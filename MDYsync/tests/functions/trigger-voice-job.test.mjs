// trigger-voice-job.mjs: which videos the voice sync accepts (recent uploads of
// the channels the site follows), and under which key the result will appear.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const MDY = 'UCKwQa5DB_VR98ac_r-Wyl-g';
const LAKEWOOD = 'UCyk5Q9nuhwqJC_-zrP2Ojcg';

async function trigger({ videoId, feeds = {}, linked = {}, body = {} }) {
  const dispatches = [];
  globalThis.Netlify = { env: { get: (k) => (k === 'GITHUB_DISPATCH_TOKEN' ? 'token' : undefined) } };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const feed = /channel_id=([\w-]+)/.exec(url);
    if (feed) return new Response((feeds[feed[1]] || []).map((id) => `<yt:videoId>${id}</yt:videoId>`).join(''));
    const link = /results\/video-links\/([^/?]+)\.json/.exec(url);
    if (link) {
      const key = decodeURIComponent(link[1]);
      return linked[key] ? new Response(JSON.stringify({ videoId: linked[key] })) : new Response('{}', { status: 404 });
    }
    if (url.endsWith('/dispatches')) { dispatches.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); }
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const { default: handler } = await import(`../../netlify/functions/trigger-voice-job.mjs?${Math.random()}`);
    const response = await handler(new Request('https://dafsync.netlify.app/api/trigger-voice-job', {
      method: 'POST',
      headers: { Origin: 'https://dafsync.netlify.app', 'Content-Type': 'application/json' },
      body: JSON.stringify({ youtubeUrl: `https://www.youtube.com/watch?v=${videoId}`, refs: ['Bekhorot 2a', 'Bekhorot 2b'], ...body }),
    }));
    return { status: response.status, json: await response.json(), dispatches };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('a recent Lakewood Daf Yomi upload is accepted and published behind the Bernstein prefix', async () => {
  const { status, json, dispatches } = await trigger({ videoId: 'Zsy7oDUP6Pw', feeds: { [LAKEWOOD]: ['Zsy7oDUP6Pw'], [MDY]: ['CNu3Ba5XCao'] } });
  assert.equal(status, 200);
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].event_type, 'run-voice-job');
  assert.equal(dispatches[0].client_payload.maggid, 'bernstein');
  assert.match(json.resultUrl, /by-ref\/Voice-Bernstein-Bekhorot-2a\.json$/);
});

test('a Mercaz Daf Yomi upload is published exactly as before, with no maggid in the job', async () => {
  const { status, json, dispatches } = await trigger({ videoId: 'CNu3Ba5XCao', feeds: { [LAKEWOOD]: ['Zsy7oDUP6Pw'], [MDY]: ['CNu3Ba5XCao'] } });
  assert.equal(status, 200);
  assert.equal('maggid' in dispatches[0].client_payload, false);
  assert.match(json.resultUrl, /by-ref\/Voice-Bekhorot-2a\.json$/);
});

test('a video of some other channel is refused', async () => {
  const { status, json, dispatches } = await trigger({ videoId: 'aaaaaaaaaaa', feeds: { [LAKEWOOD]: ['Zsy7oDUP6Pw'], [MDY]: ['CNu3Ba5XCao'] } });
  assert.equal(status, 403);
  assert.match(json.error, /Lakewood Daf Yomi/);
  assert.equal(dispatches.length, 0);
});

test('an older Lakewood video (off the 15-newest feed) is accepted when it is linked for the daf', async () => {
  const { status, dispatches } = await trigger({
    videoId: 'Zsy7oDUP6Pw', feeds: { [LAKEWOOD]: [], [MDY]: [] },
    linked: { 'Bernstein-Bekhorot-2a': 'Zsy7oDUP6Pw' }, body: { maggid: 'bernstein' },
  });
  assert.equal(status, 200);
  assert.equal(dispatches[0].client_payload.maggid, 'bernstein');
});

test('a claimed maggid does not vouch for a video that is linked under nobody\'s name', async () => {
  const { status } = await trigger({ videoId: 'Zsy7oDUP6Pw', feeds: { [LAKEWOOD]: [], [MDY]: [] }, linked: { 'Bekhorot-2a': 'someoneelse1' }, body: { maggid: 'bernstein' } });
  assert.equal(status, 403);
});
