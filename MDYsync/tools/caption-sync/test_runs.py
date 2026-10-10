"""Numbered test runs of the voice engines, kept per video on the `results` branch.

A test shiur is a video the maintainers use to tune the voice models: every
time either engine is run on it, the alignment is saved as a new numbered run
instead of replacing the last, so a change to an engine can be judged by
playing the old and the new alignments of the same shiur side by side.

Layout, under the results branch checkout (`--out-dir`):

    test-runs/<videoId>/index.json        every run, newest last
    test-runs/<videoId>/regular-1.json    the alignment itself, one file per run
    test-runs/<videoId>/live-1.json

Numbers count per engine ("Regular #3", "Live #2"), never reused, so a name is
enough to say which run something came from. `index.json` is what the player's
two dropdowns (one per engine) read; each run file is an ordinary
dafsync-alignment-v2 document the player loads exactly like a by-ref one, plus a
`testRun` block saying which run it is.

Shared by voice-job.yml (the regular engine) and tools/test-shiur/run-live-engine.mjs
(the live engine), so there is one place that decides numbers and names.
"""

import argparse
import datetime
import json
import os
import re

SCHEMA = 'dafsync-test-runs-v1'
ENGINES = {
    'regular': 'Regular engine',
    'live': 'Live engine',
}
VIDEO_ID = re.compile(r'^[A-Za-z0-9_-]{11}$')


def index_path(out_dir, video_id):
    return os.path.join(out_dir, 'test-runs', video_id, 'index.json')


def load_index(out_dir, video_id):
    try:
        with open(index_path(out_dir, video_id), encoding='utf-8') as f:
            index = json.load(f)
        if isinstance(index.get('runs'), list):
            return index
    except (OSError, ValueError):
        pass
    return {'schema': SCHEMA, 'videoId': video_id, 'runs': []}


def next_number(index, engine):
    """One more than the highest number this engine has ever had on the video."""
    return 1 + max((r['number'] for r in index['runs'] if r['engine'] == engine), default=0)


def run_name(engine, number, notes='', created_at=None):
    """'Regular #3 · 10 Oct 2026 · what changed' -- what the dropdown shows."""
    when = ''
    if created_at:
        try:
            when = datetime.datetime.fromisoformat(created_at.replace('Z', '+00:00')).strftime('%-d %b %Y')
        except ValueError:
            when = ''
    parts = [f"{ENGINES[engine].split()[0]} #{number}"]
    if when:
        parts.append(when)
    if notes:
        parts.append(notes.strip())
    return ' · '.join(parts)


def summarize(alignment):
    """A few numbers that let two runs be compared without opening them."""
    timeline = alignment.get('wordTimeline') or []
    placed_words = 0
    for entry in timeline:
        try:
            placed_words += max(0, int(entry.get('w1')) - int(entry.get('w0')) + 1)
        except (TypeError, ValueError):
            continue
    segments = alignment.get('segments') or []
    summary = {
        'segments': len(segments),
        'estimatedSegments': sum(1 for s in segments if s.get('estimated')),
        'placements': len(timeline),
        'placedWords': placed_words,
    }
    stats = alignment.get('matchStats')
    if isinstance(stats, dict):
        for key in ('totalRuns', 'totalWords', 'matchedWords', 'unmatchedWords'):
            if key in stats:
                summary[key] = stats[key]
    if alignment.get('duration'):
        summary['durationSeconds'] = alignment['duration']
    return summary


def publish_test_run(alignment, out_dir, video_id, engine, notes='', engine_version=None,
                     job_id=None, now=None):
    """Writes the next numbered run for `engine`. Returns its index entry."""
    if engine not in ENGINES:
        raise ValueError(f'engine must be one of {sorted(ENGINES)}')
    if not VIDEO_ID.match(str(video_id or '')):
        raise ValueError('a YouTube video id is required')
    created_at = (now or datetime.datetime.now(datetime.timezone.utc)).strftime('%Y-%m-%dT%H:%M:%SZ')
    index = load_index(out_dir, video_id)
    number = next_number(index, engine)
    run_id = f'{engine}-{number}'
    name = run_name(engine, number, notes, created_at)
    entry = {
        'id': run_id,
        'engine': engine,
        'number': number,
        'name': name,
        'notes': notes or '',
        'engineVersion': engine_version or None,
        'createdAt': created_at,
        'file': f'{run_id}.json',
        'jobId': job_id,
        'summary': summarize(alignment),
    }
    stamped = dict(alignment)
    stamped['testRun'] = {k: entry[k] for k in ('id', 'engine', 'number', 'name', 'notes', 'engineVersion', 'createdAt')}
    folder = os.path.join(out_dir, 'test-runs', video_id)
    os.makedirs(folder, exist_ok=True)
    with open(os.path.join(folder, entry['file']), 'w', encoding='utf-8') as f:
        json.dump(stamped, f, ensure_ascii=False, indent=2)
    index['runs'].append(entry)
    index['updatedAt'] = created_at
    with open(index_path(out_dir, video_id), 'w', encoding='utf-8') as f:
        json.dump(index, f, ensure_ascii=False, indent=2)
        f.write('\n')
    return entry


def main():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest='command', required=True)
    pub = sub.add_parser('publish', help='Save an alignment as the next numbered run.')
    pub.add_argument('--alignment', required=True)
    pub.add_argument('--out-dir', required=True)
    pub.add_argument('--video-id')
    pub.add_argument('--video-url', help="A YouTube link, when the id isn't at hand.")
    pub.add_argument('--engine', required=True, choices=sorted(ENGINES))
    pub.add_argument('--refs-json', help='The refs the recording covers, as the voice job was given them.')
    pub.add_argument('--notes', default='')
    pub.add_argument('--engine-version', default=None)
    pub.add_argument('--job-id', default=None)
    args = p.parse_args()
    video_id = args.video_id
    if not video_id and args.video_url:
        from publish_alignment import youtube_id_from_url
        video_id = youtube_id_from_url(args.video_url)
    if not video_id:
        p.error('--video-id or a YouTube --video-url is required')
    with open(args.alignment, encoding='utf-8') as f:
        alignment = json.load(f)
    # What publish_alignment.py stamps on a normal result, so the player can
    # tell which recording these timestamps were measured against.
    alignment['videoId'] = video_id
    if args.video_url:
        alignment['videoUrl'] = args.video_url
    if args.refs_json:
        alignment['coveredRefs'] = json.loads(args.refs_json)
    entry = publish_test_run(alignment, args.out_dir, video_id, args.engine, notes=args.notes,
                             engine_version=args.engine_version, job_id=args.job_id)
    print(f"Published test-runs/{video_id}/{entry['file']}: {entry['name']}")


if __name__ == '__main__':
    main()
