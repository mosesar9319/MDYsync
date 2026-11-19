#!/usr/bin/env python3
"""Unit tests for llm_patch.py (Claude reading the holes the path leaves) and the
way voice_align.py counts its answers. No request is made: Claude's answers are
written out here. `python3 test_llm_patch.py`."""
import sys
import types
import unittest

sys.modules.setdefault('faster_whisper', types.SimpleNamespace(WhisperModel=object))

import llm_patch as LP  # noqa: E402
import path_align as PA  # noqa: E402
import voice_align as VA  # noqa: E402
from caption_ocr_align import CanonWord, WordEvent, normalize_word  # noqa: E402

# 0 הלוקח 1 עובר 2 חמורו 3 של 4 נכרי 5 והמוכר 6 לו 7 אף 8 על 9 פי 10 שאינו 11 רשאי
# 12 המשתתף 13 לו 14 והמקבל 15 הימנו
DAF = 'הלוקח עובר חמורו של נכרי והמוכר לו אף על פי שאינו רשאי המשתתף לו והמקבל הימנו'


def canon_from(text, ref='Bekhorot 2a:1'):
    return [CanonWord(ref, 0, j, w, normalize_word(w)) for j, w in enumerate(text.split())]


def heard_from(text, start=100.0):
    """A transcript, one word every half second."""
    return [{'text': w, 'start': start + 0.5 * i, 'end': start + 0.5 * i + 0.4} for i, w in enumerate(text.split())]


def event(heard, i, s, e):
    return WordEvent(heard[i]['start'], s, e, 90.0, '', 'path-hebrew')


class Gaps(unittest.TestCase):
    def setUp(self):
        self.canon = canon_from(DAF)
        #                        0         1    2   3     4  5 6     7       8    9      10    11    12         13
        self.heard = heard_from('halokeach ubar the buyer of a fetus chamoro shel nochri which means vehamocher lo')
        # Placed: 0-1 at heard 0, and 5-6 at heard 12. Words 2-4 are the hole.
        self.events = [event(self.heard, 0, 0, 1), event(self.heard, 12, 5, 6)]

    def test_a_hole_is_the_unplaced_words_and_what_was_heard_between_its_neighbours(self):
        gaps = LP.find_gaps(self.canon, self.events, set(range(7)), self.heard)
        (gap,) = gaps
        self.assertEqual((gap.lo, gap.hi), (2, 4))
        self.assertEqual((gap.t0, gap.t1), (100.0, 106.0))
        self.assertLessEqual(gap.a, 1)
        self.assertEqual(gap.b, len(self.heard))            # to the end of the stretch (and a little past)

    def test_words_that_do_not_count_are_not_asked_about(self):
        self.assertEqual(LP.find_gaps(self.canon, self.events, {0, 1, 5, 6}, self.heard), [])

    def test_a_hole_at_the_end_reaches_only_so_far(self):
        gaps = LP.find_gaps(self.canon, self.events, set(range(16)), self.heard, duration=4000.0)
        self.assertEqual([(g.lo, g.hi) for g in gaps], [(2, 4), (7, 15)])
        self.assertEqual(gaps[1].t1 - gaps[1].t0, LP.OPEN_END_SECONDS)

    def test_a_stretch_too_long_to_be_one_hole_is_left(self):
        late = [event(self.heard, 0, 0, 1), WordEvent(100.0 + LP.MAX_GAP_SECONDS + 5, 5, 6, 90.0, '', 'path-hebrew')]
        self.assertEqual(LP.find_gaps(self.canon, late, set(range(7)), self.heard), [])

    def test_the_request_shows_each_hole_its_neighbours_and_numbered_speech(self):
        (gap,) = LP.find_gaps(self.canon, self.events, set(range(7)), self.heard)
        text = LP.describe(self.canon, self.heard, [gap])
        self.assertIn('<placed_before>הלוקח עובר</placed_before>', text)
        self.assertIn('M0: חמורו\nM1: של\nM2: נכרי', text)
        self.assertIn('<placed_after>והמוכר לו אף על</placed_after>', text)
        self.assertIn('[7] chamoro [8] shel [9] nochri', text)

    def test_holes_are_sent_a_few_at_a_time(self):
        gaps = [LP.Gap(i, i, 0.0, 1.0, 0, 1000) for i in range(7)]
        self.assertEqual([len(b) for b in LP.batches(gaps)], [3, 3, 1])     # 3000 heard words a request
        small = [LP.Gap(i, i, 0.0, 1.0, 0, 10) for i in range(30)]
        self.assertEqual([len(b) for b in LP.batches(small)], [12, 12, 6])


class Answers(unittest.TestCase):
    def setUp(self):
        self.canon = canon_from(DAF)
        self.heard = heard_from('halokeach ubar the buyer of a fetus chamoro shel nochri which means vehamocher lo')
        events = [event(self.heard, 0, 0, 1), event(self.heard, 12, 5, 6)]
        (self.gap,) = LP.find_gaps(self.canon, events, set(range(7)), self.heard)

    def accept(self, *placements, gap=0):
        answer = {'gaps': [{'gap': gap, 'placements': [
            dict(zip(('first_missing', 'last_missing', 'first_heard', 'last_heard', 'kind', 'confidence'), p))
            for p in placements]}]}
        return [(s, e, h0, h1, kind) for _, s, e, h0, h1, kind, _ in LP.accept([self.gap], answer, self.heard)]

    def test_a_good_answer_is_taken_on_the_dafs_own_numbering(self):
        self.assertEqual(self.accept((0, 2, 7, 9, 'read', 0.95)), [(2, 4, 7, 9, 'read')])
        self.assertEqual(self.accept((0, 0, 2, 6, 'explained', 0.8), (1, 2, 8, 9, 'read', 0.9)),
                         [(2, 2, 2, 6, 'explained'), (3, 4, 8, 9, 'read')])

    def test_an_unsure_or_impossible_answer_is_dropped(self):
        self.assertEqual(self.accept((0, 2, 7, 9, 'read', 0.5)), [])               # not confident
        self.assertEqual(self.accept((0, 3, 7, 9, 'read', 0.9)), [])               # M3 is not in the hole
        self.assertEqual(self.accept((0, 2, 7, 99, 'read', 0.9)), [])               # heard word outside the stretch
        self.assertEqual(self.accept((2, 0, 7, 9, 'read', 0.9)), [])               # backwards
        self.assertEqual(self.accept((0, 2, 7, 9, 'guessed', 0.9)), [])
        self.assertEqual(self.accept((0, 2, 7, 9, 'read', 0.9), gap=5), [])        # no such hole
        self.assertEqual(LP.accept([self.gap], None, self.heard), [])
        self.assertEqual(LP.accept([self.gap], {'gaps': 'none'}, self.heard), [])

    def test_a_read_answer_cannot_claim_far_more_speech_than_the_words_take(self):
        # One daf word "read" over ten heard words is an explanation, not a reading.
        self.assertEqual(self.accept((0, 0, 2, 11, 'read', 0.9)), [])
        self.assertEqual(self.accept((0, 0, 2, 11, 'explained', 0.9)), [(2, 2, 2, 11, 'explained')])

    def test_a_hole_whose_placements_contradict_each_other_is_dropped_whole(self):
        self.assertEqual(self.accept((0, 1, 8, 9, 'read', 0.9), (2, 2, 7, 7, 'read', 0.9)), [])       # out of order
        self.assertEqual(self.accept((0, 1, 7, 8, 'read', 0.9), (1, 2, 9, 9, 'read', 0.9)), [])       # M1 twice


class Patched(unittest.TestCase):
    """The whole step, with Claude's answer written out."""

    def setUp(self):
        self.canon = (canon_from(DAF, 'Bekhorot 2a:1') + canon_from('אמר רבי יוחנן הלכה', 'Bekhorot 2b:1'))
        self.heard = heard_from('halokeach ubar the buyer of a fetus chamoro shel nochri which means vehamocher lo '
                                'even though he may not af al pi she eino rashai')
        self.events = [event(self.heard, 0, 0, 1), event(self.heard, 12, 5, 6), event(self.heard, 19, 7, 11)]
        self.primary = VA.primary_word_indices(self.canon, ['Bekhorot 2a'])
        self.stats = {'bySource': {}, 'matchedWords': 9, 'unmatchedWords': 7, 'totalWords': 16}
        self.asked = []

    def claude(self, placements):
        def ask(client, canon, heard, batch, refresh):
            self.asked.append(batch)
            return ({'gaps': [{'gap': n, 'placements': placements if n == 0 else []} for n in range(len(batch))]},
                    {'calls': 1, 'inputTokens': 1200, 'outputTokens': 80})
        return ask

    def test_words_he_read_are_matched_and_words_he_only_explained_are_counted_apart(self):
        answer = [{'first_missing': 0, 'last_missing': 0, 'first_heard': 2, 'last_heard': 6, 'kind': 'explained', 'confidence': 0.8},
                  {'first_missing': 1, 'last_missing': 2, 'first_heard': 8, 'last_heard': 9, 'kind': 'read', 'confidence': 0.9}]
        events = VA.apply_llm_patch(self.canon, self.events, self.stats, self.heard, self.primary, 200.0,
                                    client=object(), ask_claude=self.claude(answer))
        new = [e for e in events if e.source.startswith('claude-')]
        self.assertEqual([(e.start_idx, e.end_idx, e.source, e.ocr_text) for e in new],
                         [(2, 2, 'claude-explained', 'the buyer of a fetus'), (3, 4, 'claude-read', 'shel nochri')])
        self.assertEqual(new[1].t, self.heard[8]['start'])
        self.assertEqual([e.t for e in events], sorted(e.t for e in events))
        # Read: matched. Explained: highlighted (it is an event) but not matched.
        self.assertEqual((self.stats['dafWordsPatched'], self.stats['dafWordsExplained']), (2, 1))
        self.assertEqual((self.stats['matchedWords'], self.stats['unmatchedWords']), (11, 5))
        self.assertEqual(self.stats['claude']['calls'], 1)
        self.assertEqual((self.stats['claude']['readWords'], self.stats['claude']['explainedWords']), (2, 1))
        self.assertEqual(self.stats['bySource']['claude-read'], {
            'label': LP.SOURCE_LABELS['claude-read'], 'runs': 1, 'words': 2})
        # The neighbouring amud was never read, so it was never asked about.
        self.assertTrue(all(g.hi < 16 for batch in self.asked for g in batch))

    def test_no_holes_means_no_request(self):
        full = [WordEvent(100.0, 0, 15, 90.0, '', 'path-hebrew')]
        events = VA.apply_llm_patch(self.canon, full, self.stats, self.heard, self.primary, 200.0,
                                    client=object(), ask_claude=self.claude([]))
        self.assertEqual(self.asked, [])
        self.assertEqual(events, full)
        self.assertEqual(self.stats['claude']['calls'], 0)

    def test_it_is_on_only_where_the_job_can_reach_claude(self):
        from unittest import mock
        with mock.patch.dict('os.environ', {}, clear=True):
            self.assertFalse(VA.llm_patch_by_default())
        with mock.patch.dict('os.environ', {'ANTHROPIC_API_KEY': 'k'}, clear=True):
            self.assertTrue(VA.llm_patch_by_default())
        with mock.patch.dict('os.environ', {'ANTHROPIC_API_KEY': 'k', 'VOICE_LLM_PATCH': '0'}, clear=True):
            self.assertFalse(VA.llm_patch_by_default())


class Request(unittest.TestCase):
    """What is sent, and what comes back, without sending it."""

    def setUp(self):
        self.canon = canon_from(DAF)
        self.heard = heard_from('halokeach ubar the buyer of a fetus chamoro shel nochri which means vehamocher lo')
        events = [event(self.heard, 0, 0, 1), event(self.heard, 12, 5, 6)]
        self.batch = LP.find_gaps(self.canon, events, set(range(7)), self.heard)

    def client(self, **response):
        sent = {}

        def create(**kwargs):
            sent.update(kwargs)
            return types.SimpleNamespace(**{'usage': types.SimpleNamespace(input_tokens=900, output_tokens=60), **response})
        return types.SimpleNamespace(beta=types.SimpleNamespace(messages=types.SimpleNamespace(create=create))), sent

    def test_the_request_and_its_answer(self):
        body = '{"gaps": [{"gap": 0, "placements": []}]}'
        client, sent = self.client(stop_reason='end_turn', content=[
            types.SimpleNamespace(type='thinking', thinking=''), types.SimpleNamespace(type='text', text=body)])
        refreshed = []
        answer, usage = LP.ask(client, self.canon, self.heard, self.batch, refresh=lambda: refreshed.append(1))
        self.assertEqual(answer, {'gaps': [{'gap': 0, 'placements': []}]})
        self.assertEqual(usage, {'calls': 1, 'inputTokens': 900, 'outputTokens': 60})
        self.assertEqual(refreshed, [1])
        self.assertEqual(sent['model'], 'claude-opus-5-5')
        self.assertEqual(sent['output_config']['format']['type'], 'json_schema')
        self.assertEqual(sent['output_config']['effort'], LP.EFFORT)
        self.assertEqual((sent['betas'], sent['fallbacks']), ([LP.FALLBACK_BETA], 'default'))
        self.assertNotIn('thinking', sent)          # adaptive by default; it cannot be turned off on this model
        self.assertNotIn('temperature', sent)

    def test_an_answer_cut_short_or_declined_is_not_read(self):
        for reason in ('max_tokens', 'refusal'):
            client, _ = self.client(stop_reason=reason, content=[types.SimpleNamespace(type='text', text='{"gaps": [')])
            answer, usage = LP.ask(client, self.canon, self.heard, self.batch)
            self.assertIsNone(answer)
            self.assertEqual(usage['inputTokens'], 900)     # it was still paid for


if __name__ == '__main__':
    unittest.main()
