#!/usr/bin/env python3
"""Path alignment for the voice engine: reads the Gemara out of the WHOLE
transcript, in either alphabet, and places it along the daf as one ordered path.

Two things voice_align.py's phrase-by-phrase matcher cannot do, both found on real
shiurim (R' Sruly Bornstein, Lakewood Daf Yomi):

  1. The transcriber writes most of what the maggid reads from the daf in ENGLISH
     letters, the way he says it -- "Vehamoicher lai", "Af alpisha ini Rashi",
     "patum min habechira shenemar" -- and only some of it in Hebrew letters. The
     phrase matcher looks at Hebrew letters alone. Here the daf is turned into the
     sounds an Ashkenazi reader makes (from its nikud: a tav without a dagesh is
     "s", a cholam is a vowel and so on) and the English-letter words into the same
     consonant skeleton, so the two can be compared.

  2. A maggid reads two or three words, translates them, and reads the next two or
     three. Alone, a fragment that short fits many places on a daf and has to be
     thrown away. Here every stretch of the transcript that could be daf text keeps
     ALL the places it could be, and one pass (a Viterbi search) picks the single
     path through the shiur that explains the most of them while moving through the
     daf in order -- staying put, stepping forward, or going back a little to
     re-read are cheap; a far jump has to be paid for by what follows it.

Everything is placed on the shiur's own clock rather than on one transcript's word
order, so any number of transcripts of the same audio can be given as WITNESSES --
one made with the daf's words as a hint list (which makes the transcriber write
Hebrew letters), one without (all English letters), one of the audio slowed down
-- and each stretch of the shiur is read from whichever heard it best. The phrase
matcher's own placements (its Claude rescues included) can be handed in as further
proposals. The path arbitrates everything that is known.

Returns the same WordEvent list and matchStats shape voice_align.py publishes.
"""
import bisect
import heapq
import re
import unicodedata
from collections import namedtuple

import numpy as np
from rapidfuzz import fuzz, process

from caption_ocr_align import WordEvent, normalize_word
from spoken_forms import spoken_witness

# ---------------------------------------------------------------------------
# Sounds
# ---------------------------------------------------------------------------
_DAGESH, _SHIN_DOT, _SIN_DOT, _HOLAM = "ּ", "ׁ", "ׂ", "ֹ"
_VOWELS = frozenset("ְֱֲֳִֵֶַָׇֹֺֻ")
_PLAIN = {
    "ג": "g", "ד": "d", "ז": "z", "ח": "x", "ט": "t", "ל": "l", "מ": "m", "ם": "m",
    "נ": "n", "ן": "n", "ס": "s", "צ": "ts", "ץ": "ts", "ק": "k", "ר": "r", "ך": "x", "ף": "f",
}
_DOUBLED = re.compile(r"(.)\1+")


def ashkenazi_skeleton(vocalized_word):
    """The consonants of a vocalized word as an Ashkenazi reader says them, in a
    small Latin alphabet (x = ch, S = sh). Vowels are left out on both sides: they
    are the least reliable part of a transcript, and the nikud is only needed to
    tell b from v, k from ch, p from f, t from s, sh from s, and a vav or yud that is
    a consonant from one that is only a vowel."""
    letters = []
    for ch in unicodedata.normalize("NFD", vocalized_word):
        if "א" <= ch <= "ת":
            letters.append([ch, ""])
        elif letters and "֑" <= ch <= "ׇ":
            letters[-1][1] += ch
    out = []
    for k, (ch, marks) in enumerate(letters):
        dagesh = _DAGESH in marks
        vowel = any(m in _VOWELS for m in marks)
        if ch in "אע":
            continue
        if ch == "ה":
            if k < len(letters) - 1 or vowel:
                out.append("h")
        elif ch == "ו":
            if not (_HOLAM in marks or (dagesh and not vowel)):   # not "o", not "u"
                out.append("v")
        elif ch == "י":
            if vowel or dagesh:
                out.append("y")
        elif ch == "ב":
            out.append("b" if dagesh else "v")
        elif ch == "כ":
            out.append("k" if dagesh else "x")
        elif ch == "פ":
            out.append("p" if dagesh else "f")
        elif ch == "ת":
            out.append("t" if dagesh else "s")
        elif ch == "ש":
            out.append("s" if _SIN_DOT in marks else "S")
        else:
            out.append(_PLAIN.get(ch, ""))
    return _DOUBLED.sub(r"\1", "".join(out))


_LATIN_PAIRS = (
    ("tch", "x"), ("sch", "S"), ("sh", "S"), ("ch", "x"), ("kh", "x"), ("tz", "ts"),
    ("th", "s"), ("ph", "f"), ("ck", "k"), ("qu", "k"), ("c", "k"), ("q", "k"),
    ("w", "v"), ("j", "y"),
)
_NOT_LATIN = re.compile(r"[^a-z]")
_Y_VOWEL = re.compile(r"y(?![aeiou])")
_LATIN_VOWELS = re.compile(r"[aeiou]")


def latin_skeleton(word):
    """The same consonant skeleton for a word the transcriber spelled in English
    letters ("Vehamoicher" -> vhmxr)."""
    w = _NOT_LATIN.sub("", word.lower())
    for a, b in _LATIN_PAIRS:
        w = w.replace(a, b)
    w = _Y_VOWEL.sub("", w)
    w = _LATIN_VOWELS.sub("", w)
    if w.endswith("h"):
        w = w[:-1]
    return _DOUBLED.sub(r"\1", w)


# Sounds a transcriber swaps freely when it spells Hebrew by ear.
_FOLD = str.maketrans({"z": "s", "f": "v", "p": "b", "d": "t", "g": "k", "y": "", "h": ""})


def fold(skeleton):
    return skeleton.translate(_FOLD)


# ---------------------------------------------------------------------------
# Which English-letter words are just English
# ---------------------------------------------------------------------------
COMMON_ENGLISH_WORDS = 5000


def load_common_english(n=COMMON_ENGLISH_WORDS):
    """The n most common English words (wordfreq), so "owns an" is not read as
    "vehanoisen". Without the package nothing is filtered, and the path has to
    reject English by itself -- it mostly does, but less cleanly."""
    try:
        from wordfreq import top_n_list
    except ImportError:
        print("wordfreq is not installed -- English words are not filtered out of the path alignment.")
        return frozenset()
    return frozenset(top_n_list("en", n))


_HEBREW_LETTER = re.compile(r"[א-ת]")
_WORD_CHARS = re.compile(r"[^a-z']")

# ---------------------------------------------------------------------------
# Tuning
# ---------------------------------------------------------------------------
MAX_WINDOW_WORDS = 5          # transcript words (and daf words) in one comparison
MAX_WINDOW_GAP_SECONDS = 2.0  # a longer silence ends a stretch
MIN_WINDOW_CHARS = 4          # skeleton letters; anything shorter says nothing
# A stretch this short is only believed where the path already is (see _transition).
SHORT_WINDOW_CHARS = 5
# English-letter stretch: at least this share of its skeleton must come from words
# that are not common English.
MIN_FOREIGN_SHARE = 0.6
# A long unbroken run of Hebrew letters is mostly the transcriber's own prose --
# but not only: R' Bornstein's Eruchin 2 (November 2026) had 798 words in four
# such runs, five lines of Gemara read phrase by phrase among them, and when the
# whole run was thrown out none of those 74 daf words were placed. So a word in
# a long run is still read, but on the path only as part of a phrase of
# LONG_RUN_MIN_WINDOW_WORDS words or more that matches the daf closely
# (LONG_RUN_SCORE_FLOOR): one prose word that happens to stand on the daf, with
# whatever word follows it, says nothing. Between two placed neighbours
# (fill_gaps), where the place is already known, any of them counts as usual.
MAX_HEBREW_RUN_WORDS = 25
LONG_RUN_MIN_WINDOW_WORDS = 2
LONG_RUN_SCORE_FLOOR = 90
SCORE_CUTOFF = 78


def _score_floor(chars):
    """The shorter the stretch, the closer the match has to be."""
    if chars <= 4:
        return 100
    if chars <= 6:
        return 88
    if chars <= 9:
        return 80
    return SCORE_CUTOFF


# The path. All in "reward units": a perfect match earns REWARD_PER_CHAR per
# skeleton letter.
REWARD_PER_CHAR = 0.9
NEAR_FORWARD_WORDS = 3        # this far ahead is simply reading on
NEAR_BACK_WORDS = 12          # this far back is re-reading the phrase
STEP_BACK_COST = 0.8
FORWARD_COST_PER_WORD = 0.12
FORWARD_COST_MAX = 14.0
FAR_BACK_COST = 4.0
FAR_BACK_COST_PER_WORD = 0.25
FAR_BACK_COST_MAX = 16.0

MAX_UNMATCHED_LISTED = 200
# A proposal scored below this by its own matcher still earns a little on the path.
PROPOSAL_MIN_SCORE = 71.0

# A stretch of the shiur read as a stretch of the daf: seconds t0..t1, daf words
# s..e, how alike (0-100), how many skeleton letters were compared, who says so.
Candidate = namedtuple("Candidate", "t0 t1 s e score chars source text")

SOURCE_LATIN = "path-latin"
SOURCE_HEBREW = "path-hebrew"
SOURCE_PHRASE = "path-phrase"
SOURCE_LATIN_GAP = "path-latin-gap"
SOURCE_HEBREW_GAP = "path-hebrew-gap"
SOURCE_BRIDGE = "path-bridge"
SOURCE_SPOKEN = "path-spoken"
PATH_SOURCE_LABELS = {
    SOURCE_BRIDGE: "Filled in between two placed phrases a moment apart (not heard on its own)",
    SOURCE_LATIN: "Read from English-letter spelling",
    SOURCE_HEBREW: "Read from Hebrew letters",
    SOURCE_LATIN_GAP: "Second look between placed phrases (English letters)",
    SOURCE_HEBREW_GAP: "Second look between placed phrases (Hebrew letters)",
    SOURCE_PHRASE: "Phrase matcher, kept by the path",
    SOURCE_SPOKEN: "Said another way (a count, a date), written the daf's way",
}


def build_tokens(words, english):
    """One token per transcript word: which alphabet it is in and its skeleton."""
    tokens = []
    for w in words:
        text = w.get("text", "")
        token = {"text": text, "start": w["start"], "end": w["end"], "script": None, "sk": "", "common": False}
        if _HEBREW_LETTER.search(text):
            norm = normalize_word(text)
            if norm:
                token.update(script="he", norm=norm)
        else:
            sk = fold(latin_skeleton(text))
            plain = _WORD_CHARS.sub("", text.lower()).strip("'")
            token.update(script="lat", sk=sk, common=plain in english or plain.replace("'", "") in english)
        tokens.append(token)
    return tokens


def _hebrew_run_lengths(tokens):
    """For each token, how many Hebrew-letter words stand in its unbroken run."""
    lengths = [0] * len(tokens)
    i = 0
    while i < len(tokens):
        if tokens[i]["script"] != "he":
            i += 1
            continue
        j = i
        while j + 1 < len(tokens) and tokens[j + 1]["script"] == "he":
            j += 1
        for k in range(i, j + 1):
            lengths[k] = j - i + 1
        i = j + 1
    return lengths


def _daf_windows(strings, lo=0, hi=None, min_chars=MIN_WINDOW_CHARS):
    """Every stretch of 1..MAX_WINDOW_WORDS daf words in [lo, hi), as (start, end, joined)."""
    hi = len(strings) if hi is None else hi
    out = []
    for s in range(lo, hi):
        acc = ""
        for length in range(1, MAX_WINDOW_WORDS + 1):
            if s + length > hi:
                break
            acc += strings[s + length - 1]
            if len(acc) >= min_chars:
                out.append((s, s + length - 1, acc))
    return out


def _transcript_windows(tokens, script, key, usable, a=0, b=None, min_chars=MIN_WINDOW_CHARS, min_words=None):
    """Every stretch of 1..MAX_WINDOW_WORDS consecutive transcript words in [a, b)
    in one alphabet, as (first index, word count, joined, share that is not common
    English). min_words(i), when given, is the fewest words a stretch starting at
    word i may have."""
    b = len(tokens) if b is None else b
    out = []
    for i in range(a, b):
        first = tokens[i]
        if first["script"] != script or not usable(i):
            continue
        acc, foreign = "", 0
        for length in range(1, MAX_WINDOW_WORDS + 1):
            j = i + length - 1
            if j >= b:
                break
            token = tokens[j]
            if token["script"] != script or not usable(j):
                break
            if length > 1 and token["start"] - tokens[j - 1]["end"] > MAX_WINDOW_GAP_SECONDS:
                break
            piece = token[key]
            acc += piece
            if not token["common"]:
                foreign += len(piece)
            if not piece and length == 1:
                break
            if min_words is not None and length < min_words(i):
                continue
            if len(acc) >= min_chars and piece and not token["common"] and not first["common"]:
                share = foreign / len(acc)
                if share >= MIN_FOREIGN_SHARE:
                    out.append((i, length, acc, share))
    return out


def _compare(windows, daf_windows, source, cands, floor=_score_floor, cutoff=SCORE_CUTOFF, batch=4000):
    daf_strings = [d[2] for d in daf_windows]
    if not daf_strings:
        return
    for b in range(0, len(windows), batch):
        block = windows[b:b + batch]
        matrix = process.cdist([w[2] for w in block], daf_strings, scorer=fuzz.ratio,
                               score_cutoff=cutoff, dtype=np.uint8, workers=-1)
        rows, cols = np.nonzero(matrix)
        for q, d in zip(rows.tolist(), cols.tolist()):
            i, length, text, _share = block[q]
            s, e, daf_text = daf_windows[d]
            score = int(matrix[q, d])
            chars = min(len(text), len(daf_text))
            if score < floor(chars):
                continue
            cands.setdefault(i, []).append((length, s, e, float(score), chars, source))


class _Witness:
    """One transcript of the shiur, and the daf, each as the strings the two
    alphabets are compared in."""

    def __init__(self, words, canon, phonetic, english, daf_latin, daf_hebrew, sources=None):
        self.sources = sources
        self.tokens = build_tokens(words, english)
        self.starts = [t["start"] for t in self.tokens]
        self.daf_latin = daf_latin
        self.daf_hebrew = daf_hebrew
        # A long unbroken run of Hebrew letters is the transcriber's own prose --
        # except in a rewritten witness, which is nothing but daf-form words.
        self.run_lengths = [1] * len(self.tokens) if sources else _hebrew_run_lengths(self.tokens)
        for token in self.tokens:
            if token["script"] == "he":
                token["phon"] = phonetic(token["norm"])

    def candidates(self, a=0, b=None, lo=0, hi=None, floor=_score_floor, cutoff=SCORE_CUTOFF, sources=None,
                   min_chars=MIN_WINDOW_CHARS, long_run_min_words=LONG_RUN_MIN_WINDOW_WORDS):
        """Every place in daf words [lo, hi) each stretch of transcript words [a, b)
        could be, as Candidates on the shiur's clock. A stretch that starts in a
        long run of Hebrew letters needs long_run_min_words words."""
        sources = sources or self.sources or (SOURCE_LATIN, SOURCE_HEBREW)
        found = {}
        latin = _transcript_windows(self.tokens, "lat", "sk", lambda i: True, a, b, min_chars)
        _compare(latin, _daf_windows(self.daf_latin, lo, hi, min_chars), sources[0], found, floor, cutoff)
        in_long_run = lambda i: self.run_lengths[i] > MAX_HEBREW_RUN_WORDS   # noqa: E731
        daf_hebrew = _daf_windows(self.daf_hebrew, lo, hi, min_chars)
        if long_run_min_words <= 1:
            hebrew = _transcript_windows(self.tokens, "he", "phon", lambda i: True, a, b, min_chars)
            _compare(hebrew, daf_hebrew, sources[1], found, floor, cutoff)
        else:
            hebrew = _transcript_windows(self.tokens, "he", "phon", lambda i: not in_long_run(i), a, b, min_chars)
            _compare(hebrew, daf_hebrew, sources[1], found, floor, cutoff)
            prose = _transcript_windows(self.tokens, "he", "phon", in_long_run, a, b, min_chars,
                                        lambda i: long_run_min_words)
            _compare(prose, daf_hebrew, sources[1], found,
                     lambda chars: max(floor(chars), LONG_RUN_SCORE_FLOOR), cutoff)
        out = []
        for i, places in found.items():
            for length, s, e, score, chars, source in places:
                out.append(Candidate(self.tokens[i]["start"], self.tokens[i + length - 1]["end"], s, e, score, chars,
                                     source, " ".join(t["text"] for t in self.tokens[i:i + length])))
        return out

    def adjoining(self, t, lo, hi, after_phrase, limit):
        """What stands right next to a placed phrase, against the daf words right
        next to it: the best (score, daf words, Candidate) of the transcript words
        that follow time t without a pause (after_phrase; else lead up to it)
        read as daf words lo.. (else ..hi - 1), or None. limit: the time the
        words may not pass (the next placed phrase; else the one before)."""
        tokens = self.tokens
        if after_phrase:
            i = bisect.bisect_left(self.starts, t - OVERLAP_SLACK_SECONDS)
            if i >= len(tokens) or tokens[i]["start"] - t > READ_ON_MAX_PAUSE_SECONDS:
                return None
            spans = [(i, i + n) for n in range(1, READ_ON_MAX_TOKENS + 1) if i + n <= len(tokens)]
        else:
            j = bisect.bisect_right(self.starts, t + OVERLAP_SLACK_SECONDS) - 1
            while j >= 0 and tokens[j]["end"] > t + OVERLAP_SLACK_SECONDS:
                j -= 1
            if j < 0 or t - tokens[j]["end"] > READ_ON_MAX_PAUSE_SECONDS:
                return None
            spans = [(j + 1 - n, j + 1) for n in range(1, READ_ON_MAX_TOKENS + 1) if j + 1 - n >= 0]
        best = None
        for a, b in spans:
            stretch = tokens[a:b]
            script = stretch[0]["script"]
            if script is None or any(tok["script"] != script or tok["common"] for tok in stretch):
                break
            if any(y["start"] - x["end"] > MAX_WINDOW_GAP_SECONDS for x, y in zip(stretch, stretch[1:])):
                break
            if (after_phrase and stretch[-1]["end"] > limit + OVERLAP_SLACK_SECONDS) or \
                    (not after_phrase and stretch[0]["start"] < limit - OVERLAP_SLACK_SECONDS):
                break
            key, daf, source = ("sk", self.daf_latin, SOURCE_LATIN_GAP) if script == "lat" \
                else ("phon", self.daf_hebrew, SOURCE_HEBREW_GAP)
            heard = "".join(tok[key] for tok in stretch)
            if len(heard) < READ_ON_MIN_CHARS:
                continue
            for n in range(1, hi - lo + 1):
                s, e = (lo, lo + n - 1) if after_phrase else (hi - n, hi - 1)
                written = "".join(daf[s:e + 1])
                chars = min(len(heard), len(written))
                if chars < READ_ON_MIN_CHARS:
                    continue
                score = fuzz.ratio(heard, written)
                if score < _read_on_floor(chars):
                    continue
                rank = (score, n)
                if best is None or rank > best[:2]:
                    best = (score, n, Candidate(stretch[0]["start"], stretch[-1]["end"], s, e, float(score), chars,
                                                self.sources[0] if self.sources else source,
                                                " ".join(tok["text"] for tok in stretch)))
        return best

    def between(self, t0, t1):
        """The transcript words that start inside (t0, t1), as an index range."""
        return bisect.bisect_left(self.starts, t0), bisect.bisect_left(self.starts, t1)


def _transition_costs(n_words):
    """cost[s][p]: what it costs the path to be at daf position p (the word after
    the last one placed) and place the next stretch starting at s."""
    p = np.arange(n_words + 1)
    table = []
    for s in range(n_words + 1):
        d = s - p
        cost = np.zeros(n_words + 1)
        cost = np.where(d > NEAR_FORWARD_WORDS, np.minimum(FORWARD_COST_MAX, FORWARD_COST_PER_WORD * d), cost)
        cost = np.where((d < 0) & (d >= -NEAR_BACK_WORDS), STEP_BACK_COST, cost)
        cost = np.where(d < -NEAR_BACK_WORDS,
                        np.minimum(FAR_BACK_COST_MAX, FAR_BACK_COST + FAR_BACK_COST_PER_WORD * -d), cost)
        table.append(cost)
    return table


# Two stretches may share this much of the clock (two witnesses time the same
# words a little differently).
OVERLAP_SLACK_SECONDS = 0.05


def best_path(cands, n_words, forward_only=False):
    """The cheapest way through the shiur: every stretch is either not daf text or
    one of its candidate places, and no two chosen stretches overlap in time.
    Returns the chosen Candidates in time order.
    forward_only: the path may not step back at all (used inside a gap, where the
    two ends are already fixed)."""
    if not cands or not n_words:
        return []
    costs = _transition_costs(n_words)
    if forward_only:
        position = np.arange(n_words + 1)
        costs = [np.where(position > s, np.inf, c) for s, c in enumerate(costs)]
    near = [np.flatnonzero(c == 0.0) for c in costs]      # positions a short stretch may follow from
    best = np.zeros(n_words + 1)          # best[p]: cheapest path so far that ends at daf position p
    owner = [None] * (n_words + 1)        # the record that put it there
    records = []                          # (previous record, candidate)
    pending = []                          # heap of (end time, order, daf position, cost, record)

    def settle(until):
        while pending and pending[0][0] <= until:
            _t, _n, position, cost, record = heapq.heappop(pending)
            if cost < best[position] - 1e-12:
                best[position] = cost
                owner[position] = record

    for cand in sorted(cands, key=lambda c: (c.t0, c.t1)):
        settle(cand.t0 + OVERLAP_SLACK_SECONDS)
        if cand.chars <= SHORT_WINDOW_CHARS:
            # Too short to move the path: only where the path already is.
            allowed = near[cand.s]
            if not len(allowed):
                continue
            k = int(allowed[np.argmin(best[allowed])])
            total = best[k]
        else:
            through = best + costs[cand.s]
            k = int(np.argmin(through))
            total = through[k]
        if not np.isfinite(total):
            continue
        reward = cand.chars * (cand.score - 70.0) / 30.0 * REWARD_PER_CHAR
        records.append((owner[k], cand))
        heapq.heappush(pending, (cand.t1, len(records), cand.e + 1, total - reward, len(records) - 1))
    settle(float("inf"))
    record = owner[int(np.argmin(best))]
    placed = []
    while record is not None:
        record, cand = records[record]
        placed.append(cand)
    placed.reverse()
    return placed


# A second look at what the path left out. Between two neighbouring placements the
# daf words that fall between them are the only ones the shiur there can be, so a
# much looser likeness is enough -- the garbled "מדבר שלשון" is plainly
# "המדבר של לשונו" once nothing else is on offer.
GAP_MAX_DAF_WORDS = 80
GAP_SCORE_CUTOFF = 60


def _gap_floor(chars):
    if chars <= 4:
        return 90
    if chars <= 6:
        return 75
    if chars <= 9:
        return 66
    return GAP_SCORE_CUTOFF


# A gap of only a word or two between two placed phrases is where the short words
# end up that the rest of the matcher ignores (סבר, אלו, עד, ליה: under
# MIN_WINDOW_CHARS letters, they would match by chance anywhere on the daf). Inside
# such a gap there is nothing else they can be, so they are looked for there --
# but only as an exact sound match. Two transcripts time the same word a little
# differently, so the search reaches SHORT_GAP_TIME_SLACK seconds past either end.
SHORT_GAP_DAF_WORDS = 2
SHORT_GAP_MIN_CHARS = 2
SHORT_GAP_TIME_SLACK = 1.0


def _short_gap_floor(chars):
    return 100 if chars <= 3 else _gap_floor(chars)


def fill_gaps(witnesses, placed, short_words=True):
    """Placements for the stretches between neighbours on the path (the new ones only)."""
    found = []
    for before, after in zip(placed, placed[1:]):
        lo, hi = before.e + 1, after.s
        if after.t0 <= before.t1 or hi <= lo or hi - lo > GAP_MAX_DAF_WORDS:
            continue
        short = short_words and hi - lo <= SHORT_GAP_DAF_WORDS
        slack = SHORT_GAP_TIME_SLACK if short else 0.0
        cands = []
        for witness in witnesses:
            a, b = witness.between(before.t1 - OVERLAP_SLACK_SECONDS - slack, after.t0 + slack)
            if b > a:
                sources = witness.sources or (SOURCE_LATIN_GAP, SOURCE_HEBREW_GAP)
                if short:
                    cands += witness.candidates(a, b, lo, hi, _short_gap_floor, GAP_SCORE_CUTOFF,
                                                sources, SHORT_GAP_MIN_CHARS, long_run_min_words=1)
                else:
                    cands += witness.candidates(a, b, lo, hi, _gap_floor, GAP_SCORE_CUTOFF, sources,
                                                long_run_min_words=1)
        local = [c._replace(s=c.s - lo, e=c.e - lo) for c in cands if c.t1 <= after.t0 + OVERLAP_SLACK_SECONDS + slack]
        for c in best_path(local, hi - lo, forward_only=True):
            found.append(c._replace(s=c.s + lo, e=c.e + lo))
    return found


# What the maggid read on to and the transcriber mangled. He reads לאתויי מנוול
# ומוכה שחין in one breath and then explains for a quarter of a minute; the
# transcript has "Laasui yayi menuvah u'mokashim." The last word is ומוכה שחין,
# but as a match it is a poor one (two words run into one, 67 of 100), and
# anywhere in those fifteen seconds of English it could not be taken. Standing
# right after a placed phrase, with no pause, against the very daf words that
# come next, it can: there is little else it could be. The same holds for what
# leads straight into a placed phrase. (R' Bornstein's Eruchin 2, 18:52: the
# two words stayed dark while he read them.)
READ_ON_MAX_DAF_WORDS = 4
READ_ON_MAX_TOKENS = 3
READ_ON_MAX_PAUSE_SECONDS = 1.0
READ_ON_MIN_CHARS = 3


def _read_on_floor(chars):
    if chars <= 3:
        return 100
    return 65 if chars <= 5 else GAP_SCORE_CUTOFF


def read_on(witnesses, placed):
    """Placements for the few daf words between two neighbours on the path that
    the maggid read straight after the first or straight into the second (the
    new ones only)."""
    found = []
    for before, after in zip(placed, placed[1:]):
        lo, hi = before.e + 1, after.s
        if not 1 <= hi - lo <= READ_ON_MAX_DAF_WORDS or after.t0 <= before.t1:
            continue
        options = []
        for witness in witnesses:
            options.append(witness.adjoining(before.t1, lo, hi, True, after.t0))
            options.append(witness.adjoining(after.t0, lo, hi, False, before.t1))
        options = [o for o in options if o]
        if options:
            found.append(max(options, key=lambda o: o[:2])[2])
    return found


# A word or two the transcriber garbled between two phrases that were placed a
# moment apart was read all the same: the maggid does not skip one word of the daf
# and come straight back. Such words are filled in ("bridged"), and counted apart
# from what was actually heard.
BRIDGE_MAX_DAF_WORDS = 2
BRIDGE_MAX_SECONDS = 4.0
BRIDGE_SCORE = 60.0
# A longer hole is filled in the same way when the time between the two placed
# phrases is what reading that many words takes: a few words the transcriber
# mangled past recognising ("ומשום יוסף" for ומשום יתום) in the few seconds they
# take to say. Slower than PACE_FILL_MAX_SECONDS_PER_WORD and the maggid stopped
# to explain, so the words may not have been read there at all. On Bechoros 58
# this took one transcript from 78% of the daf to 85%; on Bechoros 40, checked
# against its caption sync, it added ten fills, all in the right place.
PACE_FILL_MAX_DAF_WORDS = 6
PACE_FILL_MIN_SECONDS_PER_WORD = 0.12
PACE_FILL_MAX_SECONDS_PER_WORD = 1.2
PACE_FILL_MAX_SECONDS = 8.0


def bridge_holes(placed):
    """Candidates for the holes between consecutive placements (in time): one or
    two words BRIDGE_MAX_SECONDS apart or less, or up to PACE_FILL_MAX_DAF_WORDS
    words in the time it takes to read them."""
    found = []
    for before, after in zip(placed, placed[1:]):
        hole = after.s - before.e - 1
        if hole < 1:
            continue
        if hole <= BRIDGE_MAX_DAF_WORDS and 0 <= after.t0 - before.t0 <= BRIDGE_MAX_SECONDS:
            t = max(before.t0, min(before.t1, after.t0))
            found.append(Candidate(t, t, before.e + 1, after.s - 1, BRIDGE_SCORE, 0, SOURCE_BRIDGE, ""))
            continue
        pause = after.t0 - before.t1
        if (hole <= PACE_FILL_MAX_DAF_WORDS and 0 <= pause <= PACE_FILL_MAX_SECONDS
                and PACE_FILL_MIN_SECONDS_PER_WORD <= pause / hole <= PACE_FILL_MAX_SECONDS_PER_WORD):
            found.append(Candidate(before.t1, before.t1, before.e + 1, after.s - 1, BRIDGE_SCORE, 0, SOURCE_BRIDGE, ""))
    return found


# The holes a placed path still has: daf words between two neighbouring placements
# that nothing placed. voice_align.py can listen to just that stretch of the audio
# again, hinted with just those words (its "relisten" witness).
# Up to a whole stretch of Gemara the first transcript lost (Eruchin 2: 74 words
# over five and a half minutes); voice_align.py's own limits (RELISTEN_MAX_*)
# keep what a shiur's re-listens cost in all.
HOLE_MAX_DAF_WORDS = 80
HOLE_MAX_SECONDS = 360.0


def find_holes(placed):
    """[(t0, t1, first daf word, last daf word)] for every hole between two
    placements next to each other in time and on the daf (the path moving on, not
    jumping), at most HOLE_MAX_DAF_WORDS and HOLE_MAX_SECONDS long."""
    holes = []
    for before, after in zip(placed, placed[1:]):
        lo, hi = before.e + 1, after.s - 1
        if not 1 <= hi - lo + 1 <= HOLE_MAX_DAF_WORDS:
            continue
        t0, t1 = before.t1, max(before.t1, after.t0)
        if t1 - t0 > HOLE_MAX_SECONDS:
            continue
        holes.append((round(t0, 2), round(t1, 2), lo, hi))
    return holes


# After the maggid has read the daf through, he usually goes on to discuss it,
# quoting it as he goes ("Hilchos Pesach", "Rosh Hashanah"). Those quotes are
# short and everywhere, and highlighting each one sent the reader hopping around
# the daf for the last 25 minutes of R' Bornstein's Bechoros 58. Once the reading
# is over, nothing more is placed: the highlight stays on the last line read.
AFTER_READING_GRACE_SECONDS = 20.0


def reading_chain(placed):
    """The reading itself: the placements (indices into placed, in time order)
    that go through the daf in order -- the longest chain, by daf words, whose
    starts never move back. Quotes before the reading, re-readings and quotes in
    the discussion afterwards fall off it."""
    best, prev = [], []
    for i, c in enumerate(placed):
        weight = c.e - c.s + 1
        top, link = weight, -1
        for j in range(i):
            if placed[j].s <= c.s and best[j] + weight > top:
                top, link = best[j] + weight, j
        best.append(top)
        prev.append(link)
    if not best:
        return []
    k = max(range(len(best)), key=lambda i: (best[i], -i))
    chain = []
    while k >= 0:
        chain.append(k)
        k = prev[k]
    return chain[::-1]


def end_of_reading(placed):
    """When the maggid finished reading the daf through (the end of
    reading_chain), or None."""
    chain = reading_chain(placed)
    return placed[chain[-1]].t1 if chain else None


def same_words_at(canon, s, e):
    """Every daf position where canon[s..e]'s words stand, in the same order
    (s itself included)."""
    words = [c.norm for c in canon[s:e + 1]]
    n = len(words)
    return [k for k in range(len(canon) - n + 1)
            if canon[k].norm == words[0] and [c.norm for c in canon[k:k + n]] == words] or [s]


# ---------------------------------------------------------------------------
# One straight path
# ---------------------------------------------------------------------------
# A maggid reads a phrase, explains it, says it again, and comes back to it ten
# minutes later. Every one of those used to be placed: on R' Bornstein's Eruchin 2
# half the daf's words stood at more than one moment, the highlight stepped back
# 85 times, and a tap on the first line went to its fourth saying. Now each daf
# word has one moment -- the first time it is read, in the order of the page --
# and the highlight only ever moves forward:
#   1. best_path(forward_only=True): the path never steps back.
#   2. first_readings: where the same words were read earlier, in order, that
#      earlier moment is theirs.
#   3. drop_closing_quotes, peel_strays, peel_late_strays: a quote of the daf in
#      the discussion after the reading, or of a line far ahead, is not the reading.
#   4. straight_chain: whatever is added afterwards (second looks, fills,
#      Claude's placements) is held to the same rule.

# An earlier reading may skip this many daf words the transcript did not catch.
FIRST_READING_SKIP_WORDS = 2
# It has to be a reading of its own, not the window a word or two before the
# path's own stretch: at least this long before the path reads those words...
FIRST_READING_MIN_EARLY_SECONDS = 5.0
# ...and not too long: a quote of the daf's opening words in the introduction,
# ten minutes before, is not the reading.
FIRST_READING_MAX_EARLY_SECONDS = 300.0
# How far below the best place for the same heard words a place may score and
# still be read as one of the best (the same words standing on two lines).
SAME_WORDS_SCORE_SLACK = 3.0


def _solid(cand):
    """More than one short word: enough to count as a reading on its own."""
    return cand.e > cand.s or cand.chars > SHORT_WINDOW_CHARS


def _best_scores(cands):
    """The best score any place on the daf got for each heard stretch."""
    best = {}
    for c in cands:
        key = (c.t0, c.t1)
        if c.score > best.get(key, 0.0):
            best[key] = c.score
    return best


def first_readings(path, cands):
    """The forward path with each stretch moved to the first time it was read.

    path: best_path(forward_only=True)'s Candidates, in time order. cands: every
    candidate the path chose from. Walks the shiur in time order with a frontier
    (the last daf word read so far). A candidate takes the words beyond the
    frontier, earlier than the path has them, when
      - it reads on from the frontier, skipping at most FIRST_READING_SKIP_WORDS;
      - those words are ones the path itself reads, between
        FIRST_READING_MIN_EARLY_SECONDS and FIRST_READING_MAX_EARLY_SECONDS later;
      - nowhere else on the daf fits what was heard better.
    The path's own stretches are taken when their time comes, so nothing the path
    reached is given up for more than those few skipped words.
    """
    if not path:
        return []
    chosen_time = {}
    for c in path:
        for i in range(c.s, c.e + 1):
            chosen_time.setdefault(i, c.t0)
    on_path = set(path)
    best = _best_scores(cands)

    frontier = path[0].s - 1
    out = []
    for c in sorted(set(cands) | on_path, key=lambda c: (c.t0, c.t1, c.s)):
        if c.e <= frontier:
            continue
        s, e = max(c.s, frontier + 1), c.e
        if c not in on_path:
            if not _solid(c) or c.s > frontier + 1 + FIRST_READING_SKIP_WORDS:
                continue
            if c.score < best[(c.t0, c.t1)] - SAME_WORDS_SCORE_SLACK:
                continue
            # Only the words the path reads, and reads later by enough.
            while e >= s and e not in chosen_time:
                e -= 1
            if e < s or any(i not in chosen_time for i in range(s, e + 1)):
                continue
            early = chosen_time[s] - c.t0
            if not FIRST_READING_MIN_EARLY_SECONDS <= early <= FIRST_READING_MAX_EARLY_SECONDS:
                continue
        out.append(c._replace(s=s, e=e))
        frontier = e
    return out


def drop_closing_quotes(placed, cands):
    """placed without the quotes at its end. Once the maggid has read the daf
    through he discusses it, quoting lines he has read ("hakol chayavin b'lulav,
    l'asuyei katan"); on a path that only goes forward, such a quote lands on the
    next line that shares its words, lines he never read. A closing stretch is a
    quote when what was heard fits a line already read as well as it fits here.
    Returns (kept, how many were dropped)."""
    if not placed:
        return placed, 0
    by_stretch = {}
    for c in cands:
        by_stretch.setdefault((c.t0, c.t1), []).append(c)
    read_at = {}
    for c in placed:
        for i in range(c.s, c.e + 1):
            read_at.setdefault(i, c.t0)

    def quote(c):
        for other in by_stretch.get((c.t0, c.t1), ()):
            if other.e < c.s and other.score >= c.score - SAME_WORDS_SCORE_SLACK \
                    and all(read_at.get(i, float("inf")) < c.t0 for i in range(other.s, other.e + 1)):
                return True
        return False

    kept = list(placed)
    while len(kept) > 1 and quote(kept[-1]):
        kept.pop()
    return kept, len(placed) - len(kept)


# Stretches at the end of the path that stand alone -- reached by skipping many
# more daf words than they hold -- are quotes, not the reading: the maggid citing
# a later line, or the next amud, in the discussion after he has finished. In the
# amud after the shiur's own daf, where he reads a few lines at most, it takes
# less to be let go. (The start of the path is left alone: a shiur that opens
# "four lines from the bottom of the amud before" reads those lines, however few
# of their words were caught.)
STRAY_SKIP_PER_WORD_OWN = 4.0
STRAY_MIN_SKIP_OWN = 12
STRAY_SKIP_PER_WORD_NEIGHBOUR = 2.0


def peel_strays(placed, primary=None):
    """placed without the lone stretches at its end. Returns (kept, how many were
    dropped). primary: the canon indices of the shiur's own daf (None: all of it).

    The longest run of closing stretches is let go when, taken together, far more
    daf words were skipped to reach them than they hold -- so one stray does not
    shelter the next."""
    own = None if primary is None else set(primary)
    drop = words = skipped = 0
    for n in range(len(placed) - 1, 0, -1):
        here, before = placed[n], placed[n - 1]
        edge = here.s - before.e - 1
        words += here.e - here.s + 1
        skipped += edge
        if own is not None and here.s not in own:
            stray = skipped > STRAY_SKIP_PER_WORD_NEIGHBOUR * words
        else:
            stray = edge >= STRAY_MIN_SKIP_OWN and skipped > STRAY_SKIP_PER_WORD_OWN * words
        if stray:
            drop = len(placed) - n
    return (placed[:-drop] if drop else list(placed)), drop


# The same in time. A maggid who stops a few lines short of the end of the daf
# and goes on to discuss it leaves quotes that land on the very next line, so
# no daf words are skipped to reach them and peel_strays lets them be. They
# stand minutes apart and hold a word or two each (R' Bornstein's Eruchin 4: he
# stops at line 20 of 4b after 35 minutes, and "yihyeh", "likro" and "nemrah
# mikol ha'am" in the next 11 minutes of discussion were placed on line 21). A
# closing run of stretches is let go when it begins after a long silence of
# the path and, from there to the end, holds far fewer daf words than a reading
# of that length would.
STRAY_LATE_MIN_GAP_SECONDS = 150.0
STRAY_LATE_SECONDS_PER_WORD = 40.0


def peel_late_strays(placed):
    """placed without the closing stretches that stand alone in time. Returns
    (kept, how many were dropped)."""
    if len(placed) < 2:
        return list(placed), 0
    end = placed[-1].t1
    drop = words = 0
    for n in range(len(placed) - 1, 0, -1):
        here, before = placed[n], placed[n - 1]
        words += here.e - here.s + 1
        if here.t0 - before.t1 >= STRAY_LATE_MIN_GAP_SECONDS \
                and (end - before.t1) / words > STRAY_LATE_SECONDS_PER_WORD:
            drop = len(placed) - n
    return (placed[:-drop] if drop else list(placed)), drop


def straight_chain(items, when, span, trim):
    """The most daf words that can be kept from items on one straight path: each
    word once, and never a word before one already read. Of two ways to keep as
    many, the earlier. An item that overlaps what is already read keeps only its
    new words.

    items: anything; when(item) is its time, span(item) its (first, last) daf
    word, trim(item, first) the item starting at a later first word. Returns the
    kept items in order. Used on a path already made forward (where it changes
    nothing but a stray overlap) and on alignments published before there was
    one (straighten_alignment.py).
    """
    order = sorted(items, key=lambda item: (when(item), span(item)[0], span(item)[1]))
    n = len(order)
    if not n:
        return []
    spans = [span(item) for item in order]
    times = [when(item) for item in order]
    best = [None] * n      # (words kept, -(sum of word * time)) for the best chain ending here
    link = [-1] * n
    for j in range(n):
        s, e = spans[j]
        words = e - s + 1
        top, back = (words, -words * times[j]), -1
        for i in range(j):
            if spans[i][1] >= e:
                continue
            new = e - max(s, spans[i][1] + 1) + 1
            value = (best[i][0] + new, best[i][1] - new * times[j])
            if value > top:
                top, back = value, i
        best[j], link[j] = top, back
    k = max(range(n), key=lambda j: (best[j], -j))
    chain = []
    while k >= 0:
        chain.append(k)
        k = link[k]
    chain.reverse()
    kept, frontier = [], -1
    for k in chain:
        s, e = spans[k]
        kept.append(order[k] if s > frontier else trim(order[k], frontier + 1))
        frontier = e
    return kept


def _straight(placed):
    return straight_chain(placed, lambda c: c.t0, lambda c: (c.s, c.e), lambda c, s: c._replace(s=s))


def counted_words(canon, primary, placed_words):
    """The daf words a shiur is measured against: its own daf (primary, canon
    indices), and of the amud read before and after it only the lines any of
    which was placed. A whole neighbouring amud the maggid never opened used to
    count against him (Eruchin 2: 412 of 895, 46%, where it was 412 of the daf's
    own 600). primary None: every word counts."""
    if primary is None:
        return set(range(len(canon)))
    counted = set(primary)
    touched = {canon[i].ref for i in placed_words if i not in counted}
    if touched:
        counted.update(i for i, c in enumerate(canon) if c.ref in touched)
    return counted


def align_path(canon, transcripts, phonetic, proposals=(), source_labels=None, english=None, gaps=True,
               short_words=True, bridges=True, spoken=True, keep_after_reading=False, debug=False,
               primary=None, straight=True):
    """Place the shiur on the daf.

    transcripts: one or more word lists ([{text, start, end}, ...]) of the same
        audio, all on the audio's own clock.
    proposals: placements another matcher already made, as
        (start seconds, end seconds, daf start, daf end, score, heard text[, source]);
        they compete on the path like any other candidate. source_labels names
        their sources for matchStats.

    straight: one straight path -- each daf word at one moment, the first time it
        is read in order, and never a step back (see "One straight path" above).
        False is the path as it was before: every saying of a phrase placed.

    Returns (events, stats): WordEvents for build_outputs, and matchStats.
    """
    if english is None:
        english = load_common_english()
    daf_latin = [fold(ashkenazi_skeleton(c.text)) for c in canon]
    daf_hebrew = [phonetic(c.norm) for c in canon]
    witnesses = [_Witness(words, canon, phonetic, english, daf_latin, daf_hebrew) for words in transcripts if words]
    if spoken:
        # Counts, dates and twins the maggid said another way, written the daf's
        # way (spoken_forms.py): one more witness per transcript that has any.
        for words in transcripts:
            rewritten = spoken_witness(words or [])
            if rewritten:
                witnesses.append(_Witness(rewritten, canon, phonetic, english, daf_latin, daf_hebrew,
                                          sources=(SOURCE_SPOKEN, SOURCE_SPOKEN)))
    cands = []
    for witness in witnesses:
        # A rewritten witness only fills holes (fill_gaps): a maggid says a date
        # again and again while explaining it, and each saying would pull the
        # path back to that line.
        if not witness.sources:
            cands += witness.candidates()
    labels = {**PATH_SOURCE_LABELS, **(source_labels or {})}
    for t0, t1, s, e, score, text, *source in proposals:
        chars = sum(len(c.norm) for c in canon[s:e + 1])
        # The phrase matcher names one place. When the same words stand
        # elsewhere on the daf too (the Gemara quoting its Mishnah word for
        # word, often from the amud before), every copy is offered and the path
        # takes the one it is reading.
        for start in same_words_at(canon, s, e):
            cands.append(Candidate(t0, max(t1, t0), start, start + e - s, float(max(score, PROPOSAL_MIN_SCORE)),
                                   chars, source[0] if source else SOURCE_PHRASE, text))
    placed = best_path(cands, len(canon), forward_only=straight)
    strays_after = 0
    if straight:
        placed = first_readings(placed, cands)
        if not keep_after_reading:
            placed, quotes = drop_closing_quotes(placed, cands)
            placed, strays_after = peel_strays(placed, primary)
            placed, late = peel_late_strays(placed)
            strays_after += late
            strays_after += quotes
    if gaps:
        placed = sorted(placed + fill_gaps(witnesses, placed, short_words), key=lambda c: (c.t0, c.t1))
        if straight:
            placed = _straight(placed)
    if bridges:
        placed = sorted(placed + bridge_holes(placed), key=lambda c: (c.t0, c.t1))
        if straight:
            placed = _straight(placed)
    if gaps:
        # After the bridges: a hole they fill whole is better left to them than
        # begun here, which would leave a remainder no rule fills.
        more = read_on(witnesses, placed)
        if more:
            placed = sorted(placed + more, key=lambda c: (c.t0, c.t1))
            if bridges:
                placed = sorted(placed + bridge_holes(placed), key=lambda c: (c.t0, c.t1))
            if straight:
                placed = _straight(placed)
    reading_ends = end_of_reading(placed)
    dropped_after_reading = strays_after
    stop_at = None if keep_after_reading or reading_ends is None else reading_ends + AFTER_READING_GRACE_SECONDS
    if stop_at is not None:
        kept = [c for c in placed if c.t0 <= stop_at]
        dropped_after_reading += len(placed) - len(kept)
        placed = kept

    events = []
    by_source = {}
    heard, bridged = set(), set()
    for c in placed:
        events.append(WordEvent(round(c.t0, 2), c.s, c.e, round(c.score, 1), c.text, c.source))
        bucket = by_source.setdefault(c.source, {"label": labels.get(c.source, c.source), "runs": 0, "words": 0})
        bucket["runs"] += 1
        bucket["words"] += c.e - c.s + 1
        (bridged if c.source == SOURCE_BRIDGE else heard).update(range(c.s, c.e + 1))
        if debug:
            print(f"  t={c.t0:7.2f}  [{c.s}-{c.e}] {c.score:5.1f} {c.source:16}  {c.text}  =>  "
                  f"{' '.join(w.text for w in canon[c.s:c.e + 1])}")

    # Stretches that looked like daf text somewhere but did not fit the path: the
    # longest reading of each moment, once.
    placed_starts = [c.t0 for c in placed]
    unmatched = []
    listed_until = float("-inf")
    for c in sorted(cands, key=lambda c: (c.t0, -(c.t1 - c.t0))):
        if c.t0 < listed_until or (stop_at is not None and c.t0 > stop_at):
            continue
        k = bisect.bisect_right(placed_starts, c.t1) - 1
        if k >= 0 and placed[k].t1 > c.t0:
            continue
        listed_until = c.t1
        unmatched.append({"start": round(c.t0, 2), "end": round(c.t1, 2), "text": c.text, "offeredToLlm": False})
        if len(unmatched) >= MAX_UNMATCHED_LISTED:
            break
    counted = counted_words(canon, primary, heard | bridged)
    stats = {
        "aligner": "path",
        "totalRuns": len(placed) + len(unmatched),
        # Of the words that count (counted_words): the shiur's own daf, and the
        # lines of its neighbours that were read.
        "totalWords": len(counted),
        "matchedWords": len((heard | bridged) & counted),
        "unmatchedWords": len(counted - heard - bridged),
        "excludedWords": 0,
        "bySource": by_source,
        "unmatched": unmatched,
        "excluded": [],
        "passes": 2 if gaps else 1,
        "llmCalls": 0,
        "witnesses": sum(1 for w in witnesses if not w.sources),     # transcripts, not rewrites of them
        "transcriptWords": sum(len(w.tokens) for w in witnesses if not w.sources),
        "dafWords": len(counted),
        "dafWordsHeard": len(heard & counted),
        "dafWordsBridged": len((bridged - heard) & counted),
        # Every word the engine had before it, neighbouring amudim and all.
        "wordsRead": len(canon),
        "ownDafWords": len(counted if primary is None else set(primary)),
        "readingEndsAt": round(reading_ends, 2) if reading_ends is not None else None,
        "droppedAfterReading": dropped_after_reading,
        # One moment a word, forward only (False on alignments made before November 2026).
        "straightPath": bool(straight),
        # Not published (voice_align.py takes it out): where a re-listen could help.
        "holes": find_holes(placed),
    }
    return events, stats
