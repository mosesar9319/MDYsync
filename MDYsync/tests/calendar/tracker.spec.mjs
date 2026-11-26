import { test, expect } from '@playwright/test';
import { preparePage } from '../support/harness.mjs';
import { buildDatabase, USERS } from '../fixtures/dataset.mjs';
import { dayNumber } from '../../shared/daf-yomi.mjs';

// The Daf Yomi tracker: the player keeps what a signed-in learner hears of a
// shiur (learning-tracker.js), and the calendar shows each daf from it --
// done, part done and up to which line, a few words outstanding, or missed.
// The rule itself is tested in tests/functions/daf-progress.test.mjs.

const answerFiles = (page, files) => page.route('**/api/get-results-file?*', (route) => {
  const path = new URL(route.request().url()).searchParams.get('path');
  if (path in files) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(files[path]) });
  return route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
});

test.describe('The player keeps what was heard', () => {
  // A shiur on Chullin 89: six lines of five words on each amud, one every
  // ten seconds from 1:40.
  const lines = [];
  ['a', 'b'].forEach((amud, i) => {
    for (let n = 1; n <= 3; n += 1) {
      for (const [w0, w1] of [[0, 4], [5, 9]]) {
        const start = 100 + lines.length * 10;
        lines.push({ ref: `Chullin 89${amud}:${n}`, start, end: start + 5, he: 'מילים של הדף', w0, w1, estimated: false });
      }
    }
    void i;
  });
  const VIDEO = 'Zsy7oDUP6Pw';
  const FILES = {
    'by-ref/Chullin-89a.json': { schema: 'dafsync-alignment-v2', dafRef: 'Chullin 89a', duration: 400, videoId: VIDEO, segments: lines },
    'video-links/Chullin-89a.json': { type: 'youtube', videoId: VIDEO, url: `https://www.youtube.com/watch?v=${VIDEO}`, label: 'Chullin 89' },
  };

  // Plays the shiur from one moment to another, a second at a time, as the
  // tracker sees it.
  const play = (page, from, to) => page.evaluate(async ([a, b]) => {
    window.isPaused = () => false;
    window.getDuration = () => 400;
    for (let t = a; t <= b; t += 1) {
      window.getCurrentTime = () => t;
      window.dafLearningTracker.tick();
      if (t === a) await new Promise((done) => setTimeout(done, 50));     // the row's earlier stretches are read
    }
    window.dafLearningTracker.save();
    await new Promise((done) => setTimeout(done, 50));
    window.isPaused = () => true;
    return window.__DAFSYNC_TEST_DB__.learning;
  }, [from, to]);

  async function open(page, user, learning = []) {
    const db = buildDatabase();
    db.learning = learning;
    await preparePage(page, { user, db });
    await answerFiles(page, FILES);
    await page.goto('/player/?ref=Chullin%2089a');
    await page.waitForFunction(() => typeof state !== 'undefined' && state.segments?.some((s) => Number(s.start) === 100) && window.dafLearningTracker);
  }

  test('a signed-in learner: the stretches heard, the words they cover, and the end of the shiur', async ({ page }) => {
    await open(page, USERS.ordinary);
    let rows = await play(page, 95, 165);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: USERS.ordinary.id, shiur_key: 'default:en:regular:Chullin:89', tractate: 'Chullin', daf: 89, maggid: 'default', variant: 'regular', language: 'en',
      ranges: [[95, 165]], finished: false, manual: false, position_seconds: 165, duration_seconds: 400,
      reads: { 'Chullin 89a': [0, 29], 'Chullin 89b': [0, 29] },
      words: { 'Chullin 89a': [10, 10, 10], 'Chullin 89b': [10, 10, 10] },
      // All of amud a, and the first line of amud b.
      heard: { 'Chullin 89a': [[0, 29]], 'Chullin 89b': [[0, 4]] },
    });
    // A jump ahead with the seek bar: what was skipped is not heard.
    rows = await play(page, 190, 216);
    expect(rows).toHaveLength(1);
    expect(rows[0].ranges).toEqual([[95, 165], [190, 216]]);
    expect(rows[0].heard).toEqual({ 'Chullin 89a': [[0, 29]], 'Chullin 89b': [[0, 4], [15, 29]] });
    // He heard the last line the maggid reads.
    expect(rows[0].finished).toBe(true);
    expect(rows[0].finished_at).toBeTruthy();
  });

  test('what was heard before is added to, not replaced', async ({ page }) => {
    // An earlier visit, on this device or another, heard 1:35 to 2:20.
    await open(page, USERS.ordinary, [{ user_id: USERS.ordinary.id, shiur_key: 'default:en:regular:Chullin:89', variant: 'regular', tractate: 'Chullin', daf: 89, ranges: [[95, 140]] }]);
    const rows = await play(page, 170, 216);
    expect(rows).toHaveLength(1);
    expect(rows[0].ranges).toEqual([[95, 140], [170, 216]]);
    // The words of both visits: amud a's first lines, and the end of amud b.
    expect(rows[0].heard).toEqual({ 'Chullin 89a': [[0, 19]], 'Chullin 89b': [[5, 29]] });
  });

  test('a look of a few seconds is not kept, and nothing is kept for a visitor who is not signed in', async ({ page }) => {
    await open(page, USERS.ordinary);
    expect(await play(page, 100, 110)).toEqual([]);
    await open(page, null);
    expect(await play(page, 95, 216)).toEqual([]);
  });
});

// --- The calendar ----------------------------------------------------------------------

// Monday 23 November 2026, Eruchin 6. In this made-up Eruchin every amud is
// five paragraphs of ten words.
const NOW = new Date(2026, 10, 23, 12, 0, 0);
const FULL = [10, 10, 10, 10, 10];
const row = (more) => ({
  user_id: USERS.ordinary.id, tractate: 'Arakhin', maggid: 'default', variant: 'regular', language: 'en', manual: false,
  position_seconds: 3000, duration_seconds: 3200, created_at: '2026-11-21T09:00:00', updated_at: '2026-11-21T09:00:00', ...more,
});
const LEARNED = [
  // Daf 3 (Friday the 20th): heard to the end.
  row({ shiur_key: 'default:en:regular:Arakhin:3', daf: 3, finished: true, created_at: '2026-11-20T09:00:00',
    words: { 'Arakhin 3a': FULL, 'Arakhin 3b': FULL }, reads: { 'Arakhin 3a': [0, 49], 'Arakhin 3b': [0, 49] }, heard: { 'Arakhin 3a': [[0, 49]], 'Arakhin 3b': [[0, 49]] } }),
  // Daf 4 (Shabbos the 21st): nothing.
  // Daf 5 (Sunday the 22nd): R' Eli's shiur heard to its end, which is 20 words short of the end of amud b.
  row({ shiur_key: 'default:en:regular:Arakhin:5', daf: 5, finished: true,
    words: { 'Arakhin 5a': FULL, 'Arakhin 5b': FULL }, reads: { 'Arakhin 5a': [0, 49], 'Arakhin 5b': [0, 29] }, heard: { 'Arakhin 5a': [[0, 49]], 'Arakhin 5b': [[0, 29]] } }),
  // Daf 6 (today): R' Bornstein's shiur, which opens at the last 12 words of daf 5; three fifths of amud a heard so far.
  row({ shiur_key: 'bornstein:en:regular:Arakhin:6', daf: 6, maggid: 'bornstein', finished: false, position_seconds: 800,
    words: { 'Arakhin 5b': FULL, 'Arakhin 6a': FULL, 'Arakhin 6b': FULL }, reads: { 'Arakhin 5b': [38, 49], 'Arakhin 6a': [0, 49], 'Arakhin 6b': [0, 49] },
    heard: { 'Arakhin 5b': [[38, 49]], 'Arakhin 6a': [[0, 29]] } }),
];
const entry = (label) => ({ videoId: `v-${label}`, label, amud: 'a' });
const CATALOG = {
  tractates: { Arakhin: [{ daf: 3, regularEn: entry('Eruchin 3') }, { daf: 4, regularEn: entry('Eruchin 4') }, { daf: 5, regularEn: entry('Eruchin 5') }, { daf: 6, regularEn: entry('Eruchin 6') }] },
  maggidim: { bornstein: { tractates: { Arakhin: [{ daf: 6, regularEn: entry('Arachin 6') }] } } },
};
// R' Eli's shiur on daf 6 opens with the twenty words his daf 5 shiur left: amud b's fourth paragraph at 0:40.
const FILES = {
  'by-ref/Arakhin-6a.json': { segments: [
    { ref: 'Arakhin 5b:4', start: 40, end: 60, w0: 0, w1: 9 }, { ref: 'Arakhin 5b:5', start: 60, end: 80, w0: 0, w1: 9 }, { ref: 'Arakhin 6a:1', start: 80, end: 100, w0: 0, w1: 9 },
  ] },
  // The printed page: five words to a line.
  'pages/Arakhin-5b.json': { wordBoxes: Array.from({ length: 50 }, (_, k) => ({ ref: `Arakhin 5b:${Math.floor(k / 10) + 1}`, wordIndex: k % 10, x: 0.8 - (k % 5) * 0.1, y: 0.1 + Math.floor(k / 5) * 0.03, w: 0.08, h: 0.012 })) },
  'pages/Arakhin-6a.json': { wordBoxes: Array.from({ length: 50 }, (_, k) => ({ ref: `Arakhin 6a:${Math.floor(k / 10) + 1}`, wordIndex: k % 10, x: 0.8 - (k % 5) * 0.1, y: 0.1 + Math.floor(k / 5) * 0.03, w: 0.08, h: 0.012 })) },
};

async function openCalendar(page, { user = USERS.ordinary, learning = LEARNED } = {}) {
  const db = buildDatabase();
  db.learning = learning.map((r) => ({ ...r }));
  await preparePage(page, { user, db });
  await page.clock.install({ time: NOW });
  await page.route('**/api/get-catalog', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CATALOG) }));
  await answerFiles(page, FILES);
  await page.goto('/calendar/');
  await expect(page.locator('.cal-cell').first()).toBeVisible();
}
const cell = (page, month, day) => page.locator(`.cal-cell[data-day="${dayNumber(2026, month, day)}"]`);
const openDay = async (page, info, month, day) => {
  if (info.project.name === 'mobile' && await page.locator('#calDayClose').isVisible()) await page.locator('#calDayClose').click();
  await cell(page, month, day).click();
};

test.describe('The calendar as a tracker', () => {
  test('each day shows what was learned of its daf', async ({ page }) => {
    await openCalendar(page);
    await expect(cell(page, 11, 20)).toHaveClass(/is-done/);
    await expect(cell(page, 11, 21)).toHaveClass(/is-missed/);
    // Daf 5 was done until today's shiur, another maggid's, opened 8 words later than it stopped.
    await expect(cell(page, 11, 22)).toHaveClass(/is-gap/);
    await expect(cell(page, 11, 23)).toHaveClass(/is-partial/);
    await expect(cell(page, 11, 23).locator('.cal-ring')).toHaveCount(1);
    // Before he began, and days to come: nothing.
    await expect(cell(page, 11, 19)).toHaveClass(/is-none/);
    await expect(cell(page, 11, 24)).toHaveClass(/is-none/);
    await expect(page.locator('#calLegend .cal-legend-item')).toHaveText(['Done', 'In progress', 'A few words left', 'Missed', 'Has a note']);
    // Above the month: where today stands, what is outstanding, how many in a row.
    const tiles = page.locator('#calSummary .cal-tile');
    await expect(tiles.nth(0)).toContainText('You are 30% through. Carry on');
    await expect(tiles.nth(1)).toContainText('2 dapim not finished');
    await expect(tiles.nth(2)).toContainText('2 dapim');
    // "To catch up" goes to the earliest of them.
    await tiles.nth(1).click();
    await expect(page.locator('#calDay .cal-day-title')).toContainText('Eruchin 4');
    await expect(page.locator('#calDay .cal-state')).toContainText('Not learned yet');
  });

  test('a few words outstanding: how many, on which line, and the shiur that reads them', async ({ page }, info) => {
    await openCalendar(page);
    await openDay(page, info, 11, 22);
    const panel = page.locator('#calDay');
    await expect(panel.locator('.cal-state')).toContainText('8 words still to learn');
    // Words 31-38 of amud b: five words to a printed line, so line 7.
    await expect(panel.locator('#calWhere')).toHaveText('On amud b, line 7');
    const go = panel.locator('.cal-primary');
    await expect(go).toContainText('Learn the 8 words');
    await expect(go).toContainText("R' Eli Stefansky");
    // R' Eli's next shiur, two seconds before he reads them.
    await expect(go).toHaveAttribute('href', '/player/?ref=Arakhin%206a&t=38');
    await expect(panel.locator('.cal-map-piece.is-gap')).toHaveCount(1);
    await expect(panel.locator('.cal-shiur.is-heard')).toContainText('Heard to the end');
  });

  test('a daf in progress: how far, and the line to continue from', async ({ page }, info) => {
    await openCalendar(page);
    await openDay(page, info, 11, 23);
    const panel = page.locator('#calDay');
    await expect(panel.locator('.cal-state')).toContainText('In progress · 30%');
    // 30 words of amud a heard: the next is the first word of line 7.
    await expect(panel.locator('#calWhere')).toHaveText('Up to amud a, line 7');
    const go = panel.locator('.cal-primary');
    await expect(go).toContainText('Continue from line 7');
    // No sync to find the moment by: back to where he stopped in the shiur he is in.
    await expect(go).toHaveAttribute('href', '/player/?ref=Arakhin%206a&maggid=bornstein&t=800');
  });

  test('a daf can be marked as learned by hand, and the mark taken off', async ({ page }, info) => {
    await openCalendar(page);
    await openDay(page, info, 11, 21);
    const panel = page.locator('#calDay');
    await panel.getByRole('button', { name: 'Mark as learned' }).click();
    await expect(cell(page, 11, 21)).toHaveClass(/is-done/);
    await expect(panel.locator('.cal-state')).toContainText('Marked as learned.');
    await expect(page.locator('#calSummary .cal-tile').nth(1)).toContainText('1 daf not finished');
    await panel.getByRole('button', { name: 'Remove my mark' }).click();
    await expect(cell(page, 11, 21)).toHaveClass(/is-missed/);
  });

  test('signed out, or with nothing learned yet: the plain calendar', async ({ page }) => {
    await openCalendar(page, { user: null });
    await expect(page.locator('.cal-cell .cal-ring')).toHaveCount(0);
    await expect(page.locator('#calLegend')).toBeHidden();
    await expect(page.locator('#calSummary .cal-tile')).toHaveCount(3);
    await expect(page.locator('#calSummary .cal-invite')).toContainText('Sign in');
    await openCalendar(page, { learning: [] });
    await expect(page.locator('.cal-cell .cal-ring')).toHaveCount(0);
    await expect(page.locator('#calSummary .cal-invite')).toContainText('The calendar fills itself in as you learn');
  });
});
