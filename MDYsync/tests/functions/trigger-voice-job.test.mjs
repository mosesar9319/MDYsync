// trigger-voice-job.mjs: the channel rule holds for everyone but a verified admin.
// Every network call is stubbed. Run with `npm run test:functions`.

import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.Netlify = { env: { get: (key) => (key === 'GITHUB_DISPATCH_TOKEN' ? 'test-token' : undefined) } };
const { default: handler } = await import('../../netlify/functions/trigger-voice-job.mjs');

const OTHER_RAV = 'https://youtu.be/wa16SOzLTRQ';
const OWN_CHANNEL = 'https://youtu.be/abcdefghijk';
const JWT = 'aaaa.bbbb.cccc';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// A stand-in for everything the function reaches: the channel's feed (which lists
// only OWN_CHANNEL's video), the video-links catalog (nothing), Supabase (JWT is an
// admin iff `admin`), and GitHub's dispatch endpoint (recorded).
function world({ admin = false, supabaseDown = false } = {}) {
  const seen = { dispatches: [], supabase: 0, feed: 0 };
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('youtube.com/feeds/videos.xml')) { seen.feed += 1; return new Response('<feed><yt:videoId>abcdefghijk</yt:videoId></feed>'); }
    if (u.startsWith('https://raw.githubusercontent.com/')) return new Response('nope', { status: 404 });
    if (u.includes('.supabase.co/auth/v1/user')) {
      seen.supabase += 1;
      if (supabaseDown) throw new TypeError('fetch failed');
      return init.headers.Authorization === `Bearer ${JWT}` ? json({ id: 'u1' }) : json({}, 401);
    }
    if (u.includes('.supabase.co/rest/v1/profiles')) return json([{ is_admin: admin }]);
    if (u === 'https://api.github.com/repos/mosesar9319/MDYsync/dispatches') { seen.dispatches.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); }
    throw new Error(`unexpected request to ${u}`);
  };
  return { seen, restore: () => { globalThis.fetch = real; } };
}

const call = (body, { origin = 'https://dafsync.netlify.app', token = null } = {}) => handler(new Request('https://x.test/api/trigger-voice-job', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
}));
const body = (youtubeUrl) => ({ youtubeUrl, refs: ['Bekhorot 21a', 'Bekhorot 21b'], variant: 'regular', language: 'en' });

test('a video from the authorized channel is accepted for anyone, as before', async () => {
  const w = world();
  try {
    const response = await call(body(OWN_CHANNEL));
    assert.equal(response.status, 200);
    assert.equal(w.seen.dispatches.length, 1);
    assert.equal(w.seen.dispatches[0].event_type, 'run-voice-job');
    assert.equal(w.seen.supabase, 0, 'no token, nothing asked of Supabase');
  } finally { w.restore(); }
});

test('another channel\'s video is refused for an anonymous caller, and nothing is dispatched', async () => {
  const w = world();
  try {
    const response = await call(body(OTHER_RAV));
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /sign in as an admin/);
    assert.equal(w.seen.dispatches.length, 0);
  } finally { w.restore(); }
});

test('another channel\'s video is accepted for a verified admin, and the job is dispatched', async () => {
  const w = world({ admin: true });
  try {
    const response = await call(body(OTHER_RAV), { token: JWT });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.ok(result.jobId && result.resultUrl.includes('Voice-Bekhorot-21a'));
    assert.equal(w.seen.dispatches.length, 1);
    assert.deepEqual(w.seen.dispatches[0].client_payload.refs, ['Bekhorot 21a', 'Bekhorot 21b']);
    assert.equal(w.seen.dispatches[0].client_payload.youtubeUrl, OTHER_RAV);
    assert.equal(w.seen.feed, 0, 'an admin does not need the channel feed at all');
  } finally { w.restore(); }
});

test('a signed-in user who is not an admin is held to the channel rule', async () => {
  const w = world({ admin: false });
  try {
    assert.equal((await call(body(OTHER_RAV), { token: JWT })).status, 403);
    assert.equal(w.seen.dispatches.length, 0);
  } finally { w.restore(); }
});

test('a forged token, or Supabase being down, does not unlock it', async () => {
  let w = world({ admin: true });
  try {
    assert.equal((await call(body(OTHER_RAV), { token: 'forged.token.value' })).status, 403);
  } finally { w.restore(); }
  w = world({ admin: true, supabaseDown: true });
  try {
    assert.equal((await call(body(OTHER_RAV), { token: JWT })).status, 403);
    assert.equal(w.seen.dispatches.length, 0);
  } finally { w.restore(); }
});

test('an admin still has to send a valid link, readings and an allowed origin', async () => {
  const w = world({ admin: true });
  try {
    assert.equal((await call({ ...body(OTHER_RAV), youtubeUrl: 'https://vimeo.com/123' }, { token: JWT })).status, 400);
    assert.equal((await call({ ...body(OTHER_RAV), refs: [] }, { token: JWT })).status, 400);
    assert.equal((await call(body(OTHER_RAV), { token: JWT, origin: 'https://evil.example' })).status, 403);
    assert.equal(w.seen.dispatches.length, 0);
  } finally { w.restore(); }
});
