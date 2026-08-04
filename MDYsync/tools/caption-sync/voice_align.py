#!/usr/bin/env python3
"""Voice-based alignment for DafSync -- a standalone alternative to
caption_ocr_align.py's caption-box OCR approach, for a video with no
burned-in caption box at all.

Transcribes the video's audio with a pretrained speech model (faster-whisper,
no fine-tuning yet), then anchors that transcription against the daf's
canonical Sefaria text rather than trusting the free transcription's own
wording: only Hebrew-script word runs are considered as candidate gemara
readings at all (a shiur is mostly English explanation, occasionally
switching to read the Aramaic/Hebrew text aloud), and each run is fuzzy-
matched against a window of canonical text tracked by a cursor, the same
lock/relocalize state machine caption_ocr_align.py's match_phrase() already
uses for OCR-read caption text.

Two refinements past that baseline design, both added after testing against
real synced Chullin 95a audio:

  1. Dual scoring -- search for the best-matching window using a *phonetic*
     normalization of the Hebrew letters (collapsing acoustically-confusable
     letters: e.g. "שוטה" heard/transcribed as "שייט", ו/י both being
     glide-ish vowel letters), since ASR errors are acoustic confusions, not
     the visual ones OCR makes -- but require the same window to also clear
     a plain character-similarity floor before accepting it. Phonetic-only
     scoring recovered real matches character-only scoring missed, but also
     let a couple of coincidentally-similar-sounding hallucinated (garbled)
     transcription fragments through; requiring both to agree caught those
     without losing the phonetic recovery.

  2. A fresh lock (after starting unlocked, or after losing the lock and
     relocalizing) is only trusted once two consecutive global-search
     matches agree with each other (the second lands at or after the first,
     within a reasonable forward distance) -- a single short, ambiguous
     phrase matching *some* window elsewhere in a sugya's fairly repetitive
     opening lines turned out to be a real, distinct failure mode from
     outright noise, and neither scoring axis alone can tell "genuinely
     the right spot" from "coincidentally similar-sounding phrase
     elsewhere in the text" from a single short match.

None of this makes the underlying speech model any more accurate at
Talmudic Aramaic -- it's still zero-shot, no fine-tuning. It's the matching
layer around it that's tuned to only trust what it's actually confident
about, leaving everything else for manual correction the same way an OCR
sync's rough spots already get corrected today.
"""
import argparse
import json
import os
import re
import sys

from faster_whisper import WhisperModel
from rapidfuzz import fuzz

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from caption_ocr_align import (  # noqa: E402
    CanonWord, WordEvent, build_outputs, load_canonical, normalize_word,
)

BACK_WINDOW = 15
FWD_WINDOW = 60
# Phonetic scores run higher than character scores on the same text (less
# distinctive alphabet after collapsing confusable letters), so these two
# axes need their own floors, calibrated separately -- see the module
# docstring. Tuned against one real clip; expect these to move as more
# corrected dapim accumulate (see tools/caption-sync/voice_confusions.json).
MIN_SCORE = 60
MIN_SCORE_GLOBAL = 72
MIN_SCORE_SINGLE = 85
CHAR_FLOOR = 55
RELOCALIZE_AFTER = 12
MAX_RUN_GAP_SECONDS = 2.0

_CONFUSIONS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "voice_confusions.json")


def load_phonetic_classes():
    """Letter -> phonetic-class-symbol table. Starts from the four
    confusion classes identified against real audio (see module docstring);
    voice_confusions.json (built from banked manual corrections -- see
    tools/caption-sync/build_voice_confusions.py) can override/extend it
    once there's enough corrected data to justify it, without a code
    change."""
    classes = [("A", "אעה"), ("Y", "וי"), ("K", "כחק"), ("T", "תט")]
    if os.path.exists(_CONFUSIONS_PATH):
        try:
            with open(_CONFUSIONS_PATH, encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data.get("classes"), list):
                classes = [(c["symbol"], c["letters"]) for c in data["classes"]]
        except Exception as error:
            print(f"Could not read {_CONFUSIONS_PATH}, using built-in defaults: {error}")
    table = {}
    for symbol, letters in classes:
        for ch in letters:
            table[ch] = symbol
    return table


_PHONETIC_CLASS = load_phonetic_classes()


def phonetic(norm_word: str) -> str:
    return "".join(_PHONETIC_CLASS.get(ch, ch) for ch in norm_word)


def match_phrase_dual(canon, hl_norm, hl_phon, cursor, global_search=False):
    """Same search strategy as caption_ocr_align.match_phrase(), but scores
    on the phonetic form to find the best window, then requires that same
    window to also clear a character-similarity floor. Returns
    (start_index, end_index, phonetic_score, char_score) or None."""
    phon_phrase = "".join(hl_phon)
    if not phon_phrase:
        return None
    k = len(hl_phon)
    if global_search:
        if k < 2:
            return None
        lo, hi = 0, len(canon)
    else:
        lo = max(0, cursor - BACK_WINDOW)
        hi = min(len(canon), cursor + FWD_WINDOW)
    best = None
    for size in {max(1, k - 1), k, k + 1}:
        for s in range(lo, max(lo, hi - size + 1)):
            cand_phon = "".join(c.phon for c in canon[s:s + size])
            score = fuzz.ratio(phon_phrase, cand_phon)
            if not global_search:
                score -= abs(s - cursor) * 0.15
            if best is None or score > best[2]:
                best = (s, s + size - 1, score)
    if best is None:
        return None
    floor = MIN_SCORE_GLOBAL if global_search else (MIN_SCORE_SINGLE if k == 1 else MIN_SCORE)
    if best[2] < floor:
        return None
    s, e, phon_score = best
    char_phrase = "".join(hl_norm)
    char_cand = "".join(c.norm for c in canon[s:e + 1])
    char_score = fuzz.ratio(char_phrase, char_cand)
    if char_score < CHAR_FLOOR:
        return None
    return s, e, phon_score, char_score


def transcribe(audio_path, model_size="small"):
    print(f"Loading whisper model: {model_size} (CPU, int8)...")
    model = WhisperModel(model_size, device="cpu", compute_type="int8")
    segments, info = model.transcribe(audio_path, language="he", word_timestamps=True, vad_filter=True)
    print(f"Detected/forced language: {info.language} (p={info.language_probability:.2f})")
    words = []
    for seg in segments:
        for w in (seg.words or []):
            words.append({"start": w.start, "end": w.end, "text": w.word, "prob": w.probability})
    return words


def hebrew_script_runs(words):
    """Group consecutive Hebrew-script words into runs -- a run breaks on
    any non-Hebrew word (English explanation) or a gap between consecutive
    Hebrew words, since either means we've left a continuous stretch of
    actual reading."""
    runs = []
    current = []
    for w in words:
        n = normalize_word(w["text"])
        if not n:
            if current:
                runs.append(current)
                current = []
            continue
        if current and w["start"] - current[-1]["end"] > MAX_RUN_GAP_SECONDS:
            runs.append(current)
            current = []
        current.append({**w, "norm": n, "phon": phonetic(n)})
    if current:
        runs.append(current)
    return runs


def match_runs(canon, runs, debug=False):
    """The cursor/lock/relocalize/pending-confirmation state machine (see
    module docstring point 2) -- returns a list of WordEvent, ready for
    build_outputs()."""
    cursor = 0
    locked = False
    local_misses = 0
    pending = None
    events = []

    def make_event(run, s, e, score):
        return WordEvent(round(run[0]["start"], 2), s, e, round(score, 1),
                          " ".join(w["text"] for w in run))

    for run in runs:
        hl_norm = [w["norm"] for w in run]
        hl_phon = [w["phon"] for w in run]

        if locked:
            m = match_phrase_dual(canon, hl_norm, hl_phon, cursor)
            if m is not None:
                s, e, phon_score, char_score = m
                cursor = s
                local_misses = 0
                events.append(make_event(run, s, e, phon_score))
                if debug:
                    print(f"  t={run[0]['start']:7.2f}  [{s}-{e}] phon={phon_score:.1f} char={char_score:.1f}  "
                          f"{' '.join(w['text'] for w in run)}")
                continue
            local_misses += 1
            if local_misses < RELOCALIZE_AFTER:
                continue
            locked = False  # lost the lock -- fall through to relocalizing below

        m = match_phrase_dual(canon, hl_norm, hl_phon, cursor, global_search=True)
        if m is None:
            pending = None  # an unmatched run in between breaks any pending candidate
            continue
        s, e, phon_score, char_score = m
        if pending is not None and s >= pending["s"] and s - pending["s"] <= FWD_WINDOW:
            # Two consecutive global matches agreeing on forward progression
            # -- confirmed. Both the pending run and this one are now
            # trusted; the pending one was withheld until now.
            events.append(make_event(pending["run"], pending["s"], pending["e"], pending["phon_score"]))
            events.append(make_event(run, s, e, phon_score))
            cursor = s
            locked = True
            local_misses = 0
            pending = None
            if debug:
                print(f"  t={run[0]['start']:7.2f}  LOCK confirmed at [{s}-{e}]")
        else:
            pending = {"s": s, "e": e, "phon_score": phon_score, "char_score": char_score, "run": run}

    return events


def process_video(video_path, refs, model_size="small", cache_dir=None, debug=False):
    canon, segments = load_canonical(refs, cache_dir)
    print(f"Canonical text: {len(segments)} segments, {len(canon)} words")
    for c in canon:
        c.phon = phonetic(c.norm)

    words = transcribe(video_path, model_size)
    print(f"Transcribed {len(words)} words")
    runs = hebrew_script_runs(words)
    print(f"{len(runs)} Hebrew-script word runs")

    events = match_runs(canon, runs, debug=debug)
    print(f"Matched {len(events)} of {len(runs)} runs")

    duration = words[-1]["end"] if words else 0.0
    return canon, segments, events, duration


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("video")
    p.add_argument("--refs-json", required=True,
                   help='Sefaria refs as a JSON array string, e.g. \'["Chullin 95a", "Chullin 95b"]\'.')
    p.add_argument("--model", default="small", help="faster-whisper model size (default: small)")
    p.add_argument("--out-dir", default="out")
    p.add_argument("--debug", action="store_true")
    args = p.parse_args()

    refs = json.loads(args.refs_json)
    os.makedirs(args.out_dir, exist_ok=True)
    canon, segments, events, duration = process_video(
        args.video, refs, model_size=args.model, cache_dir=args.out_dir, debug=args.debug)
    if not events:
        print("No confident matches found -- check the audio and refs.")
        sys.exit(1)

    alignment, word_map = build_outputs(
        canon, segments, events, duration, args.video, refs,
        generator="voice_align.py", title_prefix="Voice recognition alignment")

    a_path = os.path.join(args.out_dir, "alignment.json")
    w_path = os.path.join(args.out_dir, "wordmap.json")
    json.dump(alignment, open(a_path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    json.dump(word_map, open(w_path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(f"Wrote {a_path} ({len(alignment['segments'])} segments)")
    print(f"Wrote {w_path} ({len(word_map['entries'])} word-span entries)")


if __name__ == "__main__":
    main()
