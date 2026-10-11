import { test, expect } from '@playwright/test';
import { preparePage, stubPrintedPage } from '../support/harness.mjs';

// Another maggid's recording (R' Sruly Bernstein, Lakewood Daf Yomi) plays through
// the same player under its own key prefix; and a TEST SHIUR -- the video the voice
// models are tuned on -- offers every numbered run of both engines in two
// dropdowns, to every reader.

const VIDEO = 'Zsy7oDUP6Pw';

function alignment(label, firstStart) {
  return {
    schema: 'dafsync-alignment-v2',
    dafRef: 'Bekhorot 2a',
    duration: 3000,
    generator: label === 'live' ? 'live-video.js' : 'voice_align.py',
    videoId: VIDEO,
    segments: [
      { ref: 'Bekhorot 2a:1', start: firstStart, end: firstStart + 20, he: 'משנה ראשונה', w0: 0, w1: 1, estimated: false },
      { ref: 'Bekhorot 2a:2', start: firstStart + 20, end: firstStart + 40, he: 'משנה שניה', w0: 0, w1: 1, estimated: true },
    ],
    wordTimeline: [{ start: firstStart, end: firstStart + 20, ref: 'Bekhorot 2a:1', w0: 0, w1: 1, heardText: label }],
  };
}
const RUNS = [
  { id: 'regular-1', engine: 'regular', number: 1, name: 'Regular #1 · 10 Oct 2026 · baseline', file: 'regular-1.json', summary: { placedWords: 412 } },
  { id: 'live-1', engine: 'live', number: 1, name: 'Live #1 · 10 Oct 2026 · baseline', file: 'live-1.json', summary: { placedWords: 284 } },
  { id: 'regular-2', engine: 'regular', number: 2, name: 'Regular #2 · 11 Oct 2026 · pending survives misses', file: 'regular-2.json', summary: { placedWords: 430 } },
];
const FILES = {
  'test-runs/Zsy7oDUP6Pw/index.json': { schema: 'dafsync-test-runs-v1', videoId: VIDEO, runs: RUNS },
  'test-runs/Zsy7oDUP6Pw/regular-1.json': alignment('regular', 100),
  'test-runs/Zsy7oDUP6Pw/regular-2.json': alignment('regular', 200),
  'test-runs/Zsy7oDUP6Pw/live-1.json': alignment('live', 300),
};

async function open(page, { url = '/player/?ref=Bekhorot%202a&maggid=bernstein', files = FILES } = {}) {
  const asked = [];
  await preparePage(page);
  await stubPrintedPage(page);
  await page.route('**/api/get-results-file?*', (route) => {
    const path = new URL(route.request().url()).searchParams.get('path');
    asked.push(path);
    if (path in files) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(files[path]) });
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not found."}' });
  });
  await page.goto(url);
  await expect.poll(() => page.evaluate(() => typeof refreshTestRuns)).toBe('function');
  return asked;
}

// What the player does once a YouTube video is loaded, without needing YouTube.
const showVideo = (page, videoId = VIDEO) => page.evaluate(async (id) => {
  state.videoSource = { type: 'youtube', videoId: id, url: `https://www.youtube.com/watch?v=${id}`, label: 'Bechoros 2' };
  await refreshTestRuns(id);
}, videoId);

test.describe('Another maggid\'s recording', () => {
  test('?maggid=bernstein looks everything up under the Bernstein prefix', async ({ page }) => {
    const asked = await open(page, {
      files: { 'video-links/Bernstein-Bekhorot-2a.json': { type: 'youtube', videoId: 'Zsy7oDUP6Pw', url: `https://www.youtube.com/watch?v=${VIDEO}`, label: 'Bechoros 2', maggid: 'bernstein' } },
    });
    await expect.poll(() => asked.some((p) => p.startsWith('by-ref/Voice-Bernstein-Bekhorot-2a'))).toBe(true);
    expect(asked).toContain('by-ref/Bernstein-Bekhorot-2a.json');
    expect(asked).toContain('by-ref/Voice-Bernstein-Bekhorot-2a.json');
    expect(asked.filter((p) => /^(by-ref|video-links)\/(Voice-)?Bekhorot-/.test(p))).toEqual([]); // never the other maggid's keys
    expect(await page.evaluate(() => state.maggid)).toBe('bernstein');
    expect(await page.evaluate(() => document.getElementById('dafRef').value)).toBe('Bekhorot 2a (Bernstein)');
  });

  test('without it the keys are the default maggid\'s, as always', async ({ page }) => {
    const asked = await open(page, { url: '/player/?ref=Bekhorot%202a' });
    await expect.poll(() => asked.some((p) => p === 'by-ref/Voice-Bekhorot-2a.json')).toBe(true);
    expect(asked.filter((p) => p.includes('Bernstein'))).toEqual([]);
    expect(await page.evaluate(() => state.maggid)).toBeNull();
  });

  test('the ref helpers keep the maggid through every kind of ref the page builds', async ({ page }) => {
    await open(page, { url: '/player/' });
    const r = await page.evaluate(() => ({
      parsed: parseDafRef('Bekhorot 2a (Hebrew) (Bernstein)'),
      key: refKey('Bekhorot 2a (Bernstein)'),
      voiceKey: refKey('Bekhorot 2a (Bernstein)', { voice: true }),
      hebrewKey: refKey('Bekhorot 2a (Hebrew) (Bernstein)'),
      plainKey: refKey('Bekhorot 2a'),
      next: nextDafRef('Bekhorot 2a (Bernstein)'),
      prev: prevDafRef('Bekhorot 3a (Bernstein)'),
      canonical: canonicalDafRef('bekhorot 2a (bernstein)'),
      real: realDafRef('Bekhorot 2a (Bernstein)'),
      segment: normalizeDafParagraphRef('Bekhorot 2a (Bernstein):3'),
    }));
    expect(r.parsed).toMatchObject({ tractate: 'Bekhorot', daf: 2, amud: 'a', language: 'he', maggid: 'bernstein' });
    expect(r.key).toBe('Bernstein-Bekhorot-2a');
    expect(r.voiceKey).toBe('Voice-Bernstein-Bekhorot-2a');
    expect(r.hebrewKey).toBe('Bernstein-Hebrew-Bekhorot-2a');
    expect(r.plainKey).toBe('Bekhorot-2a');
    expect(r.next).toBe('Bekhorot 2b (Bernstein)');
    expect(r.prev).toBe('Bekhorot 2b (Bernstein)');
    expect(r.canonical).toBe('Bekhorot 2a (Bernstein)');
    expect(r.real).toBe('Bekhorot 2a');
    expect(r.segment).toBe('Bekhorot 2a.3');
  });
});

test.describe('Test shiur — one dropdown per engine, numbered runs', () => {
  test('a video with test runs shows both dropdowns, each listing only its own engine\'s runs, newest first', async ({ page }) => {
    await open(page);
    await expect(page.locator('#testRuns')).toBeHidden();
    await showVideo(page);
    await expect(page.locator('#testRuns')).toBeVisible();
    await expect(page.locator('#testRunRegularSelect option')).toHaveText([
      'Choose a regular engine alignment…',
      'Regular #2 · 11 Oct 2026 · pending survives misses — 430 words placed',
      'Regular #1 · 10 Oct 2026 · baseline — 412 words placed',
    ]);
    await expect(page.locator('#testRunLiveSelect option')).toHaveText([
      'Choose a live engine alignment…',
      'Live #1 · 10 Oct 2026 · baseline — 284 words placed',
    ]);
    await expect(page.locator('#testRunNote')).toHaveText('Showing the default alignment. Pick a run to compare.');
  });

  test('it is there for every reader, signed in or not', async ({ page }) => {
    await open(page);
    await showVideo(page);
    await expect(page.locator('#testRuns')).toBeVisible();
    expect(await page.evaluate(() => document.querySelector('#testRuns').closest('.admin-only'))).toBeNull();
    expect(await page.locator('#testRuns').evaluate((el) => el.classList.contains('admin-only'))).toBe(false);
  });

  test('picking a run loads that alignment; picking from the other dropdown swaps it, and the first resets', async ({ page }) => {
    await open(page);
    await showVideo(page);
    await page.locator('#testRunRegularSelect').selectOption('regular-1');
    await expect.poll(() => page.evaluate(() => state.testRuns.activeId)).toBe('regular-1');
    expect(await page.evaluate(() => state.segments.filter((s) => s.start > 0).map((s) => s.start))).toEqual([100, 120]);
    expect(await page.evaluate(() => state.wordTimeline[0].heardText)).toBe('regular');
    await expect(page.locator('#testRunNote')).toHaveText('Showing Regular #1 · 10 Oct 2026 · baseline.');

    await page.locator('#testRunLiveSelect').selectOption('live-1');
    await expect.poll(() => page.evaluate(() => state.testRuns.activeId)).toBe('live-1');
    expect(await page.evaluate(() => state.segments.filter((s) => s.start > 0).map((s) => s.start))).toEqual([300, 320]);
    await expect(page.locator('#testRunRegularSelect')).toHaveValue('');
    await expect(page.locator('#testRunLiveSelect')).toHaveValue('live-1');

    await page.locator('#testRunRegularSelect').selectOption('regular-2');
    await expect.poll(() => page.evaluate(() => Math.max(...state.segments.map((s) => s.start)))).toBe(220);
    await expect(page.locator('#testRunLiveSelect')).toHaveValue('');
  });

  test('the daf being read stays the maggid\'s own while runs are swapped', async ({ page }) => {
    await open(page);
    await showVideo(page);
    await page.locator('#testRunLiveSelect').selectOption('live-1');
    await expect.poll(() => page.evaluate(() => state.testRuns.activeId)).toBe('live-1');
    expect(await page.evaluate(() => state.dafRef)).toBe('Bekhorot 2a (Bernstein)');
  });

  test('a video without test runs shows no dropdowns, and moving to one hides them again', async ({ page }) => {
    await open(page);
    await showVideo(page, 'aaaaaaaaaaa');
    await expect(page.locator('#testRuns')).toBeHidden();
    await showVideo(page);
    await expect(page.locator('#testRuns')).toBeVisible();
    await showVideo(page, 'bbbbbbbbbbb');
    await expect(page.locator('#testRuns')).toBeHidden();
    expect(await page.evaluate(() => state.testRuns)).toBeNull();
  });

  test('an alignment that cannot be fetched says so and changes nothing', async ({ page }) => {
    const files = { ...FILES };
    delete files['test-runs/Zsy7oDUP6Pw/regular-2.json'];
    await open(page, { files });
    await showVideo(page);
    const before = await page.evaluate(() => state.segments.length);
    await page.locator('#testRunRegularSelect').selectOption('regular-2');
    await expect(page.locator('.toast, #toast').first()).toContainText('Could not load that alignment');
    expect(await page.evaluate(() => state.segments.length)).toBe(before);
    expect(await page.evaluate(() => state.testRuns.activeId)).toBeNull();
    await expect(page.locator('#testRunRegularSelect')).toHaveValue('');
  });

  test('an engine with no runs yet has a disabled dropdown that says so', async ({ page }) => {
    const only = { ...FILES, 'test-runs/Zsy7oDUP6Pw/index.json': { videoId: VIDEO, runs: [RUNS[0]] } };
    await open(page, { files: only });
    await showVideo(page);
    await expect(page.locator('#testRunLiveSelect')).toBeDisabled();
    await expect(page.locator('#testRunLiveSelect option')).toHaveText(['No live engine runs yet']);
    await expect(page.locator('#testRunRegularSelect')).toBeEnabled();
  });
});
