// Scheduled job: polls the Mercaz Daf Yomi YouTube channel's upload feed,
// figures out which daf(s) each new video covers from its title, and
// publishes a video-links/<refKey>.json for each -- the same file
// save-video-link.mjs writes when a reader pastes a link by hand, just
// triggered by a schedule instead of a paste. This is the only piece
// allowed to hold the GitHub token that can write to the repo; it never
// touches the alignment/OCR pipeline, only the video-link association.
//
// The channel uploads four separate recordings per daf -- regular and
// "Chazarah Daf" (a shorter, gemara-only review), each in English and
// Hebrew -- and titles them consistently:
//   "Daf Yomi <Tractate> Daf <N> by R' Eli Stefansky"        (regular, English)
//   "CHAZARAH - <Tractate> Daf <N> | ..."                     (chazarah, English)
//   "מרכז דף יומי - <tractate> דף <N-in-gematria> - ..."      (regular, Hebrew)
//   "חזרה - <tractate> דף <N-in-gematria> | ..."              (chazarah, Hebrew)
// See parseChannelTitle() below.
//
// Almost every shiur opens with the tail end of the previous daf's amud b
// before moving on to the new daf's a and b, so each video is published
// under three refs, not one: the previous daf's b (if it exists) and the
// new daf's a and b (if it exists) -- see readingsForVideo().
//
// This only ever *creates* a video-links file; if one already exists for a
// ref (from this job or a manual paste), it's left alone, so a reader's own
// correction is never silently overwritten by a later poll.

const OWNER = 'mosesar9319';
const REPO = 'MDYsync';
const CHANNEL_ID = 'UCKwQa5DB_VR98ac_r-Wyl-g'; // @MercazDafYomi
const TALMUD_INDEX_URL = `https://raw.githubusercontent.com/${OWNER}/${REPO}/main/MDYsync/talmud_index.json`;

const GEMATRIA_VALUES = {
  'א': 1, 'ב': 2, 'ג': 3, 'ד': 4, 'ה': 5, 'ו': 6, 'ז': 7, 'ח': 8, 'ט': 9,
  'י': 10, 'כ': 20, 'ל': 30, 'מ': 40, 'נ': 50, 'ס': 60, 'ע': 70, 'פ': 80, 'צ': 90,
  'ק': 100, 'ר': 200, 'ש': 300, 'ת': 400,
  'ך': 20, 'ם': 40, 'ן': 50, 'ף': 80, 'ץ': 90, // final forms, in case a title uses one
};

function decodeGematria(token) {
  const letters = [...String(token || '')].filter((ch) => GEMATRIA_VALUES[ch] != null);
  if (!letters.length) return null;
  return letters.reduce((sum, ch) => sum + GEMATRIA_VALUES[ch], 0);
}

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");
}

// Same rule as app.js's amudimForDaf() -- kept in sync by hand since this
// function runs in a separate JS runtime with no shared module between
// them, and the logic (skip the trailing amud b of a tractate that ends on
// amud a, skip any explicitly listed exception page) is small and stable.
function amudimForDaf(entry, daf) {
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
function refKeyFor({ tractate, daf, amud, variant, language }) {
  const languagePrefix = language === 'he' ? 'Hebrew-' : '';
  const variantPrefix = variant === 'chazarah' ? 'Chazarah-Daf-' : '';
  return `${languagePrefix}${variantPrefix}${tractate.replace(/\s+/g, '-')}-${daf}${amud}`;
}

function refDisplay({ tractate, daf, amud, variant, language }) {
  const variantSuffix = variant === 'chazarah' ? ' (Chazarah Daf)' : '';
  const languageSuffix = language === 'he' ? ' (Hebrew)' : '';
  return `${tractate} ${daf}${amud}${variantSuffix}${languageSuffix}`;
}

function buildTalmudLookup(talmudIndex) {
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
function previousAmudB(lookup, tractateName, daf) {
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

function parseChannelTitle(rawTitle, lookup) {
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

// The three refs this video should be published under: the tail of the
// previous daf plus the new daf's amud(s), skipping any that don't
// actually exist (a tractate's very first or very last amud).
function readingsForVideo(parsed, lookup) {
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

function parseFeedEntries(xml) {
  const entries = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;
  while ((match = entryRegex.exec(xml))) {
    const block = match[1];
    const videoId = /<yt:videoId>([^<]+)<\/yt:videoId>/.exec(block)?.[1];
    const title = /<title>([^<]*)<\/title>/.exec(block)?.[1];
    const published = /<published>([^<]*)<\/published>/.exec(block)?.[1];
    if (videoId && title) entries.push({ videoId, title, published });
  }
  return entries;
}

export default async (request) => {
  const token = Netlify.env.get('GITHUB_DISPATCH_TOKEN');
  if (!token) {
    return Response.json({ error: 'Server publish is not configured yet.' }, { status: 503 });
  }
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  };

  let talmudIndex;
  try {
    const response = await fetch(TALMUD_INDEX_URL);
    if (!response.ok) throw new Error(`talmud_index.json returned ${response.status}`);
    talmudIndex = await response.json();
  } catch (error) {
    return Response.json({ error: `Could not load talmud_index.json: ${error.message}` }, { status: 502 });
  }
  const lookup = buildTalmudLookup(talmudIndex);

  let entries;
  try {
    const response = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`);
    if (!response.ok) throw new Error(`YouTube feed returned ${response.status}`);
    entries = parseFeedEntries(await response.text());
  } catch (error) {
    return Response.json({ error: `Could not read the channel feed: ${error.message}` }, { status: 502 });
  }

  // One tree listing up front tells us every video-links ref that already
  // exists, so per-video work below is pure local computation -- no GET
  // per candidate ref, and no risk of overwriting an existing file.
  let existingKeys;
  try {
    const treeResponse = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/git/trees/results?recursive=1`);
    if (!treeResponse.ok) throw new Error(`GitHub tree API returned ${treeResponse.status}`);
    const tree = await treeResponse.json();
    existingKeys = new Set(
      (tree.tree || [])
        .filter((item) => item.type === 'blob' && item.path.startsWith('video-links/') && item.path.endsWith('.json'))
        .map((item) => item.path.slice('video-links/'.length, -'.json'.length))
    );
  } catch (error) {
    return Response.json({ error: `Could not list existing video links: ${error.message}` }, { status: 502 });
  }

  const published = [];
  const skipped = [];

  for (const entry of entries) {
    const parsed = parseChannelTitle(entry.title, lookup);
    if (!parsed) {
      skipped.push({ videoId: entry.videoId, title: entry.title, reason: 'title did not match a known pattern' });
      continue;
    }
    const readings = readingsForVideo(parsed, lookup);
    const videoSource = {
      type: 'youtube',
      url: `https://www.youtube.com/watch?v=${entry.videoId}`,
      videoId: entry.videoId,
      label: decodeHtmlEntities(entry.title).slice(0, 40),
    };
    const body = JSON.stringify(videoSource);

    for (const reading of readings) {
      const key = refKeyFor(reading);
      if (existingKeys.has(key)) continue;
      try {
        const putResponse = await fetch(
          `https://api.github.com/repos/${OWNER}/${REPO}/contents/video-links/${key}.json`,
          {
            method: 'PUT',
            headers,
            body: JSON.stringify({
              message: `Auto-link ${refDisplay(reading)} to ${entry.videoId}`,
              content: Buffer.from(body, 'utf8').toString('base64'),
              branch: 'results',
            }),
          }
        );
        if (putResponse.ok) {
          existingKeys.add(key);
          published.push({ ref: refDisplay(reading), videoId: entry.videoId });
        } else {
          skipped.push({ ref: refDisplay(reading), videoId: entry.videoId, reason: `publish failed (${putResponse.status})` });
        }
      } catch (error) {
        skipped.push({ ref: refDisplay(reading), videoId: entry.videoId, reason: error.message });
      }
    }
  }

  return Response.json({ published, skipped });
};

export const config = {
  schedule: '0 * * * *',
};
