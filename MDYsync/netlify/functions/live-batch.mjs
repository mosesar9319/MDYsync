// Re-transcribes one short segment of Live Follow's microphone audio with
// ElevenLabs' BATCH model (scribe_v2), for the default-on second-opinion pass (opt out with /live/?batch=0).
//
// Why a second model at all: the realtime model Live Follow streams to
// (scribe_v2_realtime) is the only streaming one ElevenLabs offers, and its
// own docs point to batch scribe_v2 as the most accurate. Hebrew is only in
// ElevenLabs' "Good" accuracy tier (10-20% word error on ordinary modern
// Hebrew), and Talmudic Aramaic read aloud is a good deal further from that.
// A batch pass over each finished segment, a couple of seconds behind the
// realtime one, may hear what the realtime model garbles -- or may not; the
// session log records both transcripts side by side so it can be judged on
// real speech rather than assumed.
//
// Unlike live-token.mjs, audio passes through this function (the batch API
// needs the API key, which must never reach the browser). Nothing is stored
// here; the audio is forwarded to ElevenLabs and dropped.
//
// Same Origin allowlist as live-token.mjs -- the only abuse guard for now, an
// accepted gap for an unlisted experiment, not a production posture.

const ALLOWED_ORIGINS = new Set([
  'https://dafsync.netlify.app',
  'https://main--dafsync.netlify.app',
  'http://localhost:8080',
]);
const DEPLOY_PREVIEW_ORIGIN = /^https:\/\/deploy-preview-\d+--dafsync\.netlify\.app$/;

// 16kHz 16-bit mono PCM: 32,000 bytes a second. A segment is one utterance; a
// minute is far more than any, and keeps the request well under Netlify's 6MB
// body limit once base64'd.
const MAX_AUDIO_BYTES = 32000 * 60;
const MIN_AUDIO_BYTES = 3200; // 100ms, the API's minimum
const MAX_KEYTERMS = 400; // the API allows 1000; the same budget voice_align.py uses
const UPSTREAM_TIMEOUT_MS = 9000; // under Netlify's default 10s function limit

// ElevenLabs' batch limits: under 50 characters and at most 5 words a term.
function sanitizeKeyterms(keyterms) {
  if (!Array.isArray(keyterms)) return [];
  const seen = new Set();
  const out = [];
  for (const term of keyterms) {
    if (typeof term !== 'string') continue;
    const clean = term.trim();
    if (!clean || clean.length >= 50 || clean.split(/\s+/).length > 5 || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= MAX_KEYTERMS) break;
  }
  return out;
}

// multipart/form-data by hand, with list fields as repeated names -- the same
// encoding voice_align.py's transcribe_elevenlabs uses for keyterms.
function buildMultipartBody(fields, audio) {
  const boundary = `----dafsync${crypto.randomUUID().replace(/-/g, '')}`;
  const encoder = new TextEncoder();
  const parts = [];
  for (const [name, value] of fields) {
    parts.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(encoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="segment.pcm"\r\n`
    + 'Content-Type: application/octet-stream\r\n\r\n'
  ));
  parts.push(audio);
  parts.push(encoder.encode(`\r\n--${boundary}--\r\n`));
  const length = parts.reduce((n, p) => n + p.length, 0);
  const body = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { body.set(part, offset); offset += part.length; }
  return { contentType: `multipart/form-data; boundary=${boundary}`, body };
}

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

  let payload;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }
  if (typeof payload?.audioBase64 !== 'string' || !payload.audioBase64) {
    return Response.json({ error: 'audioBase64 is required.' }, { status: 400 });
  }
  // Checked before decoding: base64 is 4 characters per 3 bytes.
  if (payload.audioBase64.length > Math.ceil(MAX_AUDIO_BYTES / 3) * 4 + 4) {
    return Response.json({ error: 'That segment is too long.' }, { status: 413 });
  }
  const audio = Uint8Array.from(Buffer.from(payload.audioBase64, 'base64'));
  if (audio.length < MIN_AUDIO_BYTES || audio.length % 2 !== 0) {
    return Response.json({ error: 'The audio must be 16-bit PCM of at least 100ms.' }, { status: 400 });
  }

  const fields = [
    ['model_id', 'scribe_v2'],
    ['file_format', 'pcm_s16le_16'],
    // No audio-event tags ("(laughter)") in the text being matched to the daf.
    ['tag_audio_events', 'false'],
  ];
  if (payload.language === 'he') fields.push(['language_code', 'he']);
  for (const term of sanitizeKeyterms(payload.keyterms)) fields.push(['keyterms', term]);
  const { contentType, body } = buildMultipartBody(fields, audio);

  const started = Date.now();
  let response;
  try {
    response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': contentType },
      body,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    return Response.json({ error: `Could not reach ElevenLabs: ${error.message}` }, { status: 502 });
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    return Response.json({ error: `ElevenLabs returned ${response.status}.`, detail }, { status: 502 });
  }
  const result = await response.json();
  return Response.json({
    text: typeof result.text === 'string' ? result.text : '',
    languageCode: result.language_code ?? null,
    languageProbability: result.language_probability ?? null,
    ms: Date.now() - started,
  }, {
    headers: { 'Access-Control-Allow-Origin': origin, 'Cache-Control': 'no-store' },
  });
};

export const config = {
  path: '/api/live-batch',
};

export const __testing = { sanitizeKeyterms, buildMultipartBody, MAX_AUDIO_BYTES, MIN_AUDIO_BYTES };
