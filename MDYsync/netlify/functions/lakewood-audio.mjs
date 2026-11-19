// GET /api/lakewood-audio?tractate=Bekhorot&daf=58
//
// R' Sruly Bornstein's shiur on a daf, from Lakewood Daf Yomi's own server: the
// player plays this mp3 instead of the YouTube video (his shiurim never come from
// YouTube). The address has a number in it that only their podcast feed knows
// ("Bechoros 58_213147286.mp3"), and a browser cannot read their feed itself, so
// this reads it (shared/lakewood-feed.mjs) and answers
//   { url, seconds, title, artwork }
// or 404 { error } when the feed has no shiur on that daf (it keeps about the
// last 250). The feed is kept for 10 minutes between readings.

import { ARTWORK_URL, FEED_URL, feedItems, itemForDaf } from '../../shared/lakewood-feed.mjs';
import { MASECHTOS, masechtaByName } from '../../shared/masechtos.mjs';

const FEED_TTL_MS = 10 * 60 * 1000;
let cached = null; // { items, at }

// The lookup parseBornsteinTitle reads ({ byName }), from the masechtos list.
const LOOKUP = { byName: new Map(MASECHTOS.map((m) => [m.name.toLowerCase(), { name: m.name }])) };

export async function feedFor(fetchImpl = fetch, now = Date.now()) {
  if (cached && now - cached.at < FEED_TTL_MS) return cached.items;
  const response = await fetchImpl(FEED_URL, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Lakewood Daf Yomi's feed answered ${response.status}`);
  const items = feedItems(await response.text());
  cached = { items, at: now };
  return items;
}

export function clearFeedCache() {
  cached = null;
}

function json(body, status = 200, cache = 'public, max-age=600') {
  return Response.json(body, { status, headers: { 'cache-control': cache } });
}

export default async function handler(request, _context, fetchImpl = fetch) {
  const params = new URL(request.url).searchParams;
  const masechta = masechtaByName(params.get('tractate') || '');
  const daf = Number(params.get('daf'));
  if (!masechta || !Number.isInteger(daf) || daf < masechta.startDaf || daf > masechta.endDaf) {
    return json({ error: 'Give a tractate (as Sefaria names it) and a daf.' }, 400, 'no-store');
  }
  let items;
  try {
    items = await feedFor(fetchImpl);
  } catch (error) {
    return json({ error: `Could not read Lakewood Daf Yomi's feed (${error.message}).` }, 502, 'no-store');
  }
  const item = itemForDaf(items, LOOKUP, { tractate: masechta.name, daf });
  if (!item) return json({ error: "Lakewood Daf Yomi's feed has no shiur on this daf." }, 404);
  return json({ url: item.url, seconds: item.seconds, title: item.title, artwork: ARTWORK_URL });
}

export const config = { path: '/api/lakewood-audio' };
