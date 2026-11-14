// YouTube's WebSub (PubSubHubbub) callback. The hub verifies a
// subscription by asking this URL to repeat hub.challenge. Later it POSTs
// an Atom entry when a video on the channel changes. A notification is
// not trusted on its own: videos.list must say liveBroadcastContent is
// "live" (or a recent finished broadcast) before anything is linked.
//
// This does not use search.list. It does not start an alignment job.

import { parseAtomVideoIds, webSubVerification } from '../../shared/live-broadcast.mjs';
import { ingestDescribed, loadLookup, verifyVideoIds, webSubCallbackFromEnv } from '../../shared/live-publish.mjs';

async function hubFields(request) {
  const url = new URL(request.url);
  const fields = {
    mode: url.searchParams.get('hub.mode') || '',
    topic: url.searchParams.get('hub.topic') || '',
    challenge: url.searchParams.get('hub.challenge') || '',
    leaseSeconds: url.searchParams.get('hub.lease_seconds') || '',
    verifyToken: url.searchParams.get('hub.verify_token') || '',
  };
  if (request.method === 'POST') {
    const type = request.headers.get('content-type') || '';
    const text = await request.text();
    if (type.includes('application/x-www-form-urlencoded')) {
      const form = new URLSearchParams(text);
      fields.mode = form.get('hub.mode') || fields.mode;
      fields.topic = form.get('hub.topic') || fields.topic;
      fields.challenge = form.get('hub.challenge') || fields.challenge;
      fields.leaseSeconds = form.get('hub.lease_seconds') || fields.leaseSeconds;
      fields.verifyToken = form.get('hub.verify_token') || fields.verifyToken;
      fields.body = '';
    } else {
      fields.body = text;
    }
  }
  return fields;
}

export default async (request) => {
  const envGet = (name) => Netlify.env.get(name) || '';
  const fields = await hubFields(request);
  if (fields.mode === 'subscribe' || fields.mode === 'unsubscribe') {
    const verdict = webSubVerification(fields, { verifyToken: envGet('YOUTUBE_WEBSUB_TOKEN') });
    return new Response(verdict.body, {
      status: verdict.status,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }
  const ids = parseAtomVideoIds(fields.body || '');
  if (!ids.length) return Response.json({ published: [], skipped: [], reason: 'no video id' });
  const verified = await verifyVideoIds(ids, {
    fetchImpl: fetch,
    apiKey: envGet('YOUTUBE_API_KEY'),
  });
  if (verified.error) return Response.json({ published: [], skipped: [], error: verified.error });
  const onAirOrFresh = verified.videos.filter((video) => video.liveStatus === 'live' || video.liveStatus === 'finished');
  if (!onAirOrFresh.length) return Response.json({ published: [], skipped: [], reason: 'not a live broadcast' });
  let lookup;
  try {
    lookup = await loadLookup(fetch);
  } catch (error) {
    return Response.json({ error: error.message }, { status: 502 });
  }
  const result = await ingestDescribed(onAirOrFresh, {
    fetchImpl: fetch,
    token: envGet('GITHUB_DISPATCH_TOKEN'),
    lookup,
  });
  // Touched so a deploy log shows which callback the hub should be using.
  void webSubCallbackFromEnv(envGet);
  return Response.json(result);
};

export const config = {
  path: '/api/youtube-live-webhook',
};
