#!/usr/bin/env python3
"""Regenerate tests/fixtures/live-matcher-parity.json -- the expected
outputs live-matcher.js (Live Follow's JavaScript port of this directory's
deterministic matcher) is tested against. Re-run this whenever
match_phrase_dual, match_runs, normalize_word, phonetic or
build_keyterm_list change, then run `npm run test:functions`:

    pip install rapidfuzz
    python3 tools/caption-sync/gen_live_matcher_parity.py

Only rapidfuzz and network access to Sefaria are needed. The OCR/ASR
modules voice_align.py and caption_ocr_align.py import at module level
(cv2, numpy, pytesseract, faster_whisper) are never touched by the
functions exercised here, so they're stubbed rather than installed.

Every input is generated from a fixed seed, so re-running against
unchanged Python code reproduces the same file byte-for-byte.
"""
import json
import os
import random
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
for name in ("cv2", "numpy", "pytesseract", "faster_whisper"):
    sys.modules.setdefault(name, types.ModuleType(name))
sys.modules["faster_whisper"].WhisperModel = None
sys.path.insert(0, HERE)

from rapidfuzz import fuzz  # noqa: E402
import caption_ocr_align as coa  # noqa: E402
import voice_align as va  # noqa: E402

REFS = ["Chullin 91a", "Chullin 91b"]
OUT = os.path.join(HERE, "..", "..", "tests", "fixtures", "live-matcher-parity.json")
# Acoustically confusable swaps the phonetic classes exist for, plus a
# couple they deliberately don't cover (ש/ס, ב/פ) so both axes get exercised.
SWAPS = {"א": "ע", "ע": "א", "ה": "א", "ו": "י", "י": "ו", "כ": "ח", "ח": "כ",
         "ק": "כ", "ת": "ט", "ט": "ת", "ש": "ס", "ס": "ש", "ב": "פ", "פ": "ב"}
LETTERS = "אבגדהוזחטיכלמנסעפצקרשת"


def as_run(norms):
    return [{"text": n, "norm": n, "phon": va.phonetic(n), "start": 0.0, "end": 0.0} for n in norms]


def perturb(rng, norms, kind):
    words = list(norms)
    if kind == "exact":
        return words
    if kind == "confuse":
        out = []
        for w in words:
            chars = [SWAPS.get(c, c) if rng.random() < 0.3 else c for c in w]
            out.append("".join(chars))
        return out
    if kind == "drop_letter":
        out = []
        for w in words:
            if len(w) > 2 and rng.random() < 0.4:
                i = rng.randrange(len(w))
                w = w[:i] + w[i + 1:]
            out.append(w)
        return out
    if kind == "drop_word":
        if len(words) > 2:
            del words[rng.randrange(len(words))]
        return words
    if kind == "garbage":
        return ["".join(rng.choice(LETTERS) for _ in range(rng.randint(2, 6))) for _ in words]
    raise ValueError(kind)


def phrase_cases(rng, canon):
    cases = []
    n = len(canon)
    for _ in range(140):
        k = rng.choice([1, 2, 3, 4, 5, 8, 10, 12])
        start = rng.randrange(0, max(1, n - k))
        kind = rng.choice(["exact", "confuse", "confuse", "drop_letter", "drop_word", "garbage"])
        hl_norm = [w for w in perturb(rng, [c.norm for c in canon[start:start + k]], kind) if w]
        if not hl_norm:
            continue
        hl_phon = [va.phonetic(w) for w in hl_norm]
        cursor = max(0, min(n - 1, start + rng.randint(-25, 75)))
        window = [max(0, start - rng.randint(0, 8)), min(n, start + k + rng.randint(0, 8))]

        def res(m):
            return None if m is None else list(m)
        cases.append({
            "hlNorm": hl_norm, "hlPhon": hl_phon, "cursor": cursor, "window": window,
            "local": res(va.match_phrase_dual(canon, hl_norm, hl_phon, cursor)),
            "global": res(va.match_phrase_dual(canon, hl_norm, hl_phon, cursor, global_search=True)),
            "windowed": res(va.match_phrase_dual(canon, hl_norm, hl_phon, cursor, window=tuple(window))),
        })
    return cases


class _Word:
    def __init__(self, norm):
        self.norm = norm
        self.phon = va.phonetic(norm)


def _match_ascending(canon, hl_norm, hl_phon, cursor, global_search):
    """match_phrase_dual, except window sizes are tried in plain ascending
    order instead of match_phrase_dual's Python-set order. Used only to FIND
    inputs where that order changes the answer -- the expected values
    recorded for those inputs always come from the real function."""
    phon_phrase = "".join(hl_phon)
    k = len(hl_phon)
    if global_search:
        if k < 2:
            return None
        lo, hi = 0, len(canon)
    else:
        lo, hi = max(0, cursor - va.BACK_WINDOW), min(len(canon), cursor + va.FWD_WINDOW)
    best = None
    for size in sorted({max(1, k - 1), k, k + 1}):
        for s in range(lo, max(lo, hi - size + 1)):
            score = fuzz.ratio(phon_phrase, "".join(c.phon for c in canon[s:s + size]))
            if not global_search:
                score -= abs(s - cursor) * 0.15
            if best is None or score > best[2]:
                best = (s, s + size - 1, score)
    if best is None:
        return None
    floor = va.MIN_SCORE_GLOBAL if global_search else (va.MIN_SCORE_SINGLE if k == 1 else va.MIN_SCORE)
    if best[2] < floor:
        return None
    s, e, phon_score = best
    char_score = fuzz.ratio("".join(hl_norm), "".join(c.norm for c in canon[s:e + 1]))
    return None if char_score < va.CHAR_FLOOR else (s, e, phon_score, char_score)


def tie_break_cases(rng):
    """Exact score ties between window sizes essentially never happen on
    real text, but when they do the winner depends on match_phrase_dual's
    set-iteration order -- which only differs from ascending when the sizes
    straddle a multiple of 8 (k = 7 or 8). A two-letter alphabet makes ties
    common; only inputs where the order actually changes the result are
    kept."""
    cases = []
    attempts = 0
    while len(cases) < 12 and attempts < 50000:
        attempts += 1
        canon = [_Word("".join(rng.choice("אב") for _ in range(rng.randint(1, 3))))
                 for _ in range(rng.randint(25, 45))]
        k = rng.choice([7, 8])
        hl_norm = ["".join(rng.choice("אב") for _ in range(rng.randint(1, 3))) for _ in range(k)]
        hl_phon = [va.phonetic(w) for w in hl_norm]
        cursor = rng.randrange(len(canon))
        global_search = rng.random() < 0.5
        real = va.match_phrase_dual(canon, hl_norm, hl_phon, cursor, global_search=global_search)
        if real == _match_ascending(canon, hl_norm, hl_phon, cursor, global_search):
            continue
        cases.append({"canonNorms": [c.norm for c in canon], "hlNorm": hl_norm, "hlPhon": hl_phon,
                      "cursor": cursor, "global": global_search,
                      "expected": None if real is None else list(real)})
    return cases


def crafted_sequence(canon):
    """Hand-built edge cases for match_runs' confirmation rule: a second
    global match too far forward (> FWD_WINDOW) or behind the first must NOT
    confirm a lock; it just becomes the new pending candidate. Up to
    PENDING_MAX_MISSES unplaceable runs in between do not break a candidate."""
    def read(start, k=6):
        return as_run([c.norm for c in canon[start:start + k]])
    return [
        read(100), read(300),           # forward but > FWD_WINDOW apart: no lock
        read(306),                      # agrees with 300: lock confirmed
        read(312), read(318),           # ordinary local continuation
        as_run(["בבבב", "גגגג", "דדדד"]),  # an unplaceable run while locked
        read(324),
        read(700), read(680),           # far: local misses only (batch never relocalizes this early)
    ] + [as_run(["זזזז", "טטטט"])] * 12 + [   # 12 straight misses: lock lost
        read(500), read(480),           # second match BEHIND the first: no lock
        read(486),                      # agrees with 480: lock confirmed
    ] + [as_run(["זזזז", "טטטט"])] * 12 + [   # lost again
        read(200),
        as_run(["בבבב", "גגגג", "דדדד"]), as_run(["בבבב", "גגגג", "דדדד"]),   # 2 unplaceable runs in between...
        read(206),                      # ...still agree with 200: lock confirmed (PENDING_MAX_MISSES)
    ] + [as_run(["זזזז", "טטטט"])] * 12 + [   # lost again
        read(400),
    ] + [as_run(["בבבב", "גגגג", "דדדד"])] * (va.PENDING_MAX_MISSES + 1) + [   # too many in between...
        read(406),                      # ...the candidate was dropped: this is a new one, no lock
    ]


def shiur_sequence(rng, canon, jumps):
    """A simulated shiur: consecutive phrases read in order (with ASR-style
    noise), English-only stretches (no run at all), garbage Hebrew-script
    runs, and the listed jumps (word index to continue reading from)."""
    n = len(canon)
    pos = 0
    runs = []
    jumps = list(jumps)
    while pos < n - 3 and len(runs) < 90:
        if jumps and rng.random() < 0.08:
            pos = jumps.pop(0)
        roll = rng.random()
        if roll < 0.12:
            runs.append(as_run(perturb(rng, ["x"] * rng.randint(2, 5), "garbage")))
            continue
        k = rng.randint(2, 8)
        kind = rng.choice(["exact", "exact", "confuse", "drop_letter", "drop_word"])
        norms = [w for w in perturb(rng, [c.norm for c in canon[pos:pos + k]], kind) if w]
        if norms:
            runs.append(as_run(norms))
        pos += k + rng.randint(0, 6)
    return runs


def main():
    rng = random.Random(20261006)
    canon, segments = coa.load_canonical(REFS)
    for c in canon:  # exactly what voice_align.process_video does before matching
        c.phon = va.phonetic(c.norm)

    sequences = []
    for jumps in ([], [40], [5, 300], [len(canon) // 2, 30]):
        runs = shiur_sequence(rng, canon, jumps)
        matches, _, _, _ = va.match_runs(canon, runs, llm_rescue=False)
        sequences.append({"runs": [[w["norm"] for w in r] for r in runs], "expected": matches})
    crafted = crafted_sequence(canon)
    matches, _, _, _ = va.match_runs(canon, crafted, llm_rescue=False)
    sequences.append({"runs": [[w["norm"] for w in r] for r in crafted], "expected": matches})

    ratio_pairs = []
    for _ in range(60):
        a = "".join(rng.choice(LETTERS) for _ in range(rng.randint(0, 30)))
        b = "".join(rng.choice(LETTERS) for _ in range(rng.randint(0, 30)))
        ratio_pairs.append({"a": a, "b": b, "ratio": fuzz.ratio(a, b)})

    raw_tokens = [c.text for c in canon[::7]] + [
        "רַב־הוּנָא", "שׁ", "וכו'", "Rava", "5", "״אמר״", "שׁמע", "(דף", "אֲמַר:",
    ]
    fixture = {
        "generatedBy": "tools/caption-sync/gen_live_matcher_parity.py",
        "refs": REFS,
        "segments": segments,
        "canonNorms": [c.norm for c in canon],
        "normalize": [{"raw": t, "norm": coa.normalize_word(t),
                       "phon": va.phonetic(coa.normalize_word(t))} for t in raw_tokens],
        "ratio": ratio_pairs,
        "phrases": phrase_cases(rng, canon),
        "tieBreaks": tie_break_cases(rng),
        "sequences": sequences,
        "keyterms38": va.build_keyterm_list(canon, max_terms=38),
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(fixture, f, ensure_ascii=False, indent=1)
        f.write("\n")
    print(f"Wrote {os.path.relpath(OUT)}: {len(canon)} canon words, "
          f"{len(fixture['phrases'])} phrase cases, {len(sequences)} sequences.")


if __name__ == "__main__":
    main()
