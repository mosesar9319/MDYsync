#!/usr/bin/env python3
"""Unit tests for saved_transcripts.py. `python3 test_saved_transcripts.py`."""
import gzip
import json
import os
import tempfile
import unittest

import saved_transcripts as ST

BUNDLE = {
    'schema': 'dafsync-transcripts-v1', 'seconds': 3487.25, 'engine': 'elevenlabs', 'model': 'scribe_v2',
    'witnesses': [{'name': 'hints', 'words': [['הכל', 718.6, 718.9], ['מעריכין', 719.0, 719.6]]},
                  {'name': 'relisten', 'words': [['ונערכין', 731.2, 731.8]]}],
}
JOB = dict(job_id='edb649a0', video_id='L0213511665', video_url='https://example.org/Arachin%202_213511665.mp3',
           maggid='bornstein', variant='regular', language='en', engine_version='7c01063')


class Stored(unittest.TestCase):
    def test_a_jobs_transcripts_are_kept_under_the_recordings_id_with_what_it_was_asked(self):
        with tempfile.TemporaryDirectory() as out:
            written = ST.store(dict(BUNDLE), out, ['Arakhin 2a', 'Arakhin 2b'], **JOB)
            self.assertEqual(written, 'transcripts/L0213511665.json.gz')
            with gzip.open(os.path.join(out, written), 'rt', encoding='utf-8') as f:
                saved = json.load(f)
            self.assertEqual(saved['witnesses'], BUNDLE['witnesses'])
            self.assertEqual(saved['job']['refs'], ['Arakhin 2a', 'Arakhin 2b'])   # as asked, without the neighbours
            self.assertEqual(ST.meta(os.path.join(out, written)), {
                'jobId': 'edb649a0', 'refs': ['Arakhin 2a', 'Arakhin 2b'], 'videoId': 'L0213511665',
                'videoUrl': JOB['video_url'], 'maggid': 'bornstein', 'variant': 'regular', 'language': 'en',
                'engineVersion': '7c01063', 'seconds': 3487.25,
                'witnesses': [{'name': 'hints', 'words': 2}, {'name': 'relisten', 'words': 1}],
            })

    def test_the_same_transcripts_make_the_same_file(self):
        with tempfile.TemporaryDirectory() as out:
            path = os.path.join(out, ST.store(dict(BUNDLE), out, ['Arakhin 2a'], **JOB))
            first = open(path, 'rb').read()
            ST.store(dict(BUNDLE), out, ['Arakhin 2a'], **JOB)
            self.assertEqual(open(path, 'rb').read(), first)

    def test_a_youtube_shiur_is_kept_under_its_youtube_id(self):
        with tempfile.TemporaryDirectory() as out:
            written = ST.store(dict(BUNDLE), out, ['Chullin 89a'], job_id='j2',
                               video_url='https://www.youtube.com/watch?v=0n7fE-jS0NE')
            self.assertEqual(written, 'transcripts/0n7fE-jS0NE.json.gz')
            self.assertEqual(ST.meta(os.path.join(out, written))['videoId'], '0n7fE-jS0NE')

    def test_an_empty_or_foreign_file_is_refused(self):
        with tempfile.TemporaryDirectory() as out:
            with self.assertRaises(ValueError):
                ST.store({'words': []}, out, ['Arakhin 2a'], **JOB)
            with self.assertRaises(ValueError):
                ST.store({**BUNDLE, 'witnesses': []}, out, ['Arakhin 2a'], **JOB)
            self.assertFalse(os.path.exists(os.path.join(out, 'transcripts')))


if __name__ == '__main__':
    unittest.main()
