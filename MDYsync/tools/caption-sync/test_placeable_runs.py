#!/usr/bin/env python3
"""Tests for voice_align.py's placeable-run rules and its far-move limit:

  * a lone Hebrew word, or a run shorter than ENGLISH_CONTEXT_MIN_RUN_WORDS inside an
    English sentence, is a term the speaker dropped in -- never placed;
  * one phrase cannot move a locked position more than MAX_SINGLE_JUMP_WORDS: a
    far match is held, and followed only when a different phrase carries on from it;
  * two agreeing global matches must be two different phrases.

Needs rapidfuzz (skipped without it); the OCR/ASR modules voice_align imports are stubbed.
`python3 test_placeable_runs.py`.
"""
import os
import random
import sys
import types
import unittest
from types import SimpleNamespace

for name in ('cv2', 'numpy', 'pytesseract', 'faster_whisper'):
    sys.modules.setdefault(name, types.ModuleType(name))
sys.modules['faster_whisper'].WhisperModel = None
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    import rapidfuzz  # noqa: F401
    import voice_align as va
    HAVE_DEPS = True
except Exception:  # pragma: no cover - environment without rapidfuzz
    HAVE_DEPS = False

LETTERS = 'אבגדהוזחטיכלמנסעפצקרשת'


def make_canon(n=420, seed=7):
    rng = random.Random(seed)
    words = set()
    canon = []
    while len(canon) < n:
        w = ''.join(rng.choice(LETTERS) for _ in range(rng.randint(3, 6)))
        if w in words:
            continue
        words.add(w)
        canon.append(SimpleNamespace(norm=w, phon=va.phonetic(w), text=w))
    return canon


def run_of(canon, start, k, t0=0.0, english=False):
    """A run of canon words [start, start+k) as the engine would hear them."""
    out = []
    t = t0
    for c in canon[start:start + k]:
        out.append({'text': c.norm, 'start': t, 'end': t + 0.3, 'norm': c.norm, 'phon': c.phon, 'english': english})
        t += 0.4
    return out


@unittest.skipUnless(HAVE_DEPS, 'rapidfuzz is not installed')
class PlaceableRuns(unittest.TestCase):
    def setUp(self):
        self.canon = make_canon()

    def test_constants(self):
        self.assertEqual(va.PLACEABLE_RUN_MIN_WORDS, 2)
        self.assertEqual(va.ENGLISH_CONTEXT_MIN_RUN_WORDS, 4)
        self.assertEqual(va.MAX_SINGLE_JUMP_WORDS, 40)

    def test_a_lone_word_is_never_placeable(self):
        self.assertFalse(va.is_placeable_run(run_of(self.canon, 10, 1)))
        self.assertTrue(va.is_placeable_run(run_of(self.canon, 10, 2)))

    def test_inside_english_a_run_needs_four_words(self):
        for k, expected in [(2, False), (3, False), (4, True), (7, True)]:
            self.assertEqual(va.is_placeable_run(run_of(self.canon, 10, k, english=True)), expected, k)

    def test_runs_know_whether_they_were_said_inside_english(self):
        c = self.canon
        def w(text, t):
            return {'text': text, 'start': t, 'end': t + 0.3}
        words = [w('so', 0), w('the', 0.4), w('gemara', 0.8), w('says', 1.2), w(c[5].norm, 1.6), w(c[6].norm, 2.0),
                 w('and', 2.4), w('then', 2.8),
                 # a pause, then a reading: Hebrew only
                 w(c[30].norm, 6.0), w(c[31].norm, 6.4), w(c[32].norm, 6.8)]
        runs = va.hebrew_script_runs(words)
        self.assertEqual([len(r) for r in runs], [2, 3])
        self.assertTrue(va.run_in_english(runs[0]))
        self.assertFalse(va.run_in_english(runs[1]))
        self.assertFalse(va.is_placeable_run(runs[0]))
        self.assertTrue(va.is_placeable_run(runs[1]))

    def test_match_runs_places_a_reading_but_not_a_term_inside_english(self):
        c = self.canon
        runs = [run_of(c, 100, 6), run_of(c, 106, 6), run_of(c, 112, 6)]
        term = run_of(c, 300, 2, english=True)            # matches words 300-301 exactly; must be ignored
        lone = run_of(c, 305, 1)
        matches, *_ = va.match_runs(c, [runs[0], runs[1], term, lone, runs[2]])
        self.assertIsNotNone(matches[1])
        self.assertIsNone(matches[2])
        self.assertIsNone(matches[3])
        self.assertEqual(matches[4]['s'], 112, 'and reading carries on as if the terms had not been said')

    def test_the_same_two_words_in_a_hebrew_utterance_are_placed(self):
        c = self.canon
        runs = [run_of(c, 100, 6), run_of(c, 106, 6), run_of(c, 112, 2)]
        matches, *_ = va.match_runs(c, runs)
        self.assertIsNotNone(matches[2])

    def test_a_far_move_is_held_until_a_different_phrase_carries_on_from_it(self):
        c = self.canon
        base = [run_of(c, 100, 5), run_of(c, 106, 5)]     # locks at 106
        far = run_of(c, 106 + 50, 6)                     # 50 words on: inside the search window, past the limit
        on = run_of(c, 106 + 56, 6)                      # carries on from it
        matches, *_ = va.match_runs(c, base + [far, on])
        self.assertEqual(matches[2]['s'], 156)
        self.assertAlmostEqual(matches[3]['s'], 162, delta=1)  # fuzzy matching may start a word either side

    def test_a_far_move_alone_does_not_move_the_position(self):
        c = self.canon
        base = [run_of(c, 100, 5), run_of(c, 106, 5)]
        far = run_of(c, 156, 6)
        near = run_of(c, 112, 6)
        matches, *_ = va.match_runs(c, base + [far, near])
        self.assertIsNone(matches[2], 'held, and dropped when reading goes on near the old place')
        self.assertEqual(matches[3]['s'], 112)

    def test_the_same_phrase_said_twice_does_not_confirm_a_far_move(self):
        c = self.canon
        base = [run_of(c, 100, 5), run_of(c, 106, 5)]
        far = run_of(c, 156, 6)
        matches, *_ = va.match_runs(c, base + [far, run_of(c, 156, 6)])
        self.assertIsNone(matches[2])
        self.assertIsNone(matches[3])

    def test_a_lone_word_between_the_two_phrases_does_not_break_a_held_move(self):
        c = self.canon
        base = [run_of(c, 100, 5), run_of(c, 106, 5)]
        matches, *_ = va.match_runs(c, base + [run_of(c, 156, 6), run_of(c, 7, 1), run_of(c, 162, 6)])
        self.assertIsNotNone(matches[2])
        self.assertIsNotNone(matches[4])

    def test_two_agreeing_global_matches_must_be_different_phrases(self):
        c = self.canon
        same = run_of(c, 250, 5)
        matches, *_ = va.match_runs(c, [same, run_of(c, 250, 5)])
        self.assertEqual(matches, [None, None])
        matches, *_ = va.match_runs(c, [run_of(c, 250, 5), run_of(c, 256, 5)])
        self.assertEqual((matches[0]['s'], matches[1]['s']), (250, 256))

    def test_terms_inside_english_are_excluded_not_listed_as_needing_manual_review(self):
        c = self.canon
        runs = [run_of(c, 100, 5), run_of(c, 106, 5), run_of(c, 300, 2, english=True)]
        matches, *_ = va.match_runs(c, runs)
        stats = va._build_match_stats(runs, matches)
        self.assertEqual(stats['unmatchedWords'], 0)
        self.assertEqual(stats['excludedWords'], 2)
        self.assertEqual(stats['excluded'][0]['reason'], 'term inside English')


if __name__ == '__main__':
    unittest.main()
