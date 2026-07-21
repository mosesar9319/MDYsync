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


def fetch_sefaria(ref: str):
    import urllib.request
    url = f"https://www.sefaria.org/api/texts/{ref}?context=0&commentary=0"
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.loads(r.read())


def load_canonical(refs, cache_dir=None):
    """Return (words, segments). segments = [{ref, he}]"""
    words, segments = [], []
    for ref in refs:
        cache = os.path.join(cache_dir, f"sefaria_{ref}.json") if cache_dir else None
        if cache and os.path.exists(cache):
            data = json.load(open(cache))
        else:
            data = fetch_sefaria(ref)
            if cache:
                json.dump(data, open(cache, "w"), ensure_ascii=False)
        he = data["he"] if isinstance(data, dict) else data
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
    """Sanity check that the crop still looks like the white caption strip
    (rejects frames where a player UI overlay covers it)."""
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    white = cv2.inRange(hsv, (0, 0, 170), (180, 60, 255))
    yellow = cv2.inRange(hsv, (20, 80, 120), (40, 255, 255))
    frac = (cv2.countNonZero(white) + cv2.countNonZero(yellow)) / white.size
    return frac > 0.45


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
                  cache_dir=None, debug=False):
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
        cursor = max(cursor, s)
        events.append(WordEvent(round(t, 2), s, e, round(score, 1),
                                " ".join(w.text for w in hl)))
        if debug:
            print(f"  t={t:6.2f}  [{s}-{e}] {score:5.1f}  "
                  f"{' '.join(c.text for c in canon[s:e+1])}")

    cap.release()
    print(f"Matched {len(events)} highlight samples")
    return canon, segments, events, duration


def build_outputs(canon, segments, events, duration, video_path, refs):
    """Collapse per-frame events into a word timeline and a segment alignment."""
    # word-level timeline: merge consecutive samples with the same span
    timeline = []
    for ev in events:
        if timeline and timeline[-1]["startWord"] == ev.start_idx \
                and timeline[-1]["endWord"] == ev.end_idx:
            timeline[-1]["end"] = ev.t
            continue
        timeline.append({
            "start": ev.t,
            "end": ev.t,
            "startWord": ev.start_idx,
            "endWord": ev.end_idx,
            "ref": canon[ev.start_idx].ref,
            "wordIndexStart": canon[ev.start_idx].word_index,
            "wordIndexEnd": canon[ev.end_idx].word_index,
            "text": " ".join(c.text for c in canon[ev.start_idx:ev.end_idx + 1]),
            "score": ev.score,
        })
    # stretch each entry to meet the next
    for a, b in zip(timeline, timeline[1:]):
        a["end"] = b["start"]
    if timeline:
        timeline[-1]["end"] = round(min(duration, timeline[-1]["end"] + 2.0), 2)

    # segment-level alignment: first/last time each canonical segment is active
    seg_times = {}
    for entry in timeline:
        si = canon[entry["startWord"]].seg_index
        se = canon[entry["endWord"]].seg_index
        for s in range(si, se + 1):
            t0, t1 = seg_times.get(s, (entry["start"], entry["end"]))
            seg_times[s] = (min(t0, entry["start"]), max(t1, entry["end"]))

    align_segments = []
    for s in sorted(seg_times):
        t0, t1 = seg_times[s]
        align_segments.append({
            "ref": segments[s]["ref"],
            "start": round(t0, 2),
            "end": round(t1, 2),
            "he": segments[s]["he"],
        })

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
        "title": f"Caption OCR alignment — {', '.join(refs)}",
        "dafRef": refs[0].replace(".", " "),
        "duration": round(duration, 2),
        "alignmentStatus": "in-progress",
        "generator": "caption_ocr_align.py",
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
    p.add_argument("--refs", nargs="+", required=True,
                   help="Sefaria refs in reading order, e.g. Chullin.80b Chullin.81a")
    p.add_argument("--crop", help="Caption box as x,y,w,h (default: auto-detect)")
    p.add_argument("--sample-fps", type=float, default=3.0)
    p.add_argument("--out-dir", default="out")
    p.add_argument("--debug", action="store_true")
    args = p.parse_args()

    crop = tuple(int(v) for v in args.crop.split(",")) if args.crop else None
    canon, segments, events, duration = process_video(
        args.video, args.refs, crop=crop, sample_fps=args.sample_fps,
        out_dir=args.out_dir, debug=args.debug)
    if not events:
        print("No highlight matches found — check the crop region and refs.")
        sys.exit(1)
    alignment, word_map = build_outputs(
        canon, segments, events, duration, args.video, args.refs)

    a_path = os.path.join(args.out_dir, "alignment.json")
    w_path = os.path.join(args.out_dir, "wordmap.json")
    json.dump(alignment, open(a_path, "w"), ensure_ascii=False, indent=2)
    json.dump(word_map, open(w_path, "w"), ensure_ascii=False, indent=2)
    print(f"Wrote {a_path} ({len(alignment['segments'])} segments)")
    print(f"Wrote {w_path} ({len(word_map['entries'])} word-span entries)")


if __name__ == "__main__":
    main()
