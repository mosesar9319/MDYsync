import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { preparePage } from '../support/harness.mjs';

// Switching to another shiur of the same daf, mid-shiur (app.js, "Switching to
// another shiur of the daf"). The new shiur starts at the line the first one
// was reading -- every sync times the same words of the same daf -- and a chip
// leads back to the second the first one was left at.
//
// Three synced shiurim of Chullin 91, each reading the daf's first paragraph
// at its own times; a fourth is linked but not synced.

const pageMap91a = JSON.parse(readFileSync(new URL('../fixtures/pagemap-chullin-91a.json', import.meta.url), 'utf8'));
const PDFJS = /^https:\/\/cdn\.jsdelivr\.net\/npm\/pdfjs-dist@[^/]+\/build\/pdf\.min\.mjs$/;
const FAKE_PDFJS = `
  export const GlobalWorkerOptions = {};
  export function getDocument() {
    const page = {
      getViewport: ({ scale }) => ({ width: Math.round(1341 * scale), height: Math.round(2068 * scale) }),
      render: ({ canvasContext: ctx, viewport }) => { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, viewport.width, viewport.height); return { promise: Promise.resolve() }; },
    };
    return { promise: Promise.resolve({ destroy() {}, getPage: async () => page }) };
  }`;

const LAKEWOOD_91 = 'https://lakewoodafyomi.appspot.com/m5/X/Chulin%2091_91.mp3';
const CATALOG = {
  tractates: {
    Chullin: [{
      daf: 91,
      regularEn: { videoId: 'AAAAAAAAAAA', label: 'Daf Yomi Chullin Daf 91', amud: 'a' },
      regularHe: { videoId: 'BBBBBBBBBBB', label: 'מרכז דף יומי חולין', amud: 'a' },
      chazarahEn: { videoId: 'DDDDDDDDDDD', label: 'Chazarah, not synced', amud: 'a' },
    }],
  },
  maggidim: { bornstein: { tractates: { Chullin: [{ daf: 91, regularEn: { videoId: 'L0000000091', label: 'Chulin 91', amud: 'a', source: 'lakewood', url: LAKEWOOD_91 } }] } } },
};
// The chazarah is linked but not synced; R' Bornstein's sync is listed under his id.
const SYNCED = { Chullin: { '91a': ['regularEn', 'regularHe', 'bornstein:regularEn'] } };
const link = (videoId, label) => ({ type: 'youtube', videoId, url: `https://www.youtube.com/watch?v=${videoId}`, label });
const LINKS = {
  'video-links/Chullin-91a.json': link('AAAAAAAAAAA', 'Daf Yomi Chullin Daf 91'),
  'video-links/Hebrew-Chullin-91a.json': link('BBBBBBBBBBB', 'Hebrew'),
  'video-links/Bornstein-Chullin-91a.json': { type: 'lakewood', videoId: 'L0000000091', url: LAKEWOOD_91, label: 'Chulin 91', source: 'lakewood-feed', maggid: 'bornstein' },
};
const alignment = (segments) => ({ version: 1, dafRef: 'Chullin 91a', duration: 3000, alignmentStatus: 'complete', segments, wordTimeline: [] });
const ALIGNMENTS = {
  // English: the first five words at 0:30, the next five at 1:00.
  'by-ref/Chullin-91a.json': alignment([
    { ref: 'Chullin 91a:1', start: 30, end: 60, he: 'א ב ג ד ה', w0: 0, w1: 4 },
    { ref: 'Chullin 91a:1', start: 60, end: 90, he: 'ו ז ח ט י', w0: 5, w1: 9 },
  ]),
  // Hebrew: the same words, much later (and the second phrase read twice).
  'by-ref/Hebrew-Chullin-91a.json': alignment([
    { ref: 'Chullin 91a:1', start: 100, end: 150, he: 'א ב ג ד ה', w0: 0, w1: 4 },
    { ref: 'Chullin 91a:1', start: 200, end: 250, he: 'ו ז ח ט י', w0: 5, w1: 9 },
    { ref: 'Chullin 91a:1', start: 400, end: 420, he: 'ו ז ח ט י', w0: 5, w1: 9 },
  ]),
  // R' Bornstein: reads the first phrase and never the second.
  'by-ref/Bornstein-Chullin-91a.json': alignment([
    { ref: 'Chullin 91a:1', start: 15, end: 40, he: 'א ב ג ד ה', w0: 0, w1: 4 },
    { ref: 'Chullin 91a:1', start: 41, end: 42, he: 'ו ז ח ט י', w0: 5, w1: 9, estimated: true },
  ]),
};

async function open(page, options = {}) {
  await preparePage(page, options);
  // A stand-in YouTube player whose clock is wherever it was last sent, or
  // where the test puts it (window.__ytTime).
  await page.addInitScript(() => {
    window.__yt = [];
    window.__ytTime = 0;
    window.YT = {
      PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
      Player: function Player(_id, options) {
        const target = new Proxy({}, {
          get: (_t, name) => (name === 'then' ? undefined : (...args) => {
            window.__yt.push([String(name), ...args.filter((a) => typeof a !== 'object')]);
            if (name === 'playVideo') window.__ytState = 1;
            if (name === 'pauseVideo') window.__ytState = 2;
            if (name === 'seekTo') window.__ytTime = Number(args[0]) || 0;
            if (name === 'loadVideoById' || name === 'cueVideoById') window.__ytTime = 0;
            return name === 'getPlayerState' ? (window.__ytState || 2) : name === 'getDuration' ? 3000 : name === 'getCurrentTime' ? window.__ytTime : 0;
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
  await page.route('**/api/list-synced-dapim', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SYNCED) }));
  await page.route('https://lakewoodafyomi.appspot.com/**', () => {});
  await page.route('**/api/get-results-file?*', (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).searchParams.get('path'));
    const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === 'pages/Chullin-91a.json') return json(pageMap91a);
    if (path in LINKS) return json(LINKS[path]);
    if (path in ALIGNMENTS) return json(ALIGNMENTS[path]);
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not found."}' });
  });
  await page.goto('/browse/?ref=Chullin%2091a');
  await expect.poll(() => page.evaluate(() => !!state.videoCatalog && !!state.syncedDapim)).toBe(true);
}

const loadedVideo = (page) => page.evaluate(() => state.videoSource?.videoId || null);
const lastSeek = (page) => page.evaluate(() => window.__yt.filter(([name]) => name === 'seekTo').map(([, t]) => Math.round(t * 10) / 10).pop());
const choice = (page, videoId) => page.evaluate((id) => {
  const found = videoChoicesFor('Chullin', 91).find((c) => c.videoId === id);
  return found;
}, videoId);
// Brings MDY's English shiur up over the daf, as "Watch from here" does.
async function bringUpEnglish(page, wordIndex = 0) {
  await page.evaluate((i) => window.dafBookVideo.watch(videoChoicesFor('Chullin', 91).find((c) => c.videoId === 'AAAAAAAAAAA'), 'Chullin 91a.1', i), wordIndex);
  await expect.poll(() => loadedVideo(page)).toBe('AAAAAAAAAAA');
  await expect.poll(() => page.evaluate(() => document.body.classList.contains('book-video-up'))).toBe(true);
}

// The shiur has played on to `seconds`. The stand-in player has no clock of its
// own, so the test moves it -- once the page has finished settling the frame
// it loaded on (it puts a paused player back where it sent it).
async function playedTo(page, seconds) {
  await expect.poll(() => page.evaluate(() => state.pausedFrameRefresh || 0)).toBe(0);
  await page.waitForTimeout(700);
  await expect.poll(() => page.evaluate(() => state.pausedFrameRefresh || 0)).toBe(0);
  await page.evaluate((t) => { window.__ytTime = t; }, seconds);
  expect(await page.evaluate(() => Math.round(readPlayerTime()))).toBe(seconds);
}

test.describe('Switching to another shiur of the daf', () => {
  test('nothing to switch to until a synced shiur is up', async ({ page }) => {
    await open(page);
    expect(await page.evaluate(() => window.dafSwitchShiur.choices().length)).toBe(0);
    await expect(page.locator('#playerSwitchButton')).toBeHidden();
  });

  test('the list has the daf’s other synced shiurim: not the one playing, not an unsynced one', async ({ page }) => {
    await open(page);
    await bringUpEnglish(page);
    await expect.poll(() => page.evaluate(() => document.getElementById('playerSwitchButton').hidden)).toBe(false);
    expect(await page.evaluate(() => window.dafSwitchShiur.choices().map((e) => e.choice.videoId))).toEqual(['BBBBBBBBBBB', 'L0000000091']);
    await page.evaluate(() => window.dafSwitchShiur.open());
    const rows = page.locator('#switchShiurList .switch-shiur-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0).locator('strong')).toHaveText("R' Eli Stefansky · Hebrew");
    await expect(rows.nth(1).locator('strong')).toHaveText("R' Sruly Bornstein · English");
    await expect(rows.nth(1).locator('.switch-shiur-kind')).toHaveText('Audio');
    await expect(page.locator('#switchShiurDialogTitle')).toHaveText('Chullin 91');
  });

  test('the button is on the bottom bar: on a computer, and in the mini player over the daf', async ({ page }, testInfo) => {
    await open(page);
    await bringUpEnglish(page);
    // The shiur is up as the mini player floated over the daf, which has no top bar.
    await expect.poll(() => page.evaluate(() => document.body.classList.contains('reading-mode-active'))).toBe(true);
    // On its bar, not inside the More menu.
    await expect.poll(() => page.evaluate(() => {
      const button = document.getElementById('barSwitchButton');
      return !button.hidden && button.offsetWidth > 0 && Boolean(button.closest('.pc-tools'));
    })).toBe(true);
    // The bar still fits its frame.
    expect(await page.evaluate(() => {
      const controls = document.querySelector('.player-controls');
      return controls.scrollWidth <= controls.clientWidth + 1;
    })).toBe(true);
    if (testInfo.project.name === 'desktop') {
      // A computer has the one button: the top bar's is put away.
      expect(await page.evaluate(() => getComputedStyle(document.getElementById('playerSwitchButton')).display)).toBe('none');
    }
    await page.evaluate(() => document.getElementById('barSwitchButton').click());
    await expect(page.locator('#switchShiurList .switch-shiur-row')).toHaveCount(2);
  });

  test('the new shiur starts where it first reads the line the old one was on; the chip goes back to the very second', async ({ page }) => {
    await open(page);
    await bringUpEnglish(page);
    // The English shiur has played on into its second phrase.
    await playedTo(page, 75);
    await page.evaluate(() => window.dafSwitchShiur.open());
    await page.locator('#switchShiurList .switch-shiur-row').nth(0).click();   // Hebrew
    await expect.poll(() => loadedVideo(page)).toBe('BBBBBBBBBBB');
    // Hebrew reads that phrase at 3:20 and again at 6:40: the first reading, less the lead-in.
    await expect.poll(() => lastSeek(page)).toBe(199.6);
    await expect(page.locator('#switchShiurDialog')).toBeHidden();
    // The chip names the shiur that was left.
    const chip = page.locator('#switchBackChip');
    await expect(chip).toBeVisible();
    await expect(page.locator('#switchBackLabel')).toHaveText("Back to R' Eli Stefansky · English");
    // It sits clear of the phone's bottom navigation, inside the screen.
    const clear = await page.evaluate(() => {
      const chip = document.getElementById('switchBackChip').getBoundingClientRect();
      const nav = document.querySelector('.mobile-nav');
      const navTop = nav && getComputedStyle(nav).display !== 'none' ? nav.getBoundingClientRect().top : window.innerHeight;
      return { aboveNav: chip.bottom <= navTop, inside: chip.left >= 0 && chip.right <= window.innerWidth && chip.top >= 0 };
    });
    expect(clear).toEqual({ aboveNav: true, inside: true });
    // Now the English shiur is the one to switch to, not the Hebrew.
    expect(await page.evaluate(() => window.dafSwitchShiur.choices().map((e) => e.choice.videoId))).toEqual(['AAAAAAAAAAA', 'L0000000091']);

    await page.locator('#switchBackGo').click();
    await expect.poll(() => loadedVideo(page)).toBe('AAAAAAAAAAA');
    await expect.poll(() => lastSeek(page)).toBe(75);       // the second it was left at, not the line's start
    await expect(chip).toBeHidden();
  });

  test('a shiur that never reads that line starts at the nearest earlier one it did read, and says so', async ({ page }) => {
    await open(page);
    await bringUpEnglish(page);
    await playedTo(page, 75);
    await page.evaluate(() => window.dafSwitchShiur.open());
    await page.locator('#switchShiurList .switch-shiur-row').nth(1).click();   // R' Bornstein
    await expect.poll(() => loadedVideo(page)).toBe('L0000000091');
    // His only real line is the first phrase, at 0:15 (the second is a placeholder).
    // (His mp3 never arrives here, so the page is asked where it sent the player.)
    await expect.poll(() => page.evaluate(() => Math.round((state.lastObservedTime || 0) * 10) / 10)).toBe(14.6);
    await expect(page.locator('#toast')).toContainText('does not read that line');
    await expect(page.locator('#switchBackChip')).toBeVisible();
    // The message shows above the chip, not under it.
    await expect.poll(() => page.evaluate(() => {
      const toast = document.getElementById('toast').getBoundingClientRect();
      const chip = document.getElementById('switchBackChip').getBoundingClientRect();
      return toast.bottom <= chip.top;
    })).toBe(true);
    // The chip is dismissed without going back.
    await page.locator('#switchBackDismiss').click();
    await expect(page.locator('#switchBackChip')).toBeHidden();
    expect(await loadedVideo(page)).toBe('L0000000091');
  });

  test('the audio bar has the Switch button too', async ({ page }) => {
    // R' Bornstein's shiur is audio from Lakewood Daf Yomi's server: the bar is the player.
    await open(page, { videoSource: 'mdy' });
    await page.evaluate(() => { window.dafBookVideo.watch(videoChoicesFor('Chullin', 91).find((c) => c.videoId === 'L0000000091'), 'Chullin 91a.1', 0, { audio: true }); });
    await expect.poll(() => loadedVideo(page)).toBe('L0000000091');
    await expect(page.locator('#audioBar')).toBeVisible();
    const button = page.locator('#audioBarSwitch');
    await expect(button).toBeVisible();
    await button.click();
    const rows = page.locator('#switchShiurList .switch-shiur-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0).locator('strong')).toHaveText("R' Eli Stefansky · English");
    await expect(rows.nth(1).locator('strong')).toHaveText("R' Eli Stefansky · Hebrew");
    // The bar fits the phone's width with the extra button in it.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const box = await page.locator('#audioBar .audio-bar-row').evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    expect(box.scroll).toBeLessThanOrEqual(box.client + 1);
  });

  test('before anything is read, the new shiur starts from its beginning; closing the shiur clears the way back', async ({ page }) => {
    await open(page);
    await bringUpEnglish(page);
    await playedTo(page, 5);        // still the introduction
    await page.evaluate(() => window.dafSwitchShiur.open());
    await page.locator('#switchShiurList .switch-shiur-row').nth(0).click();
    await expect.poll(() => loadedVideo(page)).toBe('BBBBBBBBBBB');
    await expect.poll(() => lastSeek(page)).toBe(0);
    await expect(page.locator('#toast')).toContainText('starts from its beginning');
    await expect(page.locator('#switchBackChip')).toBeVisible();
    await page.evaluate(() => window.dafBookVideo.close());
    await expect(page.locator('#switchBackChip')).toBeHidden();
    expect(await page.evaluate(() => window.dafSwitchShiur.choices().length)).toBe(0);
  });

  test('the line a shiur is on, and where another reads it', async ({ page }) => {
    await open(page);
    const out = await page.evaluate(() => {
      const { currentReadLine, switchTarget } = window.dafSwitchShiur;
      const a = [
        { ref: 'Chullin 91a:1', start: 30, end: 60, w0: 0, w1: 4 },
        { ref: 'Chullin 91a:2', start: 31, end: 32, w0: 0, w1: 3, estimated: true },
        { ref: 'Chullin 91a:1', start: 60, end: 90, w0: 5, w1: 9 },
        { ref: 'Chullin 91b (Hebrew):3', start: 500, end: 520, w0: 2, w1: 6 },
      ];
      const b = [
        { ref: 'Chullin 91a:1', start: 10, end: 20, w0: 0, w1: 9 },
        { ref: 'Chullin 91a:4', start: 300, end: 320, w0: 0, w1: 5 },
        { ref: 'Chullin 91b:3', start: 900, end: 920, w0: 0, w1: 1 },
      ];
      return {
        intro: currentReadLine(a, 12),
        first: currentReadLine(a, 45),
        skipsPlaceholder: currentReadLine(a, 59),
        second: currentReadLine(a, 200),
        marker: currentReadLine(a, 510),
        exact: switchTarget(b, { ref: 'Chullin 91a.1', wordIndex: 7 }),
        // 91b:3 word 2 is not read by b (it reads words 0-1 of it): the nearest earlier line read.
        earlier: switchTarget(b, { ref: 'Chullin 91b.3', wordIndex: 2 }),
        // Before anything b read.
        none: switchTarget([{ ref: 'Chullin 91a:5', start: 9, end: 10, w0: 0, w1: 2 }], { ref: 'Chullin 91a.1', wordIndex: 0 }),
        noLine: switchTarget(b, null),
      };
    });
    expect(out.intro).toBeNull();
    expect(out.first).toEqual({ ref: 'Chullin 91a.1', wordIndex: 0 });
    expect(out.skipsPlaceholder).toEqual({ ref: 'Chullin 91a.1', wordIndex: 0 });
    expect(out.second).toEqual({ ref: 'Chullin 91a.1', wordIndex: 5 });
    expect(out.marker).toEqual({ ref: 'Chullin 91b.3', wordIndex: 2 });
    expect(out.exact).toEqual({ index: 0, exact: true });
    expect(out.earlier).toEqual({ index: 2, exact: false });
    expect(out.none).toEqual({ index: -1, exact: false });
    expect(out.noLine).toEqual({ index: -1, exact: false });
  });
});
