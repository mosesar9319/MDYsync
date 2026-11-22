// The pages Google ranks: one per masechta (/bechoros/), one per daf
// (/bechoros/58/) listing every shiur on it, and one per shiur
// (/bechoros/58/bornstein/), which is the player itself under an address and
// a title of its own. Plus /sitemap.xml listing all of them, and the home page
// (/), which is index.html with links to those pages written into it.
//
// Built here, from the published catalog, on request, rather than written out
// as files: a shiur is added to the catalog every day by the channel sync, and
// a page for it exists the moment it is listed. Netlify's CDN keeps each page
// (Netlify-CDN-Cache-Control below), so this runs about once an hour per page.
//
// Every page is complete HTML before any script runs -- the title, the
// heading, the shiurim, the daf's opening lines -- because that is what a
// search engine reads first. A shiur page then turns into the ordinary player:
// its first script puts the player's own address (/player/?ref=...) in the
// address bar before anything else loads, so app.js, its relative script paths
// and everything else work exactly as they do on /player/.

import {
  MASECHTOS, masechtaByName, masechtaBySlug, displayName, otherSpellings, hebrewNumeral, amudRange,
} from '../../shared/masechtos.mjs';
import { MAGGIDIM, DEFAULT_MAGGID_ID, maggidById } from '../../shared/maggidim.mjs';
import { OWNER, REPO, PUBLIC_SITE_ORIGIN } from '../../shared/dafsync-config.mjs';
import MdyFiles from '../../mdy-files.js';

// The four recordings a daf can have, in the order a page lists them, and
// the address segment each one's shiur page gets after the maggid.
export const VARIANTS = [
  { key: 'regularEn', segment: '', label: 'Shiur', titleWord: '', variant: '', language: '' },
  { key: 'chazarahEn', segment: 'chazarah', label: 'Chazarah', titleWord: 'Chazarah', variant: 'chazarah', language: '' },
  { key: 'regularHe', segment: 'hebrew', label: 'Shiur in Hebrew', titleWord: 'in Hebrew', variant: '', language: 'hebrew' },
  { key: 'chazarahHe', segment: 'chazarah-hebrew', label: 'Chazarah in Hebrew', titleWord: 'Chazarah in Hebrew', variant: 'chazarah', language: 'hebrew' },
];
const VARIANT_BY_SEGMENT = new Map(VARIANTS.map((v) => [v.segment, v]));

const CATALOG_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 3000;

// A date as the catalog and the maggid lists write one ("2026-11-19T04:47:41.000Z").
const isDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(T|$)/.test(value);

export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------------------------
// The catalog, as one flat list of shiurim
// ---------------------------------------------------------------------------

// catalog.json (tools/build-video-catalog.mjs): tractates.<name> = rows of the
// default maggid, maggidim.<id>.tractates.<name> = everyone else's. A row is
// { daf, regularEn?, chazarahEn?, regularHe?, chazarahHe? }, each
// { videoId, label, amud, published?, url?, liveBroadcast? }. A livestream is
// left out: it is replaced by the finished upload once that is posted.
// `published` is when the shiur was posted (rows linked before it was kept
// have none); `url` is the recording itself for a shiur that is not on YouTube.
export function shiurimFromCatalog(catalog) {
  const out = [];
  const add = (tractates, maggidId) => {
    for (const [name, rows] of Object.entries(tractates || {})) {
      const masechta = masechtaByName(name);
      if (!masechta || !Array.isArray(rows)) continue;
      for (const row of rows) {
        const daf = Number(row?.daf);
        if (!Number.isInteger(daf)) continue;
        for (const variant of VARIANTS) {
          const video = row[variant.key];
          if (!video?.videoId || video.liveBroadcast) continue;
          out.push({
            masechta, daf, maggidId, variant, videoId: video.videoId, label: video.label || '', amud: video.amud === 'b' ? 'b' : 'a',
            ...(isDate(video.published) ? { published: video.published } : {}),
            ...(typeof video.url === 'string' && /^https:\/\//.test(video.url) ? { url: video.url } : {}),
          });
        }
      }
    }
  };
  add(catalog?.tractates, DEFAULT_MAGGID_ID);
  for (const maggid of MAGGIDIM) {
    if (maggid.id !== DEFAULT_MAGGID_ID) add(catalog?.maggidim?.[maggid.id]?.tractates, maggid.id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

export const masechtaPath = (m) => `/${m.slug}/`;
export const dafPath = (m, daf) => `/${m.slug}/${daf}/`;
export const maggidPath = (id) => `/${id}/`;
export const maggidMasechtaPath = (id, m) => `/${id}/${m.slug}/`;
export const shiurPath = (s) => `/${s.masechta.slug}/${s.daf}/${s.maggidId}/${s.variant.segment ? `${s.variant.segment}/` : ''}`;
const absolute = (path) => `${PUBLIC_SITE_ORIGIN}${path}`;

// What a request asks for, or null for an address that names nothing.
export function parseRoute(pathname) {
  if (pathname === '/sitemap.xml') return { kind: 'sitemap' };
  if (pathname === '/') return { kind: 'home' };
  if (pathname === '/player/') return { kind: 'player' };
  const parts = pathname.split('/').filter(Boolean);
  const maggidPage = maggidById(parts[0]);
  if (maggidPage) {
    if (parts.length === 1) return { kind: 'maggid', maggidId: maggidPage.id };
    const m = parts.length === 2 ? masechtaBySlug(parts[1]) : null;
    return m ? { kind: 'maggid-masechta', maggidId: maggidPage.id, masechta: m } : null;
  }
  const masechta = masechtaBySlug(parts[0]);
  if (!masechta || parts.length > 4) return null;
  if (parts.length === 1) return { kind: 'masechta', masechta };
  if (!/^\d{1,3}$/.test(parts[1])) return null;
  const daf = Number(parts[1]);
  if (parts.length === 2) return { kind: 'daf', masechta, daf };
  const maggid = maggidById(parts[2]);
  const variant = VARIANT_BY_SEGMENT.get(parts[3] || '');
  if (!maggid || !variant) return null;
  return { kind: 'shiur', masechta, daf, maggidId: maggid.id, variant };
}

// The player address a shiur page hands over to, as the home page builds it.
// `extra` is the rest of what the page was asked for (a time to start at, a
// line to show, the other amud...), kept on the player's address so the
// player still sees it.
export function playerUrl(shiur, mode = 'split', extra = null) {
  const params = new URLSearchParams({ ref: `${shiur.masechta.name} ${shiur.daf}${shiur.amud}` });
  if (shiur.variant.variant) params.set('variant', shiur.variant.variant);
  if (shiur.variant.language) params.set('language', shiur.variant.language);
  if (shiur.maggidId !== DEFAULT_MAGGID_ID) params.set('maggid', shiur.maggidId);
  if (mode && mode !== 'standard') params.set('mode', mode);
  for (const [key, value] of extra || []) {
    if (key === 'ref') {
      // Only the other amud of the same daf: a shiur page never plays another daf.
      const asked = parsePlayerRef(value);
      if (asked && asked.masechta === shiur.masechta && asked.daf === shiur.daf && asked.amud) {
        params.set('ref', `${shiur.masechta.name} ${shiur.daf}${asked.amud}`);
      }
    } else if (!SHIUR_PARAMS.has(key)) {
      params.append(key, value);
    }
  }
  return `/player/?${params.toString()}`;
}

// What the shiur's own address already says, so not carried on beside it.
const SHIUR_PARAMS = new Set(['ref', 'variant', 'language', 'maggid', 'mode']);

// The player's ref, as the player reads it (parseDafRef in app.js): a masechta
// by any spelling the site uses, a daf, an amud, and the "(Chazarah Daf)",
// "(Hebrew)" and "(Bornstein)" markers in any order.
export function parsePlayerRef(ref) {
  let working = String(ref || '').trim();
  const out = { variant: '', language: '', maggidId: '' };
  const strip = (pattern) => {
    if (!pattern.test(working)) return false;
    working = working.replace(pattern, '');
    return true;
  };
  if (strip(/\s*\(Chazarah Daf\)/i)) out.variant = 'chazarah';
  if (strip(/\s*\(Hebrew\)/i)) out.language = 'hebrew';
  for (const maggid of MAGGIDIM) {
    if (maggid.id !== DEFAULT_MAGGID_ID && strip(new RegExp(`\\s*\\(${maggid.id}\\)`, 'i'))) out.maggidId = maggid.id;
  }
  const match = /^(.+?)\s+(\d{1,3})\s*([ab])?(?:[:.]\d+)?$/i.exec(working.trim());
  if (!match) return null;
  const typed = match[1].trim().toLowerCase();
  const masechta = MASECHTOS.find((m) => m.name.toLowerCase() === typed
    || displayName(m).toLowerCase() === typed || m.slug === typed.replace(/\s+/g, '-'));
  if (!masechta) return null;
  return { ...out, masechta, daf: Number(match[2]), amud: match[3] ? match[3].toLowerCase() : '' };
}

// The shiur a player address opens, or null when it names none the catalog
// has (another maggid's daf not posted yet, a typo, no ref at all).
export function shiurForPlayer(searchParams, shiurim) {
  const asked = parsePlayerRef(searchParams.get('ref'));
  if (!asked) return null;
  const variant = searchParams.get('variant') === 'chazarah' ? 'chazarah' : asked.variant;
  const language = /^(hebrew|he)$/i.test(searchParams.get('language') || '') ? 'hebrew' : asked.language;
  const maggidId = maggidById(searchParams.get('maggid') || '')?.id || asked.maggidId || DEFAULT_MAGGID_ID;
  return shiurim.find((s) => s.masechta === asked.masechta && s.daf === asked.daf && s.maggidId === maggidId
    && s.variant.variant === variant && s.variant.language === language) || null;
}

// Where an old player address now lives: the shiur's own page, with whatever
// else the address asked for. The ref stays only when it names the other amud.
export function shiurAddressFor(shiur, searchParams) {
  const params = new URLSearchParams();
  const asked = parsePlayerRef(searchParams.get('ref'));
  if (asked?.amud && asked.amud !== shiur.amud) params.set('ref', `${shiur.masechta.name} ${shiur.daf}${asked.amud}`);
  for (const [key, value] of searchParams) {
    if (!SHIUR_PARAMS.has(key) || key === 'mode') params.append(key, value);
  }
  const query = params.toString();
  return `${shiurPath(shiur)}${query ? `?${query}` : ''}`;
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

const hebrewDaf = (m, daf) => `${m.hebrew} ${hebrewNumeral(daf)}`;
const dafName = (m, daf) => `${displayName(m)} ${daf}`;
// "Rabbi Eli Stefansky": as people search for him, where the site itself
// says "R' Eli Stefansky".
const maggidName = (id) => (maggidById(id)?.name || id).replace(/^R' /, 'Rabbi ');
const shortName = (id) => maggidById(id)?.name || id;
const dafAmudim = (m, daf) => `${displayName(m)} ${amudRange(m, daf)}`;
const VARIANT_KIND = { '': 'Daf Yomi Shiur', chazarah: 'Chazarah', hebrew: 'Shiur in Hebrew', 'chazarah-hebrew': 'Chazarah in Hebrew' };
const maggidChannel = (id) => maggidById(id)?.channelName || '';

function listNames(names) {
  if (names.length <= 1) return names.join('');
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// "Bechoros 58a–58b Daf Yomi Shiur — Rabbi Eli Stefansky | DafSync": the daf
// as it is searched for (by amud as well as by daf) and the maggid's full name.
function shiurTitle(s) {
  return `${dafAmudim(s.masechta, s.daf)} ${VARIANT_KIND[s.variant.segment]} — ${maggidName(s.maggidId)} | DafSync`;
}

// The masechta's other spellings, the first two, for a description.
const alsoSpelled = (m) => {
  const spellings = otherSpellings(m).slice(0, 2);
  return spellings.length ? `${spellings.join(', ')} · ` : '';
};

function shiurDescription(s) {
  const kind = s.variant.variant === 'chazarah' ? 'chazarah' : 'Daf Yomi shiur';
  const lang = s.variant.language ? ' in Hebrew' : '';
  // R' Bornstein's shiurim are audio: listened to, with no video to sit beside.
  const audio = Boolean(MAGGID_PICTURES[s.maggidId]);
  return `${audio ? 'Listen to' : 'Watch'} ${maggidName(s.maggidId)}'s ${kind}${lang} on ${dafAmudim(s.masechta, s.daf)} (${alsoSpelled(s.masechta)}${hebrewDaf(s.masechta, s.daf)}) `
    + `with the daf beside ${audio ? 'it' : 'the video'}, each line of the Gemara highlighted as it's read.`;
}

// ---------------------------------------------------------------------------
// Outside data: the catalog, the daf's text, the videos' dates
// ---------------------------------------------------------------------------

let catalogCache = null;

async function fetchWithTimeout(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

export async function loadCatalog(env = {}) {
  if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.data;
  const token = env.GITHUB_DISPATCH_TOKEN;
  const response = token
    ? await fetchWithTimeout(`https://api.github.com/repos/${OWNER}/${REPO}/contents/catalog.json?ref=results`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.raw+json' } })
    : await fetchWithTimeout(`https://raw.githubusercontent.com/${OWNER}/${REPO}/results/catalog.json`);
  if (!response.ok) throw new Error(`catalog: GitHub returned ${response.status}`);
  const data = await response.json();
  catalogCache = { at: Date.now(), data };
  return data;
}

export function resetCatalogCache() {
  catalogCache = null;
  listsCache = null;
}

// When each shiur of the other maggidim was posted and how long it runs:
// videoId -> { published, seconds }, from the list kept for each of them on
// the results branch (maggidim/<id>.json; tools/lakewood-import.mjs and
// youtube-channel-sync.mjs write them). Empty, never an error, when a list
// cannot be read: a page is complete without its dates.
let listsCache = null;

export async function loadMaggidLists(env = {}) {
  if (listsCache && Date.now() - listsCache.at < CATALOG_TTL_MS) return listsCache.data;
  const token = env.GITHUB_DISPATCH_TOKEN;
  const data = new Map();
  await Promise.all(MAGGIDIM.filter((m) => m.id !== DEFAULT_MAGGID_ID).map(async (maggid) => {
    try {
      const response = token
        ? await fetchWithTimeout(`https://api.github.com/repos/${OWNER}/${REPO}/contents/maggidim/${maggid.id}.json?ref=results`,
          { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.raw+json' } })
        : await fetchWithTimeout(`https://raw.githubusercontent.com/${OWNER}/${REPO}/results/maggidim/${maggid.id}.json`);
      if (!response.ok) return;
      const list = await response.json();
      for (const video of Array.isArray(list?.videos) ? list.videos : []) {
        if (!video?.videoId) continue;
        data.set(video.videoId, {
          ...(isDate(video.published) ? { published: video.published } : {}),
          ...(Number(video.seconds) > 0 ? { seconds: Number(video.seconds) } : {}),
        });
      }
    } catch {
      // No list: no dates for this maggid's shiurim.
    }
  }));
  listsCache = { at: Date.now(), data };
  return data;
}

// The shiurim with what the maggid lists know added (a row's own date wins).
export function withListDetails(shiurim, lists) {
  return shiurim.map((s) => {
    const known = lists?.get(s.videoId);
    if (!known) return s;
    return { ...s, ...(s.published ? {} : known.published ? { published: known.published } : {}), ...(known.seconds ? { seconds: known.seconds } : {}) };
  });
}

// The first lines of the amud, from Sefaria, as plain text. Nothing (and no
// error) if Sefaria is slow or down: the page is complete without it.
export async function openingLines(masechta, daf, maxChars = 420) {
  try {
    const ref = `${masechta.name}.${daf}a`;
    const response = await fetchWithTimeout(`https://www.sefaria.org/api/texts/${encodeURIComponent(ref)}?context=0&commentary=0&pad=0`);
    if (!response.ok) return '';
    const data = await response.json();
    const parts = (Array.isArray(data.he) ? data.he : [data.he]).flat(Infinity).filter((s) => typeof s === 'string');
    let text = parts.join(' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    if (text.length > maxChars) text = `${text.slice(0, text.lastIndexOf(' ', maxChars))} …`;
    return text;
  } catch {
    return '';
  }
}

// Publish date and length per video, from the YouTube Data API when a key is
// set; {} otherwise. A video's structured data is only given with its date,
// which Google requires.
export async function videoDetails(videoIds, apiKey) {
  if (!apiKey || !videoIds.length) return {};
  try {
    const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${videoIds.slice(0, 50).join(',')}&key=${encodeURIComponent(apiKey)}`;
    const response = await fetchWithTimeout(url);
    if (!response.ok) return {};
    const data = await response.json();
    return Object.fromEntries((data.items || []).map((item) => [item.id, {
      publishedAt: item.snippet?.publishedAt || '',
      duration: item.contentDetails?.duration || '',
    }]));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Structured data
// ---------------------------------------------------------------------------

function breadcrumbs(items) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map(([name, path], i) => ({ '@type': 'ListItem', position: i + 1, name, item: absolute(path) })),
  };
}

// A shiur's picture. A Mercaz Daf Yomi shiur's comes from MDY's own server
// (mdy-files.js) -- filtered devices often block YouTube's -- resized by
// Netlify's image service, since MDY's originals are 1280x720 PNGs of over a
// megabyte (netlify.toml allows MDY's server as a source). Every other
// shiur's, and one MDY's server does not have, is YouTube's.
const mdyRef = (s) => ({
  tractate: s.masechta.name, daf: s.daf, variant: s.variant.variant || 'regular',
  language: s.variant.language === 'hebrew' ? 'he' : 'en', maggid: s.maggidId,
});
export function mdyPoster(s) {
  return MdyFiles.posterUrl(mdyRef(s), { title: s.label });
}
// Absolute for what other sites read (og:image, the VideoObject); relative
// for the page's own <img>, so it works on deploy previews too.
export function resizedPicture(original, width, format = 'webp', { absolute = true } = {}) {
  const path = `/.netlify/images?url=${encodeURIComponent(original)}&w=${width}&fm=${format}&q=75`;
  return absolute ? `${PUBLIC_SITE_ORIGIN}${path}` : path;
}
// R' Sruly Bornstein's shiurim show his picture: they play from Lakewood Daf
// Yomi's server, never YouTube (app.js and index.html show the same picture).
const MAGGID_PICTURES = { bornstein: '/assets/maggidim/bornstein-v1.jpg' };
const youtubePicture = (s, size = 'hq') => (MAGGID_PICTURES[s.maggidId]
  ? `${PUBLIC_SITE_ORIGIN}${MAGGID_PICTURES[s.maggidId]}`
  : `https://i.ytimg.com/vi/${s.videoId}/${size}default.jpg`);
const PICTURE_CHECK_MS = 3000;

// Which of a page's shiurim MDY's server has a picture for (videoId -> its
// address). Asked once per page build; the CDN keeps the page for an hour.
export async function shiurPictures(list) {
  const found = await Promise.all(list.map(async (s) => {
    const poster = mdyPoster(s);
    if (!poster) return null;
    try {
      const response = await fetch(poster, { method: 'HEAD', signal: AbortSignal.timeout(PICTURE_CHECK_MS) });
      return response.ok ? poster : null;
    } catch {
      return null;
    }
  }));
  return new Map(list.map((s, i) => [s.videoId, found[i]]));
}

// "PT1H5M15S" for a length in seconds.
export function isoDuration(seconds) {
  const total = Math.round(Number(seconds));
  if (!(total > 0)) return '';
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  return `PT${h ? `${h}H` : ''}${m ? `${m}M` : ''}${sec || (!h && !m) ? `${sec}S` : ''}`;
}

// The recording a shiur page plays, described for a search engine: who gives
// it, when it was posted, how long it runs and where the file is.
//
// The file named is the one the page plays. An audio shiur's is its mp3 (the
// catalog row's `url`). A Mercaz Daf Yomi shiur's is MDY's own video file when
// MDY's server has the shiur -- known here by its having the shiur's picture,
// which sits in the same folder (mdy-files.js) -- and only one MDY's server
// does not have is described by its YouTube player.
//
// A recording is only described with the date it was posted, which Google
// requires: the catalog row's or the maggid list's, else YouTube's
// (videoDetails) for a row linked before the date was kept.
export function mediaObject(s, details, pictures = new Map()) {
  const d = details?.[s.videoId];
  const uploadDate = s.published || d?.publishedAt;
  if (!uploadDate) return null;
  const duration = isoDuration(s.seconds) || d?.duration || '';
  const common = {
    '@context': 'https://schema.org',
    name: s.label && !MAGGID_PICTURES[s.maggidId] ? s.label : `${dafName(s.masechta, s.daf)} — ${maggidName(s.maggidId)}`,
    description: shiurDescription(s),
    uploadDate,
    ...(duration ? { duration } : {}),
    author: personLd(s.maggidId),
    inLanguage: s.variant.language === 'hebrew' ? 'he' : 'en',
    url: absolute(shiurPath(s)),
  };
  if (s.url) {
    return { ...common, '@type': 'AudioObject', contentUrl: s.url, encodingFormat: 'audio/mpeg', thumbnailUrl: youtubePicture(s) };
  }
  // His shiurim are audio from Lakewood Daf Yomi's server: without the file's
  // address there is nothing to describe, and never a YouTube video.
  if (MAGGID_PICTURES[s.maggidId]) return null;
  const mdyFile = pictures.get(s.videoId) ? MdyFiles.fileUrl(mdyRef(s), { title: s.label, quality: '720' }) : null;
  return {
    ...common,
    '@type': 'VideoObject',
    thumbnailUrl: pictures.get(s.videoId) ? resizedPicture(pictures.get(s.videoId), 1280, 'jpg') : youtubePicture(s),
    ...(mdyFile ? { contentUrl: mdyFile } : { embedUrl: `https://www.youtube.com/embed/${s.videoId}` }),
  };
}

function personLd(id) {
  const maggid = maggidById(id);
  return {
    '@type': 'Person', name: maggidName(id), alternateName: shortName(id), url: absolute(maggidPath(id)),
    ...(maggid?.channelName ? { affiliation: { '@type': 'Organization', name: maggid.channelName } } : {}),
  };
}

const jsonLd = (objects) => objects.filter(Boolean)
  .map((o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, '\\u003c')}</script>`).join('\n');

// ---------------------------------------------------------------------------
// The masechta and daf pages
// ---------------------------------------------------------------------------

const STYLE = `
:root{--ink:#17212b;--muted:#5b6876;--line:#e3e8ee;--brand:#132238;--accent:#2f7de1;--bg:#f6f8fa;--card:#fff}
@media (prefers-color-scheme:dark){:root{--ink:#e8edf2;--muted:#a3b0bd;--line:#2a3542;--brand:#0d1825;--accent:#6aa7ff;--bg:#101820;--card:#16212c}}
*{box-sizing:border-box}body{margin:0;font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:var(--bg)}
a{color:var(--accent)}.top{background:var(--brand);padding:12px 16px}.top a{color:#fff;text-decoration:none;font-weight:700;display:inline-flex;align-items:center;gap:10px}
main{max-width:860px;margin:0 auto;padding:20px 16px 48px}.crumbs{font-size:14px;color:var(--muted)}.crumbs a{color:var(--muted)}
h1{font-size:30px;line-height:1.2;margin:14px 0 6px}h1 .he{font-weight:600;color:var(--muted);margin-inline-start:10px}
h2{font-size:20px;margin:32px 0 12px}.lead{color:var(--muted);margin:6px 0 0}
.shiurim{list-style:none;padding:0;margin:0;display:grid;gap:12px}
.shiurim a{display:flex;gap:14px;align-items:center;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px;text-decoration:none;color:inherit}
.shiurim img{width:160px;aspect-ratio:16/9;object-fit:cover;border-radius:8px;flex:none;background:var(--line)}
.shiurim strong{display:block}.shiurim small{color:var(--muted)}
.daf-text{font:20px/1.8 "Frank Ruehl CLM","SBL Hebrew","Times New Roman",serif;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin:0}
.pager{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:32px}
.dapim{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
.dapim a{display:block;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px;text-decoration:none;color:inherit}
.dapim small{display:block;color:var(--muted)}.by-maggid{margin:14px 0 0}footer{color:var(--muted);font-size:14px;text-align:center;padding:24px 16px}
@media (max-width:560px){.shiurim img{width:112px}h1{font-size:25px}}`;

function pageShell({ title, description, path, body, ld = '', noindex = false }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/assets/app/apple-touch-icon.png">
<meta name="theme-color" content="#132238">
<script src="/pwa.js" defer></script>
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
${noindex ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${absolute(path)}">`}
<meta property="og:type" content="website">
<meta property="og:site_name" content="DafSync">
<meta property="og:url" content="${absolute(path)}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:image" content="${PUBLIC_SITE_ORIGIN}/assets/share-card.jpg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/assets/dafsync-mark.png" type="image/png">
<style>${STYLE}</style>
${ld}
</head>
<body>
<header class="top"><a href="/"><img src="/assets/dafsync-mark.png" alt="" width="36" height="29">DafSync</a></header>
<main>
${body}
</main>
<footer><a href="/">DafSync</a> — Daf Yomi shiurim with the daf synced to the video.</footer>
</body>
</html>
`;
}

export function masechtaPage(masechta, shiurim) {
  const byDaf = new Map();
  for (const s of shiurim) {
    if (s.masechta !== masechta) continue;
    if (!byDaf.has(s.daf)) byDaf.set(s.daf, new Set());
    byDaf.get(s.daf).add(s.maggidId);
  }
  const dapim = [...byDaf.keys()].sort((a, b) => a - b);
  const name = displayName(masechta);
  const total = masechta.endDaf - masechta.startDaf + 1;
  const items = dapim.map((daf) => {
    const maggidim = [...byDaf.get(daf)].map(maggidName);
    return `<li><a href="${dafPath(masechta, daf)}"><strong>${escapeHtml(name)} ${daf}</strong><small lang="he" dir="rtl">${escapeHtml(hebrewDaf(masechta, daf))}</small><small>${escapeHtml(listNames(maggidim))}</small></a></li>`;
  }).join('\n');
  const spellings = otherSpellings(masechta);
  const byMaggid = MAGGIDIM.filter((m) => shiurim.some((s) => s.masechta === masechta && s.maggidId === m.id))
    .map((m) => `<a href="${maggidMasechtaPath(m.id, masechta)}">${escapeHtml(maggidName(m.id))} on ${escapeHtml(name)}</a>`);
  const body = `<nav class="crumbs" aria-label="Breadcrumb"><a href="/">DafSync</a> › ${escapeHtml(name)}</nav>
<h1>Masechta ${escapeHtml(name)} <span class="he" lang="he" dir="rtl">${escapeHtml(masechta.hebrew)}</span></h1>
<p class="lead">Daf Yomi shiurim on ${escapeHtml(name)}${spellings.length ? ` (also spelled ${escapeHtml(spellings.join(', '))})` : ''}, with the Gemara beside the video and each line highlighted as the maggid reads it. ${dapim.length} of its ${total} dapim have a shiur so far.</p>
${byMaggid.length ? `<p class="by-maggid">By maggid: ${byMaggid.join(' · ')}</p>` : ''}
<h2>Dapim</h2>
<ul class="dapim">
${items}
</ul>`;
  return pageShell({
    title: `${name} Daf Yomi Shiurim — Every Daf with the Gemara Synced | DafSync`,
    description: `Daf Yomi shiurim on every daf of Masechta ${name} (${masechta.hebrew}) with the Gemara beside the video, each line highlighted as it's read.`,
    path: masechtaPath(masechta),
    body,
    ld: jsonLd([breadcrumbs([['DafSync', '/'], [name, masechtaPath(masechta)]])]),
  });
}

export function dafPage(masechta, daf, shiurim, { text = '', details = {}, pictures = new Map() } = {}) {
  const here = shiurim.filter((s) => s.masechta === masechta && s.daf === daf);
  const name = displayName(masechta);
  const title = dafName(masechta, daf);
  const maggidim = [...new Set(here.map((s) => s.maggidId))].map(maggidName);
  const dapim = [...new Set(shiurim.filter((s) => s.masechta === masechta).map((s) => s.daf))].sort((a, b) => a - b);
  const prev = [...dapim].reverse().find((d) => d < daf);
  const next = dapim.find((d) => d > daf);
  const picture = (s) => (pictures.get(s.videoId)
    ? `src="${escapeHtml(resizedPicture(pictures.get(s.videoId), 320, 'webp', { absolute: false }))}"`
    : `src="${escapeHtml(youtubePicture(s, 'mq'))}"`);
  const items = here.map((s) => `<li><a href="${shiurPath(s)}"><img ${picture(s)} alt="" loading="lazy" width="160" height="90"><span><strong>${escapeHtml(maggidName(s.maggidId))}</strong><small>${escapeHtml([maggidChannel(s.maggidId), s.variant.label].filter(Boolean).join(' · '))}</small><br>${escapeHtml(s.label)}</span></a></li>`).join('\n');
  const spellings = otherSpellings(masechta);
  const ref = `${masechta.name} ${daf}a`;
  const body = `<nav class="crumbs" aria-label="Breadcrumb"><a href="/">DafSync</a> › <a href="${masechtaPath(masechta)}">${escapeHtml(name)}</a> › Daf ${daf}</nav>
<h1>${escapeHtml(title)} <span class="he" lang="he" dir="rtl">${escapeHtml(hebrewDaf(masechta, daf))}</span></h1>
<p class="lead">Daf Yomi shiurim on ${escapeHtml(name)} daf ${daf} (${escapeHtml(amudRange(masechta, daf))})${spellings.length ? ` (${escapeHtml(spellings.map((s) => `${s} ${daf}`).join(', '))})` : ''}${maggidim.length ? ` by ${escapeHtml(listNames(maggidim))}` : ''}, with the Gemara beside the video and each line highlighted as the maggid reads it.</p>
<h2>Shiurim on this daf</h2>
<ul class="shiurim">
${items}
</ul>
<p class="by-maggid">More: ${[...new Set(here.map((s) => s.maggidId))].map((id) => `<a href="${maggidMasechtaPath(id, masechta)}">${escapeHtml(maggidName(id))} on ${escapeHtml(name)}</a>`).join(' · ')}</p>
${text ? `<h2>The daf</h2>
<p class="daf-text" lang="he" dir="rtl">${escapeHtml(text)}</p>
<p><a href="/browse/?ref=${encodeURIComponent(ref)}">Open ${escapeHtml(title)} on the Interactive Daf</a></p>` : ''}
<nav class="pager">
${prev ? `<a rel="prev" href="${dafPath(masechta, prev)}">‹ ${escapeHtml(name)} ${prev}</a>` : '<span></span>'}
<a href="${masechtaPath(masechta)}">All of ${escapeHtml(name)}</a>
${next ? `<a rel="next" href="${dafPath(masechta, next)}">${escapeHtml(name)} ${next} ›</a>` : '<span></span>'}
</nav>`;
  const description = `Daf Yomi shiurim on ${dafAmudim(masechta, daf)} (${alsoSpelled(masechta)}${hebrewDaf(masechta, daf)})${maggidim.length ? ` by ${listNames(maggidim)}` : ''}, with the Gemara beside the shiur and each line highlighted as it's read.`;
  return pageShell({
    title: `${dafAmudim(masechta, daf)} Daf Yomi Shiurim with the Gemara Synced | DafSync`,
    description,
    path: dafPath(masechta, daf),
    body,
    ld: jsonLd([
      breadcrumbs([['DafSync', '/'], [name, masechtaPath(masechta)], [`Daf ${daf}`, dafPath(masechta, daf)]]),
      ...here.map((s) => mediaObject(s, details, pictures)),
    ]),
  });
}

// ---------------------------------------------------------------------------
// A maggid's pages: all his shiurim, and his shiurim on one masechta
// ---------------------------------------------------------------------------

const MAGGID_LATEST = 12;
const newestFirst = (a, b) => (b.published || '').localeCompare(a.published || '')
  || MASECHTOS.indexOf(b.masechta) - MASECHTOS.indexOf(a.masechta) || b.daf - a.daf;
const shortDate = (iso) => (isDate(iso) ? new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }) : '');

// What he gives, said once for both pages.
function maggidAbout(id) {
  const maggid = maggidById(id);
  const audio = Boolean(MAGGID_PICTURES[id]);
  const from = maggid?.channelName ? ` of ${maggid.channelName}` : '';
  return `${maggidName(id)}${from} gives a daily Daf Yomi shiur. On DafSync each of his shiurim ${audio ? 'plays' : 'plays as a video'} with the Gemara beside it, and every line of the daf is highlighted as he reads it; tapping a line takes the shiur to that moment.`;
}

function shiurItem(s) {
  const when = shortDate(s.published);
  return `<li><a href="${shiurPath(s)}"><strong>${escapeHtml(dafAmudim(s.masechta, s.daf))}</strong><small lang="he" dir="rtl">${escapeHtml(hebrewDaf(s.masechta, s.daf))}</small><small>${escapeHtml([s.variant.label === 'Shiur' ? '' : s.variant.label, when].filter(Boolean).join(' · ') || 'Shiur')}</small></a></li>`;
}

export function maggidPage(id, shiurim) {
  const his = shiurim.filter((s) => s.maggidId === id);
  const name = maggidName(id);
  const maggid = maggidById(id);
  const masechtos = MASECHTOS.filter((m) => his.some((s) => s.masechta === m));
  const masechtaItems = masechtos.map((m) => {
    const count = new Set(his.filter((s) => s.masechta === m).map((s) => s.daf)).size;
    return `<li><a href="${maggidMasechtaPath(id, m)}"><strong>${escapeHtml(displayName(m))}</strong><small lang="he" dir="rtl">${escapeHtml(m.hebrew)}</small><small>${count} ${count === 1 ? 'daf' : 'dapim'}</small></a></li>`;
  }).join('\n');
  const latest = [...his].sort(newestFirst).slice(0, MAGGID_LATEST).map(shiurItem).join('\n');
  const body = `<nav class="crumbs" aria-label="Breadcrumb"><a href="/">DafSync</a> › ${escapeHtml(name)}</nav>
<h1>${escapeHtml(name)} — Daf Yomi Shiurim</h1>
<p class="lead">${escapeHtml(maggidAbout(id))}</p>
<h2>Latest shiurim</h2>
<ul class="dapim">
${latest}
</ul>
<h2>By masechta</h2>
<ul class="dapim">
${masechtaItems}
</ul>`;
  const channel = maggid?.channelName ? ` — ${maggid.channelName}` : '';
  return pageShell({
    title: `${name} Daf Yomi Shiurim${channel} | DafSync`,
    description: `Every Daf Yomi shiur by ${name}${maggid?.channelName ? ` (${maggid.channelName})` : ''} on DafSync, with the Gemara beside the shiur and each line highlighted as he reads it.${masechtos.length ? ` Masechtos: ${listNames(masechtos.map(displayName))}.` : ''}`,
    path: maggidPath(id),
    body,
    ld: jsonLd([
      breadcrumbs([['DafSync', '/'], [name, maggidPath(id)]]),
      { '@context': 'https://schema.org', ...personLd(id) },
    ]),
  });
}

export function maggidMasechtaPage(id, masechta, shiurim) {
  const his = shiurim.filter((s) => s.maggidId === id && s.masechta === masechta)
    .sort((a, b) => a.daf - b.daf || VARIANTS.indexOf(a.variant) - VARIANTS.indexOf(b.variant));
  const name = maggidName(id);
  const m = displayName(masechta);
  const spellings = otherSpellings(masechta);
  const body = `<nav class="crumbs" aria-label="Breadcrumb"><a href="/">DafSync</a> › <a href="${maggidPath(id)}">${escapeHtml(name)}</a> › ${escapeHtml(m)}</nav>
<h1>${escapeHtml(m)} — ${escapeHtml(name)} <span class="he" lang="he" dir="rtl">${escapeHtml(masechta.hebrew)}</span></h1>
<p class="lead">${escapeHtml(name)}'s Daf Yomi shiurim on Masechta ${escapeHtml(m)}${spellings.length ? ` (also spelled ${escapeHtml(spellings.join(', '))})` : ''}, daf by daf. ${escapeHtml(maggidAbout(id))}</p>
<h2>Dapim</h2>
<ul class="dapim">
${his.map(shiurItem).join('\n')}
</ul>
<p class="by-maggid"><a href="${masechtaPath(masechta)}">All shiurim on ${escapeHtml(m)}</a> · <a href="${maggidPath(id)}">All of ${escapeHtml(name)}'s shiurim</a></p>`;
  return pageShell({
    title: `${m} Daf Yomi with ${name} — Every Daf | DafSync`,
    description: `${name}'s Daf Yomi shiurim on Masechta ${m} (${alsoSpelled(masechta)}${masechta.hebrew}), each with the Gemara beside it and every line highlighted as it's read.`,
    path: maggidMasechtaPath(id, masechta),
    body,
    ld: jsonLd([breadcrumbs([['DafSync', '/'], [name, maggidPath(id)], [m, maggidMasechtaPath(id, masechta)]])]),
  });
}

// ---------------------------------------------------------------------------
// The shiur page: the player, under its own address and title
// ---------------------------------------------------------------------------

// Takes the player's head tags that describe the page and puts this shiur's
// in their place; the first thing the page runs moves the address bar to the
// player's own address, so everything below works as on /player/.
export function shiurPage(playerHtml, shiur, { mode = 'split', extra = null, details = {}, pictures = new Map() } = {}) {
  const title = shiurTitle(shiur);
  const description = shiurDescription(shiur);
  const path = shiurPath(shiur);
  const name = displayName(shiur.masechta);
  const head = `
  <script>history.replaceState(history.state, '', ${JSON.stringify(playerUrl(shiur, mode, extra)).replace(/</g, '\\u003c')});</script>
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <link rel="canonical" href="${absolute(path)}">
  <meta property="og:type" content="video.other">
  <meta property="og:site_name" content="DafSync">
  <meta property="og:url" content="${absolute(path)}">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:image" content="${escapeHtml(pictures.get(shiur.videoId) ? resizedPicture(pictures.get(shiur.videoId), 1200, 'jpg') : youtubePicture(shiur))}">
  <meta name="twitter:card" content="summary_large_image">
  ${jsonLd([
    breadcrumbs([['DafSync', '/'], [name, masechtaPath(shiur.masechta)], [`Daf ${shiur.daf}`, dafPath(shiur.masechta, shiur.daf)], [maggidName(shiur.maggidId), path]]),
    mediaObject(shiur, details, pictures),
  ])}`;
  let html = playerHtml
    .replace(/<title>[\s\S]*?<\/title>\s*/i, '')
    .replace(/<meta\s+name="(?:description|robots|twitter:[^"]+)"[^>]*>\s*/gi, '')
    .replace(/<meta\s+property="og:[^"]+"[^>]*>\s*/gi, '')
    .replace(/<link\s+rel="canonical"[^>]*>\s*/gi, '')
    // The player writes its files as ../app.js, which from /player/ is /app.js.
    // Spelled that way here so the browser's look-ahead loader, which fetches
    // them before the address change above runs, asks for the right files.
    .replace(/(\s(?:src|href)=")\.\.\//g, '$1/')
    .replace(/<h1 id="lectureTitle">[^<]*<\/h1>/, `<h1 id="lectureTitle">${escapeHtml(`${dafName(shiur.masechta, shiur.daf)} — ${maggidName(shiur.maggidId)}`)}</h1>`);
  const charset = /<meta\s+charset="[^"]*"\s*\/?>/i.exec(html);
  if (!charset) throw new Error('The player page has no <meta charset>.');
  html = html.slice(0, charset.index + charset[0].length) + head + html.slice(charset.index + charset[0].length);
  return html;
}

// ---------------------------------------------------------------------------
// The sitemap
// ---------------------------------------------------------------------------

// Each page with the day it last changed: a shiur's page on the day the shiur
// was posted, a daf's and a masechta's on the day of their newest shiur, the
// home page on the day of the newest of all. A page whose shiurim have no date
// (linked before dates were kept) is listed without one rather than with
// today's: a date that is always "today" teaches a search engine to ignore
// all of them.
export function sitemap(shiurim) {
  const pages = new Map([['/', ''], ['/browse/', ''], ['/chaburah/', '']]);
  const maggidPages = new Map();
  const noteIn = (map) => (path, day) => {
    if (!map.has(path) || day > map.get(path)) map.set(path, day);
  };
  const note = noteIn(pages);
  const noteMaggid = noteIn(maggidPages);
  for (const s of shiurim) {
    const day = isDate(s.published) ? s.published.slice(0, 10) : '';
    note('/', day);
    note(masechtaPath(s.masechta), day);
    note(dafPath(s.masechta, s.daf), day);
    note(shiurPath(s), day);
    noteMaggid(maggidPath(s.maggidId), day);
    noteMaggid(maggidMasechtaPath(s.maggidId, s.masechta), day);
  }
  // Home first, then the site's own pages, then each masechta's in the
  // catalog's order (a Map keeps the order its keys were first set in), then
  // each maggid's page followed by his masechtos.
  const entries = [...pages, ...maggidPages].map(([path, day]) => `  <url><loc>${escapeHtml(absolute(path))}</loc>${day ? `<lastmod>${day}</lastmod>` : ''}</url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</urlset>\n`;
}

// ---------------------------------------------------------------------------
// The home page: index.html, with links a search engine can follow
// ---------------------------------------------------------------------------

export const HOME_MARKER = '<!--dafsync:site-index-->';
const HOME_LATEST_DAPIM = 12;

// index.html builds its lists of shiurim in the browser, and those open the
// player, so nothing in the page as it is first read leads to a masechta's or
// a daf's own page. This writes those links in where index.html marks the
// place: every masechta that has a shiur, the newest dapim, and a few
// sentences saying what the site is and whose shiurim it has.
export function homePage(html, shiurim) {
  if (!html.includes(HOME_MARKER) || !shiurim.length) return html;
  const dapim = new Map(); // masechta -> Set of dapim
  for (const s of shiurim) {
    if (!dapim.has(s.masechta)) dapim.set(s.masechta, new Set());
    dapim.get(s.masechta).add(s.daf);
  }
  // In the order of Shas, which is the order Daf Yomi learns them.
  const masechtos = MASECHTOS.filter((m) => dapim.has(m));
  const masechtaItems = masechtos.map((m) => {
    const count = dapim.get(m).size;
    return `<li><a href="${masechtaPath(m)}">${escapeHtml(displayName(m))} <span lang="he" dir="rtl">${escapeHtml(m.hebrew)}</span> <small>${count} ${count === 1 ? 'daf' : 'dapim'}</small></a></li>`;
  }).join('\n');
  const latest = [...masechtos].reverse()
    .flatMap((m) => [...dapim.get(m)].sort((a, b) => b - a).map((daf) => [m, daf]))
    .slice(0, HOME_LATEST_DAPIM);
  const latestItems = latest.map(([m, daf]) => `<li><a href="${dafPath(m, daf)}">${escapeHtml(dafName(m, daf))} <span lang="he" dir="rtl">${escapeHtml(hebrewDaf(m, daf))}</span></a></li>`).join('\n');
  const withShiurim = MAGGIDIM.filter((m) => shiurim.some((s) => s.maggidId === m.id));
  const maggidim = withShiurim.map((m) => `${maggidName(m.id)}${m.channelName ? ` (${m.channelName})` : ''}`);
  const maggidItems = withShiurim.map((m) => `<li><a href="${maggidPath(m.id)}">${escapeHtml(maggidName(m.id))}${m.channelName ? ` <small>${escapeHtml(m.channelName)}</small>` : ''}</a></li>`).join('\n');
  const section = `<section class="site-index" aria-labelledby="siteIndexTitle">
<h2 id="siteIndexTitle">Browse by masechta</h2>
<ul>
${masechtaItems}
</ul>
<h2>Latest dapim</h2>
<ul>
${latestItems}
</ul>
<h2>By maggid</h2>
<ul>
${maggidItems}
</ul>
<p class="site-index-about">DafSync plays Daf Yomi shiurim by ${escapeHtml(listNames(maggidim))} with the daf beside the shiur. Each line of the Gemara is highlighted as the maggid reads it, and tapping a line takes the shiur to the moment it is read.</p>
</section>`;
  return html.replace(HOME_MARKER, section);
}

const HOME_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  // As Netlify serves index.html itself: the browser asks again each visit.
  'Cache-Control': 'public, max-age=0, must-revalidate',
  'Netlify-CDN-Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
};

// The home page must open whatever else is down: without the catalog it is
// index.html as it is, and if index.html itself cannot be read here the
// browser is sent to fetch it directly.
async function home(url, env) {
  let html;
  try {
    const response = await fetchWithTimeout(new URL('/index.html', url.origin));
    if (!response.ok) throw new Error(`index.html: ${response.status}`);
    html = await response.text();
  } catch {
    return Response.redirect(`${url.origin}/index.html${url.search}`, 302);
  }
  try {
    html = homePage(html, shiurimFromCatalog(await loadCatalog(env)));
  } catch {
    // The page as it is.
    return new Response(html, { headers: { ...HOME_HEADERS, 'Netlify-CDN-Cache-Control': 'public, s-maxage=60' } });
  }
  return new Response(html, { headers: HOME_HEADERS });
}

// ---------------------------------------------------------------------------
// The player's own address
// ---------------------------------------------------------------------------

// /player/?ref=... is the address every link in the site used, and the one a
// shiur page moves the address bar to, so it is the address people share and
// search engines find. It says noindex, so a search engine sent there drops it;
// the shiur page is the one it should keep. A player address that names a
// shiur in the catalog is sent on to that shiur's page, everything else in the
// address kept. Anything else -- a scan of a printed page, a daf with no shiur
// posted yet, no ref at all -- is the player as it is.
const PLAYER_REDIRECT_HEADERS = {
  'Cache-Control': 'public, max-age=300',
  'Netlify-CDN-Cache-Control': 'public, s-maxage=3600',
  'Netlify-Vary': 'query',
};

async function player(url, env) {
  if (url.searchParams.has('ref') && !url.searchParams.has('view')) {
    let shiur = null;
    try {
      shiur = shiurForPlayer(url.searchParams, shiurimFromCatalog(await loadCatalog(env)));
    } catch {
      // The catalog is down: the player as it is.
    }
    if (shiur) {
      return new Response(null, {
        status: 301, headers: { Location: shiurAddressFor(shiur, url.searchParams), ...PLAYER_REDIRECT_HEADERS },
      });
    }
  }
  let html;
  try {
    const response = await fetchWithTimeout(new URL('/player/index.html', url.origin));
    if (!response.ok) throw new Error(`player page: ${response.status}`);
    html = await response.text();
  } catch {
    return Response.redirect(`${url.origin}/player/index.html${url.search}`, 302);
  }
  return new Response(html, { headers: { ...PLAYER_HEADERS, 'Cache-Control': 'public, max-age=0, must-revalidate', 'Netlify-CDN-Cache-Control': 'public, s-maxage=300' } });
}

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'public, max-age=300',
  'Netlify-CDN-Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
};

// The player's page, wherever it is served: the camera is let in for scanning
// a printed daf, as netlify.toml lets it in on /player/.
const PLAYER_HEADERS = {
  ...PAGE_HEADERS,
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
  'Netlify-Vary': 'query',
};

function notFound(message = 'There is no page at this address.') {
  const body = `<h1>Not found</h1><p class="lead">${escapeHtml(message)}</p><p><a href="/">Back to DafSync</a></p>`;
  return new Response(pageShell({ title: 'Not found | DafSync', description: message, path: '/', body, noindex: true }), {
    status: 404, headers: { ...PAGE_HEADERS, 'Netlify-CDN-Cache-Control': 'public, s-maxage=300' },
  });
}

export async function handle(request, env = {}) {
  const url = new URL(request.url);
  if (url.pathname !== '/sitemap.xml' && !url.pathname.endsWith('/')) {
    return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);
  }
  const route = parseRoute(url.pathname);
  if (!route) return notFound();
  if (route.kind === 'home') return home(url, env);
  if (route.kind === 'player') return player(url, env);

  let shiurim;
  try {
    const [catalog, lists] = await Promise.all([loadCatalog(env), loadMaggidLists(env)]);
    shiurim = withListDetails(shiurimFromCatalog(catalog), lists);
  } catch (error) {
    return new Response('The shiur list could not be loaded just now. Please try again in a minute.', {
      status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '60', 'Cache-Control': 'no-store' },
    });
  }

  if (route.kind === 'sitemap') {
    return new Response(sitemap(shiurim), {
      headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'Netlify-CDN-Cache-Control': 'public, s-maxage=3600' },
    });
  }
  if (route.kind === 'maggid') {
    if (!shiurim.some((s) => s.maggidId === route.maggidId)) return notFound(`No shiurim by ${maggidName(route.maggidId)} yet.`);
    return new Response(maggidPage(route.maggidId, shiurim), { headers: PAGE_HEADERS });
  }
  if (route.kind === 'maggid-masechta') {
    if (!shiurim.some((s) => s.maggidId === route.maggidId && s.masechta === route.masechta)) {
      return notFound(`No shiurim by ${maggidName(route.maggidId)} on ${displayName(route.masechta)} yet.`);
    }
    return new Response(maggidMasechtaPage(route.maggidId, route.masechta, shiurim), { headers: PAGE_HEADERS });
  }
  if (route.kind === 'masechta') {
    if (!shiurim.some((s) => s.masechta === route.masechta)) return notFound(`No shiurim on ${displayName(route.masechta)} yet.`);
    return new Response(masechtaPage(route.masechta, shiurim), { headers: PAGE_HEADERS });
  }
  if (route.kind === 'daf') {
    const here = shiurim.filter((s) => s.masechta === route.masechta && s.daf === route.daf);
    if (!here.length) return notFound(`No shiurim on ${dafName(route.masechta, route.daf)} yet.`);
    const [text, details, pictures] = await Promise.all([
      openingLines(route.masechta, route.daf),
      // Asked only about a shiur whose date the catalog does not have. R' Bornstein's
      // shiurim come from Lakewood Daf Yomi, never YouTube: not asked about there.
      videoDetails(here.filter((s) => !MAGGID_PICTURES[s.maggidId] && !s.published).map((s) => s.videoId), env.YOUTUBE_API_KEY),
      shiurPictures(here),
    ]);
    return new Response(dafPage(route.masechta, route.daf, shiurim, { text, details, pictures }), { headers: PAGE_HEADERS });
  }
  const shiur = shiurim.find((s) => s.masechta === route.masechta && s.daf === route.daf
    && s.maggidId === route.maggidId && s.variant === route.variant);
  if (!shiur) {
    const daf = shiurim.some((s) => s.masechta === route.masechta && s.daf === route.daf);
    return daf ? Response.redirect(`${url.origin}${dafPath(route.masechta, route.daf)}`, 302) : notFound();
  }
  const [playerResponse, details, pictures] = await Promise.all([
    fetchWithTimeout(new URL('/player/index.html', url.origin)),
    videoDetails(MAGGID_PICTURES[shiur.maggidId] || shiur.published ? [] : [shiur.videoId], env.YOUTUBE_API_KEY),
    shiurPictures([shiur]),
  ]);
  if (!playerResponse.ok) throw new Error(`player page: ${playerResponse.status}`);
  const mode = /^[a-z-]{1,20}$/.test(url.searchParams.get('mode') || '') ? url.searchParams.get('mode') : 'split';
  return new Response(shiurPage(await playerResponse.text(), shiur, { mode, extra: url.searchParams, details, pictures }), { headers: PLAYER_HEADERS });
}

export default async (request) => handle(request, {
  GITHUB_DISPATCH_TOKEN: Netlify.env.get('GITHUB_DISPATCH_TOKEN'),
  YOUTUBE_API_KEY: Netlify.env.get('YOUTUBE_API_KEY'),
});

// Netlify reads this without running the module, so the addresses are spelled
// out: the home page, the player, every masechta's slug (shared/masechtos.mjs)
// and every maggid's id (shared/maggidim.mjs), with and without a path under
// it, and the sitemap. tests/functions/seo-pages.test.mjs
// checks the list matches MASECHTOS.
export const config = {
  path: [
    '/', '/player/',
    '/berachos', '/berachos/*', '/shabbos', '/shabbos/*', '/eruvin', '/eruvin/*', '/pesachim',
    '/pesachim/*', '/yoma', '/yoma/*', '/sukkah', '/sukkah/*', '/beitzah', '/beitzah/*',
    '/rosh-hashanah', '/rosh-hashanah/*', '/taanis', '/taanis/*', '/megillah', '/megillah/*',
    '/moed-katan', '/moed-katan/*', '/chagigah', '/chagigah/*', '/yevamos', '/yevamos/*',
    '/kesubos', '/kesubos/*', '/nedarim', '/nedarim/*', '/nazir', '/nazir/*', '/sotah', '/sotah/*',
    '/gittin', '/gittin/*', '/kiddushin', '/kiddushin/*', '/bava-kamma', '/bava-kamma/*',
    '/bava-metzia', '/bava-metzia/*', '/bava-basra', '/bava-basra/*', '/sanhedrin', '/sanhedrin/*',
    '/makkos', '/makkos/*', '/shevuos', '/shevuos/*', '/avodah-zarah', '/avodah-zarah/*',
    '/horayos', '/horayos/*', '/zevachim', '/zevachim/*', '/menachos', '/menachos/*', '/chullin',
    '/chullin/*', '/bechoros', '/bechoros/*', '/eruchin', '/eruchin/*', '/temurah', '/temurah/*',
    '/kereisos', '/kereisos/*', '/meilah', '/meilah/*', '/niddah', '/niddah/*',
    '/stefansky', '/stefansky/*', '/bornstein', '/bornstein/*', '/sitemap.xml',
  ],
};
