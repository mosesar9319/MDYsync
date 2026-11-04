import { test, expect } from '@playwright/test';
import { preparePage, failOnPageError } from '../support/harness.mjs';

// Phone player menus and captions. The overflow tray and the speed list are
// portaled out of the control bar; in Split fullscreen they have to live
// inside the fullscreen element or a tap opens a menu the phone cannot see.

const YT_STUB = `
window.YT = window.YT || {};
window.__ytCalls = [];
window.YT.Player = function (id, options) {
  window.__ytVars = options.playerVars || {};
  const self = {
    _time: 12,
    _state: 5,
    _duration: 600,
    seekTo(time) { self._time = Number(time) || 0; },
    getCurrentTime() { return self._time; },
    getDuration() { return self._duration; },
    getPlayerState() { return self._state; },
    cueVideoById() { self._state = 5; },
    playVideo() {
      self._state = 1;
      self._events.onStateChange({ data: 1, target: self });
    },
    pauseVideo() { self._state = 2; },
    mute() {},
    unMute() {},
    isMuted() { return false; },
    setVolume() {},
    getVolume() { return 100; },
    setPlaybackRate(rate) { self._rate = rate; },
    getPlaybackRate() { return self._rate || 1; },
    getVideoLoadedFraction() { return 1; },
    getAvailableQualityLevels() { return []; },
    getVideoData() { return { video_id: 'stubvid0001' }; },
    loadModule(name) { window.__ytCalls.push(['load', name]); },
    unloadModule(name) { window.__ytCalls.push(['unload', name]); },
    setOption(module, key, value) { window.__ytCalls.push(['set', module, key, value]); },
    getOption() { return [{ languageCode: 'en', displayName: 'English' }]; },
    addEventListener() {},
    destroy() {},
    _events: options.events,
  };
  window.__yt = self;
  setTimeout(() => options.events.onReady({ target: self }), 0);
  return self;
};
if (typeof window.onYouTubeIframeAPIReady === 'function') window.onYouTubeIframeAPIReady();
`;

async function dismissErrorBanner(page) {
  const dismiss = page.locator('[aria-label="Dismiss"]');
  if (await dismiss.count()) await dismiss.first().click({ timeout: 1000 }).catch(() => {});
}

async function revealChrome(page) {
  await page.evaluate(() => {
    document.body.classList.remove('split-chrome-hidden');
    document.getElementById('videoFrame')?.classList.remove('controls-hidden');
  });
}

async function openPlayer(page) {
  failOnPageError(page);
  await preparePage(page, { user: null });
  await page.setViewportSize({ width: 412, height: 915 });
  await page.goto('/player/?ref=Chullin%2089a');
  await page.waitForSelector('#speedSelect');
  await revealChrome(page);
  await dismissErrorBanner(page);
}

test.describe('phone speed, more menu, and captions', () => {
  test('tapping speed applies a rate in the bar, in fullscreen, and inside More', async ({ page }, testInfo) => {
    await openPlayer(page);
    const tap = async (selector) => {
      const target = page.locator(selector).first();
      await expect(target).toBeVisible();
      if (testInfo.project.name === 'mobile') await target.tap();
      else await target.click();
    };

    await tap('#speedSelect');
    await expect(page.locator('#speedMenu')).toBeVisible();
    await tap('#speedMenu li[data-value="1.5"]');
    await expect.poll(() => page.evaluate(() => document.getElementById('video').playbackRate)).toBe(1.5);
    expect(await page.locator('#speedSelectValue').textContent()).toBe('1.5×');

    await page.click('#viewerModeSplitButton');
    await dismissErrorBanner(page);
    const fullscreen = await page.evaluate(async () => {
      try {
        await document.querySelector('.watch-layout').requestFullscreen();
        return document.fullscreenElement?.className || '';
      } catch (error) {
        return `error:${error.message}`;
      }
    });
    test.skip(!String(fullscreen).includes('watch-layout'), `fullscreen unavailable (${fullscreen})`);
    await revealChrome(page);
    await tap('#speedSelect');
    const speedHost = await page.evaluate(() => {
      const menu = document.getElementById('speedMenu');
      const r = menu.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + 12, r.top + 12);
      return {
        hidden: menu.hidden,
        inside: Boolean(document.fullscreenElement?.contains(menu)),
        hit: hit?.closest?.('#speedMenu') ? 'menu' : (hit?.id || hit?.className || ''),
      };
    });
    expect(speedHost.hidden).toBe(false);
    expect(speedHost.inside).toBe(true);
    expect(speedHost.hit).toBe('menu');
    await tap('#speedMenu li[data-value="1.25"]');
    await expect.poll(() => page.evaluate(() => document.getElementById('video').playbackRate)).toBe(1.25);
    await page.evaluate(() => document.exitFullscreen());

    await page.evaluate(() => {
      document.getElementById('videoFrame').style.width = '180px';
    });
    await revealChrome(page);
    await expect.poll(() => page.evaluate(() => {
      const speed = document.getElementById('speedSelect');
      const more = document.getElementById('toolsMoreButton');
      return Boolean(speed?.closest('#toolsMoreMenu')) && more && !more.closest('#toolsMoreStack')?.hidden && !document.getElementById('toolsMoreStack')?.hidden;
    })).toBe(true);
    await tap('#toolsMoreButton');
    await expect(page.locator('#toolsMoreMenu')).toBeVisible();
    await tap('#speedSelect');
    await expect(page.locator('#speedMenu')).toBeVisible();
    const above = await page.evaluate(() => {
      const menu = document.getElementById('speedMenu');
      const r = menu.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 16);
      return hit?.closest?.('#speedMenu') ? 'menu' : (hit?.id || '');
    });
    expect(above).toBe('menu');
    await tap('#speedMenu li[data-value="2"]');
    await expect.poll(() => page.evaluate(() => document.getElementById('video').playbackRate)).toBe(2);
  });

  test('the More menu opens inside split fullscreen and a tap outside dismisses it', async ({ page }, testInfo) => {
    await openPlayer(page);
    await page.setViewportSize({ width: 280, height: 700 });
    await page.click('#viewerModeSplitButton');
    await dismissErrorBanner(page);
    const fullscreen = await page.evaluate(async () => {
      try {
        await document.querySelector('.watch-layout').requestFullscreen();
        return document.fullscreenElement?.className || '';
      } catch (error) {
        return `error:${error.message}`;
      }
    });
    test.skip(!String(fullscreen).includes('watch-layout'), `fullscreen unavailable (${fullscreen})`);
    await revealChrome(page);
    await expect.poll(() => page.locator('#toolsMoreButton').isVisible()).toBe(true);
    const tap = async (selector) => {
      const target = page.locator(selector);
      await expect(target).toBeVisible();
      if (testInfo.project.name === 'mobile') await target.tap();
      else await target.click();
    };
    await tap('#toolsMoreButton');
    const opened = await page.evaluate(() => {
      const menu = document.getElementById('toolsMoreMenu');
      const r = menu.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + 16, r.top + 16);
      return {
        hidden: menu.hidden,
        inside: Boolean(document.fullscreenElement?.contains(menu)),
        hit: hit?.closest?.('#toolsMoreMenu') ? 'menu' : (hit?.id || hit?.className || ''),
        items: menu.querySelectorAll('button, .speed-select').length,
      };
    });
    expect(opened.hidden).toBe(false);
    expect(opened.inside).toBe(true);
    expect(opened.hit).toBe('menu');
    expect(opened.items).toBeGreaterThan(0);
    const item = page.locator('#toolsMoreMenu button, #toolsMoreMenu .speed-select').first();
    await expect(item).toBeVisible();
    await page.evaluate(() => document.elementFromPoint(8, 8)?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await page.mouse.click(8, 8);
    await expect(page.locator('#toolsMoreMenu')).toBeHidden();
  });

  test('the More menu toggles closed on a second tap and on a tap outside', async ({ page }, testInfo) => {
    await openPlayer(page);
    await page.setViewportSize({ width: 280, height: 700 });
    await revealChrome(page);
    const tap = async (selector) => {
      const target = page.locator(selector);
      await expect(target).toBeVisible();
      if (testInfo.project.name === 'mobile') await target.tap();
      else await target.click();
    };
    await expect.poll(() => page.locator('#toolsMoreButton').isVisible()).toBe(true);
    await tap('#toolsMoreButton');
    await expect(page.locator('#toolsMoreMenu')).toBeVisible();
    await tap('#toolsMoreButton');
    await expect(page.locator('#toolsMoreMenu')).toBeHidden();
    await tap('#toolsMoreButton');
    await expect(page.locator('#toolsMoreMenu')).toBeVisible();
    await page.mouse.click(12, 70);
    await expect(page.locator('#toolsMoreMenu')).toBeHidden();

    const topMore = page.locator('#playerMoreButton');
    if (await topMore.isVisible()) {
      await tap('#playerMoreButton');
      await expect(page.locator('#playerMoreMenu')).toBeVisible();
      await tap('#playerMoreButton');
      await expect(page.locator('#playerMoreMenu')).toBeHidden();
    }
    const menuColor = await page.evaluate(() => {
      const item = document.querySelector('#playerMoreMenu .player-chrome-menu-item');
      return item ? getComputedStyle(item).color : null;
    });
    if (menuColor) expect(menuColor).toBe('rgb(244, 247, 251)');
  });

  test('closing Split or changing its layout hides an open daf picker', async ({ page }) => {
    await openPlayer(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await revealChrome(page);
    await page.click('#viewerModeSplitButton');
    await dismissErrorBanner(page);
    await revealChrome(page);
    await page.click('#playerDafButton');
    await expect(page.locator('#playerDafMenu')).toBeVisible();
    await page.click('#splitExitButton');
    await expect(page.locator('#playerDafMenu')).toBeHidden();
    await expect(page.locator('body')).not.toHaveClass(/split-view-active/);
    // The Split X swallows the next click so it cannot land on Sign in.
    await page.waitForTimeout(600);

    await page.click('#viewerModeSplitButton');
    await revealChrome(page);
    await page.click('#playerDafButton');
    await expect(page.locator('#playerDafMenu')).toBeVisible();
    await page.click('#splitLayoutToggleButton');
    await expect(page.locator('#playerDafMenu')).toBeHidden();
  });

  test('a word-tap seek masks YouTube chrome and lifts it once playback resumes', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.route('https://www.youtube.com/**', (route) => route.abort());
    await page.route('https://www.youtube.com/iframe_api*', (route) => {
      route.fulfill({ status: 200, contentType: 'text/javascript', body: YT_STUB });
    });
    await page.goto('/player/?ref=Chullin%2089a');
    await page.evaluate(() => ensureYouTubePlayer('stubvid0001'));
    await page.waitForFunction(() => window.__yt);
    const during = await page.evaluate(() => {
      state.wantPlaying = true;
      state.youtubeState = 1;
      window.__yt._state = 1;
      const frame = document.getElementById('videoFrame');
      frame.classList.add('youtube-active', 'yt-playing', 'yt-started');
      frame.classList.remove('yt-hold', 'yt-mask');
      // The same seek() a daf word uses. The scrubber's coverYouTubeSeek
      // is this function too.
      seek(80, true);
      const layer = frame.querySelector('.yt-mask-layer');
      return {
        hold: frame.classList.contains('yt-hold'),
        playing: frame.classList.contains('yt-playing'),
        mask: frame.classList.contains('yt-mask'),
        shield: getComputedStyle(document.getElementById('ytShield')).display,
        layer: layer ? getComputedStyle(layer).display : 'none',
      };
    });
    expect(during.hold).toBe(false);
    expect(during.playing).toBe(true);
    expect(during.mask).toBe(true);
    expect(during.shield).toBe('none');
    expect(during.layer).toBe('block');
    const buffering = await page.evaluate(() => {
      window.__yt._state = 3;
      window.__yt._events.onStateChange({ data: 3, target: window.__yt });
      const frame = document.getElementById('videoFrame');
      return {
        mask: frame.classList.contains('yt-mask'),
        shield: getComputedStyle(document.getElementById('ytShield')).display,
        hold: frame.classList.contains('yt-hold'),
      };
    });
    expect(buffering.mask).toBe(true);
    expect(buffering.shield).toBe('none');
    expect(buffering.hold).toBe(false);
    const frozen = await page.evaluate(async () => {
      window.__yt._state = 1;
      window.__yt._time = 80;
      window.__yt.getCurrentTime = () => 80;
      window.__yt._events.onStateChange({ data: 1, target: window.__yt });
      await new Promise((resolve) => setTimeout(resolve, 500));
      return document.getElementById('videoFrame').classList.contains('yt-mask');
    });
    expect(frozen).toBe(true);
    const jumped = await page.evaluate(async () => {
      window.__yt.getCurrentTime = () => 200;
      await new Promise((resolve) => setTimeout(resolve, 450));
      return document.getElementById('videoFrame').classList.contains('yt-mask');
    });
    expect(jumped).toBe(true);
    await page.evaluate(() => {
      const start = performance.now();
      window.__yt.getCurrentTime = () => 200 + (performance.now() - start) / 1000;
    });
    await expect.poll(() => page.evaluate(() => {
      const frame = document.getElementById('videoFrame');
      const shield = getComputedStyle(document.getElementById('ytShield')).display;
      return frame.classList.contains('yt-playing')
        && !frame.classList.contains('yt-mask')
        && !frame.classList.contains('yt-hold')
        && shield === 'none';
    }), { timeout: 1200 }).toBe(true);
  });

  test('a word-tap seek keeps the bands up until the new time is the one moving', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.route('https://www.youtube.com/**', (route) => route.abort());
    await page.route('https://www.youtube.com/iframe_api*', (route) => {
      route.fulfill({ status: 200, contentType: 'text/javascript', body: YT_STUB });
    });
    await page.goto('/player/?ref=Chullin%2089a');
    await page.evaluate(() => ensureYouTubePlayer('stubvid0001'));
    await page.waitForFunction(() => window.__yt);
    const early = await page.evaluate(async () => {
      state.wantPlaying = true;
      state.youtubeState = 1;
      window.__yt._state = 1;
      window.__yt._time = 10;
      const frame = document.getElementById('videoFrame');
      frame.classList.add('youtube-active', 'yt-playing', 'yt-started');
      frame.classList.remove('yt-hold', 'yt-mask');
      // The player has not landed yet. The old clock keeps running.
      window.__yt.seekTo = () => {};
      const start = performance.now();
      window.__yt.getCurrentTime = () => 10 + (performance.now() - start) / 1000;
      seek(80, true);
      await new Promise((resolve) => setTimeout(resolve, 500));
      return document.getElementById('videoFrame').classList.contains('yt-mask');
    });
    expect(early).toBe(true);
    await page.evaluate(() => {
      const start = performance.now();
      window.__yt.getCurrentTime = () => 80 + (performance.now() - start) / 1000;
    });
    await expect.poll(() => page.evaluate(() => {
      const frame = document.getElementById('videoFrame');
      return frame.classList.contains('yt-playing') && !frame.classList.contains('yt-mask');
    }), { timeout: 1200 }).toBe(true);

    const paused = await page.evaluate(async () => {
      state.wantPlaying = false;
      state.youtubeState = 2;
      window.__yt._state = 2;
      window.__yt._time = 80;
      window.__yt.getCurrentTime = () => 80;
      const frame = document.getElementById('videoFrame');
      frame.classList.add('yt-started', 'yt-playing', 'yt-mask');
      seek(140, true);
      const start = performance.now();
      window.__yt.getCurrentTime = () => 140 + (performance.now() - start) / 1000;
      window.__yt._state = 1;
      window.__yt._events.onStateChange({ data: 1, target: window.__yt });
      await new Promise((resolve) => setTimeout(resolve, 400));
      return {
        mask: frame.classList.contains('yt-mask'),
        want: state.wantPlaying,
      };
    });
    expect(paused.want).toBe(false);
    expect(paused.mask).toBe(true);
  });

  test('captions stay off until turned on, and the choice is remembered', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.route('https://www.youtube.com/**', (route) => route.abort());
    await page.route('https://www.youtube.com/iframe_api*', (route) => {
      route.fulfill({ status: 200, contentType: 'text/javascript', body: YT_STUB });
    });
    await page.goto('/player/?ref=Chullin%2089a');
    await page.waitForSelector('#captionsButton');
    expect(await page.locator('#captionsButton').getAttribute('aria-pressed')).toBe('false');
    expect(await page.evaluate(() => localStorage.getItem('dafsync-captions'))).toBeNull();

    const htmlTrack = await page.evaluate(() => {
      const track = document.getElementById('video').addTextTrack('subtitles', 'English', 'en');
      track.mode = 'showing';
      applyCaptionsPreference();
      return track.mode;
    });
    expect(htmlTrack).toBe('disabled');

    await page.evaluate(() => ensureYouTubePlayer('stubvid0001'));
    await page.waitForFunction(() => window.__yt);
    await page.waitForTimeout(700);
    const initial = await page.evaluate(() => ({
      policy: window.__ytVars.cc_load_policy,
      calls: window.__ytCalls.filter((call) => call[1] === 'captions').map((call) => call[0]),
    }));
    expect(initial.policy).toBe(0);
    expect(initial.calls).toContain('unload');
    expect(initial.calls).not.toContain('load');

    await page.locator('#captionsButton').click();
    await expect.poll(() => page.locator('#captionsButton').getAttribute('aria-pressed')).toBe('true');
    expect(await page.evaluate(() => localStorage.getItem('dafsync-captions'))).toBe('on');
    await expect.poll(() => page.evaluate(() => window.__ytCalls.some((call) => call[0] === 'load' && call[1] === 'captions'))).toBe(true);
    expect(await page.evaluate(() => window.__ytCalls.some((call) => call[0] === 'set' && call[1] === 'captions' && call[2] === 'track' && call[3]?.languageCode === 'en'))).toBe(true);

    await page.reload();
    await page.waitForSelector('#captionsButton');
    expect(await page.locator('#captionsButton').getAttribute('aria-pressed')).toBe('true');
    expect(await page.locator('#captionsStack .pc-label').textContent()).toBe('Captions on');
    await page.evaluate(() => ensureYouTubePlayer('stubvid0001'));
    await page.waitForFunction(() => window.__yt);
    await expect.poll(() => page.evaluate(() => window.__ytCalls.some((call) => call[0] === 'load' && call[1] === 'captions'))).toBe(true);

    // MDY uploads often list no caption tracks until later. English, including
    // the automatic track, is still requested.
    const forced = await page.evaluate(() => {
      window.__yt.getOption = () => [];
      window.__ytCalls.length = 0;
      setCaptionsEnabled(true);
      return window.__ytCalls.filter((call) => call[0] === 'set' && call[1] === 'captions' && call[2] === 'track');
    });
    expect(forced.some((call) => call[3]?.languageCode === 'en' && call[3]?.kind === 'asr')).toBe(true);
    expect(forced.some((call) => call[3]?.languageCode === 'en' && !call[3]?.kind)).toBe(true);
    expect(await page.locator('#captionsButton').getAttribute('aria-pressed')).toBe('true');
    expect(await page.locator('#captionsStack .pc-label').textContent()).toBe('Captions on');

    const turnedOff = await page.evaluate(() => {
      window.__ytCalls.length = 0;
      setCaptionsEnabled(false);
      return window.__ytCalls.filter((call) => call[1] === 'captions').map((call) => call[0]);
    });
    expect(turnedOff).toContain('unload');
    expect(turnedOff.at(-1)).toBe('unload');
    expect(turnedOff.lastIndexOf('unload')).toBeGreaterThan(turnedOff.lastIndexOf('load'));
    expect(await page.locator('#captionsButton').getAttribute('aria-pressed')).toBe('false');

    const afterFullscreen = await page.evaluate(() => {
      window.__ytCalls.length = 0;
      document.dispatchEvent(new Event('fullscreenchange'));
      return window.__ytCalls.filter((call) => call[1] === 'captions').map((call) => call[0]);
    });
    expect(afterFullscreen).toContain('unload');
    expect(afterFullscreen.at(-1)).toBe('unload');
    expect(afterFullscreen.lastIndexOf('unload')).toBeGreaterThan(afterFullscreen.lastIndexOf('load'));
  });

  test('a fresh profile and a legacy captions value stay off', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.route('https://www.youtube.com/**', (route) => route.abort());
    await page.route('https://www.youtube.com/iframe_api*', (route) => {
      route.fulfill({ status: 200, contentType: 'text/javascript', body: YT_STUB });
    });
    await page.addInitScript(() => {
      localStorage.setItem('dafsync-captions', 'true');
      localStorage.setItem('dafsync-cc', 'on');
      localStorage.setItem('captions', '1');
    });
    await page.goto('/player/?ref=Chullin%2089a');
    await page.waitForSelector('#captionsButton');
    expect(await page.locator('#captionsButton').getAttribute('aria-pressed')).toBe('false');
    expect(await page.locator('#captionsStack .pc-label').textContent()).toBe('Captions off');
    expect(await page.evaluate(() => localStorage.getItem('dafsync-captions'))).toBeNull();
    expect(await page.evaluate(() => localStorage.getItem('dafsync-cc'))).toBeNull();
    await page.evaluate(() => ensureYouTubePlayer('stubvid0001'));
    await page.waitForFunction(() => window.__yt);
    await page.waitForTimeout(400);
    const calls = await page.evaluate(() => window.__ytCalls.filter((call) => call[1] === 'captions').map((call) => call[0]));
    expect(calls).toContain('unload');
    expect(calls).not.toContain('load');
    expect(await page.evaluate(() => window.__ytVars.cc_lang_pref)).toBeUndefined();
  });
});
