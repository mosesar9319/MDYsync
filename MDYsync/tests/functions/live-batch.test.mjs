// live-batch.mjs (the batch re-transcription behind /live/?batch=1), with a
// stubbed fetch and Netlify.env so nothing reaches ElevenLabs. Run with
// `npm run test:functions`.

import test from 'node:test';
import assert from 'node:assert/strict';
import handler, { __testing } from '../../netlify/functions/live-batch.mjs';

const { sanitizeKeyterms, buildMultipartBody, MAX_AUDIO_BYTES } = __testing;
const ORIGIN = 'https://deploy-preview-174--dafsync.netlify.app';
const audioBase64 = (bytes = 6400) => Buffer.alloc(bytes, 1).toString('base64');

function withStubs({ key = 'test-key', upstream } = {}) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.Netlify = { env: { get: (name) => (name === 'ELEVENLABS_API_KEY' ? key : undefined) } };
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return upstream ? upstream(url, init) : Response.json({ text: 'שלום', language_code: 'heb', language_probability: 0.9 });
  };
  return { calls, restore: () => { globalThis.fetch = realFetch; delete globalThis.Netlify; } };
}
const post = (body, origin = ORIGIN) => handler(new Request('https://x.test/api/live-batch', {
  method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
}));
const textOf = (bytes) => Buffer.from(bytes).toString('latin1');

test('only POST from this site is accepted', async () => {
  const stubs = withStubs();
  try {
    assert.equal((await handler(new Request('https://x.test/', { method: 'GET' }))).status, 405);
    for (const origin of ['', 'https://evil.example', 'https://deploy-preview-1--dafsync.netlify.app.evil.com', 'https://deploy-preview-x--dafsync.netlify.app']) {
      assert.equal((await post({ audioBase64: audioBase64() }, origin)).status, 403, origin);
    }
    for (const origin of ['https://dafsync.netlify.app', 'https://main--dafsync.netlify.app', ORIGIN]) {
      assert.equal((await post({ audioBase64: audioBase64() }, origin)).status, 200, origin);
    }
    assert.equal(stubs.calls.length, 3, 'nothing was forwarded for a refused request');
  } finally { stubs.restore(); }
});

test('refuses cleanly when the key is not configured', async () => {
  const stubs = withStubs({ key: '' });
  try {
    const response = await post({ audioBase64: audioBase64() });
    assert.equal(response.status, 503);
    assert.equal(stubs.calls.length, 0);
  } finally { stubs.restore(); }
});

test('rejects malformed, missing, too-short, odd-length and oversized audio without calling ElevenLabs', async () => {
  const stubs = withStubs();
  try {
    assert.equal((await post('not json')).status, 400);
    assert.equal((await post({})).status, 400);
    assert.equal((await post({ audioBase64: '' })).status, 400);
    assert.equal((await post({ audioBase64: audioBase64(100) })).status, 400, 'under 100ms');
    assert.equal((await post({ audioBase64: audioBase64(6401) })).status, 400, 'not 16-bit samples');
    assert.equal((await post({ audioBase64: audioBase64(MAX_AUDIO_BYTES + 6000) })).status, 413);
    assert.equal(stubs.calls.length, 0);
  } finally { stubs.restore(); }
});

test('forwards the audio to scribe_v2 as raw 16kHz PCM, with the key, keyterms and no event tags', async () => {
  const stubs = withStubs();
  try {
    const response = await post({ audioBase64: audioBase64(6400), keyterms: ['תא שמע', 'אביי'], language: 'he' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json().then(({ text, languageCode, languageProbability }) => ({ text, languageCode, languageProbability })),
      { text: 'שלום', languageCode: 'heb', languageProbability: 0.9 });
    const { url, init } = stubs.calls[0];
    assert.equal(url, 'https://api.elevenlabs.io/v1/speech-to-text');
    assert.equal(init.headers['xi-api-key'], 'test-key');
    assert.match(init.headers['Content-Type'], /^multipart\/form-data; boundary=/);
    const body = textOf(init.body);
    for (const field of ['model_id"\r\n\r\nscribe_v2', 'file_format"\r\n\r\npcm_s16le_16', 'tag_audio_events"\r\n\r\nfalse', 'language_code"\r\n\r\nhe']) {
      assert.ok(body.includes(`name="${field}`), field);
    }
    assert.equal((body.match(/name="keyterms"/g) || []).length, 2);
    assert.ok(body.includes('name="file"; filename="segment.pcm"'));
  } finally { stubs.restore(); }
});

test('no language is forced unless asked, and no keyterms field without keyterms', async () => {
  const stubs = withStubs();
  try {
    await post({ audioBase64: audioBase64() });
    const body = textOf(stubs.calls[0].init.body);
    assert.ok(!body.includes('language_code'));
    assert.ok(!body.includes('keyterms'));
  } finally { stubs.restore(); }
});

test('an ElevenLabs failure comes back as a 502 with its status, not a crash', async () => {
  const stubs = withStubs({ upstream: () => new Response('{"detail":"quota"}', { status: 429 }) });
  try {
    const response = await post({ audioBase64: audioBase64() });
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /429/);
  } finally { stubs.restore(); }
  const down = withStubs({ upstream: () => { throw new Error('connect ECONNRESET'); } });
  try {
    assert.equal((await post({ audioBase64: audioBase64() })).status, 502);
  } finally { down.restore(); }
});

test('the multipart body is well formed around the raw audio bytes', () => {
  const audio = new Uint8Array([0, 255, 13, 10, 45, 45, 1, 2]);
  const { contentType, body } = buildMultipartBody([['a', 'b']], audio);
  const boundary = contentType.split('boundary=')[1];
  const text = textOf(body);
  assert.ok(text.startsWith(`--${boundary}\r\nContent-Disposition: form-data; name="a"\r\n\r\nb\r\n`));
  assert.ok(text.endsWith(`\r\n--${boundary}--\r\n`));
  const start = text.indexOf('\r\n\r\n', text.indexOf('name="file"')) + 4;
  assert.deepEqual([...body.slice(start, start + audio.length)], [...audio], 'audio bytes pass through untouched');
});

test('keyterms are cleaned to the API\'s limits: under 50 characters, at most 5 words, unique, capped', () => {
  assert.deepEqual(sanitizeKeyterms(['  אביי ', 'אביי', '', 'x'.repeat(50), 'a b c d e f', 'תא שמע', 5, null]), ['אביי', 'תא שמע']);
  assert.deepEqual(sanitizeKeyterms('nope'), []);
  assert.equal(sanitizeKeyterms(Array.from({ length: 900 }, (_, i) => `t${i}`)).length, 400);
});
