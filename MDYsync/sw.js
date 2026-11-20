// DafSync's service worker: what makes the site installable as an app and
// lets pages that were opened before open again without a connection.
//
// It never makes the site staler than the network would. Everything is asked
// of the network first and only read from here when the network fails; the
// one exception is a file whose address carries its version (app.js?v=202de),
// which can never change under that address.
//
//   pages                network first; offline: the saved copy, else the same
//                        page saved under another query, else /offline.html
//   scripts, styles,     network first; offline: the saved copy
//   pictures, fonts      (with ?v=: the saved copy first)
//   a shiur list, a      network first; offline: the saved copy
//   sync, a daf's text   (DATA_PATHS)
//   everything else      left to the browser: other sites, anything that is
//                        not a GET, the other /api/ calls, recordings (they
//                        are fetched in ranges, and are far too big to keep)
//
// A change to what is kept, or how: raise VERSION. The old caches are deleted
// when the new worker takes over.

const VERSION = 'v1';
const PAGES = `dafsync-pages-${VERSION}`;
const FILES = `dafsync-files-${VERSION}`;
const DATA = `dafsync-data-${VERSION}`;
const KEEP = [PAGES, FILES, DATA];
const OFFLINE_URL = '/offline.html';
const PRECACHE = [OFFLINE_URL, '/assets/dafsync-mark.png', '/assets/app/icon-192.png'];

// How many entries each cache may hold; the oldest go first.
const MAX_PAGES = 60;
const MAX_FILES = 400;
const MAX_DATA = 200;

// GET calls that only read: what a page needs to draw itself again offline.
const DATA_PATHS = [
  '/api/get-catalog', '/api/get-results-file', '/api/sefaria', '/api/sefaria-calendars',
  '/api/list-synced-dapim', '/api/daf-page',
];
// Never kept: recordings sent through dafsync.com (netlify.toml), and the rest of the API.
const SKIP_PREFIXES = ['/mdy-audio/', '/lakewood-audio/', '/api/', '/.netlify/functions/'];
const FILE_TYPES = /\.(?:js|mjs|css|png|jpe?g|webp|svg|gif|ico|woff2?|ttf|json|webmanifest)$/i;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(FILES);
    // One missing file must not stop the worker from installing.
    await Promise.all(PRECACHE.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith('dafsync-') && !KEEP.includes(name)).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

async function trim(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i += 1) await cache.delete(keys[i]);
}

async function keep(cacheName, request, response, max) {
  // Only a whole, successful answer from this site.
  if (!response || response.status !== 200 || response.type !== 'basic') return;
  const cache = await caches.open(cacheName);
  await cache.put(request, response);
  await trim(cacheName, max);
}

async function networkFirst(event, cacheName, max, fallback) {
  const { request } = event;
  try {
    const response = await fetch(request);
    event.waitUntil(keep(cacheName, request, response.clone(), max).catch(() => {}));
    return response;
  } catch (error) {
    const cache = await caches.open(cacheName);
    const saved = await cache.match(request);
    if (saved) return saved;
    if (fallback) return fallback(cache);
    throw error;
  }
}

async function savedFirst(event, cacheName, max) {
  const { request } = event;
  const cache = await caches.open(cacheName);
  const saved = await cache.match(request);
  if (saved) return saved;
  const response = await fetch(request);
  event.waitUntil(keep(cacheName, request, response.clone(), max).catch(() => {}));
  return response;
}

// A page that was never opened under this exact address: the same page under
// another query (the player is one page for every shiur), else the offline page.
async function pageFallback(request) {
  const pages = await caches.open(PAGES);
  const samePage = await pages.match(request, { ignoreSearch: true });
  if (samePage) return samePage;
  const files = await caches.open(FILES);
  return (await files.match(OFFLINE_URL)) || new Response('No connection.', {
    status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || request.headers.has('range')) return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(event, PAGES, MAX_PAGES, () => pageFallback(request)));
    return;
  }
  if (DATA_PATHS.includes(url.pathname)) {
    event.respondWith(networkFirst(event, DATA, MAX_DATA));
    return;
  }
  if (SKIP_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) return;
  if (url.pathname === '/sw.js') return;
  // Resized pictures (/.netlify/images?url=...) and the site's own files.
  if (url.pathname === '/.netlify/images' || FILE_TYPES.test(url.pathname)) {
    event.respondWith(url.searchParams.has('v')
      ? savedFirst(event, FILES, MAX_FILES)
      : networkFirst(event, FILES, MAX_FILES));
  }
});
