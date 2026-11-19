#!/usr/bin/env python3
"""The bench for filling a voice sync's holes in a Claude Code session.

llm_patch.py asks Claude, through the API, where the daf words a voice sync
could not place are said. The same questions can be answered by Claude in a
Claude Code session ("Answers from a file instead of the API", there). This
puts the steps either side of the answering in one place, so a session -- a
person's, or one a new shiur starts by itself -- does them the same way each
time (.claude/skills/patch-voice-sync/SKILL.md is the procedure):

    python3 patch_here.py list      --results <results checkout>
    python3 patch_here.py questions --results <results checkout> --video-id L0213511665 --out <dir>
    python3 patch_here.py check     --results <results checkout> --video-id L0213511665 --out <dir>

list       the synced shiurim whose transcripts are kept and that have no
           answers yet (patch-answers/<video id>.json), one JSON object a line.
questions  places the shiur from its saved transcripts and writes, in <dir>:
           INSTRUCTIONS.md (how to answer), holes.txt (every hole: the daf
           words missing, numbered D<n>, and what was heard, numbered [n]) and
           base.json (how many daf words are placed before any answer).
check      places it again with <dir>/answers.json, through the same checks an
           answer from the API passes; says how many placements were handed in
           and how many daf words they placed; fails when the highlight would
           step back or nothing was accepted; and writes <dir>/answers-input.txt,
           the answers on one line, for realign.yml's "answers" input.

No audio is read and no ElevenLabs or Anthropic API call is made. Needs what
the voice job installs (requirements-voice.txt) and Sefaria for the daf's text.
"""
import argparse
import glob
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
VIDEO_ID = re.compile(r'^[A-Za-z0-9_-]{11}$')
ANSWERS_SCHEMA = 'dafsync-patch-answers-v1'   # llm_patch.ANSWERS_SCHEMA


def unpatched(results):
    """The shiurim to answer: [{videoId, refs, maggid, seconds}] for every kept
    transcript without an answers file, oldest first."""
    from saved_transcripts import meta
    out = []
    for path in sorted(glob.glob(os.path.join(results, 'transcripts', '*.json.gz')), key=os.path.getmtime):
        video_id = os.path.basename(path)[:-len('.json.gz')]
        if not VIDEO_ID.match(video_id) or os.path.exists(os.path.join(results, 'patch-answers', f'{video_id}.json')):
            continue
        try:
            job = meta(path)
        except (OSError, ValueError):
            continue
        out.append({'videoId': video_id, 'refs': job.get('refs') or [], 'maggid': job.get('maggid'),
                    'seconds': job.get('seconds')})
    return out


def render_holes(asked):
    """llm_patch.questions() as one text to read: each hole with its missing
    words numbered by their place in the whole text (D<n>), which is how an
    answers file names them."""
    holes = asked['holes']
    parts = []
    for n, hole in enumerate(holes):
        lo = hole['dafWords'][0]
        body = hole['prompt'].split('\n\nFor each hole')[0]
        body = re.sub(r'^M(\d+): ', lambda m: f'D{lo + int(m.group(1))}: ', body, flags=re.M)
        parts.append(f"### Hole {n + 1} of {len(holes)}  ({hole['refs'][0]} to {hole['refs'][1]}; "
                     f"{hole['seconds'][0]:.0f}s-{hole['seconds'][1]:.0f}s of the recording)\n{body}")
    return '\n\n'.join(parts) + '\n'


def instructions(system, video_id):
    system = system.replace('numbered M0, M1, ... within their hole',
                            'numbered D<n> (their place in the whole text; the numbers run on from hole to hole)')
    return system + f'''

## What to hand in

Read holes.txt in this folder: every hole, in the form described above. The missing words are labelled D<n>; the heard words carry their own numbers in square brackets, [n].

Write your answer to answers.json in this folder:

{{"schema": "{ANSWERS_SCHEMA}", "videoId": "{video_id}",
 "placements": [
   {{"daf": [first D number, last D number], "heard": [first heard number, last heard number],
    "kind": "read" or "explained", "confidence": 0.0 to 1.0, "why": "a few words: what in the transcript is his saying or explaining of these words"}}
 ]}}

One entry for each run of missing words you place; leave out what you cannot place. A placement must stay inside one hole: its D numbers among that hole's missing words, its heard numbers among that hole's heard words. Placements with confidence under 0.7 are not used, so only hand in what you believe. A "read" placement may not claim much more speech than the words take to say (about four heard words for each daf word at most).

Some holes are long because the rabbi never read those lines at all in this recording (the end of the text, or lines of the neighbouring page he only listed in a recap): placing nothing there is the right answer.

Things the transcriber does that are worth knowing: two words run into one ("u'mokashim" for ומוכה שחין, "קרונה" for קרא נפקי); an abbreviation written as one word (קמ"ל holds קא משמע לן); and his edition's censored wording (he says "oved kochavim", often garbled, where the text has גוי or נכרי).
'''


def _place(results, video_id, out, extra):
    """Runs voice_align.py on the shiur's saved transcripts. Returns its alignment."""
    from saved_transcripts import meta
    saved = os.path.join(results, 'transcripts', f'{video_id}.json.gz')
    if not os.path.exists(saved):
        raise SystemExit(f'No transcripts are kept for {video_id}.')
    refs = meta(saved).get('refs') or []
    engine_out = os.path.join(out, 'engine')
    os.makedirs(engine_out, exist_ok=True)
    done = subprocess.run(
        [sys.executable, '-W', 'ignore', os.path.join(HERE, 'voice_align.py'), 'job-audio.mp3',
         '--refs-json', json.dumps(refs, ensure_ascii=False), '--saved-transcripts', saved,
         '--out-dir', engine_out] + extra,
        cwd=HERE, capture_output=True, text=True, env={**os.environ, 'VOICE_LLM_PATCH': '0'})
    if done.returncode != 0:
        raise SystemExit(f'voice_align.py failed:\n{done.stdout[-2000:]}\n{done.stderr[-2000:]}')
    with open(os.path.join(engine_out, 'alignment.json'), encoding='utf-8') as f:
        return json.load(f)


def _counts(alignment):
    stats = alignment.get('matchStats') or {}
    timeline = alignment.get('wordTimeline') or []
    return {
        'matchedWords': stats.get('matchedWords'), 'totalWords': stats.get('totalWords'),
        'dafWordsPatched': stats.get('dafWordsPatched') or 0, 'dafWordsExplained': stats.get('dafWordsExplained') or 0,
        'backwardSteps': sum(1 for a, b in zip(timeline, timeline[1:]) if b['start'] < a['start']),
    }


def write_questions(results, video_id, out):
    os.makedirs(out, exist_ok=True)
    questions_path = os.path.join(out, 'questions.json')
    alignment = _place(results, video_id, out, ['--patch-questions', questions_path])
    with open(questions_path, encoding='utf-8') as f:
        asked = json.load(f)
    with open(os.path.join(out, 'holes.txt'), 'w', encoding='utf-8') as f:
        f.write(render_holes(asked))
    with open(os.path.join(out, 'INSTRUCTIONS.md'), 'w', encoding='utf-8') as f:
        f.write(instructions(asked['system'], video_id))
    base = _counts(alignment)
    base['holes'] = len(asked['holes'])
    base['holeWords'] = sum(h['dafWords'][1] - h['dafWords'][0] + 1 for h in asked['holes'])
    with open(os.path.join(out, 'base.json'), 'w', encoding='utf-8') as f:
        json.dump(base, f)
    return base


def answers_input(answers):
    """An answers file on one line, as realign.yml's "answers" input takes it."""
    return json.dumps(answers, ensure_ascii=False, separators=(',', ':'))


def check_answers(results, video_id, out):
    path = os.path.join(out, 'answers.json')
    with open(path, encoding='utf-8') as f:
        answers = json.load(f)
    if answers.get('schema') != ANSWERS_SCHEMA or answers.get('videoId') != video_id:
        raise SystemExit(f'{path} must have "schema": "{ANSWERS_SCHEMA}" and "videoId": "{video_id}".')
    handed_in = answers.get('placements') or []
    after = _counts(_place(results, video_id, out, ['--patch-answers', path]))
    try:
        with open(os.path.join(out, 'base.json'), encoding='utf-8') as f:
            before = json.load(f)
    except (OSError, ValueError):
        before = {}
    report = {'videoId': video_id, 'handedIn': len(handed_in),
              'handedInWords': sum(p['daf'][1] - p['daf'][0] + 1 for p in handed_in),
              'before': before.get('matchedWords'), **after}
    problems = []
    if after['backwardSteps']:
        problems.append(f"the highlight would step back {after['backwardSteps']} time(s)")
    if handed_in and not after['dafWordsPatched'] + after['dafWordsExplained']:
        problems.append('none of the placements handed in was accepted')
    if before.get('matchedWords') is not None and after['matchedWords'] < before['matchedWords']:
        problems.append('fewer daf words are placed than before')
    report['ok'] = not problems
    report['problems'] = problems
    if not problems:
        with open(os.path.join(out, 'answers-input.txt'), 'w', encoding='utf-8') as f:
            f.write(answers_input(answers))
    return report


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest='command', required=True)
    for name in ('list', 'questions', 'check'):
        s = sub.add_parser(name)
        s.add_argument('--results', required=True, help='A checkout of the results branch.')
        if name != 'list':
            s.add_argument('--video-id', required=True)
            s.add_argument('--out', required=True, help='A working folder for this shiur.')
    args = p.parse_args(argv)
    if args.command == 'list':
        for shiur in unpatched(args.results):
            print(json.dumps(shiur, ensure_ascii=False))
        return 0
    if not VIDEO_ID.match(args.video_id):
        raise SystemExit(f'Not a video id: {args.video_id}')
    if args.command == 'questions':
        print(json.dumps(write_questions(args.results, args.video_id, args.out)))
        return 0
    report = check_answers(args.results, args.video_id, args.out)
    print(json.dumps(report, ensure_ascii=False))
    return 0 if report['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
