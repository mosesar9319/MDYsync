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
      const layerBox = layer ? layer.getBoundingClientRect() : { height: 0 };
      const edgeBox = edge ? edge.getBoundingClientRect() : { height: 0 };
      const bottomBox = bottom ? bottom.getBoundingClientRect() : { height: 0 };
      return {
        hold: frame.classList.contains('yt-hold'),
        started: frame.classList.contains('yt-started'),
        mask: frame.classList.contains('yt-mask'),
        shield: getComputedStyle(document.getElementById('ytShield')).display,
        layer: layer ? getComputedStyle(layer).display : 'none',
        edgeH: edgeBox.height,
        bottomH: bottomBox.height,
        layerH: layerBox.height,
        play: document.getElementById('largePlay').hidden,
      };
    });
    expect(paused.hold).toBe(false);
    expect(paused.started).toBe(true);
    expect(paused.mask).toBe(true);
    expect(paused.shield).toBe('none');
    expect(paused.layer).toBe('block');
    expect(paused.layerH).toBeGreaterThan(120);
    // Solid bands: the title row, and the More videos shelf (about the
    // bottom third on a short picture). The middle of the frame stays open.
    expect(paused.edgeH).toBeGreaterThanOrEqual(48);
    expect(paused.bottomH).toBeGreaterThanOrEqual(72);
    expect(paused.edgeH).toBeLessThan(paused.layerH * 0.45);
    expect(paused.bottomH).toBeGreaterThan(paused.layerH * 0.28);
    expect(paused.edgeH + paused.bottomH).toBeLessThan(paused.layerH * 0.92);
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
    expect(look.bg).toBe('rgb(255, 255, 255)');
    expect(look.color).toBe('rgb(16, 32, 51)');
    expect(look.w).toBeGreaterThanOrEqual(40);
    expect(look.h).toBeGreaterThanOrEqual(40);
    await shot(page, 'split-exit-enabled');
    const box = await page.locator('#splitExitButton').boundingBox();
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await expect.poll(() => page.evaluate(() => state.viewerMode)).toBe('standard');
    await expect(page.locator('body')).not.toHaveClass(/split-view-active/);
  });

  test('a touch on the Split close button leaves split while the bar is hidden', async ({ page }) => {
    test.skip(test.info().project.name !== 'mobile', 'phone touch');
    test.setTimeout(60000);
    await page.setViewportSize({ width: 412, height: 915 });
    await openLive(page, '/player/?ref=Bekhorot+30a&variant=chazarah');
    await page.click('#viewerModeSplitButton');
    await expect(page.locator('body')).toHaveClass(/split-view-active/);
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
    expect(point.barPointer).toBe('none');
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

  test('split daf header stays reachable after the page scrolls', async ({ page }) => {
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
    await page.click('#splitDivider');
    await expect(page.locator('body')).toHaveClass(/split-tools-open/);
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
    expect(geo.dafLeft).toBeGreaterThan(geo.videoRight - 30);
    // The picker and the daf header sit in the divider panel, not on the video.
    await page.click('#splitDivider');
    await expect(page.locator('body')).toHaveClass(/split-tools-open/);
    const panel = await page.evaluate(() => {
      const back = document.getElementById('splitBackToDaf').getBoundingClientRect();
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
      const title = document.getElementById('dafTitle');
      const chip = document.getElementById('skipToDafChip');
      const titleBox = title.getBoundingClientRect();
      const chipBox = chip && !chip.hidden ? chip.getBoundingClientRect() : null;
      return {
        title: title.textContent,
        titleOverflow: title.scrollWidth - title.clientWidth,
        chipText: chip?.textContent || '',
        chipRight: chipBox ? chipBox.right : null,
        viewW: window.innerWidth,
      };
    });
    expect(opened.title).toContain('Bekhorot');
    expect(opened.titleOverflow).toBeLessThan(2);
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
      const dafPage = document.getElementById('splitBackToDaf');
      const cardBox = card.getBoundingClientRect();
      const scrollBox = scroll.getBoundingClientRect();
      const panelBox = panel.getBoundingClientRect();
      const layout = {
        position: getComputedStyle(bar).position,
        panelPos: getComputedStyle(panel).position,
        inPanel: panel.contains(bar),
        barH: bar.getBoundingClientRect().height,
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
    expect(zoom.position).toBe('relative');
    expect(zoom.panelPos).toBe('absolute');
    expect(zoom.inPanel).toBe(true);
    expect(zoom.barH).toBeGreaterThan(20);
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
      frameEl.classList.add('youtube-active');
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
    expect(dragged.hostTop).toBeGreaterThanOrEqual(dragged.frameTop - 1);
    expect(dragged.hostBottom).toBeLessThanOrEqual(dragged.frameBottom + 1);
    expect(parseFloat(dragged.iframeTop)).toBeGreaterThanOrEqual(-1);
    // The poster shares the top-locked 16:9 box. It scales; it does not crop upward.
    expect(dragged.bgSize).toBe('contain');
    expect(dragged.bgPos).toMatch(/0%|top/);
    expect(dragged.shieldTop).toBeGreaterThanOrEqual(dragged.frameTop - 1);
    expect(dragged.shieldTop).toBeLessThanOrEqual(dragged.frameTop + 2);
    expect(Math.abs(dragged.shieldH - dragged.fitted)).toBeLessThan(3);
    expect(dragged.shieldBottom).toBeLessThanOrEqual(dragged.frameBottom + 1);
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
      frameEl.classList.add('youtube-active');
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
    // The narrowed pane is taller than 16:9. The picture covers the pane and
    // hangs past the top and bottom so the title and the logo sit outside.
    // The frame itself stays on screen and clips that overflow.
    expect(geo.hostTop).toBeLessThan(geo.frameTop - 16);
    expect(geo.hostBottom).toBeGreaterThan(geo.frameBottom + 8);
    expect(geo.hostW).toBeGreaterThan(geo.frameW + 8);
    const hostMid = (geo.hostLeft + geo.hostRight) / 2;
    const frameMid = (geo.frameLeft + geo.frameRight) / 2;
    expect(Math.abs(hostMid - frameMid)).toBeLessThan(3);
  });

  test('a landscape divider tap opens the daf panel and a cross-bar drag does not', async ({ page }) => {
    test.skip(test.info().project.name !== 'mobile', 'landscape phone');
    test.setTimeout(60000);
    await page.setViewportSize({ width: 915, height: 412 });
    await openLive(page, '/player/?ref=Bekhorot+30a&variant=chazarah');
    await page.click('#viewerModeSplitButton');
    await expect(page.locator('body')).toHaveClass(/split-tools-phone/);
    await expect(page.locator('body')).not.toHaveClass(/split-layout-stacked/);
    const closed = await page.evaluate(() => {
      const frame = document.getElementById('videoFrame');
      const header = document.querySelector('#dafCard .daf-header');
      const divider = document.getElementById('splitDivider');
      const box = divider.getBoundingClientRect();
      const intoDaf = document.elementFromPoint(box.right + 18, box.top + box.height / 2);
      const past = document.elementFromPoint(box.right + 48, box.top + box.height / 2);
      return {
        open: document.body.classList.contains('split-tools-open'),
        inFrame: frame.contains(document.getElementById('playerTopbar')),
        header: getComputedStyle(header).display,
        intoDaf: intoDaf === divider || divider.contains(intoDaf),
        past: past === divider || divider.contains(past),
        boxW: box.width,
      };
    });
    expect(closed.open).toBe(false);
    expect(closed.inFrame).toBe(false);
    expect(closed.header).toBe('none');
    expect(closed.intoDaf).toBe(true);
    expect(closed.past).toBe(false);
    expect(closed.boxW).toBeLessThan(20);

    // 4px across the bar, with a slide along it, is still a tap.
    const divider = await page.locator('#splitDivider').boundingBox();
    const x = divider.x + divider.width / 2;
    const y = divider.y + Math.min(divider.height / 2, 180);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 4, y + 18, { steps: 3 });
    await page.mouse.up();
    await expect(page.locator('body')).toHaveClass(/split-tools-open/);
    const opened = await page.evaluate(() => {
      const panel = document.getElementById('splitToolsPanel');
      const card = document.getElementById('dafCard');
      const frame = document.getElementById('videoFrame');
      const panelBox = panel.getBoundingClientRect();
      const cardBox = card.getBoundingClientRect();
      const header = panel.querySelector('.daf-header, .card-heading');
      const auto = panel.querySelector('.header-auto-scroll');
      return {
        inCard: card.contains(panel),
        position: getComputedStyle(panel).position,
        panelLeft: panelBox.left,
        cardLeft: cardBox.left,
        panelRight: panelBox.right,
        cardRight: cardBox.right,
        panelTop: panelBox.top,
        cardTop: cardBox.top,
        headerShown: Boolean(header) && getComputedStyle(header).display !== 'none',
        autoShown: Boolean(auto) && getComputedStyle(auto).display !== 'none',
        overVideo: frame.contains(document.getElementById('playerTopbar')),
      };
    });
    expect(opened.inCard).toBe(true);
    expect(opened.position).toBe('absolute');
    expect(Math.abs(opened.panelLeft - opened.cardLeft)).toBeLessThan(2);
    expect(Math.abs(opened.panelRight - opened.cardRight)).toBeLessThan(2);
    expect(Math.abs(opened.panelTop - opened.cardTop)).toBeLessThan(2);
    expect(opened.headerShown).toBe(true);
    expect(opened.autoShown).toBe(true);
    expect(opened.overVideo).toBe(false);
    await shot(page, 'phone-split-landscape-open');

    await page.click('#splitDivider');
    await expect(page.locator('body')).not.toHaveClass(/split-tools-open/);

    const again = await page.locator('#splitDivider').boundingBox();
    const x2 = again.x + again.width / 2;
    const y2 = again.y + Math.min(again.height / 2, 180);
    await page.mouse.move(x2, y2);
    await page.mouse.down();
    await page.mouse.move(x2 + 24, y2, { steps: 4 });
    await page.mouse.up();
    await expect(page.locator('body')).not.toHaveClass(/split-tools-open/);
  });

  test('landscape without split parks the daf picker in the control stack', async ({ page }) => {
    test.skip(test.info().project.name !== 'mobile', 'landscape phone');
    test.setTimeout(60000);
    await page.setViewportSize({ width: 915, height: 412 });
    await openLive(page, '/player/?ref=Bekhorot+30a&variant=chazarah');
    await expect(page.locator('body')).not.toHaveClass(/split-view-active/);
    const geo = await page.evaluate(() => {
      const frameEl = document.getElementById('videoFrame');
      frameEl.classList.add('youtube-active');
      const hostEl = document.getElementById('youtubePlayerHost');
      hostEl.hidden = false;
      const frame = frameEl.getBoundingClientRect();
      const host = hostEl.getBoundingClientRect();
      const topbar = document.getElementById('playerTopbar').getBoundingClientRect();
      const controls = document.querySelector('.player-controls').getBoundingClientRect();
      return {
        frameBottom: frame.bottom,
        hostBottom: host.bottom,
        hostTop: host.top,
        topbarTop: topbar.top,
        topbarBottom: topbar.bottom,
        topbarH: topbar.height,
        controlsTop: controls.top,
        inFrame: frameEl.contains(document.getElementById('playerTopbar')),
      };
    });
    expect(geo.inFrame).toBe(true);
    expect(geo.topbarH).toBeGreaterThan(28);
    expect(geo.hostBottom).toBeLessThanOrEqual(geo.topbarTop + 2);
    expect(geo.topbarBottom).toBeLessThanOrEqual(geo.controlsTop + 2);
    expect(geo.topbarTop).toBeGreaterThan(geo.hostTop + 40);
    await shot(page, 'phone-landscape-picker-in-controls');
  });

  test('dragging the split bar down covers the pane and dragging up contains it', async ({ page }) => {
    test.skip(test.info().project.name !== 'mobile', 'portrait phone');
    test.setTimeout(60000);
    await page.setViewportSize({ width: 412, height: 915 });
    await openLive(page, '/player/?ref=Bekhorot+30a&variant=chazarah');
    await page.click('#viewerModeSplitButton');
    const picture = () => page.evaluate(() => {
      const frameEl = document.getElementById('videoFrame');
      frameEl.classList.add('youtube-active', 'yt-started', 'yt-mask');
      const hostEl = document.getElementById('youtubePlayerHost');
      hostEl.hidden = false;
      let layer = frameEl.querySelector(':scope > .yt-mask-layer');
      if (!layer) {
        layer = document.createElement('div');
        layer.className = 'yt-mask-layer';
        frameEl.appendChild(layer);
      }
      const box = (el) => {
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
      };
      if (!layer.querySelector('.yt-edge-top')) {
        layer.innerHTML = '<div class="yt-edge yt-edge-top"></div><div class="yt-edge yt-edge-bottom"></div><div class="yt-edge yt-edge-logo"></div>';
      }
      const host = box(hostEl);
      const mask = box(layer);
      const topEdge = box(layer.querySelector('.yt-edge-top')).height;
      const bottomEdge = box(layer.querySelector('.yt-edge-bottom')).height;
      frameEl.classList.remove('yt-started');
      const shield = box(document.getElementById('ytShield'));
      frameEl.classList.add('yt-started');
      const frame = box(frameEl);
      const controls = box(document.querySelector('.player-controls'));
      const embed = document.querySelector('#youtubePlayerHost iframe, #youtubePlayer');
      return {
        frame, host, mask, shield, topEdge, bottomEdge, controlsBottom: controls.bottom,
        transform: embed ? getComputedStyle(embed).transform : 'none',
      };
    });
    const tall = await picture();
    expect(tall.frame.height).toBeGreaterThan(tall.frame.width * 9 / 16 + 8);
    expect(tall.host.top).toBeLessThan(tall.frame.top - 24);
    expect(tall.host.bottom).toBeGreaterThan(tall.frame.bottom + 8);
    expect(tall.host.width).toBeGreaterThan(tall.frame.width + 8);
    expect(Math.abs((tall.host.left + tall.host.right) / 2 - (tall.frame.left + tall.frame.right) / 2)).toBeLessThan(3);
    expect(Math.abs(tall.mask.left - tall.frame.left)).toBeLessThan(2);
    expect(Math.abs(tall.mask.right - tall.frame.right)).toBeLessThan(2);
    expect(Math.abs(tall.mask.top - tall.frame.top)).toBeLessThan(2);
    expect(Math.abs(tall.mask.bottom - tall.frame.bottom)).toBeLessThan(2);
    // Normal Split height is taller than 16:9 and still has to cover the
    // byline and the More videos shelf. Only a far drag thins the bands.
    expect(tall.frame.width / tall.frame.height).toBeGreaterThan(2 / 3);
    expect(tall.topEdge).toBeGreaterThanOrEqual(64);
    expect(tall.bottomEdge).toBeGreaterThanOrEqual(110);
    expect(tall.bottomEdge).toBeLessThan(tall.frame.height * 0.5);
    expect(Math.abs(tall.shield.left - tall.host.left)).toBeLessThan(2);
    expect(Math.abs(tall.shield.top - tall.host.top)).toBeLessThan(2);
    expect(Math.abs(tall.shield.bottom - tall.host.bottom)).toBeLessThan(2);
    expect(Math.abs(tall.controlsBottom - tall.frame.bottom)).toBeLessThan(2);
    expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(tall.transform);

    const divider = await page.locator('#splitDivider').boundingBox();
    const x = divider.x + divider.width / 2;
    const y = divider.y + divider.height / 2;
    const far = Math.max(220, tall.frame.width / (2 / 3) - tall.frame.height + 48);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + far, { steps: 12 });
    await page.mouse.up();
    const lower = await picture();
    expect(lower.frame.height).toBeGreaterThan(tall.frame.height + 40);
    expect(lower.frame.width / lower.frame.height).toBeLessThan(2 / 3);
    expect(lower.host.width).toBeGreaterThan(tall.host.width + 20);
    expect(lower.host.top).toBeLessThan(lower.frame.top - 24);
    expect(lower.host.bottom).toBeGreaterThan(lower.frame.bottom + 8);
    expect(lower.host.width).toBeGreaterThan(lower.frame.width + 8);
    expect(Math.abs(lower.mask.bottom - lower.frame.bottom)).toBeLessThan(2);
    expect(lower.topEdge).toBeGreaterThan(8);
    expect(lower.topEdge).toBeLessThan(48);
    expect(lower.bottomEdge).toBeLessThan(22);
    await shot(page, 'phone-split-cover');

    const div2 = await page.locator('#splitDivider').boundingBox();
    const x2 = div2.x + div2.width / 2;
    const y2 = div2.y + div2.height / 2;
    await page.mouse.move(x2, y2);
    await page.mouse.down();
    await page.mouse.move(x2, Math.max(24, y2 - 520), { steps: 12 });
    await page.mouse.up();
    const short = await picture();
    expect(short.frame.height).toBeLessThan(short.frame.width * 9 / 16 - 4);
    expect(Math.abs(short.host.top - short.frame.top)).toBeLessThan(2);
    expect(Math.abs(short.host.height - short.frame.height)).toBeLessThan(3);
    expect(short.host.width).toBeLessThan(short.frame.width - 8);
    expect(short.host.left).toBeGreaterThanOrEqual(short.frame.left - 1);
    expect(short.host.right).toBeLessThanOrEqual(short.frame.right + 1);
    expect(Math.abs(short.host.bottom - short.frame.bottom)).toBeLessThan(2);
    expect(Math.abs(short.shield.top - short.frame.top)).toBeLessThan(2);
    expect(short.shield.left).toBeGreaterThanOrEqual(short.frame.left - 1);
  });

  test('play and a word click keep the YouTube bands up for about three seconds', async ({ page }) => {
    test.setTimeout(90000);
    const phone = test.info().project.name === 'mobile';
    const label = phone ? 'phone' : 'desktop';
    await page.setViewportSize(phone ? { width: 412, height: 915 } : { width: 1280, height: 800 });
    await openLive(page, '/player/?ref=Bekhorot+30a&variant=chazarah');
    if (phone) {
      await page.click('#viewerModeSplitButton');
      await expect(page.locator('body')).toHaveClass(/split-view-active/);
    }
    await page.evaluate(() => {
      const style = document.createElement('style');
      style.textContent = '#youtubePlayerHost{background:#e85d4c !important}#youtubePlayerHost iframe{opacity:.12 !important}';
      document.head.appendChild(style);
      const tag = document.createElement('div');
      tag.id = 'holdMark';
      tag.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99999;background:#fff;color:#111;font:700 16px sans-serif;padding:4px 8px';
      document.body.appendChild(tag);
    });
    const sample = async (name) => {
      const info = await page.evaluate((name) => {
        document.getElementById('holdMark').textContent = name;
        const frame = document.getElementById('videoFrame');
        const host = document.getElementById('youtubePlayerHost');
        const layer = frame.querySelector('.yt-mask-layer');
        const top = layer?.querySelector('.yt-edge-top');
        const bottom = layer?.querySelector('.yt-edge-bottom');
        const box = (el) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { top: r.top, left: r.left, width: r.width, height: r.height, bottom: r.bottom };
        };
        const frameBox = box(frame);
        const hostBox = box(host);
        const topBox = box(top);
        const bottomBox = box(bottom);
        const picture = hostBox && frameBox ? {
          top: Math.max(hostBox.top, frameBox.top),
          left: Math.max(hostBox.left, frameBox.left),
          right: Math.min(hostBox.left + hostBox.width, frameBox.left + frameBox.width),
          bottom: Math.min(hostBox.top + hostBox.height, frameBox.top + frameBox.height),
        } : null;
        const pictureW = picture ? picture.right - picture.left : 0;
        const scale = hostBox && pictureW ? hostBox.width / pictureW : 1;
        const crop = hostBox && picture ? picture.top - hostBox.top : 0;
        return {
          mask: frame.classList.contains('yt-mask'),
          layer: layer ? getComputedStyle(layer).display : 'none',
          topH: topBox?.height || 0,
          bottomH: bottomBox?.height || 0,
          needed: 48 * scale - crop,
          topCovers: Boolean(topBox && picture && topBox.top <= picture.top + 2 && topBox.left <= picture.left + 2 && topBox.left + topBox.width >= picture.right - 2 && topBox.height >= 48),
          bottomCovers: Boolean(bottomBox && picture && bottomBox.bottom >= picture.bottom - 2 && bottomBox.left <= picture.left + 2 && bottomBox.left + bottomBox.width >= picture.right - 2),
        };
      }, name);
      await shot(page, name);
      return info;
    };
    const at = async (since, ms) => {
      const left = ms - (Date.now() - since);
      if (left > 0) await page.waitForTimeout(left);
    };
    await page.waitForFunction(() => state.youtubeReady);
    let since = Date.now();
    await page.evaluate(() => togglePlay());
    for (const ms of [500, 1500, 3000]) {
      await at(since, ms);
      const info = await sample(`${label}-play-${ms === 500 ? '0.5s' : ms === 1500 ? '1.5s' : '3s'}`);
      expect(info.mask, `${label} play ${ms}ms`).toBe(true);
      expect(info.layer).toBe('block');
      expect(info.topCovers).toBe(true);
      expect(info.topH).toBeGreaterThanOrEqual(info.needed - 1);
      expect(info.bottomCovers).toBe(true);
      if (phone) expect(info.bottomH).toBeGreaterThanOrEqual(100);
    }
    await expect.poll(() => page.evaluate(() => document.getElementById('videoFrame').classList.contains('yt-mask')), { timeout: 2500 }).toBe(false);

    since = Date.now();
    await page.evaluate(() => {
      const word = document.querySelector('.vilna-phrase-box');
      if (word) word.click();
      else seek(48, true);
    });
    for (const ms of [500, 1500, 3000]) {
      await at(since, ms);
      const info = await sample(`${label}-word-${ms === 500 ? '0.5s' : ms === 1500 ? '1.5s' : '3s'}`);
      expect(info.mask, `${label} word ${ms}ms`).toBe(true);
      expect(info.layer).toBe('block');
      expect(info.topCovers).toBe(true);
      expect(info.bottomCovers).toBe(true);
    }
    await expect.poll(() => page.evaluate(() => document.getElementById('videoFrame').classList.contains('yt-mask')), { timeout: 2500 }).toBe(false);
  });
});
