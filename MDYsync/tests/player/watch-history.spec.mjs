import { test, expect } from '@playwright/test';
import { preparePage, failOnPageError, stubPrintedPage } from '../support/harness.mjs';

// The player remembers, on this device, how far the reader got in each
// shiur (dafsync.watchHistory) for the home page's Continue learning row,
// and a link from that row (?t=<seconds>) resumes there.

const readHistory = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('dafsync.watchHistory') || '[]'));

async function playAt(page, seconds) {
  await page.evaluate((at) => {
    state.videoSource = { type: 'youtube', videoId: 'HISTVID0001' };
    window.getCurrentTime = () => at;
    window.getDuration = () => 2400;
    window.dispatchEvent(new Event('pagehide'));
  }, seconds);
}

test.describe('Watch history', () => {
  test('leaving a shiur remembers the daf, its recording and the time reached', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a&variant=chazarah&mode=split');
    await playAt(page, 125.6);
    const [entry] = await readHistory(page);
    expect(entry).toMatchObject({
      ref: 'Chullin 89a',
      url: '/player/?ref=Chullin+89a&variant=chazarah',
      videoId: 'HISTVID0001',
      time: 125,
      duration: 2400,
    });
  });

  test('one entry per shiur, the latest first', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    await playAt(page, 60);
    await page.goto('/player/?ref=Chullin%2090a');
    await playAt(page, 90);
    await page.goto('/player/?ref=Chullin%2089a');
    await playAt(page, 300);
    const history = await readHistory(page);
    expect(history.map((entry) => [entry.ref, entry.time])).toEqual([['Chullin 89a', 300], ['Chullin 90a', 90]]);
  });

  test('the first few seconds are not worth remembering', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    await playAt(page, 3);
    expect(await readHistory(page)).toEqual([]);
  });

  test('?t= starts the shiur where the reader stopped', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await stubPrintedPage(page);
    const VIDEO = 'Zsy7oDUP6Pw';
    const files = {
      'by-ref/Bekhorot-2a.json': {
        schema: 'dafsync-alignment-v2', dafRef: 'Bekhorot 2a', duration: 3000, videoId: VIDEO,
        segments: [
          { ref: 'Bekhorot 2a:1', start: 100, end: 400, he: 'משנה ראשונה', w0: 0, w1: 1, estimated: false },
          { ref: 'Bekhorot 2a:2', start: 400, end: 900, he: 'משנה שניה', w0: 0, w1: 1, estimated: false },
        ],
      },
      'video-links/Bekhorot-2a.json': { type: 'youtube', videoId: VIDEO, url: `https://www.youtube.com/watch?v=${VIDEO}`, label: 'Bechoros 2' },
    };
    await page.route('**/api/get-results-file?*', (route) => {
      const path = new URL(route.request().url()).searchParams.get('path');
      if (path in files) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(files[path]) });
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not found."}' });
    });
    // A stand-in for YouTube's player that records where it was asked to go.
    await page.route('https://www.youtube.com/**', (route) => route.abort());
    await page.route('https://www.youtube.com/iframe_api*', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: `
      window.YT = window.YT || {};
      window.YT.Player = function (id, options) {
        const self = {
          _time: 0, seeks: [],
          seekTo(time) { self._time = Number(time) || 0; self.seeks.push(self._time); },
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
    ` }));
    await page.goto('/player/?ref=Bekhorot%202a&t=300');
    await expect.poll(() => page.evaluate(() => window.__yt?.seeks || [])).toContain(300);
  });
});
