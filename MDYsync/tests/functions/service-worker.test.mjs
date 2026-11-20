// sw.js: which requests the service worker answers, and which it leaves to the
// browser. Run in a bare sandbox: the worker's own code, with stand-ins for
// the cache and the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const ORIGIN = 'https://dafsync.com';

// Stand-ins for the browser's own: an answer that says it came from this site
// (type "basic", which Node's Response cannot be given), and a request made
// from a path.
class Answer {
  constructor(body, status = 200) { this.body = body; this.status = status; this.type = 'basic'; }
  clone() { return new Answer(this.body, this.status); }
  async text() { return this.body; }
}
class Asked {
  constructor(url) { this.url = new URL(url, ORIGIN).href; }
}

function worker({ online = true } = {}) {
  const stores = new Map();           // cache name -> Map(url -> Response)
  const handlers = {};
  const asked = [];
  const open = async (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name);
    return {
      match: async (request, options = {}) => {
        const url = typeof request === 'string' ? new URL(request, ORIGIN).href : request.url;
        if (store.has(url)) return store.get(url).clone();
        if (options.ignoreSearch) {
          const want = new URL(url).pathname;
          for (const [key, value] of store) if (new URL(key).pathname === want) return value.clone();
        }
        return undefined;
      },
      put: async (request, response) => { store.set(request.url, response); },
      add: async (request) => { store.set(request.url, new Answer('precached')); },
      keys: async () => [...store.keys()].map((url) => ({ url })),
      delete: async (request) => store.delete(request.url),
    };
  };
  const state = { online };
  const sandbox = {
    self: {
      location: { origin: ORIGIN },
      addEventListener: (type, fn) => { handlers[type] = fn; },
      skipWaiting: async () => {},
      clients: { claim: async () => {} },
    },
    caches: { open, keys: async () => [...stores.keys()], delete: async (name) => stores.delete(name) },
    fetch: async (request) => {
      asked.push(request.url);
      if (!state.online) throw new TypeError('Failed to fetch');
      return new Answer(`network:${request.url}`);
    },
    URL, Request: Asked, Response: Answer, Promise, console,
  };
  vm.runInNewContext(SOURCE, sandbox);
  const request = (url, { method = 'GET', mode = 'cors', headers = {} } = {}) => ({
    url: new URL(url, ORIGIN).href, method, mode, headers: new Headers(headers),
  });
  async function ask(url, options) {
    const waits = [];
    let answer;
    handlers.fetch({
      request: request(url, options),
      respondWith: (promise) => { answer = promise; },
      waitUntil: (promise) => { waits.push(promise); },
    });
    if (!answer) return { handled: false };
    const response = await answer;
    await Promise.all(waits);
    return { handled: true, text: await response.text(), status: response.status };
  }
  async function run(type) {
    const waits = [];
    handlers[type]({ waitUntil: (promise) => waits.push(promise) });
    await Promise.all(waits);
  }
  return { ask, run, stores, asked, state };
}

test('the worker leaves to the browser what it must not keep', async () => {
  const sw = worker();
  for (const [url, options] of [
    ['/api/save-settings', { method: 'POST' }],                       // not a GET
    ['/api/save-video-link'],                                         // an API call that is not a read
    ['/api/live-token'],
    ['/.netlify/functions/get-catalog'],
    ['/mdy-audio/shiur/english/arachin/mp3/2.mp3'],                   // a recording sent through the site
    ['/lakewood-audio/Arachin%204_213599204.mp3'],
    ['/app.js?v=202de', { headers: { range: 'bytes=0-99' } }],        // a ranged request
    ['https://cdn.mdydaf.com/shiur/english/arachin/720/2.mp4'],       // another site
    ['https://cyexvsymuivvvhvpeber.supabase.co/rest/v1/profiles'],
    ['/sw.js'],
    ['/sitemap.xml'],
  ]) {
    assert.equal((await sw.ask(url, options)).handled, false, url);
  }
  assert.deepEqual(sw.asked, []);
});

test('a page comes from the network, and from the saved copy when there is no connection', async () => {
  const sw = worker();
  await sw.run('install');
  const online = await sw.ask('/player/?ref=Arakhin+4a&maggid=bornstein', { mode: 'navigate' });
  assert.equal(online.text, `network:${ORIGIN}/player/?ref=Arakhin+4a&maggid=bornstein`);
  sw.state.online = false;
  // The same address: its saved copy.
  assert.equal((await sw.ask('/player/?ref=Arakhin+4a&maggid=bornstein', { mode: 'navigate' })).text, online.text);
  // The same page under another query: the player is one page for every shiur.
  assert.equal((await sw.ask('/player/?ref=Arakhin+2a', { mode: 'navigate' })).text, online.text);
  // A page never opened: the offline page, which was saved when the worker was installed.
  assert.equal((await sw.ask('/kuntras/', { mode: 'navigate' })).text, 'precached');
});

test('files and read-only data are never staler than the network; a versioned file is kept as it is', async () => {
  const sw = worker();
  // Online, every one of these is asked of the network, every time.
  for (const url of ['/auth.js', '/styles.css', '/api/get-catalog', '/api/get-results-file?path=by-ref%2FArakhin-4a.json',
    '/.netlify/images?url=x&w=480']) {
    assert.equal((await sw.ask(url)).text, `network:${ORIGIN}${url}`);
    assert.equal((await sw.ask(url)).text, `network:${ORIGIN}${url}`);
  }
  assert.equal(sw.asked.length, 10);
  // A file whose address carries its version is asked for once.
  await sw.ask('/app.js?v=202de');
  await sw.ask('/app.js?v=202de');
  assert.equal(sw.asked.filter((url) => url.endsWith('/app.js?v=202de')).length, 1);
  // Offline, each comes from its saved copy; one never fetched fails as it would without the worker.
  sw.state.online = false;
  assert.equal((await sw.ask('/api/get-catalog')).text, `network:${ORIGIN}/api/get-catalog`);
  assert.equal((await sw.ask('/styles.css')).text, `network:${ORIGIN}/styles.css`);
  await assert.rejects(() => sw.ask('/never-fetched.js'));
});

test('a new version of the worker deletes the old caches and no one else’s', async () => {
  const sw = worker();
  await sw.ask('/styles.css');
  sw.stores.set('dafsync-pages-v0', new Map());
  sw.stores.set('someone-elses-cache', new Map());
  await sw.run('activate');
  assert.equal(sw.stores.has('dafsync-pages-v0'), false);
  assert.equal(sw.stores.has('someone-elses-cache'), true);
  assert.equal(sw.stores.has('dafsync-files-v1'), true);
});

test('a cache never grows past its limit: the oldest entries go first', async () => {
  const sw = worker();
  for (let n = 0; n < 65; n += 1) await sw.ask(`/player/?ref=Chullin+${n}a`, { mode: 'navigate' });
  const pages = [...sw.stores.get('dafsync-pages-v1').keys()];
  assert.equal(pages.length, 60);
  assert.ok(pages[0].endsWith('Chullin+5a') && pages[59].endsWith('Chullin+64a'));
});

test('the manifest names the app, its colours and icons that exist', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.name, 'DafSync');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  const sizes = manifest.icons.map((icon) => `${icon.sizes} ${icon.purpose}`);
  assert.deepEqual(sizes, ['192x192 any', '512x512 any', '512x512 maskable']);
  for (const icon of [...manifest.icons, ...manifest.shortcuts.flatMap((s) => s.icons)]) {
    const file = fs.readFileSync(path.join(ROOT, icon.src));
    // A PNG's width and height sit at bytes 16-23.
    const [width, height] = [file.readUInt32BE(16), file.readUInt32BE(20)];
    assert.equal(`${width}x${height}`, icon.sizes, icon.src);
  }
});

test('every page links the manifest and loads the script that registers the worker', () => {
  const pages = ['index.html', 'player/index.html', 'browse/index.html', 'watch/index.html', 'chaburah/index.html',
    'chaburah/thread/index.html', 'notes/index.html', 'kuntras/index.html', 'live/index.html', 'profile/index.html',
    'studio/index.html'];
  for (const page of pages) {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest">/, page);
    assert.match(html, /<script src="\/pwa\.js" defer><\/script>/, page);
    assert.match(html, /<link rel="apple-touch-icon" href="\/assets\/app\/apple-touch-icon\.png">/, page);
  }
});
