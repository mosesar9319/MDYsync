#!/usr/bin/env python3
"""Unit tests for test_runs.py (numbered test runs of the voice engines) and the
maggid key prefix in publish_alignment.py. Stdlib only: `python3 test_test_runs.py`."""
import datetime
import json
import os
import tempfile
import unittest

import publish_alignment
import test_runs

VIDEO = 'Zsy7oDUP6Pw'
NOW = datetime.datetime(2026, 10, 10, 22, 30, tzinfo=datetime.timezone.utc)


def alignment(placements=3):
    return {
        'schema': 'dafsync-alignment-v2', 'dafRef': 'Bekhorot 2a', 'duration': 3000.5,
        'segments': [{'ref': 'Bekhorot 2a:1', 'start': 1, 'end': 2, 'estimated': i % 2 == 1} for i in range(4)],
        'wordTimeline': [{'start': i, 'end': i + 1, 'ref': 'Bekhorot 2a:1', 'w0': i * 5, 'w1': i * 5 + 3} for i in range(placements)],
    }


class TestRuns(unittest.TestCase):
    def test_numbers_count_per_engine_and_are_never_reused(self):
        with tempfile.TemporaryDirectory() as d:
            a = test_runs.publish_test_run(alignment(), d, VIDEO, 'regular', notes='baseline', now=NOW)
            b = test_runs.publish_test_run(alignment(), d, VIDEO, 'live', now=NOW)
            c = test_runs.publish_test_run(alignment(), d, VIDEO, 'regular', notes='pending fix', now=NOW)
            self.assertEqual([a['id'], b['id'], c['id']], ['regular-1', 'live-1', 'regular-2'])
            index = test_runs.load_index(d, VIDEO)
            self.assertEqual([r['id'] for r in index['runs']], ['regular-1', 'live-1', 'regular-2'])
            for entry in index['runs']:
                self.assertTrue(os.path.exists(os.path.join(d, 'test-runs', VIDEO, entry['file'])))

    def test_names_say_engine_number_date_and_what_changed(self):
        with tempfile.TemporaryDirectory() as d:
            entry = test_runs.publish_test_run(alignment(), d, VIDEO, 'live', notes='pending survives misses', now=NOW)
            self.assertEqual(entry['name'], 'Live #1 · 10 Oct 2026 · pending survives misses')
            plain = test_runs.publish_test_run(alignment(), d, VIDEO, 'regular', now=NOW)
            self.assertEqual(plain['name'], 'Regular #1 · 10 Oct 2026')

    def test_the_run_file_is_the_alignment_stamped_with_which_run_it_is(self):
        with tempfile.TemporaryDirectory() as d:
            test_runs.publish_test_run(alignment(), d, VIDEO, 'regular', notes='x', engine_version='abc1234', now=NOW)
            with open(os.path.join(d, 'test-runs', VIDEO, 'regular-1.json'), encoding='utf-8') as f:
                run = json.load(f)
            self.assertEqual(run['schema'], 'dafsync-alignment-v2')
            self.assertEqual(run['testRun']['id'], 'regular-1')
            self.assertEqual(run['testRun']['engineVersion'], 'abc1234')
            self.assertEqual(len(run['segments']), 4)

    def test_the_summary_makes_two_runs_comparable(self):
        s = test_runs.summarize(alignment(placements=3))
        self.assertEqual(s['placements'], 3)
        self.assertEqual(s['placedWords'], 12)
        self.assertEqual(s['segments'], 4)
        self.assertEqual(s['estimatedSegments'], 2)
        self.assertEqual(s['durationSeconds'], 3000.5)

    def test_bad_input_is_refused(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(ValueError):
                test_runs.publish_test_run(alignment(), d, VIDEO, 'whisper')
            with self.assertRaises(ValueError):
                test_runs.publish_test_run(alignment(), d, '../etc', 'live')


class MaggidKeyPrefix(unittest.TestCase):
    def test_prefix_order_is_voice_then_maggid_then_language_then_variant(self):
        self.assertEqual(publish_alignment.key_prefix('chazarah', 'he', True, 'bernstein'), 'Voice-Bernstein-Hebrew-Chazarah-Daf-')
        self.assertEqual(publish_alignment.key_prefix(None, None, True, 'bernstein'), 'Voice-Bernstein-')
        self.assertEqual(publish_alignment.key_prefix(None, None, False, 'bernstein'), 'Bernstein-')

    def test_the_default_maggid_is_unchanged(self):
        self.assertEqual(publish_alignment.key_prefix('chazarah', 'he', True), 'Voice-Hebrew-Chazarah-Daf-')
        self.assertEqual(publish_alignment.key_prefix(), '')
        self.assertEqual(publish_alignment.key_prefix(None, None, True, 'stefansky'), 'Voice-')


if __name__ == '__main__':
    unittest.main()
