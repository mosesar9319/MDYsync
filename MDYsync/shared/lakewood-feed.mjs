// Lakewood Daf Yomi's own copies of R' Sruly Bornstein's shiurim.
//
// Lakewood Daf Yomi publish every daf's shiur as an mp3 on their own server,
// through the podcast feed their app reads (FEED_URL): one item per daf, titled
// the way the YouTube videos are ("Bechoros 58", "Eruchin 2"), with the file on
// their storage. The feed holds about the last 250 shiurim. The file is the same
// recording as the YouTube video (Bechoros 58: 3814.27 s against 3814.2 s), so a
// sync timed against either lines up with both.
//
// Used by the voice sync job (tools/lakewood-audio.mjs) and by the player, through
// netlify/functions/lakewood-audio.mjs (the browser cannot read the feed itself).
// Deliberately dependency-free.

import { parseBornsteinTitle } from './maggidim.mjs';

export const FEED_URL = 'https://app.daf-yomi.net/podcasts/DafYomi.xml';

// R' Bornstein's shiurim are identified on DafSync by Lakewood Daf Yomi's own
// episode number, the number in the mp3's name ("Bechoros 58_213147286.mp3"):
// "L" and the number, ten digits -- "L0213147286". It sits where a recording's
// id goes everywhere else (video-links, catalog.json, by-video/, test-runs/), so
// it is 11 characters like every other; it is never a YouTube id and nothing
// ever sends it to YouTube.
export const LAKEWOOD_ID = /^L\d{10}$/;

// His shiurim are voice-synced automatically from Eruchin 2 on (published
// 19 Nov 2026), as they come out (tools/lakewood-sync.mjs); the ones before it
// are on DafSync to listen to, without a sync.
export const SYNC_FROM_PUBLISHED = '2026-11-19T04:47:41.000Z';
export function isLakewoodId(id) {
  return LAKEWOOD_ID.test(String(id || ''));
}
// Their file store's own address for an mp3 the feed links to (the feed's link
// redirects there under the same file name), for a service that will not follow
// a redirect.
export function lakewoodDirectUrl(mp3Url) {
  const file = String(mp3Url || '').split('?')[0].split('/').pop();
  return file ? `https://lkwd-daf-yomi.nyc3.cdn.digitaloceanspaces.com/aud/d/${file}` : null;
}

export function lakewoodEpisodeId(mp3Url) {
  const file = decodeURIComponent(String(mp3Url || '').split('?')[0].split('/').pop() || '');
  const match = /_(\d{1,10})\.mp3$/i.exec(file);
  return match ? `L${match[1].padStart(10, '0')}` : null;
}
// The feed's own picture, shown for a shiur in place of a video's thumbnail.
export const ARTWORK_URL = 'https://app.daf-yomi.net/images/daf-podcast-2.jpeg';

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
  return raw.split(':').map(Number).reduce((total, n) => total * 60 + n, 0);
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

// The feed item for a daf ({ tractate: 'Bekhorot', daf: 58 }, the tractate as
// talmud_index.json names it), or null. The newest (first listed) wins.
export function itemForDaf(items, lookup, { tractate, daf }) {
  for (const item of items) {
    const parsed = parseBornsteinTitle(item.title, lookup);
    if (parsed && parsed.tractate === tractate && parsed.daf === Number(daf)) return item;
  }
  return null;
}

const READING = /^\s*([A-Za-z][A-Za-z' ]*?)\s+(\d{1,3})[ab]\b/;

// The daf most of a job's readings are on ("Bekhorot 57b", "Bekhorot 58a",
// "Bekhorot 58b", "Bekhorot 59a" -> Bekhorot 58), as { tractate, daf } or null.
export function dafOfReadings(refs, lookup) {
  const counts = new Map();
  let tractate = null;
  for (const ref of Array.isArray(refs) ? refs : []) {
    const match = READING.exec(String(ref || ''));
    const entry = match && lookup.byName.get(match[1].toLowerCase());
    if (!entry) continue;
    tractate = tractate || entry.name;
    if (entry.name !== tractate) continue;
    const daf = Number(match[2]);
    counts.set(daf, (counts.get(daf) || 0) + 1);
  }
  let best = null;
  for (const [daf, count] of counts) {
    if (best === null || count > counts.get(best)) best = daf;
  }
  return best === null ? null : { tractate, daf: best };
}

export function itemForReadings(items, lookup, refs) {
  const found = dafOfReadings(refs, lookup);
  return found ? itemForDaf(items, lookup, found) : null;
}
