// The Live Follow video-transcript functions (live-video-job-background.mjs
// and live-video-status.mjs) with a stubbed ElevenLabs fetch and an in-memory
// stand-in for Netlify Blobs, so nothing leaves the machine. Run with
// `npm run test:functions`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runJob } from '../../netlify/functions/live-video-job-background.mjs';
import { readStatus } from '../../netlify/functions/live-video-status.mjs';
import { acceptVideoUrl, sanitizeKeyterms, jobKey, buildTranscribeFields, compactWords } from '../../shared/live-video-job.mjs';

const require = createRequire(import.meta.url);
const LV = require('../../live-video.js');

const ORIGIN = 'https://deploy-preview-174--dafsync.netlify.app';
const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

function memoryStore() {
  const data = new Map();
  return { data, get: async (k) => (data.has(k) ? structuredClone(data.get(k)) : null), setJSON: async (k, v) => { data.set(k, structuredClone(v)); } };
}
function withKey(key = 'test-key') {
  globalThis.Netlify = { env: { get: (n) => (n === 'ELEVENLABS_API_KEY' ? key : undefined) } };
  return () => { delete globalThis.Netlify; };
}
const post = (body, origin = ORIGIN) => new Request('https://x.test/.netlify/functions/live-video-job-background', {
  method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const get = (query, headers = {}) => new Request(`https://x.test/api/live-video-status?${new URLSearchParams(query)}`, { headers });
const elevenLabs = (words = [
  { text: 'רב', start: 1.234, end: 1.5, type: 'word' },
  { text: ' ', start: 1.5, end: 1.55, type: 'spacing' },
  { text: '(music)', start: 1.6, end: 2, type: 'audio_event' },
  { text: 'אשי', start: 1.55, end: 1.9, type: 'word' },
]) => async () => Response.json({ language_code: 'heb', words });

// --- acceptVideoUrl: same answers as the page's own parser, plus the safety rules ----

test('the server accepts what the page accepts, canonicalised the same way', () => {
  for (const input of [YT, 'https://youtu.be/dQw4w9WgXcQ?t=5', 'https://www.youtube.com/shorts/dQw4w9WgXcQ', 'https://cdn.example.org/a/b.mp3', 'https://example.org/page.html', 'https://vimeo.com/1',
    'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/view?usp=sharing', 'https://drive.google.com/open?id=1AbCdEfGhIjKlMnOpQrStUvWxYz012345',
    'https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz012345', 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit']) {
    const page = LV.parseVideoLink(input);
    const server = acceptVideoUrl(input);
    assert.equal(server?.kind ?? null, page?.kind ?? null, input);
    assert.equal(server?.url ?? null, page?.url ?? null, input);
  }
});

test('private, local and credentialed hosts are refused', () => {
  for (const bad of [
    'https://localhost/a.mp3', 'https://127.0.0.1/a.mp3', 'https://10.0.0.5/a.mp4', 'https://[::1]/a.mp3', 'https://intranet/a.mp3',
    'https://printer.local/a.mp3', 'https://user:pw@example.org/a.mp3', 'http://example.org/a.mp3', 'file:///etc/passwd', 'not a url', '', null,
  ]) assert.equal(acceptVideoUrl(bad), null, String(bad));
});

test('keyterms are limited the way ElevenLabs limits them', () => {
  assert.deepEqual(sanitizeKeyterms(['a', ' a ', '', 'x'.repeat(50), 'one two three four five six', 'ok', 7]), ['a', 'ok']);
  assert.equal(sanitizeKeyterms(Array.from({ length: 900 }, (_, i) => `t${i}`)).length, 400);
  assert.deepEqual(sanitizeKeyterms('nope'), []);
});

test('a job is keyed by video, daf, bias-list use and language', () => {
  const base = { url: YT, daf: 'Chullin 91a', withKeyterms: true };
  assert.equal(jobKey(base), jobKey({ ...base }));
  for (const other of [{ daf: 'Chullin 91b' }, { withKeyterms: false }, { language: 'he' }, { url: `${YT}x` }]) {
    assert.notEqual(jobKey({ ...base, ...other }), jobKey(base), JSON.stringify(other));
  }
});

test('YouTube goes to source_url, a file to cloud_storage_url, with word timestamps', () => {
  const yt = Object.fromEntries(buildTranscribeFields({ kind: 'youtube', url: YT, keyterms: [] }));
  assert.equal(yt.source_url, YT);
  assert.equal(yt.cloud_storage_url, undefined);
  assert.equal(yt.timestamps_granularity, 'word');
  assert.equal(yt.model_id, 'scribe_v2');
  const file = buildTranscribeFields({ kind: 'media', url: 'https://x.org/a.mp3', keyterms: ['א', 'ב'], language: 'he' });
  assert.ok(file.some(([k, v]) => k === 'cloud_storage_url' && v === 'https://x.org/a.mp3'));
  assert.deepEqual(file.filter(([k]) => k === 'keyterms').map(([, v]) => v), ['א', 'ב']);
  assert.ok(file.some(([k, v]) => k === 'language_code' && v === 'he'));
});

test('only real words survive, with rounded times', () => {
  assert.deepEqual(compactWords({ words: [
    { text: 'רב', start: 1.234, end: 1.5, type: 'word' }, { text: ' ', start: 1.5, end: 1.6, type: 'spacing' },
    { text: '(x)', start: 2, end: 3, type: 'audio_event' }, { text: 'אשי', start: 1.6, type: 'word' }, { text: 'bad', start: 'x', type: 'word' },
  ] }), [['רב', 1.23, 1.5], ['אשי', 1.6, 1.6]]);
  assert.deepEqual(compactWords(null), []);
});

// --- the job -------------------------------------------------------------------------

test('a job stores the transcript, and the status function then serves it', async () => {
  const restore = withKey();
  try {
    const store = memoryStore();
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push({ url, init }); return elevenLabs()(); };
    const body = { url: YT, daf: 'Chullin 91a', keyterms: ['שור'] };
    assert.equal(await runJob({ request: post(body), store, fetchImpl }), 'done');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.elevenlabs.io/v1/speech-to-text');
    assert.equal(calls[0].init.headers['xi-api-key'], 'test-key');
    assert.match(calls[0].init.body, /name="source_url"\r\n\r\nhttps:\/\/www\.youtube\.com\/watch\?v=dQw4w9WgXcQ/);
    assert.match(calls[0].init.body, /name="keyterms"\r\n\r\nשור/);

    const status = await readStatus({ request: get({ url: YT, daf: 'Chullin 91a', kt: '1' }), store });
    assert.equal(status.code, 200);
    assert.deepEqual(status.body, { status: 'done', words: [['רב', 1.23, 1.5], ['אשי', 1.55, 1.9]], languageCode: 'heb', seconds: 1.9 });
  } finally { restore(); }
});

test('asking again for the same video costs nothing', async () => {
  const restore = withKey();
  try {
    const store = memoryStore();
    let n = 0;
    const fetchImpl = async () => { n += 1; return elevenLabs()(); };
    const body = { url: YT, daf: 'Chullin 91a' };
    assert.equal(await runJob({ request: post(body), store, fetchImpl }), 'done');
    assert.equal(await runJob({ request: post(body), store, fetchImpl }), 'already-done');
    assert.equal(n, 1);
    assert.equal(await runJob({ request: post({ ...body, daf: 'Chullin 92a' }), store, fetchImpl }), 'done', 'a different daf is a different job');
    assert.equal(n, 2);
  } finally { restore(); }
});

test('a job already running is not started twice, but a dead one is replaced', async () => {
  const restore = withKey();
  try {
    const store = memoryStore();
    let n = 0;
    const fetchImpl = async () => { n += 1; return elevenLabs()(); };
    const body = { url: YT, daf: 'd' };
    const key = jobKey({ url: YT, daf: 'd', withKeyterms: false });
    await store.setJSON(key, { status: 'pending', startedAt: 1_000_000 });
    assert.equal(await runJob({ request: post(body), store, fetchImpl, now: () => 1_000_000 + 60_000 }), 'already-running');
    assert.equal(n, 0);
    assert.equal(await runJob({ request: post(body), store, fetchImpl, now: () => 1_000_000 + 17 * 60_000 }), 'done');
    assert.equal(n, 1);
  } finally { restore(); }
});

test('an ElevenLabs refusal is recorded as an error the page can show', async () => {
  const restore = withKey();
  try {
    const store = memoryStore();
    const fetchImpl = async () => new Response('{"detail":"cannot fetch that video"}', { status: 422 });
    assert.equal(await runJob({ request: post({ url: YT }), store, fetchImpl }), 'upstream-error');
    const status = await readStatus({ request: get({ url: YT }), store });
    assert.equal(status.body.status, 'error');
    assert.match(status.body.error, /422/);
    assert.match(status.body.detail, /cannot fetch/);
    // ...and asking again retries rather than serving the failure forever.
    assert.equal(await runJob({ request: post({ url: YT }), store, fetchImpl: async () => elevenLabs()() }), 'done');
  } finally { restore(); }
});

test('a network failure is an error too, not a stuck "pending"', async () => {
  const restore = withKey();
  try {
    const store = memoryStore();
    assert.equal(await runJob({ request: post({ url: YT }), store, fetchImpl: async () => { throw new Error('boom'); } }), 'failed');
    const status = await readStatus({ request: get({ url: YT }), store });
    assert.equal(status.body.status, 'error');
    assert.match(status.body.error, /boom/);
  } finally { restore(); }
});

test('the job refuses foreign origins, bad links, bad bodies and a missing key without calling ElevenLabs', async () => {
  const store = memoryStore();
  let n = 0;
  const fetchImpl = async () => { n += 1; return elevenLabs()(); };
  let restore = withKey();
  try {
    assert.equal(await runJob({ request: post({ url: YT }, 'https://evil.example'), store, fetchImpl }), 'origin');
    assert.equal(await runJob({ request: post({ url: YT }, ''), store, fetchImpl }), 'origin');
    assert.equal(await runJob({ request: post({ url: 'https://localhost/a.mp3' }), store, fetchImpl }), 'bad-url');
    assert.equal(await runJob({ request: new Request('https://x.test/', { method: 'POST', headers: { Origin: ORIGIN }, body: 'nope' }), store, fetchImpl }), 'bad-body');
    assert.equal(await runJob({ request: new Request('https://x.test/', { method: 'GET' }), store, fetchImpl }), 'method');
  } finally { restore(); }
  restore = withKey('');
  try {
    assert.equal(await runJob({ request: post({ url: YT }), store, fetchImpl }), 'unconfigured');
  } finally { restore(); }
  assert.equal(n, 0);
  assert.equal(store.data.size, 0, 'nothing was even recorded');
});

// --- the status function -----------------------------------------------------------------

test('status: absent, pending, stale pending, and the 400/403 cases', async () => {
  const store = memoryStore();
  assert.deepEqual((await readStatus({ request: get({ url: YT, daf: 'd' }), store })).body, { status: 'absent', url: YT, kind: 'youtube' });
  const key = jobKey({ url: YT, daf: 'd', withKeyterms: false });
  await store.setJSON(key, { status: 'pending', startedAt: 5_000 });
  const pending = await readStatus({ request: get({ url: YT, daf: 'd' }), store, now: () => 65_000 });
  assert.deepEqual(pending.body, { status: 'pending', elapsedMs: 60_000 });
  const stale = await readStatus({ request: get({ url: YT, daf: 'd' }), store, now: () => 5_000 + 20 * 60_000 });
  assert.equal(stale.body.status, 'absent');
  assert.equal((await readStatus({ request: get({ url: 'https://vimeo.com/1' }), store })).code, 400);
  assert.equal((await readStatus({ request: get({}), store })).code, 400);
  assert.equal((await readStatus({ request: get({ url: YT }, { Origin: 'https://evil.example' }), store })).code, 403);
  assert.equal((await readStatus({ request: get({ url: YT }, { Origin: ORIGIN }), store })).code, 200);
});
