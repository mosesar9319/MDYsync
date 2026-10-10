#!/usr/bin/env node
// Links a followed maggid's whole back catalogue (everything their channel has
// uploaded, not just the 15 newest that the hourly channel sync can see) into a
// checkout of the `results` branch: one video-links/<refKey>.json per daf video
// and maggidim/<id>.json, a plain list of everything the channel has posted
// (derashos and topical shiurim included, which have no daf to be linked to).
// Afterwards run tools/build-video-catalog.mjs on the same checkout to rebuild
// catalog.json.
//
// The video list comes from yt-dlp, which can page through a whole channel:
//
//   yt-dlp --flat-playlist -J "https://www.youtube.com/channel/<channelId>/videos" \
//     | node -e 'const d=JSON.parse(require("fs").readFileSync(0));
//         console.log(JSON.stringify(d.entries.map(e=>({id:e.id,title:e.title}))))' > videos.json
//   node backfill-maggid-videos.mjs --maggid bernstein --videos videos.json \
//        --talmud-index ../talmud_index.json --results /path/to/results-checkout \
//        [--test-video Zsy7oDUP6Pw]
//
// --test-video marks a video as a test shiur (the voice models are tuned on it,
// and the player offers its numbered test runs): its links carry testShiur and
// are locked, so the hourly sync never swaps it for a re-upload.
//
// Existing links are left alone unless they are this maggid's own channel-auto
// ones pointing at a different video of the same daf (kept as the first seen,
// i.e. the newest in yt-dlp's order, so the channel's re-uploads win).

import fs from 'node:fs';
import path from 'node:path';
import { buildTalmudLookup, amudimForDaf, refKeyFor, plainRef } from '../shared/mdy-channel.mjs';
import { maggidById, parseBernsteinTitle } from '../shared/maggidim.mjs';

const TITLE_PARSERS = { bernstein: parseBernsteinTitle };

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`Unexpected argument ${a}`);
    args[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
  }
  for (const required of ['maggid', 'videos', 'talmudIndex', 'results']) {
    if (!args[required]) throw new Error(`--${required.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`);
  }
  return args;
}

export function backfill({ maggidId, videos, lookup, resultsDir, testVideoId = null, log = console.log }) {
  const maggid = maggidById(maggidId);
  if (!maggid || !maggid.keyPrefix) throw new Error(`"${maggidId}" is not a followed maggid with its own key prefix`);
  const parseTitle = TITLE_PARSERS[maggid.id];
  if (!parseTitle) throw new Error(`No title parser for ${maggid.id}`);
  const linksDir = path.join(resultsDir, 'video-links');
  fs.mkdirSync(linksDir, { recursive: true });

  const claimed = new Set(); // refKeys written by this run: the first (newest) video of a daf wins
  const list = [];
  let linked = 0;
  let kept = 0;
  for (const video of videos) {
    const parsed = parseTitle(video.title, lookup);
    list.push({
      videoId: video.id,
      title: String(video.title || '').slice(0, 120),
      published: video.published || null,
      ...(parsed ? { tractate: parsed.tractate, daf: parsed.daf } : {}),
    });
    if (!parsed) continue;
    const entry = lookup.byName.get(parsed.tractate.toLowerCase());
    const readings = amudimForDaf(entry, parsed.daf)
      .map((amud) => ({ tractate: parsed.tractate, daf: parsed.daf, amud, variant: parsed.variant, language: parsed.language, maggid: maggid.id }));
    const isTest = video.id === testVideoId;
    const source = {
      type: 'youtube',
      url: `https://www.youtube.com/watch?v=${video.id}`,
      videoId: video.id,
      label: String(video.title).slice(0, 100),
      coveredRefs: readings.map((r) => plainRef(r)),
      source: 'channel-auto',
      maggid: maggid.id,
      ...(isTest ? { testShiur: true, locked: true } : {}),
    };
    for (const reading of readings) {
      const key = refKeyFor(reading);
      const file = path.join(linksDir, `${key}.json`);
      if (claimed.has(key) && !isTest) { kept += 1; continue; }
      if (fs.existsSync(file) && !claimed.has(key) && !isTest) {
        let existing = null;
        try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* replaced below */ }
        if (existing?.locked || (existing && existing.source !== 'channel-auto')) { kept += 1; claimed.add(key); continue; }
      }
      fs.writeFileSync(file, `${JSON.stringify(source)}\n`);
      claimed.add(key);
      linked += 1;
    }
  }

  const listDir = path.join(resultsDir, 'maggidim');
  fs.mkdirSync(listDir, { recursive: true });
  fs.writeFileSync(path.join(listDir, `${maggid.id}.json`), `${JSON.stringify({
    maggid: maggid.id,
    channelId: maggid.channelId,
    generatedAt: new Date().toISOString(),
    videos: list,
  }, null, 2)}\n`);
  log(`${maggid.name}: ${videos.length} videos, ${list.filter((v) => v.daf).length} titled as a daf; wrote ${linked} link file(s), kept ${kept}.`);
  return { linked, kept, listed: list.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const args = parseArgs(process.argv);
  const lookup = buildTalmudLookup(JSON.parse(fs.readFileSync(args.talmudIndex, 'utf8')));
  backfill({
    maggidId: args.maggid,
    videos: JSON.parse(fs.readFileSync(args.videos, 'utf8')),
    lookup,
    resultsDir: args.results,
    testVideoId: args.testVideo || null,
  });
}
