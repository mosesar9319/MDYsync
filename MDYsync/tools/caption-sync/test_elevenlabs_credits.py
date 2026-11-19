#!/usr/bin/env python3
"""Unit tests for the voice engine's ElevenLabs bookkeeping in voice_align.py: which
Scribe model a job uses, and the credits record each job leaves.
`python3 test_elevenlabs_credits.py`."""
import io
import json
import sys
import types
import unittest
from unittest import mock

# voice_align.py imports the local speech model at the top; these tests never use it.
sys.modules.setdefault('faster_whisper', types.SimpleNamespace(WhisperModel=object))

import voice_align as VA  # noqa: E402


def subscription(used, limit, reset=1766000000):
    body = json.dumps({'character_count': used, 'character_limit': limit,
                       'next_character_count_reset_unix': reset, 'tier': 'creator'}).encode()
    response = io.BytesIO(body)
    response.__enter__ = lambda self=response: self
    response.__exit__ = lambda *a: False
    return response


class ModelChoice(unittest.TestCase):
    def test_default_is_scribe_v2(self):
        self.assertEqual(VA.elevenlabs_model_from_env(''), 'scribe_v2')

    def test_scribe_v3_can_be_asked_for(self):
        self.assertEqual(VA.elevenlabs_model_from_env('scribe_v3'), 'scribe_v3')
        self.assertEqual(VA.elevenlabs_model_from_env(' scribe_v3 '), 'scribe_v3')

    def test_an_unknown_model_falls_back_to_the_default(self):
        with mock.patch('builtins.print'):
            self.assertEqual(VA.elevenlabs_model_from_env('scribe_v9'), 'scribe_v2')

    def test_read_from_the_environment(self):
        with mock.patch.dict('os.environ', {'VOICE_STT_MODEL': 'scribe_v3'}):
            self.assertEqual(VA.elevenlabs_model_from_env(), 'scribe_v3')


class Balance(unittest.TestCase):
    def test_reads_the_subscription(self):
        with mock.patch('urllib.request.urlopen', return_value=subscription(1200, 30000)) as urlopen:
            balance = VA.elevenlabs_balance('key')
        self.assertEqual(balance, {'used': 1200, 'limit': 30000, 'left': 28800,
                                   'resetsAt': 1766000000, 'tier': 'creator'})
        request = urlopen.call_args[0][0]
        self.assertEqual(request.full_url, VA.ELEVENLABS_SUBSCRIPTION_URL)
        self.assertEqual(request.get_header('Xi-api-key'), 'key')

    def test_no_key_no_call(self):
        with mock.patch.dict('os.environ', {}, clear=True), mock.patch('urllib.request.urlopen') as urlopen:
            self.assertIsNone(VA.elevenlabs_balance())
        urlopen.assert_not_called()

    def test_a_refused_key_never_fails_the_job(self):
        with mock.patch('urllib.request.urlopen', side_effect=OSError('401')), mock.patch('builtins.print'):
            self.assertIsNone(VA.elevenlabs_balance('key'))


class Record(unittest.TestCase):
    usage = {'requests': 3, 'audio_secs': 3814.2 * 2 + 646, 'keyterm_secs': 3814.2 + 646}

    def test_used_and_left(self):
        before = {'used': 1000, 'limit': 30000, 'left': 29000, 'resetsAt': None, 'tier': None}
        after = {'used': 2400, 'limit': 30000, 'left': 27600, 'resetsAt': None, 'tier': None}
        record = VA.credits_record(before, after, 'scribe_v3', self.usage)
        self.assertEqual(record['creditsUsed'], 1400)
        self.assertEqual(record['creditsLeft'], 27600)
        self.assertEqual(record['creditLimit'], 30000)
        self.assertEqual(record['model'], 'scribe_v3')
        self.assertEqual(record['audioMinutes'], 137.9)
        self.assertEqual(record['keytermMinutes'], 74.3)
        line = VA.describe_credits(record)
        self.assertIn('1,400 credits used', line)
        self.assertIn('27,600 of 30,000 left', line)

    def test_a_reset_or_plan_change_mid_job_leaves_used_unknown(self):
        before = {'used': 29000, 'limit': 30000, 'left': 1000, 'resetsAt': None, 'tier': None}
        after = {'used': 300, 'limit': 30000, 'left': 29700, 'resetsAt': None, 'tier': None}
        record = VA.credits_record(before, after, 'scribe_v2', self.usage)
        self.assertIsNone(record['creditsUsed'])
        self.assertEqual(record['creditsLeft'], 29700)
        self.assertIn('credits used unknown', VA.describe_credits(record))

    def test_no_balance_still_records_what_was_sent(self):
        record = VA.credits_record(None, None, 'scribe_v2', self.usage)
        self.assertIsNone(record['creditsLeft'])
        self.assertEqual(record['requests'], 3)
        self.assertIn('could not be read', VA.describe_credits(record))


class Usage(unittest.TestCase):
    def test_each_transcription_is_counted_at_its_uploaded_length(self):
        answer = io.BytesIO(json.dumps({'words': [], 'audio_duration_secs': 80, 'language_code': 'heb'}).encode())
        answer.__enter__ = lambda self=answer: self
        answer.__exit__ = lambda *a: False
        start = dict(VA.ELEVENLABS_USAGE)
        with mock.patch('urllib.request.urlopen', return_value=answer) as urlopen, \
                mock.patch('builtins.open', mock.mock_open(read_data=b'mp3')), mock.patch('builtins.print'):
            VA.transcribe_elevenlabs('clip.mp3', keyterms=['שור'], api_key='key')
        body = urlopen.call_args[0][0].data
        self.assertIn(f'\r\n\r\n{VA.ELEVENLABS_MODEL}\r\n'.encode(), body)
        self.assertEqual(VA.ELEVENLABS_USAGE['requests'], start['requests'] + 1)
        self.assertEqual(VA.ELEVENLABS_USAGE['audio_secs'], start['audio_secs'] + 80)
        self.assertEqual(VA.ELEVENLABS_USAGE['keyterm_secs'], start['keyterm_secs'] + 80)


class ByPass(unittest.TestCase):
    def setUp(self):
        VA.ELEVENLABS_CHECKPOINTS.clear()

    def tearDown(self):
        VA.ELEVENLABS_CHECKPOINTS.clear()
        VA.start_credit_pass('hints')

    def test_each_pass_costs_the_change_across_it(self):
        usage = {'byPass': {'hints': {'requests': 1, 'audio_secs': 3816},
                            'plain': {'requests': 1, 'audio_secs': 3816},
                            'relisten': {'requests': 43, 'audio_secs': 750}}}
        checkpoints = [('start', 1562), ('hints', 2260), ('plain', 2842), ('relisten', 3700)]
        passes = VA.credits_by_pass(usage, checkpoints)
        self.assertEqual([p['pass'] for p in passes], ['hints', 'plain', 'relisten'])
        self.assertEqual([p['creditsUsed'] for p in passes], [698, 582, 858])
        self.assertEqual(passes[0]['audioMinutes'], 63.6)
        self.assertEqual(passes[2]['requests'], 43)
        self.assertEqual(passes[2]['creditsPerAudioMinute'], 68.6)

    def test_no_baseline_no_readings(self):
        reader = mock.Mock()
        self.assertIsNone(VA.credit_checkpoint('hints', balance_reader=reader, settle=0))
        reader.assert_not_called()

    def test_a_reading_after_a_pass_is_kept(self):
        VA.ELEVENLABS_CHECKPOINTS.append(('start', 100))
        VA.credit_checkpoint('hints', balance_reader=lambda: {'used': 800}, settle=0)
        VA.credit_checkpoint('plain', balance_reader=lambda: None, settle=0)
        self.assertEqual(VA.ELEVENLABS_CHECKPOINTS, [('start', 100), ('hints', 800)])

    def test_requests_are_counted_under_the_current_pass(self):
        answer = io.BytesIO(json.dumps({'words': [], 'audio_duration_secs': 30}).encode())
        answer.__enter__ = lambda self=answer: self
        answer.__exit__ = lambda *a: False
        VA.start_credit_pass('relisten')
        before = dict(VA.ELEVENLABS_USAGE['byPass'].get('relisten', {'requests': 0, 'audio_secs': 0.0}))
        with mock.patch('urllib.request.urlopen', return_value=answer), \
                mock.patch('builtins.open', mock.mock_open(read_data=b'mp3')), mock.patch('builtins.print'):
            VA.transcribe_elevenlabs('clip.mp3', keyterms=['שור'], api_key='key')
        after = VA.ELEVENLABS_USAGE['byPass']['relisten']
        self.assertEqual(after['requests'], before['requests'] + 1)
        self.assertEqual(after['audio_secs'], before['audio_secs'] + 30)

    def test_the_log_shows_each_pass(self):
        record = VA.credits_record(
            {'used': 0, 'limit': 30247, 'left': 30247, 'resetsAt': None, 'tier': None},
            {'used': 1562, 'limit': 30247, 'left': 28685, 'resetsAt': None, 'tier': None},
            'scribe_v3', {'requests': 44, 'audio_secs': 4566, 'keyterm_secs': 4566,
                          'byPass': {'hints': {'requests': 1, 'audio_secs': 3816},
                                     'relisten': {'requests': 43, 'audio_secs': 750}}},
            [('start', 0), ('hints', 900), ('relisten', 1562)])
        text = VA.describe_credits(record)
        self.assertIn('hints: 900 credits for 63.6 min in 1 request(s), 14.2 per minute', text)
        self.assertIn('relisten: 662 credits for 12.5 min in 43 request(s), 53.0 per minute', text)


if __name__ == '__main__':
    unittest.main()
