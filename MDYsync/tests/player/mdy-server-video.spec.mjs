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
    const chrome = await page.evaluate(() => ({
      qualities: [...document.getElementById('qualitySelect').options].map((o) => o.value),
      gear: document.querySelector('#videoSettings summary').getAttribute('aria-label'),
      // No "Play from" choice any more: MDY first, YouTube only as the fallback.
      playFrom: Boolean(document.getElementById('playSourceSelect')),
      // MDY's files have no captions, so no captions button while one plays.
      captions: getComputedStyle(document.getElementById('captionsStack')).display,
    }));
    expect(chrome.qualities).toEqual(['360', '720', '1080', 'audio']);
    expect(chrome.gear).toBe('Quality');
    expect(chrome.playFrom).toBe(false);
    expect(chrome.captions).toBe('none');
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
    // YouTube has captions, so the button is back.
    expect(await page.evaluate(() => document.body.classList.contains('playing-mdy-file'))).toBe(false);
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

  test('listen to the audio alone and back, in place, from More; the mp3 downloads from dafsync.com', async ({ page }) => {
    await openShiur(page, { videoSource: 'mdy' });
    await page.waitForFunction(() => document.getElementById('video').readyState >= 1, null, { timeout: 15000 });
    const before = await page.evaluate(() => state.mdyPlayback.url);
    const link = await page.evaluate(() => ({
      hidden: document.getElementById('moreDownloadLink').hidden,
      href: document.getElementById('moreDownloadLink').getAttribute('href'),
      name: document.getElementById('moreDownloadLink').getAttribute('download'),
      listen: document.getElementById('moreListenButton').hidden,
    }));
    expect(link.hidden).toBe(false);
    expect(link.listen).toBe(false);
    expect(link.href).toBe('/mdy-audio/shiur/english/chullin/mp3/89.mp3');
    expect(link.name).toBe("Chullin 89 - R' Eli Stefansky.mp3");

    await page.evaluate(() => { document.getElementById('video').currentTime = 5; });
    await page.waitForFunction(() => Math.abs(document.getElementById('video').currentTime - 5) < 0.5);
    await page.evaluate(() => document.getElementById('moreListenButton').click());
    await page.waitForFunction((mp3) => document.getElementById('video').getAttribute('src') === mp3, MDY_MP3);
    await page.waitForFunction(() => Math.abs(document.getElementById('video').currentTime - 5) < 0.6, null, { timeout: 15000 });
    expect(await page.evaluate(() => document.getElementById('moreListenButton').textContent)).toBe('Back to video');

    await page.evaluate(() => document.getElementById('moreListenButton').click());
    await page.waitForFunction((url) => document.getElementById('video').getAttribute('src') === url, before);
    expect(await page.evaluate(() => document.getElementById('moreListenButton').textContent)).toBe('Listen to audio only');
  });

  test('in Split view the audio controls are in the divider\u2019s drop-down, not More', async ({ page }) => {
    await openShiur(page, { videoSource: 'mdy' });
    await page.waitForFunction(() => document.getElementById('video').readyState >= 1, null, { timeout: 15000 });
    await page.evaluate(() => setViewerMode('split'));
    await page.evaluate(() => setSplitToolsOpen(true));
    await expect(page.locator('#splitListenButton')).toBeVisible();
    await expect(page.locator('#splitDownloadLink')).toBeVisible();
    expect(await page.locator('#splitDownloadLink').getAttribute('href')).toBe('/mdy-audio/shiur/english/chullin/mp3/89.mp3');
    expect(await page.evaluate(() => getComputedStyle(document.getElementById('moreListenButton')).display)).toBe('none');
    // "Skip to" is no longer in the drop-down.
    expect(await page.evaluate(() => {
      const chip = document.getElementById('skipToDafChip');
      return !chip || !document.getElementById('splitToolsPanel').contains(chip) || getComputedStyle(chip).display === 'none';
    })).toBe(true);
    await page.locator('#splitListenButton').click();
    await page.waitForFunction((mp3) => document.getElementById('video').getAttribute('src') === mp3, MDY_MP3);
    expect(await page.locator('#splitListenButton').getAttribute('aria-pressed')).toBe('true');
  });

  test('from YouTube, "listen to audio only" switches to MDY\u2019s mp3 in place', async ({ page }) => {
    await openShiur(page, { videoSource: 'youtube' });
    await page.waitForFunction(() => state.playerType === 'youtube' && window.__ytCued === 'mdyTest0001', null, { timeout: 15000 });
    expect(await page.evaluate(() => document.getElementById('moreListenButton').hidden)).toBe(false);
    await page.evaluate(() => { window.__yt._time = 3; });
    await page.evaluate(() => toggleMdyListen());
    await page.waitForFunction((mp3) => state.playerType === 'html5' && document.getElementById('video').getAttribute('src') === mp3, MDY_MP3);
    await page.waitForFunction(() => Math.abs(document.getElementById('video').currentTime - 3) < 0.6, null, { timeout: 15000 });
  });
});

// R' Sruly Bornstein's shiurim come from Lakewood Daf Yomi's own server, as
// audio (their podcast feed has no video), and never from YouTube.
test.describe('R’ Bornstein’s shiurim from Lakewood Daf Yomi’s server', () => {
  const LAKEWOOD = 'https://lakewoodafyomi.appspot.com/m5/X/Chulin%2089_1.mp3';
  const BORNSTEIN_LINK = { type: 'youtube', videoId: 'bornstein89', url: 'https://www.youtube.com/watch?v=bornstein89', label: 'Chulin 89' };

  async function openBornstein(page, { found = true } = {}) {
    await preparePage(page, { user: null, videoSource: 'mdy' });
    const requests = { lakewood: [], lookups: [], youtube: 0 };
    await page.route('**/api/lakewood-audio?*', (route) => {
      requests.lookups.push(Object.fromEntries(new URL(route.request().url()).searchParams));
      if (!found) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"none"}' });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ url: LAKEWOOD, seconds: 12, title: 'Chulin 89' }) });
    });
    await page.route(/^https:\/\/lakewoodafyomi\.appspot\.com\//, (route) => {
      requests.lakewood.push(route.request().url());
      const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range || '');
      if (!range) return route.fulfill({ status: 200, contentType: 'video/webm', headers: { 'Accept-Ranges': 'bytes' }, body: CLIP });
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), CLIP.length - 1) : CLIP.length - 1;
      return route.fulfill({ status: 206, contentType: 'video/webm',
        headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${CLIP.length}` },
        body: CLIP.subarray(start, end + 1) });
    });
    await page.route('https://www.youtube.com/**', (route) => { requests.youtube += 1; return route.abort(); });
    await page.route(/i\.ytimg\.com/, (route) => { requests.youtube += 1; return route.abort(); });
    await page.route('**/.netlify/images?*', (route) => route.fulfill({ status: 404, body: '' }));
    await page.route('**/api/daf-page**', (route) => route.fulfill({ status: 200, contentType: 'application/pdf', body: '%PDF-fake' }));
    await page.route('**/api/get-results-file**', (route) => {
      const path = new URL(route.request().url()).searchParams.get('path') || '';
      if (path === 'by-ref/Bornstein-Chullin-89a.json') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...alignment(CLIP_SECONDS), dafRef: 'Chullin 89a (Bornstein)' }) });
      }
      if (path === 'video-links/Bornstein-Chullin-89a.json') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(BORNSTEIN_LINK) });
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"missing"}' });
    });
    await page.goto('/player/?ref=Chullin+89a&maggid=bornstein');
    await page.waitForFunction(() => state.videoSource?.videoId === 'bornstein89', null, { timeout: 20000 });
    return requests;
  }

  test('plays as audio from their server, in the audio bar, with no video and no YouTube', async ({ page }) => {
    const requests = await openBornstein(page);
    await page.waitForFunction(() => document.getElementById('video').readyState >= 1, null, { timeout: 15000 });
    const now = await playing(page);
    expect(now.playerType).toBe('html5');
    expect(now.src).toBe(LAKEWOOD);
    expect(now.mdy).toEqual({ url: LAKEWOOD, quality: 'audio' });
    expect(now.badge).toBe('Lakewood Daf Yomi');
    expect(requests.lookups).toEqual([{ tractate: 'Chullin', daf: '89' }]);
    expect(requests.youtube).toBe(0);
    const bar = page.locator('#audioBar');
    await expect(bar).toBeVisible();
    await expect(bar.locator('#audioBarVideo')).toBeHidden();
    await expect(page.locator('.player-card')).toBeHidden();
    // Nothing about video: no quality choice, no "back to video".
    expect(await page.evaluate(() => ({
      quality: document.getElementById('qualityControl')?.hidden ?? true,
      listen: ['splitListenButton', 'moreListenButton'].map((id) => document.getElementById(id)?.hidden ?? true),
    }))).toEqual({ quality: true, listen: [true, true] });
    // The highlight's clock is the file's clock.
    await page.evaluate(() => { document.getElementById('video').currentTime = 6; });
    await page.waitForFunction(() => Math.abs(getCurrentTime() - 6) < 0.5);
  });

  test('a daf their server no longer has says so, and does not turn to YouTube', async ({ page }) => {
    const requests = await openBornstein(page, { found: false });
    await expect(page.locator('.toast')).toContainText("isn't on Lakewood Daf Yomi's server");
    expect(requests.youtube).toBe(0);
    expect(requests.lakewood).toEqual([]);
    expect(await page.evaluate(() => document.getElementById('video').getAttribute('src'))).toBeNull();
  });
});
