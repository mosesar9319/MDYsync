'use strict';

// Cloud Chaburah Live: shows background alerts (web push) and opens the right discussion when
// one is tapped. It does nothing else: no caching, no fetch handling, so it cannot change
// how any page loads. It exists only for people who turned background alerts on.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let message = {};
  try {
    message = event.data ? event.data.json() : {};
  } catch {
    message = { body: event.data ? event.data.text() : '' };
  }
  const title = String(message.title || 'DafSync').slice(0, 120);
  event.waitUntil(self.registration.showNotification(title, {
    body: String(message.body || '').slice(0, 300),
    tag: message.tag || undefined, // alerts about one discussion replace each other
    icon: '/assets/dafsync-mark.png',
    badge: '/assets/dafsync-mark.png',
    data: { url: typeof message.url === 'string' ? message.url : '/' },
  }));
});

// Only same-site links; anything else opens the home page.
function target(url) {
  try {
    const parsed = new URL(url, self.location.origin);
    return parsed.origin === self.location.origin ? parsed.href : self.location.origin + '/';
  } catch {
    return self.location.origin + '/';
  }
}

const READING_PAGES = ['/browse/', '/player/', '/watch/'];

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = target(event.notification.data && event.notification.data.url);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // A tab that already has the panel gets told which discussion to open; otherwise a new one.
    const open = windows.find((client) => {
      try { return READING_PAGES.some((path) => new URL(client.url).pathname.startsWith(path)); } catch { return false; }
    });
    if (open) {
      await open.focus();
      open.postMessage({ type: 'live-open', url });
      return;
    }
    await self.clients.openWindow(url);
  })());
});
