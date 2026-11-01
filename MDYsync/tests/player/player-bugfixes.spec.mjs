import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { preparePage, failOnPageError } from '../support/harness.mjs';

// Player fixes that can be proven against the real page with a YouTube
// stand-in and, where the timing only exists in published data, the live
// Bekhorot alignments. The harness stubs /api, so the live JSON is fetched
// once here and replayed.

const LIVE = 'https://dafsync.netlify.app/api/get-results-file?path=';
const FILES = [
  'by-ref/Chazarah-Daf-Bekhorot-30a.json',
  'by-ref/Chazarah-Daf-Bekhorot-31a.json',
  'by-ref/Bekhorot-20a.json',
  'video-links/Chazarah-Daf-Bekhorot-30a.json',
  'video-links/Chazarah-Daf-Bekhorot-31a.json',
  'video-links/Bekhorot-20a.json',
];
const SHOTS = '/opt/cursor/artifacts/player-bugfixes';

const YT_STUB = `
window.YT = window.YT || {};
window.YT.Player = function (id, options) {
  window.__playerVars = options.playerVars || {};
  const self = {
    _time: 0,
    _state: 5,
    _duration: 7200,
    _muted: false,
    seekTo(time) { self._time = Number(time) || 0; },
    getCurrentTime() { return self._time; },
    getDuration() { return self._duration; },
    getPlayerState() { return self._state; },
    cueVideoById() { self._state = 5; },
    playVideo() {
      self._state = 1;
      options.events.onStateChange({ data: 1, target: self });
    },
    pauseVideo() {
      self._state = 2;
      options.events.onStateChange({ data: 2, target: self });
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
}

async function shot(page, name) {
  if (test.info().project.name !== 'desktop') return;
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false });
}

test.describe('player bugfixes on live Bekhorot', () => {
  test('Vaater jumps a whole phrase, including while paused', async ({ page }) => {
    test.setTimeout(60000);
    await openLive(page, '/player/?ref=Bekhorot+30a&variant=chazarah');
    const result = await page.evaluate(() => {
      const real = state.segments.findIndex((segment) => !segment.estimated && segment.end - segment.start > 0.2);
      const start = state.segments[real].start + 0.1;
      window.__yt._time = start;
      window.__yt._state = 2;
      state.youtubeState = 2;
      state.wantPlaying = false;
      updateActiveSegment(true, start);
      updatePlayUi();
      const before = getCurrentTime();
      const target = nextReadingTime(before);
      const button = document.getElementById('vaaterButton');
      const enabledWhilePaused = Boolean(button) && !button.hidden && !button.disabled;
      button.click();
      const landed = state.segments[state.activeIndex];
      return {
        before,
        target,
        after: getCurrentTime(),
        enabledWhilePaused,
        landedEstimated: Boolean(landed?.estimated),
        landedStart: landed?.start ?? null,
        skippedFrames: target != null && target - before > 0.5,
      };
    });
    expect(result.enabledWhilePaused).toBe(true);
    expect(result.target).not.toBeNull();
    expect(result.skippedFrames).toBe(true);
    expect(result.after).toBeCloseTo(result.target, 1);
    expect(result.landedEstimated).toBe(false);
    await shot(page, 'vaater-30a');
  });

  test('Bekhorot 31a intro does not highlight the packed 30b phrases', async ({ page }) => {
    test.setTimeout(60000);
    await openLive(page, '/player/?ref=Bekhorot+31a&variant=chazarah');
    const intro = await page.evaluate(() => {
      const anchor = firstRealSegmentStart();
      const probe = Math.max(0, (anchor || 0) - 0.2);
      window.__yt._time = probe;
      updateActiveSegment(true, probe);
      const active = document.querySelectorAll('.daf-segment.active');
      const boxes = document.querySelectorAll('#vilnaActiveOverlay .vilna-active-rect');
      return {
        anchor,
        probe,
        index: state.activeIndex,
        ref: document.getElementById('currentRef')?.textContent || '',
        activeCount: active.length,
        boxCount: boxes.length,
        activeRef: state.segments[state.activeIndex]?.ref || '',
      };
    });
    expect(intro.anchor).toBeGreaterThan(0.5);
    expect(intro.index).toBe(-1);
    expect(intro.ref).toBe('Intro');
    expect(intro.activeCount).toBe(0);
    expect(intro.boxCount).toBe(0);
    await shot(page, 'intro-31a');
  });

  test('play intent shows a spinner and a second click cancels instead of re-requesting', async ({ page }) => {
    test.setTimeout(60000);
    await openLive(page, '/player/?ref=Bekhorot+20a');
    const result = await page.evaluate(() => {
      window.__plays = 0;
      window.__pauses = 0;
      const player = window.__yt;
      player.playVideo = () => { window.__plays += 1; player._state = 3; };
      player.pauseVideo = () => { window.__pauses += 1; player._state = 2; };
      player._state = 5;
      state.wantPlaying = false;
      state.youtubeReady = true;
      togglePlay();
      const loading = document.getElementById('largePlay').classList.contains('is-loading')
        || document.getElementById('playButton').classList.contains('is-loading');
      const label = document.getElementById('playButton').getAttribute('aria-label');
      togglePlay();
      return {
        loading,
        label,
        plays: window.__plays,
        pauses: window.__pauses,
        wantPlaying: state.wantPlaying,
      };
    });
    expect(result.loading).toBe(true);
    expect(result.label).toMatch(/Loading/i);
    expect(result.plays).toBe(1);
    expect(result.pauses).toBe(1);
    expect(result.wantPlaying).toBe(false);
    await shot(page, 'play-loading-20a');
  });
});

test.describe('player bugfixes without a published alignment', () => {
  test.beforeEach(async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/player/');
  });

  test('Space and j/l work while a player button is focused, and not while typing', async ({ page }) => {
    await page.evaluate(() => {
      window.__keys = [];
      window.togglePlay = () => { window.__keys.push('toggle'); };
      window.seek = (time) => { window.__keys.push(['seek', time]); };
    });
    await page.locator('#playButton').focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('k');
    await page.keyboard.press('j');
    await page.keyboard.press('l');
    await page.evaluate(() => {
      const input = document.createElement('input');
      input.id = 'typingProbe';
      input.type = 'text';
      document.body.appendChild(input);
    });
    await page.locator('#typingProbe').focus();
    await page.keyboard.type('a');
    await page.keyboard.press('Space');
    await page.keyboard.press('k');
    const keys = await page.evaluate(() => window.__keys);
    expect(keys[0]).toBe('toggle');
    expect(keys[1]).toBe('toggle');
    expect(keys[2][0]).toBe('seek');
    expect(keys[3][0]).toBe('seek');
    expect(keys[3][1] - keys[2][1]).toBeCloseTo(20, 5);
    expect(keys).toHaveLength(4);
  });

  test('a mouse click on the video picture toggles play; a first touch does not', async ({ page }) => {
    await page.evaluate(() => {
      window.__toggles = 0;
      window.togglePlay = () => { window.__toggles += 1; };
      state.playerType = 'youtube';
      document.getElementById('videoFrame').classList.add('youtube-active');
    });
    const surface = page.locator('.video-click-surface');
    await surface.dispatchEvent('pointerdown', { pointerType: 'mouse' });
    await surface.dispatchEvent('click');
    expect(await page.evaluate(() => window.__toggles)).toBe(1);

    await page.evaluate(() => document.getElementById('videoFrame').classList.add('controls-hidden'));
    const wake = page.locator('.player-wake-layer');
    await wake.dispatchEvent('pointerdown', { pointerType: 'touch' });
    await wake.dispatchEvent('click');
    expect(await page.evaluate(() => window.__toggles)).toBe(1);
    await shot(page, 'click-to-play');
  });

  test('header notes keep the daf from shifting when they appear', async ({ page }) => {
    const tops = await page.evaluate(() => {
      ensureReaderNotes();
      const card = document.getElementById('dafCard');
      const scroll = document.getElementById('dafScroll');
      const rel = () => scroll.getBoundingClientRect().top - card.getBoundingClientRect().top;
      const before = rel();
      state.dafRef = 'Bekhorot 31a';
      state.segments = [
        { ref: 'Bekhorot 30b:1', start: 0.1, end: 0.4, estimated: true, he: 'א', w0: 0, w1: 1 },
        { ref: 'Bekhorot 31a:1', start: 12, end: 16, estimated: false, he: 'ב', w0: 0, w1: 2 },
      ];
      updateReaderNotes(0.2, -1);
      const intro = rel();
      updateReaderNotes(1, 0);
      const leadIn = rel();
      const notes = document.getElementById('readerDafNotes');
      return {
        before, intro, leadIn,
        height: notes.getBoundingClientRect().height,
        chipHidden: document.getElementById('skipToDafChip').hidden,
        ref: document.getElementById('currentRef').textContent,
      };
    });
    expect(tops.intro).toBeCloseTo(tops.before, 0);
    expect(tops.leadIn).toBeCloseTo(tops.before, 0);
    expect(tops.height).toBeCloseTo(32, 0);
    expect(tops.chipHidden).toBe(false);
    expect(tops.ref).toMatch(/Reviewing|Intro|Bekhorot/);
    await shot(page, 'notes-stable');
  });

  test('Split view toggles off, Back leaves it, and Escape leaves it', async ({ page }) => {
    const dismiss = page.locator('[aria-label="Dismiss"]');
    if (await dismiss.count()) await dismiss.first().click({ timeout: 1000 }).catch(() => {});
    await page.click('#viewerModeSplitButton');
    await expect.poll(() => page.evaluate(() => state.viewerMode)).toBe('split');
    await expect(page.locator('#splitBackToDaf')).toBeVisible();
    await shot(page, 'split-back-button');
    await page.click('#viewerModeSplitButton');
    await expect.poll(() => page.evaluate(() => state.viewerMode)).toBe('standard');
    await page.waitForFunction(() => !history.state?.split);

    await page.click('#viewerModeSplitButton');
    await page.goBack();
    await expect.poll(() => page.evaluate(() => state.viewerMode)).toBe('standard');

    await page.click('#viewerModeSplitButton');
    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => state.viewerMode)).toBe('standard');
    await expect(page.locator('body')).not.toHaveClass(/split-view-active/);
    await shot(page, 'split-exit');
  });

  test('a recovered YouTube error does not toast, and mute label tracks the click', async ({ page }) => {
    await page.evaluate(() => {
      const toast = document.getElementById('toast');
      toast.textContent = '';
      toast.classList.remove('show');
      state.youtubeCueId = 'abc123def45';
      state.youtubePlayer = {
        getPlayerState: () => 5,
        getVideoData: () => ({ video_id: 'abc123def45' }),
      };
      scheduleYouTubeError(2, state.youtubePlayer, 'abc123def45', {
        reject() { window.__ytRejected = true; },
        resolve() { window.__ytResolved = true; },
        settled: () => true,
      });
    });
    await page.waitForTimeout(1700);
    const toast = await page.locator('#toast').textContent();
    expect(toast || '').not.toMatch(/invalid|couldn't load/i);

    await page.click('#muteButton');
    await expect(page.locator('#muteButton')).toHaveAttribute('aria-label', 'Unmute');
    await page.click('#muteButton');
    await expect(page.locator('#muteButton')).toHaveAttribute('aria-label', 'Mute');
  });

  test('the scrub tooltip hides when the pointer leaves', async ({ page }) => {
    await page.evaluate(() => {
      state.segments = [{ ref: 'Bekhorot 30a:1', start: 0, end: 10, estimated: false, he: 'מילה', w0: 0, w1: 0 }];
      const scrubber = document.getElementById('scrubber');
      scrubber.max = '100';
      const rect = scrubber.getBoundingClientRect();
      scrubber.dispatchEvent(new PointerEvent('pointermove', {
        pointerType: 'mouse', bubbles: true, clientX: rect.left + 20, clientY: rect.top + 4,
      }));
    });
    await expect(page.locator('#scrubPreview')).toBeVisible();
    await page.evaluate(() => document.getElementById('scrubber').dispatchEvent(new PointerEvent('pointerleave', { bubbles: true })));
    await expect(page.locator('#scrubPreview')).toBeHidden();
  });
});
