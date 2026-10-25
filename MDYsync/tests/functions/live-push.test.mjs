// Cloud Chaburah Live background alerts: how what is due becomes messages (shared/live-push.mjs),
// the sender that delivers them (netlify/functions/live-push-send.mjs), and what the service
// worker does with a tap (live-sw.js). No network and no keys are needed.

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { buildPushMessages, pushConfig, isGone } from '../../shared/live-push.mjs';
import { sendDue } from '../../netlify/functions/live-push-send.mjs';

const item = (thread, kind, actor, preview, daf = 'Chullin-89a') => ({ thread_id: thread, daf_ref_key: daf, kind, actor, preview });

test('one discussion: who, what happened, the words, and a link to that discussion', () => {
  const [m] = buildPushMessages({ items: [item('t1', 'reply_to_me', 'Avi', 'Because of the Mishnah.')] });
  assert.equal(m.title, 'Avi replied to you');
  assert.equal(m.body, 'Because of the Mishnah.');
  assert.equal(m.url, '/browse/?ref=Chullin%2089a&live=t1');
  assert.equal(m.tag, 'live-thread-t1');
});

test('several messages in one discussion are one alert saying how many more', () => {
  const messages = buildPushMessages({ items: [item('t1', 'reply_to_thread', 'Avi', 'Third'), item('t1', 'reply_to_thread', 'Avi', 'Second'), item('t1', 'reply_to_thread', 'Avi', 'First')] });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].body, 'Third (+2 more)');
});

test('up to three discussions are three alerts, more become one summary', () => {
  const three = buildPushMessages({ items: ['a', 'b', 'c'].map((t) => item(t, 'mention', 'Avi', 'x')) });
  assert.equal(three.length, 3);
  const four = buildPushMessages({ items: ['a', 'b', 'c', 'd'].map((t) => item(t, 'mention', 'Avi', 'x')) });
  assert.equal(four.length, 1);
  assert.equal(four[0].body, '4 discussions have new activity');
  assert.match(four[0].url, /live=inbox$/);
});

test('a digest is one alert that counts, and opens the inbox', () => {
  const [m] = buildPushMessages({ digest: true, items: [
    item('a', 'new_thread_everywhere', 'Avi', 'x', 'Chullin-89a'), item('b', 'new_thread_everywhere', 'Bo', 'y', 'Berakhot-2a'), item('b', 'new_thread_everywhere', 'Bo', 'z', 'Berakhot-2a'),
  ] });
  assert.equal(m.title, 'DafSync digest');
  assert.equal(m.body, '3 new messages in 2 discussions across 2 dapim');
  assert.match(m.url, /live=inbox$/);
});

test('a long preview is cut, and nothing due means nothing sent', () => {
  const [m] = buildPushMessages({ items: [item('t1', 'mention', 'Avi', 'x'.repeat(400))] });
  assert.ok(m.body.length <= 140);
  assert.deepEqual(buildPushMessages({ items: [] }), []);
  assert.deepEqual(buildPushMessages(null), []);
});

test('background alerts are offered only when every secret is set', () => {
  const env = { VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
  assert.ok(pushConfig((k) => env[k]));
  for (const missing of Object.keys(env)) {
    assert.equal(pushConfig((k) => (k === missing ? undefined : env[k])), null, missing);
  }
  assert.match(pushConfig((k) => env[k]).subject, /^mailto:/);
});

test('the sender delivers to each device, and removes one the push service says is gone', async () => {
  const people = [{
    user_id: 'u1', digest: false,
    devices: [{ endpoint: 'https://push/ok', p256dh: 'k', auth: 'a' }, { endpoint: 'https://push/gone', p256dh: 'k', auth: 'a' }],
    items: [item('t1', 'reply_to_me', 'Avi', 'Hello')],
  }];
  const calls = [];
  const dropped = [];
  const result = await sendDue({}, {
    claim: async () => people,
    drop: async (endpoint) => { dropped.push(endpoint); },
    send: async (subscription, payload, options) => {
      calls.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload), options });
      if (subscription.endpoint.endsWith('gone')) { const e = new Error('gone'); e.statusCode = 410; throw e; }
    },
  });
  assert.deepEqual(result, { people: 1, sent: 1, removed: 1 });
  assert.deepEqual(dropped, ['https://push/gone']);
  assert.equal(calls[0].payload.title, 'Avi replied to you');
  assert.match(calls[0].options.topic, /^[A-Za-z0-9_-]{1,32}$/);
  assert.ok(isGone({ statusCode: 404 }) && !isGone({ statusCode: 500 }) && !isGone(null));
});

test('a failed delivery that is not "gone" keeps the device', async () => {
  const dropped = [];
  const result = await sendDue({}, {
    claim: async () => [{ devices: [{ endpoint: 'https://push/x', p256dh: 'k', auth: 'a' }], items: [item('t1', 'mention', 'Avi', 'x')] }],
    drop: async (e) => dropped.push(e),
    send: async () => { const e = new Error('busy'); e.statusCode = 503; throw e; },
  });
  assert.deepEqual(result, { people: 1, sent: 0, removed: 0 });
  assert.deepEqual(dropped, []);
});

// ---- the service worker -----------------------------------------------------------------------
function loadWorker() {
  const listeners = {};
  const shown = [];
  const state = { opened: [], focused: 0, posted: [], windows: [] };
  const self = {
    location: { origin: 'https://dafsync.example' },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting: () => {},
    clients: {
      claim: () => Promise.resolve(),
      matchAll: async () => state.windows,
      openWindow: async (url) => { state.opened.push(url); },
    },
    registration: { showNotification: async (title, options) => { shown.push({ title, options }); } },
  };
  vm.runInNewContext(readFileSync(new URL('../../live-sw.js', import.meta.url), 'utf8'), { self, URL, console });
  return { listeners, shown, state };
}
const waitable = () => { const w = { p: null, waitUntil(p) { w.p = p; } }; return w; };

test('the worker shows what was sent, replacing an earlier alert about the same discussion', async () => {
  const { listeners, shown } = loadWorker();
  const event = waitable();
  event.data = { json: () => ({ title: 'Avi replied to you', body: 'Hello', url: '/browse/?live=x', tag: 'live-thread-1' }) };
  listeners.push(event);
  await event.p;
  assert.equal(shown[0].title, 'Avi replied to you');
  assert.equal(shown[0].options.tag, 'live-thread-1');
  assert.equal(shown[0].options.data.url, '/browse/?live=x');
});

test('a tap opens the discussion: in an open reading tab if there is one, else a new window', async () => {
  const w = loadWorker();
  let closed = false;
  const tap = (url) => { const e = waitable(); e.notification = { close: () => { closed = true; }, data: { url } }; w.listeners.notificationclick(e); return e.p; };
  await tap('/browse/?ref=Chullin%2089a&live=t1');
  assert.ok(closed);
  assert.deepEqual(w.state.opened, ['https://dafsync.example/browse/?ref=Chullin%2089a&live=t1']);

  const posted = [];
  w.state.windows = [{ url: 'https://dafsync.example/browse/?ref=x', focus: async () => {}, postMessage: (m) => posted.push(m) }];
  await tap('/browse/?ref=Chullin%2089a&live=t2');
  assert.equal(w.state.opened.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(posted)), [{ type: 'live-open', url: 'https://dafsync.example/browse/?ref=Chullin%2089a&live=t2' }]);
});

test('a tap never leaves the site', async () => {
  const w = loadWorker();
  const e = waitable();
  e.notification = { close() {}, data: { url: 'https://evil.example/phish' } };
  w.listeners.notificationclick(e);
  await e.p;
  assert.deepEqual(w.state.opened, ['https://dafsync.example/']);
});
