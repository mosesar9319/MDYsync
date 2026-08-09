#!/usr/bin/env python3
"""Turns banked voice-recognition corrections into voice_align.py's phonetic
confusion table (voice_confusions.json), closing the loop the rest of this
codebase already describes but never actually implemented: save-voice-
correction.mjs banks (what the engine heard, what a human confirmed is
actually correct) pairs, and voice_align.py already knows how to load an
override file if one exists (see its load_phonetic_classes()) -- this is
the missing piece that turns the first into the second.

What "training" means here: no model weights are touched (there's no GPU
fine-tuning pipeline for the underlying Whisper model, and there isn't
going to be one from a handful of corrected dapim). This only refines the
hand-tuned starting point -- four letter classes identified against one
real clip (see voice_align.py's module docstring) -- into something backed
by actual accumulated evidence of which Hebrew letters this engine's
transcriptions really do confuse for each other.

Where the evidence comes from: bankVoiceCorrection() in app.js looks up
each corrected segment's original word range in state.wordTimeline, which
(as of this script's own introduction) now carries heardText -- the raw
transcribed text the engine produced for that range, before it was matched
to canonical text at all. That's the "heard" side. The "actual" side is
simply the corrected segment's own canonical text, which a human confirmed
is where that audio really belongs. Diffing the two (character-level,
after the same nikud/non-Hebrew stripping normalize_word() already does)
via rapidfuzz's edit-op backtrace yields real substitution pairs: "canonical
X showed up as heard Y" -- and *that* is what a confusion class should be
built from, not a guess.

Usage:
    python3 build_voice_confusions.py --corrections-dir /path/to/results/voice-corrections

Deliberately conservative: a letter pair only gets merged into a shared
class once it's been seen at least --min-evidence times (default 2)
across *different* correction files, and the whole run refuses to touch
the existing voice_confusions.json at all if there isn't at least
--min-total (default 5) usable corrections banked yet -- a handful of
early corrections shouldn't be allowed to overwrite four classes that were
already confirmed against real audio, with something noisier.
"""
import argparse
import glob
import json
import os
import sys
from collections import Counter

from rapidfuzz.distance import Levenshtein

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from caption_ocr_align import normalize_word  # noqa: E402

# Must match voice_align.py's own load_phonetic_classes() defaults exactly --
# this is the prior these classes are refined from, not replaced outright.
DEFAULT_CLASSES = [("A", "אעה"), ("Y", "וי"), ("K", "כחק"), ("T", "תט")]

OUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "voice_confusions.json")

# A wildly mismatched pair (e.g. the engine matched a run to the wrong
# sugya entirely, or a correction changed which text a segment even
# represents) would dump edit-ops that are mostly insertions/deletions
# dressed up as "replacements" once rapidfuzz runs out of real alignment --
# not genuine acoustic-confusion evidence. Below this normalized-length
# ratio, skip the pair entirely rather than let a bad example pollute the
# tally.
MIN_LENGTH_RATIO = 0.5


def normalize_phrase(text):
    """Same per-word normalize_word() the engines use, concatenated with no
    spaces -- word boundaries in a free transcription don't reliably match
    the canonical text's own, so alignment works on the flat letter stream."""
    return "".join(normalize_word(tok) for tok in (text or "").split())


class UnionFind:
    def __init__(self):
        self.parent = {}

    def find(self, x):
        self.parent.setdefault(x, x)
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[ra] = rb


def load_corrections(corrections_dir):
    """Yields (heard_norm, actual_norm) pairs from every banked correction
    file -- one file can contain several segment corrections (see
    save-voice-correction.mjs), paired by array position same as the
    client does."""
    paths = sorted(glob.glob(os.path.join(corrections_dir, "*.json")))
    total_files = 0
    total_pairs = 0
    for path in paths:
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError) as error:
            print(f"Skipping {path}: {error}")
            continue
        original = data.get("original") or []
        corrected = data.get("corrected") or []
        if not original or not corrected:
            continue
        total_files += 1
        for orig, corr in zip(original, corrected):
            heard = normalize_phrase(orig.get("heardText", ""))
            actual = normalize_phrase(corr.get("he", ""))
            if not heard or not actual:
                continue  # no recognition evidence for this segment, or nothing to compare it to
            total_pairs += 1
            yield heard, actual
    print(f"Read {total_files} correction file(s), {total_pairs} segment pair(s) with usable heard-text.")


def tally_substitutions(pairs):
    counts = Counter()
    for heard, actual in pairs:
        shorter, longer = sorted((len(heard), len(actual)))
        if longer == 0 or shorter / longer < MIN_LENGTH_RATIO:
            continue
        for op in Levenshtein.editops(actual, heard):
            if op.tag != "replace":
                continue  # insertions/deletions aren't a letter-for-letter confusion
            a, h = actual[op.src_pos], heard[op.dest_pos]
            if a == h:
                continue
            counts[frozenset((a, h))] += 1
    return counts


def build_classes(pair_counts, min_evidence):
    uf = UnionFind()
    for symbol, letters in DEFAULT_CLASSES:
        for ch in letters:
            uf.find(ch)  # register it
        for ch in letters[1:]:
            uf.union(letters[0], ch)

    kept, dropped = 0, 0
    for pair, count in pair_counts.items():
        a, b = tuple(pair)
        if count >= min_evidence:
            uf.union(a, b)
            kept += 1
        else:
            dropped += 1
    print(f"{kept} letter-pair(s) merged from real evidence (>= {min_evidence} occurrences each); "
          f"{dropped} pair(s) seen but below the evidence threshold, left as-is.")

    groups = {}
    for ch in list(uf.parent):
        groups.setdefault(uf.find(ch), set()).add(ch)

    classes = []
    # Stable order: by the smallest letter's Unicode codepoint, so re-runs
    # over the same evidence produce the same file (easier to review in a
    # diff) rather than dict/set iteration order shuffling it each time.
    for root in sorted(groups, key=lambda r: min(groups[r])):
        letters = groups[root]
        if len(letters) < 2:
            continue  # a letter nobody has ever confused with anything needs no explicit class
        classes.append("".join(sorted(letters)))

    symbols = [chr(ord("A") + i) for i in range(len(classes))]
    return [{"symbol": s, "letters": letters} for s, letters in zip(symbols, classes)]


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--corrections-dir", required=True,
                   help="Local path to a results-branch checkout's voice-corrections/ directory.")
    p.add_argument("--min-evidence", type=int, default=2,
                   help="Minimum independent occurrences of a letter pair before merging its class (default: 2).")
    p.add_argument("--min-total", type=int, default=5,
                   help="Minimum usable correction pairs banked before writing anything at all (default: 5).")
    p.add_argument("--out", default=OUT_PATH, help="Where to write the confusion table.")
    args = p.parse_args()

    if not os.path.isdir(args.corrections_dir):
        print(f"No such directory: {args.corrections_dir} (nothing banked yet?)")
        sys.exit(0)

    pairs = list(load_corrections(args.corrections_dir))
    if len(pairs) < args.min_total:
        print(f"Only {len(pairs)} usable correction(s) banked so far -- need at least {args.min_total} "
              f"before it's worth touching {os.path.basename(args.out)}. Leaving it as-is. "
              "Run this again once more corrections accumulate (use the desktop app's or the "
              "Vilna-page 'Mark words' editor's manual correction, then Save draft).")
        sys.exit(0)

    pair_counts = tally_substitutions(pairs)
    classes = build_classes(pair_counts, args.min_evidence)

    payload = {
        "classes": classes,
        "generatedAt": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
        "totalCorrections": len(pairs),
        "totalSubstitutionPairsObserved": sum(pair_counts.values()),
    }
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"Wrote {args.out}: {len(classes)} class(es) from {len(pairs)} corrections.")
    for c in classes:
        print(f"  {c['symbol']}: {c['letters']}")


if __name__ == "__main__":
    main()
