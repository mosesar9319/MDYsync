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
    await page.evaluate(() => ensureYouTubePlayer('stubvid0001'));
    await page.waitForFunction(() => window.__yt);
    await expect.poll(() => page.evaluate(() => window.__ytCalls.some((call) => call[0] === 'load' && call[1] === 'captions'))).toBe(true);
  });
});
