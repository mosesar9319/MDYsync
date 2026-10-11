// Where a Live Follow video transcript stands: GET /api/live-video-status
// ?url=<video link>&daf=<Chullin 91a>&kt=1&lang=he. Answers
//   { status: 'absent' }                     nothing has been started
//   { status: 'pending' }                    ElevenLabs is working on it
//   { status: 'error', error }               it failed -- start again to retry
//   { status: 'done', words, languageCode, seconds }  words: [[text, start, end], ...]
// A bad link is a 400 here, which is the page's first and only feedback on
// one: the job function it then triggers answers 202 whatever it decides.

import { isAllowedOrigin, acceptVideoUrl, jobKey, jobStore, PENDING_STALE_MS } from '../../shared/live-video-job.mjs';

export async function readStatus({ request, store, now = () => Date.now() }) {
  // Read-only and free to call (it only looks at what the job function has
  // stored), so a same-origin GET -- which browsers send with no Origin header
  // -- is fine; a foreign Origin is still turned away.
  const origin = request.headers.get('Origin');
  if (origin && !isAllowedOrigin(origin)) return { code: 403, body: { error: 'Origin not permitted.' } };
  const params = new URL(request.url).searchParams;
  const video = acceptVideoUrl(params.get('url'));
  if (!video) {
    return { code: 400, body: { error: 'Use a YouTube link, or a direct https link to an audio or video file (.mp3, .m4a, .mp4, .webm …).' } };
  }
  const key = jobKey({
    url: video.url, daf: (params.get('daf') || '').slice(0, 80), withKeyterms: params.get('kt') === '1', language: params.get('lang') === 'he' ? 'he' : undefined,
  });
  const job = await store.get(key, { type: 'json' }).catch(() => null);
  if (!job) return { code: 200, body: { status: 'absent', url: video.url, kind: video.kind } };
  if (job.status === 'pending') {
    return now() - job.startedAt < PENDING_STALE_MS
      ? { code: 200, body: { status: 'pending', elapsedMs: now() - job.startedAt } }
      : { code: 200, body: { status: 'absent', url: video.url, kind: video.kind } };
  }
  if (job.status === 'error') return { code: 200, body: { status: 'error', error: job.error, detail: job.detail } };
  return { code: 200, body: { status: 'done', words: job.words, languageCode: job.languageCode, seconds: job.seconds } };
}

export default async (request) => {
  if (request.method !== 'GET') return Response.json({ error: 'Method not allowed' }, { status: 405 });
  const { code, body } = await readStatus({ request, store: jobStore() });
  return Response.json(body, { status: code, headers: { 'Cache-Control': 'no-store' } });
};

export const config = { path: '/api/live-video-status' };
