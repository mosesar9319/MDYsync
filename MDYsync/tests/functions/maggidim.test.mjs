// The maggidei shiur registry (shared/maggidim.mjs) and everything that has to
// agree with it: the title parser for Lakewood Daf Yomi, the key scheme (mirrored
// by hand in app.js, index.html and publish_alignment.py), the catalog builder,
// the back-catalogue backfill and the hourly channel sync.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { MAGGIDIM, maggidById, maggidByChannelId, maggidKeyPrefix, parseBernsteinTitle } from '../../shared/maggidim.mjs';
import { buildTalmudLookup, refKeyFor, refDisplay, parseChannelTitle } from '../../shared/mdy-channel.mjs';
import { backfill } from '../../tools/backfill-maggid-videos.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const lookup = buildTalmudLookup(JSON.parse(read('talmud_index.json')));

test('the registry: Mercaz Daf Yomi is the default and has no key prefix; Lakewood Daf Yomi has its own', () => {
  assert.equal(MAGGIDIM[0].id, 'stefansky');
  assert.equal(MAGGIDIM[0].keyPrefix, '');
  assert.equal(MAGGIDIM[0].marker, '');
  const bernstein = maggidById('bernstein');
  assert.equal(bernstein.name, "R' Sruly Bernstein");
  assert.equal(bernstein.channelId, 'UCyk5Q9nuhwqJC_-zrP2Ojcg');
  assert.equal(bernstein.keyPrefix, 'Bernstein-');
  assert.equal(maggidByChannelId('UCKwQa5DB_VR98ac_r-Wyl-g').id, 'stefansky');
  assert.equal(MAGGIDIM[0].follow, true);
  assert.equal(bernstein.follow, false, 'only the one video asked for is imported, by hand, for now');
  assert.equal(maggidKeyPrefix('bernstein'), 'Bernstein-');
  assert.equal(maggidKeyPrefix('stefansky'), '');
  assert.equal(maggidKeyPrefix('nobody'), '');
  assert.equal(new Set(MAGGIDIM.map((m) => m.keyPrefix).filter(Boolean)).size, MAGGIDIM.filter((m) => m.keyPrefix).length, 'prefixes are distinct');
});

test('Lakewood Daf Yomi titles: "<Tractate> <N>" and the older "<Tractate> Daf <N> by Sruly Bornstein"', () => {
  const daf = (title) => { const p = parseBernsteinTitle(title, lookup); return p && `${p.tractate} ${p.daf} ${p.variant} ${p.language}`; };
  assert.equal(daf('Bechoros 2'), 'Bekhorot 2 regular en');
  assert.equal(daf('Bechoros 22'), 'Bekhorot 22 regular en');
  assert.equal(daf('Chulin 100'), 'Chullin 100 regular en');
  assert.equal(daf('Menachos 89'), 'Menachot 89 regular en');
  assert.equal(daf('Yevamos 12'), 'Yevamot 12 regular en');
  assert.equal(daf('Yevamos Daf 6 by Sruly Bornstein'), 'Yevamot 6 regular en');
  assert.equal(daf('Yevamos Daf 6 by Sruly Bernstein'), 'Yevamot 6 regular en');
});

test('titles that are not a daf are left alone, not guessed at', () => {
  for (const title of [
    'Not All of Our Sages Were Created Equally', 'Rebbi Yehoshua the Shadlan Part 2', 'Kosher Gelatin? Coca Cola Part 1',
    'An Introduction to Maseches Bechoros', 'Just The Daf', 'ויחל משה', 'Bechoros', 'Bechoros 1', '', 'Kerisus 5', 'Bechoros 22 review',
  ]) {
    assert.equal(parseBernsteinTitle(title, lookup), null, title);
  }
  assert.equal(parseChannelTitle('Bechoros 22', lookup), null, "Mercaz Daf Yomi's parser does not read Lakewood's titles");
});

test('keys: the maggid prefix goes first, ahead of the language and variant ones', () => {
  const base = { tractate: 'Bekhorot', daf: 2, amud: 'a', variant: 'regular', language: 'en' };
  assert.equal(refKeyFor(base), 'Bekhorot-2a');
  assert.equal(refKeyFor({ ...base, maggid: 'bernstein' }), 'Bernstein-Bekhorot-2a');
  assert.equal(refKeyFor({ ...base, maggid: 'stefansky' }), 'Bekhorot-2a');
  assert.equal(refKeyFor({ ...base, maggid: 'bernstein', language: 'he', variant: 'chazarah' }), 'Bernstein-Hebrew-Chazarah-Daf-Bekhorot-2a');
  assert.equal(refDisplay({ ...base, maggid: 'bernstein' }), 'Bekhorot 2a (Bernstein)');
  assert.equal(refDisplay(base), 'Bekhorot 2a');
});

test('app.js, index.html and publish_alignment.py mirror the registry', () => {
  const app = read('app.js');
  const block = /const MAGGIDIM = \[([\s\S]*?)\n\];/.exec(app)[1];
  const fromApp = [...block.matchAll(/\{ id: '([^']+)', keyPrefix: '([^']*)', marker: '([^']*)' \}/g)].map((m) => ({ id: m[1], keyPrefix: m[2], marker: m[3] }));
  assert.deepEqual(fromApp, MAGGIDIM.map(({ id, keyPrefix, marker }) => ({ id, keyPrefix, marker })), 'app.js');

  const index = read('index.html');
  const indexBlock = /const MAGGIDIM = \[([\s\S]*?)\n\s*\];/.exec(index)[1];
  const indexEntries = [...indexBlock.matchAll(/\{ id: "([^"]+)", name: "([^"]+)"/g)].map((m) => ({ id: m[1], name: m[2].replace('’', "'") }));
  assert.deepEqual(indexEntries, MAGGIDIM.map(({ id, name }) => ({ id, name })), 'index.html');

  const py = read('tools/caption-sync/publish_alignment.py');
  const pyMap = /MAGGID_KEY_PREFIXES = \{([^}]*)\}/.exec(py)[1];
  const fromPy = Object.fromEntries([...pyMap.matchAll(/'([^']+)': '([^']+)'/g)].map((m) => [m[1], m[2]]));
  assert.deepEqual(fromPy, Object.fromEntries(MAGGIDIM.filter((m) => m.keyPrefix).map((m) => [m.id, m.keyPrefix])), 'publish_alignment.py');
});

function tmpResults() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'maggid-results-'));
}

test('the backfill links every daf video behind the maggid prefix, lists the rest, and marks the test shiur', () => {
  const dir = tmpResults();
  const videos = [
    { id: 'g7VSmqB8Xlk', title: 'Bechoros 22' },
    { id: 'Zsy7oDUP6Pw', title: 'Bechoros 2' },
    { id: 'FvMHzatB_9Y', title: 'Not All of Our Sages Were Created Equally' },
    { id: 'aaaaaaaaaaa', title: 'Bechoros 22' }, // an older upload of the same daf: the newest wins
  ];
  const result = backfill({ maggidId: 'bernstein', videos, lookup, resultsDir: dir, testVideoId: 'Zsy7oDUP6Pw', log: () => {} });
  assert.equal(result.listed, 4);
  const link = (key) => JSON.parse(fs.readFileSync(path.join(dir, 'video-links', `${key}.json`), 'utf8'));
  assert.equal(link('Bernstein-Bekhorot-22a').videoId, 'g7VSmqB8Xlk');
  assert.equal(link('Bernstein-Bekhorot-22b').videoId, 'g7VSmqB8Xlk');
  assert.equal(link('Bernstein-Bekhorot-22a').maggid, 'bernstein');
  assert.deepEqual(link('Bernstein-Bekhorot-22a').coveredRefs, ['Bekhorot 22a', 'Bekhorot 22b']);
  const test2a = link('Bernstein-Bekhorot-2a');
  assert.equal(test2a.videoId, 'Zsy7oDUP6Pw');
  assert.equal(test2a.testShiur, true);
  assert.equal(test2a.locked, true, 'never swapped for a re-upload by the hourly sync');
  assert.equal(link('Bernstein-Bekhorot-22a').testShiur, undefined);
  // Bekhorot is the tractate's first daf: it has both amudim, but nothing before it.
  assert.deepEqual(fs.readdirSync(path.join(dir, 'video-links')).sort(), [
    'Bernstein-Bekhorot-22a.json', 'Bernstein-Bekhorot-22b.json', 'Bernstein-Bekhorot-2a.json', 'Bernstein-Bekhorot-2b.json',
  ]);
  const list = JSON.parse(fs.readFileSync(path.join(dir, 'maggidim', 'bernstein.json'), 'utf8'));
  assert.equal(list.videos.length, 4);
  assert.equal(list.videos.find((v) => v.videoId === 'FvMHzatB_9Y').daf, undefined);
  assert.equal(list.videos.find((v) => v.videoId === 'Zsy7oDUP6Pw').daf, 2);
});

test('the backfill leaves a maggid\'s hand-saved or locked link alone', () => {
  const dir = tmpResults();
  fs.mkdirSync(path.join(dir, 'video-links'));
  fs.writeFileSync(path.join(dir, 'video-links', 'Bernstein-Bekhorot-5a.json'), JSON.stringify({ videoId: 'manualvideo', source: 'manual' }));
  backfill({ maggidId: 'bernstein', videos: [{ id: 'g7VSmqB8Xlk', title: 'Bechoros 5' }], lookup, resultsDir: dir, log: () => {} });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'video-links', 'Bernstein-Bekhorot-5a.json'), 'utf8')).videoId, 'manualvideo');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'video-links', 'Bernstein-Bekhorot-5b.json'), 'utf8')).videoId, 'manualvideo' === 'x' ? '' : 'g7VSmqB8Xlk');
});

test('the catalog builder files each maggid\'s videos under their own section and leaves the default rows as they were', () => {
  const dir = tmpResults();
  const links = path.join(dir, 'video-links');
  fs.mkdirSync(links);
  const put = (key, body) => fs.writeFileSync(path.join(links, `${key}.json`), JSON.stringify(body));
  put('Bekhorot-2a', { videoId: 'CNu3Ba5XCao', label: "Daf Yomi Bechoros Daf 2 by R' Eli Stefansky" });
  put('Hebrew-Bekhorot-2a', { videoId: 'PXjUf4aUXs0', label: 'עברית' });
  put('Bernstein-Bekhorot-2a', { videoId: 'Zsy7oDUP6Pw', label: 'Bechoros 2', testShiur: true });
  put('Bernstein-Bekhorot-2b', { videoId: 'Zsy7oDUP6Pw', label: 'Bechoros 2', testShiur: true });
  put('Bernstein-Chullin-100a', { videoId: 'cccccccccc1', label: 'Chulin 100' });
  execFileSync('node', [path.join(ROOT, 'tools', 'build-video-catalog.mjs'), '--results', dir], { stdio: 'pipe' });
  const catalog = JSON.parse(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8'));
  assert.deepEqual(Object.keys(catalog.tractates), ['Bekhorot'], 'no "Bernstein Bekhorot" tractate among the default maggid\'s');
  assert.deepEqual(catalog.tractates.Bekhorot, [{
    daf: 2,
    regularEn: { videoId: 'CNu3Ba5XCao', label: "Daf Yomi Bechoros Daf 2 by R' Eli Stefansky", amud: 'a' },
    regularHe: { videoId: 'PXjUf4aUXs0', label: 'עברית', amud: 'a' },
  }]);
  assert.deepEqual(catalog.maggidim.bernstein.tractates.Bekhorot, [{
    daf: 2, regularEn: { videoId: 'Zsy7oDUP6Pw', label: 'Bechoros 2', amud: 'a', testShiur: true },
  }]);
  assert.equal(catalog.maggidim.bernstein.tractates.Chullin[0].daf, 100);
});

test('a catalog with only the default maggid has no maggidim section', () => {
  const dir = tmpResults();
  fs.mkdirSync(path.join(dir, 'video-links'));
  fs.writeFileSync(path.join(dir, 'video-links', 'Bekhorot-2a.json'), JSON.stringify({ videoId: 'CNu3Ba5XCao', label: 'x' }));
  execFileSync('node', [path.join(ROOT, 'tools', 'build-video-catalog.mjs'), '--results', dir], { stdio: 'pipe' });
  assert.equal('maggidim' in JSON.parse(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8')), false);
});

// ---- The hourly channel sync ---------------------------------------------------------------------------

function feedXml(entries) {
  return `<feed>${entries.map((e) => `<entry><yt:videoId>${e.id}</yt:videoId><title>${e.title}</title><published>${e.published}</published></entry>`).join('')}</feed>`;
}

// `followBernstein` turns the maggid's `follow` flag on for the run (it is off by default).
async function runSync({ mdyFeed = [], bernsteinFeed = [], bernsteinStatus = 200, existing = {}, files = {}, followBernstein = true }) {
  const puts = [];
  const bernstein = maggidById('bernstein');
  const wasFollowing = bernstein.follow;
  bernstein.follow = followBernstein;
  const talmud = read('talmud_index.json');
  globalThis.Netlify = { env: { get: (k) => (k === 'GITHUB_DISPATCH_TOKEN' ? 'token' : undefined) } };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method || 'GET';
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.includes('talmud_index.json')) return new Response(talmud);
    if (url.includes('settings.json')) return json({});
    if (url.includes('channel_id=UCKwQa5DB_VR98ac_r-Wyl-g')) return new Response(feedXml(mdyFeed));
    if (url.includes('channel_id=UCyk5Q9nuhwqJC_-zrP2Ojcg')) return new Response(feedXml(bernsteinFeed), { status: bernsteinStatus });
    if (url.includes('/git/trees/results')) return json({ tree: Object.keys(existing).map((k) => ({ type: 'blob', path: `video-links/${k}.json` })) });
    const contents = /\/contents\/([^?]+)/.exec(url);
    if (contents && method === 'GET') {
      const file = files[contents[1]];
      if (!file) return json({ message: 'Not Found' }, 404);
      return json({ sha: 'sha1', content: Buffer.from(JSON.stringify(file)).toString('base64') });
    }
    if (contents && method === 'PUT') {
      const body = JSON.parse(init.body);
      puts.push({ path: contents[1], content: JSON.parse(Buffer.from(body.content, 'base64').toString('utf8')), message: body.message });
      return json({ ok: true });
    }
    if (url.endsWith('/dispatches')) { puts.push({ path: 'dispatch', content: JSON.parse(init.body) }); return new Response(null, { status: 204 }); }
    throw new Error(`unexpected fetch ${method} ${url}`);
  };
  try {
    const { default: handler } = await import(`../../netlify/functions/youtube-channel-sync.mjs?${Math.random()}`);
    const response = await handler(new Request('https://example.test/'));
    return { response: await response.json(), puts };
  } finally {
    globalThis.fetch = realFetch;
    bernstein.follow = wasFollowing;
  }
}

test('by default the channel sync does not touch Lakewood Daf Yomi at all', async () => {
  const { puts } = await runSync({
    followBernstein: false,
    mdyFeed: [],
    bernsteinFeed: [{ id: 'g7VSmqB8Xlk', title: 'Bechoros 22', published: '2026-10-09T10:00:00+00:00' }],
  });
  assert.equal(puts.some((p) => p.path.includes('Bernstein') || p.path.startsWith('maggidim/')), false);
});

test('the channel sync links a new Lakewood Daf Yomi video behind the Bernstein prefix, under its own daf only', async () => {
  const { response, puts } = await runSync({
    bernsteinFeed: [
      { id: 'g7VSmqB8Xlk', title: 'Bechoros 22', published: '2026-10-09T10:00:00+00:00' },
      { id: 'FvMHzatB_9Y', title: 'Not All of Our Sages Were Created Equally', published: '2026-09-28T10:00:00+00:00' },
    ],
  });
  const links = puts.filter((p) => p.path.startsWith('video-links/'));
  assert.deepEqual(links.map((p) => p.path).sort(), ['video-links/Bernstein-Bekhorot-22a.json', 'video-links/Bernstein-Bekhorot-22b.json'],
    'no tail reading of the previous daf, and nothing for the video that is not a daf');
  assert.equal(links[0].content.maggid, 'bernstein');
  assert.equal(links[0].content.videoId, 'g7VSmqB8Xlk');
  assert.deepEqual(response.published.map((p) => p.ref).sort(), ['Bekhorot 22a (Bernstein)', 'Bekhorot 22b (Bernstein)']);
  const catalog = puts.find((p) => p.path === 'catalog.json').content;
  assert.deepEqual(catalog.maggidim.bernstein.tractates.Bekhorot, [{ daf: 22, regularEn: { videoId: 'g7VSmqB8Xlk', label: 'Bechoros 22', amud: 'a' } }]);
  assert.deepEqual(catalog.tractates, {}, 'the default maggid\'s rows are untouched');
  const list = puts.find((p) => p.path === 'maggidim/bernstein.json').content;
  assert.deepEqual(list.videos.map((v) => [v.videoId, v.daf ?? null]), [['g7VSmqB8Xlk', 22], ['FvMHzatB_9Y', null]]);
  assert.equal(puts.some((p) => p.path === 'dispatch'), false, 'no caption-OCR job for a video with no captions');
});

test('the channel sync still handles Mercaz Daf Yomi exactly as before, beside the new channel', async () => {
  const { puts } = await runSync({
    mdyFeed: [{ id: 'CNu3Ba5XCao', title: "Daf Yomi Bechoros Daf 2 by R' Eli Stefansky", published: '2026-10-01T10:00:00+00:00' }],
    bernsteinFeed: [{ id: 'Zsy7oDUP6Pw', title: 'Bechoros 2', published: '2026-10-01T11:00:00+00:00' }],
  });
  const keys = puts.filter((p) => p.path.startsWith('video-links/')).map((p) => p.path).sort();
  assert.deepEqual(keys, [
    'video-links/Bekhorot-2a.json', 'video-links/Bekhorot-2b.json',
    'video-links/Bernstein-Bekhorot-2a.json', 'video-links/Bernstein-Bekhorot-2b.json',
    'video-links/Chullin-142a.json', // ...except the previous tractate's last amud, which his shiur opens on
  ]);
  const catalog = puts.find((p) => p.path === 'catalog.json').content;
  assert.equal(catalog.tractates.Bekhorot[0].regularEn.videoId, 'CNu3Ba5XCao');
  assert.equal(catalog.maggidim.bernstein.tractates.Bekhorot[0].regularEn.videoId, 'Zsy7oDUP6Pw');
});

test('a maggid\'s feed being down skips that maggid but not the default one', async () => {
  const { response, puts } = await runSync({
    mdyFeed: [{ id: 'CNu3Ba5XCao', title: "Daf Yomi Bechoros Daf 2 by R' Eli Stefansky", published: '2026-10-01T10:00:00+00:00' }],
    bernsteinStatus: 500,
  });
  assert.ok(puts.some((p) => p.path === 'video-links/Bekhorot-2a.json'));
  assert.equal(puts.some((p) => p.path.includes('Bernstein')), false);
  assert.deepEqual(response.skipped.filter((s) => s.maggid), [{ maggid: 'bernstein', reason: 'YouTube feed returned 500' }]);
});
