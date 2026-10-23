import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { preparePage } from '../support/harness.mjs';

// Live published alignments (results branch), played through the real player
// with a YouTube stand-in whose seekTo lags 150ms — the same gap that used
// to leave the highlight on the phrase the reader had just left.

const LIVE = 'https://dafsync.netlify.app/api/get-results-file?path=';
const FILES = [
  'by-ref/Bekhorot-34a.json',
  'by-ref/Chazarah-Daf-Bekhorot-30a.json',
  'video-links/Bekhorot-34a.json',
  'video-links/Chazarah-Daf-Bekhorot-30a.json',
];
const SHOTS = '/opt/cursor/artifacts/player-follow';

const YT_STUB = `
window.YT = window.YT || {};
window.YT.Player = function (id, options) {
  window.__playerVars = options.playerVars || {};
  const self = {
    _time: 0,
    _state: 5,
    _duration: 7200,
    seekTo(time) { setTimeout(() => { self._time = time; }, 150); },
    getCurrentTime() { return self._time; },
    getDuration() { return self._duration; },
    getPlayerState() { return self._state; },
    cueVideoById() { self._state = 5; },
    playVideo() { self._state = 1; options.events.onStateChange({ data: 1, target: self }); },
    pauseVideo() { self._state = 2; options.events.onStateChange({ data: 2, target: self }); },
    setPlaybackRate() {},
    getPlaybackRate() { return 1; },
    getVideoLoadedFraction() { return 1; },
    mute() {}, unMute() {}, isMuted() { return false; },
    setVolume() {}, getVolume() { return 100; },
    getAvailableQualityLevels() { return []; },
    addEventListener() {},
    destroy() {},
  };
  window.__yt = self;
  setTimeout(() => options.events.onReady({ target: self }), 0);
  return self;
};
if (typeof window.onYouTubeIframeAPIReady === 'function') window.onYouTubeIframeAPIReady();
`;

let files;

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  files = {};
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
    if (!body) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"missing"}' });
    return route.fulfill({ status: 200, contentType: 'application/json', body });
  });
}

async function openLiveDaf(page, url) {
  await preparePage(page, { user: null });
  await installLiveRoutes(page);
  await page.goto(url);
  await page.waitForFunction(() => state.segments.length > 20 && window.__yt, null, { timeout: 20000 });
}

async function shot(page, name) {
  if (test.info().project.name !== 'desktop') return;
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

function tapPairScript() {
  const counts = new Map();
  const keyOf = (segment) => `${segment.ref}:${segment.w0}:${segment.w1}`;
  for (const segment of state.segments) counts.set(keyOf(segment), (counts.get(keyOf(segment)) || 0) + 1);
  for (let later = 4; later < state.segments.length; later += 1) {
    const earlier = later - 2;
    const a = state.segments[earlier];
    const b = state.segments[later];
    if (!a || !b || a.estimated || b.estimated) continue;
    if (counts.get(keyOf(a)) !== 1 || counts.get(keyOf(b)) !== 1) continue;
    if (b.start - a.start < 3) continue;
    return { earlier, later };
  }
  return null;
}

test.describe('live alignments follow taps, the intro, and gaps', () => {
  test('Bekhorot 30a Chazarah: intro, lead-in, taps while playing and paused, gap dim', async ({ page }) => {
    test.setTimeout(60000);
    await openLiveDaf(page, '/player/?ref=Bekhorot+30a&variant=chazarah');

    const intro = await page.evaluate(() => ({
      active: state.activeIndex,
      ref: document.getElementById('currentRef').textContent,
      title: document.getElementById('dafTitle').textContent,
      chip: document.getElementById('skipToDafChip')?.textContent || '',
      chipHidden: document.getElementById('skipToDafChip')?.hidden,
      own: ownContentStartTime(),
      disablekb: window.__playerVars?.disablekb,
    }));
    expect(intro.active).toBe(-1);
    expect(intro.ref).toBe('Intro');
    expect(intro.title).toContain('Bekhorot 30a');
    expect(intro.chipHidden).toBe(false);
    expect(intro.chip).toContain('Skip to Bekhorot 30a');
    expect(intro.own).toBeGreaterThan(140);
    expect(intro.own).toBeLessThan(170);
    expect(intro.disablekb).toBe(1);
    await shot(page, 'bekhorot-30-chazarah-intro');

    const reviewing = await page.evaluate(() => {
      const lead = state.segments.find((segment) => !segment.estimated
        && segmentDafKey(segment.ref) === 'Bekhorot 29b'
        && segment.start + 1 < ownContentStartTime());
      window.__yt._time = lead.start + 0.2;
      state.pendingSeek = null;
      state.phrasePin = null;
      state.lastObservedTime = window.__yt._time;
      updateActiveSegment(true);
      return {
        ref: document.getElementById('currentRef').textContent,
        label: document.getElementById('reviewingLabel')?.textContent || '',
        title: document.getElementById('dafTitle').textContent,
      };
    });
    expect(reviewing.label).toContain('Reviewing');
    expect(reviewing.label).toContain('29b');
    expect(reviewing.title).toContain('30a');
    await shot(page, 'bekhorot-30-chazarah-reviewing');

    const pair = await page.evaluate(tapPairScript);
    expect(pair).toBeTruthy();

    const placed = await page.evaluate(({ later }) => {
      stopYouTubePoll();
      const time = state.segments[later].start + 0.2;
      window.__yt._time = time;
      window.__yt._state = 1;
      state.pendingSeek = null;
      state.phrasePin = null;
      state.lastObservedTime = time;
      updateActiveSegment(true, time);
      startYouTubePoll();
      return state.activeIndex;
    }, pair);
    expect(placed).toBe(pair.later);

    await page.locator(`.daf-segment[data-index="${pair.earlier}"]`).dispatchEvent('click');
    expect(await page.evaluate(() => state.activeIndex)).toBe(pair.earlier);
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => state.activeIndex)).toBe(pair.earlier);
    await shot(page, 'bekhorot-30-chazarah-backward-tap');

    await page.locator(`.daf-segment[data-index="${pair.later}"]`).dispatchEvent('click');
    expect(await page.evaluate(() => state.activeIndex)).toBe(pair.later);
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => state.activeIndex)).toBe(pair.later);

    await page.evaluate(() => window.__yt.pauseVideo());
    await page.evaluate(({ later }) => {
      window.__yt._time = state.segments[later].start + 0.2;
      state.pendingSeek = null;
      state.phrasePin = null;
      state.lastObservedTime = window.__yt._time;
      updateActiveSegment(true);
    }, pair);
    await page.locator(`.daf-segment[data-index="${pair.earlier}"]`).dispatchEvent('click');
    expect(await page.evaluate(() => state.activeIndex)).toBe(pair.earlier);
    await page.waitForTimeout(700);
    expect(await page.evaluate(() => state.activeIndex)).toBe(pair.earlier);
    expect(await page.evaluate(() => state.youtubePlayer.getPlayerState())).toBe(2);

    const gap = await page.evaluate(() => {
      // A phrase can share its start with a longer neighbor, so "3s after
      // this phrase's end" is only a gap when no other phrase still covers it.
      const segments = state.segments;
      for (let i = 0; i < segments.length; i += 1) {
        const end = Number(segments[i].end);
        if (!Number.isFinite(end)) continue;
        const time = end + 3.5;
        if (time <= segments[0].start || findSegmentAt(time) !== -1) continue;
        state.pendingSeek = null;
        state.phrasePin = null;
        updateActiveSegment(true, time);
        return {
          active: state.activeIndex,
          ref: document.getElementById('currentRef').textContent,
        };
      }
      return null;
    });
    expect(gap).toBeTruthy();
    expect(gap.active).toBe(-1);
    expect(gap.ref).toBe('Between phrases');
    await shot(page, 'bekhorot-30-chazarah-gap');

    expect(await page.locator('.daf-segment.estimated').count()).toBeGreaterThan(0);

    const marked = await page.evaluate(() => {
      const index = state.segments.findIndex((segment) => !segment.estimated);
      const before = state.segments[index].start;
      document.body.classList.remove('is-admin');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', code: 'KeyM', bubbles: true }));
      return { before, after: state.segments[index].start };
    });
    expect(marked.after).toBe(marked.before);
  });

  test('Bekhorot 34a: intro names the requested amud and offers the real start', async ({ page }) => {
    test.setTimeout(60000);
    await openLiveDaf(page, '/player/?ref=Bekhorot+34a');

    const intro = await page.evaluate(() => ({
      active: state.activeIndex,
      ref: document.getElementById('currentRef').textContent,
      title: document.getElementById('dafTitle').textContent,
      chip: document.getElementById('skipToDafChip')?.textContent || '',
      own: ownContentStartTime(),
    }));
    expect(intro.active).toBe(-1);
    expect(intro.ref).toBe('Intro');
    expect(intro.title).toContain('Bekhorot 34a');
    expect(intro.title).not.toContain('33b');
    expect(intro.chip).toContain('Skip to Bekhorot 34a');
    expect(intro.own).toBeGreaterThan(600);
    expect(intro.own).toBeLessThan(2000);
    await shot(page, 'bekhorot-34a-intro');

    const lead = await page.evaluate(() => {
      const previous = state.segments.find((segment) => !segment.estimated
        && segmentDafKey(segment.ref) === 'Bekhorot 33b'
        && segment.start + 1 < ownContentStartTime());
      window.__yt._time = previous.start + 0.2;
      state.pendingSeek = null;
      state.phrasePin = null;
      updateActiveSegment(true);
      return {
        label: document.getElementById('reviewingLabel')?.textContent || '',
        title: document.getElementById('dafTitle').textContent,
        chip: document.getElementById('skipToDafChip')?.hidden,
      };
    });
    expect(lead.label).toContain('33b');
    expect(lead.title).toContain('34a');
    expect(lead.chip).toBe(false);

    const gap = await page.evaluate(() => {
      const segments = state.segments;
      for (let i = 0; i < segments.length; i += 1) {
        const end = Number(segments[i].end);
        if (!Number.isFinite(end)) continue;
        const time = end + 3.5;
        if (time <= segments[0].start || findSegmentAt(time) !== -1) continue;
        state.pendingSeek = null;
        state.phrasePin = null;
        updateActiveSegment(true, time);
        return state.activeIndex;
      }
      return null;
    });
    expect(gap).toBe(-1);
    await shot(page, 'bekhorot-34a-gap');
  });
});

test.describe('player labels, keys, and the wake layer', () => {
  test('reader-facing labels match phrase-level sync', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Bekhorot+34a');
    await expect(page.locator('#dafTitle')).toContainText('Bekhorot 34a');
    await expect(page.locator('#lectureTitle')).toContainText('Bekhorot 34a');
    await expect(page.locator('#currentRef')).toContainText('Loading');
    await expect(page.locator('.detail-pill', { hasText: 'Phrase-level sync' })).toBeVisible();
    await expect(page.locator('.detail-pill', { hasText: 'Word-level sync' })).toHaveCount(0);
    await expect(page.locator('#autoScroll')).toBeChecked();
    await expect(page.locator('#alignmentStatus')).toBeHidden();
    await expect(page.locator('#currentTranslation')).toBeHidden();
  });

  test('a click on faded controls activates the control underneath', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/watch/?ref=Chullin%2089a');
    await expect(page.locator('#playButton')).toBeAttached();
    const point = await page.evaluate(() => {
      const rect = document.getElementById('playButton').getBoundingClientRect();
      window.__playClicks = 0;
      document.getElementById('playButton').addEventListener('click', () => { window.__playClicks += 1; });
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await page.mouse.move(point.x, point.y);
    await page.evaluate(() => document.getElementById('videoFrame').classList.add('controls-hidden'));
    await page.mouse.down();
    await page.mouse.up();
    expect(await page.evaluate(() => window.__playClicks)).toBe(1);
    expect(await page.evaluate(() => document.getElementById('videoFrame').classList.contains('controls-hidden'))).toBe(false);
  });
});
