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

  // A reader paused a shiur, left the tab for a few minutes and came back: each
  // tap on a word moved the highlight, and the recording stayed where it was.
  test('the lock screen shows an MDY shiur with its picture, and nothing while YouTube plays', async ({ page }) => {
    await openShiur(page);
    await page.waitForFunction(() => document.getElementById('video').readyState >= 1, null, { timeout: 15000 });
    await page.waitForFunction(() => navigator.mediaSession.metadata && navigator.mediaSession.metadata.title);
    const told = await page.evaluate(() => {
      const m = navigator.mediaSession.metadata;
      return { title: m.title, artist: m.artist, artwork: m.artwork.map((a) => decodeURIComponent(new URL(a.src).search)) };
    });
    expect(told.title).toBe('Chullin 89');
    expect(told.artist).toBe("R' Eli Stefansky");
    expect(told.artwork[0]).toContain('https://cdn.mdydaf.com/shiur/english/chullin/thumb/89.png');
    // On to YouTube: YouTube's own frame answers the lock screen, so the page says nothing.
    await page.evaluate(() => { switchPlayerType('youtube'); updateMediaSession(); });
    expect(await page.evaluate(() => ({ metadata: navigator.mediaSession.metadata, state: navigator.mediaSession.playbackState })))
      .toEqual({ metadata: null, state: 'none' });
  });

  test('a seek the player does not make is sent again, and then on a fresh load of the file', async ({ page }) => {
    await openShiur(page);
    await page.waitForFunction(() => document.getElementById('video').readyState >= 1, null, { timeout: 15000 });
    // The element takes the first `drop` seeks and stays where it is.
    const dropSeeks = (drop) => page.evaluate((count) => {
      const video = document.getElementById('video');
      const real = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
      window.__sent = [];
      window.__loads = 0;
      Object.defineProperty(video, 'currentTime', {
        configurable: true,
        get() { return real.get.call(this); },
        set(value) { window.__sent.push(value); if (window.__sent.length > count) real.set.call(this, value); },
      });
      if (!video.__load) {
        video.__load = video.load;
        video.load = function load() { window.__loads += 1; return video.__load.call(this); };
      }
    }, drop);
    const where = () => page.evaluate(() => Math.round(document.getElementById('video').currentTime));

    await dropSeeks(1);
    await page.evaluate(() => activatePhrase(1));          // the second phrase starts at 5s
    expect(await where()).toBe(0);
    await expect.poll(where, { timeout: 6000 }).toBe(5);
    expect(await page.evaluate(() => ({ sent: window.__sent.length, loads: window.__loads }))).toEqual({ sent: 2, loads: 0 });

    // Twice ignored: the file is loaded afresh, and the seek made there.
    await page.evaluate(() => seek(0));
    await expect.poll(where, { timeout: 6000 }).toBe(0);
    await dropSeeks(2);
    await page.evaluate(() => activatePhrase(1));
    await expect.poll(where, { timeout: 12000 }).toBe(5);
    expect(await page.evaluate(() => window.__loads)).toBe(1);

    // A seek that landed is left alone, and so is the scrubber's own.
    await dropSeeks(0);
    await page.evaluate(() => seek(8));
    await page.waitForTimeout(1900);
    expect(await page.evaluate(() => ({ sent: window.__sent, loads: window.__loads }))).toEqual({ sent: [8], loads: 0 });
    await page.evaluate(() => { seek(2); applyScrubSeek(9, true); });
    await page.waitForTimeout(1900);
    expect(await where()).toBe(9);
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
  // As tools/lakewood-import.mjs writes it: Lakewood's own id and the feed's mp3.
  const BORNSTEIN_LINK = { type: 'lakewood', videoId: 'L0000000089', url: LAKEWOOD, label: 'Chulin 89', source: 'lakewood-feed', maggid: 'bornstein' };

  async function openBornstein(page, { found = true, synced = true, voice = false } = {}) {
    await preparePage(page, { user: null, videoSource: 'mdy' });
    const requests = { lakewood: [], lookups: [], youtube: 0 };
    await page.route('**/api/lakewood-audio?*', (route) => {
      requests.lookups.push(Object.fromEntries(new URL(route.request().url()).searchParams));
      if (!found) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"none"}' });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ url: LAKEWOOD, seconds: 12, title: 'Chulin 89' }) });
    });
    await page.route(/^https:\/\/lakewoodafyomi\.appspot\.com\//, (route) => {
      requests.lakewood.push(route.request().url());
      if (!found) return route.fulfill({ status: 404, body: '' });
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
      if (path === 'by-ref/Bornstein-Chullin-89a.json' && synced) {
        const voiceSync = voice ? { generator: 'voice_align.py', matchStats: { aligner: 'path', straightPath: true } } : {};
        return route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify({ ...alignment(CLIP_SECONDS), dafRef: 'Chullin 89a (Bornstein)', ...voiceSync }) });
      }
      if (path === 'video-links/Bornstein-Chullin-89a.json') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(BORNSTEIN_LINK) });
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"missing"}' });
    });
    await page.goto('/player/?ref=Chullin+89a&maggid=bornstein');
    await page.waitForFunction(() => state.videoSource?.videoId === 'L0000000089', null, { timeout: 20000 });
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
    // The link has the feed's address: nothing looked up, and the source is Lakewood's.
    expect(requests.lookups).toEqual([]);
    expect(await page.evaluate(() => state.videoSource.type)).toBe('lakewood');
    expect(requests.youtube).toBe(0);
    const bar = page.locator('#audioBar');
    await expect(bar).toBeVisible();
    await expect(bar.locator('#audioBarVideo')).toBeHidden();
    await expect(bar.locator('#audioBarDownload')).toHaveAttribute('href', '/lakewood-audio/Chulin%2089_1.mp3');
    await expect(bar.locator('#audioBarDownload')).toHaveAttribute('download', "Chullin 89 - R' Sruly Bornstein.mp3");
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

  // The phone's lock screen and notification shade, and headphone buttons:
  // navigator.mediaSession is what the page tells them, and what they call back.
  test('the lock screen shows the daf, R\u2019 Bornstein and his picture, and its buttons drive the shiur', async ({ page }) => {
    await openBornstein(page);
    await page.waitForFunction(() => document.getElementById('video').readyState >= 1, null, { timeout: 15000 });
    await page.waitForFunction(() => navigator.mediaSession.metadata && navigator.mediaSession.metadata.title);
    const told = await page.evaluate(() => {
      const m = navigator.mediaSession.metadata;
      return { title: m.title, artist: m.artist, album: m.album, artwork: m.artwork.map((a) => new URL(a.src).pathname), state: navigator.mediaSession.playbackState };
    });
    expect(told).toEqual({ title: 'Chullin 89', artist: "R' Sruly Bornstein", album: 'DafSync', artwork: ['/assets/maggidim/bornstein-v1.jpg'], state: 'paused' });

    // The handlers the page gave the phone, called as the phone would call them.
    const calls = await page.evaluate(async () => {
      const handlers = {};
      const real = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);
      navigator.mediaSession.setActionHandler = (action, handler) => { handlers[action] = handler; real(action, handler); };
      setUpMediaSession();
      const video = document.getElementById('video');
      const at = () => Math.round(video.currentTime * 10) / 10;
      const out = { actions: Object.keys(handlers).sort() };
      video.currentTime = 3;
      await new Promise((resolve) => setTimeout(resolve, 200));
      handlers.seekforward({});
      await new Promise((resolve) => setTimeout(resolve, 200));
      out.afterForward = at();
      handlers.seekbackward({ seekOffset: 5 });
      await new Promise((resolve) => setTimeout(resolve, 200));
      out.afterBack = at();
      handlers.seekto({ seekTime: 0.2 });
      await new Promise((resolve) => setTimeout(resolve, 200));
      out.afterSeekTo = at();
      // "Next" on headphones is Vaater: the next line he reads (the sync's phrases start at 1s and 5s).
      handlers.nexttrack({});
      await new Promise((resolve) => setTimeout(resolve, 300));
      out.afterNext = at();
      return out;
    });
    expect(calls.actions).toEqual(['nexttrack', 'pause', 'play', 'seekbackward', 'seekforward', 'seekto']);
    expect(calls.afterForward).toBeCloseTo(11.5, 0);   // 10 s on, held short of the clip's end
    expect(calls.afterBack).toBeCloseTo(6.5, 0);
    expect(calls.afterSeekTo).toBeCloseTo(0.2, 0);
    expect(calls.afterNext).toBe(1);
  });

  test("the audio bar's Vaater skips on to the daf's next synced phrase, as the video player's does", async ({ page }) => {
    await openBornstein(page);
    await page.waitForFunction(() => document.getElementById('video').readyState >= 1, null, { timeout: 15000 });
    const vaater = page.locator('#audioBar #audioBarVaater');
    await expect(vaater).toBeVisible();
    await expect(vaater).toBeEnabled();
    const where = () => page.evaluate(() => Math.round(document.getElementById('video').currentTime));
    // The sync's phrases start at 1s and 5s.
    await vaater.click();
    await expect.poll(where).toBe(1);
    // (A second press inside 2.5s chains on from the end of the phrase it went
    // to -- skipToNextReading -- which in this sync is where the next begins.)
    await page.waitForTimeout(2600);
    await vaater.click();
    await expect.poll(where).toBe(5);
    // Past the last phrase there is nowhere to go.
    await page.evaluate(() => { seek(11); updateVaaterButtonUi(11); });
    await expect(vaater).toBeDisabled();
  });

  // R' Bornstein's Eruchin 2: he reads line 1 at 11:58 and explains it, and
  // the line stays lit until he reads on. As a caption sync's "held" line it
  // was jumped over, and Vaater went from the start of the shiur to 15:23.
  test('in a voice sync Vaater lands on every phrase, though he explained it at length', async ({ page }) => {
    await openBornstein(page, { voice: true });
    await page.waitForFunction(() => state.segments.length > 0, null, { timeout: 15000 });
    const held = (voice) => page.evaluate((straight) => {
      state.straightPathSync = straight;
      state.activeIndex = -1;
      state.segments = [
        { ref: 'Chullin 89a:1', w0: 0, w1: 0, start: 718, end: 718, he: 'א' },        // as voice_align.py writes them: ending where they start
        { ref: 'Chullin 89a:1', w0: 1, w1: 1, start: 718.06, end: 731, he: 'ב' },     // then 13s of explanation
        { ref: 'Chullin 89a:1', w0: 2, w1: 2, start: 731, end: 751, he: 'ג' },
        { ref: 'Chullin 89a:2', w0: 0, w1: 4, start: 751, end: 754, he: 'ד ה ו ז ח' },
        { ref: 'Chullin 89a:2', w0: 5, w1: 6, start: 754, end: 760, he: 'ט י' },
      ];
      return nextReadingTime(0);
    }, voice);
    expect(await page.evaluate(() => state.straightPathSync)).toBe(true);   // from the file
    expect(await held(true)).toBe(718);
    // A caption sync keeps skipping a line held far longer than reading it takes.
    expect(await held(false)).toBe(751);
  });

  test('the speed picker on a narrow phone: the arrows for Vaater, the list above the bar', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await openBornstein(page);
    await page.waitForFunction(() => document.getElementById('video').readyState >= 1, null, { timeout: 15000 });
    const bar = page.locator('#audioBar');
    // Everything on one row, nothing pushed off the screen.
    const right = await page.evaluate(() => Math.max(...[...document.querySelectorAll('#audioBar .audio-bar-row > *')]
      .filter((el) => el.offsetParent !== null).map((el) => el.getBoundingClientRect().right)));
    expect(right).toBeLessThanOrEqual(360);
    await bar.locator('#audioBarSpeed').click();
    const list = page.locator('#audioBarSpeedMenu');
    await expect(list).toBeVisible();
    const box = await list.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(360);
    await list.locator('li', { hasText: '2×' }).click();
    await expect(bar.locator('#audioBarSpeed')).toHaveText('2×');
    expect(await page.evaluate(() => document.getElementById('video').playbackRate)).toBe(2);
  });

  // His shiurim before Eruchin 2 are linked to listen to, with no sync. The daf
  // used to be given placeholder timing (each line an equal share of the hour),
  // which lit lines and seeked on taps as if it were a sync of what he says.
  test('a shiur with no sync shows the daf without highlighting, and a tap says it is not synced', async ({ page }) => {
    await openBornstein(page, { synced: false });
    await page.waitForFunction(() => state.segments.length > 0 && state.alignmentStatus === 'placeholder', null, { timeout: 20000 });
    expect(await page.evaluate(() => ({ unsynced: state.unsyncedDaf, active: state.activeIndex }))).toEqual({ unsynced: true, active: -1 });
    await page.evaluate(() => { document.getElementById('video').currentTime = 6; updateActiveSegment(true); });
    expect(await page.evaluate(() => state.activeIndex)).toBe(-1);
    await page.evaluate(() => { document.querySelectorAll('.toast').forEach((t) => { t.textContent = ''; }); });
    const before = await page.evaluate(() => getCurrentTime());
    await page.evaluate(() => seekToVilnaWord(state.segments[1].ref, 0));
    await expect(page.locator('.toast')).toContainText("isn't synced with the daf yet");
    expect(Math.abs((await page.evaluate(() => getCurrentTime())) - before)).toBeLessThan(0.5);
    // The audio bar's Vaater has no phrase to go to either.
    await page.evaluate(() => { document.querySelectorAll('.toast').forEach((t) => { t.textContent = ''; }); });
    const vaater = page.locator('#audioBar #audioBarVaater');
    if (await vaater.isEnabled()) {
      await vaater.click();
      await expect(page.locator('.toast')).toContainText("isn't synced with the daf yet");
    }
    expect(Math.abs((await page.evaluate(() => getCurrentTime())) - before)).toBeLessThan(0.5);
  });

  test('a file their server does not send says so, and does not turn to YouTube', async ({ page }) => {
    const requests = await openBornstein(page, { found: false });
    await expect(page.locator('.toast')).toContainText("didn't load from Lakewood Daf Yomi's server");
    expect(requests.youtube).toBe(0);
    expect(await page.evaluate(() => state.videoSource.type)).toBe('lakewood');
  });
});
