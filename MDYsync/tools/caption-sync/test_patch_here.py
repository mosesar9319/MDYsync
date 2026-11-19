#!/usr/bin/env python3
"""Unit tests for patch_here.py (what stands either side of the answering).
`python3 test_patch_here.py`."""
import gzip
import json
import os
import tempfile
import unittest

import llm_patch as LP
import patch_here as PH


def keep(results, video_id, refs=('Arakhin 4a', 'Arakhin 4b'), answered=False):
    os.makedirs(os.path.join(results, 'transcripts'), exist_ok=True)
    bundle = {'schema': 'dafsync-transcripts-v1', 'seconds': 3600.0,
              'witnesses': [{'name': 'hints', 'words': [['hakol', 1.0, 1.4]]}],
              'job': {'refs': list(refs), 'videoId': video_id, 'maggid': 'bornstein'}}
    with gzip.open(os.path.join(results, 'transcripts', f'{video_id}.json.gz'), 'wt', encoding='utf-8') as f:
        json.dump(bundle, f)
    if answered:
        os.makedirs(os.path.join(results, 'patch-answers'), exist_ok=True)
        with open(os.path.join(results, 'patch-answers', f'{video_id}.json'), 'w') as f:
            json.dump({'schema': PH.ANSWERS_SCHEMA, 'videoId': video_id, 'placements': []}, f)


class WhichShiurim(unittest.TestCase):
    def test_a_shiur_with_kept_transcripts_and_no_answers_is_to_do(self):
        with tempfile.TemporaryDirectory() as results:
            self.assertEqual(PH.unpatched(results), [])
            keep(results, 'L0213511665', answered=True)
            keep(results, 'L0213600001')
            keep(results, 'not-a-video-id-at-all')
            self.assertEqual(PH.unpatched(results), [
                {'videoId': 'L0213600001', 'refs': ['Arakhin 4a', 'Arakhin 4b'], 'maggid': 'bornstein', 'seconds': 3600.0}])


class Questions(unittest.TestCase):
    ASKED = {'system': LP.SYSTEM, 'holes': [
        {'dafWords': [60, 62], 'heardWords': [75, 80], 'seconds': [25.0, 62.4], 'refs': ['Arakhin 2b:4', 'Arakhin 2b:4'],
         'missing': {'60': 'בסוכה', '61': 'לאיתויי', '62': 'מאי'},
         'prompt': '<hole daf_words="60-62">\n<placed_before>הכל חייבין</placed_before>\n<missing>\nM0: בסוכה\nM1: לאיתויי\n'
                   'M2: מאי\n</missing>\n<placed_after>לאיתויי קטן</placed_after>\n<heard seconds="38">\n[75] Amud [76] Beis\n'
                   '</heard>\n</hole>\n\nFor each hole, give the placements of its missing words.'},
        {'dafWords': [321, 321], 'heardWords': [540, 560], 'seconds': [170.0, 180.0], 'refs': ['Arakhin 2b:17', 'Arakhin 2b:17'],
         'missing': {'321': 'ביום'},
         'prompt': '<hole daf_words="321-321">\n<missing>\nM0: ביום\n</missing>\n<heard seconds="10">\n[551] Veyontiv\n</heard>\n'
                   '</hole>\n\nFor each hole, give the placements.'}]}

    def test_the_missing_words_carry_their_place_in_the_whole_text(self):
        text = PH.render_holes(self.ASKED)
        self.assertIn('### Hole 1 of 2  (Arakhin 2b:4 to Arakhin 2b:4; 25s-62s of the recording)', text)
        self.assertIn('D60: בסוכה\nD61: לאיתויי\nD62: מאי', text)
        self.assertIn('D321: ביום', text)
        self.assertNotIn('M0:', text)
        self.assertNotIn('For each hole', text)
        self.assertIn('[551] Veyontiv', text)

    def test_the_instructions_say_how_to_answer_this_shiur(self):
        text = PH.instructions(LP.SYSTEM, 'L0213600001')
        self.assertIn('"videoId": "L0213600001"', text)
        self.assertIn(f'"schema": "{LP.ANSWERS_SCHEMA}"', text)
        self.assertIn('numbered D<n>', text)
        self.assertNotIn('M0, M1', text)
        self.assertEqual(PH.ANSWERS_SCHEMA, LP.ANSWERS_SCHEMA)

    def test_the_answers_go_to_the_workflow_on_one_line(self):
        answers = {'schema': PH.ANSWERS_SCHEMA, 'videoId': 'L0213600001',
                   'placements': [{'daf': [321, 321], 'heard': [551, 551], 'kind': 'read', 'confidence': 0.88, 'why': '"Veyontiv" = ביום טוב'}]}
        line = PH.answers_input(answers)
        self.assertNotIn('\n', line)
        self.assertEqual(json.loads(line), answers)
        self.assertIn('ביום טוב', line)


if __name__ == '__main__':
    unittest.main()
