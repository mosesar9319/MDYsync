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

const YT_STUB = `
window.YT = window.YT || {};
window.YT.Player = function (id, options) {
  const self = {
    _time: 0,
    _state: 5,
    _duration: 7200,
    _muted: false,
    _events: options.events,
    seekTo(time) { self._time = Number(time) || 0; },
    getCurrentTime() { return self._time; },
    getDuration() { return self._duration; },
    getPlayerState() { return self._state; },
    cueVideoById() { self._state = 5; },
    playVideo() {
      self._state = 1;
      self._playCount = (self._playCount || 0) + 1;
      const fire = () => self._events.onStateChange({ data: 1, target: self });
      if (self._delayPlay) setTimeout(fire, self._delayPlay);
      else fire();
    },
    pauseVideo() {
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
  test('phone control buttons are 44px and do not overlap', async ({ page }) => {
    test.skip(test.info().project.name !== 'mobile', 'measured on the touch viewport');
    test.setTimeout(60000);
    await page.setViewportSize({ width: 400, height: 985 });
    await openLive(page, '/player/?ref=Bekhorot+30a&variant=chazarah');
    await page.locator('#videoFrame').evaluate((frame) => frame.classList.remove('controls-hidden'));
    const ids = ['backButton', 'playButton', 'forwardButton', 'vaaterButton', 'muteButton', 'fullscreenButton'];
    const boxes = {};
    for (const id of ids) {
      const box = await page.locator(`#${id}`).boundingBox();
      boxes[id] = box;
      expect(box, id).toBeTruthy();
      expect(box.width, id).toBeGreaterThanOrEqual(44);
      expect(box.height, id).toBeGreaterThanOrEqual(44);
    }
    const speedHome = await page.evaluate(() => {
      const speed = document.getElementById('speedSelect');
      return speed?.closest('#toolsMoreMenu') ? 'menu' : 'bar';
    });
    if (speedHome === 'bar') {
      const speed = await page.locator('#speedSelect').boundingBox();
      expect(speed.height).toBeGreaterThanOrEqual(44);
      expect(speed.width).toBeGreaterThanOrEqual(44);
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

  test('split daf header stays reachable after the page scrolls', async ({ page }) => {
    test.skip(test.info().project.name !== 'mobile', 'stacked phone split');
    test.setTimeout(60000);
    await page.setViewportSize({ width: 400, height: 985 });
    await openLive(page, '/player/?ref=Bekhorot+30a&variant=chazarah');
    await page.click('#viewerModeSplitButton');
    await expect(page.locator('body')).toHaveClass(/split-view-active/);
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
      const header = document.querySelector('#dafCard .daf-header').getBoundingClientRect();
      const back = document.getElementById('splitBackToDaf').getBoundingClientRect();
      const autoScroll = document.getElementById('autoScroll').getBoundingClientRect();
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
    expect(geo.headerBottom).toBeLessThanOrEqual(geo.cardTop + 160);
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
      return {
        sidebar: getComputedStyle(document.querySelector('.sidebar')).display,
        top: document.querySelector('.topbar').getBoundingClientRect().height,
        playW: play.width,
        playH: play.height,
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
    // 46. The phone 44px target must not replace any of those.
    const expected = geo.compact ? 30 : geo.snug ? 38 : 46;
    expect(Math.abs(geo.playW - expected)).toBeLessThan(2);
    expect(Math.abs(geo.playH - expected)).toBeLessThan(2);
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
      back: document.getElementById('splitBackToDaf')?.hidden === false,
    }));
    expect(after.state).toBe(before);
    test.skip(!after.fullscreen.includes('watch-layout'), `fullscreen unavailable (${after.fullscreen})`);
    expect(after.daf).toBe(true);
    expect(after.video).toBe(true);
    expect(after.back).toBe(true);
    const panes = await page.evaluate(() => {
      const video = document.querySelector('.watch-layout.split-active > .player-card').getBoundingClientRect();
      const daf = document.getElementById('dafCard').getBoundingClientRect();
      const back = document.getElementById('splitBackToDaf').getBoundingClientRect();
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

  test('split overlay fullscreen enters on the first tap while the bar is hidden', async ({ page }) => {
    test.skip(test.info().project.name !== 'mobile', 'phone split fullscreen');
    test.setTimeout(60000);
    await page.setViewportSize({ width: 400, height: 985 });
    await openLive(page, '/player/?ref=Bekhorot+30a&variant=chazarah');
    await page.click('#viewerModeSplitButton');
    await expect(page.locator('body')).toHaveClass(/split-view-active/);
    const button = await page.locator('#splitFullscreenButton').boundingBox();
    await page.evaluate(() => document.body.classList.add('split-chrome-hidden'));
    const covered = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      return el?.closest?.('#splitFullscreenButton')?.id || '';
    }, { x: button.x + button.width / 2, y: button.y + button.height / 2 });
    expect(covered).toBe('');
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
      const back = document.getElementById('splitBackToDaf').getBoundingClientRect();
      return {
        stacked: document.body.classList.contains('split-layout-stacked'),
        videoRight: video.right,
        dafLeft: daf.left,
        videoW: video.width,
        dafW: daf.width,
        backW: back.width,
      };
    });
    expect(geo.stacked).toBe(false);
    expect(geo.videoW).toBeGreaterThan(80);
    expect(geo.dafW).toBeGreaterThan(80);
    expect(geo.backW).toBeGreaterThan(20);
    expect(geo.dafLeft).toBeGreaterThan(geo.videoRight - 30);
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
    expect(box.height).toBeGreaterThanOrEqual(40);
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
});
