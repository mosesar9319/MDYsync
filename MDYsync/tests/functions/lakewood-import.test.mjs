// R' Bornstein's shiurim from Lakewood Daf Yomi's own feed, never YouTube:
// tools/lakewood-import.mjs (links, and moving the ones once linked by a YouTube
// id) and tools/lakewood-sync.mjs (which new shiurim get a voice sync).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTalmudLookup } from '../../shared/mdy-channel.mjs';
import { feedItems, isLakewoodId, lakewoodEpisodeId, lakewoodDirectUrl } from '../../shared/lakewood-feed.mjs';
import { importFeed } from '../../tools/lakewood-import.mjs';
import { plan, dispatchPayload, estimateCredits, RESERVE_CREDITS } from '../../tools/lakewood-sync.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const lookup = buildTalmudLookup(JSON.parse(fs.readFileSync(path.join(HERE, '..', '..', 'talmud_index.json'), 'utf8')));
const A = 'https://lakewoodafyomi.appspot.com/m5/';
const FEED = `<rss><channel>
<item><title>Eruchin 2</title><pubDate>Thu, 19 Nov 2026 04:47:41 GMT</pubDate><enclosure url="${A}X/Arachin%202_213511665.mp3"/><itunes:duration>0:58:07</itunes:duration></item>
<item><title>Bechoros 59</title><pubDate>Sun, 15 Nov 2026 12:00:00 GMT</pubDate><enclosure url="${A}X/Bechoros%2059_213231329.mp3"/><itunes:duration>50:00</itunes:duration></item>
<item><title>Bechoros 58</title><pubDate>Sat, 14 Nov 2026 23:34:45 GMT</pubDate><enclosure url="${A}X/Bechoros%2058_213147286.mp3"/><itunes:duration>1:03:34</itunes:duration></item>
<item><title>Bechoros 57</title><pubDate>Fri, 13 Nov 2026 12:56:10 GMT</pubDate><enclosure url="${A}X/Bechoros%2057_213022570.mp3"/><itunes:duration>56:07</itunes:duration></item>
</channel></rss>`;

function results(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'results-'));
  for (const [file, value] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), JSON.stringify(value));
  }
  return dir;
}
const read = (dir, file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
const YT = (id, label, extra = {}) => ({ type: 'youtube', url: `https://www.youtube.com/watch?v=${id}`, videoId: id, label, source: 'manual', ...extra });

test('ids: Lakewood’s own episode number, never a YouTube id', () => {
  assert.equal(lakewoodEpisodeId(`${A}X/Bechoros%2058_213147286.mp3`), 'L0213147286');
  assert.equal(isLakewoodId('L0213147286'), true);
  assert.equal(isLakewoodId('TWCiP96dKXU'), false);
  assert.equal(lakewoodDirectUrl(`${A}X/Bechoros%2058_213147286.mp3`),
    'https://lkwd-daf-yomi.nyc3.cdn.digitaloceanspaces.com/aud/d/Bechoros%2058_213147286.mp3');
});

test('every daf shiur in the feed is linked, amud by amud, as a Lakewood link', () => {
  const dir = results();
  const summary = importFeed({ resultsDir: dir, items: feedItems(FEED), lookup });
  const link = read(dir, 'video-links/Bornstein-Arakhin-2a.json');
  assert.deepEqual(link, {
    type: 'lakewood', videoId: 'L0213511665', url: `${A}X/Arachin%202_213511665.mp3`, label: 'Eruchin 2',
    seconds: 3487, published: '2026-11-19T04:47:41.000Z', coveredRefs: ['Arakhin 2a', 'Arakhin 2b'],
    source: 'lakewood-feed', maggid: 'bornstein',
  });
  assert.equal(read(dir, 'video-links/Bornstein-Bekhorot-57b.json').videoId, 'L0213022570');
  assert.equal(summary.items.length, 4);
  assert.equal(JSON.stringify(fs.readdirSync(path.join(dir, 'video-links'))).includes('youtube'), false);
  const list = read(dir, 'maggidim/bornstein.json');
  assert.deepEqual(list.videos.map((v) => v.videoId), ['L0213511665', 'L0213231329', 'L0213147286', 'L0213022570']);
  // A second run changes nothing.
  assert.equal(importFeed({ resultsDir: dir, items: feedItems(FEED), lookup }).linked, 0);
});

test('a link of another kind, or one an admin locked, is left alone; a shiur gone from the feed stays', () => {
  const dir = results({
    'video-links/Bornstein-Bekhorot-57a.json': { type: 'direct', url: 'https://example.com/x.mp3', videoId: null, source: 'manual' },
    'video-links/Bornstein-Bekhorot-10a.json': { type: 'lakewood', videoId: 'L0000000010', url: `${A}X/Bechoros%2010_10.mp3`, label: 'Bechoros 10', source: 'lakewood-feed', maggid: 'bornstein' },
  });
  importFeed({ resultsDir: dir, items: feedItems(FEED), lookup });
  assert.equal(read(dir, 'video-links/Bornstein-Bekhorot-57a.json').type, 'direct');
  assert.equal(read(dir, 'video-links/Bornstein-Bekhorot-10a.json').videoId, 'L0000000010');
});

test('his shiurim once linked by a YouTube id move to the feed’s copy, with their syncs and test runs', () => {
  const dir = results({
    'video-links/Bornstein-Bekhorot-58a.json': YT('TWCiP96dKXU', 'Bechoros 58', { locked: true }),
    'video-links/Bornstein-Bekhorot-58b.json': YT('TWCiP96dKXU', 'Bechoros 58', { locked: true }),
    // The test shiur reads into the amud before: that link goes to Bechoros 57's own shiur.
    'video-links/Bornstein-Bekhorot-57b.json': YT('TWCiP96dKXU', 'Bechoros 58', { locked: true, testShiur: true }),
    'by-ref/Voice-Bornstein-Bekhorot-58a.json': { videoId: 'TWCiP96dKXU', videoUrl: 'https://www.youtube.com/watch?v=TWCiP96dKXU', segments: [] },
    'by-ref/Voice-Bornstein-Bekhorot-2a.json': { videoId: 'someoneElse', segments: [] },
    'by-video/Voice-Bornstein-TWCiP96dKXU.json': { videoId: 'TWCiP96dKXU', segments: [] },
    'test-runs/TWCiP96dKXU/index.json': { videoId: 'TWCiP96dKXU', runs: [{ id: 'regular-8', file: 'regular-8.json' }] },
    'test-runs/TWCiP96dKXU/regular-8.json': { videoId: 'TWCiP96dKXU', videoUrl: 'https://www.youtube.com/watch?v=TWCiP96dKXU' },
    'settings.json': { shownTestRun: { TWCiP96dKXU: 'regular-8' } },
  });
  const summary = importFeed({ resultsDir: dir, items: feedItems(FEED), lookup });
  assert.deepEqual(summary.migrated, { TWCiP96dKXU: 'L0213147286' });
  const own = read(dir, 'video-links/Bornstein-Bekhorot-58a.json');
  assert.equal(own.type, 'lakewood');
  assert.equal(own.videoId, 'L0213147286');
  assert.equal(own.locked, true);
  assert.equal(read(dir, 'video-links/Bornstein-Bekhorot-57b.json').videoId, 'L0213022570');
  const sync = read(dir, 'by-ref/Voice-Bornstein-Bekhorot-58a.json');
  assert.equal(sync.videoId, 'L0213147286');
  assert.equal(sync.videoUrl, `${A}X/Bechoros%2058_213147286.mp3`);
  assert.equal(read(dir, 'by-ref/Voice-Bornstein-Bekhorot-2a.json').videoId, 'someoneElse');
  assert.equal(fs.existsSync(path.join(dir, 'by-video/Voice-Bornstein-TWCiP96dKXU.json')), false);
  assert.equal(read(dir, 'by-video/Voice-Bornstein-L0213147286.json').videoId, 'L0213147286');
  assert.equal(fs.existsSync(path.join(dir, 'test-runs/TWCiP96dKXU')), false);
  assert.equal(read(dir, 'test-runs/L0213147286/index.json').videoId, 'L0213147286');
  assert.equal(read(dir, 'test-runs/L0213147286/regular-8.json').videoUrl, `${A}X/Bechoros%2058_213147286.mp3`);
  assert.deepEqual(read(dir, 'settings.json').shownTestRun, { L0213147286: 'regular-8' });
  // Nothing of his is tied to YouTube any more.
  const everything = fs.readdirSync(dir, { recursive: true })
    .filter((f) => f.endsWith('.json')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
  assert.equal(everything.includes('TWCiP96dKXU'), false);
});

test('syncs: only from Eruchin 2 on, not twice, and never past the credit reserve', () => {
  const dir = results();
  const { items } = importFeed({ resultsDir: dir, items: feedItems(FEED), lookup });
  // Plenty of credits: Eruchin 2 alone (published from 19 Nov); the ones before it are not synced.
  let r = plan({ resultsDir: dir, items, state: { jobs: {} }, balance: { left: 26000 } });
  assert.deepEqual(r.start.map((i) => i.title), ['Eruchin 2']);
  assert.equal(estimateCredits(r.start[0]), Math.ceil((3487 / 60) * 23));
  // Started an hour ago and not published yet: still running, not started again.
  const now = Date.parse('2026-11-19T10:00:00Z');
  r = plan({ resultsDir: dir, items, state: { jobs: { L0213511665: { attempts: 1, lastStartedAt: '2026-11-19T09:00:00Z' } } }, balance: { left: 26000 }, now });
  assert.deepEqual(r.start, []);
  assert.deepEqual(r.waiting.map((w) => w.why), ['running']);
  // Three hours on and still nothing: tried again; after three tries, given up.
  r = plan({ resultsDir: dir, items, state: { jobs: { L0213511665: { attempts: 1, lastStartedAt: '2026-11-19T06:00:00Z' } } }, balance: { left: 26000 }, now });
  assert.deepEqual(r.start.map((i) => i.title), ['Eruchin 2']);
  r = plan({ resultsDir: dir, items, state: { jobs: { L0213511665: { attempts: 3, lastStartedAt: '2026-11-19T01:00:00Z' } } }, balance: { left: 26000 }, now });
  assert.deepEqual(r.waiting.map((w) => w.why), ['gave up']);
  // Credits low, or unknown: it waits.
  r = plan({ resultsDir: dir, items, state: { jobs: {} }, balance: { left: RESERVE_CREDITS + 500 } });
  assert.deepEqual(r.waiting.map((w) => w.why), ['credits']);
  r = plan({ resultsDir: dir, items, state: { jobs: {} }, balance: null });
  assert.deepEqual(r.waiting.map((w) => w.why), ['balance unknown']);
  // Synced already (by this very recording): left alone.
  fs.mkdirSync(path.join(dir, 'by-ref'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'by-ref/Voice-Bornstein-Arakhin-2a.json'), JSON.stringify({ videoId: 'L0213511665' }));
  r = plan({ resultsDir: dir, items, state: { jobs: {} }, balance: { left: 26000 } });
  assert.deepEqual(r.start, []);
  assert.deepEqual(r.waiting, []);
});

test('the sync job is sent the feed’s mp3 and Lakewood’s id, no YouTube address', () => {
  const dir = results();
  const { items } = importFeed({ resultsDir: dir, items: feedItems(FEED), lookup });
  const payload = dispatchPayload(items[0], 'job1');
  assert.deepEqual(payload, {
    event_type: 'run-voice-job',
    client_payload: {
      videoId: 'L0213511665', audioUrl: `${A}X/Arachin%202_213511665.mp3`, refs: ['Arakhin 2a', 'Arakhin 2b'],
      jobId: 'job1', variant: 'regular', language: 'en', maggid: 'bornstein',
    },
  });
  assert.equal(JSON.stringify(payload).includes('youtube'), false);
});
