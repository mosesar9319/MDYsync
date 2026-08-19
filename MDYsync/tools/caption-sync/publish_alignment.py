"""Publishes one finished alignment to the `results` branch checkout.

Shared by ocr-job.yml and voice-job.yml so the (subtle) rules below live in
one testable place instead of being duplicated inside two YAML heredocs.

WHY THIS ISN'T JUST "WRITE by-ref/<ref>.json FOR EVERY REF":

A shiur almost always opens by reviewing the last few lines of the PREVIOUS
daf before starting its own, so a job for daf N is dispatched covering
[N-1b, Na, Nb]. Every covered ref used to get the whole alignment written
under its own by-ref/<ref>.json -- including that lead-in ref. Two things
went wrong as a result, both confirmed directly against published data:

  1. The next daf's job clobbered the previous daf's alignment. Daf 104's
     job overwrote by-ref/Chullin-103b.json (which daf 103's job had filled
     with 67 real segments) with its own 55-segment lead-in tail.

  2. Worse, the clobbering desynced the alignment from the video. An
     alignment's timestamps only mean anything against the ONE recording
     they were measured from, but nothing recorded which that was, and
     video-links/<ref>.json is chosen independently. Measured across
     Chullin 100-109, 4 of 20 dapim ended up with an alignment whose
     timestamps came from a different video than the one the reader is
     actually given -- e.g. Chullin 104b served the daf-105 job's
     timestamps while playing the daf-104 shiur, which is simply wrong
     everywhere rather than merely misordered.

So: the full alignment is published once per VIDEO (by-video/<key>.json),
which is the only thing its timestamps are meaningful against, and
by-ref/<ref>.json is written only for the dapim this recording is actually
*about*. Coverage of a neighbouring daf still gets published -- inside the
by-video file -- so a reader watching this video can follow along through
the lead-in, without that partial coverage ever displacing the neighbour's
own full shiur.
"""

import json
import os
import re
from collections import Counter

REF_PATTERN = re.compile(r'^(?P<tractate>.+?)\s+(?P<daf>\d+)(?P<amud>[ab])$', re.IGNORECASE)
# Same two URL shapes trigger-ocr-job.mjs's own extractYoutubeVideoId accepts.
YOUTUBE_URL_PATTERN = re.compile(
    r'^https?://(?:www\.)?(?:youtube\.com/watch\?(?:.*&)?v=|youtu\.be/)([\w-]{11})')


def youtube_id_from_url(url):
    match = YOUTUBE_URL_PATTERN.match(str(url or '').strip())
    return match.group(1) if match else None


def ref_key(ref, prefix=''):
    """The published filename stem for a ref.

    Must match trigger-ocr-job.mjs's and the frontend's own refKey()
    exactly -- a mismatch here doesn't error, it just silently publishes
    where nothing will ever look.
    """
    return prefix + re.sub(r'\s+', '-', ref.strip())


def key_prefix(variant=None, language=None, voice=False):
    """A 'Chazarah Daf' (shorter gemara-only review) recording and/or a
    Hebrew-language recording are namespaced under their own prefix(es),
    composed in this order, so none of the four variant/language
    combinations collide.

    'Voice-' is the outermost prefix: the voice-recognition engine publishes
    to its own keys entirely, so a caption-OCR sync and a voice sync started
    on the same daf never race to overwrite each other's result (the player
    fetches both and lets the reader pick). That separation applies to the
    by-video files too, or the two engines' alignments for one recording
    would collide there instead.
    """
    return (('Voice-' if voice else '')
            + ('Hebrew-' if language == 'he' else '')
            + ('Chazarah-Daf-' if variant == 'chazarah' else ''))


def primary_daf(refs):
    """Which daf this recording is actually *about*, given every ref it covers.

    Derived from the refs rather than the video's title so it works for a
    Drive upload with no title at all, and can't be thrown off by however a
    channel happens to word one. A shiur covers both amudim of its own daf
    but only the trailing amud of the one before it, so the daf contributing
    the most refs wins; ties break toward the later daf, since a job that
    covers exactly one amud of each is far more likely to be [prev-b, own-a]
    (a shiur opening mid-daf) than the reverse.

    Returns None if no ref parses, in which case the caller should treat
    every ref as primary -- publishing too much is the pre-existing
    behaviour and strictly better than publishing nothing.
    """
    counts = Counter()
    for ref in refs:
        match = REF_PATTERN.match(str(ref).strip())
        if match:
            counts[int(match.group('daf'))] += 1
    if not counts:
        return None
    best = max(counts.values())
    return max(daf for daf, n in counts.items() if n == best)


def split_refs(refs):
    """(refs this recording is about, refs it only passes through).

    The pass-through set is deliberately symmetric: a daf BEFORE the primary
    one (the lead-in review this all started with) and a daf AFTER it (a
    shiur running past its own daf's end) are both context that some other
    recording owns properly.
    """
    daf = primary_daf(refs)
    if daf is None:
        return list(refs), []
    own, context = [], []
    for ref in refs:
        match = REF_PATTERN.match(str(ref).strip())
        (own if match and int(match.group('daf')) == daf else context).append(ref)
    return own, context


def video_key(video_id=None, video_url=None, job_id=None, prefix=''):
    """Stable filename stem for the recording an alignment was measured from.

    Prefer the YouTube id (stable across re-syncs, so re-running a daf
    replaces its alignment instead of accumulating copies). A Drive job has
    no such id, so fall back to a sanitized URL, then to the job id -- which
    at least keeps the file addressable even though a re-sync of the same
    Drive video won't recognise its own earlier output.
    """
    raw = video_id or video_url or job_id or 'unknown'
    return prefix + re.sub(r'[^A-Za-z0-9_-]+', '-', str(raw)).strip('-')[:120]


def publish(alignment, refs, out_dir, job_id=None, variant=None, language=None,
            video_id=None, video_url=None, voice=False):
    """Writes the by-video file and the primary by-ref files. Returns a report."""
    prefix = key_prefix(variant, language, voice)
    own_refs, context_refs = split_refs(refs)
    # A YouTube job passes the watch URL; the id inside it is the stable key
    # (a Drive job has neither, and falls back inside video_key below).
    video_id = video_id or youtube_id_from_url(video_url)

    # Stamped so the frontend's poll loop can tell a freshly published result
    # for THIS job apart from an older file that already existed under the
    # same ref -- without it, polling by path alone reports 'done' the
    # instant it sees any file there, stale or not.
    alignment['jobId'] = job_id
    # Self-describing from here on: an alignment's timestamps are only
    # meaningful against this exact recording, so the reader can now check
    # that rather than assuming whatever video-links happens to point at.
    if video_id:
        alignment['videoId'] = video_id
    if video_url:
        alignment['videoUrl'] = video_url
    alignment['coveredRefs'] = list(refs)
    alignment['primaryRefs'] = own_refs

    written = []
    vkey = video_key(video_id, video_url, job_id, prefix)
    os.makedirs(os.path.join(out_dir, 'by-video'), exist_ok=True)
    video_path = os.path.join(out_dir, 'by-video', f'{vkey}.json')
    with open(video_path, 'w', encoding='utf-8') as f:
        json.dump(alignment, f, ensure_ascii=False, indent=2)
    written.append(f'by-video/{vkey}.json')

    os.makedirs(os.path.join(out_dir, 'by-ref'), exist_ok=True)
    for ref in own_refs:
        key = ref_key(ref, prefix)
        with open(os.path.join(out_dir, 'by-ref', f'{key}.json'), 'w', encoding='utf-8') as f:
            json.dump(alignment, f, ensure_ascii=False, indent=2)
        written.append(f'by-ref/{key}.json')

    return {
        'videoKey': vkey,
        'primaryRefs': own_refs,
        'contextRefs': context_refs,
        'written': written,
    }


def main():
    import argparse
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--alignment', required=True)
    p.add_argument('--refs-json', required=True)
    p.add_argument('--out-dir', required=True)
    p.add_argument('--job-id')
    p.add_argument('--variant')
    p.add_argument('--language')
    p.add_argument('--video-id')
    p.add_argument('--video-url')
    p.add_argument('--voice', action='store_true',
                   help="Publish under the voice engine's own 'Voice-' key namespace.")
    args = p.parse_args()

    with open(args.alignment, encoding='utf-8') as f:
        alignment = json.load(f)
    report = publish(
        alignment, json.loads(args.refs_json), args.out_dir,
        job_id=args.job_id, variant=args.variant, language=args.language,
        video_id=args.video_id, video_url=args.video_url, voice=args.voice,
    )
    for path in report['written']:
        print(f'Published {path}')
    if report['contextRefs']:
        print('Context-only (published inside the by-video file, not given its own '
              f"by-ref entry, so it can't displace that daf's own shiur): {report['contextRefs']}")


if __name__ == '__main__':
    main()
