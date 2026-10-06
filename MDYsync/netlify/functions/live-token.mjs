// Mints a short-lived ElevenLabs token for Live Follow (the real-time
// "listen to a live shiur and highlight the daf as it's read" experiment --
// see /live/). The browser connects straight to ElevenLabs' realtime
// WebSocket itself (mic audio never passes through this server), but that
// connection needs *some* credential, and the real xi-api-key must never
// reach a browser -- anyone who read it out of page source could run up
// ElevenLabs usage on this account indefinitely. A single-use token (good
// for one WebSocket connection, expires after 15 minutes if unused) is
// ElevenLabs' own answer to exactly this: mint it server-side, hand only
// the token to the browser.
//
// Same Origin allowlist as save-settings.mjs/trigger-voice-job.mjs -- the
// only abuse guard this function has for now. That's an accepted gap for an
// experiment behind an unlisted /live/ page, not a production posture: once
// this leaves V1, minting should also require a signed-in session (none of
// this repo's existing functions check that either, but none of them front
// a metered paid API the way this one does).

const ALLOWED_ORIGINS = new Set([
  'https://dafsync.netlify.app',
  'https://main--dafsync.netlify.app',
  'http://localhost:8080',
]);
// Unlike the admin functions this list is copied from, Live Follow has to
// work on a PR's deploy preview too -- that's the only place it can be tried
// before merging, and the browser sends the preview's own origin with this
// POST, which the fixed list above refused outright.
const DEPLOY_PREVIEW_ORIGIN = /^https:\/\/deploy-preview-\d+--dafsync\.netlify\.app$/;

export default async (request) => {
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  const origin = request.headers.get('Origin') || '';
  if (!ALLOWED_ORIGINS.has(origin) && !DEPLOY_PREVIEW_ORIGIN.test(origin)) {
    return Response.json({ error: 'Origin not permitted.' }, { status: 403 });
  }

  const apiKey = Netlify.env.get('ELEVENLABS_API_KEY');
  if (!apiKey) {
    return Response.json({ error: 'Live Follow is not configured yet.' }, { status: 503 });
  }

  let response;
  try {
    response = await fetch('https://api.elevenlabs.io/v1/single-use-token/realtime_scribe', {
      method: 'POST',
      headers: { 'xi-api-key': apiKey },
    });
  } catch (error) {
    return Response.json({ error: `Could not reach ElevenLabs: ${error.message}` }, { status: 502 });
  }
  if (!response.ok) {
    const detail = await response.text();
    return Response.json({ error: 'ElevenLabs refused to issue a token.', detail }, { status: 502 });
  }
  const { token } = await response.json();
  if (!token) {
    return Response.json({ error: 'ElevenLabs returned no token.' }, { status: 502 });
  }

  return Response.json({ token }, {
    headers: { 'Access-Control-Allow-Origin': origin, 'Cache-Control': 'no-store' },
  });
};

export const config = {
  path: '/api/live-token',
};
