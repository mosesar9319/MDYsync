// Transcribes a video link for Live Follow's "Server transcript" mode. A
// BACKGROUND function (the -background suffix: it answers 202 at once and may
// run for up to 15 minutes), because ElevenLabs transcribes a whole video in
// one synchronous call that can outlast an ordinary function's 10 seconds.
//
// POST body: { url, daf?, keyterms?, language? }. The result -- or the error
// -- is written to Netlify Blobs under a key made from the request, and
// /api/live-video-status reads it from there. The status function has
// already vetted the request by the time the page calls this (a background
// function's own response is never seen), but everything is checked again:
// this is the one that spends money.
//
// Same Origin allowlist as the other Live Follow functions -- the only abuse
// guard for now, an accepted gap for an unlisted experiment.

import {
  isAllowedOrigin, acceptVideoUrl, sanitizeKeyterms, jobKey, buildTranscribeFields, compactWords, jobStore, PENDING_STALE_MS,
} from '../../shared/live-video-job.mjs';

const UPSTREAM_TIMEOUT_MS = 14 * 60 * 1000; // inside the 15 minute limit

function buildMultipartBody(fields) {
  const boundary = `----dafsync${crypto.randomUUID().replace(/-/g, '')}`;
  const body = fields.map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`).join('')
    + `--${boundary}--\r\n`;
  return { contentType: `multipart/form-data; boundary=${boundary}`, body };
}

export async function runJob({ request, store, fetchImpl = fetch, now = () => Date.now() }) {
  if (request.method !== 'POST') return 'method';
  if (!isAllowedOrigin(request.headers.get('Origin') || '')) return 'origin';
  const apiKey = Netlify.env.get('ELEVENLABS_API_KEY');
  if (!apiKey) return 'unconfigured';
  let payload;
  try { payload = await request.json(); } catch { return 'bad-body'; }
  const video = acceptVideoUrl(payload?.url);
  if (!video) return 'bad-url';
  const keyterms = sanitizeKeyterms(payload.keyterms);
  const language = payload.language === 'he' ? 'he' : undefined;
  const daf = typeof payload.daf === 'string' ? payload.daf.slice(0, 80) : '';
  const key = jobKey({ url: video.url, daf, withKeyterms: keyterms.length > 0, language });

  // One job at a time per key: a second request while the first is running
  // (a double click, two devices) does nothing; a finished one is kept.
  const existing = await store.get(key, { type: 'json' }).catch(() => null);
  if (existing?.status === 'done') return 'already-done';
  if (existing?.status === 'pending' && now() - existing.startedAt < PENDING_STALE_MS) return 'already-running';
  const startedAt = now();
  await store.setJSON(key, { status: 'pending', startedAt });

  try {
    const { contentType, body } = buildMultipartBody(buildTranscribeFields({ kind: video.kind, url: video.url, keyterms, language }));
    const response = await fetchImpl('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': contentType },
      body,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 400);
      await store.setJSON(key, { status: 'error', error: `ElevenLabs returned ${response.status}.`, detail, startedAt });
      return 'upstream-error';
    }
    const result = await response.json();
    const words = compactWords(result);
    await store.setJSON(key, {
      status: 'done',
      words,
      languageCode: result.language_code ?? null,
      seconds: words.length ? words[words.length - 1][2] : 0,
      startedAt,
      finishedAt: now(),
    });
    return 'done';
  } catch (error) {
    await store.setJSON(key, { status: 'error', error: `Could not transcribe the video: ${error.message}`, startedAt });
    return 'failed';
  }
}

export default async (request) => {
  await runJob({ request, store: jobStore() });
  return new Response(null, { status: 202 });
};

export const __testing = { buildMultipartBody };
