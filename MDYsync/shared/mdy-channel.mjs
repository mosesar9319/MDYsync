// Shared logic for turning a Mercaz Daf Yomi channel video title into the
// daf references it covers, and into the results-branch key each of those
// references is published under.
//
// Deliberately dependency-free and side-effect-free so both consumers can
// import it as-is: youtube-channel-sync.mjs (the hourly Netlify job that
// picks up new uploads) and tools/backfill-video-links.mjs (the one-off
// workflow that walks the channel's whole back catalogue). Before this was
// extracted the parsing lived only in the Netlify function, so backfilling
// would have meant a second hand-maintained copy -- and refKey composition
// is already hand-mirrored in enough places (app.js, trigger-ocr-job.mjs,
// save-video-link.mjs, ocr-job.yml) that adding another was a bad trade.

const GEMATRIA_VALUES = {
  'א': 1, 'ב': 2, 'ג': 3, 'ד': 4, 'ה': 5, 'ו': 6, 'ז': 7, 'ח': 8, 'ט': 9,
  'י': 10, 'כ': 20, 'ל': 30, 'מ': 40, 'נ': 50, 'ס': 60, 'ע': 70, 'פ': 80, 'צ': 90,
  'ק': 100, 'ר': 200, 'ש': 300, 'ת': 400,
  'ך': 20, 'ם': 40, 'ן': 50, 'ף': 80, 'ץ': 90, // final forms, in case a title uses one
};

export function decodeGematria(token) {
  const letters = [...String(token || '')].filter((ch) => GEMATRIA_VALUES[ch] != null);
  if (!letters.length) return null;
  return letters.reduce((sum, ch) => sum + GEMATRIA_VALUES[ch], 0);
}

export function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");
}

// Same rule as app.js's amudimForDaf() -- kept in sync by hand since that
// one runs in the browser with no shared module between them, and the logic
// (skip the trailing amud b of a tractate that ends on amud a, skip any
// explicitly listed exception page) is small and stable.
export function amudimForDaf(entry, daf) {
  const sides = [];
  for (const side of ['a', 'b']) {
    if (daf === entry.endDaf && side === 'b' && entry.endSide === 'a') continue;
    if (entry.skipAmudim.includes(`${daf}${side}`)) continue;
    sides.push(side);
  }
  return sides;
}

// Same composition as app.js's refKey()/CHAZARAH_KEY_PREFIX/HEBREW_KEY_PREFIX
// -- must match exactly, or a video published here would never be found by
// the player looking it up under its own refKey().
export function refKeyFor({ tractate, daf, amud, variant, language }) {
  const languagePrefix = language === 'he' ? 'Hebrew-' : '';
  const variantPrefix = variant === 'chazarah' ? 'Chazarah-Daf-' : '';
  return `${languagePrefix}${variantPrefix}${tractate.replace(/\s+/g, '-')}-${daf}${amud}`;
}

export function refDisplay({ tractate, daf, amud, variant, language }) {
  const variantSuffix = variant === 'chazarah' ? ' (Chazarah Daf)' : '';
  const languageSuffix = language === 'he' ? ' (Hebrew)' : '';
  return `${tractate} ${daf}${amud}${variantSuffix}${languageSuffix}`;
}

export function buildTalmudLookup(talmudIndex) {
  const byName = new Map();
  const byHebrewName = new Map();
  const order = [];
  for (const entry of talmudIndex.tractates) {
    byName.set(entry.name.toLowerCase(), entry);
    byHebrewName.set(entry.hebrewName, entry);
    order.push(entry.name);
  }
  return { byName, byHebrewName, order };
}

// The video before this one in the cycle ends with -- e.g. if this video
// opens on Chullin 87a, the previous daf is Chullin 86b (or, if this video
// opens a new tractate, the previous tractate's last amud).
export function previousAmudB(lookup, tractateName, daf) {
  const entry = lookup.byName.get(tractateName.toLowerCase());
  if (!entry) return null;
  if (daf > entry.startDaf) {
    const prevDaf = daf - 1;
    const sides = amudimForDaf(entry, prevDaf);
    const amud = sides.includes('b') ? 'b' : sides.includes('a') ? 'a' : null;
    return amud ? { tractate: entry.name, daf: prevDaf, amud } : null;
  }
  const idx = lookup.order.indexOf(entry.name);
  if (idx <= 0) return null; // Berakhot: nothing precedes it in Bavli
  const prevEntry = lookup.byName.get(lookup.order[idx - 1].toLowerCase());
  const sides = amudimForDaf(prevEntry, prevEntry.endDaf);
  const amud = sides.includes('b') ? 'b' : sides.includes('a') ? 'a' : null;
  return amud ? { tractate: prevEntry.name, daf: prevEntry.endDaf, amud } : null;
}

function finish(rawTractate, daf, variant, language, lookup) {
  if (!Number.isInteger(daf) || daf < 2) return null;
  const entry = language === 'he'
    ? lookup.byHebrewName.get(rawTractate.trim())
    : lookup.byName.get(rawTractate.trim().toLowerCase());
  // An unrecognized tractate name (a typo, a special/guest shiur, an
  // announcement video, ...) is deliberately left unhandled rather than
  // guessed at -- a missed video can always be linked by hand, but a
  // wrongly-keyed one would be hard to notice.
  if (!entry) return null;
  return { tractate: entry.name, daf, variant, language };
}

// The channel titles its four recordings per daf consistently:
//   "Daf Yomi <Tractate> Daf <N> by R' Eli Stefansky"        (regular, English)
//   "CHAZARAH - <Tractate> Daf <N> | ..."                     (chazarah, English)
//   "מרכז דף יומי - <tractate> דף <N-in-gematria> - ..."      (regular, Hebrew)
//   "חזרה - <tractate> דף <N-in-gematria> | ..."              (chazarah, Hebrew)
// Anything that doesn't match one of these returns null rather than being
// guessed at -- see finish() above for why.
export function parseChannelTitle(rawTitle, lookup) {
  const title = decodeHtmlEntities(rawTitle).trim();

  let m = /^Daf\s+Yomi\s+(.+?)\s+Daf\s+(\d+)\b/i.exec(title);
  if (m) return finish(m[1], Number(m[2]), 'regular', 'en', lookup);

  m = /^CHAZARAH\s*[-–—]\s*(.+?)\s+Daf\s+(\d+)\b/i.exec(title);
  if (m) return finish(m[1], Number(m[2]), 'chazarah', 'en', lookup);

  m = /^מרכז\s+דף\s+יומי\s*[-–—]\s*(.+?)\s+דף\s+([א-ת]+)/.exec(title);
  if (m) {
    const daf = decodeGematria(m[2]);
    if (daf) return finish(m[1], daf, 'regular', 'he', lookup);
  }

  m = /^חזרה\s*[-–—]\s*(.+?)\s+דף\s+([א-ת]+)/.exec(title);
  if (m) {
    const daf = decodeGematria(m[2]);
    if (daf) return finish(m[1], daf, 'chazarah', 'he', lookup);
  }

  return null;
}

// The refs this video should be published under: the tail of the previous
// daf (almost every shiur opens there before moving on) plus the new daf's
// amud(s), skipping any that don't actually exist (a tractate's very first
// or very last amud).
export function readingsForVideo(parsed, lookup) {
  const entry = lookup.byName.get(parsed.tractate.toLowerCase());
  if (!entry) return [];
  const readings = [];
  const prev = previousAmudB(lookup, parsed.tractate, parsed.daf);
  if (prev) readings.push({ ...prev, variant: parsed.variant, language: parsed.language });
  for (const amud of amudimForDaf(entry, parsed.daf)) {
    readings.push({ tractate: parsed.tractate, daf: parsed.daf, amud, variant: parsed.variant, language: parsed.language });
  }
  return readings;
}
