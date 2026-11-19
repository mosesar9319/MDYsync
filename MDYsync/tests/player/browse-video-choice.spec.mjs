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
const LAKEWOOD_91 = 'https://lakewoodafyomi.appspot.com/m5/X/Chulin%2091_91.mp3';
const CATALOG = {
  tractates: {
    Chullin: [
      { daf: 91, regularEn: { videoId: 'AAAAAAAAAAA', label: 'Daf Yomi Chullin Daf 91', amud: 'a' }, regularHe: { videoId: 'BBBBBBBBBBB', label: 'מרכז דף יומי חולין', amud: 'a' }, chazarahEn: { videoId: 'DDDDDDDDDDD', label: 'Chazarah, not synced', amud: 'a' } },
    ],
  },
  // R' Bornstein's shiurim come from Lakewood Daf Yomi's own feed, named by their own id (tools/lakewood-import.mjs).
  maggidim: { bornstein: { tractates: { Chullin: [{ daf: 91, regularEn: { videoId: 'L0000000091', label: 'Chulin 91', amud: 'a', source: 'lakewood', url: LAKEWOOD_91 } }] } } },
};
// The Chazarah recording is linked but its sync has not finished.
const SYNCED = { Chullin: { '91a': ['regularEn', 'regularHe'] } };
const LINKS = {
  'video-links/Chullin-91a.json': link('AAAAAAAAAAA', 'Daf Yomi Chullin Daf 91'),
  'video-links/Hebrew-Chullin-91a.json': link('BBBBBBBBBBB', 'Hebrew'),
  'video-links/Bornstein-Chullin-91a.json': { type: 'lakewood', videoId: 'L0000000091', url: LAKEWOOD_91, label: 'Chulin 91', source: 'lakewood-feed', maggid: 'bornstein' },
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

async function open(page, url = '/browse/?ref=Chullin%2091a', { synced = SYNCED, videoSource } = {}) {
  const asked = [];
  await preparePage(page, videoSource ? { videoSource } : {});
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
    for (const hidden of ['#dafDafSelect', '#dafAmudToggle', '#dafShiurToggle', '#dafLanguageToggle', '#browseNextButton', '#dafCard .view-switch', '#lfPanel']) {
      await expect(page.locator(hidden)).toBeHidden();
    }
    // All of Shas, not only the masechtos with synced dapim (here: one).
    await expect(page.locator('#dafTractateSelect option')).toHaveCount(36);
    // What stays: the dial and the zoom bar with Select text.
    await expect(page.locator('#dafBookDrum')).toBeVisible();
    await expect(page.locator('#vilnaSelectTextModeButton')).toBeVisible();
    // The masechta picker is light, with dark writing: readable without opening it.
    const colors = await page.locator('#dafTractateSelect').evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).color]);
    expect(colors).toEqual(['rgb(255, 255, 255)', 'rgb(19, 34, 56)']);
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

  test('a tap on a word opens its menu, with one line to watch the shiur from there', async ({ page }) => {
    await open(page);
    await tapWord(page, 7);
    await expect(menuItems(page).first()).toBeVisible();
    expect(await watchLines(page).allTextContents()).toEqual(['Watch from here']);
    await expect(menuItems(page).filter({ hasText: 'Add note here' })).toHaveCount(1);
    expect(await loadedVideo(page)).toBeNull();
    // A tap elsewhere (a word the open menu is not lying over) only closes it.
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

  test('Watch from here opens a window of every shiur linked to the daf, synced or not, with its picture', async ({ page }) => {
    await open(page);
    // The site's image service, which sends MDY's pictures resized.
    const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    await page.route('**/.netlify/images?*', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
    await tapWord(page, 7);
    await watchLines(page).click();
    const rows = page.locator('#bookShiurList .book-shiur-row');
    await expect(rows).toHaveCount(4);
    await expect(page.locator('#bookShiurDialogTitle')).toHaveText('Chullin 91a');
    const seen = await rows.evaluateAll((list) => list.map((row) => ({
      who: row.querySelector('strong').textContent,
      status: row.querySelector('.book-shiur-status').textContent,
      buttons: [...row.querySelectorAll('button')].map((b) => b.textContent),
      picture: row.querySelector('img')?.getAttribute('src') || '',
    })));
    expect(seen.map((r) => [r.who, r.status, r.buttons.join('/')])).toEqual([
      ["R' Eli Stefansky · English", 'Synced · starts at this word', 'Video/Audio'],
      ["R' Eli Stefansky · Hebrew", 'Synced · starts at this word', 'Video/Audio'],
      ["R' Eli Stefansky · Chazarah Daf, English", 'Not synced yet · plays from the start', 'Video/Audio'],
      // R' Bornstein's: audio only, from Lakewood Daf Yomi's server; its sync is found out when it loads.
      ["R' Sruly Bornstein · English", 'Starts at this word where synced', 'Audio'],
    ]);
    // MDY's picture through the site's image service; R' Bornstein's own picture for his -- never YouTube's.
    expect(seen[0].picture).toContain('/.netlify/images?url=');
    expect(seen[0].picture).toContain(encodeURIComponent('https://cdn.mdydaf.com/shiur/english/chullin/thumb/91.png'));
    expect(seen[3].picture).toBe('/assets/maggidim/bornstein-v1.jpg');
    expect(seen.map((r) => r.picture).join(' ')).not.toContain('ytimg');
  });

  test('choosing a shiur floats its video over the daf, at that word', async ({ page }) => {
    await open(page);
    await tapWord(page, 7); // in the second phrase, which starts at 1:00
    await watchLines(page).click();
    await page.locator('#bookShiurList .book-shiur-row').nth(1).locator('button', { hasText: 'Video' }).click(); // Hebrew
    await expect.poll(() => loadedVideo(page)).toBe('BBBBBBBBBBB');
    expect(await videoUp(page)).toBe(true);
    await expect(page.locator('body')).toHaveAttribute('data-viewer-mode', 'video-on-daf');
    await expect(page.locator('#videoFrame')).toBeVisible();
    await expect(page.locator('#viewerModeSelect')).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__yt.filter(([name]) => name === 'seekTo').map(([, t]) => Math.round(t)).pop())).toBe(60);
    await expect.poll(() => page.evaluate(() => window.__yt.some(([name]) => name === 'playVideo'))).toBe(true);
    await expect(page.locator('#dafTitle')).toHaveText('Chullin 91a');
  });

  test('while a shiur is up, a tap on a word sends it there, and a long press opens the menu', async ({ page }) => {
    await open(page);
    await tapWord(page, 7);
    await watchLines(page).click();
    await page.locator('#bookShiurList .book-shiur-row').first().locator('button', { hasText: 'Video' }).click();
    await expect.poll(() => loadedVideo(page)).toBe('AAAAAAAAAAA');
    await expect.poll(() => page.evaluate(() => window.__yt.filter(([name]) => name === 'seekTo').map(([, t]) => Math.round(t)).pop())).toBe(60);
    // The first phrase starts at 0:30. A tap there: no menu, the shiur goes to it.
    await page.evaluate(() => { document.body.classList.remove('reading-mode-active'); }); // the float is not over the words in this check
    await tapWord(page, 2);
    await expect.poll(() => page.evaluate(() => window.__yt.filter(([name]) => name === 'seekTo').map(([, t]) => Math.round(t)).pop())).toBe(30);
    await expect(page.locator('.daf-context-menu')).toBeHidden();
    // A right-click (a long press on a phone) still opens the menu.
    const point = await page.evaluate(() => {
      const b = state.vilnaPageMap.wordBoxes.find((x) => x.ref === 'Chullin 91a.1' && x.wordIndex === 7);
      const r = document.getElementById('vilnaPageCanvas').getBoundingClientRect();
      return { x: r.left + (b.x + b.w / 2) * r.width, y: r.top + (b.y + b.h / 2) * r.height };
    });
    await page.mouse.click(point.x, point.y, { button: 'right' });
    await expect(menuItems(page).first()).toBeVisible();
  });

  test('a shiur with no sync yet plays from its beginning, highlights nothing, and saves nothing', async ({ page }) => {
    const writes = [];
    await open(page);
    page.on('request', (request) => { if (request.method() !== 'GET') writes.push(request.url()); });
    await tapWord(page, 7);
    await watchLines(page).click();
    await page.locator('#bookShiurList .book-shiur-row').nth(2).locator('button', { hasText: 'Video' }).click(); // Chazarah, not synced
    await expect.poll(() => loadedVideo(page)).toBe('DDDDDDDDDDD');
    await expect.poll(() => page.evaluate(() => window.__yt.filter(([name]) => name === 'seekTo').map(([, t]) => Math.round(t)).pop())).toBe(0);
    expect(await page.evaluate(() => state.bookVideo.synced)).toBe(false);
    await expect(page.locator('#toast')).toContainText('not synced');
    await expect(page.locator('#vilnaActiveOverlay > *')).toHaveCount(0);
    expect(writes.filter((url) => /save-video-link|video-links/.test(url))).toEqual([]);
    // A tap on a word opens the menu: there is nowhere in it to send this shiur.
    expect(await page.evaluate(() => window.dafBookVideo.canSeek())).toBe(false);
  });

  test('Audio plays MDY’s mp3 of the shiur, over the daf, from the word', async ({ page }) => {
    await open(page, '/browse/?ref=Chullin%2091a', { videoSource: 'mdy' });
    await tapWord(page, 7);
    await watchLines(page).click();
    const mp3 = page.waitForRequest('https://cdn.mdydaf.com/shiur/english/chullin/mp3/91.mp3');
    await page.locator('#bookShiurList .book-shiur-row').first().locator('button', { hasText: 'Audio' }).click();
    await mp3;
    await expect.poll(() => page.evaluate(() => document.body.classList.contains('book-audio'))).toBe(true);
    // Listening here is not made the player pages' default.
    expect(await page.evaluate(() => localStorage.getItem('dafsync-mdy-quality'))).not.toBe('audio');
  });

  test('audio alone: a slim bar at the bottom instead of the video player, with a way back to the video', async ({ page }) => {
    await open(page, '/browse/?ref=Chullin%2091a', { videoSource: 'mdy' });
    // MDY's mp3 starts and keeps loading (no answer here), so the page stays on it.
    await page.route('https://cdn.mdydaf.com/**/mp3/*.mp3', () => {});
    await tapWord(page, 7);
    await watchLines(page).click();
    await page.locator('#bookShiurList .book-shiur-row').first().locator('button', { hasText: 'Audio' }).click();
    const bar = page.locator('#audioBar');
    await expect(bar).toBeVisible();
    await expect(page.locator('.player-card')).toBeHidden();
    await expect(page.locator('#viewerModeSelect')).toBeHidden();
    for (const id of ['#audioBarPlay', '#audioBarBack', '#audioBarForward', '#audioBarVaater', '#audioBarSpeed', '#audioBarDownload', '#audioBarVideo', '#audioBarClose']) {
      await expect(bar.locator(id)).toBeVisible();
    }
    // MDY's mp3, saved through dafsync.com.
    await expect(bar.locator('#audioBarDownload')).toHaveAttribute('href', '/mdy-audio/shiur/english/chullin/mp3/91.mp3');
    await expect(bar.locator('#audioBarDownload')).toHaveAttribute('download', "Chullin 91 - R' Eli Stefansky.mp3");
    // Slim, at the bottom of the screen, above the phone's bottom bar where there is one.
    const box = await bar.boundingBox();
    expect(box.height).toBeLessThan(80);
    const navTop = await page.evaluate(() => {
      const nav = document.querySelector('.mobile-nav');
      return nav && getComputedStyle(nav).display !== 'none' ? nav.getBoundingClientRect().top : window.innerHeight;
    });
    // Phones: flush on the bottom bar. Desktop: a card floating 16px off the bottom.
    const gap = navTop - (box.y + box.height);
    expect(gap).toBeGreaterThanOrEqual(-1);
    expect(gap).toBeLessThan(20);
    // The speed opens a list of speeds, above the bar; a pick sets it and closes the list.
    const speeds = page.locator('#audioBarSpeedMenu');
    await expect(speeds).toBeHidden();
    await bar.locator('#audioBarSpeed').click();
    await expect(speeds).toBeVisible();
    await expect(speeds.locator('li')).toHaveText(['0.75×', '1×', '1.25×', '1.5×', '2×', '2.5×', '3×']);
    await expect(speeds.locator('li[aria-selected="true"]')).toHaveText('1×');
    const listBox = await speeds.boundingBox();
    expect(listBox.y + listBox.height).toBeLessThanOrEqual((await bar.boundingBox()).y + 1);
    await speeds.locator('li', { hasText: '1.5×' }).click();
    await expect(speeds).toBeHidden();
    await expect(bar.locator('#audioBarSpeed')).toHaveText('1.5×');
    expect(await page.evaluate(() => document.getElementById('video').playbackRate)).toBe(1.5);
    // Open again: the speed in use is the one marked; a tap elsewhere closes it unchanged.
    await bar.locator('#audioBarSpeed').click();
    await expect(speeds.locator('li[aria-selected="true"]')).toHaveText('1.5×');
    await page.locator('#audioBarTitle').click();
    await expect(speeds).toBeHidden();
    await expect(bar.locator('#audioBarSpeed')).toHaveText('1.5×');
    // Video brings the player back.
    await bar.locator('#audioBarVideo').click();
    await expect(bar).toBeHidden();
    await expect(page.locator('#videoFrame')).toBeVisible();
  });

  test("R' Bornstein's shiur plays as audio from Lakewood Daf Yomi's server, never from YouTube", async ({ page }) => {
    await open(page, '/browse/?ref=Chullin%2091a', { videoSource: 'mdy' });
    const LAKEWOOD = LAKEWOOD_91;
    const lookups = [];
    await page.route('**/api/lakewood-audio?*', (route) => {
      lookups.push(Object.fromEntries(new URL(route.request().url()).searchParams));
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ url: LAKEWOOD, seconds: 3000, title: 'Chulin 91', artwork: 'https://app.daf-yomi.net/images/daf-podcast-2.jpeg' }) });
    });
    // Their mp3 keeps loading (no answer here), so the page stays on it.
    await page.route('https://lakewoodafyomi.appspot.com/**', () => {});
    await tapWord(page, 7);
    await watchLines(page).click();
    const row = page.locator('#bookShiurList .book-shiur-row').nth(3);
    await expect(row.locator('button')).toHaveText(['Audio']);
    await row.locator('button', { hasText: 'Audio' }).click();
    await expect.poll(() => page.evaluate(() => document.querySelector('video')?.getAttribute('src'))).toBe(LAKEWOOD);
    // The link has the feed's address: nothing to look up, and it is a Lakewood source.
    expect(lookups).toEqual([]);
    expect(await page.evaluate(() => ({ type: state.videoSource.type, id: state.videoSource.videoId }))).toEqual({ type: 'lakewood', id: 'L0000000091' });
    const bar = page.locator('#audioBar');
    await expect(bar).toBeVisible();
    // Nothing to switch to: no video.
    await expect(bar.locator('#audioBarVideo')).toBeHidden();
    await expect(bar.locator('#audioBarPlay')).toBeVisible();
    // The MP3 is saved through dafsync.com, under the shiur's name.
    const download = bar.locator('#audioBarDownload');
    await expect(download).toBeVisible();
    await expect(download).toHaveAttribute('href', '/lakewood-audio/Chulin%2091_91.mp3');
    await expect(download).toHaveAttribute('download', "Chullin 91 - R' Sruly Bornstein.mp3");
    expect(await page.evaluate(() => window.__yt.length)).toBe(0); // YouTube was never asked
  });

  test("R' Bornstein's shiur that does not load from Lakewood Daf Yomi's server says so, and does not turn to YouTube", async ({ page }) => {
    await open(page, '/browse/?ref=Chullin%2091a', { videoSource: 'mdy' });
    await page.route('https://lakewoodafyomi.appspot.com/**', (route) => route.fulfill({ status: 404, body: '' }));
    await tapWord(page, 7);
    await watchLines(page).click();
    await page.locator('#bookShiurList .book-shiur-row').nth(3).locator('button', { hasText: 'Audio' }).click();
    await expect(page.locator('.toast')).toContainText("didn't load from Lakewood Daf Yomi's server");
    expect(await page.evaluate(() => window.__yt.length)).toBe(0);
    expect(await page.evaluate(() => state.videoSource?.type)).toBe('lakewood');
  });

  test('Split view and Daf on video are one tap away, and Close puts the book back', async ({ page }) => {
    await open(page);
    await tapWord(page, 7);
    await watchLines(page).click();
    await page.locator('#bookShiurList .book-shiur-row').first().locator('button', { hasText: 'Video' }).click();
    await expect.poll(() => loadedVideo(page)).toBe('AAAAAAAAAAA');
    await page.locator('#viewerModeDafOnVideoButton').click();
    await expect(page.locator('body')).toHaveAttribute('data-viewer-mode', 'daf-on-video');
    expect(await videoUp(page)).toBe(true);
    await page.evaluate(() => document.getElementById('viewerModeSplitButton').click());
    await expect(page.locator('body')).toHaveAttribute('data-viewer-mode', 'split');
    expect(await videoUp(page)).toBe(true);
    expect(await page.evaluate(() => localStorage.getItem('dafsync-book-video-mode'))).toBe('split');
    await page.evaluate(() => document.getElementById('bookVideoCloseButton').click());
    await expect(page.locator('body')).toHaveAttribute('data-viewer-mode', 'standard');
    expect(await videoUp(page)).toBe(false);
    await expect(page.locator('.player-card')).toBeHidden();
    await expect.poll(() => page.evaluate(() => window.__yt.some(([name]) => name === 'pauseVideo'))).toBe(true);
    // Closed, a tap opens the menu again.
    expect(await page.evaluate(() => window.dafBookVideo.canSeek())).toBe(false);
  });

  test('a daf whose words are still being prepared says so when tapped', async ({ page }) => {
    await open(page);
    await wordsReady(page);
    await page.route('**/api/trigger-page-ocr-job', (route) => route.fulfill({ status: 202, contentType: 'application/json', body: '{}' }));
    await page.locator('#dafNextAmudButton').click(); // 91b: no word positions yet
    await expect.poll(() => page.evaluate(() => state.vilnaPageMapStatus)).toEqual({ ref: 'Chullin 91b', status: 'preparing' });
    await expect(page.locator('.daf-book-stage')).toHaveCount(0, { timeout: 5000 });
    await page.evaluate(() => new Promise((done) => {
      document.getElementById('vilnaPageWrap').scrollIntoView({ block: 'start', behavior: 'instant' });
      requestAnimationFrame(() => requestAnimationFrame(done));
    }));
    const box = await page.locator('#vilnaPageCanvas').boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + 150);
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
