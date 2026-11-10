import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { preparePage } from '../support/harness.mjs';

// Phone layout for the shiur player. Bekhorot 30a Chazarah is the page QA
// used (portrait ~400x985, landscape ~985x400). The YouTube stand-in can
// delay its PLAYING event and slip the clock, which is what a paused Vaater
// and a pause looked like on a real device.

const LIVE = 'https://dafsync.netlify.app/api/get-results-file?path=';
const FILES = [
  'by-ref/Chazarah-Daf-Bekhorot-30a.json',
  'video-links/Chazarah-Daf-Bekhorot-30a.json',
];
const SHOTS = '/opt/cursor/artifacts/mobile-layout';

// YouTube's bottom row, in the iframe's own box: the More videos card is
// x 55%–90%, the logo continues to the right edge, and the share icon is
// the first 96px. Project that onto the screen and clip it to the pane.
function rowSlice(iframe, frame, x0, x1) {
  const left = iframe.left + iframe.width * x0;
  const right = iframe.left + iframe.width * x1;
  const top = iframe.bottom - 52;
  const bottom = iframe.bottom;
  const l = Math.max(left, frame.left);
  const r = Math.min(right, frame.right);
  const t = Math.max(top, frame.top);
  const b = Math.min(bottom, frame.bottom);
  return { left: l, right: r, top: t, bottom: b, width: Math.max(0, r - l), height: Math.max(0, b - t) };
}
function expectChipCovers(chip, target, frame, name) {
  if (target.width < 1 || target.height < 1) return;
  expect(chip.right, `${name} chip inside`).toBeLessThanOrEqual(frame.right + 2);
  expect(chip.left, `${name} chip inside`).toBeGreaterThanOrEqual(frame.left - 2);
  expect(chip.left, `${name} covers left`).toBeLessThanOrEqual(target.left + 2);
  expect(chip.right, `${name} covers right`).toBeGreaterThanOrEqual(target.right - 2);
  expect(chip.top, `${name} covers top`).toBeLessThanOrEqual(target.top + 2);
  expect(chip.bottom, `${name} covers bottom`).toBeGreaterThanOrEqual(target.bottom - 2);
}
function expectBottomRow(iframe, frame, logo, share, name) {
  const card = rowSlice(iframe, frame, 0.55, 0.9);
  const logoSlice = rowSlice(iframe, frame, 0.9, 1);
  const shareSlice = rowSlice(iframe, frame, 0, Math.min(1, 96 / Math.max(iframe.width, 1)));
  if (card.width >= 1) {
    const mid = ((card.left + card.right) / 2 - frame.left) / frame.width;
    console.log(`CARD ${name} x=${((card.left - frame.left) / frame.width).toFixed(2)}-${((card.right - frame.left) / frame.width).toFixed(2)} mid=${mid.toFixed(2)} w=${card.width.toFixed(0)}`);
  } else {
    console.log(`CARD ${name} offscreen`);
  }
  if (card.width < 1 && logoSlice.width < 1) expect(logo.width, `${name} card offscreen`).toBeLessThan(2);
  else {
    expectChipCovers(logo, card, frame, `${name} more-videos`);
    expectChipCovers(logo, logoSlice, frame, `${name} logo`);
  }
  if (shareSlice.width < 1) expect(share.width, `${name} share offscreen`).toBeLessThan(2);
  else expectChipCovers(share, shareSlice, frame, `${name} share`);
}

const YT_STUB = `
window.YT = window.YT || {};
window.YT.Player = function (id, options) {
  const self = {
    _time: 0,
    _state: 5,
    _duration: 7200,
    _muted: false,
    _events: options.events,
    seekTo(time) {
      self._time = Number(time) || 0;
      self._origin = self._time;
      if (self._state === 1) self._playedAt = performance.now();
    },
    getCurrentTime() {
      if (self._state === 1 && self._playedAt) {
        return self._origin + (performance.now() - self._playedAt) / 1000;
      }
      return self._time;
    },
    getDuration() { return self._duration; },
    getPlayerState() { return self._state; },
    cueVideoById() { self._state = 5; },
    playVideo() {
      if (self._state !== 1 || !self._playedAt) {
        self._origin = self._time;
        self._playedAt = performance.now();
      }
      self._state = 1;
      self._playCount = (self._playCount || 0) + 1;
      const fire = () => self._events.onStateChange({ data: 1, target: self });
      if (self._delayPlay) setTimeout(fire, self._delayPlay);
      else fire();
    },
    pauseVideo() {
      if (self._playedAt && self._state === 1) {
        self._time = self._origin + (performance.now() - self._playedAt) / 1000;
      }
      self._playedAt = 0;
      self._state = 2;
      self._pauseCount = (self._pauseCount || 0) + 1;
      if (self._pauseRewind) self._time = Math.max(0, self._time - self._pauseRewind);
      self._events.onStateChange({ data: 2, target: self });
    },
    mute() { self._muted = true; },
    unMute() { self._muted = false; },
    isMuted() { return self._muted; },
    setVolume() {},
    getVolume() { return 100; },
    setPlaybackRate() {},
    getPlaybackRate() { return 1; },
    getVideoLoadedFraction() { return 1; },
    getAvailableQualityLevels() { return []; },
    getVideoData() { return { video_id: 'stubvid0001' }; },
    addEventListener() {},
    destroy() {},
  };
  window.__yt = self;
  setTimeout(() => options.events.onReady({ target: self }), 0);
  return self;
};
if (typeof window.onYouTubeIframeAPIReady === 'function') window.onYouTubeIframeAPIReady();
`;

let files = {};

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  await Promise.all(FILES.map(async (path) => {
    const response = await fetch(LIVE + encodeURIComponent(path));
    if (!response.ok) throw new Error(`live fetch ${path} -> ${response.status}`);
    files[path] = await response.text();
  }));
});

async function installLiveRoutes(page) {
  await page.route('https://www.youtube.com/**', (route) => route.abort());
  await page.route('https://www.youtube.com/iframe_api*', (route) => {
    route.fulfill({ status: 200, contentType: 'text/javascript', body: YT_STUB });
  });
  await page.route(/cdn\.jsdelivr\.net/, (route) => route.abort());
  await page.route('https://www.sefaria.org/**', (route) => route.abort());
  await page.route('**/api/sefaria**', (route) => route.fulfill({ status: 404, body: '{}' }));
  await page.route('**/api/daf-page**', (route) => {
    route.fulfill({ status: 200, contentType: 'application/pdf', body: '%PDF-fake' });
  });
  await page.route('**/api/get-results-file**', (route) => {
    const path = new URL(route.request().url()).searchParams.get('path') || '';
    const body = files[path];
    if (!body) return route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
    return route.fulfill({ status: 200, contentType: 'application/json', body });
  });
}

async function openLive(page, url) {
  await preparePage(page, { user: null });
  await installLiveRoutes(page);
  await page.goto(url);
  await page.waitForFunction(() => state.segments.length > 20 && window.__yt, null, { timeout: 20000 });
  await page.waitForTimeout(250);
}

// On a phone the viewing modes and the Split tools are in the divider's
// drop-down (see 'the phone Split drop-down holds the viewing modes...').
async function openSplitTools(page) {
  if (!(await page.evaluate(() => document.body.classList.contains('split-tools-phone')))) return;
  await page.evaluate(() => setSplitToolsOpen(true));
  await expect(page.locator('#splitToolsPanel')).toBeVisible();
}

async function shot(page, name) {
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false });
}

function boxesOverlap(a, b) {
  if (!a || !b) return false;
  const gap = 1;
  return a.x < b.x + b.width - gap && a.x + a.width - gap > b.x
    && a.y < b.y + b.height - gap && a.y + a.height - gap > b.y;
}

test.describe('mobile player layout', () => {
  // As on YouTube's phone player: one tap on the picture shows the controls,
  // the next puts them away, and neither plays or pauses. Split used to put
  // them straight back: the imitation mouse events a browser fires after a
  // tap counted as a real mouse arriving.
  test('a tap on the picture shows the controls and the next tap hides them, in every layout', async ({ page }) => {
    test.skip(test.info().project.name !== 'mobile', 'touch');
    test.setTimeout(60000);
    await page.setViewportSize({ width: 412, height: 915 });
    await openLive(page, '/player/?ref=Bekhorot+30a&variant=chazarah');
    const hidden = () => page.evaluate(() => document.getElementById('videoFrame').classList.contains('controls-hidden'));
    const tapPicture = async () => {
      const box = await page.locator('#videoFrame').boundingBox();
      await page.touchscreen.tap(box.x + box.width * 0.25, box.y + box.height * 0.35);
      await page.waitForTimeout(500);
    };
    await page.evaluate(() => { window.__yt._state = 1; state.youtubeReady = true; updatePlayUi(); });
    for (const layout of ['regular', 'split', 'split fullscreen']) {
      if (layout === 'split') await page.click('#viewerModeSplitButton');
      if (layout === 'split fullscreen') {
        await page.evaluate(() => document.getElementById('splitFullscreenButton').click());
        await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
      }
      await page.waitForTimeout(300);
      await page.evaluate(() => document.getElementById('videoFrame').classList.add('controls-hidden'));
      await tapPicture();
      expect(await hidden(), `${layout}: first tap shows`).toBe(false);
      await tapPicture();
      expect(await hidden(), `${layout}: second tap hides`).toBe(true);
      await tapPicture();
      expect(await hidden(), `${layout}: third tap shows again`).toBe(false);
      expect(await page.evaluate(() => window.__yt._state), `${layout}: still playing`).toBe(1);
    }
  });

  // The flash on the regular page: a tap that wakes the controls can end
  // with its click on the picture surface underneath. That click is not a
  // tap of its own and must not put the controls straight back away.
  test('the click that ends a waking tap does not hide the controls it just showed', async ({ page }) => {
    test.skip(test.info().project.name !== 'mobile', 'touch');
    test.setTimeout(60000);
    await page.setViewportSize({ width: 412, height: 915 });
    await openLive(page, '/player/?ref=Bekhorot+30a&variant=chazarah');
    await page.evaluate(() => { window.__yt._state = 1; state.youtubeReady = true; updatePlayUi(); });
    // An earlier finger tap on the surface itself.
    await page.evaluate(() => {
      const surface = document.querySelector('.video-click-surface');
      surface.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true }));
      surface.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await page.evaluate(() => document.getElementById('videoFrame').classList.add('controls-hidden'));
    const result = await page.evaluate(async () => {
      const frame = document.getElementById('videoFrame');
      const wake = document.querySelector('.player-wake-layer');
      const surface = document.querySelector('.video-click-surface');
      const r = wake.getBoundingClientRect();
      const x = r.left + r.width * 0.25;
      const y = r.top + r.height * 0.35;
      wake.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 3, pointerType: 'touch', clientX: x, clientY: y, bubbles: true }));
      wake.dispatchEvent(new PointerEvent('pointerup', { pointerId: 3, pointerType: 'touch', clientX: x, clientY: y, bubbles: true }));
      // The browser's click for that tap, landing on the surface below.
      surface.dispatchEvent(new MouseEvent('click', { clientX: x, clientY: y, bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 300));
      return frame.classList.contains('controls-hidden');
    });
    expect(result).toBe(false);
  });

  // On a phone the viewing modes and the Split tools fold into the divider's
  // drop-down, with a daf row under them: amud arrows, Auto-scroll, Select
  // text. The daf title, Following, Video on daf and the zoom bar are gone.
  test('a sideways phone: the player fits the screen, its bars and controls on it', async ({ page }) => {
    test.skip(test.info().project.name !== 'mobile', 'touch');
    test.setTimeout(60000);
    await page.setViewportSize({ width: 915, height: 412 });
    await openLive(page, '/player/?ref=Bekhorot+30a&variant=chazarah');
    for (const mode of ['standard', 'daf-on-video']) {
      if (mode !== 'standard') await page.evaluate(() => setViewerMode('daf-on-video'));
      await page.locator('#videoFrame').evaluate((frame) => { frame.scrollIntoView({ block: 'start' }); frame.classList.remove('controls-hidden'); });
      const box = await page.evaluate(() => {
        const r = (id) => document.querySelector(id).getBoundingClientRect();
        return { frame: r('#videoFrame'), topbar: r('#playerTopbar'), controls: r('.player-controls'), overlay: r('#videoVilnaOverlay'), vh: innerHeight };
      });
      expect(box.frame.height, mode).toBeLessThanOrEqual(box.vh);
      // The bars are inside the player, which is no taller than the screen.
      expect(box.controls.bottom, mode).toBeLessThanOrEqual(box.frame.bottom + 1);
      expect(box.topbar.bottom, mode).toBeLessThanOrEqual(box.controls.top + 1);
      // The daf overlay is on the picture, not over the bars below it.
      expect(box.overlay.bottom, mode).toBeLessThanOrEqual(box.topbar.top + 1);
    }
  });

  test('Daf on video on a phone starts with a band of the current lines, nearly opaque', async ({ page }) => {
    test.setTimeout(60000);
    const phone = test.info().project.name === 'mobile';
    await openLive(page, '/player/?ref=Bekhorot+30a&variant=chazarah');
    await page.click('#viewerModeDafOnVideoButton');
    await expect.poll(() => page.evaluate(() => state.viewerMode)).toBe('daf-on-video');
    const overlay = await page.evaluate(() => ({ mode: state.videoOverlayMode, opacity: state.videoOverlayOpacity, select: document.getElementById('overlayModeSelect').value }));
    // A computer keeps the whole page, half see-through.
    expect(overlay).toEqual(phone ? { mode: 'strip', opacity: 0.9, select: 'strip' } : { mode: 'full', opacity: 0.5, select: 'full' });
  });

  test('the phone Split drop-down is two rows, the Skip chip at the end of the daf row', async ({ page }) => {
    test.skip(test.info().project.name !== 'mobile', 'touch');
    test.setTimeout(90000);
    for (const width of [412, 360]) {
      await page.setViewportSize({ width, height: 860 });
      await openLive(page, '/player/?ref=Bekhorot+30a&variant=chazarah');
      await page.click('#viewerModeSplitButton');
      await expect.poll(() => page.evaluate(() => state.viewerMode)).toBe('split');
      await page.locator('#splitDivider').tap();
      const panel = page.locator('#splitToolsPanel');
      await expect(panel).toBeVisible();
      // At 0:00 the shiur is still in its lead-in: the chip offers the jump.
      const chip = panel.locator('#splitToolsDafRow #skipToDafChip');
      await expect(chip).toBeVisible();
      await expect(chip).toHaveAttribute('data-short', /^Skip to \d+:\d\d$/);
      await expect(chip).toHaveAttribute('aria-label', /^Skip to Bekhorot 30a \(/);
      const rows = await page.evaluate(() => {
        const visible = [...document.querySelectorAll('#splitToolsPanel .split-tools-scroll > *')]
          .filter((el) => el.getBoundingClientRect().height > 0);
        return {
          ids: visible.map((el) => el.id),
          lines: ['splitToolsModesRow', 'splitToolsDafRow'].map((id) => {
            const el = document.getElementById(id);
            return { h: el.getBoundingClientRect().height, overflow: el.scrollWidth - el.clientWidth };
          }),
        };
      });
      expect(rows.ids, `width ${width}`).toEqual(['splitToolsModesRow', 'splitToolsDafRow']);
      for (const line of rows.lines) {
        expect(line.h, `width ${width}`).toBeLessThanOrEqual(56);
        expect(line.overflow, `width ${width}`).toBeLessThanOrEqual(1);
      }
    }
  });

  test('Notes from the phone drop-down: Save is reachable on a short screen and saves', async ({ page }) => {
    test.skip(test.info().project.name !== 'mobile', 'touch');
    test.setTimeout(60000);
    await page.setViewportSize({ width: 412, height: 420 });
    const { USERS } = await import('../fixtures/dataset.mjs');
    await preparePage(page, { user: USERS.ordinary });
    await installLiveRoutes(page);
    await page.goto('/player/?ref=Bekhorot+30a&variant=chazarah');
    await page.waitForFunction(() => state.segments.length > 20 && window.__yt, null, { timeout: 20000 });
    await page.click('#viewerModeSplitButton');
    await expect.poll(() => page.evaluate(() => state.viewerMode)).toBe('split');
    await page.locator('#splitDivider').tap();
    await page.locator('#playerNotesButton').tap();
    await expect(page.locator('#noteCompose')).toBeVisible();
    await page.locator('#noteBodyInput').fill('Written on a short phone screen');
    const save = page.locator('#saveNoteButton');
    const box = await save.boundingBox();
    expect(box.y + box.height).toBeLessThanOrEqual(420);
    await save.tap();
    await expect(page.locator('#noteBodyInput')).toHaveValue('');
    await expect(page.locator('#noteDialog .note-list')).toContainText('Written on a short phone screen');
  });

  test('the daf picker in the phone drop-down opens over the daf and changes the amud', async ({ page }) => {
    test.skip(test.info().project.name !== 'mobile', 'touch');
    test.setTimeout(60000);
    await page.setViewportSize({ width: 412, height: 915 });
    await openLive(page, '/player/?ref=Bekhorot+30a&variant=chazarah');
    await page.click('#viewerModeSplitButton');
    await expect.poll(() => page.evaluate(() => state.viewerMode)).toBe('split');
    await page.locator('#splitDivider').tap();
    await page.locator('#playerDafButton').tap();
    const menu = page.locator('#playerDafMenu');
    await expect(menu).toBeVisible();
    // Below the button, on top of everything (not hidden behind the video).
    const placed = await page.evaluate(() => {
      const button = document.getElementById('playerDafButton').getBoundingClientRect();
      const select = document.getElementById('dafDafSelect').getBoundingClientRect();
      const hit = document.elementFromPoint(select.x + select.width / 2, select.y + select.height / 2);
      return { below: select.top > button.bottom, onTop: hit?.id === 'dafDafSelect' };
    });
    expect(placed).toEqual({ below: true, onTop: true });
    const asked = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).searchParams.get('path');
      if (path) asked.push(path);
    });
    await menu.locator('.amud-option', { hasText: 'b' }).first().tap();
    await expect.poll(() => asked.some((path) => path.includes('Bekhorot-30b'))).toBe(true);
  });

  test('the phone Split drop-down holds the viewing modes, the Split tools and the daf row', async ({ page }) => {
    test.skip(test.info().project.name !== 'mobile', 'touch');
    test.setTimeout(60000);
    await page.setViewportSize({ width: 412, height: 915 });
    await openLive(page, '/player/?ref=Bekhorot+30a&variant=chazarah');
    await page.click('#viewerModeSplitButton');
    await page.waitForTimeout(300);
    // Closed: nothing of the bar on the video.
    await expect(page.locator('#viewerModeSelect')).toBeHidden();
    expect(await page.evaluate(() => document.getElementById('splitToolsPanel').contains(document.getElementById('viewerModeSelect')))).toBe(true);
    await page.locator('#splitDivider').tap();
    const panel = page.locator('#splitToolsPanel');
    await expect(panel).toBeVisible();
    for (const id of ['viewerModeSplitButton', 'viewerModeDafOnVideoButton', 'viewerModeVideoOnDafButton', 'splitLayoutToggleButton', 'splitSwapButton', 'splitResetButton', 'splitFullscreenButton', 'splitExitButton']) {
      await expect(panel.locator(`#${id}`), id).toBeVisible();
    }
    const dafRow = panel.locator('#splitToolsDafRow');
    await expect(dafRow.locator('#splitAmudNextButton')).toBeVisible();
    await expect(dafRow.locator('#splitAmudPrevButton')).toBeVisible();
    await expect(dafRow.locator('#autoScroll')).toBeAttached();
    await expect(dafRow.getByText('Auto-scroll')).toBeVisible();
    await expect(dafRow.locator('#vilnaSelectTextModeButton')).toBeVisible();
    for (const id of ['readingModeButton', 'readingVideoFollowButton', 'dafTitle', 'vilnaZoomInButton', 'vilnaZoomResetButton']) {
      await expect(page.locator(`#${id}`), id).toBeHidden();
    }
    // Two rows, each within the screen's width.
    const rows = await page.evaluate(() => ['splitToolsModesRow', 'splitToolsDafRow'].map((id) => {
      const el = document.getElementById(id);
      const r = el.getBoundingClientRect();
      return { right: r.right, overflow: el.scrollWidth - el.clientWidth };
    }));
    for (const row of rows) {
      expect(row.right).toBeLessThanOrEqual(412 + 1);
      expect(row.overflow).toBeLessThanOrEqual(1);
    }
    // A mode button in the drop-down still works: it leaves Split.
    await panel.locator('#splitExitButton').click();
    await expect.poll(() => page.evaluate(() => state.viewerMode)).toBe('standard');
    // Out of Split the bar is back where it always was, over the player.
    await expect(page.locator('#viewerModeSelect')).toBeVisible();
    expect(await page.evaluate(() => document.getElementById('splitToolsPanel').contains(document.getElementById('viewerModeSelect')))).toBe(false);
  });

  test('the amud arrows turn the printed page on its own, into the next daf, and back to the shiur', async ({ page }) => {
    test.skip(test.info().project.name !== 'mobile', 'touch');
    test.setTimeout(60000);
    await page.setViewportSize({ width: 412, height: 915 });
    await openLive(page, '/player/?ref=Bekhorot+30a&variant=chazarah');
    await page.waitForFunction(() => Object.keys(syncState.talmudByName).length > 10, null, { timeout: 15000 });
    await page.click('#viewerModeSplitButton');
    await page.locator('#splitDivider').tap();
    const shown = () => page.evaluate(() => { const { parsed } = currentVilnaPageKey(); return parsed ? `${parsed.tractate} ${parsed.daf}${parsed.amud}` : null; });
    expect(await shown()).toBe('Bekhorot 30a');
    await page.locator('#splitAmudNextButton').click();
    expect(await shown()).toBe('Bekhorot 30b');
    await expect(page.locator('#splitAmudBackButton')).toBeVisible();
    await page.locator('#splitAmudNextButton').click();
    expect(await shown()).toBe('Bekhorot 31a');
    await page.locator('#splitAmudBackButton').click();
    expect(await shown()).toBe('Bekhorot 30a');
    await expect(page.locator('#splitAmudBackButton')).toBeHidden();
    await page.locator('#splitAmudPrevButton').click();
    expect(await shown()).toBe('Bekhorot 29b');
    // Turning back onto the shiur's own amud follows the shiur again.
    await page.locator('#splitAmudNextButton').click();
    expect(await page.evaluate(() => state.browsePageRef)).toBeNull();
    // The video never moved.
    expect(await page.evaluate(() => state.dafRef)).toContain('Bekhorot 30a');
  });

  test('the divider introduces its drop-down: a Daf tools handle, a bounce, a one-time tip', async ({ page }) => {
    test.skip(test.info().project.name !== 'mobile', 'touch');
    test.setTimeout(60000);
    await page.setViewportSize({ width: 412, height: 915 });
    await preparePage(page, { user: null, menuHints: true });
    await installLiveRoutes(page);
    await page.goto('/player/?ref=Bekhorot+30a&variant=chazarah');
    await page.waitForFunction(() => state.segments.length > 20 && window.__yt, null, { timeout: 20000 });
    await page.click('#viewerModeSplitButton');
    const cue = page.locator('#splitDividerCue');
    await expect(cue).toBeVisible();
    await expect(cue).toContainText('Daf tools');
    await expect(cue).toHaveClass(/is-bouncing/);
    await expect(page.locator('.split-divider-tip')).toContainText('Tap it for the daf tools', { timeout: 3000 });
    await page.locator('#splitDivider').tap();
    await expect(page.locator('.split-divider-tip')).toHaveCount(0);
    await expect(cue.locator('.split-divider-cue-label')).toBeHidden();
    // Leaving and coming back: no tip, no words, just the handle.
    await page.locator('#splitExitButton').click();
    await expect.poll(() => page.evaluate(() => state.viewerMode)).toBe('standard');
    // The X swallows any tap for half a second after it closes Split (the
    // click the phone sends after the finger lifts), so wait past that.
    await page.waitForTimeout(800);
    await page.click('#viewerModeSplitButton');
    await expect.poll(() => page.evaluate(() => state.viewerMode)).toBe('split');
    await page.waitForTimeout(1200);
    await expect(page.locator('.split-divider-tip')).toHaveCount(0);
    await expect(cue).toBeVisible();
    await expect(cue.locator('.split-divider-cue-label')).toBeHidden();
  });

  test('phone control buttons stay compact and do not overlap', async ({ page }) => {
    test.skip(test.info().project.name !== 'mobile', 'measured on the touch viewport');
    test.setTimeout(60000);
    await page.setViewportSize({ width: 412, height: 915 });
    await openLive(page, '/player/?ref=Bekhorot+30a&variant=chazarah');
    await page.locator('#videoFrame').evaluate((frame) => frame.classList.remove('controls-hidden'));
    const ids = ['backButton', 'playButton', 'forwardButton', 'muteButton', 'fullscreenButton'];
    const boxes = {};
    for (const id of ids) {
      const box = await page.locator(`#${id}`).boundingBox();
      boxes[id] = box;
      expect(box, id).toBeTruthy();
      expect(box.height, id).toBeGreaterThanOrEqual(32);
      expect(box.height, id).toBeLessThanOrEqual(36);
      expect(box.width, id).toBeGreaterThanOrEqual(32);
      expect(box.width, id).toBeLessThanOrEqual(36);
    }
    const chrome = await page.evaluate(() => {
      const bar = getComputedStyle(document.querySelector('.player-controls'));
      const scrub = document.querySelector('.scrubber-wrap').getBoundingClientRect();
      const controls = document.querySelector('.player-controls').getBoundingClientRect();
      const mute = getComputedStyle(document.getElementById('muteButton'));
      return {
        barBg: bar.backgroundColor,
        bottom: Math.round(controls.bottom - scrub.top),
        muteBorder: mute.borderTopWidth,
        fade: Math.round(parseFloat(getComputedStyle(document.querySelector('.player-controls'), '::before').height) || 0),
      };
    });
    expect(chrome.barBg).toBe('rgba(0, 0, 0, 0)');
    expect(chrome.bottom).toBeLessThanOrEqual(64);
    expect(chrome.fade).toBeLessThanOrEqual(40);
    expect(chrome.muteBorder).toBe('0px');
    const youtube = await page.evaluate(() => {
      const host = document.getElementById('youtubePlayerHost');
      const frame = document.getElementById('videoFrame');
      return {
        pointer: getComputedStyle(host).pointerEvents,
        hidden: getComputedStyle(host).visibility,
        started: frame.classList.contains('yt-started'),
        hold: frame.classList.contains('yt-hold'),
        shield: getComputedStyle(document.getElementById('ytShield')).display,
        crop: parseFloat(getComputedStyle(document.getElementById('youtubePlayer')).top),
        branding: window.__playerVars?.modestbranding ?? window.__ytVars?.modestbranding,
      };
    });
    expect(youtube.pointer).toBe('none');
    expect(youtube.hidden).toBe('hidden');
    expect(youtube.started).toBe(false);
    expect(youtube.hold).toBe(true);
    expect(youtube.shield).toBe('block');
    // The embed used to be shifted up by 72px. On a short phone that crop
    // took the top of the picture with it. The picture now starts at the
    // top of its frame.
    expect(youtube.crop).toBeGreaterThanOrEqual(-1);
    expect(youtube.crop).toBeLessThan(2);
    const speedHome = await page.evaluate(() => {
      const speed = document.getElementById('speedSelect');
      return speed?.closest('#toolsMoreMenu') ? 'menu' : 'bar';
    });
    if (speedHome === 'bar') {
      const speed = await page.locator('#speedSelect').boundingBox();
      expect(speed.height).toBeGreaterThanOrEqual(30);
      expect(speed.height).toBeLessThanOrEqual(36);
      boxes.speed = speed;
    }
    const order = Object.keys(boxes);
    for (let i = 0; i < order.length; i += 1) {
      for (let j = i + 1; j < order.length; j += 1) {
        expect(boxesOverlap(boxes[order[i]], boxes[order[j]]), `${order[i]} overlaps ${order[j]}`).toBe(false);
      }
    }
    const frame = await page.locator('#videoFrame').boundingBox();
    for (const id of order) {
      const box = boxes[id];
      expect(box.x, id).toBeGreaterThanOrEqual(frame.x - 1);
      expect(box.x + box.width, id).toBeLessThanOrEqual(frame.x + frame.width + 1);
    }
    await shot(page, 'phone-controls');
    const more = page.locator('#toolsMoreButton');
    if (await more.isVisible()) await more.tap();
    await expect(page.locator('#toolsMoreMenu')).toBeVisible();
    await expect(page.locator('#captionsStack .pc-label')).toHaveText('Captions off');
    await shot(page, 'captions-off');
    await page.locator('#captionsButton').tap();
    await expect(page.locator('#captionsStack .pc-label')).toHaveText('Captions on');
    await expect(page.locator('#captionsButton')).toHaveAttribute('aria-pressed', 'true');
    await shot(page, 'captions-on');
  });

  test('the opening poster lifts within a second and a pause keeps the frame', async ({ page }) => {
    test.skip(test.info().project.name !== 'mobile', 'phone player');
    test.setTimeout(60000);
    await page.setViewportSize({ width: 412, height: 915 });
    await openLive(page, '/player/?ref=Bekhorot+30a&variant=chazarah');
    const before = await page.evaluate(() => ({
      hold: document.getElementById('videoFrame').classList.contains('yt-hold'),
      shield: getComputedStyle(document.getElementById('ytShield')).display,
    }));
    expect(before.hold).toBe(true);
    expect(before.shield).toBe('block');
    await shot(page, 'youtube-cover-before-play');
    // togglePlay() is the real Play path. Calling playVideo() on the stub
    // while a paused-frame blip is still armed is treated as that blip and
    // paused again before the cover can lift.
    await page.waitForFunction(() => state.youtubeReady);
    const warming = await page.evaluate(() => {
      togglePlay();
      return document.getElementById('videoFrame').classList.contains('yt-hold');
    });
    expect(warming).toBe(true);
    await expect.poll(() => page.evaluate(() => {
      const frame = document.getElementById('videoFrame');
      return !frame.classList.contains('yt-hold') && frame.classList.contains('yt-started');
    }), { timeout: 800 }).toBe(true);
    const playing = await page.evaluate(() => {
      const frame = document.getElementById('videoFrame');
      const badge = document.getElementById('videoSourceBadge');
      badge.hidden = false;
      badge.textContent = 'YouTube';
      const mask = frame.querySelector('.yt-chrome-mask');
      return {
        hold: frame.classList.contains('yt-hold'),
        started: frame.classList.contains('yt-started'),
        shield: getComputedStyle(document.getElementById('ytShield')).display,
        mask: mask ? getComputedStyle(mask).display : 'none',
        badge: getComputedStyle(badge).display,
      };
    });
    expect(playing.hold).toBe(false);
    expect(playing.started).toBe(true);
    expect(playing.shield).toBe('none');
    expect(playing.mask).toBe('none');
    expect(playing.badge).toBe('none');
    await page.evaluate(() => togglePlay());
    const paused = await page.evaluate(() => {
      const frame = document.getElementById('videoFrame');
      const layer = frame.querySelector('.yt-mask-layer');
      const edge = frame.querySelector('.yt-edge-top');
      const bottom = frame.querySelector('.yt-edge-bottom');
      const logo = frame.querySelector('.yt-edge-logo');
      const share = frame.querySelector('.yt-edge-share');
      const layerBox = layer ? layer.getBoundingClientRect() : { height: 0 };
      const edgeBox = edge ? edge.getBoundingClientRect() : { height: 0 };
      const bottomBox = bottom ? bottom.getBoundingClientRect() : { height: 0 };
      const logoCs = logo ? getComputedStyle(logo) : null;
      const shareCs = share ? getComputedStyle(share) : null;
      return {
        hold: frame.classList.contains('yt-hold'),
        started: frame.classList.contains('yt-started'),
        mask: frame.classList.contains('yt-mask'),
        corner: frame.classList.contains('yt-corner'),
        shield: getComputedStyle(document.getElementById('ytShield')).display,
        layer: layer ? getComputedStyle(layer).display : 'none',
        edgeH: edgeBox.height,
        bottomH: bottomBox.height,
        layerH: layerBox.height,
        play: document.getElementById('largePlay').hidden,
        logoDisplay: logoCs ? logoCs.display : 'missing',
        logoH: logo ? logo.getBoundingClientRect().height : 0,
        shareDisplay: shareCs ? shareCs.display : 'missing',
        shareH: share ? share.getBoundingClientRect().height : 0,
      };
    });
    expect(paused.hold).toBe(false);
    expect(paused.started).toBe(true);
    expect(paused.mask).toBe(true);
    expect(paused.shield).toBe('none');
    expect(paused.layer).toBe('block');
    expect(paused.layerH).toBeGreaterThan(120);
    // The title row is still covered. The caption lines are not: there is
    // no full-width bottom band.
    expect(paused.edgeH).toBeGreaterThanOrEqual(48);
    expect(paused.bottomH).toBe(0);
    expect(paused.edgeH).toBeLessThan(paused.layerH * 0.45);
    expect(paused.corner).toBe(true);
    expect(paused.logoDisplay).toBe('block');
    expect(paused.logoH).toBeGreaterThanOrEqual(50);
    expect(paused.logoH).toBeLessThanOrEqual(54);
    expect(paused.shareDisplay).toBe('block');
    expect(paused.shareH).toBeGreaterThanOrEqual(50);
    expect(paused.play).toBe(false);
    await shot(page, 'youtube-cover-paused');
    await page.click('#viewerModeSplitButton');
    await expect(page.locator('body')).toHaveClass(/split-view-active/);
    const splitCover = await page.evaluate(() => {
      const frame = document.getElementById('videoFrame');
      const layer = frame.querySelector('.yt-mask-layer');
      return {
        hold: frame.classList.contains('yt-hold'),
        mask: frame.classList.contains('yt-mask'),
        shield: getComputedStyle(document.getElementById('ytShield')).display,
        layer: layer ? getComputedStyle(layer).display : 'none',
        stage: getComputedStyle(document.getElementById('youtubeStage')).display,
      };
    });
    expect(splitCover.hold).toBe(false);
    expect(splitCover.mask).toBe(true);
    expect(splitCover.shield).toBe('none');
    expect(splitCover.layer).toBe('block');
    expect(splitCover.stage).toBe('block');
    await shot(page, 'youtube-cover-split-paused');
  });

  test('split close is a solid enabled button and leaves split view', async ({ page }) => {
    test.skip(test.info().project.name !== 'mobile', 'phone split');
    test.setTimeout(60000);
    await page.setViewportSize({ width: 412, height: 915 });
    await openLive(page, '/player/?ref=Bekhorot+30a&variant=chazarah');
    await page.click('#viewerModeSplitButton');
    await expect(page.locator('body')).toHaveClass(/split-view-active/);
    await page.evaluate(() => document.body.classList.remove('split-chrome-hidden'));
    await openSplitTools(page);
    const look = await page.evaluate(() => {
      const button = document.getElementById('splitExitButton');
      const style = getComputedStyle(button);
      const rect = button.getBoundingClientRect();
      return {
        opacity: style.opacity,
        color: style.color,
        bg: style.backgroundColor,
        disabled: button.disabled,
        pointer: style.pointerEvents,
        hidden: button.hidden,
        w: rect.width,
        h: rect.height,
      };
    });
    expect(look.hidden).toBe(false);
    expect(look.disabled).toBe(false);
    expect(look.opacity).toBe('1');
    expect(look.pointer).not.toBe('none');
    // In the light drop-down the close button is the one dark, solid chip.
    expect(look.bg).toBe('rgb(19, 34, 56)');
    expect(look.color).toBe('rgb(255, 255, 255)');
    expect(look.w).toBeGreaterThanOrEqual(40);
    expect(look.h).toBeGreaterThanOrEqual(40);
    await shot(page, 'split-exit-enabled');
    const box = await page.locator('#splitExitButton').boundingBox();
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await expect.poll(() => page.evaluate(() => state.viewerMode)).toBe('standard');
    await expect(page.locator('body')).not.toHaveClass(/split-view-active/);
  });

  // The player chrome hiding (split-chrome-hidden) must not make the close
  // button in the drop-down dead: the drop-down is not part of that chrome.
  test('a touch on the Split close button leaves split after the player chrome has hidden', async ({ page }) => {
    test.skip(test.info().project.name !== 'mobile', 'phone touch');
    test.setTimeout(60000);
    await page.setViewportSize({ width: 412, height: 915 });
    await openLive(page, '/player/?ref=Bekhorot+30a&variant=chazarah');
    await page.click('#viewerModeSplitButton');
    await expect(page.locator('body')).toHaveClass(/split-view-active/);
    await openSplitTools(page);
    const point = await page.evaluate(() => {
      document.body.classList.add('split-chrome-hidden');
      const button = document.getElementById('splitExitButton');
      const bar = document.getElementById('viewerModeSelect');
      const rect = button.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        w: rect.width,
        barPointer: getComputedStyle(bar).pointerEvents,
      };
    });
    expect(point.w).toBeGreaterThan(8);
    expect(point.barPointer).not.toBe('none');
    await page.touchscreen.tap(point.x, point.y);
    await expect.poll(() => page.evaluate(() => state.viewerMode)).toBe('standard');
    await expect(page.locator('body')).not.toHaveClass(/split-view-active/);
    expect(await page.evaluate(() => document.getElementById('authDialog').open)).toBe(false);
  });

  test('a touch on the Split close button does not open Sign in', async ({ page }) => {
    test.skip(test.info().project.name !== 'mobile', 'phone touch');
    test.setTimeout(60000);
    await page.setViewportSize({ width: 412, height: 915 });
    await openLive(page, '/player/?ref=Bekhorot+30a&variant=chazarah');
    await page.click('#viewerModeSplitButton');
    await expect(page.locator('body')).toHaveClass(/split-view-active/);
    await openSplitTools(page);
    const point = await page.evaluate(() => {
      const exit = document.getElementById('splitExitButton');
      const rect = exit.getBoundingClientRect();
      const signIn = document.getElementById('signInButton');
      signIn.style.position = 'fixed';
      signIn.style.left = `${rect.left}px`;
      signIn.style.top = `${rect.top}px`;
      signIn.style.width = `${Math.max(rect.width, 44)}px`;
      signIn.style.height = `${Math.max(rect.height, 44)}px`;
      signIn.style.zIndex = '1';
      signIn.style.margin = '0';
      signIn.style.pointerEvents = 'auto';
      window.__signInClicks = 0;
      signIn.addEventListener('click', () => { window.__signInClicks += 1; });
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await page.touchscreen.tap(point.x, point.y);
    await expect.poll(() => page.evaluate(() => state.viewerMode)).toBe('standard');
    await page.waitForTimeout(50);
    const after = await page.evaluate(() => ({
      clicks: window.__signInClicks,
      open: document.getElementById('authDialog').open,
    }));
    expect(after.clicks).toBe(0);
    expect(after.open).toBe(false);
  });

  test('a pause stays paused when YouTube reports playing again', async ({ page }) => {
    test.skip(test.info().project.name !== 'mobile', 'phone player');
    test.setTimeout(60000);
    await page.setViewportSize({ width: 412, height: 915 });
    await openLive(page, '/player/?ref=Bekhorot+30a&variant=chazarah');
    await page.waitForFunction(() => state.youtubeReady);
    await page.evaluate(() => togglePlay());
    await page.evaluate(() => togglePlay());
    const result = await page.evaluate(() => {
      const before = window.__yt._pauseCount || 0;
      state.wantPlaying = false;
      window.__yt._state = 1;
      window.__yt._events.onStateChange({ data: 1, target: window.__yt });
      const frame = document.getElementById('videoFrame');
      return {
        want: state.wantPlaying,
        pauses: (window.__yt._pauseCount || 0) - before,
        hold: frame.classList.contains('yt-hold'),
        mask: frame.classList.contains('yt-mask'),
        shield: getComputedStyle(document.getElementById('ytShield')).display,
        state: window.__yt.getPlayerState(),
      };
    });
    expect(result.want).toBe(false);
    expect(result.pauses).toBeGreaterThan(0);
    // Still covered: the opening poster if playback never revealed, otherwise
    // the edge mask. The thumbnail does not replace a frame that already showed.
    if (result.hold) expect(result.shield).toBe('block');
    else expect(result.mask).toBe(true);
    expect(result.state).toBe(2);
  });

  test('tapping the video does not scroll the page down to the daf', async ({ page }) => {
    test.skip(test.info().project.name !== 'mobile', 'portrait phone');
    test.setTimeout(60000);
    await page.setViewportSize({ width: 400, height: 985 });
    await openLive(page, '/player/?ref=Bekhorot+30a&variant=chazarah');
    const placed = await page.evaluate(() => {
      const card = document.getElementById('dafCard');
      card.setAttribute('data-daf-view', 'text');
      const sheet = document.getElementById('dafPage');
      sheet.hidden = false;
      const seg = document.querySelector('.daf-segment');
      seg.style.display = 'block';
      seg.style.marginTop = '2600px';
      state.activeIndex = Number(seg.dataset.index);
      document.getElementById('autoScroll').checked = true;
      state.lastManualScrollAt = 0;
      window.scrollTo(0, 0);
      scrollActiveIntoView(true);
      return {
        scrollY: window.scrollY,
        index: state.activeIndex,
      };
    });
    expect(placed.scrollY).toBeLessThan(5);

    const video = await page.locator('#videoFrame').boundingBox();
    const before = await page.evaluate(() => window.scrollY);
    await page.touchscreen.tap(video.x + video.width / 2, video.y + Math.min(80, video.height / 3));
    await page.waitForTimeout(200);
    const after = await page.evaluate(() => window.scrollY);
    expect(Math.abs(after - before)).toBeLessThan(5);
    await shot(page, 'phone-video-tap');
  });

  test('the split drop-down stays reachable after the page scrolls', async ({ page }) => {
    test.skip(test.info().project.name !== 'mobile', 'stacked phone split');
    test.setTimeout(60000);
    await page.setViewportSize({ width: 400, height: 985 });
    await openLive(page, '/player/?ref=Bekhorot+30a&variant=chazarah');
    await page.click('#viewerModeSplitButton');
    await expect(page.locator('body')).toHaveClass(/split-view-active/);
    await page.click('#splitDivider');
    await expect(page.locator('body')).toHaveClass(/split-tools-open/);
    await page.evaluate(() => {
      const scroll = document.getElementById('dafScroll');
      const stretch = document.createElement('div');
      stretch.style.height = '3200px';
      scroll.appendChild(stretch);
      const seg = document.querySelector('.daf-segment');
      if (seg) {
        document.getElementById('dafCard').setAttribute('data-daf-view', 'text');
        document.getElementById('dafPage').hidden = false;
      }
      scroll.scrollTop = 1800;
    });
    const geo = await page.evaluate(() => {
      const card = document.getElementById('dafCard').getBoundingClientRect();
      const header = document.getElementById('splitToolsModesRow').getBoundingClientRect();
      const back = document.getElementById('splitExitButton').getBoundingClientRect();
      const autoScroll = document.querySelector('#splitToolsDafRow .header-auto-scroll').getBoundingClientRect();
      const notes = document.getElementById('readerDafNotes')?.getBoundingClientRect();
      return {
        cardTop: card.top,
        cardBottom: card.bottom,
        headerTop: header.top,
        headerBottom: header.bottom,
        backTop: back.top,
        autoTop: autoScroll.top,
        notesTop: notes ? notes.top : null,
        scrollTop: document.getElementById('dafScroll').scrollTop,
      };
    });
    expect(geo.scrollTop).toBeGreaterThan(200);
    expect(geo.headerTop).toBeGreaterThanOrEqual(geo.cardTop - 2);
    // The phone tools panel (picker, then the header) sits above the page.
    // It stays pinned to the card; it does not scroll away with the daf.
    expect(geo.headerBottom).toBeLessThanOrEqual(geo.cardTop + 260);
    expect(geo.backTop).toBeGreaterThanOrEqual(geo.cardTop - 2);
    expect(geo.autoTop).toBeGreaterThanOrEqual(geo.cardTop - 2);
    expect(geo.autoTop).toBeLessThan(geo.cardBottom);
    if (geo.notesTop != null) {
      expect(geo.notesTop).toBeGreaterThanOrEqual(geo.headerTop);
      expect(geo.notesTop).toBeLessThan(geo.cardBottom);
    }
    await shot(page, 'phone-split-header');
  });

  test('short landscape hides the sidebar and gives the video more height', async ({ page }) => {
    test.skip(test.info().project.name !== 'mobile', 'landscape phone');
    test.setTimeout(60000);
    await page.setViewportSize({ width: 985, height: 400 });
    await openLive(page, '/player/?ref=Bekhorot+30a&variant=chazarah');
    const geo = await page.evaluate(() => {
      const sidebar = getComputedStyle(document.querySelector('.sidebar')).display;
      const top = document.querySelector('.topbar').getBoundingClientRect().height;
      const video = document.querySelector('#videoFrame').getBoundingClientRect();
      const buttons = [...document.querySelectorAll('.viewer-mode-button')].map((el) => el.getBoundingClientRect().top);
      const visible = Math.min(video.bottom, window.innerHeight) - Math.max(video.top, 0);
      return {
        sidebar,
        top,
        videoTop: video.top,
        videoH: video.height,
        buttonTops: buttons,
        visibleRatio: visible / window.innerHeight,
        crumb: getComputedStyle(document.querySelector('.breadcrumb')).display,
        actions: getComputedStyle(document.querySelector('.title-actions')).display,
        videoHeader: getComputedStyle(document.querySelector('.video-header')).display,
      };
    });
    expect(geo.sidebar).toBe('none');
    expect(geo.top).toBeLessThan(56);
    expect(geo.videoTop).toBeLessThan(160);
    expect(geo.visibleRatio).toBeGreaterThan(0.55);
    expect(geo.crumb).toBe('none');
    expect(geo.actions).toBe('none');
    expect(geo.videoHeader).toBe('none');
    expect(geo.videoH).toBeGreaterThan(140);
    expect(Math.max(...geo.buttonTops) - Math.min(...geo.buttonTops)).toBeLessThan(4);
    await shot(page, 'landscape-compact');
  });

  test('view-mode buttons stay on one row and the daf title is not truncated', async ({ page }) => {
    test.skip(test.info().project.name !== 'mobile', 'portrait phone');
    test.setTimeout(60000);
    await page.setViewportSize({ width: 400, height: 985 });
    await openLive(page, '/player/?ref=Bekhorot+30a&variant=chazarah');
    const row = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('#viewerModeSelect .viewer-mode-button')];
      const tops = buttons.map((el) => el.getBoundingClientRect().top);
      const title = document.getElementById('dafTitle');
      return {
        count: buttons.length,
        spread: Math.max(...tops) - Math.min(...tops),
        text: title.textContent,
        overflow: title.scrollWidth - title.clientWidth,
      };
    });
    expect(row.count).toBe(3);
    expect(row.spread).toBeLessThan(4);
    expect(row.text).toContain('Bekhorot 30a');
    expect(row.text).toContain('Chazarah');
    expect(row.overflow).toBeLessThan(2);
    await shot(page, 'phone-mode-row');
  });

  test('desktop keeps the sidebar and the full-size play control', async ({ page }) => {
    test.skip(test.info().project.name !== 'desktop', 'desktop geometry');
    test.setTimeout(60000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openLive(page, '/player/?ref=Bekhorot+30a&variant=chazarah');
    const geo = await page.evaluate(() => {
      const play = document.getElementById('playButton').getBoundingClientRect();
      const frame = document.getElementById('videoFrame').getBoundingClientRect();
      const picker = document.getElementById('playerTopbar').getBoundingClientRect();
      return {
        sidebar: getComputedStyle(document.querySelector('.sidebar')).display,
        top: document.querySelector('.topbar').getBoundingClientRect().height,
        playW: play.width,
        playH: play.height,
        pickerTop: picker.top - frame.top,
        tiny: document.getElementById('videoFrame').classList.contains('is-tiny'),
        compact: document.getElementById('videoFrame').classList.contains('is-compact'),
        snug: document.getElementById('videoFrame').classList.contains('is-snug'),
      };
    });
    expect(geo.sidebar).not.toBe('none');
    expect(geo.top).toBeGreaterThan(80);
    expect(geo.tiny).toBe(false);
    // At 1440px the sidebar and daf column leave the video frame in the
    // compact tier, whose desktop play control is 30px. Snug is 38, full is
    // 46. The phone control size must not replace any of those.
    const expected = geo.compact ? 30 : geo.snug ? 38 : 46;
    expect(Math.abs(geo.playW - expected)).toBeLessThan(2);
    expect(Math.abs(geo.playH - expected)).toBeLessThan(2);
    expect(geo.pickerTop).toBeLessThan(8);
    await shot(page, 'desktop-unchanged');
  });

  test('a paused Vaater stays paused when YouTube reports playing late', async ({ page }) => {
    test.setTimeout(60000);
    await openLive(page, '/player/?ref=Bekhorot+30a&variant=chazarah');
    const jumped = await page.evaluate(() => {
      const real = state.segments.findIndex((segment) => !segment.estimated && segment.end - segment.start > 1);
      const start = state.segments[real].start + 0.2;
      window.__yt._time = start;
      window.__yt._state = 2;
      window.__yt._delayPlay = 280;
      window.__yt._pauseRewind = 0;
      state.youtubeState = 2;
      state.wantPlaying = false;
      state.pendingSeek = null;
      updateActiveSegment(true, start);
      const target = nextReadingTime(start);
      document.getElementById('vaaterButton').click();
      return { target, label: document.getElementById('currentTime').textContent, expected: formatTime(target) };
    });
    expect(jumped.target).not.toBeNull();
    expect(jumped.label).toBe(jumped.expected);
    await page.waitForTimeout(500);
    const settled = await page.evaluate(() => ({
      state: window.__yt.getPlayerState(),
      wantPlaying: state.wantPlaying,
      time: getCurrentTime(),
      pauses: window.__yt._pauseCount,
      plays: window.__yt._playCount,
    }));
    expect(settled.plays).toBeGreaterThan(0);
    expect(settled.state).toBe(2);
    expect(settled.wantPlaying).toBe(false);
    expect(settled.pauses).toBeGreaterThan(0);
    expect(settled.time).toBeCloseTo(jumped.target, 0);
  });

  test('pausing does not leave the clock a second behind', async ({ page }) => {
    test.setTimeout(60000);
    await openLive(page, '/player/?ref=Bekhorot+30a&variant=chazarah');
    const result = await page.evaluate(() => {
      window.__yt._delayPlay = 0;
      window.__yt._time = 228;
      window.__yt._state = 1;
      window.__yt._pauseRewind = 1;
      state.youtubeState = 1;
      state.wantPlaying = true;
      state.pendingSeek = null;
      const before = formatTime(getCurrentTime());
      togglePlay();
      return {
        before,
        after: document.getElementById('currentTime').textContent,
        time: getCurrentTime(),
        state: window.__yt.getPlayerState(),
        wantPlaying: state.wantPlaying,
      };
    });
    expect(result.before).toBe('3:48');
    expect(result.after).toBe('3:48');
    expect(result.time).toBeGreaterThan(227.5);
    expect(result.state).toBe(2);
    expect(result.wantPlaying).toBe(false);
  });

  test('split fullscreen keeps both panes and the daf-page control', async ({ page }) => {
    test.skip(test.info().project.name !== 'mobile', 'phone split fullscreen');
    test.setTimeout(60000);
    await page.setViewportSize({ width: 400, height: 985 });
    await openLive(page, '/player/?ref=Bekhorot+30a&variant=chazarah');
    await page.click('#viewerModeSplitButton');
    await expect(page.locator('body')).toHaveClass(/split-view-active/);
    await openSplitTools(page);
    const button = await page.locator('#splitFullscreenButton').boundingBox();
    const hit = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      return el?.closest?.('#splitFullscreenButton')?.id || el?.id || '';
    }, { x: button.x + button.width / 2, y: button.y + button.height / 2 });
    expect(hit).toBe('splitFullscreenButton');
    const before = await page.evaluate(() => window.__yt.getPlayerState());
    await page.touchscreen.tap(button.x + button.width / 2, button.y + button.height / 2);
    await page.waitForTimeout(200);
    const after = await page.evaluate(() => ({
      state: window.__yt.getPlayerState(),
      fullscreen: document.fullscreenElement?.className || '',
      daf: Boolean(document.fullscreenElement?.querySelector('#dafCard')),
      video: Boolean(document.fullscreenElement?.querySelector('#videoFrame')),
      back: Boolean(document.fullscreenElement?.contains(document.getElementById('splitExitButton'))),
    }));
    expect(after.state).toBe(before);
    test.skip(!after.fullscreen.includes('watch-layout'), `fullscreen unavailable (${after.fullscreen})`);
    expect(after.daf).toBe(true);
    expect(after.video).toBe(true);
    expect(after.back).toBe(true);
    await openSplitTools(page);
    const panes = await page.evaluate(() => {
      const video = document.querySelector('.watch-layout.split-active > .player-card').getBoundingClientRect();
      const daf = document.getElementById('dafCard').getBoundingClientRect();
      const back = document.getElementById('splitExitButton').getBoundingClientRect();
      return {
        stacked: document.body.classList.contains('split-layout-stacked'),
        videoH: video.height,
        dafH: daf.height,
        videoW: video.width,
        dafW: daf.width,
        backTop: back.top,
        backH: back.height,
      };
    });
    expect(panes.stacked).toBe(true);
    expect(panes.videoH).toBeGreaterThan(40);
    expect(panes.dafH).toBeGreaterThan(40);
    expect(panes.backH).toBeGreaterThan(20);
    expect(panes.backTop).toBeGreaterThanOrEqual(0);
    await shot(page, 'fullscreen-split-portrait');
    await page.evaluate(() => document.exitFullscreen());
  });

  test('split fullscreen enters on the first tap after the player chrome has hidden', async ({ page }) => {
    test.skip(test.info().project.name !== 'mobile', 'phone split fullscreen');
    test.setTimeout(60000);
    await page.setViewportSize({ width: 400, height: 985 });
    await openLive(page, '/player/?ref=Bekhorot+30a&variant=chazarah');
    await page.click('#viewerModeSplitButton');
    await expect(page.locator('body')).toHaveClass(/split-view-active/);
    await openSplitTools(page);
    const button = await page.locator('#splitFullscreenButton').boundingBox();
    await page.evaluate(() => document.body.classList.add('split-chrome-hidden'));
    const reachable = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      return el?.closest?.('#splitFullscreenButton')?.id || '';
    }, { x: button.x + button.width / 2, y: button.y + button.height / 2 });
    expect(reachable).toBe('splitFullscreenButton');
    await page.touchscreen.tap(button.x + button.width / 2, button.y + button.height / 2);
    await page.waitForTimeout(300);
    const opened = await page.evaluate(() => document.fullscreenElement?.className || '');
    test.skip(!opened.includes('watch-layout'), `fullscreen unavailable (${opened})`);
    expect(opened).toContain('split-active');
    await page.evaluate(() => document.exitFullscreen());
  });

  test('split fullscreen in landscape stays side by side', async ({ page }) => {
    test.skip(test.info().project.name !== 'mobile', 'landscape phone');
    test.setTimeout(60000);
    await page.setViewportSize({ width: 985, height: 400 });
    await openLive(page, '/player/?ref=Bekhorot+30a&variant=chazarah');
    await page.click('#viewerModeSplitButton');
    await page.click('#fullscreenButton');
    const opened = await page.evaluate(() => document.fullscreenElement?.className || '');
    test.skip(!String(opened).includes('watch-layout'), `fullscreen unavailable (${opened})`);
    const geo = await page.evaluate(() => {
      const video = document.querySelector('.watch-layout.split-active > .player-card').getBoundingClientRect();
      const daf = document.getElementById('dafCard').getBoundingClientRect();
      return {
        stacked: document.body.classList.contains('split-layout-stacked'),
        videoRight: video.right,
        dafLeft: daf.left,
        videoW: video.width,
        dafW: daf.width,
      };
    });
    expect(geo.stacked).toBe(false);
    expect(geo.videoW).toBeGreaterThan(80);
    expect(geo.dafW).toBeGreaterThan(80);
    expect(geo.dafLeft).toBeGreaterThan(geo.videoRight - 30);
    // The picker and the viewing modes sit in the divider panel, not on the video.
    await page.click('#splitDivider');
    await expect(page.locator('body')).toHaveClass(/split-tools-open/);
    const panel = await page.evaluate(() => {
      const back = document.getElementById('splitExitButton').getBoundingClientRect();
      const topbar = document.getElementById('playerTopbar');
      const frame = document.getElementById('videoFrame');
      const tools = document.getElementById('splitToolsPanel');
      const card = document.getElementById('dafCard');
      return {
        backW: back.width,
        overVideo: frame.contains(topbar),
        inCard: card.contains(tools) && tools.contains(topbar),
      };
    });
    expect(panel.backW).toBeGreaterThan(20);
    expect(panel.overVideo).toBe(false);
    expect(panel.inCard).toBe(true);
    await shot(page, 'fullscreen-split-landscape');
    await page.evaluate(() => document.exitFullscreen());
  });

  test('daf-only fullscreen keeps a visible header and exit', async ({ page }) => {
    test.skip(test.info().project.name !== 'mobile', 'portrait phone');
    test.setTimeout(60000);
    await page.setViewportSize({ width: 400, height: 985 });
    await openLive(page, '/player/?ref=Bekhorot+30a&variant=chazarah');
    await page.click('#vilnaFullscreenButton');
    const opened = await page.evaluate(() => document.fullscreenElement?.id || '');
    test.skip(opened !== 'dafCard', `fullscreen unavailable (${opened})`);
    const geo = await page.evaluate(() => {
      const card = document.getElementById('dafCard').getBoundingClientRect();
      const header = document.querySelector('#dafCard .daf-header').getBoundingClientRect();
      const exit = document.getElementById('dafFullscreenExit').getBoundingClientRect();
      const bg = getComputedStyle(document.getElementById('dafCard')).backgroundColor;
      return {
        cardTop: card.top,
        cardH: card.height,
        headerTop: header.top,
        headerH: header.height,
        exitW: exit.width,
        exitH: exit.height,
        exitTop: exit.top,
        bg,
      };
    });
    expect(geo.headerTop).toBeGreaterThanOrEqual(-1);
    expect(geo.headerTop).toBeLessThan(80);
    expect(geo.headerH).toBeGreaterThan(24);
    expect(geo.exitW).toBeGreaterThan(40);
    expect(geo.exitH).toBeGreaterThanOrEqual(40);
    expect(geo.exitTop).toBeLessThan(geo.headerTop + geo.headerH);
    expect(geo.bg).not.toBe('rgba(0, 0, 0, 0)');
    expect(geo.cardH).toBeGreaterThan(400);
    await shot(page, 'fullscreen-daf-only');
    await page.locator('#dafFullscreenExit').click();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeFalsy();
  });

  test('the first tap on Auto-scroll toggles it while split chrome is hidden', async ({ page }) => {
    test.skip(test.info().project.name !== 'mobile', 'touch');
    test.setTimeout(60000);
    await page.setViewportSize({ width: 400, height: 985 });
    await openLive(page, '/player/?ref=Bekhorot+30a&variant=chazarah');
    await page.click('#viewerModeSplitButton');
    await page.click('#splitDivider');
    await expect(page.locator('body')).toHaveClass(/split-tools-open/);
    await page.evaluate(() => document.body.classList.add('split-chrome-hidden'));
    await page.waitForTimeout(350);
    const before = await page.evaluate(() => document.getElementById('autoScroll').checked);
    const box = await page.locator('.header-auto-scroll').boundingBox();
    await page.touchscreen.tap(box.x + 12, box.y + box.height / 2);
    const after = await page.evaluate(() => document.getElementById('autoScroll').checked);
    expect(after).toBe(!before);
    await shot(page, 'autoscroll-first-tap');
  });

  test('a hidden control bar activates the speed button on the first touch', async ({ page }) => {
    test.skip(test.info().project.name !== 'mobile', 'touch');
    test.setTimeout(60000);
    await page.setViewportSize({ width: 400, height: 985 });
    await openLive(page, '/player/?ref=Bekhorot+30a&variant=chazarah');
    await page.evaluate(() => document.getElementById('videoFrame').classList.add('controls-hidden'));
    await page.waitForTimeout(300);
    const where = await page.evaluate(() => {
      const speed = document.getElementById('speedSelect');
      const target = speed.closest('#toolsMoreMenu') ? document.getElementById('muteButton') : speed;
      const r = target.getBoundingClientRect();
      return { id: target.id, x: r.left + r.width / 2, y: r.top + r.height / 2, muted: state.muted };
    });
    await page.waitForTimeout(350);
    await page.touchscreen.tap(where.x, where.y);
    if (where.id === 'speedSelect') {
      await expect.poll(() => page.locator('#speedSelect').getAttribute('aria-expanded')).toBe('true');
    } else {
      await expect.poll(() => page.evaluate(() => state.muted)).toBe(!where.muted);
    }
    expect(await page.evaluate(() => document.getElementById('videoFrame').classList.contains('controls-hidden'))).toBe(false);
    await shot(page, 'speed-first-tap');
  });

  test('leaving video fullscreen restores the scroll position', async ({ page }) => {
    test.skip(test.info().project.name !== 'mobile', 'portrait phone');
    test.setTimeout(60000);
    await page.setViewportSize({ width: 400, height: 985 });
    await openLive(page, '/player/?ref=Bekhorot+30a&variant=chazarah');
    await page.evaluate(() => {
      const tall = document.createElement('div');
      tall.id = 'scrollSpacer';
      tall.style.height = '4000px';
      document.body.appendChild(tall);
      window.scrollTo(0, 160);
    });
    await page.click('#fullscreenButton');
    const opened = await page.evaluate(() => document.fullscreenElement?.id || '');
    test.skip(opened !== 'videoFrame', `fullscreen unavailable (${opened})`);
    const exit = page.locator('#videoFullscreenExit');
    await expect(exit).toBeVisible();
    const exitBox = await exit.boundingBox();
    expect(exitBox.height).toBeGreaterThanOrEqual(40);
    expect(exitBox.y).toBeLessThan(80);
    await page.evaluate(() => window.scrollTo(0, 2200));
    await exit.click();
    await page.waitForTimeout(400);
    const y = await page.evaluate(() => window.scrollY);
    expect(y).toBeGreaterThan(120);
    expect(y).toBeLessThan(220);
    await shot(page, 'fullscreen-scroll-restore');
  });

  test('a touch drag on the scrubber thumb seeks', async ({ page }) => {
    test.skip(test.info().project.name !== 'mobile', 'touch');
    test.setTimeout(60000);
    await page.setViewportSize({ width: 400, height: 985 });
    await openLive(page, '/player/?ref=Bekhorot+30a&variant=chazarah');
    await page.evaluate(() => {
      document.getElementById('videoFrame').classList.remove('controls-hidden');
      const scrubber = document.getElementById('scrubber');
      scrubber.max = '200';
      scrubber.value = '0';
      state.seeking = false;
    });
    const box = await page.locator('#scrubber').boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(24);
    expect(box.height).toBeLessThanOrEqual(36);
    const client = await page.context().newCDPSession(page);
    const y = box.y + box.height / 2;
    const startX = box.x + 8;
    const endX = box.x + box.width * 0.62;
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: startX, y }],
    });
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: endX, y }],
    });
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(250);
    const time = await page.evaluate(() => Number(document.getElementById('scrubber').value));
    expect(time).toBeGreaterThan(80);
    expect(time).toBeLessThan(160);
    await shot(page, 'scrubber-touch-drag');
  });

  test('reviewing 30b does not highlight the 31a page map', async ({ page }) => {
    test.setTimeout(60000);
    await openLive(page, '/player/?ref=Bekhorot+30a&variant=chazarah');
    const result = await page.evaluate(() => {
      state.vilnaPageMap = {
        tractate: 'Bekhorot',
        daf: 31,
        amud: 'a',
        wordBoxes: [
          { ref: 'Bekhorot 31a:1', x: 0.2, y: 0.2, w: 0.3, h: 0.02, wordIndex: 0 },
          { ref: 'Bekhorot 30b:1', x: 0.2, y: 0.4, w: 0.3, h: 0.02, wordIndex: 0 },
        ],
      };
      state.vilnaOverlayKey = '';
      state.dafRef = 'Bekhorot 31a';
      state.segments = [
        { ref: 'Bekhorot 30b:15', start: 11, end: 16, estimated: false, he: 'חבר', w0: 0, w1: 2 },
        { ref: 'Bekhorot 31a:1', start: 189, end: 200, estimated: false, he: 'תנו', w0: 0, w1: 2 },
      ];
      state.activeIndex = 0;
      document.getElementById('vilnaPlaceholder').hidden = false;
      updateReaderNotes(12, 0);
      updateVilnaOverlay();
      const mismatched = document.querySelectorAll('#vilnaActiveOverlay .vilna-active-rect').length;
      state.activeIndex = 1;
      state.vilnaOverlayKey = '';
      updateVilnaOverlay();
      const matched = document.querySelectorAll('#vilnaActiveOverlay .vilna-active-rect').length;
      return {
        label: document.getElementById('reviewingLabel').textContent,
        chip: document.getElementById('skipToDafChip').textContent,
        mismatched,
        matched,
      };
    });
    expect(result.label).toBe('Reviewing Bekhorot 30b');
    expect(result.chip).toContain('31a');
    expect(result.mismatched).toBe(0);
    expect(result.matched).toBeGreaterThan(0);
  });

  test('a tap on the split bar opens the controls and a drag keeps the video on screen', async ({ page }) => {
    test.skip(test.info().project.name !== 'mobile', 'portrait phone');
    test.setTimeout(60000);
    await page.setViewportSize({ width: 412, height: 915 });
    await openLive(page, '/player/?ref=Bekhorot+30a&variant=chazarah');
    await page.click('#viewerModeSplitButton');
    await expect(page.locator('body')).toHaveClass(/split-tools-phone/);
    const closed = await page.evaluate(() => {
      const frame = document.getElementById('videoFrame');
      const topbar = document.getElementById('playerTopbar');
      const header = document.querySelector('#dafCard .daf-header');
      const divider = document.getElementById('splitDivider').getBoundingClientRect();
      const card = document.getElementById('dafCard').getBoundingClientRect();
      const scroll = document.getElementById('dafScroll').getBoundingClientRect();
      return {
        open: document.body.classList.contains('split-tools-open'),
        inFrame: frame.contains(topbar),
        header: getComputedStyle(header).display,
        gap: card.top - divider.bottom,
        scrollGap: scroll.top - divider.bottom,
      };
    });
    expect(closed.open).toBe(false);
    expect(closed.inFrame).toBe(false);
    expect(closed.header).toBe('none');
    expect(Math.abs(closed.gap)).toBeLessThan(4);
    expect(Math.abs(closed.scrollGap)).toBeLessThan(8);
    await shot(page, 'phone-split-closed-flush');

    await page.click('#splitDivider');
    await expect(page.locator('body')).toHaveClass(/split-tools-open/);
    const opened = await page.evaluate(() => {
      const chip = document.getElementById('skipToDafChip');
      const chipBox = chip && !chip.hidden ? chip.getBoundingClientRect() : null;
      return {
        chipText: chip?.textContent || '',
        chipRight: chipBox ? chipBox.right : null,
        viewW: window.innerWidth,
      };
    });
    if (opened.chipRight != null) expect(opened.chipRight).toBeLessThanOrEqual(opened.viewW + 1);
    const zoom = await page.evaluate(() => {
      const bar = document.getElementById('vilnaZoomControls');
      const select = document.getElementById('vilnaSelectTextModeButton');
      const panel = document.getElementById('splitToolsPanel');
      const card = document.getElementById('dafCard');
      const scroll = document.getElementById('dafScroll');
      const notes = document.getElementById('readerDafNotes');
      const chip = document.getElementById('skipToDafChip');
      const label = document.getElementById('reviewingLabel');
      if (label) {
        label.hidden = false;
        label.textContent = 'Reviewing Bekhorot 43b';
      }
      if (chip) {
        chip.hidden = false;
        chip.textContent = 'Skip to Bekhorot 44a (7:28)';
      }
      const fits = (el) => {
        if (!el || el.hidden) return false;
        const box = el.getBoundingClientRect();
        const pane = panel.getBoundingClientRect();
        return box.height > 8
          && box.width > 8
          && box.top >= pane.top - 1
          && box.bottom <= pane.bottom + 1
          && box.left >= pane.left - 1
          && box.right <= pane.right + 1;
      };
      const scroller = panel.querySelector('.split-tools-scroll');
      const auto = document.querySelector('#splitToolsPanel .header-auto-scroll');
      const dafPage = document.getElementById('splitExitButton');
      const cardBox = card.getBoundingClientRect();
      const scrollBox = scroll.getBoundingClientRect();
      const panelBox = panel.getBoundingClientRect();
      const layout = {
        panelPos: getComputedStyle(panel).position,
        zoomShown: getComputedStyle(bar).display !== 'none' && bar.getBoundingClientRect().height > 0,
        notesClip: notes ? notes.scrollHeight - notes.clientHeight : 0,
        panelH: panelBox.height,
        cardH: cardBox.height,
        scrollH: scrollBox.height,
        scrollTop: scrollBox.top,
        cardTop: cardBox.top,
        innerScroll: scroller ? scroller.scrollHeight - scroller.clientHeight : 0,
        panelScroll: panel.scrollHeight - panel.clientHeight,
      };
      return {
        ...layout,
        selectFits: fits(select),
        chipFits: fits(chip),
        labelFits: fits(label),
        autoFits: fits(auto),
        dafPageFits: fits(dafPage),
      };
    });
    expect(zoom.panelPos).toBe('absolute');
    // No zoom bar on a phone (pinch zooms the page); Select text is in the daf row.
    expect(zoom.zoomShown).toBe(false);
    expect(zoom.selectFits).toBe(true);
    expect(zoom.chipFits).toBe(true);
    expect(zoom.labelFits).toBe(true);
    expect(zoom.notesClip).toBeLessThanOrEqual(1);
    expect(zoom.autoFits).toBe(true);
    expect(zoom.dafPageFits).toBe(true);
    expect(zoom.innerScroll).toBeLessThanOrEqual(1);
    expect(zoom.panelScroll).toBeLessThanOrEqual(1);
    expect(zoom.panelH).toBeLessThanOrEqual(zoom.cardH * 0.6 + 2);
    expect(zoom.panelH).toBeLessThan(zoom.cardH * 0.75);
    // The toolbar and footer stay in the card. The page scroll still fills
    // the rest, instead of collapsing under an in-flow panel.
    expect(zoom.scrollH).toBeGreaterThan(zoom.cardH * 0.7);
    expect(Math.abs(zoom.scrollTop - zoom.cardTop)).toBeLessThan(8);
    const openBar = await page.evaluate(() => {
      const divider = document.getElementById('splitDivider').getBoundingClientRect();
      const card = document.getElementById('dafCard').getBoundingClientRect();
      const panel = document.getElementById('splitToolsPanel').getBoundingClientRect();
      const more = document.getElementById('playerMoreButton');
      const notes = document.getElementById('playerNotesButton');
      const hit = (el) => {
        if (!el || el.hidden) return null;
        const box = el.getBoundingClientRect();
        const x = box.left + Math.min(box.width / 2, 18);
        const y = box.top + box.height / 2;
        const top = document.elementFromPoint(x, y);
        return {
          h: box.height,
          inPanel: box.top >= panel.top - 1 && box.bottom <= panel.bottom + 1,
          hit: top === el || el.contains(top),
        };
      };
      return {
        gap: card.top - divider.bottom,
        panelGap: panel.top - card.top,
        more: hit(more),
        notes: hit(notes),
      };
    });
    expect(Math.abs(openBar.gap)).toBeLessThan(4);
    expect(Math.abs(openBar.panelGap)).toBeLessThan(2);
    expect(openBar.more?.h).toBeGreaterThan(8);
    expect(openBar.more?.inPanel).toBe(true);
    expect(openBar.more?.hit).toBe(true);
    if (openBar.notes) {
      expect(openBar.notes.h).toBeGreaterThan(8);
      expect(openBar.notes.inPanel).toBe(true);
      expect(openBar.notes.hit).toBe(true);
    }
    await shot(page, 'phone-split-open-flush');
    await page.click('#splitDivider');
    await expect(page.locator('body')).not.toHaveClass(/split-tools-open/);

    const divider = await page.locator('#splitDivider').boundingBox();
    const startX = divider.x + divider.width / 2;
    const startY = divider.y + divider.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX, Math.max(24, startY - 220), { steps: 10 });
    await page.mouse.up();
    const dragged = await page.evaluate(() => {
      const layout = document.querySelector('.watch-layout.split-active').getBoundingClientRect();
      const frame = document.getElementById('videoFrame').getBoundingClientRect();
      const frameEl = document.getElementById('videoFrame');
      frameEl.classList.add('youtube-active', 'controls-hidden');
      const hostEl = document.getElementById('youtubePlayerHost');
      hostEl.hidden = false;
      const host = hostEl.getBoundingClientRect();
      const embed = document.querySelector('#youtubePlayerHost iframe, #youtubePlayer');
      const shieldEl = document.getElementById('ytShield');
      const shield = shieldEl.getBoundingClientRect();
      const shieldCs = getComputedStyle(shieldEl);
      const fitted = Math.min(frame.height, frame.width * 9 / 16);
      return {
        open: document.body.classList.contains('split-tools-open'),
        layoutTop: layout.top,
        frameTop: frame.top,
        frameH: frame.height,
        frameW: frame.width,
        frameBottom: frame.bottom,
        layoutBottom: layout.bottom,
        hostTop: host.top,
        hostBottom: host.bottom,
        hostH: host.height,
        iframeTop: embed ? getComputedStyle(embed).top : '0px',
        shieldTop: shield.top,
        shieldH: shield.height,
        shieldW: shield.width,
        shieldBottom: shield.bottom,
        shieldLeft: shield.left,
        shieldRight: shield.right,
        frameLeft: frame.left,
        frameRight: frame.right,
        fitted,
        bgSize: shieldCs.backgroundSize,
        bgPos: shieldCs.backgroundPosition,
      };
    });
    expect(dragged.open).toBe(false);
    expect(dragged.frameTop).toBeGreaterThanOrEqual(dragged.layoutTop - 1);
    expect(dragged.frameH).toBeGreaterThanOrEqual(108);
    expect(dragged.frameBottom).toBeLessThanOrEqual(dragged.layoutBottom + 1);
    // The whole 16:9 picture, fitted inside the shortened pane: its top edge
    // stays on the pane's top edge (it shrinks, it does not slide off), and
    // nothing hangs past any edge.
    expect(Math.abs(dragged.hostTop - dragged.frameTop)).toBeLessThan(1.5);
    expect(dragged.hostBottom).toBeLessThanOrEqual(dragged.frameBottom + 1);
    expect(Math.abs(dragged.hostH - dragged.fitted)).toBeLessThan(1.5);
    expect(parseFloat(dragged.iframeTop)).toBeGreaterThanOrEqual(-1);
    // The poster uses the same box, scaled inside it.
    expect(dragged.bgSize).toBe('contain');
    expect(dragged.bgPos).toMatch(/0%|top/);
    expect(Math.abs(dragged.shieldTop - dragged.hostTop)).toBeLessThan(1.5);
    expect(Math.abs(dragged.shieldBottom - dragged.hostBottom)).toBeLessThan(1.5);
    expect(Math.abs(dragged.shieldW / dragged.shieldH - 16 / 9)).toBeLessThan(0.02);
    expect(dragged.shieldLeft).toBeGreaterThanOrEqual(dragged.frameLeft - 1);
    expect(dragged.shieldRight).toBeLessThanOrEqual(dragged.frameRight + 1);
    await shot(page, 'phone-split-tools');
  });

  test('landscape split keeps the video inside the screen when the bar is dragged', async ({ page }) => {
    test.skip(test.info().project.name !== 'mobile', 'landscape phone');
    test.setTimeout(60000);
    await page.setViewportSize({ width: 900, height: 400 });
    await openLive(page, '/player/?ref=Bekhorot+30a&variant=chazarah');
    await page.click('#viewerModeSplitButton');
    const divider = await page.locator('#splitDivider').boundingBox();
    const y = divider.y + divider.height / 2;
    await page.mouse.move(divider.x + 4, y);
    await page.mouse.down();
    await page.mouse.move(40, y, { steps: 8 });
    await page.mouse.up();
    const geo = await page.evaluate(() => {
      const layout = document.querySelector('.watch-layout.split-active').getBoundingClientRect();
      const frameEl = document.getElementById('videoFrame');
      const frame = frameEl.getBoundingClientRect();
      frameEl.classList.add('youtube-active', 'controls-hidden');
      const hostEl = document.getElementById('youtubePlayerHost');
      hostEl.hidden = false;
      const host = hostEl.getBoundingClientRect();
      const header = document.querySelector('#dafCard .daf-header');
      const topbar = document.getElementById('playerTopbar');
      return {
        stacked: document.body.classList.contains('split-layout-stacked'),
        tools: document.body.classList.contains('split-tools-phone'),
        open: document.body.classList.contains('split-tools-open'),
        inFrame: frameEl.contains(topbar),
        header: header ? getComputedStyle(header).display : 'none',
        layoutTop: layout.top,
        layoutLeft: layout.left,
        layoutRight: layout.right,
        layoutBottom: layout.bottom,
        frameTop: frame.top,
        frameLeft: frame.left,
        frameRight: frame.right,
        frameBottom: frame.bottom,
        frameW: frame.width,
        hostTop: host.top,
        hostBottom: host.bottom,
        hostLeft: host.left,
        hostRight: host.right,
        hostW: host.width,
      };
    });
    expect(geo.stacked).toBe(false);
    expect(geo.tools).toBe(true);
    expect(geo.open).toBe(false);
    expect(geo.inFrame).toBe(false);
    expect(geo.header).toBe('none');
    expect(geo.frameTop).toBeGreaterThanOrEqual(geo.layoutTop - 1);
    expect(geo.frameLeft).toBeGreaterThanOrEqual(geo.layoutLeft - 1);
    expect(geo.frameRight).toBeLessThanOrEqual(geo.layoutRight + 1);
    expect(geo.frameBottom).toBeLessThanOrEqual(geo.layoutBottom + 1);
    expect(geo.frameW).toBeGreaterThanOrEqual(100);
    // The narrowed pane is far taller than 16:9. The picture still runs from
    // the pane's top down to the controls, centered, its sides cut evenly.
    expect(Math.abs(geo.hostTop - geo.frameTop)).toBeLessThan(1.5);
    expect(geo.hostBottom).toBeLessThanOrEqual(geo.frameBottom + 1);
    expect(geo.hostLeft).toBeLessThan(geo.frameLeft);
    expect(geo.hostRight).toBeGreaterThan(geo.frameRight);
    expect(Math.abs((geo.frameLeft - geo.hostLeft) - (geo.hostRight - geo.frameRight))).toBeLessThan(1.5);
    expect(Math.abs(geo.hostW / (geo.hostBottom - geo.hostTop) - 16 / 9)).toBeLessThan(0.02);
  });

  test('a landscape page load opens Split side by side with the video on the left', async ({ page }) => {
    test.skip(test.info().project.name !== 'mobile', 'touch phone');
    test.setTimeout(60000);
    await page.setViewportSize({ width: 915, height: 412 });
    await openLive(page, '/player/?ref=Bekhorot+30a&variant=chazarah');
    await page.click('#viewerModeSplitButton');
    const geo = await page.evaluate(() => {
      const frame = document.getElementById('videoFrame').getBoundingClientRect();
      const daf = document.getElementById('dafCard').getBoundingClientRect();
      return {
        stacked: document.body.classList.contains('split-layout-stacked'),
        videoLeft: frame.right <= daf.left + 1,
      };
    });
    expect(geo.stacked).toBe(false);
    expect(geo.videoLeft).toBe(true);
  });

  // A phone held sideways: the side-by-side pane is about as tall as the
  // screen. The picture used to fit the pane's width and leave a tall empty
  // band below it; it now fills the pane's height, sides cut, under the
  // floating controls.
  test('landscape split fills the video pane top to bottom, with no empty band', async ({ page }) => {
    test.skip(test.info().project.name !== 'mobile', 'touch phone');
    test.setTimeout(60000);
    await page.setViewportSize({ width: 915, height: 412 });
    await openLive(page, '/player/?ref=Bekhorot+30a&variant=chazarah');
    await page.click('#viewerModeSplitButton');
    const read = () => page.evaluate(() => {
      const frameEl = document.getElementById('videoFrame');
      frameEl.classList.add('youtube-active');
      frameEl.classList.remove('controls-hidden');
      const hostEl = document.getElementById('youtubePlayerHost');
      hostEl.hidden = false;
      const box = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }; };
      const mask = document.querySelector('#videoFrame .yt-mask-layer');
      return {
        stacked: document.body.classList.contains('split-layout-stacked'),
        frame: box(frameEl),
        host: box(hostEl),
        mask: mask ? box(mask) : null,
        timeline: box(frameEl.querySelector('.scrubber-wrap')),
        controls: box(frameEl.querySelector('.player-controls')),
      };
    });
    const geo = await read();
    expect(geo.stacked).toBe(false);
    // Top on the pane's top, bottom on the pane's bottom: no gap.
    expect(Math.abs(geo.host.top - geo.frame.top)).toBeLessThan(1.5);
    expect(Math.abs(geo.host.bottom - geo.frame.bottom)).toBeLessThan(1.5);
    expect(geo.host.height).toBeGreaterThan(geo.frame.width * 9 / 16 + 20);
    // 16:9, centered, both sides cut by the same amount.
    expect(Math.abs(geo.host.width / geo.host.height - 16 / 9)).toBeLessThan(0.02);
    expect(Math.abs((geo.frame.left - geo.host.left) - (geo.host.right - geo.frame.right))).toBeLessThan(1.5);
    // The mask is the visible part: the pane's width, the picture's height.
    if (geo.mask && geo.mask.width > 0) {
      expect(Math.abs(geo.mask.left - geo.frame.left)).toBeLessThan(1.5);
      expect(Math.abs(geo.mask.width - geo.frame.width)).toBeLessThan(1.5);
      expect(Math.abs(geo.mask.bottom - geo.host.bottom)).toBeLessThan(1.5);
    }
    await shot(page, 'landscape-split-filled');

    // Divider dragged right: a wider pane cuts less. Past the picture's own
    // width the whole picture shows, centered, still full height.
    const divider = await page.locator('#splitDivider').boundingBox();
    const y = divider.y + divider.height / 2;
    await page.mouse.move(divider.x + 4, y);
    await page.mouse.down();
    await page.mouse.move(890, y, { steps: 8 });
    await page.mouse.up();
    const wide = await read();
    expect(wide.frame.width).toBeGreaterThan(geo.frame.width);
    expect(Math.abs(wide.host.bottom - wide.frame.bottom)).toBeLessThan(1.5);
    expect(Math.abs(wide.host.width / wide.host.height - 16 / 9)).toBeLessThan(0.02);
    const cutBefore = geo.host.width - geo.frame.width;
    const cutAfter = Math.max(0, wide.host.width - wide.frame.width);
    expect(cutAfter).toBeLessThan(cutBefore);
    await shot(page, 'landscape-split-filled-wide');
  });

  // Pinch goes all the way out to the whole frame and in to 5x, in both
  // layouts. Side by side the picture starts cut at the sides, so pinching
  // out is how the whole frame comes back; one finger can slide it across.
  test('split pinch zooms out to the whole frame and in to 5x, in both layouts', async ({ page }) => {
    test.skip(test.info().project.name !== 'mobile', 'touch phone');
    test.setTimeout(60000);
    await page.setViewportSize({ width: 915, height: 412 });
    await openLive(page, '/player/?ref=Bekhorot+30a&variant=chazarah');
    await page.click('#viewerModeSplitButton');
    const measure = () => page.evaluate(() => {
      const frameEl = document.getElementById('videoFrame');
      frameEl.classList.add('youtube-active');
      const host = document.getElementById('youtubePlayerHost');
      host.hidden = false;
      const f = frameEl.getBoundingClientRect();
      const h = host.getBoundingClientRect();
      return { zoom: state.splitVideoZoom, frameW: f.width, frameLeft: f.left, frameRight: f.right, hostW: h.width, hostLeft: h.left, hostRight: h.right, hostTop: h.top, hostBottom: h.bottom, frameTop: f.top, frameBottom: f.bottom };
    });
    await measure();
    // Side by side: starts side-cut, so pinching out goes below 1x and stops
    // exactly where the whole picture fits the pane's width.
    await page.evaluate(() => setSplitVideoZoom(0.05));
    await page.waitForTimeout(300); // the zoom eases in over 0.12s
    const out = await measure();
    expect(out.zoom).toBeLessThan(0.95);
    expect(Math.abs(out.hostW - out.frameW)).toBeLessThan(2);
    expect(out.hostLeft).toBeGreaterThanOrEqual(out.frameLeft - 1);
    expect(out.hostRight).toBeLessThanOrEqual(out.frameRight + 1);
    expect(await page.locator('#splitVideoFitButton').isVisible()).toBe(true);
    await page.evaluate(() => setSplitVideoZoom(50));
    expect((await measure()).zoom).toBe(5);
    // Back to the start; at 1x one finger can slide the cut picture across,
    // but never past its own edge.
    await page.evaluate(() => resetSplitVideoZoom({ announce: false }));
    await page.evaluate(() => setSplitVideoZoom(1, { panX: 5000, panY: 0, announce: false }));
    await page.waitForTimeout(300);
    const slid = await measure();
    expect(Math.abs(slid.hostLeft - slid.frameLeft)).toBeLessThan(1.5);
    await page.evaluate(() => resetSplitVideoZoom({ announce: false }));

    // Stacked (portrait): the default already shows the whole picture, so
    // it cannot go below 1x there; it still zooms in to 5x.
    await page.setViewportSize({ width: 412, height: 915 });
    await expect.poll(() => page.evaluate(() => document.body.classList.contains('split-layout-stacked'))).toBe(true);
    await page.evaluate(() => setSplitVideoZoom(0.05));
    expect((await measure()).zoom).toBeGreaterThan(0.97);
    await page.evaluate(() => setSplitVideoZoom(50));
    expect((await measure()).zoom).toBe(5);
  });

  test('side by side the controls float over a full-height picture', async ({ page }) => {
    test.skip(test.info().project.name !== 'mobile', 'touch phone');
    test.setTimeout(60000);
    await page.setViewportSize({ width: 915, height: 412 });
    await openLive(page, '/player/?ref=Bekhorot+30a&variant=chazarah');
    await page.click('#viewerModeSplitButton');
    const geo = await page.evaluate(() => {
      const frameEl = document.getElementById('videoFrame');
      frameEl.classList.add('youtube-active');
      frameEl.classList.remove('controls-hidden');
      const host = document.getElementById('youtubePlayerHost');
      host.hidden = false;
      const f = frameEl.getBoundingClientRect();
      const h = host.getBoundingClientRect();
      const bar = frameEl.querySelector('.player-controls');
      const b = bar.getBoundingClientRect();
      return { frameTop: f.top, frameBottom: f.bottom, hostTop: h.top, hostBottom: h.bottom, barTop: b.top, barBg: getComputedStyle(bar).backgroundColor };
    });
    expect(Math.abs(geo.hostTop - geo.frameTop)).toBeLessThan(1.5);
    expect(Math.abs(geo.hostBottom - geo.frameBottom)).toBeLessThan(1.5);
    expect(geo.barTop).toBeLessThan(geo.hostBottom);
    expect(geo.barBg).toBe('rgba(0, 0, 0, 0)');
    await shot(page, 'landscape-split-floating-controls');
  });

  test('each view mode shows its name under its icon, on one row', async ({ page }) => {
    test.setTimeout(60000);
    const phone = test.info().project.name === 'mobile';
    const sizes = phone ? [{ width: 360, height: 780 }, { width: 412, height: 915 }, { width: 915, height: 412 }] : [{ width: 1440, height: 900 }];
    await page.setViewportSize(sizes[0]);
    await openLive(page, '/player/?ref=Bekhorot+30a&variant=chazarah');
    const read = () => page.evaluate(() => {
      const bar = document.getElementById('viewerModeSelect');
      const buttons = [...bar.querySelectorAll('.viewer-mode-button')];
      return {
        overflow: bar.scrollWidth - bar.clientWidth,
        barRight: bar.getBoundingClientRect().right,
        viewW: window.innerWidth,
        rows: new Set(buttons.map((b) => Math.round(b.getBoundingClientRect().top))).size,
        items: buttons.map((b) => {
          const icon = b.querySelector('svg').getBoundingClientRect();
          const label = b.querySelector('span');
          const box = label.getBoundingClientRect();
          const cs = getComputedStyle(label);
          const own = b.getBoundingClientRect();
          return {
            text: label.textContent.trim(),
            under: box.top >= icon.bottom - 1,
            centered: Math.abs((box.left + box.right) / 2 - (icon.left + icon.right) / 2) < 3,
            visible: box.width > 10 && box.height > 6 && cs.clip === 'auto' && cs.visibility === 'visible',
            inside: box.left >= own.left - 0.5 && box.right <= own.right + 0.5 && box.bottom <= own.bottom + 0.5
              && label.scrollWidth <= label.clientWidth + 1,
            fontPx: parseFloat(cs.fontSize),
            tap: Math.min(own.width, own.height),
          };
        }),
      };
    });
    const expectLabels = (info, name) => {
      expect(info.items.map((i) => i.text), name).toEqual(['Split view', 'Daf on video', 'Video on daf']);
      for (const item of info.items) {
        expect(item.visible, `${name} ${item.text} visible`).toBe(true);
        expect(item.under, `${name} ${item.text} under its icon`).toBe(true);
        expect(item.centered, `${name} ${item.text} centered`).toBe(true);
        expect(item.inside, `${name} ${item.text} not clipped`).toBe(true);
        expect(item.fontPx, `${name} ${item.text} readable`).toBeGreaterThanOrEqual(10);
        expect(item.tap, `${name} ${item.text} tap target`).toBeGreaterThanOrEqual(40);
      }
      expect(info.rows, `${name} one row`).toBe(1);
      expect(info.overflow, `${name} no sideways scroll`).toBeLessThanOrEqual(1);
      expect(info.barRight, `${name} on screen`).toBeLessThanOrEqual(info.viewW + 1);
    };
    for (const size of sizes) {
      await page.setViewportSize(size);
      await page.waitForTimeout(200);
      if (await page.evaluate(() => state.viewerMode === 'split')) await page.evaluate(() => setViewerMode('standard'));
      await page.waitForTimeout(150);
      expectLabels(await read(), `standard ${size.width}x${size.height}`);
      await page.evaluate(() => setViewerMode('split'));
      await page.evaluate(() => showSplitChrome());
      await openSplitTools(page);
      await page.waitForTimeout(300);
      expectLabels(await read(), `split ${size.width}x${size.height}`);
      await shot(page, `mode-labels-${test.info().project.name}-${size.width}`);
      await page.evaluate(() => setViewerMode('standard'));
    }
  });

  test('the timeline seeks to the point pressed and steps by keyboard', async ({ page }) => {
    test.setTimeout(60000);
    const phone = test.info().project.name === 'mobile';
    await page.setViewportSize(phone ? { width: 412, height: 915 } : { width: 1280, height: 800 });
    await openLive(page, '/player/?ref=Bekhorot+30a&variant=chazarah');
    if (phone) await page.click('#viewerModeSplitButton');
    // This test is about the timeline, not auto-hide: keep the bar up so a
    // tap is never spent revealing it.
    await page.addStyleTag({ content: '.video-frame.controls-hidden .scrubber-wrap,.video-frame.controls-hidden .player-controls{opacity:1!important;visibility:visible!important;pointer-events:auto!important}' });
    await page.evaluate(() => showVideoControls());
    const scrubber = page.locator('#scrubber');
    await expect(scrubber).toBeVisible();
    const box = await scrubber.boundingBox();
    const dur = await page.evaluate(() => getDuration());
    const thumb = await scrubber.evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue('--scrub-thumb')));
    // What is painted (slider pseudo-elements have no computed style to read):
    // half played, then count red and grey pixels down three columns.
    await page.mouse.move(1, 1);
    await page.evaluate((t) => { seek(t, true); showVideoControls(); }, dur / 2);
    // The bar floats over the picture: measure it over a plain dark ground.
    const ground = await page.addStyleTag({ content: '.youtube-stage,.yt-shield,.yt-mask-layer,#video{visibility:hidden!important}.video-frame{background:#030914!important}' });
    await page.waitForTimeout(250);
    const { Jimp } = await import('jimp');
    const png = await Jimp.read(await scrubber.screenshot());
    await ground.evaluate((el) => el.remove());
    const scale = png.bitmap.width / box.width;
    const column = (fx) => {
      const x = Math.round(png.bitmap.width * fx);
      let red = 0;
      let grey = 0;
      for (let yy = 0; yy < png.bitmap.height; yy += 1) {
        const i = (yy * png.bitmap.width + x) * 4;
        const [r, g, b] = [png.bitmap.data[i], png.bitmap.data[i + 1], png.bitmap.data[i + 2]];
        if (r > 190 && g < 90 && b < 110) red += 1;
        else if (Math.abs(r - g) < 14 && Math.abs(g - b) < 14 && r > 60) grey += 1;
      }
      return { red: red / scale, grey: grey / scale };
    };
    const played = column(0.25);
    const atThumb = column(0.5);
    const remaining = column(0.8);
    // Thin red played track, round red thumb in the middle, muted rest, and
    // a hit box much taller than what is drawn.
    expect(played.red, 'played track is red and thin').toBeGreaterThan(1.5);
    expect(played.red, 'played track is red and thin').toBeLessThanOrEqual(4);
    expect(atThumb.red, 'round red thumb').toBeGreaterThanOrEqual(9);
    expect(remaining.red, 'remaining is not red').toBe(0);
    expect(remaining.grey, 'remaining is a muted track').toBeGreaterThan(1.5);
    expect(remaining.grey, 'remaining is a muted track').toBeLessThanOrEqual(4);
    expect(box.height).toBeGreaterThanOrEqual(phone ? 28 : 20);
    expect(await scrubber.evaluate((el) => getComputedStyle(el).touchAction)).toBe('none');
    const expectAt = (x) => Math.min(1, Math.max(0, (x - box.x - thumb / 2) / (box.width - thumb))) * dur;
    const tol = 2 * dur / (box.width - thumb); // two pixels
    const y = box.y + box.height / 2;
    const read = () => page.evaluate(() => Number(document.getElementById('scrubber').value));
    const tapAt = async (x, dy = 0) => {
      if (phone) {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y + dy }] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } else {
        await page.mouse.click(x, y + dy);
      }
      await page.waitForTimeout(250);
    };
    // A tap a few pixels off the painted 3px bar still lands.
    for (const f of [0.1, 0.5, 0.9]) {
      const x = box.x + box.width * f;
      await tapAt(x, phone ? -8 : -6);
      const got = await read();
      expect(Math.abs(got - expectAt(x)), `tap at ${f}: want ${expectAt(x).toFixed(1)} got ${got.toFixed(1)}`).toBeLessThanOrEqual(tol);
    }
    // A drag that wanders vertically still follows x, and ends where released.
    const from = box.x + box.width * 0.2;
    const to = box.x + box.width * 0.75;
    if (phone) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from, y }] });
      for (let i = 1; i <= 10; i += 1) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from + (to - from) * i / 10, y: y + (i % 2 ? 9 : -9) }] });
      }
      expect(await scrubber.evaluate((el) => el.classList.contains('is-scrubbing'))).toBe(true);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await page.mouse.move(from, y);
      await page.mouse.down();
      for (let i = 1; i <= 10; i += 1) await page.mouse.move(from + (to - from) * i / 10, y);
      expect(await scrubber.evaluate((el) => el.classList.contains('is-scrubbing'))).toBe(true);
      await page.mouse.up();
    }
    await page.waitForTimeout(250);
    expect(Math.abs((await read()) - expectAt(to))).toBeLessThanOrEqual(tol);
    expect(await scrubber.evaluate((el) => el.classList.contains('is-scrubbing'))).toBe(false);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    // The seek reached the player and the highlight followed it.
    const synced = await page.evaluate(() => ({ player: window.__yt.getCurrentTime(), value: Number(document.getElementById('scrubber').value), active: state.activeIndex }));
    expect(Math.abs(synced.player - synced.value)).toBeLessThan(1.5);
    // Keyboard: arrows step 5s, Home/End go to the ends, with a readable value.
    await scrubber.focus();
    const k0 = await read();
    await page.keyboard.press('ArrowRight');
    expect((await read()) - k0).toBeCloseTo(5, 0);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    expect((await read()) - k0).toBeCloseTo(-5, 0);
    await page.keyboard.press('Home');
    expect(await read()).toBe(0);
    await expect(scrubber).toHaveAttribute('aria-valuetext', /^0:00 of \d+:\d\d(:\d\d)?$/);
    await shot(page, `scrubber-${test.info().project.name}`);
  });
});
