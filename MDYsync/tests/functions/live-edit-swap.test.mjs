// Phase 3: hold the live video until the edit's alignment exists, never
// let a live id take the daf back, and never write a lead-in onto the
// previous daf.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  decideUpload,
  editedLinkFrom,
  linkReadingsOnly,
  unavailableVideoIds,
} from '../../shared/live-edit-swap.mjs';
import { readingsForVideo, buildTalmudLookup, parseChannelTitle } from '../../shared/mdy-channel.mjs';
import { chooseLiveRecording, describeLiveVideo } from '../../shared/live-broadcast.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const lookup = buildTalmudLookup(JSON.parse(fs.readFileSync(path.join(ROOT, 'talmud_index.json'), 'utf8')));

test('the swap waits for the edit alignment, then a live id cannot undo it', () => {
  const live = { videoId: 'live0000001', liveBroadcast: true, liveStatus: 'finished' };
  const now = new Date('2026-11-15T12:00:00Z');
  assert.equal(decideUpload({ existing: live, videoId: 'edit0000001', aligned: false, now }).action, 'hold');
  assert.equal(decideUpload({ existing: live, videoId: 'edit0000001', aligned: false, now }).dispatch, true);
  const held = {
    ...live,
    pendingEdit: { videoId: 'edit0000001', dispatchedAt: '2026-11-15T12:00:00Z' },
  };
  const again = decideUpload({ existing: held, videoId: 'edit0000001', aligned: false, now: new Date('2026-11-15T12:10:00Z') });
  assert.equal(again.action, 'hold');
  assert.equal(again.dispatch, false);
  assert.equal(decideUpload({ existing: held, videoId: 'edit0000001', aligned: true, now }).action, 'swap');
  const swapped = editedLinkFrom(held, { videoId: 'edit0000001', label: 'edited' });
  assert.equal(swapped.videoId, 'edit0000001');
  assert.equal(swapped.liveBroadcast, undefined);
  assert.equal(chooseLiveRecording(swapped, { videoId: 'live0000001', liveStatus: 'live' }), 'keep');
  assert.equal(decideUpload({ existing: { videoId: 'edit0000001' }, videoId: 'edit0000001', aligned: true, now }).action, 'same');
});

test('a Hebrew edit is not linked as the English shiur', () => {
  const parsed = parseChannelTitle('מרכז דף יומי - בכורות דף נח. - ר\' אלי סטפנסקי שליט"א', lookup);
  assert.equal(parsed.language, 'he');
  const readings = readingsForVideo(parsed, lookup);
  const linked = linkReadingsOnly(parsed, readings);
  assert.ok(linked.every((reading) => reading.language === 'he' && reading.daf === 58));
  assert.equal(linked.some((reading) => reading.language === 'en'), false);
});

test('a lead-in is not a video link for the previous daf', () => {
  const parsed = parseChannelTitle("Daf Yomi Bechoros Daf 4 by R' Eli Stefansky", lookup);
  const readings = readingsForVideo(parsed, lookup);
  const linked = linkReadingsOnly(parsed, readings);
  assert.ok(readings.some((reading) => reading.daf === 3 && reading.amud === 'b'));
  assert.deepEqual(linked.map((reading) => `${reading.daf}${reading.amud}`), ['4a', '4b']);
});

test('a private or missing live id is not a video we can link', () => {
  assert.deepEqual(
    unavailableVideoIds(['gone0000001', 'still000001'], [
      { id: 'still000001', status: { privacyStatus: 'public' } },
      { id: 'priv0000001', status: { privacyStatus: 'private' } },
    ]).sort(),
    ['gone0000001', 'priv0000001'],
  );
  assert.equal(describeLiveVideo({
    id: 'priv0000001',
    status: { privacyStatus: 'private' },
    snippet: { liveBroadcastContent: 'none', title: 'old' },
    liveStreamingDetails: { actualEndTime: '2026-11-14T00:00:00Z' },
  }), null);
});

function feedXml(entries) {
  return `<feed>${entries.map((entry) => `<entry><yt:videoId>${entry.id}</yt:videoId><title>${entry.title}</title><published>${entry.published}</published></entry>`).join('')}</feed>`;
}

test('the hourly sync does not give the previous daf this shiur, and holds a live link until the edit is synced', async () => {
  const puts = [];
  const dispatches = [];
  const files = {
    'video-links/Bekhorot-4a.json': {
      type: 'youtube', videoId: 'live0000001', liveBroadcast: true, liveStatus: 'finished',
      label: 'unedited', source: 'live-auto',
    },
    'video-links/Bekhorot-4b.json': {
      type: 'youtube', videoId: 'live0000001', liveBroadcast: true, liveStatus: 'finished',
      label: 'unedited', source: 'live-auto',
    },
  };
  const talmud = fs.readFileSync(path.join(ROOT, 'talmud_index.json'), 'utf8');
  globalThis.Netlify = { env: { get: (key) => (key === 'GITHUB_DISPATCH_TOKEN' ? 'token' : key === 'YOUTUBE_API_KEY' ? 'key' : '') } };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method || 'GET';
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.includes('talmud_index.json')) return new Response(talmud);
    if (url.includes('settings.json')) return json({ autoSyncNewUploads: true });
    if (url.includes('playlist_id=UULF')) {
      return new Response(feedXml([{
        id: 'edit0000001',
        title: "Daf Yomi Bechoros Daf 4 by R' Eli Stefansky",
        published: '2026-11-15T18:00:00Z',
      }]));
    }
    if (url.includes('googleapis.com/youtube/v3/videos')) return json({ items: [] });
    if (url.includes('/git/trees/results')) {
      return json({
        tree: Object.keys(files).map((file) => ({ type: 'blob', path: file })),
      });
    }
    if (url.includes('/dispatches')) {
      dispatches.push(JSON.parse(init.body));
      return new Response(null, { status: 204 });
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
      puts.push({ path: decodeURIComponent(contents[1]), decoded });
      files[decodeURIComponent(contents[1])] = decoded;
      return json({ ok: true });
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  try {
    const { default: handler } = await import(`../../netlify/functions/youtube-channel-sync.mjs?hold=${Date.now()}`);
    const held = await handler(new Request('https://example.test/'));
    assert.equal(held.status, 200);
    assert.equal(puts.some((put) => put.path.includes('Bekhorot-3')), false);
    const link = puts.find((put) => put.path === 'video-links/Bekhorot-4a.json');
    assert.equal(link.decoded.videoId, 'live0000001');
    assert.equal(link.decoded.pendingEdit.videoId, 'edit0000001');
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0].client_payload.liveRecording, undefined);
    assert.equal(dispatches[0].client_payload.youtubeUrl.includes('edit0000001'), true);
    assert.ok(dispatches[0].client_payload.refs.includes('Bekhorot 3b'));
    assert.equal(puts.some((put) => put.path === 'catalog.json'), false);

    files['by-video/edit0000001.json'] = { videoId: 'edit0000001', segments: [{}] };
    puts.length = 0;
    const { default: again } = await import(`../../netlify/functions/youtube-channel-sync.mjs?swap=${Date.now()}`);
    await again(new Request('https://example.test/'));
    const swapped = puts.filter((put) => put.path === 'video-links/Bekhorot-4a.json').at(-1);
    assert.equal(swapped.decoded.videoId, 'edit0000001');
    assert.equal(swapped.decoded.liveBroadcast, undefined);
    assert.equal(dispatches.length, 1);
    const catalog = puts.find((put) => put.path === 'catalog.json');
    assert.equal(catalog.decoded.tractates.Bekhorot.find((row) => row.daf === 4).regularEn.videoId, 'edit0000001');
    assert.equal(catalog.decoded.tractates.Bekhorot.find((row) => row.daf === 4).regularEn.liveBroadcast, undefined);
  } finally {
    globalThis.fetch = realFetch;
  }
});
