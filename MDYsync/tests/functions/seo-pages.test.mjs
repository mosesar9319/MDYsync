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
  mediaObject, isoDuration, withListDetails, homePage, HOME_MARKER,
  parsePlayerRef, shiurForPlayer, shiurAddressFor,
} from '../../netlify/functions/seo-pages.mjs';
import { MASECHTOS, MASECHTA_SLUGS, masechtaBySlug, hebrewNumeral, otherSpellings } from '../../shared/masechtos.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PLAYER_HTML = fs.readFileSync(path.join(ROOT, 'player/index.html'), 'utf8');
const HOME_HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

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
  const expected = ['/', '/player/'].concat(MASECHTOS.flatMap((m) => [`/${m.slug}`, `/${m.slug}/*`]), '/sitemap.xml');
  assert.deepEqual(config.path, expected);
  const home = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const table = JSON.parse(`{${/const MASECHTA_SLUGS = \{([^}]*)\};/.exec(home)[1]}}`);
  assert.deepEqual(table, Object.fromEntries(MASECHTOS.map((m) => [m.name, m.slug])));
  // Eruchin's address is its own; shas.org's daf pages stay under "arachin".
  assert.equal(table.Arakhin, 'eruchin');
  assert.equal(MASECHTA_SLUGS.Arakhin, 'arachin');
  // No slug may shadow a real page of the site.
  for (const m of MASECHTOS) assert.equal(fs.existsSync(path.join(ROOT, m.slug)), false, m.slug);
});

test('names, numerals and spellings', () => {
  assert.equal(hebrewNumeral(58), 'נח');
  assert.equal(hebrewNumeral(15), 'טו');
  assert.equal(hebrewNumeral(16), 'טז');
  assert.equal(hebrewNumeral(120), 'קכ');
  assert.deepEqual(otherSpellings(masechtaBySlug('eruchin')), ['Arakhin', 'Arachin']);
  assert.deepEqual(otherSpellings(BECHOROS), ['Bekhorot', 'Bechorot']);
});

test('addresses: what each one names', () => {
  assert.deepEqual(parseRoute('/sitemap.xml'), { kind: 'sitemap' });
  assert.deepEqual(parseRoute('/'), { kind: 'home' });
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
  const html = dafPage(BECHOROS, 58, SHIURIM, { text: 'אמר רב', details: { '0n7fE-jS0NE': { publishedAt: '2026-06-01T10:00:00Z', duration: 'PT1H4M' }, 'TWCiP96dKXU': { publishedAt: '2026-06-02T10:00:00Z' } } });
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
  // Only the video with a known date; R' Bornstein's shiur is audio from Lakewood Daf Yomi, never a
  // YouTube video, and this row does not have its file.
  assert.deepEqual(ld.map((o) => o['@type']), ['BreadcrumbList', 'VideoObject']);
  assert.equal(ld[1].embedUrl, 'https://www.youtube.com/embed/0n7fE-jS0NE');
  assert.equal(ld[1].uploadDate, '2026-06-01T10:00:00Z');
  assert.deepEqual(ld[1].author, { '@type': 'Person', name: "R' Eli Stefansky" });
});

test('a recording is described by the file the page plays, with its own date and length', () => {
  assert.equal(isoDuration(3487), 'PT58M7S');
  assert.equal(isoDuration(3915), 'PT1H5M15S');
  assert.equal(isoDuration(3600), 'PT1H');
  assert.equal(isoDuration(0), '');
  const catalog = {
    tractates: { Arakhin: [{ daf: 2, regularEn: { videoId: 'p0kSAIw99HM', label: "Daf Yomi Arachin Daf 2 by R' Eli Stefansky", amud: 'a', published: '2026-11-19T13:09:06+00:00' }, regularHe: { videoId: 'Np3wL14Pbng', label: 'ערכין דף ב', amud: 'a' } }] },
    maggidim: { bornstein: { tractates: { Arakhin: [{ daf: 2, regularEn: { videoId: 'L0213511665', label: 'Eruchin 2', amud: 'a', source: 'lakewood', url: 'https://lakewoodafyomi.appspot.com/m5/x/Arachin%202_213511665.mp3' } }] } } },
  };
  const lists = new Map([['L0213511665', { published: '2026-11-19T04:47:41.000Z', seconds: 3487 }]]);
  const [mdy, mdyHebrew, bornstein] = withListDetails(shiurimFromCatalog(catalog), lists);

  // MDY's server has the shiur (its picture is there): the video is MDY's own file, not YouTube's player.
  const pictures = new Map([['p0kSAIw99HM', 'https://cdn.mdydaf.com/shiur/english/arachin/thumb/2.png']]);
  const video = mediaObject(mdy, {}, pictures);
  assert.equal(video['@type'], 'VideoObject');
  assert.equal(video.contentUrl, 'https://cdn.mdydaf.com/shiur/english/arachin/720/2.mp4');
  assert.equal(video.embedUrl, undefined);
  assert.equal(video.uploadDate, '2026-11-19T13:09:06+00:00');   // the catalog's date: YouTube is not asked
  assert.equal(video.url, 'https://dafsync.com/eruchin/2/stefansky/');
  assert.doesNotMatch(JSON.stringify(video), /youtube|ytimg/);
  // MDY's server does not have it: described by the YouTube player it plays in.
  assert.equal(mediaObject(mdy, {}).embedUrl, 'https://www.youtube.com/embed/p0kSAIw99HM');
  // No date anywhere: not described at all.
  assert.equal(mediaObject(mdyHebrew, {}), null);
  assert.equal(mediaObject(mdyHebrew, { Np3wL14Pbng: { publishedAt: '2026-11-19T12:10:42Z', duration: 'PT1H3M45S' } }).inLanguage, 'he');

  // R' Bornstein's shiur is audio: its mp3, when it was posted, how long it runs, and who gives it.
  const audio = mediaObject(bornstein, {});
  assert.equal(audio['@type'], 'AudioObject');
  assert.equal(audio.contentUrl, 'https://lakewoodafyomi.appspot.com/m5/x/Arachin%202_213511665.mp3');
  assert.equal(audio.uploadDate, '2026-11-19T04:47:41.000Z');
  assert.equal(audio.duration, 'PT58M7S');
  assert.equal(audio.name, "Eruchin 2 — R' Sruly Bornstein");
  assert.deepEqual(audio.author, { '@type': 'Person', name: "R' Sruly Bornstein" });
  assert.equal(audio.thumbnailUrl, 'https://dafsync.com/assets/maggidim/bornstein-v1.jpg');
  assert.doesNotMatch(JSON.stringify(audio), /youtube|ytimg/);
  const html = dafPage(masechtaBySlug('eruchin'), 2, [mdy, mdyHebrew, bornstein], { pictures });
  const types = [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)].map((m) => JSON.parse(m[1])['@type']);
  assert.deepEqual(types, ['BreadcrumbList', 'VideoObject', 'AudioObject']);
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
  const xml = sitemap(SHIURIM);
  const locs = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1].replace('https://dafsync.com', ''));
  assert.deepEqual(locs, ['/', '/browse/', '/chaburah/', '/bechoros/', '/bechoros/57/', '/bechoros/57/stefansky/',
    '/bechoros/58/', '/bechoros/58/stefansky/', '/bechoros/58/stefansky/chazarah/', '/bechoros/58/bornstein/']);
  // No shiur has a date: no page claims one (and never today's).
  assert.doesNotMatch(xml, /<lastmod>/);
});

test('the sitemap dates each page by its newest shiur, and leaves undated pages undated', () => {
  const dated = SHIURIM.map((s) => ({
    ...s,
    ...(s.videoId === '0n7fE-jS0NE' ? { published: '2026-11-10T13:00:00+00:00' } : {}),
    ...(s.videoId === 'TWCiP96dKXU' ? { published: '2026-11-12T04:47:41.000Z' } : {}),
  }));
  const xml = sitemap(dated);
  const day = Object.fromEntries([...xml.matchAll(/<loc>https:\/\/dafsync\.com(.*?)<\/loc>(?:<lastmod>(.*?)<\/lastmod>)?/g)].map((m) => [m[1], m[2] || '']));
  assert.equal(day['/bechoros/58/stefansky/'], '2026-11-10');
  assert.equal(day['/bechoros/58/bornstein/'], '2026-11-12');
  assert.equal(day['/bechoros/58/stefansky/chazarah/'], '');
  assert.equal(day['/bechoros/58/'], '2026-11-12');      // its newest shiur
  assert.equal(day['/bechoros/'], '2026-11-12');
  assert.equal(day['/'], '2026-11-12');
  assert.equal(day['/bechoros/57/'], '');                // nothing known
  assert.equal(day['/bechoros/57/stefansky/'], '');
  assert.equal(day['/browse/'], '');
});

test('the home page gets links to every masechta and the newest dapim, where it marks the place', () => {
  assert.equal(HOME_HTML.split(HOME_MARKER).length, 2, 'index.html marks the place once');
  const catalog = {
    tractates: { Chullin: [{ daf: 141, regularEn: { videoId: 'a', label: 'x', amud: 'a' } }, { daf: 142, regularEn: { videoId: 'b', label: 'x', amud: 'a' } }], Arakhin: [{ daf: 2, regularEn: { videoId: 'c', label: 'x', amud: 'a' } }] },
    maggidim: { bornstein: { tractates: { Arakhin: [{ daf: 3, regularEn: { videoId: 'L0213553074', label: 'Eruchin 3', amud: 'a' } }], Bekhorot: [{ daf: 61, regularEn: { videoId: 'L0213377535', label: 'Bechoros 61', amud: 'a' } }] } } },
  };
  const html = homePage(HOME_HTML, shiurimFromCatalog(catalog));
  assert.ok(!html.includes(HOME_MARKER));
  const section = /<section class="site-index"[\s\S]*?<\/section>/.exec(html)[0];
  assert.ok(html.indexOf(section) < html.indexOf('</main>'), 'inside the page\u2019s main content');
  const [masechtos, latest] = section.split('<h2>Latest dapim</h2>');
  // Masechtos in the order of Shas, each with how many dapim it has.
  assert.deepEqual([...masechtos.matchAll(/href="([^"]+)"/g)].map((m) => m[1]), ['/chullin/', '/bechoros/', '/eruchin/']);
  assert.match(masechtos, /Chullin <span lang="he" dir="rtl">חולין<\/span> <small>2 dapim<\/small>/);
  assert.match(masechtos, /Bechoros <span lang="he" dir="rtl">בכורות<\/span> <small>1 daf<\/small>/);
  // The newest dapim first: the last masechta being learned, from its last daf back.
  assert.deepEqual([...latest.matchAll(/href="([^"]+)"/g)].map((m) => m[1]), ['/eruchin/3/', '/eruchin/2/', '/bechoros/61/', '/chullin/142/', '/chullin/141/']);
  assert.match(latest, /by R&#39; Eli Stefansky \(Mercaz Daf Yomi\) and R&#39; Sruly Bornstein \(Lakewood Daf Yomi\)/);
  // Nothing to link, or no place marked: the page as it is.
  assert.equal(homePage(HOME_HTML, []), HOME_HTML);
  assert.equal(homePage('<main></main>', shiurimFromCatalog(catalog)), '<main></main>');
  // The page says what the site is in a form a search engine reads, and its stand-in shiur is gone.
  const ld = JSON.parse(/<script type="application\/ld\+json">(.*?)<\/script>/.exec(HOME_HTML)[1]);
  assert.deepEqual(ld['@graph'].map((o) => o['@type']), ['WebSite', 'Organization']);
  assert.equal(ld['@graph'][0].name, 'DafSync');
  assert.doesNotMatch(HOME_HTML, /Zevachim 61|46 min/);
});

test('the handler: the home page opens with its links, and without them when anything is down', async () => {
  const home = ['dafsync.com/index.html', () => new Response(HOME_HTML)];
  await withFetch([...ROUTES, home], async () => {
    const res = await handle(new Request('https://dafsync.com/'), {});
    assert.equal(res.status, 200);
    assert.match(res.headers.get('Content-Type'), /text\/html/);
    assert.match(res.headers.get('Cache-Control'), /max-age=0/);
    const html = await res.text();
    assert.ok(html.includes('href="/bechoros/58/"') && html.includes('href="/bechoros/"'));
    assert.match(html, /<title>DafSync — Daf Yomi Shiurim/);
  });
  // The catalog is down: index.html as it is.
  await withFetch([['catalog.json', () => new Response('', { status: 500 })], home], async () => {
    const res = await handle(new Request('https://dafsync.com/?q=chullin'), {});
    assert.equal(res.status, 200);
    assert.equal(await res.text(), HOME_HTML);
  });
  // index.html cannot be read from here: the browser is sent to it.
  await withFetch([['catalog.json', () => Response.json(CATALOG)]], async () => {
    const res = await handle(new Request('https://dafsync.com/?q=chullin'), {});
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('Location'), 'https://dafsync.com/index.html?q=chullin');
  });
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

test('a player ref is read as the player reads it', () => {
  assert.deepEqual(
    (({ masechta, ...rest }) => ({ slug: masechta.slug, ...rest }))(parsePlayerRef('Arakhin 3b (Chazarah Daf) (Bornstein)')),
    { slug: 'eruchin', daf: 3, amud: 'b', variant: 'chazarah', language: '', maggidId: 'bornstein' },
  );
  assert.equal(parsePlayerRef('bechoros 58').masechta, BECHOROS);
  assert.equal(parsePlayerRef('Bekhorot 58a:4').amud, 'a');
  assert.equal(parsePlayerRef('Eruchin 2a').masechta.slug, 'eruchin');
  assert.equal(parsePlayerRef('Bava Basra 2a').masechta.slug, 'bava-basra');
  assert.equal(parsePlayerRef('Nothing 2a'), null);
  assert.equal(parsePlayerRef(''), null);
});

test('a player address names the shiur it plays, and where that shiur now lives', () => {
  const find = (query) => shiurForPlayer(new URLSearchParams(query), SHIURIM);
  assert.equal(find('ref=Bekhorot+58a').videoId, '0n7fE-jS0NE');
  assert.equal(find('ref=Bekhorot+58a&variant=chazarah').videoId, 'CCCCCCCCCC1');
  assert.equal(find('ref=Bekhorot+58a+(Chazarah+Daf)').videoId, 'CCCCCCCCCC1');
  assert.equal(find('ref=Bekhorot+58a&maggid=bornstein').videoId, 'TWCiP96dKXU');
  assert.equal(find('ref=Bekhorot+58a+(Bornstein)').videoId, 'TWCiP96dKXU');
  assert.equal(find('ref=Bekhorot+58a&language=hebrew'), null);       // only live, so not in the catalog
  assert.equal(find('ref=Bekhorot+12a'), null);
  assert.equal(find('mode=split'), null);
  const at = (query) => shiurAddressFor(find(query), new URLSearchParams(query));
  assert.equal(at('ref=Bekhorot+58a&maggid=bornstein'), '/bechoros/58/bornstein/');
  assert.equal(at('ref=Bekhorot+58a&mode=split&t=95'), '/bechoros/58/stefansky/?mode=split&t=95');
  assert.equal(at('ref=Bekhorot+58b&variant=chazarah'), '/bechoros/58/stefansky/chazarah/?ref=Bekhorot+58b');
  assert.equal(at('ref=Bekhorot+58'), '/bechoros/58/stefansky/');
});

test('a shiur page keeps the rest of its address on the player address it moves to', () => {
  const shiur = SHIURIM.find((s) => s.videoId === '0n7fE-jS0NE');
  assert.equal(playerUrl(shiur, 'split', new URLSearchParams('t=95&hlRef=Bekhorot+58a:3&mode=standard&maggid=bornstein')),
    '/player/?ref=Bekhorot+58a&mode=split&t=95&hlRef=Bekhorot+58a%3A3');
  assert.equal(playerUrl(shiur, 'split', new URLSearchParams('ref=Bekhorot+58b')), '/player/?ref=Bekhorot+58b&mode=split');
  // Never another daf under this shiur's page.
  assert.equal(playerUrl(shiur, 'split', new URLSearchParams('ref=Chullin+5a')), '/player/?ref=Bekhorot+58a&mode=split');
});

test('the handler: a player address goes to its shiur page; anything else is the player', async () => {
  await withFetch(ROUTES, async (asked) => {
    const get = (p) => handle(new Request(`https://dafsync.com${p}`), {});
    const moved = await get('/player/?ref=Bekhorot+58a&maggid=bornstein&mode=split&t=40');
    assert.equal(moved.status, 301);
    assert.equal(moved.headers.get('Location'), 'https://dafsync.com/bechoros/58/bornstein/?mode=split&t=40');
    assert.equal(moved.headers.get('Netlify-Vary'), 'query');
    // The page it lands on hands the player everything the old address said.
    const page = await get('/bechoros/58/bornstein/?mode=split&t=40');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('Permissions-Policy'), /camera=\(self\)/);
    assert.match(await page.text(), /"\/player\/\?ref=Bekhorot\+58a&maggid=bornstein&mode=split&t=40"/);
    for (const query of ['?ref=Bekhorot+12a', '?view=scan&ref=Bekhorot+58a', '', '?ref=Bekhorot+58a&language=hebrew']) {
      const res = await get(`/player/${query}`);
      assert.equal(res.status, 200, query);
      assert.equal(await res.text(), PLAYER_HTML, query);
      assert.match(res.headers.get('Cache-Control'), /max-age=0/);
      assert.match(res.headers.get('Permissions-Policy'), /camera=\(self\)/);
    }
    assert.ok(asked.every((u) => !u.includes('googleapis')));
  });
  // The catalog is down: the player as it is.
  await withFetch([['catalog.json', () => new Response('', { status: 500 })], ROUTES[2]], async () => {
    const res = await handle(new Request('https://dafsync.com/player/?ref=Bekhorot+58a'), {});
    assert.equal(res.status, 200);
    assert.equal(await res.text(), PLAYER_HTML);
  });
  // The player page cannot be read from here: the browser is sent to the file.
  await withFetch([ROUTES[0]], async () => {
    const res = await handle(new Request('https://dafsync.com/player/?ref=Bekhorot+12a'), {});
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('Location'), 'https://dafsync.com/player/index.html?ref=Bekhorot+12a');
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
  // R' Bornstein's shiurim show his picture, never YouTube's.
  assert.ok(html.includes('src="https://dafsync.com/assets/maggidim/bornstein-v1.jpg"'));
  assert.ok(!html.includes(`i.ytimg.com/vi/${bornstein58.videoId}`));

  const page = shiurPage(PLAYER_HTML, mdy58, { pictures });
  assert.match(page, /<meta property="og:image" content="https:\/\/dafsync\.com\/\.netlify\/images\?url=https%3A%2F%2Fcdn\.mdydaf\.com%2Fshiur%2Fenglish%2Fbechoros%2Fthumb%2F58\.png&amp;w=1200&amp;fm=jpg&amp;q=75">/);
  const fallback = shiurPage(PLAYER_HTML, bornstein58, {});
  assert.match(fallback, /<meta property="og:image" content="https:\/\/dafsync\.com\/assets\/maggidim\/bornstein-v1\.jpg">/);
});
