#!/usr/bin/env node
// The address of Lakewood Daf Yomi's own mp3 of R' Sruly Bornstein's shiur on a
// daf, for a voice-sync job -- so the job never downloads his shiurim from YouTube.
//
// Lakewood Daf Yomi publish every daf's shiur as an mp3 on their own server,
// through the podcast feed their app reads (FEED_URL): one item per daf, titled
// the way the YouTube videos are ("Bechoros 58", "Eruchin 2"), with the file
// itself on their storage. The feed holds about the last 250 shiurim.
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
import { parseBornsteinTitle } from '../shared/maggidim.mjs';
import { dafOfReadings } from './mdy-audio.mjs';

export const FEED_URL = 'https://app.daf-yomi.net/podcasts/DafYomi.xml';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function decode(text) {
  return String(text || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

// "1:03:34" / "48:14" / "3814" -> seconds, or null.
export function durationSeconds(text) {
  const raw = String(text || '').trim();
  if (!/^\d+(:\d{1,2}){0,2}$/.test(raw)) return null;
  const parts = raw.split(':').map(Number);
  return parts.reduce((total, n) => total * 60 + n, 0);
}

// The feed's items as { title, url, seconds, published }.
export function feedItems(xml) {
  const items = [];
  for (const [, body] of String(xml || '').matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g)) {
    const title = decode((/<title>([\s\S]*?)<\/title>/.exec(body) || [])[1]);
    const url = decode((/<enclosure\b[^>]*\burl="([^"]+)"/.exec(body) || [])[1]);
    const seconds = durationSeconds(decode((/<itunes:duration>([\s\S]*?)<\/itunes:duration>/.exec(body) || [])[1]));
    const published = decode((/<pubDate>([\s\S]*?)<\/pubDate>/.exec(body) || [])[1]);
    if (title && url) items.push({ title, url, seconds, published });
  }
  return items;
}

// The feed item for a daf ({ tractate: 'Bekhorot', daf: 58 }), or null. When the
// feed has the daf more than once, the newest (the first listed) is used.
export function itemForDaf(items, lookup, { tractate, daf }) {
  for (const item of items) {
    const parsed = parseBornsteinTitle(item.title, lookup);
    if (parsed && parsed.tractate === tractate && parsed.daf === daf) return item;
  }
  return null;
}

// The tractate's name as talmud_index.json spells it, from a reading's ref.
function tractateOfReadings(refs, lookup) {
  for (const ref of Array.isArray(refs) ? refs : []) {
    const match = /^\s*([A-Za-z][A-Za-z' ]*?)\s+\d{1,3}[ab]\b/.exec(String(ref || ''));
    const entry = match && lookup.byName.get(match[1].toLowerCase());
    if (entry) return entry.name;
  }
  return null;
}

export function itemForReadings(items, lookup, refs) {
  const tractate = tractateOfReadings(refs, lookup);
  const found = dafOfReadings(refs);
  if (!tractate || !found) return null;
  return itemForDaf(items, lookup, { tractate, daf: found.daf });
}

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
