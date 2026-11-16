#!/usr/bin/env python3
"""Scores a voice alignment against a caption (OCR) alignment of the SAME video.

Mercaz Daf Yomi burns the words being read into the picture, so its caption
alignments say where on the daf the shiur really is at every moment. That makes any
MDY shiur an answer key for the voice engine: run the voice engine on it, and this
tells how often its highlight is where the captions are.

    python3 score_against_captions.py --voice out/alignment.json --captions Bekhorot-40a.json

Both files are dafsync-alignment-v2 (what publish_alignment.py writes, and what
/api/get-results-file?path=by-ref/<key>.json returns). Stdlib only.

Prints, for every second a caption was on screen: how often the voice alignment's
current line is within 5 and within 15 words of it; and for each voice placement
(wordTimeline entry), whether the captions agree.
"""
import argparse
import bisect
import json
import re

# A caption stays "on screen" in the file until the next one appears; past this
# many seconds it says nothing about where the shiur is (a long explanation).
CAPTION_TRUST_SECONDS = 20
PLACEMENT_PAD_SECONDS = 6
PLACEMENT_SLACK_WORDS = 3

_REF = re.compile(r'^(.*) (\d+)([ab]):(\d+)$')


def _ref_key(ref):
    m = _REF.match(ref)
    return (m.group(1), int(m.group(2)), m.group(3), int(m.group(4))) if m else (ref, 0, '', 0)


def word_order(*alignments):
    """A position for every (ref, word index) either file mentions, in daf order."""
    lengths = {}
    for alignment in alignments:
        for entry in (alignment.get('segments') or []) + (alignment.get('wordTimeline') or []):
            if entry.get('ref') is None or entry.get('w1') is None:
                continue
            lengths[entry['ref']] = max(lengths.get(entry['ref'], 0), int(entry['w1']) + 1)
    offsets, total = {}, 0
    for ref in sorted(lengths, key=_ref_key):
        offsets[ref] = total
        total += lengths[ref]
    return lambda ref, w: offsets[ref] + int(w)


def score(voice, captions):
    at = word_order(voice, captions)
    truth = sorted((e['start'], min(e['end'], e['start'] + CAPTION_TRUST_SECONDS), at(e['ref'], e['w0']), at(e['ref'], e['w1']))
                   for e in captions.get('wordTimeline') or [])
    if not truth:
        raise ValueError('The caption alignment has no wordTimeline.')
    truth_starts = [t[0] for t in truth]
    lines = sorted((s['start'], at(s['ref'], s['w0']), at(s['ref'], s['w1'])) for s in voice.get('segments') or [])
    line_starts = [line[0] for line in lines]

    judged = within5 = within15 = 0
    t = truth[0][0]
    while t <= truth[-1][0]:
        k = bisect.bisect_right(truth_starts, t) - 1
        if k >= 0 and t <= truth[k][1]:
            judged += 1
            j = bisect.bisect_right(line_starts, t) - 1
            if j >= 0:
                _, a, b = lines[j]
                ta, tb = truth[k][2], truth[k][3]
                distance = 0 if (a <= tb and b >= ta) else min(abs(a - tb), abs(b - ta))
                within5 += distance <= 5
                within15 += distance <= 15
        t += 1.0

    right = wrong = unjudged = 0
    for e in voice.get('wordTimeline') or []:
        a, b = at(e['ref'], e['w0']), at(e['ref'], e['w1'])
        lo = bisect.bisect_left(truth_starts, e['start'] - PLACEMENT_PAD_SECONDS - CAPTION_TRUST_SECONDS)
        hi = bisect.bisect_right(truth_starts, e['start'] + PLACEMENT_PAD_SECONDS)
        near = [(ta, tb) for (s, end, ta, tb) in truth[lo:hi]
                if s - PLACEMENT_PAD_SECONDS <= e['start'] <= end + PLACEMENT_PAD_SECONDS]
        if not near:
            unjudged += 1
        elif any(a <= tb + PLACEMENT_SLACK_WORDS and b >= ta - PLACEMENT_SLACK_WORDS for ta, tb in near):
            right += 1
        else:
            wrong += 1
    return {
        'secondsJudged': judged,
        'within5Words': within5 / judged if judged else 0.0,
        'within15Words': within15 / judged if judged else 0.0,
        'placements': right + wrong + unjudged,
        'placementsRight': right,
        'placementsWrong': wrong,
        'placementsNoCaption': unjudged,
    }


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--voice', required=True, help='The voice alignment to score.')
    p.add_argument('--captions', required=True, help='The caption (OCR) alignment of the same video.')
    args = p.parse_args()
    with open(args.voice, encoding='utf-8') as f:
        voice = json.load(f)
    with open(args.captions, encoding='utf-8') as f:
        captions = json.load(f)
    r = score(voice, captions)
    print(f"Highlight within 5 words of the captions {r['within5Words']:.0%} of the time, "
          f"within 15 words {r['within15Words']:.0%} ({r['secondsJudged']}s judged).")
    judged = r['placementsRight'] + r['placementsWrong']
    share = r['placementsRight'] / judged if judged else 0.0
    print(f"Placements: {r['placements']}; where a caption was showing, {r['placementsRight']} agree and "
          f"{r['placementsWrong']} do not ({share:.0%} right); {r['placementsNoCaption']} had no caption to compare.")


if __name__ == '__main__':
    main()
