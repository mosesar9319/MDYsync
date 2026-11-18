import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { preparePage } from '../support/harness.mjs';

// Interactive Daf is the book on its own: no player and no list of shiurim on
// the page, and only the masechta to pick (every masechta; the dial has the
// daf). A tap on a word opens the word's menu, which lists the shiurim that
// are synced for that amud; choosing one floats the video over the daf, at
// that word, with Split view and Daf on video one tap away and Close to put
// the book back.
//
// The printed page is the real page map for Chullin 91a, drawn by a stand-in
// pdf.js as bars where the words are.

const pageMap91a = JSON.parse(readFileSync(new URL('../fixtures/pagemap-chullin-91a.json', import.meta.url), 'utf8'));
const PDFJS = /^https:\/\/cdn\.jsdelivr\.net\/npm\/pdfjs-dist@[^/]+\/build\/pdf\.min\.mjs$/;
const FAKE_PDFJS = `
  const MAP = ${JSON.stringify({ wordBoxes: pageMap91a.wordBoxes })};
  export const GlobalWorkerOptions = {};
  export function getDocument() {
    const page = {
      getViewport: ({ scale }) => ({ width: Math.round(1341 * scale), height: Math.round(2068 * scale) }),
      render: ({ canvasContext: ctx, viewport }) => {
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, viewport.width, viewport.height);
        ctx.fillStyle = '#000';
        for (const b of MAP.wordBoxes) ctx.fillRect(b.x * viewport.width, (b.y + b.h * 0.2) * viewport.height, b.w * viewport.width, b.h * 0.55 * viewport.height);
        return { promise: Promise.resolve() };
      },
    };
    return { promise: Promise.resolve({ destroy() {}, getPage: async () => page }) };
  }`;

const link = (videoId, label) => ({ type: 'youtube', videoId, url: `https://www.youtube.com/watch?v=${videoId}`, label });
const CATALOG = {
  tractates: {
    Chullin: [
      { daf: 91, regularEn: { videoId: 'AAAAAAAAAAA', label: 'Daf Yomi Chullin Daf 91', amud: 'a' }, regularHe: { videoId: 'BBBBBBBBBBB', label: 'מרכז דף יומי חולין', amud: 'a' }, chazarahEn: { videoId: 'DDDDDDDDDDD', label: 'Chazarah, not synced', amud: 'a' } },
    ],
  },
  maggidim: { bornstein: { tractates: { Chullin: [{ daf: 91, regularEn: { videoId: 'Zsy7oDUP6Pw', label: 'Chullin 91', amud: 'a' } }] } } },
};
// The Chazarah recording is linked but its sync has not finished.
const SYNCED = { Chullin: { '91a': ['regularEn', 'regularHe'] } };
const LINKS = {
  'video-links/Chullin-91a.json': link('AAAAAAAAAAA', 'Daf Yomi Chullin Daf 91'),
  'video-links/Hebrew-Chullin-91a.json': link('BBBBBBBBBBB', 'Hebrew'),
  'video-links/Bornstein-Chullin-91a.json': link('Zsy7oDUP6Pw', 'Chullin 91'),
};
// Two phrases of the daf's first paragraph: its first five words at 0:30, the next five at 1:00.
const ALIGNMENT = {
  version: 1,
  dafRef: 'Chullin 91a',
  duration: 3000,
  alignmentStatus: 'complete',
  segments: [
    { ref: 'Chullin 91a:1', start: 30, end: 60, he: 'א ב ג ד ה', w0: 0, w1: 4 },
    { ref: 'Chullin 91a:1', start: 60, end: 90, he: 'ו ז ח ט י', w0: 5, w1: 9 },
  ],
  wordTimeline: [],
};

async function open(page, url = '/browse/?ref=Chullin%2091a', { synced = SYNCED } = {}) {
  const asked = [];
  await preparePage(page);
  // No YouTube in the test browser: a stand-in player, ready at once, that notes what it is told.
  await page.addInitScript(() => {
    window.__yt = [];
    window.YT = {
      PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
      Player: function Player(_id, options) {
        const target = new Proxy({}, {
          get: (_t, name) => (name === 'then' ? undefined : (...args) => {
            window.__yt.push([String(name), ...args.filter((a) => typeof a !== 'object')]);
            if (name === 'playVideo') window.__ytState = 1;
            if (name === 'pauseVideo') window.__ytState = 2;
            return name === 'getPlayerState' ? (window.__ytState || 2) : name === 'getDuration' ? 3000 : 0;
          }),
        });
        setTimeout(() => options?.events?.onReady?.({ target }), 0);
        return target;
      },
    };
  });
  await page.route(PDFJS, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: FAKE_PDFJS }));
  await page.route('**/api/daf-page?*', (route) => route.fulfill({ status: 200, contentType: 'application/pdf', body: '%PDF-fake' }));
  await page.route('**/api/get-catalog', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CATALOG) }));
  await page.route('**/api/list-synced-dapim', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(synced) }));
  await page.route('**/api/get-results-file?*', (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).searchParams.get('path'));
    asked.push(path);
    const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === 'pages/Chullin-91a.json') return json(pageMap91a);
    if (path in LINKS) return json(LINKS[path]);
    if (/^by-ref\/(Hebrew-|Bornstein-)?Chullin-91a\.json$/.test(path)) return json(ALIGNMENT);
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not found."}' });
  });
  await page.goto(url);
  await expect.poll(() => page.evaluate(() => !!state.videoCatalog)).toBe(true);
  return asked;
}

const wordsReady = (page) => expect.poll(() => page.evaluate(() => state.vilnaPageMap?.wordBoxes?.length || 0), { timeout: 10000 }).toBeGreaterThan(0);
// A click on one printed word of the daf's first paragraph.
async function tapWord(page, wordIndex, { scroll = true } = {}) {
  await wordsReady(page);
  const at = () => page.evaluate((i) => {
    const b = state.vilnaPageMap.wordBoxes.find((x) => x.ref === 'Chullin 91a.1' && x.wordIndex === i);
    const r = document.getElementById('vilnaPageCanvas').getBoundingClientRect();
    return { x: r.left + (b.x + b.w / 2) * r.width, y: r.top + (b.y + b.h / 2) * r.height };
  }, wordIndex);
  if (scroll) {
    // Scrolling closes an open menu, as it does for a reader; let it land first.
    const first = await at();
    await page.evaluate((y) => new Promise((done) => {
      window.scrollBy({ top: y - window.innerHeight / 3, behavior: 'instant' });
      requestAnimationFrame(() => requestAnimationFrame(done));
    }), first.y);
  }
  const point = await at();
  await page.mouse.click(point.x, point.y);
}
const menuItems = (page) => page.locator('.daf-context-menu:not([hidden]) .daf-context-item');
const watchLines = (page) => page.locator('.daf-context-menu:not([hidden]) .daf-context-item.is-primary');
const loadedVideo = (page) => page.evaluate(() => state.videoSource?.videoId || null);
const videoUp = (page) => page.evaluate(() => document.body.classList.contains('book-video-up'));

test.describe('Interactive Daf — the book on its own', () => {
  test('no player and no list of shiurim; only the masechta to pick, and every masechta is there', async ({ page }) => {
    await open(page);
    await expect(page.locator('.player-card')).toBeHidden();
    await expect(page.locator('#videoChoice')).toBeHidden();
    await expect(page.locator('#viewerModeSelect')).toBeHidden();
    await expect(page.locator('#dafTractateSelect')).toBeVisible();
    for (const hidden of ['#dafDafSelect', '#dafAmudToggle', '#dafShiurToggle', '#dafLanguageToggle', '#browseNextButton', '#dafCard .view-switch']) {
      await expect(page.locator(hidden)).toBeHidden();
    }
    // All of Shas, not only the masechtos with synced dapim (here: one).
    await expect(page.locator('#dafTractateSelect option')).toHaveCount(36);
    // What stays: the dial, the zoom bar with Select text, Live follow.
    await expect(page.locator('#dafBookDrum')).toBeVisible();
    await expect(page.locator('#vilnaSelectTextModeButton')).toBeVisible();
    await expect(page.locator('#lfToggle')).toBeVisible();
    await expect(page.locator('#dafTitle')).toHaveText('Chullin 91a');
  });

  test('opening a daf loads no shiur, and neither does picking a masechta', async ({ page }) => {
    const asked = await open(page);
    await wordsReady(page);
    expect(await loadedVideo(page)).toBeNull();
    expect(asked.filter((path) => path.startsWith('video-links/'))).toEqual([]);
    await page.locator('#dafTractateSelect').selectOption('Berakhot');
    await expect(page.locator('#dafTitle')).toHaveText(/^Berakhot \d+a$/);
    expect(await loadedVideo(page)).toBeNull();
    expect(await videoUp(page)).toBe(false);
  });

  test('a tap on a word opens its menu, with a line for each shiur that is synced for the amud', async ({ page }) => {
    await open(page);
    await tapWord(page, 7);
    await expect(menuItems(page).first()).toBeVisible();
    // The unsynced Chazarah recording is not offered.
    expect(await watchLines(page).allTextContents()).toEqual([
      "Watch from here: R' Eli Stefansky, English",
      "Watch from here: R' Eli Stefansky, Hebrew",
      "Watch from here: R' Sruly Bornstein, English",
    ]);
    // The rest of the menu is as it was.
    await expect(menuItems(page).filter({ hasText: 'Add note here' })).toHaveCount(1);
    // Nothing has loaded yet, and a tap elsewhere only closes the menu.
    expect(await loadedVideo(page)).toBeNull();
    // (A word the open menu is not lying over.)
    const clear = await page.evaluate(() => {
      const menu = document.querySelector('.daf-context-menu').getBoundingClientRect();
      const r = document.getElementById('vilnaPageCanvas').getBoundingClientRect();
      for (const b of state.vilnaPageMap.wordBoxes) {
        const x = r.left + (b.x + b.w / 2) * r.width;
        const y = r.top + (b.y + b.h / 2) * r.height;
        const onMenu = x > menu.left - 12 && x < menu.right + 12 && y > menu.top - 12 && y < menu.bottom + 12;
        if (!onMenu && x > 8 && x < innerWidth - 8 && y > 90 && y < innerHeight - 140) return { x, y };
      }
      return null;
    });
    expect(clear).not.toBeNull();
    await page.mouse.click(clear.x, clear.y);
    await expect(page.locator('.daf-context-menu')).toBeHidden();
  });

  test('a daf with nothing synced offers no shiur in the menu', async ({ page }) => {
    await open(page, '/browse/?ref=Chullin%2091a', { synced: {} });
    await tapWord(page, 7);
    await expect(menuItems(page).first()).toBeVisible();
    // MDY's own are not synced; the other maggid's is offered as the catalog lists it.
    expect(await watchLines(page).allTextContents()).toEqual(['Watch the shiur from here']);
  });

  test('choosing a shiur floats its video over the daf, at that word', async ({ page }) => {
    await open(page);
    await tapWord(page, 7); // in the second phrase, which starts at 1:00
    await watchLines(page).nth(1).click(); // the Hebrew shiur
    await expect.poll(() => loadedVideo(page)).toBe('BBBBBBBBBBB');
    expect(await videoUp(page)).toBe(true);
    await expect(page.locator('body')).toHaveAttribute('data-viewer-mode', 'video-on-daf');
    await expect(page.locator('#videoFrame')).toBeVisible();
    await expect(page.locator('#viewerModeSelect')).toBeVisible();
    // The video was sent to the phrase the word is in, and told to play.
    await expect.poll(() => page.evaluate(() => window.__yt.filter(([name]) => name === 'seekTo').map(([, t]) => Math.round(t)).pop())).toBe(60);
    await expect.poll(() => page.evaluate(() => window.__yt.some(([name]) => name === 'playVideo'))).toBe(true);
    // The book keeps its own name, whichever shiur is up.
    await expect(page.locator('#dafTitle')).toHaveText('Chullin 91a');
  });

  test('Split view and Daf on video are one tap away, and Close puts the book back', async ({ page }) => {
    await open(page);
    await tapWord(page, 7);
    await watchLines(page).first().click();
    await expect.poll(() => loadedVideo(page)).toBe('AAAAAAAAAAA');
    await page.locator('#viewerModeDafOnVideoButton').click();
    await expect(page.locator('body')).toHaveAttribute('data-viewer-mode', 'daf-on-video');
    expect(await videoUp(page)).toBe(true);
    await page.evaluate(() => document.getElementById('viewerModeSplitButton').click());
    await expect(page.locator('body')).toHaveAttribute('data-viewer-mode', 'split');
    expect(await videoUp(page)).toBe(true);
    // The mode last used is the one the next shiur comes up in.
    expect(await page.evaluate(() => localStorage.getItem('dafsync-book-video-mode'))).toBe('split');
    await page.evaluate(() => document.getElementById('bookVideoCloseButton').click());
    await expect(page.locator('body')).toHaveAttribute('data-viewer-mode', 'standard');
    expect(await videoUp(page)).toBe(false);
    await expect(page.locator('.player-card')).toBeHidden();
    await expect.poll(() => page.evaluate(() => window.__yt.some(([name]) => name === 'pauseVideo'))).toBe(true);
  });

  test('a daf whose words are still being prepared says so when tapped', async ({ page }) => {
    await open(page);
    await wordsReady(page);
    await page.route('**/api/trigger-page-ocr-job', (route) => route.fulfill({ status: 202, contentType: 'application/json', body: '{}' }));
    await page.locator('#dafNextAmudButton').click(); // 91b: no word positions yet
    await expect.poll(() => page.evaluate(() => state.vilnaPageMapStatus)).toEqual({ ref: 'Chullin 91b', status: 'preparing' });
    await expect(page.locator('.daf-book-stage')).toHaveCount(0, { timeout: 5000 });
    const box = await page.locator('#vilnaPageCanvas').boundingBox();
    await page.mouse.click(box.x + box.width / 2, Math.min(box.y + 200, page.viewportSize().height - 160));
    await expect(page.locator('#toast')).toContainText('being prepared');
    await expect(page.locator('.daf-context-menu')).toBeHidden();
  });

  test('a link that names a shiur brings it up', async ({ page }) => {
    await open(page, '/browse/?ref=Chullin%2091a&language=hebrew');
    await expect.poll(() => loadedVideo(page)).toBe('BBBBBBBBBBB');
    expect(await videoUp(page)).toBe(true);
    await expect(page.locator('#videoFrame')).toBeVisible();
  });
});
