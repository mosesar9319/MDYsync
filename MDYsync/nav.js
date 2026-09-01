'use strict';

// Sitewide bottom tab bar -- renders the same 5 tabs index.html's own
// sidebar/mobile-nav uses (see its own navItems there) as plain links on
// every OTHER page, since those pages have no in-page catalog to filter
// the way the home page does; "Today's Daf"/"Maggidei Shiurim" instead
// link back to / with a ?nav= param index.html reads on load to land
// pre-selected. Not loaded by index.html itself -- it already renders its
// own copy with real in-page filter behavior, not just links.

const NAV_ITEMS = [
  { label: 'Home', icon: 'home', href: '/' },
  { label: 'Today’s Daf', icon: 'calendar', href: '/?nav=today' },
  { label: 'Interactive Daf', icon: 'bookOpen', href: '/browse/' },
  { label: 'Cloud Chaburah', icon: 'chaburah', href: '/chaburah/' },
  { label: 'Maggidei Shiurim', icon: 'teacher', href: '/?nav=maggidei' },
  { label: 'Daf Scan', icon: 'camera', href: '/player/?view=scan' },
];

// Same path data as index.html's own icon set, kept in sync by hand since
// there's no shared-module loader in this codebase for plain pages (see
// the "no shared HTML-partial mechanism" note wherever this repo's own
// docs/comments discuss it).
const NAV_ICON_PATHS = {
  home: '<path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10M9 20v-6h6v6"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
  teacher: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a8 8 0 0 1 16 0v1"/>',
  camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
  bookOpen: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  chaburah: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h.79a4.5 4.5 0 1 1 0 9z"/>',
};

function navIcon(name) {
  return `<svg aria-hidden="true" class="icon" fill="none" height="23" viewBox="0 0 24 24" width="23">${NAV_ICON_PATHS[name]}</svg>`;
}

// The Daf Scan tab's own destination is /player/?view=scan -- only that
// specific combination should read as "active," not every /player/
// visit (e.g. an ordinary loaded shiur shouldn't light up "Daf Scan").
function isItemActive(item) {
  const url = new URL(item.href, location.origin);
  if (url.pathname !== location.pathname) return false;
  if (url.searchParams.get('view') === 'scan') {
    return new URLSearchParams(location.search).get('view') === 'scan';
  }
  if (url.pathname === '/') {
    // Home (no ?nav=) vs. Today's Daf/Maggidei Shiurim (?nav=today /
    // ?nav=maggidei) are otherwise indistinguishable by pathname alone.
    return (new URLSearchParams(location.search).get('nav') || '') === (url.searchParams.get('nav') || '');
  }
  return true;
}

function renderBottomNav() {
  const nav = document.createElement('nav');
  nav.className = 'mobile-nav';
  nav.setAttribute('aria-label', 'Mobile navigation');
  nav.innerHTML = NAV_ITEMS.map((item) =>
    `<a class="${isItemActive(item) ? 'active' : ''}" href="${item.href}">${navIcon(item.icon)}<span>${item.label}</span></a>`
  ).join('');
  document.body.appendChild(nav);
}

// Desktop-visible counterpart to the bottom bar above -- .mobile-nav is
// CSS-hidden above 760px (see styles.css), so without this, every page
// loading nav.js had no sitewide navigation at all on desktop.
//
// Every page loading nav.js (browse/watch/studio/player) now ships the same
// fixed left <aside class="sidebar">...<nav class="desktop-navigation">
// markup (see styles.css's shared .sidebar/.side-link rules) -- this just
// fills that nav in with real content and links.
function renderDesktopNav() {
  // side-link is what styles.css's shared .side-link rule targets to turn
  // each link into a stacked icon-over-label button; without it these
  // render as plain unstyled/underlined text links.
  const linksHtml = NAV_ITEMS.map((item) =>
    `<a class="side-link${isItemActive(item) ? ' active' : ''}" href="${item.href}" title="${item.label}" aria-label="${item.label}">${navIcon(item.icon)}<span>${item.label}</span></a>`
  ).join('');

  const existing = document.querySelector('.desktop-navigation');
  if (!existing) return; // page has no sidebar -- nothing to attach to
  existing.innerHTML = linksHtml;
}

renderBottomNav();
renderDesktopNav();
