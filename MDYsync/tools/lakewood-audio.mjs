#!/usr/bin/env node
// The address of Lakewood Daf Yomi's own mp3 of R' Sruly Bornstein's shiur on a
// daf, for a voice-sync job -- so the job never downloads his shiurim from YouTube.
// The feed itself is read by shared/lakewood-feed.mjs.
//
//   node tools/lakewood-audio.mjs --refs '["Bekhorot 57b","Bekhorot 58a","Bekhorot 58b","Bekhorot 59a"]'
//
// Prints "<mp3 address> <length in seconds>" for the daf most of the readings are
// on, or nothing (exit 0) when the feed has no shiur on that daf.
// --feed <file> reads a saved copy of the feed instead. Dependency-free.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTalmudLookup } from '../shared/mdy-channel.mjs';
import { FEED_URL, feedItems, itemForReadings } from '../shared/lakewood-feed.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const refs = JSON.parse(arg('--refs') || '[]');
  const lookup = buildTalmudLookup(JSON.parse(fs.readFileSync(path.join(HERE, '..', 'talmud_index.json'), 'utf8')));
  let xml;
  if (arg('--feed')) {
    xml = fs.readFileSync(arg('--feed'), 'utf8');
  } else {
    const response = await fetch(FEED_URL, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) {
      console.error(`Lakewood Daf Yomi's feed answered ${response.status}.`);
      return;
    }
    xml = await response.text();
  }
  const item = itemForReadings(feedItems(xml), lookup, refs);
  if (item) console.log(`${item.url} ${item.seconds ?? ''}`.trim());
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
  });
}
