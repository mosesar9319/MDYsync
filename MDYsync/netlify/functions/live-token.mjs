// Mints a short-lived ElevenLabs token for Live Follow (the real-time
// "listen to a live shiur and highlight the daf as it's read" experiment --
// see live-follow.js on the Interactive Daf page). The browser connects straight to ElevenLabs' realtime
// WebSocket itself (mic audio never passes through this server), but that
// connection needs *some* credential, and the real xi-api-key must never
// reach a browser -- anyone who read it out of page source could run up
// ElevenLabs usage on this account indefinitely. A single-use token (good
// for one WebSocket connection, expires after 15 minutes if unused) is
// ElevenLabs' own answer to exactly this: mint it server-side, hand only
// the token to the browser.
//
// Origin allowlist is the shared production list (the same hosts
// save-settings.mjs and trigger-voice-job.mjs use) plus numbered deploy
// previews. Unlike those admin functions, Live Follow has to work on a PR's
// deploy preview too -- that's the only place it can be tried before merging,
// and the browser sends the preview's own origin with this POST.
// isAllowedPreviewOrigin is that shared list plus
// deploy-preview-<n>--dafsync.netlify.app, not every branch deploy.
//
// That origin check is the only abuse guard this function has for now. That's
// an accepted gap for an experiment behind a switch on the Interactive Daf
// page, not a production posture: once this leaves V1, minting should also
// require a signed-in session (none of this repo's existing functions check
// that either, but none of them front a metered paid API the way this one does).

import { isAllowedPreviewOrigin } from '../../shared/dafsync-config.mjs';

export default async (request) => {
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  const origin = request.headers.get('Origin') || '';
  if (!isAllowedPreviewOrigin(origin)) {
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
