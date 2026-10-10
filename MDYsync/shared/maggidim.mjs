// The maggidei shiur whose YouTube channels this site follows.
//
// Mercaz Daf Yomi (R' Eli Stefansky) was the only one for a long time, so its
// videos live under the plain refKey scheme (video-links/Bekhorot-2b.json,
// Hebrew-/Chazarah-Daf- prefixes for the other recordings of the same daf).
// Every other maggid's videos sit in the same scheme behind their own
// `keyPrefix` ("Bernstein-Bekhorot-2b"), so a daf can have a recording from
// each side by side and everything keyed by refKey (video links, published
// alignments, sync jobs) keeps working without a second code path.
//
// The marker a ref carries in the player ("Bekhorot 2b (Bernstein)") is
// `marker`; app.js's parseDafRef reads it back, and refKey() composes
// `keyPrefix` after any Voice- prefix. Hand-mirrored in app.js (MAGGIDIM)
// because the player has no module system -- tests/functions/maggidim.test.mjs
// checks the two agree.
//
// Deliberately dependency-free: imported by the Netlify functions, the channel
// backfill tool and the tests alike.

export const MAGGIDIM = [
  {
    id: 'stefansky',
    name: "R' Eli Stefansky",
    channelName: 'Mercaz Daf Yomi',
    channelId: 'UCKwQa5DB_VR98ac_r-Wyl-g', // @MercazDafYomi
    handle: '@MercazDafYomi',
    keyPrefix: '',
    marker: '',
  },
  {
    id: 'bernstein',
    name: "R' Sruly Bernstein",
    channelName: 'Lakewood Daf Yomi',
    channelId: 'UCyk5Q9nuhwqJC_-zrP2Ojcg', // @lakewooddafyomi
    handle: '@lakewooddafyomi',
    keyPrefix: 'Bernstein-',
    marker: 'Bernstein',
  },
];

export const DEFAULT_MAGGID_ID = 'stefansky';

export function maggidById(id) {
  return MAGGIDIM.find((m) => m.id === id) || null;
}

export function maggidByChannelId(channelId) {
  return MAGGIDIM.find((m) => m.channelId === channelId) || null;
}

// The key prefix for a maggid id ('' for the default maggid or none).
export function maggidKeyPrefix(id) {
  return maggidById(id)?.keyPrefix || '';
}

// How Lakewood Daf Yomi's titles spell the tractates it has covered, where that
// differs from talmud_index.json's name -- only spellings the channel actually
// uses (checked against its whole upload list), since a wrong guess would
// silently file a video under the wrong tractate. Bechoros is already known to
// mdy-channel.mjs's buildTalmudLookup.
const BERNSTEIN_TRACTATE_ALIASES = {
  chulin: 'chullin',
  menachos: 'menachot',
  yevamos: 'yevamot',
  bechoros: 'bekhorot',
};

// Lakewood Daf Yomi's daf videos are titled "<Tractate> <N>" ("Bechoros 22",
// "Chulin 100"); its earliest ones "<Tractate> Daf <N> by Sruly Bornstein".
// English only, one regular recording per daf. Everything else it posts
// (derashos, shiurim on a topic) is not tied to a daf and returns null.
// Returns { tractate, daf, variant, language } or null.
export function parseBernsteinTitle(rawTitle, lookup) {
  const title = String(rawTitle || '').replace(/&amp;/g, '&').trim();
  const m = /^([A-Za-z][A-Za-z' ]*?)(?:\s+Daf)?\s+(\d{1,3})(?:\s+by\s+Sruly\s+B[eo]rn?stein)?$/i.exec(title);
  if (!m) return null;
  const typed = m[1].trim().toLowerCase();
  const entry = lookup.byName.get(BERNSTEIN_TRACTATE_ALIASES[typed] || typed);
  const daf = Number(m[2]);
  if (!entry || !Number.isInteger(daf) || daf < 2) return null;
  return { tractate: entry.name, daf, variant: 'regular', language: 'en' };
}
