#!/usr/bin/env node
// Makes a video a TEST SHIUR in a checkout of the `results` branch: a
// video-links/<refKey>.json for each daf it covers, marked testShiur (the player
// offers its numbered test runs) and locked (no channel sync ever swaps it for
// another upload). Afterwards run tools/build-video-catalog.mjs on the same
// checkout so catalog.json lists it.
//
//   node register.mjs --results /path/to/results-checkout --video-id TWCiP96dKXU \
//        --refs "Bekhorot 58a,Bekhorot 58b" [--maggid bornstein] [--label "Bechoros 58"]
//
// A daf that already has a DIFFERENT video linked under the same key is left
// alone (and reported): replacing somebody's link is not this tool's call.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { refKeyFor } from '../../shared/mdy-channel.mjs';
import { maggidById } from '../../shared/maggidim.mjs';

const REF = /^(.+) (\d+)([ab])$/;

export function parseRefs(value) {
  return String(value || '').split(',').map((r) => r.trim()).filter(Boolean).map((ref) => {
    const m = REF.exec(ref);
    if (!m) throw new Error(`Not a daf reference: "${ref}" (expected like "Bekhorot 58a").`);
    return { ref, tractate: m[1], daf: Number(m[2]), amud: m[3] };
  });
}

// Returns { written: [keys], kept: [{ key, videoId }] }.
export function registerTestShiur({ resultsDir, videoId, refs, maggid = '', label = '' }) {
  if (!/^[\w-]{11}$/.test(String(videoId || ''))) throw new Error(`Not a YouTube video id: "${videoId}".`);
  if (maggid && !maggidById(maggid)) throw new Error(`Unknown maggid "${maggid}".`);
  const readings = parseRefs(refs);
  if (!readings.length) throw new Error('No dapim given.');
  const linksDir = path.join(resultsDir, 'video-links');
  fs.mkdirSync(linksDir, { recursive: true });
  const written = [];
  const kept = [];
  for (const reading of readings) {
    const key = refKeyFor({ ...reading, variant: 'regular', language: 'en', maggid });
    const file = path.join(linksDir, `${key}.json`);
    let existing = null;
    try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none yet */ }
    if (existing?.videoId && existing.videoId !== videoId) {
      kept.push({ key, videoId: existing.videoId });
      continue;
    }
    const link = {
      ...(existing || {}),
      type: 'youtube',
      url: `https://www.youtube.com/watch?v=${videoId}`,
      videoId,
      label: String(label || existing?.label || `${reading.tractate} ${reading.daf}`).slice(0, 100),
      coveredRefs: readings.map((r) => r.ref),
      source: existing?.source || 'manual',
      ...(maggid ? { maggid } : {}),
      testShiur: true,
      locked: true,
    };
    fs.writeFileSync(file, `${JSON.stringify(link, null, 2)}\n`);
    written.push(key);
  }
  return { written, kept };
}

async function videoTitle(videoId) {
  try {
    const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`;
    const response = await fetch(url);
    if (!response.ok) return '';
    return String((await response.json()).title || '');
  } catch { return ''; }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const name = argv[i];
    if (!name.startsWith('--')) throw new Error(`Unknown argument: ${name}`);
    args[name.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[i + 1];
    i += 1;
  }
  return args;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv);
  if (!args.results || !args.videoId || !args.refs) {
    console.error('Usage: node register.mjs --results <dir> --video-id <id> --refs "Bekhorot 58a,Bekhorot 58b" [--maggid bornstein] [--label "..."]');
    process.exit(2);
  }
  const label = args.label || await videoTitle(args.videoId);
  const { written, kept } = registerTestShiur({
    resultsDir: args.results, videoId: args.videoId, refs: args.refs, maggid: args.maggid || '', label,
  });
  for (const key of written) console.log(`Test shiur link: video-links/${key}.json -> ${args.videoId}`);
  for (const { key, videoId } of kept) console.log(`Left alone: video-links/${key}.json already links ${videoId}.`);
}
