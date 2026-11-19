#!/usr/bin/env python3
"""Unit tests for path_align.py (the voice engine's path alignment) and the parts of
voice_align.py that feed it. Needs what the voice job installs
(requirements-voice.txt); faster-whisper itself is not needed.
`python3 test_path_align.py`."""
import json
import os
import sys
import tempfile
import types
import unittest
from unittest import mock

# voice_align.py imports the local speech model at the top; these tests never use it.
sys.modules.setdefault('faster_whisper', types.SimpleNamespace(WhisperModel=object))

import path_align as PA  # noqa: E402
import spoken_forms as SF  # noqa: E402
import voice_align as VA  # noqa: E402
from caption_ocr_align import CanonWord, normalize_word  # noqa: E402

# The Mishnah that opens Bekhorot, as Sefaria gives it.
MISHNAH = ('הַלּוֹקֵחַ עוּבַּר חֲמוֹרוֹ שֶׁל נָכְרִי, וְהַמּוֹכֵר לוֹ, אַף עַל פִּי שֶׁאֵינוֹ רַשַּׁאי, '
           'הַמִּשְׁתַּתֵּף לוֹ, וְהַמְקַבֵּל הֵימֶנּוּ, וְהַנּוֹתֵן לוֹ בְּקַבָּלָה — פָּטוּר מִן הַבְּכוֹרָה, '
           'שֶׁנֶּאֱמַר: ״בְּיִשְׂרָאֵל״, אֲבָל לֹא בַּאֲחֵרִים.')
ENGLISH = frozenset('the of a an and or in is it to he she owns somebody if that this was with not but'.split())


def canon_from(text, ref='Bekhorot 2a:1'):
    words = []
    for j, w in enumerate(text.split()):
        n = normalize_word(w)
        if n:
            words.append(CanonWord(ref, 0, j, w, n))
    return words


def said(*phrases, start=100.0, gap=4.0):
    """A transcript: each phrase's words 0.4s apart, phrases `gap` seconds apart."""
    words, t = [], start
    for phrase in phrases:
        for w in phrase.split():
            words.append({'text': w, 'start': round(t, 2), 'end': round(t + 0.3, 2)})
            t += 0.4
        t += gap
    return words


def spans(events):
    return [(e.start_idx, e.end_idx) for e in events]


class Skeletons(unittest.TestCase):
    def test_the_daf_is_read_as_an_ashkenazi_reader_says_it(self):
        self.assertEqual(PA.ashkenazi_skeleton('וְהַמּוֹכֵר'), 'vhmxr')      # cholam is a vowel, kaf without a dagesh is ch
        self.assertEqual(PA.ashkenazi_skeleton('בְּקַבָּלָה'), 'bkbl')        # final heh is silent
        self.assertEqual(PA.ashkenazi_skeleton('שֶׁנֶּאֱמַר:'), 'Snmr')
        self.assertEqual(PA.ashkenazi_skeleton('הַבְּכוֹרָה,'), 'hbxr')
        self.assertEqual(PA.ashkenazi_skeleton('מַתְנִי׳'), 'msn')           # tav without a dagesh is s
        self.assertEqual(PA.ashkenazi_skeleton('תּוֹרָה'), 'tr')             # with one it is t
        self.assertEqual(PA.ashkenazi_skeleton('יִשְׂרָאֵל'), 'ysrl')         # sin, not shin

    def test_english_letter_spellings_come_to_the_same_skeleton(self):
        self.assertEqual(PA.latin_skeleton('Vehamoicher'), 'vhmxr')
        self.assertEqual(PA.latin_skeleton("b'kabalah,"), 'bkbl')
        self.assertEqual(PA.latin_skeleton('shenemar.'), 'Snmr')
        self.assertEqual(PA.fold(PA.latin_skeleton('habechira')), PA.fold(PA.ashkenazi_skeleton('הַבְּכוֹרָה')))


class Path(unittest.TestCase):
    def setUp(self):
        self.canon = canon_from(MISHNAH)

    def align(self, *transcripts, **kw):
        return PA.align_path(self.canon, list(transcripts), VA.phonetic, english=ENGLISH, **kw)

    def test_english_letter_reading_is_placed_in_order(self):
        # What the transcriber really wrote for this Mishnah (Lakewood Daf Yomi, Bechoros 2).
        events, stats = self.align(said(
            'Uber chamoraishel oved kochavim', 'If somebody purchases the uber of a chamor',
            'Vehamoicher lai', 'Af alpisha ini Rashi', 'Hamishtataf lei', "va'amkabli menu",
            'vehanoisen lebekabalah', 'patum min habechira shenemar', 'aval lo beacheirim'))
        placed = spans(events)
        self.assertIn((5, 6), placed)       # וְהַמּוֹכֵר לוֹ
        self.assertIn((7, 11), placed)      # אַף עַל פִּי שֶׁאֵינוֹ רַשַּׁאי
        self.assertIn((16, 18), placed)     # וְהַנּוֹתֵן לוֹ בְּקַבָּלָה
        self.assertIn((24, 26), placed)     # אֲבָל לֹא בַּאֲחֵרִים
        self.assertEqual(sorted(placed), placed, 'the path reads on through the daf')
        self.assertTrue(all(e.source.startswith('path-latin') for e in events))
        self.assertGreaterEqual(stats['dafWordsHeard'], 18)
        self.assertEqual(stats['aligner'], 'path')

    def test_plain_english_is_not_read_as_the_daf(self):
        # "owns an" has the consonants of וְהַנּוֹתֵן, and so has nothing to do with it.
        events, _ = self.align(said('somebody owns an animal', 'and he was with it'))
        self.assertEqual(events, [])

    def test_hebrew_letter_reading_is_placed_too(self):
        events, _ = self.align(said('והמוכר לו', 'the seller', 'אף על פי שאינו רשאי', 'פטור מן הבכורה'))
        self.assertEqual(spans(events), [(5, 6), (7, 11), (19, 21)])
        self.assertTrue(all(e.source == 'path-hebrew' for e in events))

    def test_a_short_fragment_goes_where_the_path_is(self):
        # "לו" follows three different words of this Mishnah. Read after "והמקבל הימנו
        # והנותן", it is the third one -- not the first that looks like it.
        events, _ = self.align(said('והמקבל הימנו', 'והנותן', 'לו בקבלה'))
        self.assertEqual(spans(events)[-1], (17, 18))

    def test_two_transcripts_are_two_witnesses_on_one_clock(self):
        hinted = said('והמוכר לו', 'xx xx', 'xx xx xx', start=100)
        plain = said('qq qq', 'Af alpisha ini Rashi', 'patum min habechira', start=100)
        events, stats = self.align(hinted, plain)
        self.assertEqual(spans(events), [(5, 6), (7, 11), (19, 21)])
        self.assertEqual(stats['witnesses'], 2)
        # The same words heard by both are placed once.
        both, _ = self.align(said('והמוכר לו'), said('Vehamoicher lai'))
        self.assertEqual(spans(both), [(5, 6)])

    def test_a_proposal_competes_like_anything_else(self):
        proposals = [(300.0, 301.0, 12, 15, 90.0, 'heard by the phrase matcher', 'llm-rescue')]
        events, stats = self.align(said('והמוכר לו', 'אף על פי שאינו רשאי'), proposals=proposals,
                                   source_labels={'llm-rescue': 'LLM rescue (Claude)'})
        self.assertEqual(spans(events), [(5, 6), (7, 11), (12, 15)])
        self.assertEqual(stats['bySource']['llm-rescue'], {'label': 'LLM rescue (Claude)', 'runs': 1, 'words': 4})

    def test_a_second_look_fills_a_gap_between_two_placed_phrases(self):
        # "אמשטיף" alone is too far from "המשתתף" to be placed anywhere on the daf; between
        # "אף על פי שאינו רשאי" and "והמקבל הימנו" there is nothing else it can be.
        transcript = said('אף על פי שאינו רשאי', 'אמשטיף', 'והמקבל הימנו')
        without, _ = self.align(transcript, gaps=False)
        self.assertEqual(spans(without), [(7, 11), (14, 15)])
        events, _ = self.align(transcript)
        self.assertEqual(spans(events), [(7, 11), (12, 12), (14, 15)])
        self.assertEqual(events[1].source, 'path-hebrew-gap')

    def test_nothing_heard_is_an_empty_result_not_an_error(self):
        events, stats = self.align(said('nothing of the kind', 'at all'))
        self.assertEqual((events, stats['dafWordsHeard']), ([], 0))
        self.assertEqual(PA.align_path(self.canon, [[]], VA.phonetic, english=ENGLISH)[0], [])


class Holes(unittest.TestCase):
    """What the path leaves between two placed phrases a moment apart."""

    def setUp(self):
        self.canon = canon_from(MISHNAH)

    def align(self, transcript, **kw):
        return PA.align_path(self.canon, [transcript], VA.phonetic, english=ENGLISH, **kw)

    def test_a_garbled_word_or_two_between_close_phrases_is_filled_in(self):
        # "המשתתף לו" (12-13) came out as nothing usable, between two phrases 3.4s apart.
        transcript = said('אף על פי שאינו רשאי', 'the', 'והמקבל הימנו', gap=0.5)
        without, _ = self.align(transcript, bridges=False)
        self.assertEqual(spans(without), [(7, 11), (14, 15)])
        events, stats = self.align(transcript)
        self.assertEqual(spans(events), [(7, 11), (12, 13), (14, 15)])
        self.assertEqual(events[1].source, 'path-bridge')
        self.assertEqual(events[1].ocr_text, '')
        # Counted as filled in, not as heard.
        self.assertEqual((stats['dafWordsHeard'], stats['dafWordsBridged'], stats['matchedWords']), (7, 2, 9))

    def test_a_few_words_in_the_time_it_takes_to_read_them_are_filled_in(self):
        # 7-11 (five words) missing, and under two seconds between the phrases either side.
        events, stats = self.align(said('והמוכר לו', 'the', 'המשתתף לו', gap=0.5))
        self.assertEqual(spans(events), [(5, 6), (7, 11), (12, 13)])
        self.assertEqual(events[1].source, 'path-bridge')
        self.assertEqual((stats['dafWordsHeard'], stats['dafWordsBridged']), (4, 5))

    def test_a_longer_hole_or_a_long_pause_is_left_alone(self):
        # The same five words, but the maggid stopped for eight seconds: he was explaining.
        paused = self.align(said('והמוכר לו', 'the', 'המשתתף לו', gap=4.0))[0]
        self.assertEqual(spans(paused), [(5, 6), (12, 13)])
        # Seven words (2-8) are more than is filled in on trust.
        long_hole = self.align(said('הלוקח עובר', 'the', 'פי שאינו רשאי', gap=0.5))[0]
        self.assertEqual(spans(long_hole), [(0, 1), (9, 11)])
        apart = self.align(said('אף על פי שאינו רשאי', 'the', 'והמקבל הימנו', gap=4.0))[0]   # 10s apart
        self.assertEqual(spans(apart), [(7, 11), (14, 15)])

    def test_a_short_word_is_looked_for_only_inside_a_small_gap(self):
        # "לו" alone fits four places in this Mishnah; between "המשתתף" and "והמקבל" it
        # can only be the one at 13.
        transcript = said('אף על פי שאינו רשאי', 'המשתתף', 'לו', 'והמקבל הימנו')
        without, _ = self.align(transcript, short_words=False, bridges=False)
        self.assertEqual(spans(without), [(7, 11), (12, 12), (14, 15)])
        events, _ = self.align(transcript, bridges=False)
        self.assertEqual(spans(events), [(7, 11), (12, 12), (13, 13), (14, 15)])
        self.assertEqual(events[2].source, 'path-hebrew-gap')
        # Nowhere else: on its own it is not placed at all.
        self.assertEqual(self.align(said('לו', 'the', 'לו'))[0], [])


PROSE = 'שלום לכולם היום אנחנו רוצים לדבר קצת על דברים חשובים מאוד בחיים של כל אדם ואדם בעולם הגדול הזה'


class LongHebrewRuns(unittest.TestCase):
    """A long unbroken stretch in Hebrew letters is mostly the transcriber's own
    prose, but the maggid's reading can be inside it (Eruchin 2)."""

    def setUp(self):
        self.canon = canon_from(MISHNAH)

    def align(self, text, **kw):
        return PA.align_path(self.canon, [said(text, gap=0.5)], VA.phonetic, english=ENGLISH, **kw)[0]

    def test_a_phrase_read_inside_a_long_run_is_placed(self):
        text = f'{PROSE} אף על פי שאינו רשאי {PROSE}'
        self.assertGreater(len(text.split()), PA.MAX_HEBREW_RUN_WORDS)
        self.assertEqual(spans(self.align(text)), [(7, 11)])

    def test_one_word_of_prose_that_stands_on_the_daf_is_not(self):
        self.assertEqual(spans(self.align(f'{PROSE} המשתתף {PROSE}')), [])
        # On its own, in a short run, the same word is believed.
        self.assertEqual(spans(self.align('המשתתף')), [(12, 12)])


class Counting(unittest.TestCase):
    """A shiur is measured against its own daf and the lines it read of the amud
    before and after it -- not a whole neighbouring amud it never opened."""

    def setUp(self):
        self.canon = (canon_from(MISHNAH, 'Bekhorot 2a:1')
                      + canon_from('אמר רבי יוחנן הלכה כרבי יהודה', 'Bekhorot 2b:1')
                      + canon_from('ורבי שמעון בן לקיש אמר אין הלכה', 'Bekhorot 2b:2'))
        self.own = VA.primary_word_indices(self.canon, ['Bekhorot 2a'])

    def test_the_shiurs_own_daf_is_told_apart_from_its_neighbours(self):
        self.assertEqual(self.own, list(range(len(canon_from(MISHNAH)))))
        self.assertIsNone(VA.primary_word_indices(self.canon, ['Bekhorot 2a', 'Bekhorot 2b']))   # all of it is its own
        self.assertIsNone(VA.primary_word_indices(self.canon, None))

    def test_a_neighbouring_line_counts_only_once_it_is_read(self):
        n = len(self.own)
        self.assertEqual(len(PA.counted_words(self.canon, self.own, {0, 1})), n)
        self.assertEqual(len(PA.counted_words(self.canon, self.own, {0, n + 1})), n + 6)        # 2b:1 was read
        self.assertEqual(len(PA.counted_words(self.canon, None, {0})), len(self.canon))

    def test_the_stats_are_out_of_the_words_that_count(self):
        transcript = said('אף על פי שאינו רשאי', 'the', 'והמקבל הימנו', gap=0.5)
        _, everything = PA.align_path(self.canon, [transcript], VA.phonetic, english=ENGLISH)
        _, own = PA.align_path(self.canon, [transcript], VA.phonetic, english=ENGLISH, primary=self.own)
        self.assertEqual(everything['totalWords'], len(self.canon))
        self.assertEqual((own['totalWords'], own['dafWords'], own['ownDafWords']), (len(self.own),) * 3)
        self.assertEqual(own['wordsRead'], len(self.canon))
        self.assertEqual(own['matchedWords'], everything['matchedWords'])
        self.assertEqual(own['unmatchedWords'], len(self.own) - own['matchedWords'])


class SavedTranscripts(unittest.TestCase):
    """What a job heard is kept, so the shiur is never paid for twice."""

    def test_a_jobs_transcripts_are_saved_and_read_back(self):
        hints = said('אף על פי שאינו רשאי', 'the', 'והמקבל הימנו')
        again = said('המשתתף לו', start=104.0)
        bundle = VA.transcripts_bundle([('hints', hints), ('relisten', again), ('plain', [])], 3487.25,
                                       engine='elevenlabs', model='scribe_v2')
        self.assertEqual([w['name'] for w in bundle['witnesses']], ['hints', 'relisten'])
        import gzip
        with tempfile.TemporaryDirectory() as folder:
            for name, opener in (('t.json', open), ('t.json.gz', gzip.open)):
                path = os.path.join(folder, name)
                with opener(path, 'wt', encoding='utf-8') as f:
                    json.dump(bundle, f, ensure_ascii=False)
                witnesses, seconds, heard_by = VA.load_transcripts_bundle(path)
                self.assertEqual(witnesses, [('hints', hints), ('relisten', again)])
                self.assertEqual(seconds, 3487.25)
                self.assertEqual(heard_by, {'engine': 'elevenlabs', 'model': 'scribe_v2'})
            other = os.path.join(folder, 'other.json')
            json.dump({'words': []}, open(other, 'w'))
            with self.assertRaises(ValueError):
                VA.load_transcripts_bundle(other)


class Chunks(unittest.TestCase):
    def test_a_phrase_said_again_never_makes_an_empty_row(self):
        from caption_ocr_align import _group_real_entries, _segment_phrase_chunks
        # Words 4-5, then a step back to 2-3 a second later (Eruchin 2 published "w 4-2").
        entries = [{'start': 10.0, 'end': 10.5, 'w0': 4, 'w1': 5}, {'start': 11.0, 'end': 11.5, 'w0': 2, 'w1': 3},
                   {'start': 30.0, 'end': 30.5, 'w0': 3, 'w1': 4}]
        groups = _group_real_entries(entries)
        self.assertTrue(all(g['w0'] <= g['w1'] for g in groups))
        chunks = _segment_phrase_chunks(groups, 8, 10.0)
        self.assertTrue(all(c['w0'] <= c['w1'] for c in chunks))
        self.assertEqual(chunks[-1]['w1'], 7)


class ClaudeSpan(unittest.TestCase):
    """A Claude placement may not cover more daf words than were heard, plus two."""

    def reply(self, start, end):
        body = json.dumps({'is_reading_daf_text': True, 'start_index': start, 'end_index': end, 'confidence': 0.9})
        message = types.SimpleNamespace(content=[types.SimpleNamespace(type='text', text=body)])
        return types.SimpleNamespace(messages=types.SimpleNamespace(create=lambda **kw: message))

    def test_an_answer_longer_than_what_was_heard_is_refused(self):
        canon = canon_from(MISHNAH)
        run = [{'text': 'אלולין', 'start': 1.0, 'end': 1.4}, {'text': 'מתעשרין', 'start': 1.5, 'end': 1.9}]
        self.assertEqual(VA.resolve_ambiguous_run(canon, 3, run, client=self.reply(0, 3))[:2], (3, 6))
        self.assertIsNone(VA.resolve_ambiguous_run(canon, 3, run, client=self.reply(0, 10)))
        self.assertTrue(VA.llm_span_plausible(0, 5, [{}] * 4))
        self.assertFalse(VA.llm_span_plausible(0, 6, [{}] * 4))


class ClaudeByDefault(unittest.TestCase):
    def test_off_for_the_path_aligner_and_up_to_the_credentials_for_the_phrase_matcher(self):
        with mock.patch.object(VA, '_anthropic_credentials_available', return_value=True):
            self.assertFalse(VA.llm_rescue_by_default('path'))
            self.assertTrue(VA.llm_rescue_by_default('phrase'))
        with mock.patch.object(VA, '_anthropic_credentials_available', return_value=False):
            self.assertFalse(VA.llm_rescue_by_default('phrase'))


class Witnesses(unittest.TestCase):
    def test_which_extra_transcripts_are_asked_for(self):
        self.assertEqual(VA.parse_witnesses('hints,plain'), ['plain'])
        self.assertEqual(VA.parse_witnesses(' Slow , plain,hints'), ['plain', 'slow'])
        self.assertEqual(VA.parse_witnesses('hints'), [])
        self.assertEqual(VA.parse_witnesses(''), [])
        with self.assertRaises(ValueError):
            VA.parse_witnesses('hints,fast')

    def test_a_saved_transcript_loads_in_either_shape(self):
        with tempfile.TemporaryDirectory() as d:
            a = os.path.join(d, 'a.json')
            with open(a, 'w') as f:
                json.dump({'status': 'done', 'seconds': 12.5, 'words': [['Rabosai', 1.0, 1.4]]}, f)
            b = os.path.join(d, 'b.json')
            with open(b, 'w', encoding='utf-8') as f:
                json.dump([{'text': 'אמר', 'start': 2.0, 'end': 2.2}], f, ensure_ascii=False)
            self.assertEqual(VA.load_transcript_file(a), ([{'text': 'Rabosai', 'start': 1.0, 'end': 1.4}], 12.5))
            self.assertEqual(VA.load_transcript_file(b), ([{'text': 'אמר', 'start': 2.0, 'end': 2.2}], 2.2))

    def test_a_slowed_transcript_comes_back_on_the_real_clock(self):
        response = {'language_code': 'eng', 'audio_duration_secs': 80.0,
                    'words': [{'type': 'word', 'text': 'omar', 'start': 40.0, 'end': 44.0}]}

        class Reply:
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self): return json.dumps(response).encode()

        with tempfile.TemporaryDirectory() as d:
            audio = os.path.join(d, 'shiur.mp3')
            slowed = os.path.join(d, 'shiur.tempo0.75.mp3')
            with open(audio, 'wb') as f:
                f.write(b'real')

            def fake_slowed_copy(path, tempo):
                with open(slowed, 'wb') as f:
                    f.write(b'slowed')
                return slowed

            with mock.patch.object(VA, 'slowed_copy', side_effect=fake_slowed_copy) as slow, \
                    mock.patch('urllib.request.urlopen', return_value=Reply()) as sent:
                words, duration = VA.transcribe_elevenlabs(audio, keyterms=['אמר'], api_key='k', tempo=0.75)
            slow.assert_called_once_with(audio, 0.75)
            self.assertIn(b'slowed', sent.call_args[0][0].data)       # the slowed copy is what was sent
            self.assertFalse(os.path.exists(slowed))                  # and is not left behind
            self.assertEqual((words[0]['start'], words[0]['end'], duration), (30.0, 33.0, 60.0))


COUNTING = ('וּמוֹנִין: אֶחָד, שְׁנַיִם, שְׁלֹשָׁה, אַרְבָּעָה, חֲמִשָּׁה, שִׁשָּׁה, שִׁבְעָה, שְׁמוֹנָה, תִּשְׁעָה, '
            'וְהַיּוֹצֵא עֲשִׂירִי סוֹקֵר בְּסִיקְרָא')


class SpokenForms(unittest.TestCase):
    """Counts, dates and twins said another way than the daf has them."""

    def rewrite(self, *phrases):
        return [w['text'] for w in SF.spoken_witness(said(*phrases))]

    def test_a_count_is_written_the_dafs_way(self):
        self.assertEqual(self.rewrite('And then you count Alef, Beis, Gimel, Daled.'), ['אחד', 'שנים', 'שלשה', 'ארבעה'])
        self.assertEqual(self.rewrite('It has to be one, two, three.'), ['אחד', 'שנים', 'שלשה'])
        # Ordinary English is left alone: one number, two in a row, or out of order.
        self.assertEqual(self.rewrite('one of the animals'), [])
        self.assertEqual(self.rewrite('one, two'), [])
        self.assertEqual(self.rewrite('five, two, one'), [])

    def test_a_date_is_written_the_dafs_way(self):
        self.assertEqual(self.rewrite("It's the twenty-ninth day of Elul."), ['בעשרים', 'ותשעה', 'באלול'])
        self.assertEqual(self.rewrite('the 29th of Av'), ['בעשרים', 'ותשעה', 'באב'])
        self.assertEqual(self.rewrite('fifteenth of Nissan'), ['בחמשה', 'עשר', 'בניסן'])
        self.assertEqual(self.rewrite('Rosh Chodesh Tishrei.'), ['באחד', 'בתשרי'])
        self.assertEqual(self.rewrite('the twenty-ninth day'), [])          # no month: not a date
        self.assertEqual(SF.date_number(30), ['שלשים'])

    def test_a_twin_is_written_the_dafs_way(self):
        self.assertEqual(self.rewrite('Ben Azzai לשיטותיה.'), ['לטעמיה'])

    def test_a_rewritten_count_fills_the_hole_between_two_placed_phrases(self):
        canon = canon_from(COUNTING)
        english = ENGLISH | {'then', 'you', 'count'}
        transcript = said('ומונין', 'And then you count Alef, Beis, Gimel, Daled, He, Vav, Zayin, Chet, Tes.',
                          'ויוצא העשירי סוקר בסיקרא', gap=0.5)
        without, _ = PA.align_path(canon, [transcript], VA.phonetic, english=english, spoken=False, bridges=False)
        self.assertEqual({i for a, b in spans(without) for i in range(a, b + 1)}, {0, 10, 11, 12, 13})
        events, stats = PA.align_path(canon, [transcript], VA.phonetic, english=english, bridges=False)
        filled = {i for e in events if e.source == 'path-spoken' for i in range(e.start_idx, e.end_idx + 1)}
        self.assertEqual(filled, set(range(1, 10)))
        self.assertEqual(stats['dafWordsHeard'], 14)

    def test_a_rewritten_date_alone_does_not_move_the_path(self):
        # Said while explaining, with nothing placed around it: not placed.
        canon = canon_from('רַבִּי מֵאִיר אוֹמֵר: בְּאֶחָד בֶּאֱלוּל רֹאשׁ הַשָּׁנָה לְמַעְשַׂר בְּהֵמָה')
        events, _ = PA.align_path(canon, [said('So that is Rosh Chodesh Elul for him.')], VA.phonetic, english=ENGLISH)
        self.assertEqual(events, [])


class SameWords(unittest.TestCase):
    def test_a_phrase_the_daf_repeats_is_offered_at_every_copy(self):
        # The Gemara quoting its Mishnah word for word: the phrase matcher names
        # the first copy, the path may take the one it is reading.
        canon = canon_from('בֶּן עַזַּאי אוֹמֵר: בְּאֶחָד בְּסִיוָן. גְּמָ׳ תַּנְיָא בֶּן עַזַּאי אוֹמֵר: בְּאֶחָד בְּסִיוָן.')
        self.assertEqual(PA.same_words_at(canon, 0, 2), [0, 7])
        self.assertEqual(PA.same_words_at(canon, 3, 4), [3, 10])
        self.assertEqual(PA.same_words_at(canon, 5, 6), [5])
        transcript = said('גמרא תניא', 'בן עזאי אומר באחד בסיון', gap=0.5)
        events, _ = PA.align_path(canon, [transcript], VA.phonetic, english=ENGLISH,
                                  proposals=[(transcript[2]['start'], transcript[-1]['end'], 0, 4, 90, 'בן עזאי אומר באחד בסיון')])
        self.assertEqual(spans(events)[-1][1], 11)


class Relisten(unittest.TestCase):
    """The holes the path leaves, listened to again on their own."""

    def test_the_path_reports_its_holes(self):
        canon = canon_from(MISHNAH)
        transcript = said('אף על פי שאינו רשאי', 'the', 'והמקבל הימנו', gap=0.5)
        _, stats = PA.align_path(canon, [transcript], VA.phonetic, english=ENGLISH, bridges=False)
        (t0, t1, lo, hi), = stats['holes']
        self.assertEqual((lo, hi), (12, 13))
        self.assertLess(t0, t1)

    def test_only_holes_with_a_word_placed_nowhere_are_listened_to(self):
        canon = canon_from(MISHNAH)
        holes = [(10.0, 12.0, 12, 13), (50.0, 51.0, 3, 4), (80.0, 120.0, 20, 21)]
        clips = VA.relisten_clips(canon, holes, placed_words={3, 4})
        self.assertEqual([(start, end) for start, end, _ in clips], [(8.0, 14.0), (78.0, 122.0)])
        # Hinted with the hole's words and two either side.
        self.assertEqual(clips[0][2], [c.norm for c in canon[10:16]])

    def test_clips_are_widened_merged_and_capped(self):
        canon = canon_from(MISHNAH)
        clips = VA.relisten_clips(canon, [(10.0, 10.0, 12, 12), (13.0, 14.0, 13, 13)])
        self.assertEqual([(start, end) for start, end, _ in clips], [(8.0, 16.0)])
        with mock.patch.object(VA, 'RELISTEN_MAX_TOTAL_SECONDS', 10.0):
            clips = VA.relisten_clips(canon, [(10.0, 20.0, 12, 12), (40.0, 41.0, 13, 14)])
        self.assertEqual([(start, end) for start, end, _ in clips], [(38.0, 43.0)])   # the bigger hole first

    def test_a_relistened_clip_comes_back_on_the_whole_audios_clock(self):
        canon = canon_from(MISHNAH)
        heard = []

        def transcribe_clip(path, terms):
            heard.append(terms)
            if len(heard) == 2:
                raise RuntimeError('rate limited')
            return [{'text': 'המשתתף', 'start': 2.5, 'end': 3.0}]

        with mock.patch.object(VA, 'cut_clip', side_effect=lambda audio, start, end, out: out):
            words = VA.relisten_holes('shiur.mp3', canon, [(10.0, 12.0, 12, 13), (100.0, 101.0, 14, 14)],
                                      transcribe_clip=transcribe_clip)
        self.assertEqual(len(heard), 2)                       # the second failed, the first was kept
        self.assertEqual(words, [{'text': 'המשתתף', 'start': 10.5, 'end': 11.0}])
        self.assertEqual(VA.parse_witnesses('hints,plain,relisten'), ['plain', 'relisten'])


class AfterTheReading(unittest.TestCase):
    """Once the daf has been read through, the maggid's quotes are not placed."""

    def test_the_reading_is_the_longest_run_through_the_daf_in_order(self):
        C = PA.Candidate
        placed = [C(10, 11, 40, 42, 90, 9, 'x', ''),            # a quote before the reading starts
                  C(20, 21, 0, 4, 90, 9, 'x', ''), C(30, 31, 5, 9, 90, 9, 'x', ''),
                  C(40, 41, 3, 4, 90, 9, 'x', ''),              # re-reading a phrase
                  C(50, 51, 10, 20, 90, 9, 'x', ''), C(60, 61, 21, 30, 90, 9, 'x', ''),
                  C(90, 91, 2, 3, 90, 9, 'x', ''), C(95, 96, 12, 13, 90, 9, 'x', '')]   # the discussion
        self.assertEqual(PA.reading_chain(placed), [1, 2, 4, 5])
        self.assertEqual(PA.end_of_reading(placed), 61)
        self.assertIsNone(PA.end_of_reading([]))

    def test_quotes_after_the_reading_are_not_placed(self):
        canon = canon_from(MISHNAH)
        # (English between the phrases, as a maggid translates as he reads: one
        # unbroken run of Hebrew letters that long would be the transcriber's prose.)
        reading = said('הלוקח עובר חמורו של נכרי', 'the', 'והמוכר לו אף על פי שאינו רשאי', 'the',
                       'והמשתתף לו והמקבל הימנו', 'the', 'והנותן לו בקבלה פטור מן הבכורה', 'the',
                       'שנאמר בישראל אבל לא באחרים')
        quotes = said('So that is הלוקח עובר חמורו', 'and again אף על פי שאינו רשאי', start=reading[-1]['end'] + 120)
        events, stats = PA.align_path(canon, [reading + quotes], VA.phonetic, english=ENGLISH)
        last_read = reading[-1]['end']
        self.assertTrue(events)
        self.assertTrue(all(e.t <= last_read + PA.AFTER_READING_GRACE_SECONDS for e in events))
        self.assertGreater(stats['droppedAfterReading'], 0)
        self.assertAlmostEqual(stats['readingEndsAt'], last_read, delta=0.5)
        kept, _ = PA.align_path(canon, [reading + quotes], VA.phonetic, english=ENGLISH, keep_after_reading=True)
        self.assertGreater(max(e.t for e in kept), last_read + 100)


class NeighborAmudim(unittest.TestCase):
    """A whole daf's job also reads the amud before and the amud after it."""

    def test_which_amudim_are_added(self):
        self.assertEqual(VA.neighbor_amudim(['Bekhorot 58a', 'Bekhorot 58b']), ('Bekhorot 57b', 'Bekhorot 59a'))
        self.assertEqual(VA.neighbor_amudim(['Bekhorot 57b', 'Bekhorot 58a', 'Bekhorot 58b']), (None, 'Bekhorot 59a'))
        self.assertEqual(VA.neighbor_amudim(['Bava Kamma 2a', 'Bava Kamma 2b']), (None, 'Bava Kamma 3a'))   # no daf 1
        # One amud, or several dapim: adding could change which daf the job is about.
        self.assertEqual(VA.neighbor_amudim(['Bekhorot 58b']), (None, None))
        self.assertEqual(VA.neighbor_amudim(['Bekhorot 58a', 'Bekhorot 58b', 'Bekhorot 60a']), (None, None))
        self.assertEqual(VA.neighbor_amudim(['Bekhorot 58a', 'Bekhorot 58b', 'Bekhorot 59a', 'Bekhorot 59b']), (None, None))
        self.assertEqual(VA.neighbor_amudim(['Bekhorot 58a (Chazarah)', 'Bekhorot 58b']), (None, None))

    def test_an_amud_sefaria_does_not_have_is_left_out(self):
        def load(refs, cache_dir=None):
            if refs == ['Bekhorot 61b']:
                raise RuntimeError("Sefaria returned no text for 'Bekhorot 61b'.")
            return [], []
        self.assertEqual(VA.with_neighbor_amudim(['Bekhorot 61a', 'Bekhorot 61b'], load=load),
                         ['Bekhorot 60b', 'Bekhorot 61a', 'Bekhorot 61b', 'Bekhorot 62a'])
        self.assertEqual(VA.with_neighbor_amudim(['Bekhorot 60a', 'Bekhorot 60b'], load=load),
                         ['Bekhorot 59b', 'Bekhorot 60a', 'Bekhorot 60b', 'Bekhorot 61a'])

        def gone(refs, cache_dir=None):
            if refs == ['Bekhorot 62a']:
                raise RuntimeError('no text')
            return [], []
        self.assertEqual(VA.with_neighbor_amudim(['Bekhorot 61a', 'Bekhorot 61b'], load=gone),
                         ['Bekhorot 60b', 'Bekhorot 61a', 'Bekhorot 61b'])


class Scoring(unittest.TestCase):
    def test_a_voice_alignment_is_scored_against_the_captions(self):
        import score_against_captions as SC
        ref = 'Bekhorot 40a:1'
        captions = {'wordTimeline': [
            {'start': 100, 'end': 110, 'ref': ref, 'w0': 0, 'w1': 4},
            {'start': 110, 'end': 300, 'ref': ref, 'w0': 5, 'w1': 9},      # trusted for 20s only
            {'start': 300, 'end': 310, 'ref': 'Bekhorot 40a:2', 'w0': 0, 'w1': 4},
        ]}
        voice = {
            'segments': [{'start': 100, 'ref': ref, 'w0': 0, 'w1': 4}, {'start': 110, 'ref': ref, 'w0': 40, 'w1': 44}],
            'wordTimeline': [{'start': 101, 'ref': ref, 'w0': 1, 'w1': 3}, {'start': 112, 'ref': ref, 'w0': 40, 'w1': 44},
                             {'start': 200, 'ref': ref, 'w0': 20, 'w1': 22}],
        }
        r = SC.score(voice, captions)
        self.assertEqual(r['secondsJudged'], 32)                 # 100..130, and 300
        # Right for the first ten seconds, and at 300s, where the next line starts one word on.
        self.assertEqual(round(r['within5Words'] * 32), 11)
        self.assertEqual((r['placementsRight'], r['placementsWrong'], r['placementsNoCaption']), (1, 1, 1))


if __name__ == '__main__':
    unittest.main()
