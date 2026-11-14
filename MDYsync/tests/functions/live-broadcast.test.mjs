// Phase 1 live detection. No network, no GitHub writes, no search.list.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  chooseLiveRecording,
  describeLiveVideo,
  hubFieldsFromUrl,
  leaseRenewalDue,
  parseAtomVideoIds,
  parseIsoDuration,
  selectRecording,
  shouldDispatchLiveAlignment,
  shouldHighlightWords,
  videosListUrl,
  webSubVerification,
  WEBSUB_TOPIC,
} from '../../shared/live-broadcast.mjs';
import { buildTalmudLookup, parseChannelTitle } from '../../shared/mdy-channel.mjs';
import { ingestDescribed, planGroups, pollLive } from '../../shared/live-publish.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const lookup = buildTalmudLookup(JSON.parse(fs.readFileSync(path.join(ROOT, 'talmud_index.json'), 'utf8')));
const NOW = new Date('2026-11-14T20:00:00Z');

const ENGLISH_LIVE = {
  id: 'aK6dGXjrTDw',
  snippet: {
    title: "Daf Yomi Bechoros Daf 57 by R' Eli Stefansky (unedited)",
    channelId: 'UCKwQa5DB_VR98ac_r-Wyl-g',
    publishedAt: '2026-11-13T13:15:11+00:00',
    liveBroadcastContent: 'live',
  },
  contentDetails: { duration: 'PT1H14M57S' },
  liveStreamingDetails: { actualStartTime: '2026-11-13T13:15:11Z' },
};

const HEBREW_LIVE = {
  id: 'Jm2dsXpe4KA',
  snippet: {
    title: 'מרכז דף יומי -  בכורות דף נח. - ר\' אלי סטפנסקי שליט"א (לא ערוך)',
    channelId: 'UCKwQa5DB_VR98ac_r-Wyl-g',
    publishedAt: '2026-11-14T20:33:00+00:00',
    liveBroadcastContent: 'live',
  },
  contentDetails: { duration: 'PT1H10M39S' },
  liveStreamingDetails: { actualStartTime: '2026-11-14T20:33:00Z' },
};

test('the real unedited titles parse as the main shiur, not Chazarah', () => {
  const english = parseChannelTitle(ENGLISH_LIVE.snippet.title, lookup);
  assert.deepEqual(
    { tractate: english.tractate, daf: english.daf, variant: english.variant, language: english.language },
    { tractate: 'Bekhorot', daf: 57, variant: 'regular', language: 'en' },
  );
  const hebrew = parseChannelTitle(HEBREW_LIVE.snippet.title, lookup);
  assert.equal(hebrew.daf, 58);
  assert.equal(hebrew.language, 'he');
  assert.equal(hebrew.variant, 'regular');
  const chazarah = parseChannelTitle('CHAZARAH - Bechoros Daf 56 | Nothing but the Daf', lookup);
  assert.equal(chazarah.variant, 'chazarah');
  assert.equal(planGroups([{ ...describeLiveVideo({
    id: 'chaz0000001',
    snippet: { title: chazarah && 'CHAZARAH - Bechoros Daf 56 | Nothing but the Daf', channelId: 'UCKwQa5DB_VR98ac_r-Wyl-g', liveBroadcastContent: 'live', publishedAt: NOW.toISOString() },
    liveStreamingDetails: { actualStartTime: NOW.toISOString() },
  }) }], lookup).length, 0);
});

test('videos.list describes a broadcast and ignores a normal upload', () => {
  const live = describeLiveVideo(ENGLISH_LIVE);
  assert.equal(live.liveStatus, 'live');
  assert.equal(live.durationSeconds, 1 * 3600 + 14 * 60 + 57);
  assert.equal(parseIsoDuration('PT45S'), 45);
  const upload = describeLiveVideo({ id: 'finalcut111', snippet: { liveBroadcastContent: 'none', title: 'edited' } });
  assert.equal(upload, null);
  assert.equal(videosListUrl(['aK6dGXjrTDw'], 'key').includes('search'), false);
  assert.match(videosListUrl(['aK6dGXjrTDw'], 'key'), /part=snippet,contentDetails,liveStreamingDetails/);
});

test('an edited link is never replaced, and two live ids keep the first', () => {
  const edited = { videoId: 'edit0000001', liveBroadcast: false };
  const first = { videoId: 'live0000001', liveStatus: 'live', durationSeconds: 600, liveBroadcast: true };
  const second = { videoId: 'live0000002', liveStatus: 'live', durationSeconds: 30, title: 'restart' };
  assert.equal(chooseLiveRecording(edited, second), 'keep');
  assert.equal(chooseLiveRecording(first, second), 'keep');
  assert.equal(selectRecording(edited, [second]).action, 'keep');
  const kept = selectRecording(first, [second]);
  assert.equal(kept.action, 'keep');
});

test('of two finished live recordings, the longer one wins', () => {
  const short = { videoId: 'short000001', liveStatus: 'finished', durationSeconds: 120, liveBroadcast: true, actualStartTime: '2026-11-14T20:00:00Z' };
  const long = { videoId: 'long0000001', liveStatus: 'finished', durationSeconds: 4200, title: 'full', actualStartTime: '2026-11-14T20:05:00Z', publishedAt: '2026-11-14T20:05:00Z' };
  assert.equal(chooseLiveRecording(short, long), 'replace');
  assert.equal(chooseLiveRecording(long, short), 'keep');
  assert.equal(selectRecording(short, [long]).video.videoId, 'long0000001');
});

test('a stream that is on the air replaces a finished restart, not the other way around', () => {
  const finished = { videoId: 'dead0000001', liveStatus: 'finished', durationSeconds: 90, liveBroadcast: true };
  const onAir = { videoId: 'onair000001', liveStatus: 'live', durationSeconds: 600, title: 'on air', actualStartTime: '2026-11-14T21:00:00Z' };
  assert.equal(chooseLiveRecording(finished, onAir), 'replace');
  assert.equal(chooseLiveRecording({ ...onAir, liveBroadcast: true }, { ...finished, title: 'done' }), 'keep');
});

test('words stay unhighlighted while live, and a different video\'s alignment is not used', () => {
  const source = { liveBroadcast: true, liveStatus: 'live', videoId: 'aK6dGXjrTDw' };
  assert.equal(shouldHighlightWords(source, null), false);
  assert.equal(shouldHighlightWords(source, { videoId: 'other000001', segments: [{ start: 1 }] }), false);
  assert.equal(shouldHighlightWords({ ...source, liveStatus: 'finished' }, { videoId: 'other000001', segments: [{ start: 1 }] }), false);
  assert.equal(shouldHighlightWords(
    { liveBroadcast: true, liveStatus: 'finished', videoId: 'aK6dGXjrTDw' },
    { videoId: 'aK6dGXjrTDw', segments: [{ start: 1 }] },
  ), true);
  assert.equal(shouldHighlightWords({ videoId: 'edit0000001' }, null), true);
  assert.equal(shouldDispatchLiveAlignment(source), false);
});

test('the hub challenge is echoed and a bad token is refused', () => {
  const url = `https://dafsync.netlify.app/api/youtube-live-webhook?hub.mode=subscribe&hub.topic=${encodeURIComponent(WEBSUB_TOPIC)}&hub.challenge=abc123&hub.verify_token=secret&hub.lease_seconds=432000`;
  const fields = hubFieldsFromUrl(url);
  assert.deepEqual(webSubVerification(fields, { verifyToken: 'secret' }), { ok: true, status: 200, body: 'abc123' });
  assert.equal(webSubVerification(fields, { verifyToken: 'other' }).status, 404);
  assert.equal(webSubVerification({ ...fields, topic: 'https://example.test/feed' }, { verifyToken: 'secret' }).status, 404);
  assert.deepEqual(parseAtomVideoIds('<feed><entry><yt:videoId>aK6dGXjrTDw</yt:videoId></entry></feed>'), ['aK6dGXjrTDw']);
});

test('the lease is renewed only in the three daily windows', () => {
  assert.equal(leaseRenewalDue(new Date('2026-11-14T04:00:00Z')), true);
  assert.equal(leaseRenewalDue(new Date('2026-11-14T04:07:00Z')), false);
  assert.equal(leaseRenewalDue(new Date('2026-11-14T12:00:00Z')), true);
  assert.equal(leaseRenewalDue(new Date('2026-11-14T15:00:00Z')), false);
});

function githubFetch({ files, puts, calls }) {
  return async (input, init = {}) => {
    const url = String(input);
    const method = init.method || 'GET';
    calls.push({ url, method });
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.includes('talmud_index.json')) {
      return new Response(fs.readFileSync(path.join(ROOT, 'talmud_index.json'), 'utf8'));
    }
    if (url.includes('googleapis.com/youtube/v3/search')) throw new Error('search.list must not be called');
    if (url.includes('/dispatches')) throw new Error('live ingest must not dispatch a job');
    if (url.includes('pubsubhubbub')) return new Response('', { status: 202 });
    if (url.includes('playlist_id=UULV')) {
      return new Response(`<feed><entry><yt:videoId>aK6dGXjrTDw</yt:videoId><title>${ENGLISH_LIVE.snippet.title}</title><published>${ENGLISH_LIVE.snippet.publishedAt}</published></entry><entry><yt:videoId>old00000001</yt:videoId><title>Daf Yomi Menachos daf 10</title><published>2018-01-01T00:00:00Z</published></entry></feed>`);
    }
    if (url.includes('googleapis.com/youtube/v3/videos')) {
      assert.match(url, /part=snippet,contentDetails,liveStreamingDetails/);
      assert.match(url, /aK6dGXjrTDw/);
      assert.equal(url.includes('old00000001'), false);
      return json({ items: [ENGLISH_LIVE] });
    }
    const contents = /\/contents\/([^?]+)/.exec(url);
    if (contents && method === 'GET') {
      const file = files[decodeURIComponent(contents[1])];
      if (!file) return json({ message: 'Not Found' }, 404);
      return json({ sha: 'sha-1', content: Buffer.from(JSON.stringify(file)).toString('base64') });
    }
    if (contents && method === 'PUT') {
      const body = JSON.parse(init.body);
      const decoded = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'));
      puts.push({ path: decodeURIComponent(contents[1]), decoded, message: body.message, branch: body.branch });
      return json({ ok: true });
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  };
}

test('a recent English live id is linked for both amudim and does not start OCR', async () => {
  const puts = [];
  const calls = [];
  const files = {};
  const described = describeLiveVideo(ENGLISH_LIVE);
  const result = await ingestDescribed([described], {
    fetchImpl: githubFetch({ files, puts, calls }),
    token: 'token',
    lookup,
    now: NOW,
  });
  assert.equal(result.dispatched, false);
  assert.equal(calls.some((call) => call.url.includes('/dispatches')), false);
  const links = puts.filter((put) => put.path.startsWith('video-links/'));
  assert.deepEqual(links.map((put) => put.path).sort(), [
    'video-links/Bekhorot-57a.json',
    'video-links/Bekhorot-57b.json',
  ]);
  assert.equal(links[0].decoded.liveBroadcast, true);
  assert.equal(links[0].decoded.liveStatus, 'live');
  assert.equal(links[0].decoded.videoId, 'aK6dGXjrTDw');
  assert.equal(links[0].decoded.locked, false);
  assert.equal(links[0].branch, 'results');
  assert.equal(links.some((put) => put.path.includes('56')), false);
  const catalog = puts.find((put) => put.path === 'catalog.json');
  const row = catalog.decoded.tractates.Bekhorot.find((item) => item.daf === 57);
  assert.equal(row.regularEn.liveBroadcast, true);
  assert.equal(row.regularEn.liveStatus, 'live');
  assert.equal(row.regularEn.videoId, 'aK6dGXjrTDw');
});

test('the poll verifies with videos.list and leaves an edited link in place', async () => {
  const puts = [];
  const calls = [];
  const files = {
    'video-links/Bekhorot-57a.json': { videoId: 'edit0000001', label: 'edited', source: 'channel-auto' },
    'video-links/Bekhorot-57b.json': { videoId: 'edit0000001', label: 'edited', source: 'channel-auto' },
    'catalog.json': { tractates: { Bekhorot: [{ daf: 57, regularEn: { videoId: 'edit0000001', label: 'edited', amud: 'a' } }] } },
  };
  const result = await pollLive({
    fetchImpl: githubFetch({ files, puts, calls }),
    token: 'token',
    apiKey: 'test-key',
    callback: 'https://dafsync.netlify.app/api/youtube-live-webhook',
    verifyToken: 'secret',
    now: new Date('2026-11-14T04:00:00Z'),
  });
  assert.equal(result.renewed, true);
  assert.equal(result.dispatched, false);
  assert.equal(calls.some((call) => call.url.includes('/youtube/v3/search')), false);
  assert.equal(calls.some((call) => call.url.includes('/dispatches')), false);
  assert.ok(calls.some((call) => call.url.includes('pubsubhubbub') && call.method === 'POST'));
  assert.deepEqual(result.checked, ['aK6dGXjrTDw']);
  assert.equal(puts.some((put) => put.path.startsWith('video-links/')), false);
  assert.ok(result.skipped.some((item) => item.reason === 'edited upload stays'));
});

test('the webhook repeats the hub challenge as plain text', async () => {
  globalThis.Netlify = { env: { get: (key) => (key === 'YOUTUBE_WEBSUB_TOKEN' ? 'secret' : '') } };
  const { default: handler } = await import(`../../netlify/functions/youtube-live-webhook.mjs?${Date.now()}`);
  const url = `https://dafsync.netlify.app/api/youtube-live-webhook?hub.mode=subscribe&hub.topic=${encodeURIComponent(WEBSUB_TOPIC)}&hub.challenge=challenge-token&hub.verify_token=secret`;
  const response = await handler(new Request(url));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'challenge-token');
  assert.match(response.headers.get('content-type'), /text\/plain/);
});
