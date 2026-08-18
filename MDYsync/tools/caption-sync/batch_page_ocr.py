#!/usr/bin/env python3
"""Pre-generates results/pages/<key>.json for a whole range of dapim in one
run, instead of the one-page-at-a-time on-demand path (trigger-page-ocr-
job.mjs -> page-ocr-job.yml, still used as the fallback for any daf this
hasn't covered yet).

Two things this makes possible that the on-demand path can't:
  1. Normal page-load speed: a page map only ever existing "maybe, if
     someone already viewed this daf and triggered the job" means every
     first-ever viewer of a daf waits on a fresh OCR job. Pre-generating a
     whole tractate removes that wait for anything already covered.
  2. The camera-scan feature (see scan-daf-page.mjs): it can only ever
     recognize a daf it already has word-position data for, and needs that
     lookup to be instant (no per-scan OCR job), so its whole premise
     depends on this cache being populated ahead of time, not on demand.

Deliberately does NOT take a hardcoded "this tractate has N dapim" table --
that's exactly the kind of fact worth confirming from the real page fetch
rather than typing a number in from memory (see
shared/daf-header-vocabulary.mjs's own comment on the same judgment call).
Instead this just tries every daf in [--daf-start, --daf-end] and treats a
fetch failure as "past the end of this tractate" once a few happen in a
row -- cheap to confirm wrong (the next run just covers less than hoped),
expensive to get uncritically wrong the other way (silently never
generating dapim that exist because a hardcoded count was off by one).
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from page_ocr_align import process_page  # noqa: E402

# A real fetch failure (a 404 past the tractate's last daf, or a transient
# network error) shouldn't be indistinguishable from "this whole run is
# broken" -- but enough of them *in a row* means the range has genuinely
# run past the end of the tractate, so stop trying rather than burning the
# rest of the job's time budget on dapim that don't exist.
CONSECUTIVE_FAILURE_LIMIT = 4

# The current schema page_ocr_align.py's process_page writes -- keep this in
# sync with its own 'schema' value. Anything older (or missing/unreadable)
# gets regenerated automatically on the next batch run, so a schema change
# (like v1 -> v2's new textBlock field) rolls out just by re-running the
# same workflow that originally built the cache, no separate --force flag
# or manual deletion needed.
CURRENT_SCHEMA = 'dafsync-pagemap-v2'


def needs_regeneration(out_path):
    """True if this page map is missing, corrupt, on an old schema, or --
    same idea, just for the OCR engine rather than the JSON shape -- still
    on Tesseract from before Google Vision became available (see
    page_ocr_align.py's own engine auto-pick). A page already on
    google-vision is left alone; anything else is worth regenerating the
    same way an old schema already was, no separate --force flag needed
    here either.
    """
    try:
        with open(out_path, encoding='utf-8') as f:
            data = json.load(f)
    except (OSError, ValueError):
        return True  # unreadable/corrupt -- safest to just regenerate it
    return data.get('schema') != CURRENT_SCHEMA or data.get('engine') != 'google-vision'


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--tractate', required=True)
    p.add_argument('--daf-start', type=int, default=2)
    p.add_argument('--daf-end', type=int, default=180)
    p.add_argument('--amud', choices=['a', 'b', 'both'], default='both')
    p.add_argument('--results-dir', required=True,
                    help='Path to a checked-out results-branch worktree; existing pages/<key>.json files there are skipped.')
    p.add_argument('--work-dir', default='batch-page-out')
    args = p.parse_args()

    pages_dir = os.path.join(args.results_dir, 'pages')
    os.makedirs(pages_dir, exist_ok=True)
    cache_dir = os.path.join(args.work_dir, 'cache')
    os.makedirs(cache_dir, exist_ok=True)

    amuds = ['a', 'b'] if args.amud == 'both' else [args.amud]

    written, skipped, failed = 0, 0, 0
    consecutive_failures = 0
    for daf in range(args.daf_start, args.daf_end + 1):
        if consecutive_failures >= CONSECUTIVE_FAILURE_LIMIT:
            print(f'{consecutive_failures} consecutive failures -- assuming {args.tractate} '
                  f'ends before daf {daf}, stopping here.')
            break
        daf_had_any_success = False
        for amud in amuds:
            key = f"{args.tractate.replace(' ', '-')}-{daf}{amud}"
            out_path = os.path.join(pages_dir, f'{key}.json')
            if os.path.exists(out_path) and not needs_regeneration(out_path):
                print(f'{key}: already have a current page map, skipping.')
                skipped += 1
                daf_had_any_success = True  # a prior run already confirmed this daf exists
                continue
            try:
                page_out_dir = os.path.join(args.work_dir, key)
                result = process_page(
                    args.tractate, daf, amud, page_out_dir, cache_dir=cache_dir,
                    google_vision_api_key=os.environ.get('GOOGLE_VISION_API_KEY'),
                    google_vision_credentials_json=os.environ.get('GOOGLE_VISION_CREDENTIALS_JSON'),
                )
                with open(out_path, 'w', encoding='utf-8') as f:
                    json.dump(result, f, ensure_ascii=False)
                covered = len(result['wordBoxes'])
                print(f'{key}: wrote page map ({covered} words aligned).')
                written += 1
                daf_had_any_success = True
            except Exception as error:
                print(f'{key}: failed ({error}).')
                failed += 1
        consecutive_failures = 0 if daf_had_any_success else consecutive_failures + 1

    print(f'\nDone. {written} written, {skipped} already present, {failed} failed.')


if __name__ == '__main__':
    main()
