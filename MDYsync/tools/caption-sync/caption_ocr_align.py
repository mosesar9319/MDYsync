#!/usr/bin/env python3
"""Caption-box OCR alignment for DafSync.

Extracts the burned-in caption box from a Daf Yomi lecture video (the strip at
the bottom showing the daf text with the currently spoken words highlighted in
yellow), OCRs it, and maps the highlighted words onto the canonical Sefaria
text. Produces:

  1. A word-level timeline: which canonical daf words are being spoken at
     each moment of the video.
  2. A segment-level alignment JSON (schema dafsync-alignment-v2) that the
     DafSync Studio player can import directly.

Requirements: opencv-python-headless, pytesseract, rapidfuzz, and the
tesseract binary with the `heb` language pack.

Example:
    python3 caption_ocr_align.py video.mp4 \
        --refs Chullin.80b Chullin.81a \
        --out-dir out/
"""

import argparse
import json
import os
import re
import sys
import unicodedata
from dataclasses import dataclass, field

import cv2
import numpy as np
import pytesseract
from rapidfuzz import fuzz

# ---------------------------------------------------------------------------
# Hebrew text normalization
# ---------------------------------------------------------------------------

# Nikud, cantillation, and punctuation marks to strip before matching.
_HEBREW_MARKS = re.compile(r"[֑-ׇ]")
_NON_HEBREW = re.compile(r"[^א-ת]")


def normalize_word(w: str) -> str:
    """Strip nikud/taamim and everything that is not a Hebrew base letter."""
    w = unicodedata.normalize("NFKD", w)
    w = _HEBREW_MARKS.sub("", w)
    w = _NON_HEBREW.sub("", w)
    return w


# ---------------------------------------------------------------------------
# Canonical text
# ---------------------------------------------------------------------------

@dataclass
class CanonWord:
    ref: str          # e.g. "Chullin 80b:12"
    seg_index: int    # index into the flat segment list
    word_index: int   # word position within the segment
    text: str         # original (vocalized) word
    norm: str         # normalized form


def fetch_sefaria(ref: str, attempts: int = 3):
    import time
    import urllib.error
    import urllib.parse
    import urllib.request
    url = (f"https://www.sefaria.org/api/texts/"
           f"{urllib.parse.quote(ref)}?context=0&commentary=0")
    last_error = None
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(url, timeout=30) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            last_error = e
            if e.code == 404:
                break  # not found won't fix itself with a retry
            if attempt < attempts - 1:
                time.sleep(1.5 * (attempt + 1))
        except urllib.error.URLError as e:
            last_error = e
            if attempt < attempts - 1:
                time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(
        f"Could not fetch '{ref}' from Sefaria ({last_error}). "
        f"Check that it's a valid reference, e.g. 'Chullin 80b' or "
        f"'Chullin 81a' (tractate, page number, and a/b side — not the "
        f"word 'Daf'). Sefaria's servers can also be briefly unavailable; "
        f"try again in a minute."
    )


def _flatten_he(node):
    """Sefaria returns a flat list of segment strings for a fully-specified
    ref (e.g. Chullin.80b), but a nested list of amud-lists when the amud is
    omitted (e.g. Chullin.80). Flatten either shape into one segment list."""
    if node is None:
        return []
    if isinstance(node, str):
        return [node]
    if not isinstance(node, list):
        return []
    out = []
    for child in node:
        out.extend(_flatten_he(child))
    return out


def load_canonical(refs, cache_dir=None):
    """Return (words, segments). segments = [{ref, he}]"""
    words, segments = [], []
    for ref in refs:
        cache = os.path.join(cache_dir, f"sefaria_{ref}.json") if cache_dir else None
        if cache and os.path.exists(cache):
            data = json.load(open(cache, encoding="utf-8"))
        else:
            data = fetch_sefaria(ref)
            if cache:
                json.dump(data, open(cache, "w", encoding="utf-8"),
                          ensure_ascii=False)
        he = _flatten_he(data["he"] if isinstance(data, dict) else data)
        if not he:
            raise RuntimeError(
                f"Sefaria returned no text for '{ref}'. Check the "
                f"reference is correct, e.g. 'Chullin 80b'.")
        base = ref.replace(".", " ")
        for i, seg in enumerate(he):
            seg_plain = re.sub(r"<[^>]+>", "", seg)
            seg_ref = f"{base}:{i + 1}"
            seg_index = len(segments)
            segments.append({"ref": seg_ref, "he": seg_plain})
            for j, w in enumerate(seg_plain.split()):
                n = normalize_word(w)
                if n:
                    words.append(CanonWord(seg_ref, seg_index, j, w, n))
    return words, segments


# ---------------------------------------------------------------------------
# Caption box detection
# ---------------------------------------------------------------------------

def auto_detect_box(frame):
    """Find the white caption strip in the bottom part of the frame.

    Returns (x, y, w, h) or None.
    """
    h, w = frame.shape[:2]
    bottom = frame[int(h * 0.6):]
    hsv = cv2.cvtColor(bottom, cv2.COLOR_BGR2HSV)
    # near-white or yellow (the highlight sits inside the strip)
    white = cv2.inRange(hsv, (0, 0, 170), (180, 60, 255))
    yellow = cv2.inRange(hsv, (20, 80, 120), (40, 255, 255))
    mask = cv2.bitwise_or(white, yellow)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((5, 25), np.uint8))
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    best = None
    for c in contours:
        x, y, cw, ch = cv2.boundingRect(c)
        if cw > w * 0.35 and ch > 30 and cw / max(ch, 1) > 3:
            if best is None or cw * ch > best[2] * best[3]:
                best = (x, y, cw, ch)
    if best is None:
        return None
    x, y, cw, ch = best
    return (x, y + int(h * 0.6), cw, ch)


def box_is_visible(crop):
    """Cheap pre-filter so OCR isn't run on frames with no caption at all
    (e.g. a b-roll cutaway with nothing white/yellow in the crop region).

    This used to require frac > 0.45, on the assumption that a real caption
    fills most of the crop. That's true for a single-line caption but false
    for a two-line one, which measured as low as ~0.23-0.39 on real,
    correctly-OCRable captions -- so the old threshold was silently
    discarding long stretches of genuinely readable, matchable caption
    frames before OCR ever ran on them. The real correctness guard is the
    match-score floor in match_phrase, which already rejects OCR garbage
    from non-caption frames (verified: an unrelated infographic and a plain
    video b-roll frame both produced no scoring match). So this only needs
    to filter out frames with essentially nothing on them.
    """
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    white = cv2.inRange(hsv, (0, 0, 170), (180, 60, 255))
    yellow = cv2.inRange(hsv, (20, 80, 120), (40, 255, 255))
    frac = (cv2.countNonZero(white) + cv2.countNonZero(yellow)) / white.size
    return frac > 0.08


# ---------------------------------------------------------------------------
# OCR (cached per caption "page")
# ---------------------------------------------------------------------------

OCR_SCALE = 2.5


@dataclass
class OcrWord:
    text: str
    norm: str
    x: int
    y: int
    w: int
    h: int
    line: int


def text_signature(crop):
    """Hash of the binarized text pixels, ignoring the yellow highlight, so a
    moving highlight does not look like a caption change."""
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    yellow = cv2.inRange(hsv, (20, 80, 120), (40, 255, 255))
    g = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    _, dark = cv2.threshold(g, 110, 255, cv2.THRESH_BINARY_INV)
    dark[yellow > 0] = dark[yellow > 0]  # text inside highlight stays dark
    small = cv2.resize(dark, (64, 16), interpolation=cv2.INTER_AREA)
    return (small > 127).tobytes()


def ocr_caption(crop):
    """OCR the caption crop; returns list of OcrWord with line indices."""
    g = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    g = cv2.resize(g, None, fx=OCR_SCALE, fy=OCR_SCALE, interpolation=cv2.INTER_CUBIC)
    _, th = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    d = pytesseract.image_to_data(
        th, lang="heb", config="--psm 6", output_type=pytesseract.Output.DICT
    )
    words = []
    for i in range(len(d["text"])):
        t = d["text"][i].strip()
        if not t:
            continue
        n = normalize_word(t)
        if not n:
            continue
        words.append(
            OcrWord(
                text=t,
                norm=n,
                x=int(d["left"][i] / OCR_SCALE),
                y=int(d["top"][i] / OCR_SCALE),
                w=int(d["width"][i] / OCR_SCALE),
                h=int(d["height"][i] / OCR_SCALE),
                line=0,
            )
        )
    if not words:
        return words
    # cluster into text lines by vertical center
    words.sort(key=lambda w: w.y + w.h / 2)
    line_no, prev_cy = 0, None
    for w in words:
        cy = w.y + w.h / 2
        if prev_cy is not None and cy - prev_cy > w.h * 0.8:
            line_no += 1
        w.line = line_no
        prev_cy = cy
    # RTL reading order: line asc, x desc
    words.sort(key=lambda w: (w.line, -w.x))
    return words


# ---------------------------------------------------------------------------
# Highlight detection
# ---------------------------------------------------------------------------

def highlighted_words(crop, words):
    """Return the subset of OCR words covered by the yellow highlight."""
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    yellow = cv2.inRange(hsv, (20, 80, 120), (40, 255, 255))
    out = []
    for w in words:
        pad = 2
        y0, y1 = max(0, w.y - pad), min(yellow.shape[0], w.y + w.h + pad)
        x0, x1 = max(0, w.x - pad), min(yellow.shape[1], w.x + w.w + pad)
        region = yellow[y0:y1, x0:x1]
        if region.size == 0:
            continue
        frac = cv2.countNonZero(region) / region.size
        if frac > 0.15:
            out.append(w)
    return out


# ---------------------------------------------------------------------------
# Matching highlighted OCR words to the canonical stream
# ---------------------------------------------------------------------------

BACK_WINDOW = 15
FWD_WINDOW = 60
MIN_SCORE = 60          # local matches
MIN_SCORE_GLOBAL = 72   # global (re)localization is stricter
MIN_SCORE_SINGLE = 85   # single highlighted words are ambiguous
RELOCALIZE_AFTER = 12   # consecutive local failures before searching globally


def match_phrase(canon, hl, cursor, global_search=False):
    """Fuzzy-match the highlighted phrase against canonical word windows.

    Searches near the running cursor, or the whole stream when
    (re)localizing. Returns (start_index, end_index, score) or None.
    """
    phrase = "".join(w.norm for w in hl)
    if not phrase:
        return None
    k = len(hl)
    if global_search:
        if k < 2:
            return None  # a lone word can't localize reliably
        lo, hi = 0, len(canon)
    else:
        lo = max(0, cursor - BACK_WINDOW)
        hi = min(len(canon), cursor + FWD_WINDOW)
    best = None
    for size in {max(1, k - 1), k, k + 1}:
        for s in range(lo, max(lo, hi - size + 1)):
            cand = "".join(c.norm for c in canon[s:s + size])
            score = fuzz.ratio(phrase, cand)
            if not global_search:
                # gentle preference for staying near the cursor
                score -= abs(s - cursor) * 0.15
            if best is None or score > best[2]:
                best = (s, s + size - 1, score)
    if best is None:
        return None
    floor = MIN_SCORE_GLOBAL if global_search else \
        (MIN_SCORE_SINGLE if k == 1 else MIN_SCORE)
    return best if best[2] >= floor else None


# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------

@dataclass
class WordEvent:
    t: float
    start_idx: int
    end_idx: int
    score: float
    ocr_text: str = ""


def process_video(path, refs, crop=None, sample_fps=3.0, out_dir="out",
                  cache_dir=None, debug=False, progress=None):
    os.makedirs(out_dir, exist_ok=True)
    canon, segments = load_canonical(refs, cache_dir or out_dir)
    print(f"Canonical text: {len(segments)} segments, {len(canon)} words")

    cap = cv2.VideoCapture(path)
    fps = cap.get(cv2.CAP_PROP_FPS)
    nframes = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration = nframes / fps
    step = max(1, round(fps / sample_fps))
    print(f"Video: {duration:.1f}s @ {fps:.2f}fps; sampling every {step} frames")

    events = []
    cursor = 0
    locked = False
    local_misses = 0
    ocr_cache_sig, ocr_cache_words = None, None
    frame_idx = 0
    while True:
        ok = cap.grab()
        if not ok:
            break
        if frame_idx % step:
            frame_idx += 1
            continue
        ok, frame = cap.retrieve()
        frame_idx += 1
        if not ok:
            break
        t = (frame_idx - 1) / fps
        if progress and nframes and frame_idx % (step * 25) == 0:
            progress(frame_idx / nframes)

        if crop is None:
            crop = auto_detect_box(frame)
            if crop is None:
                continue
            print(f"Auto-detected caption box at x={crop[0]} y={crop[1]} "
                  f"w={crop[2]} h={crop[3]}")
        x, y, w, h = crop
        box = frame[y:y + h, x:x + w]
        if not box_is_visible(box):
            continue

        sig = text_signature(box)
        if sig != ocr_cache_sig:
            ocr_cache_words = ocr_caption(box)
            ocr_cache_sig = sig
        words = ocr_cache_words
        if not words:
            continue

        hl = highlighted_words(box, words)
        if not hl:
            continue
        m = match_phrase(canon, hl, cursor) if locked else None
        if m is None:
            if locked:
                local_misses += 1
                if local_misses < RELOCALIZE_AFTER:
                    continue
            m = match_phrase(canon, hl, cursor, global_search=True)
            if m is None:
                continue
            locked = True
        local_misses = 0
        s, e, score = m
        # Trust the match position outright rather than clamping to a
        # never-decreasing cursor. A hard forward-only floor means a single
        # bad match (OCR misread, an ambiguous short phrase) permanently
        # strands later matching: every subsequent local search window is
        # anchored past where the true content actually is, and even a
        # confident global relocalization gets silently discarded if it
        # points earlier than the stuck cursor. Local search already biases
        # toward staying near the cursor (see the distance penalty in
        # match_phrase), so this only actually jumps far when the evidence
        # — a high-scoring global re-match — says the cursor was wrong.
        cursor = s
        events.append(WordEvent(round(t, 2), s, e, round(score, 1),
                                " ".join(w.text for w in hl)))
        if debug:
            print(f"  t={t:6.2f}  [{s}-{e}] {score:5.1f}  "
                  f"{' '.join(c.text for c in canon[s:e+1])}")

    cap.release()
    print(f"Matched {len(events)} highlight samples")
    return canon, segments, events, duration


def _fill_segment_gaps(seg_times, n_segments, duration):
    """seg_times: {seg_index: (start, end)} for segments a real match
    covered. Returns {seg_index: (start, end, estimated)} for every index in
    range(n_segments) -- see build_outputs for why every segment needs a row,
    not just the confidently-matched ones."""
    known = sorted(seg_times)
    if not known:
        # Nothing matched at all -- spread everything evenly so there's at
        # least a plausible starting point to correct from.
        step = duration / max(1, n_segments)
        return {s: (round(s * step, 2), round(s * step, 2), True) for s in range(n_segments)}

    result = {s: (seg_times[s][0], seg_times[s][1], False) for s in known}

    for a, b in zip(known, known[1:]):
        gap = b - a - 1
        if gap <= 0:
            continue
        t0, t1 = seg_times[a][1], seg_times[b][0]
        for k in range(1, gap + 1):
            t = t0 + (t1 - t0) * k / (gap + 1)
            result[a + k] = (round(t, 2), round(t, 2), True)

    t0 = seg_times[known[0]][0]
    for s in range(known[0] - 1, -1, -1):
        t0 = max(0.0, t0 - 1.0)
        result[s] = (round(t0, 2), round(t0, 2), True)

    t1 = seg_times[known[-1]][1]
    for s in range(known[-1] + 1, n_segments):
        t1 = min(duration, t1 + 1.0)
        result[s] = (round(t1, 2), round(t1, 2), True)

    return result


# A whole Sefaria segment (one "he" list entry for a ref) is often a full
# paragraph -- fine as the *matching* unit (that's the granularity the fuzzy
# search reasons about), but too long as the *highlighting* unit: a reader
# watching one multi-sentence block light up all at once for 30+ seconds
# doesn't get much signal from it. This splits each one into shorter,
# evenly-sized phrase chunks purely for display/editing, without touching
# the underlying canonical word indexing.
PHRASE_TARGET_WORDS = 8


def _split_word_ranges(n_words, target=PHRASE_TARGET_WORDS):
    """(start_idx, end_idx) word-index pairs (inclusive, 0-based, matching
    CanonWord.word_index) splitting a segment's n_words into evenly-sized
    ~target-word chunks -- balanced sizes rather than a fixed chunk size
    that leaves a small leftover tail on the last one."""
    if n_words <= 0:
        return [(0, 0)]
    if n_words <= target:
        return [(0, n_words - 1)]
    n_chunks = max(1, round(n_words / target))
    size = n_words / n_chunks
    bounds = sorted({round(i * size) for i in range(n_chunks + 1)})
    bounds[0], bounds[-1] = 0, n_words
    return [(bounds[i], bounds[i + 1] - 1) for i in range(len(bounds) - 1)]


def _robust_cluster(entries, gap_seconds):
    """entries: dicts with "start"/"end" keys. Groups by time gap and keeps
    only the largest cluster -- a short, ambiguous match landing far from
    where a segment is actually read (an accidental fuzzy hit elsewhere in
    a repetitive sugya, or minutes later on a second pass) shouldn't drag
    the segment's recorded range across unrelated video the way a plain
    min/max over every entry would."""
    entries = sorted(entries, key=lambda e: e["start"])
    clusters = [[entries[0]]]
    for e in entries[1:]:
        if e["start"] - clusters[-1][-1]["end"] > gap_seconds:
            clusters.append([])
        clusters[-1].append(e)
    return max(clusters, key=len)


CLUSTER_GAP_SECONDS = 180  # see _robust_cluster
PAUSE_GAP_SECONDS = 2.0    # see _group_real_entries


def _group_real_entries(entries, target=PHRASE_TARGET_WORDS):
    """entries: real observed (start, end, w0, w1) samples for one segment
    -- the cluster _robust_cluster already picked as the genuine one.
    Merges adjacent entries into ~target-word phrase chunks using each
    chunk's own first real timestamp; no interpolation is needed since a
    chunk's boundaries are always real observed times. Crucially, this
    never merges across a gap bigger than PAUSE_GAP_SECONDS -- that gap
    usually means the speaker actually paused (to explain, etc.), and
    assuming uniform pace across it the way word-count interpolation would
    could put words on the wrong side of a real pause."""
    entries = sorted(entries, key=lambda e: e["start"])
    groups = []
    current = None
    for e in entries:
        if current is None:
            current = dict(e)
        elif e["start"] - current["end"] > PAUSE_GAP_SECONDS or (current["w1"] - current["w0"] + 1) >= target:
            groups.append(current)
            current = dict(e)
        else:
            current["end"] = e["end"]
            current["w1"] = e["w1"]
    if current is not None:
        groups.append(current)
    return groups


def _estimated_word_chunks(w_lo, w_hi, anchor_time, target=PHRASE_TARGET_WORDS):
    """Placeholder phrase chunks (see _fill_segment_gaps) for a word range
    with no real match at all, spaced a hair apart from anchor_time so each
    still gets its own sortable, individually-correctable row."""
    return [
        {"start": anchor_time + 0.01 * w0, "end": anchor_time + 0.01 * (w1 + 1),
         "w0": w_lo + w0, "w1": w_lo + w1, "estimated": True}
        for w0, w1 in _split_word_ranges(w_hi - w_lo + 1, target)
    ]


def _segment_phrase_chunks(groups, n_words, fallback_time, target=PHRASE_TARGET_WORDS):
    """Real phrase chunks (groups, from _group_real_entries) plus
    "estimated" placeholder chunks filling any word range within the
    segment that no real match actually covered (a run can match only part
    of a paragraph). Ordered by word position (reading order) -- what the
    "he" text reconstruction needs -- rather than by playback time, which
    relocalization can occasionally make non-monotonic within one segment's
    real matches."""
    ordered = sorted(groups, key=lambda g: g["w0"])
    chunks = []
    cursor = 0
    for g in ordered:
        if g["w0"] > cursor:
            chunks.extend(_estimated_word_chunks(cursor, g["w0"] - 1, g["start"], target))
        chunks.append({**g, "estimated": False})
        cursor = g["w1"] + 1
    if cursor < n_words:
        anchor = ordered[-1]["end"] if ordered else fallback_time
        chunks.extend(_estimated_word_chunks(cursor, n_words - 1, anchor, target))
    return chunks


def build_outputs(canon, segments, events, duration, video_path, refs,
                   generator="caption_ocr_align.py", title_prefix="Caption OCR alignment"):
    """Collapse per-frame events into a word timeline and a segment alignment."""
    # word-level timeline: merge consecutive samples with the same span
    timeline = []
    for ev in events:
        if timeline and timeline[-1]["startWord"] == ev.start_idx \
                and timeline[-1]["endWord"] == ev.end_idx:
            timeline[-1]["end"] = timeline[-1]["realEnd"] = ev.t
            continue
        timeline.append({
            "start": ev.t,
            "end": ev.t,
            "realEnd": ev.t,  # see the stretch step below
            "startWord": ev.start_idx,
            "endWord": ev.end_idx,
            "ref": canon[ev.start_idx].ref,
            "wordIndexStart": canon[ev.start_idx].word_index,
            "wordIndexEnd": canon[ev.end_idx].word_index,
            "text": " ".join(c.text for c in canon[ev.start_idx:ev.end_idx + 1]),
            "score": ev.score,
        })
    # stretch each entry's "end" to meet the next -- word_timeline wants
    # that (a word stays highlighted on screen until the next one appears),
    # but it destroys the real gap between two entries, which is exactly
    # what phrase-chunk pause detection below needs to see (_group_real_
    # entries) -- so "realEnd" (each entry's own last actually-observed
    # timestamp, untouched by this) is kept alongside it for that purpose.
    for a, b in zip(timeline, timeline[1:]):
        a["end"] = b["start"]
    if timeline:
        timeline[-1]["end"] = round(min(duration, timeline[-1]["end"] + 2.0), 2)

    # segment-level alignment. Each canonical segment can accumulate several
    # timeline entries (repeats, relocalization after a gap, etc.); clip
    # every entry to the portion of it that actually falls within a given
    # segment (an entry can span a paragraph boundary), then keep only the
    # largest same-segment time cluster (_robust_cluster) -- a single stray
    # entry, a short ambiguous phrase that fuzzy-matched to the wrong spot,
    # shouldn't drag the segment's recorded range across unrelated minutes
    # of video the way a plain min/max over every entry would.
    seg_word_bounds = {}
    for i, c in enumerate(canon):
        lo, hi = seg_word_bounds.get(c.seg_index, (i, i))
        seg_word_bounds[c.seg_index] = (min(lo, i), max(hi, i))

    seg_entries = {}
    for entry in timeline:
        si = canon[entry["startWord"]].seg_index
        se = canon[entry["endWord"]].seg_index
        for s in range(si, se + 1):
            lo, hi = seg_word_bounds[s]
            clipped_lo, clipped_hi = max(entry["startWord"], lo), min(entry["endWord"], hi)
            seg_entries.setdefault(s, []).append({
                # realEnd, not the stretched "end" -- see the timeline loop
                # above for why the stretched value would hide real pauses
                # from _group_real_entries.
                "start": entry["start"], "end": entry["realEnd"],
                "w0": canon[clipped_lo].word_index, "w1": canon[clipped_hi].word_index,
            })
    seg_clusters = {s: _robust_cluster(es, CLUSTER_GAP_SECONDS) for s, es in seg_entries.items()}
    seg_times = {s: (c[0]["start"], c[-1]["end"]) for s, c in seg_clusters.items()}

    # A segment with no confident match anywhere (common for voice sync,
    # which only ever locks onto the ~15-50% of runs it's sure about --
    # OCR usually covers nearly the whole daf since the captions scroll
    # through all of it) used to be left out of align_segments entirely:
    # not "unsynced", just gone, with no row in the manual-correction
    # editor to fix it from. Every canonical segment gets a row now; the
    # ones with no real match get a placeholder time interpolated between
    # their confidently-matched neighbors (or extrapolated a second apart,
    # past the first/last known one) and are flagged "estimated" so the
    # editor can mark them as needing a real correction rather than
    # looking already-done.
    all_seg_times = _fill_segment_gaps(seg_times, len(segments), duration)

    align_segments = []
    for s in sorted(all_seg_times):
        t0, _t1, _estimated = all_seg_times[s]
        seg_words = segments[s]["he"].split()
        n_words = len(seg_words)
        if n_words == 0:
            continue  # nothing to time or highlight in a blank segment
        # Real phrase-chunk boundaries/times come straight from actual
        # observed matches (_group_real_entries), not an assumed-uniform
        # pace across the segment's whole span -- a pause mid-segment (the
        # speaker stopping to explain) already shows up as a real gap
        # between two observed entries rather than getting smoothed over.
        # Only the parts nothing ever actually matched fall back to an
        # evenly-spaced guess, and those are flagged "estimated".
        if s in seg_clusters:
            chunks = _segment_phrase_chunks(_group_real_entries(seg_clusters[s]), n_words, t0)
        else:
            chunks = _estimated_word_chunks(0, n_words - 1, t0)
        for c in chunks:
            entry = {
                "ref": segments[s]["ref"],
                "start": round(c["start"], 2),
                "end": round(c["end"], 2),
                "he": " ".join(seg_words[c["w0"]:c["w1"] + 1]),
                "w0": c["w0"],
                "w1": c["w1"],
            }
            if c["estimated"]:
                entry["estimated"] = True
            align_segments.append(entry)

    # word timeline embedded in the alignment file, split per segment so the
    # player can highlight words by (ref, word index) directly
    word_timeline = []
    for entry in timeline:
        span = canon[entry["startWord"]:entry["endWord"] + 1]
        by_seg = {}
        for c in span:
            w0, w1 = by_seg.get(c.seg_index, (c.word_index, c.word_index))
            by_seg[c.seg_index] = (min(w0, c.word_index), max(w1, c.word_index))
        for s, (w0, w1) in sorted(by_seg.items()):
            word_timeline.append({
                "start": entry["start"],
                "end": entry["end"],
                "ref": segments[s]["ref"],
                "w0": w0,
                "w1": w1,
            })

    alignment = {
        "schema": "dafsync-alignment-v2",
        "title": f"{title_prefix} — {', '.join(refs)}",
        "dafRef": refs[0].replace(".", " "),
        "duration": round(duration, 2),
        "alignmentStatus": "in-progress",
        "generator": generator,
        "videoSource": {"type": "local", "url": os.path.basename(video_path)},
        "segments": align_segments,
        "wordTimeline": word_timeline,
    }
    word_map = {
        "schema": "dafsync-wordmap-v1",
        "refs": [r.replace(".", " ") for r in refs],
        "duration": round(duration, 2),
        "entries": timeline,
    }
    return alignment, word_map


def main():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("video")
    p.add_argument("--refs", nargs="+",
                   help="Sefaria refs in reading order, e.g. Chullin.80b Chullin.81a. "
                        "Breaks on multi-word tractate names (e.g. 'Bava Batra') "
                        "since each token is treated as a separate ref — use "
                        "--refs-json for those instead.")
    p.add_argument("--refs-json",
                   help="Sefaria refs as a single JSON array string, e.g. "
                        '\'["Chullin 80b", "Bava Batra 82b"]\'. Safe for '
                        "multi-word tractate names; use this from scripts/CI "
                        "rather than --refs.")
    p.add_argument("--crop", help="Caption box as x,y,w,h (default: auto-detect)")
    p.add_argument("--sample-fps", type=float, default=3.0)
    p.add_argument("--out-dir", default="out")
    p.add_argument("--debug", action="store_true")
    args = p.parse_args()

    if args.refs_json:
        refs = json.loads(args.refs_json)
    elif args.refs:
        refs = args.refs
    else:
        p.error("one of --refs or --refs-json is required")

    crop = tuple(int(v) for v in args.crop.split(",")) if args.crop else None
    canon, segments, events, duration = process_video(
        args.video, refs, crop=crop, sample_fps=args.sample_fps,
        out_dir=args.out_dir, debug=args.debug)
    if not events:
        print("No highlight matches found — check the crop region and refs.")
        sys.exit(1)
    alignment, word_map = build_outputs(
        canon, segments, events, duration, args.video, refs)

    a_path = os.path.join(args.out_dir, "alignment.json")
    w_path = os.path.join(args.out_dir, "wordmap.json")
    json.dump(alignment, open(a_path, "w", encoding="utf-8"),
              ensure_ascii=False, indent=2)
    json.dump(word_map, open(w_path, "w", encoding="utf-8"),
              ensure_ascii=False, indent=2)
    print(f"Wrote {a_path} ({len(alignment['segments'])} segments)")
    print(f"Wrote {w_path} ({len(word_map['entries'])} word-span entries)")


if __name__ == "__main__":
    main()
