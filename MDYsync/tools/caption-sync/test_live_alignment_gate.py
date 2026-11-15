#!/usr/bin/env python3
"""python3 test_live_alignment_gate.py"""

import unittest

from live_alignment_gate import captions_ok, duration_ok, outcome_document


# Highlight samples are what the OCR log prints ("Matched N highlight samples").
# We have that number for the failure and for one readable English run.
# The other four readable runs are checked on segment ratio; their real-word
# counts were 423–738, in the same band as the 4896-sample run and nowhere
# near the 65-sample failure.
MEASURED = [
    ('he40 4vSdKjq5P6s', 65, 11, 198, False),
    ('en40 6FOwpo2pRKE', 4896, 132, 289, True),
    ('he41 ratio', 461, 108, 217, True),
    ('he39 ratio', 502, 130, 303, True),
    ('en41 ratio', 684, 123, 230, True),
    ('en39 ratio', 423, 137, 310, True),
]


class GateTests(unittest.TestCase):
    def test_duration_allows_thirty_seconds_or_one_percent(self):
        self.assertTrue(duration_ok(4497.4, 4497))
        self.assertTrue(duration_ok(4499, 4497))
        # Seven seconds used to fail the 2s gate. It is inside 1% of ~75 minutes.
        self.assertTrue(duration_ok(4490, 4497))
        # Bekhorot 58a, run 43691341016: 4440.27s downloaded, 4450s on YouTube.
        self.assertTrue(duration_ok(4440.27, 4450))
        # A short file is held to 30 seconds, not to 1% (which would be tighter).
        self.assertTrue(duration_ok(970, 1000))
        self.assertFalse(duration_ok(960, 1000))
        # A long file is held to 1% once that is more than 30 seconds.
        self.assertTrue(duration_ok(5050, 5000))
        self.assertFalse(duration_ok(5060, 5000))
        self.assertFalse(duration_ok(None, 4497))
        self.assertFalse(duration_ok(100, 0))

    def test_measured_live_recordings(self):
        for name, samples, real, total, expect in MEASURED:
            self.assertEqual(captions_ok(samples, real, total), expect, name)

    def test_mostly_estimated_is_rejected(self):
        self.assertFalse(captions_ok(65, 11, 198))
        self.assertFalse(captions_ok(500, 10, 198))
        self.assertFalse(captions_ok(199, 100, 200))

    def test_outcome_names(self):
        doc = outcome_document('rejected-captions', videoId='4vSdKjq5P6s', highlightSamples=65)
        self.assertEqual(doc['outcome'], 'rejected-captions')
        self.assertEqual(doc['videoId'], '4vSdKjq5P6s')
        self.assertIn('T', doc['at'])


if __name__ == '__main__':
    unittest.main()
