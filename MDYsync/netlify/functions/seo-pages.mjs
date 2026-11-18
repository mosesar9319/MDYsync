// The pages Google ranks: one per masechta (/bechoros/), one per daf
// (/bechoros/58/) listing every shiur on it, and one per shiur
// (/bechoros/58/bornstein/), which is the player itself under an address and
// a title of its own. Plus /sitemap.xml listing all of them.
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
  MASECHTOS, masechtaByName, masechtaBySlug, displayName, otherSpellings, hebrewNumeral,
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

export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------------------------
// The catalog, as one flat list of shiurim
// ---------------------------------------------------------------------------

// catalog.json (tools/build-video-catalog.mjs): tractates.<name> = rows of the
// default maggid, maggidim.<id>.tractates.<name> = everyone else's. A row is
// { daf, regularEn?, chazarahEn?, regularHe?, chazarahHe? }, each
// { videoId, label, amud, liveBroadcast? }. A livestream is left out: it is
// replaced by the finished upload once that is posted.
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
          out.push({ masechta, daf, maggidId, variant, videoId: video.videoId, label: video.label || '', amud: video.amud === 'b' ? 'b' : 'a' });
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
export const shiurPath = (s) => `/${s.masechta.slug}/${s.daf}/${s.maggidId}/${s.variant.segment ? `${s.variant.segment}/` : ''}`;
const absolute = (path) => `${PUBLIC_SITE_ORIGIN}${path}`;

// What a request asks for, or null for an address that names nothing.
export function parseRoute(pathname) {
  if (pathname === '/sitemap.xml') return { kind: 'sitemap' };
  const parts = pathname.split('/').filter(Boolean);
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
export function playerUrl(shiur, mode = 'split') {
  const params = new URLSearchParams({ ref: `${shiur.masechta.name} ${shiur.daf}${shiur.amud}` });
  if (shiur.variant.variant) params.set('variant', shiur.variant.variant);
  if (shiur.variant.language) params.set('language', shiur.variant.language);
  if (shiur.maggidId !== DEFAULT_MAGGID_ID) params.set('maggid', shiur.maggidId);
  if (mode && mode !== 'standard') params.set('mode', mode);
  return `/player/?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

const hebrewDaf = (m, daf) => `${m.hebrew} ${hebrewNumeral(daf)}`;
const dafName = (m, daf) => `${displayName(m)} ${daf}`;
const maggidName = (id) => maggidById(id)?.name || id;
const maggidChannel = (id) => maggidById(id)?.channelName || '';

function listNames(names) {
  if (names.length <= 1) return names.join('');
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function shiurTitle(s) {
  const word = s.variant.titleWord ? ` ${s.variant.titleWord}` : '';
  return `${dafName(s.masechta, s.daf)}${word} — ${maggidName(s.maggidId)}, Daf Yomi Shiur | DafSync`;
}

function shiurDescription(s) {
  const kind = s.variant.variant === 'chazarah' ? 'chazarah' : 'Daf Yomi shiur';
  const lang = s.variant.language ? ' in Hebrew' : '';
  return `Watch ${maggidName(s.maggidId)}'s ${kind}${lang} on ${dafName(s.masechta, s.daf)} (${hebrewDaf(s.masechta, s.daf)}) `
    + 'with the daf beside the video, each line of the Gemara highlighted as it\'s read.';
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
export function mdyPoster(s) {
  return MdyFiles.posterUrl(
    {
      tractate: s.masechta.name, daf: s.daf, variant: s.variant.variant || 'regular',
      language: s.variant.language === 'hebrew' ? 'he' : 'en', maggid: s.maggidId,
    },
    { title: s.label },
  );
}
// Absolute for what other sites read (og:image, the VideoObject); relative
// for the page's own <img>, so it works on deploy previews too.
export function resizedPicture(original, width, format = 'webp', { absolute = true } = {}) {
  const path = `/.netlify/images?url=${encodeURIComponent(original)}&w=${width}&fm=${format}&q=75`;
  return absolute ? `${PUBLIC_SITE_ORIGIN}${path}` : path;
}
const youtubePicture = (s, size = 'hq') => `https://i.ytimg.com/vi/${s.videoId}/${size}default.jpg`;
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

function videoObject(s, details, pictures = new Map()) {
  const d = details?.[s.videoId];
  if (!d?.publishedAt) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'VideoObject',
    name: s.label || `${dafName(s.masechta, s.daf)} — ${maggidName(s.maggidId)}`,
    description: shiurDescription(s),
    thumbnailUrl: pictures.get(s.videoId) ? resizedPicture(pictures.get(s.videoId), 1280, 'jpg') : youtubePicture(s),
    uploadDate: d.publishedAt,
    ...(d.duration ? { duration: d.duration } : {}),
    embedUrl: `https://www.youtube.com/embed/${s.videoId}`,
    url: absolute(shiurPath(s)),
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
.dapim small{display:block;color:var(--muted)}footer{color:var(--muted);font-size:14px;text-align:center;padding:24px 16px}
@media (max-width:560px){.shiurim img{width:112px}h1{font-size:25px}}`;

function pageShell({ title, description, path, body, ld = '', noindex = false }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
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
  const body = `<nav class="crumbs" aria-label="Breadcrumb"><a href="/">DafSync</a> › ${escapeHtml(name)}</nav>
<h1>Masechta ${escapeHtml(name)} <span class="he" lang="he" dir="rtl">${escapeHtml(masechta.hebrew)}</span></h1>
<p class="lead">Daf Yomi shiurim on ${escapeHtml(name)}${spellings.length ? ` (also spelled ${escapeHtml(spellings.join(', '))})` : ''}, with the Gemara beside the video and each line highlighted as the maggid reads it. ${dapim.length} of its ${total} dapim have a shiur so far.</p>
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
<p class="lead">Daf Yomi shiurim on ${escapeHtml(name)} daf ${daf}${spellings.length ? ` (${escapeHtml(spellings.map((s) => `${s} ${daf}`).join(', '))})` : ''}${maggidim.length ? ` by ${escapeHtml(listNames(maggidim))}` : ''}, with the Gemara beside the video and each line highlighted as the maggid reads it.</p>
<h2>Shiurim on this daf</h2>
<ul class="shiurim">
${items}
</ul>
${text ? `<h2>The daf</h2>
<p class="daf-text" lang="he" dir="rtl">${escapeHtml(text)}</p>
<p><a href="/browse/?ref=${encodeURIComponent(ref)}">Open ${escapeHtml(title)} on the Interactive Daf</a></p>` : ''}
<nav class="pager">
${prev ? `<a rel="prev" href="${dafPath(masechta, prev)}">‹ ${escapeHtml(name)} ${prev}</a>` : '<span></span>'}
<a href="${masechtaPath(masechta)}">All of ${escapeHtml(name)}</a>
${next ? `<a rel="next" href="${dafPath(masechta, next)}">${escapeHtml(name)} ${next} ›</a>` : '<span></span>'}
</nav>`;
  const description = `Watch ${title} (${hebrewDaf(masechta, daf)}) Daf Yomi shiurim${maggidim.length ? ` by ${listNames(maggidim)}` : ''} with the Gemara beside the video, each line highlighted as it's read.`;
  return pageShell({
    title: `${title} Daf Yomi Shiur — Video with the Daf Synced | DafSync`,
    description,
    path: dafPath(masechta, daf),
    body,
    ld: jsonLd([
      breadcrumbs([['DafSync', '/'], [name, masechtaPath(masechta)], [`Daf ${daf}`, dafPath(masechta, daf)]]),
      ...here.map((s) => videoObject(s, details, pictures)),
    ]),
  });
}

// ---------------------------------------------------------------------------
// The shiur page: the player, under its own address and title
// ---------------------------------------------------------------------------

// Takes the player's head tags that describe the page and puts this shiur's
// in their place; the first thing the page runs moves the address bar to the
// player's own address, so everything below works as on /player/.
export function shiurPage(playerHtml, shiur, { mode = 'split', details = {}, pictures = new Map() } = {}) {
  const title = shiurTitle(shiur);
  const description = shiurDescription(shiur);
  const path = shiurPath(shiur);
  const name = displayName(shiur.masechta);
  const head = `
  <script>history.replaceState(history.state, '', ${JSON.stringify(playerUrl(shiur, mode)).replace(/</g, '\\u003c')});</script>
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
    videoObject(shiur, details, pictures),
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

export function sitemap(shiurim, lastmod) {
  const urls = new Set(['/', '/browse/', '/chaburah/']);
  for (const s of shiurim) {
    urls.add(masechtaPath(s.masechta));
    urls.add(dafPath(s.masechta, s.daf));
    urls.add(shiurPath(s));
  }
  const day = String(lastmod || '').slice(0, 10);
  const entries = [...urls].map((path) => `  <url><loc>${escapeHtml(absolute(path))}</loc>${day ? `<lastmod>${day}</lastmod>` : ''}</url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</urlset>\n`;
}

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'public, max-age=300',
  'Netlify-CDN-Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
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

  let shiurim;
  let catalog;
  try {
    catalog = await loadCatalog(env);
    shiurim = shiurimFromCatalog(catalog);
  } catch (error) {
    return new Response('The shiur list could not be loaded just now. Please try again in a minute.', {
      status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '60', 'Cache-Control': 'no-store' },
    });
  }

  if (route.kind === 'sitemap') {
    return new Response(sitemap(shiurim, catalog.generatedAt), {
      headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'Netlify-CDN-Cache-Control': 'public, s-maxage=3600' },
    });
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
      videoDetails(here.map((s) => s.videoId), env.YOUTUBE_API_KEY),
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
    videoDetails([shiur.videoId], env.YOUTUBE_API_KEY),
    shiurPictures([shiur]),
  ]);
  if (!playerResponse.ok) throw new Error(`player page: ${playerResponse.status}`);
  const mode = /^[a-z-]{1,20}$/.test(url.searchParams.get('mode') || '') ? url.searchParams.get('mode') : 'split';
  return new Response(shiurPage(await playerResponse.text(), shiur, { mode, details, pictures }), { headers: PAGE_HEADERS });
}

export default async (request) => handle(request, {
  GITHUB_DISPATCH_TOKEN: Netlify.env.get('GITHUB_DISPATCH_TOKEN'),
  YOUTUBE_API_KEY: Netlify.env.get('YOUTUBE_API_KEY'),
});

// Netlify reads this without running the module, so the addresses are spelled
// out: every masechta's slug (shared/masechtos.mjs), with and without a path
// under it, and the sitemap. tests/functions/seo-pages.test.mjs checks the
// list matches MASECHTOS.
export const config = {
  path: [
    '/berachos', '/berachos/*', '/shabbos', '/shabbos/*', '/eruvin', '/eruvin/*', '/pesachim',
    '/pesachim/*', '/yoma', '/yoma/*', '/sukkah', '/sukkah/*', '/beitzah', '/beitzah/*',
    '/rosh-hashanah', '/rosh-hashanah/*', '/taanis', '/taanis/*', '/megillah', '/megillah/*',
    '/moed-katan', '/moed-katan/*', '/chagigah', '/chagigah/*', '/yevamos', '/yevamos/*',
    '/kesubos', '/kesubos/*', '/nedarim', '/nedarim/*', '/nazir', '/nazir/*', '/sotah', '/sotah/*',
    '/gittin', '/gittin/*', '/kiddushin', '/kiddushin/*', '/bava-kamma', '/bava-kamma/*',
    '/bava-metzia', '/bava-metzia/*', '/bava-basra', '/bava-basra/*', '/sanhedrin', '/sanhedrin/*',
    '/makkos', '/makkos/*', '/shevuos', '/shevuos/*', '/avodah-zarah', '/avodah-zarah/*',
    '/horayos', '/horayos/*', '/zevachim', '/zevachim/*', '/menachos', '/menachos/*', '/chullin',
    '/chullin/*', '/bechoros', '/bechoros/*', '/arachin', '/arachin/*', '/temurah', '/temurah/*',
    '/kereisos', '/kereisos/*', '/meilah', '/meilah/*', '/niddah', '/niddah/*', '/sitemap.xml',
  ],
};
