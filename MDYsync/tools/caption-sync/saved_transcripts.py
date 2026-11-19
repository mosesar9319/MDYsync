#!/usr/bin/env python3
"""Keeps what a voice job heard, so no shiur has to be paid for twice.

voice_align.py writes every transcript of a job (the one made with hints, the
re-listened holes, any further witness) to job-out/transcripts.json. This puts
that file on the results branch as

    transcripts/<video id>.json.gz

together with what the job was asked for (refs, maggid, variant, language, the
recording's address), which is everything realign.yml needs to place the same
shiur again -- with whatever the engine has learnt since -- without one
ElevenLabs credit:

    python3 saved_transcripts.py store --transcripts job-out/transcripts.json \
        --out-dir <results checkout> --refs-json '["Arakhin 2a", "Arakhin 2b"]' \
        --video-id L0213511665 --video-url <mp3> --maggid bornstein --job-id <id>
    python3 saved_transcripts.py meta --file <results checkout>/transcripts/L0213511665.json.gz

Until November 2026 the transcript was thrown away with the job: R' Bornstein's
Eruchin 2 lost five lines of Gemara to a rule in the engine, and seeing why (let
alone trying a fix) meant buying the same hour of transcription again.
"""
import argparse
import gzip
import json
import os
import sys

from publish_alignment import video_key, youtube_id_from_url

FOLDER = 'transcripts'
SCHEMA = 'dafsync-transcripts-v1'


def transcripts_path(out_dir, video_id=None, video_url=None, job_id=None):
    """Where a recording's transcripts are kept: by its video id (so a second
    sync of the same shiur replaces them), else as publish_alignment names it."""
    video_id = video_id or youtube_id_from_url(video_url)
    return os.path.join(out_dir, FOLDER, f'{video_key(video_id, video_url, job_id)}.json.gz')


def store(bundle, out_dir, refs, job_id=None, video_id=None, video_url=None, maggid=None,
          variant=None, language=None, engine_version=None):
    """Writes the bundle with the job's own details and returns the path, relative
    to out_dir."""
    if bundle.get('schema') != SCHEMA or not bundle.get('witnesses'):
        raise ValueError('not a transcripts file with anything in it')
    video_id = video_id or youtube_id_from_url(video_url)
    bundle = {
        **bundle,
        'job': {
            'jobId': job_id or None,
            'refs': list(refs),
            'videoId': video_id or None,
            'videoUrl': video_url or None,
            'maggid': maggid or None,
            'variant': variant or None,
            'language': language or None,
            'engineVersion': engine_version or None,
        },
    }
    path = transcripts_path(out_dir, video_id, video_url, job_id)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    # mtime=0: the same transcripts make the same bytes, so a job run again
    # does not make git store a second copy.
    with open(path, 'wb') as raw, gzip.GzipFile(fileobj=raw, mode='wb', mtime=0) as f:
        f.write(json.dumps(bundle, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))
    return os.path.relpath(path, out_dir)


def meta(path):
    """The job's details stored with a recording's transcripts."""
    with gzip.open(path, 'rt', encoding='utf-8') as f:
        data = json.load(f)
    job = dict(data.get('job') or {})
    job['witnesses'] = [{'name': w.get('name'), 'words': len(w.get('words', []))} for w in data.get('witnesses', [])]
    job['seconds'] = data.get('seconds')
    return job


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest='command', required=True)
    s = sub.add_parser('store')
    s.add_argument('--transcripts', required=True)
    s.add_argument('--out-dir', required=True)
    s.add_argument('--refs-json', required=True, help='The refs the job was asked for (not the neighbours it added).')
    s.add_argument('--job-id')
    s.add_argument('--video-id')
    s.add_argument('--video-url')
    s.add_argument('--maggid')
    s.add_argument('--variant')
    s.add_argument('--language')
    s.add_argument('--engine-version')
    m = sub.add_parser('meta')
    m.add_argument('--file', required=True)
    args = p.parse_args(argv)
    if args.command == 'meta':
        print(json.dumps(meta(args.file), ensure_ascii=False))
        return 0
    with open(args.transcripts, encoding='utf-8') as f:
        bundle = json.load(f)
    written = store(bundle, args.out_dir, json.loads(args.refs_json), job_id=args.job_id,
                    video_id=args.video_id, video_url=args.video_url, maggid=args.maggid,
                    variant=args.variant, language=args.language, engine_version=args.engine_version)
    print(f'Kept {written}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
