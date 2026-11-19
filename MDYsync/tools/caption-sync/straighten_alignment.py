#!/usr/bin/env python3
"""Puts voice syncs published before November 2026 on one straight path.

Until then the voice engine placed every saying of a phrase: the reading, the
maggid saying it again as he explained it, his quoting it ten minutes later. So
a daf word could stand at several moments, the highlight stepped back to follow
each repeat, and a tap on a word went to whichever saying was nearest. The
engine now gives each word one moment, the first time it is read in the order
of the page (path_align.py, "One straight path").

This does the same to a sync already published, from the sync itself -- no
audio, no transcript, no ElevenLabs credit: of everything it placed, the most
daf words that lie on one path that never steps back are kept (path_align.
straight_chain; of two ways to keep as many, the earlier), and the segments are
made again from those. A shiur whose transcripts were kept is better placed
again by realign.yml, which also finds the Gemara's quote of its Mishnah on the
Gemara's own line; this is for the ones that were not.

    python3 straighten_alignment.py --results <results checkout> [--video-id L0213147286]

Goes over by-ref/Voice-*.json, by-video/Voice-*.json and the regular engine's
test runs (test-runs/<video id>/regular-*.json, with their index.json), leaves
alone anything already straight or not made by voice_align.py, and prints what
it changed. Needs what the voice job installs, and Sefaria for the daf's text.
"""
import argparse
import dataclasses
import glob
import json
import os
import sys

import path_align
from caption_ocr_align import WordEvent, build_outputs, load_canonical


def refs_of(alignment):
    """The amudim an alignment covers, in order."""
    refs = alignment.get('coveredRefs')
    if refs:
        return [str(r).replace('.', ' ') for r in refs]
    seen = []
    for segment in alignment.get('segments') or []:
        amud = str(segment.get('ref', '')).rsplit(':', 1)[0].rsplit('.', 1)[0]
        if amud and amud not in seen:
            seen.append(amud)
    return seen


def needs_straightening(alignment):
    if not isinstance(alignment, dict) or alignment.get('generator') != 'voice_align.py':
        return False
    if (alignment.get('matchStats') or {}).get('straightPath'):
        return False
    return bool(alignment.get('wordTimeline'))


def timeline_events(alignment, canon):
    """A sync's placements as the engine's own events, from its wordTimeline."""
    index = {(c.ref, c.word_index): n for n, c in enumerate(canon)}
    events = []
    for entry in alignment.get('wordTimeline') or []:
        first = index.get((entry.get('ref'), entry.get('w0')))
        last = index.get((entry.get('ref'), entry.get('w1')))
        if first is None or last is None or last < first:
            continue
        events.append(WordEvent(float(entry['start']), first, last, 0.0, entry.get('heardText') or '',
                                entry.get('source') or ''))
    return events


def recount(alignment, canon, events, primary_refs=None):
    """The path aligner's counts in matchStats, made from the events a sync now
    holds. The daf a shiur is measured against is its own (primaryRefs, which
    publish_alignment.py stamps on a published sync; a test run has none, so
    primary_refs passes its shiur's). Returns whether anything changed."""
    stats = alignment.setdefault('matchStats', {})
    if stats.get('aligner') != 'path':
        return False
    before = {key: stats.get(key) for key in COUNTS}
    placed = {i for e in events for i in range(e.start_idx, e.end_idx + 1)}
    own_refs = {str(r).replace('.', ' ') for r in alignment.get('primaryRefs') or primary_refs or []}
    primary = [i for i, c in enumerate(canon) if c.ref.rsplit(':', 1)[0] in own_refs] if own_refs else None
    if primary is not None and len(primary) in (0, len(canon)):
        primary = None
    counted = path_align.counted_words(canon, primary, placed)
    bridged = {i for e in events if e.source == path_align.SOURCE_BRIDGE for i in range(e.start_idx, e.end_idx + 1)}
    stats.update({
        'totalWords': len(counted), 'matchedWords': len(placed & counted),
        'unmatchedWords': len(counted - placed), 'dafWords': len(counted),
        'dafWordsHeard': len((placed - bridged) & counted), 'dafWordsBridged': len(bridged & counted),
    })
    return before != {key: stats.get(key) for key in COUNTS}


COUNTS = ('totalWords', 'matchedWords', 'unmatchedWords', 'dafWords', 'dafWordsHeard', 'dafWordsBridged')


def straighten(alignment, cache_dir=None, load=load_canonical, primary_refs=None):
    """alignment on one straight path, in place. Returns a short account of what
    changed ({placementsBefore, placementsAfter, wordsBefore, wordsAfter}), or
    None when there was nothing to do.

    A sync straightened before its shiur's own daf was known (a test run, counted
    against the neighbouring amudim too) is counted again, and nothing else of
    it is touched."""
    if not needs_straightening(alignment):
        stats = alignment.get('matchStats') if isinstance(alignment, dict) else None
        if (not isinstance(stats, dict) or not stats.get('straightened') or alignment.get('primaryRefs')
                or not primary_refs or alignment.get('generator') != 'voice_align.py'):
            return None
        canon, _ = load(refs_of(alignment), cache_dir)
        if not recount(alignment, canon, timeline_events(alignment, canon), primary_refs):
            return None
        return dict(stats['straightened'], recounted=True)
    refs = refs_of(alignment)
    canon, segments = load(refs, cache_dir)
    events = timeline_events(alignment, canon)
    if not events:
        return None
    before = {i for e in events for i in range(e.start_idx, e.end_idx + 1)}
    kept = path_align.straight_chain(
        events, lambda e: e.t, lambda e: (e.start_idx, e.end_idx),
        lambda e, first: dataclasses.replace(e, start_idx=first))
    after = {i for e in kept for i in range(e.start_idx, e.end_idx + 1)}

    source = alignment.get('videoSource') or {}
    made, _ = build_outputs(canon, segments, kept, float(alignment.get('duration') or 0.0),
                            source.get('url') or 'job-audio.mp3', refs,
                            generator='voice_align.py', title_prefix='Voice recognition alignment', straight=True)
    alignment['segments'] = made['segments']
    alignment['wordTimeline'] = made['wordTimeline']

    stats = alignment.setdefault('matchStats', {})
    recount(alignment, canon, kept, primary_refs)
    if stats.get('aligner') == 'path':
        by_source = {}
        for e in kept:
            label = (stats.get('bySource') or {}).get(e.source, {}).get('label') \
                or path_align.PATH_SOURCE_LABELS.get(e.source, e.source)
            bucket = by_source.setdefault(e.source, {'label': label, 'runs': 0, 'words': 0})
            bucket['runs'] += 1
            bucket['words'] += e.end_idx - e.start_idx + 1
        stats['bySource'] = by_source
    stats['straightPath'] = True
    change = {'placementsBefore': len(events), 'placementsAfter': len(kept),
              'wordsBefore': len(before), 'wordsAfter': len(after)}
    # Kept in the file: this sync was straightened after the fact, not placed so.
    stats['straightened'] = change
    return change


def straighten_results(results_dir, video_id=None, cache_dir=None, log=print):
    """Every voice sync under results_dir (or only video_id's). Returns the paths
    it changed, relative to results_dir."""
    patterns = ['by-ref/Voice-*.json', 'by-video/Voice-*.json', 'test-runs/*/regular-*.json']
    changed = []
    touched_runs = {}
    # A test run does not say which daf is its shiur's own; the published sync of
    # the same recording does (by-ref and by-video come first).
    own_daf = {}
    for pattern in patterns:
        for path in sorted(glob.glob(os.path.join(results_dir, pattern))):
            try:
                with open(path, encoding='utf-8') as f:
                    alignment = json.load(f)
            except (OSError, ValueError):
                continue
            if not isinstance(alignment, dict) or (video_id and alignment.get('videoId') != video_id):
                continue
            recording = alignment.get('videoId') or os.path.basename(os.path.dirname(path))
            if alignment.get('primaryRefs'):
                own_daf.setdefault(recording, alignment['primaryRefs'])
            try:
                change = straighten(alignment, cache_dir, primary_refs=own_daf.get(recording))
            except Exception as error:  # noqa: BLE001 -- one bad file does not stop the rest
                log(f'Could not straighten {os.path.relpath(path, results_dir)}: {error}')
                continue
            if not change:
                continue
            with open(path, 'w', encoding='utf-8') as f:
                json.dump(alignment, f, ensure_ascii=False, indent=2)
            relative = os.path.relpath(path, results_dir)
            changed.append(relative)
            if change.get('recounted'):
                stats = alignment['matchStats']
                log(f"{relative}: counted again, {stats.get('matchedWords')} of {stats.get('totalWords')} daf words")
            else:
                log(f"{relative}: {change['placementsBefore']} placements -> {change['placementsAfter']}, "
                    f"{change['wordsBefore']} daf words -> {change['wordsAfter']}")
            if relative.startswith('test-runs' + os.sep):
                touched_runs.setdefault(os.path.dirname(path), {})[os.path.basename(path)] = alignment
    # The numbers each run is listed with (and chosen by) follow the file.
    if touched_runs:
        from test_runs import summarize
        for folder, runs in touched_runs.items():
            index_path = os.path.join(folder, 'index.json')
            try:
                with open(index_path, encoding='utf-8') as f:
                    index = json.load(f)
            except (OSError, ValueError):
                continue
            for entry in index.get('runs') or []:
                if entry.get('file') in runs:
                    entry['summary'] = summarize(runs[entry['file']])
            with open(index_path, 'w', encoding='utf-8') as f:
                json.dump(index, f, ensure_ascii=False, indent=2)
                f.write('\n')
            changed.append(os.path.relpath(index_path, results_dir))
    return changed


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--results', required=True, help='A checkout of the results branch.')
    p.add_argument('--video-id', help="Only this recording's syncs.")
    p.add_argument('--cache-dir', default='straighten-cache', help="Where the daf's text is kept between files.")
    args = p.parse_args(argv)
    os.makedirs(args.cache_dir, exist_ok=True)
    changed = straighten_results(args.results, args.video_id, args.cache_dir)
    print(f'Straightened {len(changed)} file(s).')
    return 0


if __name__ == '__main__':
    sys.exit(main())
