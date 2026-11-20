#!/usr/bin/env python3
"""Unit tests for the stretches a transcriber skips (voice_align.skipped_stretches,
skipped_pieces, fill_skipped). `python3 test_fill_skipped.py`."""
import unittest
from unittest import mock

import voice_align as VA


def word(text, start, end=None):
    return {'text': text, 'start': start, 'end': start + 0.3 if end is None else end}


# R' Bornstein's Eruchin 4, as Scribe returned it: speech, then one word
# stretched over minutes, twice more, then speech again.
ERUCHIN_4 = ([word(f'w{n}', 1800 + n * 0.5) for n in range(100)]
             + [word('fellow.', 1852.0), word('Whatever', 1853.0, 2055.0), word("he's", 2065.0, 2153.0),
                word('worth,', 2153.0, 2208.5)]
             + [word(f'x{n}', 2208.6 + n * 0.5) for n in range(100)])


class Found(unittest.TestCase):
    def test_a_word_stretched_over_minutes_does_not_hide_the_stretch_it_covers(self):
        self.assertEqual(VA.skipped_stretches(ERUCHIN_4, 2260.0), [(0.0, 1800.0), (1856.0, 2208.6)])

    def test_a_plain_gap_between_two_words_is_a_stretch(self):
        words = [word('a', 1000.0), word('b', 1003.2, 1003.56), word('c', 1091.84), word('d', 1092.5)]
        self.assertEqual(VA.skipped_stretches(words), [(0.0, 1000.0), (1003.56, 1091.84)])

    def test_an_ordinary_pause_is_not(self):
        words = [word('a', 0.2), word('b', 12.0), word('c', 30.5), word('d', 31.0)]
        self.assertEqual(VA.skipped_stretches(words, 40.0), [])

    def test_the_end_of_the_recording_counts(self):
        self.assertEqual(VA.skipped_stretches([word('a', 0.2), word('b', 5.0)], 65.0), [(5.3, 65.0)])


class Pieces(unittest.TestCase):
    def test_a_long_stretch_is_cut_into_clips_that_share_a_moment(self):
        pieces = VA.skipped_pieces(1856.0, 2208.6, 3541.87)
        self.assertEqual(len(pieces), 3)
        for clip_start, clip_end, own_from, own_until in pieces:
            self.assertLessEqual(clip_end - clip_start, VA.SKIPPED_MAX_CLIP_SECONDS + VA.SKIPPED_OVERLAP_SECONDS)
            self.assertLessEqual(clip_start, own_from)
            self.assertGreaterEqual(clip_end, own_until)
        # Every moment of the stretch is owned by exactly one clip.
        self.assertEqual(pieces[0][2], 1855.0)
        self.assertEqual(pieces[-1][3], 2209.6)
        for before, after in zip(pieces, pieces[1:]):
            self.assertEqual(before[3], after[2])
            self.assertGreater(before[1], after[0])       # they overlap

    def test_a_short_stretch_is_one_clip_and_never_runs_past_the_recording(self):
        self.assertEqual(VA.skipped_pieces(50.0, 80.0, 80.4), [(49.0, 80.4, 49.0, 80.4)])


class Filled(unittest.TestCase):
    def fill(self, words, duration, heard, volume=-18.0):
        asked = []

        def transcribe_clip(path, terms):
            asked.append((path, terms))
            return heard(len(asked) - 1)

        with mock.patch.object(VA, 'cut_clip', side_effect=lambda audio, start, end, out: f'{start:.1f}-{end:.1f}'):
            got = VA.fill_skipped('shiur.mp3', words, duration, ['ערכך'], transcribe_clip=transcribe_clip,
                                  volume=lambda path, start, end: volume)
        return got, asked

    def test_what_is_heard_goes_where_it_was_said_and_the_stretched_word_shrinks(self):
        lead = [word('.', t) for t in (5.0, 23.0, 41.0, 59.0, 77.0, 90.0)]      # no stretch before it
        words = lead + [word('before', 100.0), word('Whatever', 101.0, 160.0), word('after', 160.2)]
        (filled_words, filled), asked = self.fill(
            words, 170.0, lambda n: [word('too-early', 0.5), word('דבר', 5.0), word('אחר', 5.6), word('too-late', 58.0)])
        # One clip, a second either side of the stretch, with the daf's words as hints.
        self.assertEqual(asked, [('103.0-161.2', ['ערכך'])])
        self.assertEqual([w['text'] for w in filled_words[6:]], ['before', 'Whatever', 'דבר', 'אחר', 'after'])
        self.assertEqual([round(w['start'], 1) for w in filled_words[6:]], [100.0, 101.0, 108.0, 108.6, 160.2])
        self.assertEqual(filled_words[7]['end'], 101.5)                # no longer a minute long
        self.assertEqual(filled, [{'start': 104.0, 'end': 160.2, 'words': 2}])

    def test_silence_is_left_alone_and_costs_nothing(self):
        words = [word('a', 10.0), word('b', 90.0)]
        (filled_words, filled), asked = self.fill(words, 100.0, lambda n: [word('x', 1.0)], volume=-70.0)
        self.assertEqual((filled_words, filled, asked), (words, [], []))

    def test_audio_that_cannot_be_measured_is_left_alone(self):
        words = [word('a', 10.0), word('b', 90.0)]
        (filled_words, filled), asked = self.fill(words, 100.0, lambda n: [word('x', 1.0)], volume=None)
        self.assertEqual((filled_words, filled, asked), (words, [], []))

    def test_a_transcript_without_skipped_stretches_is_returned_as_it_is(self):
        words = [word(f'w{n}', n * 2.0) for n in range(40)]
        (filled_words, filled), asked = self.fill(words, 80.0, lambda n: [])
        self.assertIs(filled_words, words)
        self.assertEqual((filled, asked), ([], []))

    def test_a_clip_that_fails_only_loses_that_clip(self):
        words = [word('a', 0.2), word('b', 400.0), word('c', 400.5)]

        def heard(n):
            if n == 1:
                raise RuntimeError('ElevenLabs returned 500')
            return [word(f'clip{n}', 60.0)]

        (filled_words, filled), asked = self.fill(words, 401.0, heard)
        self.assertEqual(len(asked), 3)
        self.assertEqual([w['text'] for w in filled_words], ['a', 'clip0', 'clip2', 'b', 'c'])
        self.assertEqual(filled[0]['words'], 2)

    def test_a_word_in_the_shared_moment_is_kept_once(self):
        # Two clips; the same word is heard at the end of the first and the start of the second.
        words = [word('a', 0.2), word('b', 290.0)]
        pieces = VA.skipped_pieces(0.5, 290.0, 290.4)
        self.assertEqual(len(pieces), 2)
        shared = pieces[0][3] + 0.4                                    # just inside the second clip's part

        def heard(n):
            clip_start = pieces[n][0]
            return [word('שנים', shared - clip_start)]

        (filled_words, filled), _ = self.fill(words, 290.4, heard)
        self.assertEqual([w['text'] for w in filled_words].count('שנים'), 1)

    def test_no_more_than_the_limit_is_transcribed_again_the_longest_first(self):
        words = [word('a', 0.2), word('b', 1000.0), word('c', 1400.0), word('d', 1450.0)]
        (filled_words, filled), asked = self.fill(words, 1451.0, lambda n: [word('x', 30.0)])
        # 1000 s, 400 s and 50 s were skipped. The longest is heard; the 400 s would pass the
        # 1200 s limit and is left; the 50 s still fits.
        self.assertEqual([(f['start'], f['end']) for f in filled], [(0.5, 1000.0), (1400.3, 1450.0)])


if __name__ == '__main__':
    unittest.main()
