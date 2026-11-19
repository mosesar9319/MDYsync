import test from 'node:test';
import assert from 'node:assert/strict';

import tick, { config, EVENT_TYPE } from '../../netlify/functions/bornstein-feed-tick.mjs';

function withEnv(env, fetchImpl, fn) {
  const saved = { Netlify: globalThis.Netlify, fetch: globalThis.fetch };
  globalThis.Netlify = { env: { get: (name) => env[name] } };
  globalThis.fetch = fetchImpl;
  return fn().finally(() => {
    globalThis.Netlify = saved.Netlify;
    globalThis.fetch = saved.fetch;
  });
}

test('every hour it asks GitHub to run the Bornstein feed workflow', async () => {
  assert.equal(config.schedule, '23 * * * *');
  const sent = [];
  await withEnv({ GITHUB_DISPATCH_TOKEN: 't0ken' }, async (url, init) => {
    sent.push({ url, init });
    return new Response(null, { status: 204 });
  }, async () => {
    const response = await tick();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { dispatched: 'bornstein-feed' });
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://api.github.com/repos/mosesar9319/MDYsync/dispatches');
  assert.equal(sent[0].init.method, 'POST');
  assert.equal(sent[0].init.headers.Authorization, 'Bearer t0ken');
  assert.deepEqual(JSON.parse(sent[0].init.body), { event_type: EVENT_TYPE });
});

test('without the token, or when GitHub refuses, it says so', async () => {
  await withEnv({}, async () => assert.fail('nothing is sent without a token'), async () => {
    assert.equal((await tick()).status, 503);
  });
  const errors = [];
  const saved = console.error;
  console.error = (line) => errors.push(line);
  try {
    await withEnv({ GITHUB_DISPATCH_TOKEN: 't' }, async () => new Response('Bad credentials', { status: 401 }), async () => {
      assert.equal((await tick()).status, 502);
    });
  } finally {
    console.error = saved;
  }
  assert.match(errors[0], /401.*Bad credentials/);
});
