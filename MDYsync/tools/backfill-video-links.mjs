#!/usr/bin/env node
// Walks a dump of the Mercaz Daf Yomi channel's uploads and writes a
// video-links/<refKey>.json for every daf reference they cover, so the
// player has a playable link ready for a daf long before anyone syncs it.
//
// The hourly youtube-channel-sync Netlify function only ever sees the 15
// most recent uploads (that's all the channel's RSS feed carries), so it
// can keep up with new shiurim but can never fill in the back catalogue.
// This is the one-off counterpart: same parsing (imported, not copied --
// see shared/mdy-channel.mjs), fed from a full `yt-dlp --flat-playlist`
// listing instead of the feed.
//
// Usage:
//   node backfill-video-links.mjs --videos <file> --results <dir> \
//        [--tractate Chullin] [--dry-run]
//
// <file> is one "<videoId>|||<title>" per line, newest upload first.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  buildTalmudLookup,
  parseChannelTitle,
  readingsForVideo,
  refKeyFor,
  refDisplay,
} from '../shared/mdy-channel.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { tractate: 'all', dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--videos') args.videos = argv[++i];
    else if (a === '--results') args.results = argv[++i];
    else if (a === '--tractate') args.tractate = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!args.videos) throw new Error('--videos <file> is required');
  if (!args.results && !args.dryRun) throw new Error('--results <dir> is required unless --dry-run');
  return args;
}

const args = parseArgs(process.argv);
const talmudIndex = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'talmud_index.json'), 'utf8'));
const lookup = buildTalmudLookup(talmudIndex);

const wantTractate = args.tractate.toLowerCase();
const lines = fs.readFileSync(args.videos, 'utf8').split('\n').filter((l) => l.trim());

// A daf's own shiur covers it in full, while the *next* daf's shiur only
// opens on its tail -- so when both are candidates for the same reference,
// the one whose own daf number matches wins regardless of which is newer.
// (Ties then go to the newer upload, which is the re-edited/corrected cut
// when the channel posts one.) Without this the newest-first scan order
// would systematically link every amud b to the following daf's video,
// where it's barely covered.
const PRIMARY = 0;
const TAIL = 1;

const best = new Map(); // refKey -> { rank, position, videoId, title, readings, reading }
const unmatched = [];
let considered = 0;

lines.forEach((line, position) => {
  const sep = line.indexOf('|||');
  if (sep < 0) return;
  const videoId = line.slice(0, sep).trim();
  const title = line.slice(sep + 3).trim();
  if (!videoId || !title) return;

  const parsed = parseChannelTitle(title, lookup);
  if (!parsed) {
    unmatched.push({ videoId, title });
    return;
  }
  if (wantTractate !== 'all' && parsed.tractate.toLowerCase() !== wantTractate) return;
  considered++;

  for (const reading of readingsForVideo(parsed, lookup)) {
    const key = refKeyFor(reading);
    const rank = reading.daf === parsed.daf ? PRIMARY : TAIL;
    const prev = best.get(key);
    if (prev && (prev.rank < rank || (prev.rank === rank && prev.position < position))) continue;
    best.set(key, {
      rank, position, videoId, title, reading,
      coveredRefs: readingsForVideo(parsed, lookup).map((r) => `${r.tractate} ${r.daf}${r.amud}`),
    });
  }
});

const written = [];
const kept = [];
const enriched = [];
for (const [key, pick] of [...best.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const target = args.results ? path.join(args.results, 'video-links', `${key}.json`) : null;
  // Never repoint an existing link: it's either a reader's own hand-pasted
  // correction or something the hourly job already published, and neither
  // should be clobbered by a bulk backfill.
  //
  // The one exception is purely additive. Links published before coveredRefs
  // existed can't drive a one-click sync, and skipping them outright would
  // leave that permanently broken on precisely the dapim already in use. So
  // when the stored video is the same one this scan picked, its covered refs
  // are filled in and nothing else is touched. A file pointing somewhere
  // else is a deliberate correction and is left completely alone.
  if (target && fs.existsSync(target)) {
    try {
      const existing = JSON.parse(fs.readFileSync(target, 'utf8'));
      if (existing.videoId === pick.videoId && !Array.isArray(existing.coveredRefs)) {
        existing.coveredRefs = pick.coveredRefs;
        if (!args.dryRun) fs.writeFileSync(target, `${JSON.stringify(existing, null, 2)}\n`);
        enriched.push(key);
        continue;
      }
    } catch {
      // Unreadable/corrupt existing file: leave it be and report it as kept
      // rather than silently replacing something we couldn't inspect.
    }
    kept.push(key);
    continue;
  }
  const payload = {
    label: pick.title.slice(0, 40),
    type: 'youtube',
    url: `https://www.youtube.com/watch?v=${pick.videoId}`,
    videoId: pick.videoId,
    coveredRefs: pick.coveredRefs,
  };
  if (!args.dryRun) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`);
  }
  written.push({ key, ref: refDisplay(pick.reading), videoId: pick.videoId, rank: pick.rank });
}

console.log(`Scanned ${lines.length} channel videos; ${considered} matched `
  + `${wantTractate === 'all' ? 'a known tractate' : args.tractate}.`);
console.log(`${written.length} link(s) ${args.dryRun ? 'would be written' : 'written'}, `
  + `${enriched.length} existing link(s) ${args.dryRun ? 'would gain' : 'gained'} covered refs, `
  + `${kept.length} left alone.`);

for (const w of written.slice(0, 40)) {
  console.log(`  + ${w.key}${w.rank === TAIL ? '  (tail coverage only)' : ''}  <- ${w.videoId}`);
}
if (written.length > 40) console.log(`  ... and ${written.length - 40} more`);

// Surfaced rather than swallowed: a title the patterns don't recognize is a
// video silently absent from the site, and the only way anyone finds out is
// if it's reported here. The known offender is the Hebrew "unedited" cut,
// whose title drops the dash separator the pattern anchors on.
if (unmatched.length) {
  console.log(`\n${unmatched.length} video(s) did not match any known title pattern `
    + `and were skipped (showing up to 25):`);
  for (const u of unmatched.slice(0, 25)) console.log(`  ? ${u.videoId}  ${u.title}`);
}
