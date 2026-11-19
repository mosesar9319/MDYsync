#!/usr/bin/env python3
"""Unit tests for straighten_alignment.py and the reading-order rule of
build_outputs. `python3 test_straighten_alignment.py`."""
import json
import os
import tempfile
import unittest

import straighten_alignment as SA
from caption_ocr_align import CanonWord, WordEvent, _keep_reading_order, build_outputs, normalize_word

LINE_1 = 'הלוקח עובר חמורו של נכרי והמוכר לו'
LINE_2 = 'אף על פי שאינו רשאי המשתתף לו'


def daf(refs, cache_dir=None):
    canon, segments = [], []
    for n, text in enumerate((LINE_1, LINE_2)):
        ref = f'Bekhorot 2a:{n + 1}'
        segments.append({'ref': ref, 'he': text, 'en': ''})
        canon += [CanonWord(ref, n, j, w, normalize_word(w)) for j, w in enumerate(text.split())]
    return canon, segments


def published(events, **extra):
    """An alignment as the voice job published it before the path was straight."""
    canon, segments = daf(None)
    alignment, _ = build_outputs(canon, segments, events, 600.0, 'job-audio.mp3', ['Bekhorot 2a'],
                                 generator='voice_align.py', title_prefix='Voice recognition alignment')
    alignment.update({'coveredRefs': ['Bekhorot 2a'], 'primaryRefs': ['Bekhorot 2a'], 'videoId': 'L0000000002',
                      'matchStats': {'aligner': 'path', 'totalWords': 14, 'matchedWords': 14, 'bySource': {}}})
    alignment.update(extra)
    return alignment


# He reads line 1, says its opening words again while explaining, reads line 2,
# then quotes line 1 once more.
REPEATS = [WordEvent(100.0, 0, 4, 90.0, 'reads line 1', 'path-latin'),
           WordEvent(104.0, 5, 6, 90.0, '', 'path-bridge'),
           WordEvent(130.0, 0, 1, 90.0, 'says it again', 'path-latin'),
           WordEvent(200.0, 7, 11, 90.0, 'reads line 2', 'path-latin'),
           WordEvent(260.0, 0, 2, 90.0, 'quotes line 1', 'path-latin'),
           WordEvent(300.0, 12, 13, 90.0, 'reads on', 'path-latin')]


class Straightened(unittest.TestCase):
    def test_each_word_keeps_one_moment_the_first(self):
        alignment = published(REPEATS)
        self.assertEqual(len(alignment['wordTimeline']), 6)
        change = SA.straighten(alignment, load=daf)
        self.assertEqual(change, {'placementsBefore': 6, 'placementsAfter': 4, 'wordsBefore': 14, 'wordsAfter': 14})
        timeline = alignment['wordTimeline']
        self.assertEqual([(e['ref'], e['w0'], e['w1'], e['start']) for e in timeline],
                         [('Bekhorot 2a:1', 0, 4, 100.0), ('Bekhorot 2a:1', 5, 6, 104.0),
                          ('Bekhorot 2a:2', 0, 4, 200.0), ('Bekhorot 2a:2', 5, 6, 300.0)])
        starts = [s['start'] for s in alignment['segments']]
        self.assertEqual(starts, sorted(starts))
        self.assertEqual(alignment['segments'][0]['start'], 100.0)          # a tap on line 1: its first reading
        stats = alignment['matchStats']
        self.assertTrue(stats['straightPath'])
        self.assertEqual((stats['matchedWords'], stats['totalWords'], stats['dafWordsHeard'], stats['dafWordsBridged']),
                         (14, 14, 12, 2))
        self.assertEqual(stats['straightened'], change)
        self.assertEqual(alignment['videoId'], 'L0000000002')                # the rest of the file is as it was

    def test_what_is_straight_already_or_not_a_voice_sync_is_left_alone(self):
        alignment = published(REPEATS)
        SA.straighten(alignment, load=daf)
        again = json.loads(json.dumps(alignment))
        self.assertIsNone(SA.straighten(again, load=daf))
        self.assertEqual(again, alignment)
        captions = published(REPEATS, generator='caption_ocr_align.py')
        self.assertIsNone(SA.straighten(captions, load=daf))
        self.assertEqual(len(captions['wordTimeline']), 6)

    def test_a_phrase_matcher_run_keeps_its_own_counts(self):
        alignment = published(REPEATS, matchStats={'totalWords': 900, 'matchedWords': 300})   # transcribed words
        SA.straighten(alignment, load=daf)
        self.assertEqual((alignment['matchStats']['totalWords'], alignment['matchStats']['matchedWords']), (900, 300))
        self.assertTrue(alignment['matchStats']['straightPath'])

    def test_the_results_branch_is_gone_over_and_the_runs_index_follows(self):
        real_load, SA.load_canonical = SA.load_canonical, daf
        defaults, SA.straighten.__defaults__ = SA.straighten.__defaults__, (None, daf)
        try:
            with tempfile.TemporaryDirectory() as results:
                paths = {'by-ref/Voice-Bornstein-Bekhorot-2a.json': published(REPEATS),
                         'by-video/Voice-Bornstein-L0000000002.json': published(REPEATS),
                         'by-video/Voice-Bornstein-L0000000009.json': published(REPEATS, videoId='L0000000009'),
                         'by-ref/Bekhorot-2a.json': published(REPEATS, generator='caption_ocr_align.py'),
                         'test-runs/L0000000002/regular-1.json': published(REPEATS),
                         'test-runs/L0000000002/live-1.json': published(REPEATS, generator='live-engine')}
                for name, alignment in paths.items():
                    path = os.path.join(results, name)
                    os.makedirs(os.path.dirname(path), exist_ok=True)
                    json.dump(alignment, open(path, 'w', encoding='utf-8'), ensure_ascii=False)
                index = {'videoId': 'L0000000002', 'runs': [
                    {'id': 'regular-1', 'file': 'regular-1.json', 'summary': {'placements': 6}},
                    {'id': 'live-1', 'file': 'live-1.json', 'summary': {'placements': 6}}]}
                json.dump(index, open(os.path.join(results, 'test-runs/L0000000002/index.json'), 'w'))
                lines = []
                changed = SA.straighten_results(results, video_id='L0000000002', log=lines.append)
                self.assertEqual(sorted(changed), ['by-ref/Voice-Bornstein-Bekhorot-2a.json',
                                                   'by-video/Voice-Bornstein-L0000000002.json',
                                                   'test-runs/L0000000002/index.json',
                                                   'test-runs/L0000000002/regular-1.json'])
                read = lambda name: json.load(open(os.path.join(results, name), encoding='utf-8'))  # noqa: E731
                self.assertEqual(len(read('by-video/Voice-Bornstein-L0000000002.json')['wordTimeline']), 4)
                self.assertEqual(len(read('by-video/Voice-Bornstein-L0000000009.json')['wordTimeline']), 6)   # another video
                self.assertEqual(len(read('by-ref/Bekhorot-2a.json')['wordTimeline']), 6)                     # a caption sync
                runs = {r['id']: r['summary'] for r in read('test-runs/L0000000002/index.json')['runs']}
                self.assertEqual(runs['regular-1']['placements'], 4)
                self.assertEqual(runs['live-1'], {'placements': 6})
                self.assertEqual(SA.straighten_results(results, log=lines.append),
                                 ['by-video/Voice-Bornstein-L0000000009.json'])                               # then the rest
                self.assertEqual(SA.straighten_results(results, log=lines.append), [])
        finally:
            SA.load_canonical = real_load
            SA.straighten.__defaults__ = defaults


class ReadingOrder(unittest.TestCase):
    def test_a_placeholder_row_is_never_later_than_the_phrase_it_stands_before(self):
        rows = [{'start': 384.76, 'end': 384.82, 'estimated': True}, {'start': 384.82, 'end': 384.88, 'estimated': True},
                {'start': 384.76, 'end': 385.76}, {'start': 437.86, 'end': 438.5}]
        _keep_reading_order(rows)
        self.assertEqual([r['start'] for r in rows], [384.76, 384.76, 384.76, 437.86])
        self.assertTrue(all(r['end'] >= r['start'] for r in rows))

    def test_two_real_rows_heard_as_one_stretch_do_not_tie(self):
        rows = [{'start': 2684.69, 'end': 2684.69}, {'start': 2684.69, 'end': 2687.83}, {'start': 2700.0, 'end': 2701.0}]
        _keep_reading_order(rows)
        self.assertEqual([r['start'] for r in rows], [2684.69, 2684.75, 2700.0])
        self.assertEqual(rows[0]['end'], 2684.69)


if __name__ == '__main__':
    unittest.main()
