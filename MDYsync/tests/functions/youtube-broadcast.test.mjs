// Livestreams vs finished uploads. The classifier reads a YouTube Data API
// videos.list body (snippet.liveBroadcastContent + liveStreamingDetails).
// A past broadcast reports liveBroadcastContent "none" once it ends, and is
// still a livestream because liveStreamingDetails stays.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  isLivestreamVideo,
  livestreamIdsAmong,
  livestreamIdsFromVideosList,
  MDY_CHANNEL_ID,
  recentUploadFeedUrl,
} from '../../shared/youtube-broadcast.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const API = {
  items: [
    {
      id: 'livepast111',
      snippet: { liveBroadcastContent: 'none' },
      liveStreamingDetails: { actualStartTime: '2026-10-01T15:00:00Z', actualEndTime: '2026-10-01T16:30:00Z' },
    },
    {
      id: 'upcoming111',
      snippet: { liveBroadcastContent: 'upcoming' },
      liveStreamingDetails: { scheduledStartTime: '2026-10-02T15:00:00Z' },
    },
    {
      id: 'stilllive11',
      snippet: { liveBroadcastContent: 'live' },
      liveStreamingDetails: { actualStartTime: '2026-10-29T15:00:00Z' },
    },
    { id: 'finalcut111', snippet: { liveBroadcastContent: 'none' } },
    { id: 'nodetails1', snippet: { liveBroadcastContent: 'none' }, liveStreamingDetails: {} },
  ],
};

test('a past broadcast is a livestream; a finished upload is not', () => {
  assert.equal(isLivestreamVideo(API.items[0]), true, 'ended broadcast keeps liveStreamingDetails');
  assert.equal(isLivestreamVideo(API.items[1]), true);
  assert.equal(isLivestreamVideo(API.items[2]), true);
  assert.equal(isLivestreamVideo(API.items[3]), false);
  assert.equal(isLivestreamVideo(API.items[4]), false, 'empty liveStreamingDetails is not a broadcast');
  assert.deepEqual(
    [...livestreamIdsFromVideosList(API)].sort(),
    ['livepast111', 'stilllive11', 'upcoming111'],
  );
});

test('livestreamIdsAmong reads a mocked videos.list response', async () => {
  const seen = [];
  const ids = await livestreamIdsAmong(['livepast111', 'finalcut111', 'stilllive11'], {
    apiKey: 'test-key',
    channelId: MDY_CHANNEL_ID,
    fetchImpl: async (url) => {
      seen.push(String(url));
      assert.match(String(url), /googleapis\.com\/youtube\/v3\/videos\?/);
      assert.match(String(url), /part=snippet,liveStreamingDetails/);
      assert.match(String(url), /livepast111/);
      return new Response(JSON.stringify(API), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  assert.equal(seen.length, 1);
  assert.equal(ids.has('livepast111'), true);
  assert.equal(ids.has('stilllive11'), true);
  assert.equal(ids.has('finalcut111'), false);
});

test('without an API key, ids on the Live-tab feed are the livestreams', async () => {
  const xml = '<feed><entry><yt:videoId>livepast111</yt:videoId><title>unedited</title></entry></feed>';
  const ids = await livestreamIdsAmong(['livepast111', 'finalcut111'], {
    apiKey: '',
    channelId: MDY_CHANNEL_ID,
    fetchImpl: async (url) => {
      assert.match(String(url), /playlist_id=UULVKwQa5DB_VR98ac_r-Wyl-g/);
      return new Response(xml);
    },
  });
  assert.deepEqual([...ids], ['livepast111']);
});

test('Mercaz Daf Yomi is ingested from the Videos tab, not the mixed uploads feed', () => {
  assert.equal(
    recentUploadFeedUrl(MDY_CHANNEL_ID),
    'https://www.youtube.com/feeds/videos.xml?playlist_id=UULFKwQa5DB_VR98ac_r-Wyl-g',
  );
});

function feedXml(entries) {
  return `<feed>${entries.map((e) => `<entry><yt:videoId>${e.id}</yt:videoId><title>${e.title}</title><published>${e.published}</published></entry>`).join('')}</feed>`;
}

test('the channel sync does not link a livestream the Data API marks as a past broadcast', async () => {
  const puts = [];
  const talmud = fs.readFileSync(path.join(ROOT, 'talmud_index.json'), 'utf8');
  const mdyFeed = [
    { id: 'livepast111', title: "Daf Yomi Bechoros Daf 2 by R' Eli Stefansky", published: '2026-10-29T12:00:00+00:00' },
    { id: 'finalcut111', title: "Daf Yomi Bechoros Daf 3 by R' Eli Stefansky", published: '2026-10-28T12:00:00+00:00' },
  ];
  globalThis.Netlify = {
    env: { get: (k) => (k === 'GITHUB_DISPATCH_TOKEN' ? 'token' : k === 'YOUTUBE_API_KEY' ? 'test-key' : undefined) },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method || 'GET';
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.includes('talmud_index.json')) return new Response(talmud);
    if (url.includes('settings.json')) return json({});
    if (url.includes('playlist_id=UULFKwQa5DB_VR98ac_r-Wyl-g')) return new Response(feedXml(mdyFeed));
    if (url.includes('googleapis.com/youtube/v3/videos')) return json(API);
    if (url.includes('/git/trees/results')) return json({ tree: [] });
    const contents = /\/contents\/([^?]+)/.exec(url);
    if (contents && method === 'GET') return json({ message: 'Not Found' }, 404);
    if (contents && method === 'PUT') {
      const body = JSON.parse(init.body);
      puts.push({ path: contents[1], content: JSON.parse(Buffer.from(body.content, 'base64').toString('utf8')) });
      return json({ ok: true });
    }
    if (url.endsWith('/dispatches')) return new Response(null, { status: 204 });
    throw new Error(`unexpected fetch ${method} ${url}`);
  };
  try {
    const { default: handler } = await import(`../../netlify/functions/youtube-channel-sync.mjs?${Math.random()}`);
    const response = await handler(new Request('https://example.test/'));
    const body = await response.json();
    const links = puts.filter((p) => p.path.startsWith('video-links/'));
    assert.equal(links.some((p) => p.content.videoId === 'livepast111'), false);
    assert.ok(links.some((p) => p.path === 'video-links/Bekhorot-3a.json' && p.content.videoId === 'finalcut111'));
    assert.equal(links.some((p) => p.path === 'video-links/Bekhorot-2a.json'), false);
    assert.ok(body.skipped.some((s) => s.videoId === 'livepast111' && s.reason === 'live stream or past broadcast'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('backfill skips Live-tab ids and lines marked as livestreams', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-live-'));
  fs.writeFileSync(path.join(dir, 'videos.txt'), [
    "livepast111|||Daf Yomi Bechoros Daf 2 by R' Eli Stefansky",
    "waslive1111|||Daf Yomi Bechoros Daf 4 by R' Eli Stefansky|||was_live",
    "finalcut111|||Daf Yomi Bechoros Daf 3 by R' Eli Stefansky",
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'live.txt'), 'livepast111\n');
  const out = execFileSync('node', [
    path.join(ROOT, 'tools', 'backfill-video-links.mjs'),
    '--videos', path.join(dir, 'videos.txt'),
    '--exclude', path.join(dir, 'live.txt'),
    '--tractate', 'Bekhorot',
    '--dry-run',
  ], { encoding: 'utf8' });
  const linked = out.split('\n').filter((line) => line.trim().startsWith('+'));
  assert.ok(linked.some((line) => line.includes('finalcut111')));
  assert.ok(linked.every((line) => !line.includes('livepast111') && !line.includes('waslive1111')));
  assert.match(out, /2 live stream\(s\) skipped/);
});
