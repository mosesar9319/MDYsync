import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { preparePage } from '../support/harness.mjs';

// An MDY shiur plays from MDY's own server (mdy-files.js) instead of YouTube,
// for readers whose filters block YouTube; YouTube is the fallback when the
// file is missing or is a different recording from the one the daf was synced
// to, and a reader can choose YouTube outright.
//
// The "file" is a 12-second WebM (Playwright's Chromium has no H.264), served
// at the .mp4 address MDY uses.

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIP = readFileSync(join(HERE, '..', 'fixtures', 'mdy-shiur-12s.webm'));
const CLIP_SECONDS = 12.008;
const VIDEO_ID = 'mdyTest0001';
const MDY_720 = 'https://cdn.mdydaf.com/shiur/english/chullin/720/89.mp4';
const MDY_360 = 'https://cdn.mdydaf.com/shiur/english/chullin/360/89.mp4';
const MDY_MP3 = 'https://cdn.mdydaf.com/shiur/english/chullin/mp3/89.mp3';

const YT_STUB = `
window.YT = window.YT || {};
window.__ytCreated = 0;
window.YT.Player = function (id, options) {
  window.__ytCreated += 1;
  const self = {
    _time: 0, _state: 5,
    seekTo(time) { self._time = time; },
    getCurrentTime() { return self._time; },
    getDuration() { return ${CLIP_SECONDS}; },
    getPlayerState() { return self._state; },
    cueVideoById(videoId) { window.__ytCued = videoId; self._state = 5; },
    playVideo() { self._state = 1; options.events.onStateChange({ data: 1, target: self }); },
    pauseVideo() { self._state = 2; options.events.onStateChange({ data: 2, target: self }); },
    setPlaybackRate() {}, getPlaybackRate() { return 1; },
    getVideoLoadedFraction() { return 1; },
    mute() {}, unMute() {}, isMuted() { return false; },
    setVolume() {}, getVolume() { return 100; },
    getAvailableQualityLevels() { return []; },
    addEventListener() {}, destroy() {},
  };
  window.__yt = self;
  setTimeout(() => options.events.onReady({ target: self }), 0);
  return self;
};
if (typeof window.onYouTubeIframeAPIReady === 'function') window.onYouTubeIframeAPIReady();
`;

function alignment(duration) {
  return {
    schema: 'dafsync-alignment-v2',
    dafRef: 'Chullin 89a',
    duration,
    alignmentStatus: 'complete',
    segments: [
      { ref: 'Chullin 89a:1', start: 1, end: 5, he: 'תנו רבנן ארבעה ראשי שנים הם', w0: 0, w1: 5 },
      { ref: 'Chullin 89a:2', start: 5, end: 10, he: 'ראש השנה למעשר בהמה', w0: 0, w1: 3 },
    ],
    wordTimeline: [],
  };
}

const VIDEO_LINK = {
  type: 'youtube',
  videoId: VIDEO_ID,
  url: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
  label: "Daf Yomi Chullin Daf 89 by R' Eli Stefansky",
};

// mdyFile: 'present' | 'missing'. youtube: 'works' | 'blocked'.
async function openShiur(page, { videoSource = null, syncedSeconds = CLIP_SECONDS, mdyFile = 'present', youtube = 'works' } = {}) {
  await preparePage(page, { user: null, videoSource });
  const requests = { mdy: [], youtube: 0 };
  await page.route(/^https:\/\/cdn\.mdydaf\.com\//, (route) => {
    const url = route.request().url();
    requests.mdy.push(url);
    if (url.endsWith('.png')) return route.fulfill({ status: 404, body: '' });
    if (mdyFile !== 'present') return route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
    // A real file server answers byte ranges, which is what lets the browser seek.
    const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range || '');
    if (!range) {
      return route.fulfill({ status: 200, contentType: 'video/webm', headers: { 'Accept-Ranges': 'bytes' }, body: CLIP });
    }
    const start = Number(range[1]);
    const end = range[2] ? Math.min(Number(range[2]), CLIP.length - 1) : CLIP.length - 1;
    return route.fulfill({
      status: 206,
      contentType: 'video/webm',
      headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${CLIP.length}` },
      body: CLIP.subarray(start, end + 1),
    });
  });
  await page.route('https://www.youtube.com/**', (route) => route.abort());
  await page.route('https://www.youtube.com/iframe_api*', (route) => {
    requests.youtube += 1;
    if (youtube === 'blocked') return route.abort();
    return route.fulfill({ status: 200, contentType: 'text/javascript', body: YT_STUB });
  });
  await page.route(/i\.ytimg\.com/, (route) => route.abort());
  await page.route('**/api/daf-page**', (route) => route.fulfill({ status: 200, contentType: 'application/pdf', body: '%PDF-fake' }));
  await page.route('**/api/get-results-file**', (route) => {
    const path = new URL(route.request().url()).searchParams.get('path') || '';
    if (path === 'by-ref/Chullin-89a.json') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(alignment(syncedSeconds)) });
    if (path === 'video-links/Chullin-89a.json') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(VIDEO_LINK) });
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"missing"}' });
  });
  await page.goto('/player/?ref=Chullin+89a');
  await page.waitForFunction(() => state.videoSource?.videoId === 'mdyTest0001', null, { timeout: 20000 });
  return requests;
}

const playing = (page) => page.evaluate(() => ({
  playerType: state.playerType,
  src: document.getElementById('video').getAttribute('src'),
  mdy: state.mdyPlayback ? { url: state.mdyPlayback.url, quality: state.mdyPlayback.quality } : null,
  badge: document.getElementById('videoSourceBadge').textContent,
  savedLink: state.videoSource?.type,
}));

test.describe('MDY shiurim from MDY’s own server', () => {
  test('plays from MDY’s server by default, never touching YouTube', async ({ page }, testInfo) => {
    const requests = await openShiur(page);
    await page.waitForFunction(() => document.getElementById('video').readyState >= 1, null, { timeout: 15000 });
    const now = await playing(page);
    const phone = testInfo.project.name !== 'desktop';
    expect(now.playerType).toBe('html5');
    expect(now.src).toBe(phone ? MDY_360 : MDY_720);
    expect(now.badge).toBe('MDY');
    // The daf's link stays the YouTube one: every sync is keyed by it.
    expect(now.savedLink).toBe('youtube');
    expect(requests.youtube).toBe(0);
    // Same recording: the highlight's clock is the file's clock.
    await page.evaluate(() => { document.getElementById('video').currentTime = 6; });
    await page.waitForFunction(() => Math.abs(getCurrentTime() - 6) < 0.5);
    const control = await page.evaluate(() => ({
      hidden: document.getElementById('playSourceControl').hidden,
      value: document.getElementById('playSourceSelect').value,
      qualities: [...document.getElementById('qualitySelect').options].map((o) => o.value),
    }));
    expect(control.hidden).toBe(false);
    expect(control.value).toBe('mdy');
    expect(control.qualities).toEqual(['360', '720', '1080', 'audio']);
  });

  test('a change of quality keeps the place, and audio only is the mp3', async ({ page }) => {
    await openShiur(page, { videoSource: 'mdy' });
    await page.waitForFunction(() => document.getElementById('video').readyState >= 1, null, { timeout: 15000 });
    await page.evaluate(() => { document.getElementById('video').currentTime = 7; });
    await page.waitForFunction(() => Math.abs(document.getElementById('video').currentTime - 7) < 0.5);
    await page.evaluate(() => changeMdyQuality('audio'));
    await page.waitForFunction((mp3) => document.getElementById('video').getAttribute('src') === mp3, MDY_MP3);
    await page.waitForFunction(() => Math.abs(document.getElementById('video').currentTime - 7) < 0.6, null, { timeout: 15000 });
    expect(await page.evaluate(() => localStorage.getItem('dafsync-mdy-quality'))).toBe('audio');
  });

  test('a file MDY’s server does not have falls back to YouTube', async ({ page }) => {
    await openShiur(page, { mdyFile: 'missing' });
    await page.waitForFunction(() => state.playerType === 'youtube' && window.__ytCued === 'mdyTest0001', null, { timeout: 15000 });
    const now = await playing(page);
    expect(now.mdy).toBeNull();
    expect(now.badge).toBe('YouTube');
    await expect(page.locator('#toast')).toContainText("isn't on MDY's server");
    expect(await page.evaluate(() => document.getElementById('playSourceSelect').value)).toBe('youtube');
  });

  test('a different recording from the synced one falls back to YouTube', async ({ page }) => {
    await openShiur(page, { syncedSeconds: 3400 });
    await page.waitForFunction(() => state.playerType === 'youtube' && window.__ytCued === 'mdyTest0001', null, { timeout: 15000 });
    await expect(page.locator('#toast')).toContainText('different recording');
    expect((await playing(page)).mdy).toBeNull();
  });

  test('a different recording still plays from MDY’s server when YouTube is blocked', async ({ page }) => {
    await openShiur(page, { syncedSeconds: 3400, youtube: 'blocked' });
    await page.waitForFunction(() => state.mdyPlayback && state.mdyAcceptMismatch.has('mdyTest0001'), null, { timeout: 45000 });
    const now = await playing(page);
    expect(now.playerType).toBe('html5');
    expect(now.src).toContain('https://cdn.mdydaf.com/shiur/english/chullin/');
    await expect(page.locator('#toast')).toContainText("YouTube didn't load");
  });

  test('a reader who chooses YouTube gets YouTube, and can switch back in place', async ({ page }) => {
    const requests = await openShiur(page, { videoSource: 'youtube' });
    await page.waitForFunction(() => state.playerType === 'youtube' && window.__ytCued === 'mdyTest0001', null, { timeout: 15000 });
    expect(requests.mdy.filter((url) => url.endsWith('.mp4'))).toEqual([]);
    expect(await page.evaluate(() => document.getElementById('playSourceSelect').value)).toBe('youtube');

    await page.evaluate(() => { window.__yt._time = 4; });
    await page.evaluate(() => changePlaySource('mdy'));
    await page.waitForFunction(() => state.playerType === 'html5' && document.getElementById('video').readyState >= 1, null, { timeout: 15000 });
    await page.waitForFunction(() => Math.abs(document.getElementById('video').currentTime - 4) < 0.6, null, { timeout: 15000 });
    expect(await page.evaluate(() => localStorage.getItem('dafsync-video-source'))).toBe('mdy');
    expect((await playing(page)).badge).toBe('MDY');

    await page.evaluate(() => changePlaySource('youtube'));
    await page.waitForFunction(() => state.playerType === 'youtube' && state.mdyPlayback === null);
    expect(await page.evaluate(() => document.getElementById('video').getAttribute('src'))).toBeNull();
  });

  test('listen to the audio alone, and back to the video, in place; the mp3 downloads from dafsync.com', async ({ page }) => {
    await openShiur(page, { videoSource: 'mdy' });
    await page.waitForFunction(() => document.getElementById('video').readyState >= 1, null, { timeout: 15000 });
    const before = await page.evaluate(() => state.mdyPlayback.url);
    const link = await page.evaluate(() => ({
      hidden: document.getElementById('mdyAudioControl').hidden,
      href: document.getElementById('mdyDownloadLink').getAttribute('href'),
      name: document.getElementById('mdyDownloadLink').getAttribute('download'),
    }));
    expect(link.hidden).toBe(false);
    expect(link.href).toBe('/mdy-audio/shiur/english/chullin/mp3/89.mp3');
    expect(link.name).toBe("Chullin 89 - R' Eli Stefansky.mp3");

    await page.evaluate(() => { document.getElementById('video').currentTime = 5; });
    await page.waitForFunction(() => Math.abs(document.getElementById('video').currentTime - 5) < 0.5);
    await page.evaluate(() => toggleMdyListen());
    await page.waitForFunction((mp3) => document.getElementById('video').getAttribute('src') === mp3, MDY_MP3);
    await page.waitForFunction(() => Math.abs(document.getElementById('video').currentTime - 5) < 0.6, null, { timeout: 15000 });
    expect(await page.evaluate(() => document.getElementById('mdyListenButton').getAttribute('aria-pressed'))).toBe('true');

    await page.evaluate(() => toggleMdyListen());
    await page.waitForFunction((url) => document.getElementById('video').getAttribute('src') === url, before);
    expect(await page.evaluate(() => document.getElementById('mdyListenButton').textContent)).toBe('Listen to audio only');
  });

  test('from YouTube, "listen to audio only" switches to MDY\u2019s mp3 in place', async ({ page }) => {
    await openShiur(page, { videoSource: 'youtube' });
    await page.waitForFunction(() => state.playerType === 'youtube' && window.__ytCued === 'mdyTest0001', null, { timeout: 15000 });
    expect(await page.evaluate(() => document.getElementById('mdyAudioControl').hidden)).toBe(false);
    await page.evaluate(() => { window.__yt._time = 3; });
    await page.evaluate(() => toggleMdyListen());
    await page.waitForFunction((mp3) => state.playerType === 'html5' && document.getElementById('video').getAttribute('src') === mp3, MDY_MP3);
    await page.waitForFunction(() => Math.abs(document.getElementById('video').currentTime - 3) < 0.6, null, { timeout: 15000 });
  });
});
