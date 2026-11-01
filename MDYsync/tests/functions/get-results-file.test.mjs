import assert from 'node:assert/strict';
import test from 'node:test';

test('optional=1 turns an upstream 404 into 200 null; a required 404 stays 404', async () => {
  globalThis.Netlify = { env: { get: () => 'token' } };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('missing', { status: 404 });
  const { default: handler } = await import('../../netlify/functions/get-results-file.mjs');
  try {
    const optional = await handler(new Request('https://dafsync.test/api/get-results-file?path=by-ref%2Fmissing.json&optional=1'));
    assert.equal(optional.status, 200);
    assert.equal(await optional.text(), 'null');

    const required = await handler(new Request('https://dafsync.test/api/get-results-file?path=pages%2Fmissing.json'));
    assert.equal(required.status, 404);
  } finally {
    globalThis.fetch = realFetch;
  }
});
