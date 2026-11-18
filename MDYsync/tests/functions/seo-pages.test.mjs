// netlify/functions/seo-pages.mjs: the masechta, daf and shiur pages and the
// sitemap that search engines read.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  config, parseRoute, shiurimFromCatalog, masechtaPage, dafPage, shiurPage, sitemap, handle,
  playerUrl, shiurPath, resetCatalogCache, mdyPoster, shiurPictures,
} from '../../netlify/functions/seo-pages.mjs';
import { MASECHTOS, MASECHTA_SLUGS, masechtaBySlug, hebrewNumeral, otherSpellings } from '../../shared/masechtos.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PLAYER_HTML = fs.readFileSync(path.join(ROOT, 'player/index.html'), 'utf8');

const CATALOG = {
  generatedAt: '2026-11-16T20:25:18.829Z',
  tractates: {
    Bekhorot: [
      { daf: 57, regularEn: { videoId: 'AAAAAAAAAA1', label: "Daf Yomi Bechoros Daf 57 by R' Eli Stefansky", amud: 'a' } },
      {
        daf: 58,
        regularEn: { videoId: '0n7fE-jS0NE', label: "Daf Yomi Bechoros Daf 58 by R' Eli Stefansky", amud: 'a' },
        chazarahEn: { videoId: 'CCCCCCCCCC1', label: 'CHAZARAH - Bechoros Daf 58', amud: 'a' },
        regularHe: { videoId: 'LIVELIVELI1', label: 'live', amud: 'a', liveBroadcast: true },
      },
    ],
    NotATractate: [{ daf: 3, regularEn: { videoId: 'x', label: 'x', amud: 'a' } }],
  },
  maggidim: { bornstein: { tractates: { Bekhorot: [{ daf: 58, regularEn: { videoId: 'TWCiP96dKXU', label: 'Bechoros 58', amud: 'a' } }] } } },
};
const SHIURIM = shiurimFromCatalog(CATALOG);
const BECHOROS = masechtaBySlug('bechoros');

test('every masechta has an address, and the home page links with the same slugs', () => {
  const expected = MASECHTOS.flatMap((m) => [`/${m.slug}`, `/${m.slug}/*`]).concat('/sitemap.xml');
  assert.deepEqual(config.path, expected);
  const home = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const table = JSON.parse(`{${/const MASECHTA_SLUGS = \{([^}]*)\};/.exec(home)[1]}}`);
  assert.deepEqual(table, MASECHTA_SLUGS);
  // No slug may shadow a real page of the site.
  for (const m of MASECHTOS) assert.equal(fs.existsSync(path.join(ROOT, m.slug)), false, m.slug);
});

test('names, numerals and spellings', () => {
  assert.equal(hebrewNumeral(58), 'נח');
  assert.equal(hebrewNumeral(15), 'טו');
  assert.equal(hebrewNumeral(16), 'טז');
  assert.equal(hebrewNumeral(120), 'קכ');
  assert.deepEqual(otherSpellings(BECHOROS), ['Bekhorot', 'Bechorot']);
});

test('addresses: what each one names', () => {
  assert.deepEqual(parseRoute('/sitemap.xml'), { kind: 'sitemap' });
  assert.equal(parseRoute('/bechoros/').kind, 'masechta');
  assert.deepEqual({ ...parseRoute('/bechoros/58/'), masechta: undefined }, { kind: 'daf', masechta: undefined, daf: 58 });
  const shiur = parseRoute('/bechoros/58/bornstein/');
  assert.equal(shiur.kind, 'shiur');
  assert.equal(shiur.maggidId, 'bornstein');
  assert.equal(shiur.variant.key, 'regularEn');
  assert.equal(parseRoute('/bechoros/58/stefansky/chazarah-hebrew/').variant.key, 'chazarahHe');
  assert.equal(parseRoute('/bechoros/fifty/'), null);
  assert.equal(parseRoute('/bechoros/58/nobody/'), null);
  assert.equal(parseRoute('/bechoros/58/bornstein/director-cut/'), null);
  assert.equal(parseRoute('/nosuchmasechta/'), null);
});

test('the catalog becomes one shiur per recording, livestreams and unknown masechtos left out', () => {
  assert.deepEqual(SHIURIM.map((s) => `${shiurPath(s)} ${s.videoId}`), [
    '/bechoros/57/stefansky/ AAAAAAAAAA1',
    '/bechoros/58/stefansky/ 0n7fE-jS0NE',
    '/bechoros/58/stefansky/chazarah/ CCCCCCCCCC1',
    '/bechoros/58/bornstein/ TWCiP96dKXU',
  ]);
  assert.equal(playerUrl(SHIURIM[3]), '/player/?ref=Bekhorot+58a&maggid=bornstein&mode=split');
  assert.equal(playerUrl(SHIURIM[2], 'standard'), '/player/?ref=Bekhorot+58a&variant=chazarah');
});

test('a daf page: its title, heading, every shiur, the daf text, and its neighbours', () => {
  const html = dafPage(BECHOROS, 58, SHIURIM, { text: 'אמר רב', details: { 'TWCiP96dKXU': { publishedAt: '2026-06-01T10:00:00Z', duration: 'PT1H4M' } } });
  assert.match(html, /<title>Bechoros 58 Daf Yomi Shiur — Video with the Daf Synced \| DafSync<\/title>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/dafsync.com\/bechoros\/58\/">/);
  assert.match(html, /<h1>Bechoros 58 <span class="he" lang="he" dir="rtl">בכורות נח<\/span><\/h1>/);
  assert.match(html, /Bekhorot 58, Bechorot 58/);
  assert.match(html, /by R&#39; Eli Stefansky and R&#39; Sruly Bornstein/);
  for (const href of ['/bechoros/58/stefansky/', '/bechoros/58/stefansky/chazarah/', '/bechoros/58/bornstein/']) {
    assert.ok(html.includes(`href="${href}"`), href);
  }
  assert.match(html, /Lakewood Daf Yomi/);
  assert.match(html, /<p class="daf-text" lang="he" dir="rtl">אמר רב<\/p>/);
  assert.match(html, /rel="prev" href="\/bechoros\/57\/"/);
  assert.doesNotMatch(html, /rel="next"/);
  const ld = [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
  assert.deepEqual(ld.map((o) => o['@type']), ['BreadcrumbList', 'VideoObject']);   // only the video with a known date
  assert.equal(ld[1].embedUrl, 'https://www.youtube.com/embed/TWCiP96dKXU');
  assert.equal(ld[1].uploadDate, '2026-06-01T10:00:00Z');
});

test('a masechta page lists only the dapim that have a shiur', () => {
  const html = masechtaPage(BECHOROS, SHIURIM);
  assert.match(html, /<title>Bechoros Daf Yomi Shiurim/);
  assert.ok(html.includes('href="/bechoros/57/"') && html.includes('href="/bechoros/58/"'));
  assert.match(html, /2 of its 60 dapim have a shiur so far/);
});

test('a shiur page is the player under its own address and title', () => {
  const shiur = SHIURIM[3];
  const html = shiurPage(PLAYER_HTML, shiur);
  // The very first script moves the address bar to the player's own address.
  const head = html.slice(0, html.indexOf('</head>'));
  assert.ok(head.indexOf('history.replaceState') < head.indexOf('<script', head.indexOf('history.replaceState') + 1));
  assert.ok(head.indexOf('history.replaceState') < head.search(/<link rel="stylesheet"/));
  assert.match(head, /history\.replaceState\(history\.state, '', "\/player\/\?ref=Bekhorot\+58a&maggid=bornstein&mode=split"\)/);
  assert.match(head, /<title>Bechoros 58 — R&#39; Sruly Bornstein, Daf Yomi Shiur \| DafSync<\/title>/);
  assert.match(head, /<link rel="canonical" href="https:\/\/dafsync.com\/bechoros\/58\/bornstein\/">/);
  // The player's own description, robots, canonical and share tags are gone.
  assert.equal((head.match(/<title>/g) || []).length, 1);
  assert.equal((head.match(/rel="canonical"/g) || []).length, 1);
  assert.equal((head.match(/name="description"/g) || []).length, 1);
  assert.doesNotMatch(head, /name="robots"/);
  assert.equal((head.match(/property="og:url"/g) || []).length, 1);
  assert.match(html, /<h1 id="lectureTitle">Bechoros 58 — R&#39; Sruly Bornstein<\/h1>/);
  // Its files are asked for from the site root, as they are from /player/.
  assert.doesNotMatch(html, /(src|href)="\.\.\//);
  assert.match(html, /<script src="\/app\.js\?v=/);
});

test('the sitemap lists the home page and every masechta, daf and shiur page', () => {
  const xml = sitemap(SHIURIM, CATALOG.generatedAt);
  const locs = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1].replace('https://dafsync.com', ''));
  assert.deepEqual(locs, ['/', '/browse/', '/chaburah/', '/bechoros/', '/bechoros/57/', '/bechoros/57/stefansky/',
    '/bechoros/58/', '/bechoros/58/stefansky/', '/bechoros/58/stefansky/chazarah/', '/bechoros/58/bornstein/']);
  assert.match(xml, /<lastmod>2026-11-16<\/lastmod>/);
});

async function withFetch(routes, fn) {
  const original = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    const href = String(url);
    asked.push(href);
    for (const [pattern, reply] of routes) {
      if (href.includes(pattern)) return typeof reply === 'function' ? reply() : reply;
    }
    return new Response('nope', { status: 404 });
  };
  resetCatalogCache();
  try {
    return await fn(asked);
  } finally {
    globalThis.fetch = original;
    resetCatalogCache();
  }
}

const ROUTES = [
  ['catalog.json', () => Response.json(CATALOG)],
  ['sefaria.org', () => Response.json({ he: ['<b>אמר</b> רב', 'יהודה'] })],
  ['/player/index.html', () => new Response(PLAYER_HTML)],
];

test('the handler: pages, the sitemap, slashes, and addresses that name nothing', async () => {
  await withFetch(ROUTES, async (asked) => {
    const get = (p) => handle(new Request(`https://dafsync.com${p}`), {});
    const daf = await get('/bechoros/58/');
    assert.equal(daf.status, 200);
    assert.match(await daf.text(), /אמר רב יהודה/);
    assert.match(daf.headers.get('Netlify-CDN-Cache-Control'), /s-maxage=3600/);
    assert.equal((await get('/bechoros/')).status, 200);
    const shiur = await get('/bechoros/58/bornstein/?mode=standard');
    assert.equal(shiur.status, 200);
    assert.match(await shiur.text(), /"\/player\/\?ref=Bekhorot\+58a&maggid=bornstein"/);
    const map = await get('/sitemap.xml');
    assert.match(map.headers.get('Content-Type'), /xml/);
    const slashless = await get('/bechoros/58');
    assert.equal(slashless.status, 301);
    assert.equal(slashless.headers.get('Location'), 'https://dafsync.com/bechoros/58/');
    assert.equal((await get('/bechoros/12/')).status, 404);            // no shiur on that daf
    assert.equal((await get('/chullin/')).status, 404);                // no shiur on that masechta
    const missing = await get('/bechoros/58/bornstein/chazarah/');     // a recording that doesn't exist
    assert.equal(missing.status, 302);
    assert.equal(missing.headers.get('Location'), 'https://dafsync.com/bechoros/58/');
    assert.equal(asked.filter((u) => u.includes('catalog.json')).length, 1);   // cached between requests
    assert.ok(asked.every((u) => !u.includes('googleapis')));                // no key, no YouTube calls
  });
});

test('the handler: Sefaria down still gives the page, the catalog down gives a 503', async () => {
  await withFetch([['catalog.json', () => Response.json(CATALOG)], ['sefaria.org', () => { throw new Error('down'); }]], async () => {
    const daf = await handle(new Request('https://dafsync.com/bechoros/58/'), {});
    assert.equal(daf.status, 200);
    assert.doesNotMatch(await daf.text(), /<p class="daf-text"/);
  });
  await withFetch([['catalog.json', () => new Response('', { status: 500 })]], async () => {
    const res = await handle(new Request('https://dafsync.com/bechoros/58/'), {});
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('Retry-After'), '60');
  });
});

test('pictures: MDY\u2019s own, resized and sent from dafsync.com, when its server has one; YouTube\u2019s otherwise', async () => {
  const mdy58 = SHIURIM.find((s) => s.daf === 58 && s.maggidId === 'stefansky' && s.variant.key === 'regularEn');
  const chazarah58 = SHIURIM.find((s) => s.daf === 58 && s.variant.key === 'chazarahEn');
  const bornstein58 = SHIURIM.find((s) => s.daf === 58 && s.maggidId === 'bornstein');
  assert.equal(mdyPoster(mdy58), 'https://cdn.mdydaf.com/shiur/english/bechoros/thumb/58.png');
  assert.equal(mdyPoster(chazarah58), 'https://cdn.mdydaf.com/nbtd/english/bechoros/thumb/58.png');
  assert.equal(mdyPoster(bornstein58), null);

  const asked = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    asked.push(`${init.method || 'GET'} ${url}`);
    return new Response(null, { status: String(url).includes('/shiur/') ? 200 : 404 });
  };
  let pictures;
  try {
    pictures = await shiurPictures([mdy58, chazarah58, bornstein58]);
  } finally {
    globalThis.fetch = original;
  }
  // Only MDY's shiurim are asked about, and only with HEAD.
  assert.deepEqual(asked, [
    'HEAD https://cdn.mdydaf.com/shiur/english/bechoros/thumb/58.png',
    'HEAD https://cdn.mdydaf.com/nbtd/english/bechoros/thumb/58.png',
  ]);
  assert.equal(pictures.get(mdy58.videoId), 'https://cdn.mdydaf.com/shiur/english/bechoros/thumb/58.png');
  assert.equal(pictures.get(chazarah58.videoId), null);

  const html = dafPage(BECHOROS, 58, SHIURIM, { pictures });
  assert.ok(html.includes('src="/.netlify/images?url=https%3A%2F%2Fcdn.mdydaf.com%2Fshiur%2Fenglish%2Fbechoros%2Fthumb%2F58.png&amp;w=320&amp;fm=webp&amp;q=75"'));
  assert.ok(html.includes(`src="https://i.ytimg.com/vi/${chazarah58.videoId}/mqdefault.jpg"`));
  assert.ok(html.includes(`src="https://i.ytimg.com/vi/${bornstein58.videoId}/mqdefault.jpg"`));

  const page = shiurPage(PLAYER_HTML, mdy58, { pictures });
  assert.match(page, /<meta property="og:image" content="https:\/\/dafsync\.com\/\.netlify\/images\?url=https%3A%2F%2Fcdn\.mdydaf\.com%2Fshiur%2Fenglish%2Fbechoros%2Fthumb%2F58\.png&amp;w=1200&amp;fm=jpg&amp;q=75">/);
  const fallback = shiurPage(PLAYER_HTML, bornstein58, {});
  assert.match(fallback, new RegExp(`<meta property="og:image" content="https://i\\.ytimg\\.com/vi/${bornstein58.videoId}/hqdefault\\.jpg">`));
});
