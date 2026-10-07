// daf-page.mjs (the proxy for shas.org's printed-page PDFs), with a stubbed fetch so
// nothing leaves the machine. Run with `npm run test:functions`.

import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../../netlify/functions/daf-page.mjs';

const get = (query = 'tractate=Bekhorot&daf=16&amud=b') => handler(new Request(`https://x.test/api/daf-page?${query}`));
function withFetch(impl) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push(String(url)); return impl(String(url), init); };
  return { calls, restore: () => { globalThis.fetch = real; } };
}
const certError = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('Hostname/IP does not match certificate\'s altnames'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }) });
const pdf = () => new Response('%PDF-1.6 fake', { status: 200, headers: { 'content-type': 'application/pdf' } });

test('a page is fetched from www.shas.org with the right masechta, daf and amud', async () => {
  const stub = withFetch(() => pdf());
  try {
    const response = await get();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/pdf');
    assert.equal(stub.calls.length, 1);
    const url = new URL(stub.calls[0]);
    assert.equal(url.hostname, 'www.shas.org');
    assert.deepEqual([url.searchParams.get('masechta'), url.searchParams.get('daf'), url.searchParams.get('amud')], ['bechoros', '16', 'b']);
  } finally { stub.restore(); }
});

test('if www.shas.org\'s certificate is refused, shas.org is tried -- verified the same way', async () => {
  const stub = withFetch((url) => { if (new URL(url).hostname === 'www.shas.org') throw certError(); return pdf(); });
  try {
    const response = await get();
    assert.equal(response.status, 200);
    assert.deepEqual(stub.calls.map((u) => new URL(u).hostname), ['www.shas.org', 'shas.org']);
  } finally { stub.restore(); }
});

test('if neither name can be reached, the answer says why for each', async () => {
  const stub = withFetch(() => { throw certError(); });
  try {
    const response = await get();
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.error, 'Page image request failed.');
    assert.equal(body.cause, 'ERR_TLS_CERT_ALTNAME_INVALID');
    assert.deepEqual(body.attempts.map((a) => [a.host, a.code]), [['www.shas.org', 'ERR_TLS_CERT_ALTNAME_INVALID'], ['shas.org', 'ERR_TLS_CERT_ALTNAME_INVALID']]);
  } finally { stub.restore(); }
});

test('an answer from the site, even a "no", is final: the other name is not asked', async () => {
  const stub = withFetch(() => new Response('nope', { status: 404 }));
  try {
    assert.equal((await get()).status, 404);
    assert.equal(stub.calls.length, 1);
  } finally { stub.restore(); }
  const down = withFetch(() => new Response('oops', { status: 500 }));
  try {
    assert.equal((await get()).status, 502);
    assert.equal(down.calls.length, 1);
  } finally { down.restore(); }
});

test('a bad request never reaches shas.org', async () => {
  const stub = withFetch(() => pdf());
  try {
    for (const query of ['tractate=Nope&daf=2&amud=a', 'tractate=Chullin&daf=1&amud=a', 'tractate=Chullin&daf=91&amud=c']) {
      assert.equal((await get(query)).status, 400, query);
    }
    assert.equal((await handler(new Request('https://x.test/api/daf-page', { method: 'POST' }))).status, 405);
    assert.equal(stub.calls.length, 0);
  } finally { stub.restore(); }
});
