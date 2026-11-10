import { test, expect } from '@playwright/test';
import { preparePage, failOnPageError, stubPrintedPage } from '../support/harness.mjs';

// Split View and the daf on a computer: the video is centred in its pane,
// clicking the divider opens a drop-down of daf tools (the zoom bar stays
// on the daf), and the daf's zoom bar has Fit width / Fit page, set sizes,
// left / centre / right, back to the top, and wheel zoom -- all remembered.

const VIDEO = 'Zsy7oDUP6Pw';
const FILES = {
  'by-ref/Bekhorot-2a.json': {
    schema: 'dafsync-alignment-v2', dafRef: 'Bekhorot 2a', duration: 3000, videoId: VIDEO,
    segments: [
      { ref: 'Bekhorot 2a:1', start: 100, end: 400, he: 'משנה ראשונה', w0: 0, w1: 1, estimated: false },
      { ref: 'Bekhorot 2a:2', start: 400, end: 900, he: 'משנה שניה', w0: 0, w1: 1, estimated: false },
    ],
  },
  'video-links/Bekhorot-2a.json': { type: 'youtube', videoId: VIDEO, url: `https://www.youtube.com/watch?v=${VIDEO}`, label: 'Bechoros 2' },
};
const YT_STUB = `
  window.YT = window.YT || {};
  window.YT.Player = function (id, options) {
    const self = {
      _time: 0,
      seekTo(time) { self._time = Number(time) || 0; },
      getCurrentTime() { return self._time; }, getDuration() { return 3000; },
      getPlayerState() { return 5; }, cueVideoById() {}, loadVideoById() {}, playVideo() {}, pauseVideo() {},
      mute() {}, unMute() {}, isMuted() { return false; }, setVolume() {}, getVolume() { return 100; },
      setPlaybackRate() {}, getPlaybackRate() { return 1; }, getVideoLoadedFraction() { return 1; },
      getAvailableQualityLevels() { return []; }, getVideoData() { return { video_id: '${VIDEO}' }; },
      getIframe() { return document.getElementById(id); }, addEventListener() {}, destroy() {},
    };
    window.__yt = self;
    setTimeout(() => options.events.onReady({ target: self }), 0);
    return self;
  };
  if (typeof window.onYouTubeIframeAPIReady === 'function') window.onYouTubeIframeAPIReady();
`;

async function openPlayer(page, { size = { width: 2560, height: 1080 } } = {}) {
  failOnPageError(page);
  await page.setViewportSize(size);
  await preparePage(page, { user: null });
  await stubPrintedPage(page);
  await page.route('**/api/get-results-file?*', (route) => {
    const path = new URL(route.request().url()).searchParams.get('path');
    if (path in FILES) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FILES[path]) });
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not found."}' });
  });
  await page.route('https://www.youtube.com/**', (route) => route.abort());
  await page.route('https://www.youtube.com/iframe_api*', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: YT_STUB }));
  await page.goto('/player/?ref=Bekhorot%202a');
  await page.waitForFunction(() => window.__yt && state.segments.length === 2, null, { timeout: 20000 });
}

// The printed page never draws in tests (pdf.js is stubbed), so give the
// page's box a real height for the zoom tests to work with.
async function givePageSize(page, height = 1100) {
  await page.evaluate((h) => { document.getElementById('vilnaPageWrap').style.height = `${h}px`; }, height);
}

async function openSplit(page) {
  await page.evaluate(() => setViewerMode('split'));
  await expect.poll(() => page.evaluate(() => document.body.classList.contains('split-tools-desk'))).toBe(true);
}

test.describe('Split View on a computer', () => {
  test.beforeEach(({}, info) => test.skip(info.project.name === 'mobile', 'mouse layout'));

  test('side by side on a wide screen, the video is centred top to bottom', async ({ page }) => {
    await openPlayer(page);
    await openSplit(page);
    const box = await page.evaluate(() => {
      const frame = document.getElementById('videoFrame').getBoundingClientRect();
      const picture = document.getElementById('youtubePlayerHost').getBoundingClientRect();
      return { above: picture.top - frame.top, below: frame.bottom - picture.bottom, height: picture.height };
    });
    expect(box.height).toBeGreaterThan(300);
    expect(box.above).toBeGreaterThan(100);
    expect(Math.abs(box.above - box.below)).toBeLessThanOrEqual(2);
  });

  test('clicking the divider opens the daf tools; dragging it does not', async ({ page }) => {
    await openPlayer(page);
    await openSplit(page);
    const divider = page.locator('#splitDivider');
    const box = await divider.boundingBox();
    // A drag resizes and leaves the drop-down shut.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 120, box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();
    await expect(page.locator('#splitToolsPanel')).toBeHidden();
    // A click (here on the round handle near the top) opens it.
    await page.locator('#splitDividerCue').click();
    const panel = page.locator('#splitToolsPanel');
    await expect(panel).toBeVisible();
    await expect(panel.locator('#splitAmudNextButton')).toBeVisible();
    await expect(panel.locator('#splitAmudPrevButton')).toBeVisible();
    await expect(panel.getByText('Auto-scroll')).toBeVisible();
    await expect(divider).toHaveAttribute('aria-expanded', 'true');
    // The viewing modes stay on the video, and the zoom bar on the daf.
    expect(await page.evaluate(() => document.getElementById('splitToolsPanel').contains(document.getElementById('viewerModeSelect')))).toBe(false);
    await expect(page.locator('#viewerModeSelect')).toBeVisible();
    expect(await page.evaluate(() => document.getElementById('splitToolsPanel').contains(document.getElementById('vilnaZoomControls')))).toBe(false);
    // The amud arrows work from here.
    await panel.locator('#splitAmudNextButton').click();
    await expect.poll(() => page.evaluate(() => state.browsePageRef || null)).not.toBeNull();
    // Escape shuts it, and the Auto-scroll switch goes home.
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    expect(await page.evaluate(() => document.getElementById('splitToolsPanel').contains(document.querySelector('.header-auto-scroll')))).toBe(false);
    // So does a click elsewhere.
    await page.locator('#splitDividerCue').click();
    await expect(panel).toBeVisible();
    await page.mouse.click(200, 200);
    await expect(panel).toBeHidden();
  });

  test('leaving Split closes the drop-down', async ({ page }) => {
    await openPlayer(page);
    await openSplit(page);
    await page.locator('#splitDividerCue').click();
    await expect(page.locator('#splitToolsPanel')).toBeVisible();
    await page.evaluate(() => setViewerMode('standard'));
    await expect(page.locator('#splitToolsPanel')).toBeHidden();
    await expect.poll(() => page.evaluate(() => document.body.classList.contains('split-tools-desk'))).toBe(false);
  });
});

test.describe('The daf zoom bar on a computer', () => {
  test.beforeEach(({}, info) => test.skip(info.project.name === 'mobile', 'mouse layout'));

  const zoom = (page) => page.evaluate(() => state.vilnaPageZoom);

  test('set sizes, Fit width, and up to 400%', async ({ page }) => {
    await openPlayer(page, { size: { width: 1440, height: 900 } });
    await givePageSize(page);
    await expect(page.locator('#vilnaZoomResetButton')).toHaveText('Fit width');
    await page.locator('#vilnaZoomSizeSelect').selectOption('1.5');
    await expect.poll(() => zoom(page)).toBe(1.5);
    await expect(page.locator('#vilnaZoomLabel')).toHaveText('150%');
    await page.locator('#vilnaZoomSizeSelect').selectOption('4');
    await expect.poll(() => zoom(page)).toBe(4);
    await page.locator('#vilnaZoomInButton').click();
    expect(await zoom(page)).toBe(4);
    await page.locator('#vilnaZoomResetButton').click();
    await expect.poll(() => zoom(page)).toBe(1);
  });

  test('the page sits left, in the centre or right, and the choice shows', async ({ page }) => {
    await openPlayer(page, { size: { width: 1440, height: 900 } });
    await givePageSize(page);
    await page.locator('#vilnaZoomSizeSelect').selectOption('0.5');
    const left = async () => page.evaluate(() => document.getElementById('vilnaPageWrap').getBoundingClientRect().left);
    await page.locator('[data-daf-align="left"]').click();
    const atLeft = await left();
    await page.locator('[data-daf-align="center"]').click();
    const atCentre = await left();
    await page.locator('[data-daf-align="right"]').click();
    const atRight = await left();
    expect(atCentre).toBeGreaterThan(atLeft + 50);
    expect(atRight).toBeGreaterThan(atCentre + 50);
    await expect(page.locator('[data-daf-align="right"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-daf-align="left"]')).toHaveAttribute('aria-pressed', 'false');
  });

  test('a page wider than the pane scrolls to its left edge, centre or right edge', async ({ page }) => {
    await openPlayer(page, { size: { width: 1440, height: 900 } });
    await givePageSize(page);
    await page.locator('#vilnaZoomSizeSelect').selectOption('2');
    const scroll = () => page.evaluate(() => { const s = document.getElementById('dafScroll'); return { left: s.scrollLeft, max: s.scrollWidth - s.clientWidth }; });
    await page.locator('[data-daf-align="left"]').click();
    expect((await scroll()).left).toBe(0);
    await page.locator('[data-daf-align="right"]').click();
    const right = await scroll();
    expect(right.max).toBeGreaterThan(100);
    expect(right.left).toBeGreaterThanOrEqual(right.max - 1);
    await page.locator('[data-daf-align="center"]').click();
    const centre = await scroll();
    expect(Math.abs(centre.left - centre.max / 2)).toBeLessThanOrEqual(2);
  });

  test('the mouse wheel zooms: with Ctrl on the page, or over the zoom bar', async ({ page }) => {
    await openPlayer(page, { size: { width: 1440, height: 900 } });
    await givePageSize(page);
    const bar = await page.locator('#vilnaZoomLabel').boundingBox();
    await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2);
    await page.mouse.wheel(0, -200);
    await expect.poll(() => zoom(page)).toBeGreaterThan(1.2);
    const afterBar = await zoom(page);
    await page.mouse.wheel(0, 200);
    await expect.poll(() => zoom(page)).toBeLessThan(afterBar);
    // On the page, the plain wheel scrolls; with Ctrl it zooms.
    await page.locator('#vilnaPageWrap').evaluate((el) => el.scrollIntoView({ block: 'center' }));
    // A point on the visible part of the page (the daf's header sits above it).
    const point = await page.evaluate(() => {
      const wrap = document.getElementById('vilnaPageWrap').getBoundingClientRect();
      const pane = document.getElementById('dafScroll').getBoundingClientRect();
      const top = Math.max(wrap.top, pane.top) + 120;
      return { x: wrap.left + wrap.width / 2, y: Math.min(top, pane.bottom - 20, innerHeight - 20) };
    });
    await page.mouse.move(point.x, point.y);
    const before = await zoom(page);
    await page.mouse.wheel(0, -100);
    expect(await zoom(page)).toBe(before);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -200);
    await page.keyboard.up('Control');
    await expect.poll(() => zoom(page)).toBeGreaterThan(before);
  });

  test('the zoom and position are remembered on the next visit', async ({ page }) => {
    await openPlayer(page, { size: { width: 1440, height: 900 } });
    await givePageSize(page);
    await page.locator('#vilnaZoomSizeSelect').selectOption('1.25');
    await page.locator('[data-daf-align="right"]').click();
    await page.reload();
    await page.waitForFunction(() => typeof state !== 'undefined' && state.segments.length === 2, null, { timeout: 20000 });
    expect(await zoom(page)).toBe(1.25);
    await expect(page.locator('#vilnaZoomLabel')).toHaveText('125%');
    await expect(page.locator('[data-daf-align="right"]')).toHaveAttribute('aria-pressed', 'true');
  });

  test('Fit page fits the whole page and is remembered as Fit page', async ({ page }) => {
    await openPlayer(page, { size: { width: 1440, height: 900 } });
    await givePageSize(page);
    await page.locator('#vilnaFitPageButton').click();
    await expect(page.locator('#vilnaFitPageButton')).toHaveAttribute('aria-pressed', 'true');
    const fit = await page.evaluate(() => {
      const scroller = document.getElementById('dafScroll');
      const wrap = document.getElementById('vilnaPageWrap');
      return { zoom: state.vilnaPageZoom, shown: wrap.getBoundingClientRect().height, room: scroller.clientHeight };
    });
    expect(fit.zoom).toBeLessThan(1);
    expect(fit.shown).toBeLessThanOrEqual(fit.room);
    expect(JSON.parse(await page.evaluate(() => localStorage.getItem('dafsync.dafView'))).fit).toBe('page');
    // Any other zoom ends Fit page.
    await page.locator('#vilnaZoomInButton').click();
    await expect(page.locator('#vilnaFitPageButton')).toHaveAttribute('aria-pressed', 'false');
  });
});
