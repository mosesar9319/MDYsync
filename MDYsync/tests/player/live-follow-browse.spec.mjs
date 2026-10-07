import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { preparePage, failOnPageError } from '../support/harness.mjs';

// Live follow on the Interactive Daf page (/browse/), end to end, minus the
// pieces that cannot run here: the real ElevenLabs realtime WebSocket (no key
// here, and no interest in a metered third-party service in a test suite) and
// pdf.js (replaced by a stand-in that draws dark bars where the real page map
// says the printed words are). Transcripts are fed straight into
// handleCommitted/handlePartial -- the exact functions the socket's message
// handler calls -- so everything from the transcript onward is real: the
// matcher, the follow states, and the page's own highlighting. The daf is
// real Sefaria text for Chullin 91a/91b and the page map is the real one for
// 91a, both from fixtures.

const fixture = JSON.parse(readFileSync(new URL('../fixtures/live-matcher-parity.json', import.meta.url), 'utf8'));
const pageMap91a = JSON.parse(readFileSync(new URL('../fixtures/pagemap-chullin-91a.json', import.meta.url), 'utf8'));
const phrase = (start, length) => fixture.canonNorms.slice(start, start + length).join(' ');

const PDFJS = /^https:\/\/cdn\.jsdelivr\.net\/npm\/pdfjs-dist@[^/]+\/build\/pdf\.min\.mjs$/;
const mockPdfJs = (maps) => `
  const MAPS = ${JSON.stringify(maps)};
  export const GlobalWorkerOptions = {};
  export function getDocument({ data }) {
    const key = /key=(\\S+)/.exec(new TextDecoder().decode(data))?.[1];
    const map = MAPS[key];
    const page = {
      getViewport: ({ scale }) => ({ width: Math.round(1341 * scale), height: Math.round(2068 * scale) }),
      render: ({ canvasContext: ctx, viewport }) => {
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, viewport.width, viewport.height);
        ctx.fillStyle = '#000';
        for (const b of (map?.wordBoxes || [])) ctx.fillRect(b.x * viewport.width, (b.y + b.h * 0.2) * viewport.height, b.w * viewport.width, b.h * 0.55 * viewport.height);
        return { promise: Promise.resolve() };
      },
    };
    return { promise: Promise.resolve({ getPage: async () => page }) };
  }`;

// Registered AFTER preparePage: its catch-all /api/** stub is the latest route
// until then, and the latest route wins.
async function serveDaf(page, { maps = { 'Chullin-91a': pageMap91a }, jobStatus = 202, pageStatus = {} } = {}) {
  const seen = { pages: [], maps: [], jobs: [], sefaria: [] };
  await page.route('**/api/sefaria?*', (route) => {
    const ref = new URL(route.request().url()).searchParams.get('ref');
    seen.sefaria.push(ref);
    const he = fixture.segments.filter((s) => s.ref.startsWith(`${ref}:`)).map((s) => s.he);
    // Only the real daf (91a/91b) has fixture text; any other page the picker
    // passes through on the way gets a one-line stand-in, as a real daf would
    // have text -- except one that does not exist at all.
    if (/ 999[ab]$/.test(ref)) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not found"}' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ref, sectionRef: ref, heRef: ref, he: he.length ? he : ['שלום עליכם'] }) });
  });
  await page.route('https://www.sefaria.org/**', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"offline in tests"}' }));
  await page.route(PDFJS, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: mockPdfJs(maps) }));
  await page.route('**/api/daf-page?*', (route) => {
    const q = new URL(route.request().url()).searchParams;
    const key = `${q.get('tractate')}-${q.get('daf')}${q.get('amud')}`;
    seen.pages.push(key);
    if (pageStatus[key]) return route.fulfill({ status: pageStatus[key], contentType: 'application/json', body: '{"error":"No page image available."}' });
    return route.fulfill({ status: 200, contentType: 'application/pdf', body: `%PDF-fake key=${key}` });
  });
  await page.route('**/api/get-results-file?*', (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).searchParams.get('path'));
    const key = /^pages\/([^.]+)\.json$/.exec(path)?.[1];
    if (!key) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not found"}' });
    seen.maps.push(key);
    const found = typeof maps[key] === 'function' ? maps[key]() : maps[key];
    return found
      ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(found) })
      : route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not found"}' });
  });
  await page.route('**/api/trigger-page-ocr-job', (route) => {
    seen.jobs.push(route.request().postDataJSON());
    return route.fulfill({ status: jobStatus, contentType: 'application/json', body: '{}' });
  });
  return seen;
}

async function openBrowse(page, { query = '', serve = {}, errors = null, noTabShare = false } = {}) {
  if (errors) failOnPageError(page, errors);
  await preparePage(page, { user: null });
  const seen = await serveDaf(page, serve);
  // A token that works and a socket that just sits connecting: Start completes and
  // then nothing asynchronous (a failed token request, a dropped socket) can
  // change the status underneath what a test is asserting.
  await page.route('**/api/live-token', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"token":"test-token"}' }));
  await page.addInitScript(() => {
    window.__constraints = null; window.__display = null;
    navigator.mediaDevices.getUserMedia = (c) => { window.__constraints = c; return Promise.resolve(new AudioContext().createMediaStreamDestination().stream); };
    navigator.mediaDevices.getDisplayMedia = (c) => {
      window.__display = c;
      if (window.__noAudioShared) return Promise.resolve(new MediaStream());
      const stream = new AudioContext().createMediaStreamDestination().stream;
      const canvas = document.createElement('canvas'); canvas.getContext('2d');
      stream.addTrack(canvas.captureStream(1).getVideoTracks()[0]);
      window.__displayStream = stream;
      return Promise.resolve(stream);
    };
    window.WebSocket = class { constructor() { this.readyState = 0; } addEventListener() {} send() {} close() {} };
  });
  if (noTabShare) await page.addInitScript(() => { navigator.mediaDevices.getDisplayMedia = undefined; });
  await page.goto(`/browse/${query}`);
  await expect.poll(() => page.locator('#dafTractateSelect option').count()).toBeGreaterThan(0);
  return seen;
}

// The page's own picker: tractate, daf, then side.
async function pick(page, ref) {
  const [, tractate, daf, side] = /^(.+?)\s+(\d+)([ab])$/.exec(ref);
  await page.locator('#dafTractateSelect').selectOption(tractate);
  await page.locator('#dafDafSelect').selectOption(daf);
  await page.locator(`#dafAmudToggle .amud-option[data-side="${side}"]`).click();
}

// The test hooks, under the short names the tests use. (None of these names is
// a global of the page's own scripts.)
const alias = (page) => page.evaluate(() => {
  const t = dafLiveFollow.__test;
  Object.assign(window, {
    live: t.live, handleCommitted: t.handleCommitted, handlePartial: t.handlePartial, setProvisional: t.setProvisional,
    setAnchor: t.setAnchor, startLiveFollow: t.startLiveFollow, stopLiveFollow: t.stopLiveFollow, recordSentAudio: t.recordSentAudio,
    segmentAudio: t.segmentAudio, buildWsUrl: t.buildWsUrl, activeKeyterms: t.activeKeyterms, activeKeytermTokens: t.activeKeytermTokens,
    PAGE_OPTIONS: t.PAGE_OPTIONS,
  });
});

// Live follow on, the picker on Chullin 91a, the daf loaded, the printed page up
// with its word positions, and the matcher armed the way Start arms it.
async function openFollowing(page, options = {}) {
  const seen = await openBrowse(page, options);
  await page.locator('#lfToggle').click();
  await pick(page, 'Chullin 91a');
  await expect.poll(() => page.evaluate(() => dafLiveFollow.__test.live.daf?.label)).toBe('Chullin 91a');
  await alias(page);
  await expect.poll(() => page.evaluate(() => state.vilnaPageMap !== null)).toBe(true);
  await page.evaluate(() => {
    live.tracker = LiveMatcher.createTracker(live.daf.canon, { eagerRelocalize: true });
    live.preview = LiveMatcher.createPreview(live.daf.canon, live.tracker);
  });
  return seen;
}
// The same, but only as far as the mode being on and the daf being chosen: for tests that Start.
async function openChosen(page, options = {}) {
  const seen = await openBrowse(page, options);
  await page.locator('#lfToggle').click();
  await pick(page, 'Chullin 91a');
  await expect.poll(() => page.evaluate(() => dafLiveFollow.__test.live.daf?.label)).toBe('Chullin 91a');
  await alias(page);
  return seen;
}
// A tap on the word, as the page's own handlers deliver one.
const tapWord = (page, index) => page.evaluate((i) => { const w = live.daf.canon.words[i]; dafLiveFollow.tapWord(w.ref, w.wordIndex); }, index);
const chooseSource = (page, value) => page.locator(`#lfSources label:has(input[value="${value}"])`).click();
// A real click on a printed word: scrolled into view, then a mouse click at the word's
// centre. (Not locator.click: the page's own phrase-sized hit regions sit over the page, and
// Playwright refuses to click "through" them -- which is the very thing live follow's
// capture-phase handler is there to deal with.)
async function clickPrintedWord(page, index) {
  await page.evaluate((i) => {
    const w = live.daf.canon.words[i];
    const b = state.vilnaPageMap.wordBoxes.find((x) => x.ref === w.ref && x.wordIndex === w.wordIndex);
    const marker = document.createElement('div');
    marker.style.cssText = `position:absolute;left:${(b.x + b.w / 2) * 100}%;top:${(b.y + b.h / 2) * 100}%;width:1px;height:1px`;
    document.getElementById('vilnaPageWrap').append(marker);
    marker.scrollIntoView({ block: 'center', behavior: 'instant' }); // not the page's smooth scrolling: the point must be where it is measured
    marker.remove();
  }, index);
  const point = await page.evaluate((i) => {
    const w = live.daf.canon.words[i];
    const b = state.vilnaPageMap.wordBoxes.find((x) => x.ref === w.ref && x.wordIndex === w.wordIndex);
    const r = document.getElementById('vilnaPageCanvas').getBoundingClientRect();
    return { x: r.left + (b.x + b.w / 2) * r.width, y: r.top + (b.y + b.h / 2) * r.height };
  }, index);
  await page.mouse.click(point.x, point.y);
}
const activeBars = (page) => page.locator('#vilnaActiveOverlay .vilna-active-rect');
const quiet = (page) => expect(page.locator('body'));
const say = (page, text) => page.evaluate((t) => handleCommitted(t), text);
const confirmed = (page) => page.evaluate(() => live.confirmed);
const status = (page) => page.locator('#lfStatusText');
const detail = (page) => page.locator('#lfStatusDetail');

// ---- Page basics ----------------------------------------------------------------------

test.describe('Live follow — the mode on the Interactive Daf page', () => {
  test('the page loads cleanly with live follow off: nothing of it is in the way', async ({ page }) => {
    const errors = [];
    await openBrowse(page, { errors });
    await expect(page.locator('#lfToggle')).toHaveText('Turn on');
    await expect(page.locator('#lfBody')).toBeHidden();
    expect(await page.evaluate(() => state.liveFollow)).toBeNull();
    expect(await page.evaluate(() => document.body.classList.contains('lf-on'))).toBe(false);
    expect(errors.filter((e) => !/404|Failed to load resource/.test(e))).toEqual([]);
  });

  test('turning it on opens the panel and offers every daf, not just the synced ones', async ({ page }) => {
    await openBrowse(page);
    const before = await page.locator('#dafTractateSelect option').evaluateAll((o) => o.map((x) => x.value));
    await page.locator('#lfToggle').click();
    await expect(page.locator('#lfToggle')).toHaveText('Turn off');
    await expect(page.locator('#lfBody')).toBeVisible();
    expect(await page.evaluate(() => state.liveFollow)).toMatchObject({ active: true });
    const after = await page.locator('#dafTractateSelect option').evaluateAll((o) => o.map((x) => x.value));
    expect(after.length).toBe(36);
    expect(after.length).toBeGreaterThan(before.length);
    await page.locator('#dafTractateSelect').selectOption('Berakhot');
    expect(await page.locator('#dafDafSelect option').count()).toBe(63); // 2..64, all of them
  });

  test('while it is on, the page says a tap sets the place (not that it plays the shiur)', async ({ page }) => {
    await openBrowse(page);
    const before = await page.locator('.browse-nav-label').textContent();
    expect(before).toContain('watch that part of the shiur');
    await page.locator('#lfToggle').click();
    await expect(page.locator('.browse-nav-label')).toContainText('set where the reading is');
    await page.locator('#lfToggle').click();
    await expect(page.locator('.browse-nav-label')).toHaveText(before);
  });

  test('turning it off puts the page back as it was', async ({ page }) => {
    await openBrowse(page);
    const before = await page.evaluate(() => ({ options: document.getElementById('dafTractateSelect').innerHTML, segments: state.segments.length, dafRef: state.dafRef }));
    await page.locator('#lfToggle').click();
    await pick(page, 'Chullin 91a');
    await expect.poll(() => page.evaluate(() => state.dafRef)).toBe('Chullin 91a');
    expect(await page.evaluate(() => state.segments.length)).toBeGreaterThan(20);
    await page.locator('#lfToggle').click();
    await expect(page.locator('#lfBody')).toBeHidden();
    expect(await page.evaluate(() => state.liveFollow)).toBeNull();
    const after = await page.evaluate(() => ({ options: document.getElementById('dafTractateSelect').innerHTML, segments: state.segments.length, dafRef: state.dafRef }));
    expect(after.segments).toBe(before.segments);
    expect(after.dafRef).toBe(before.dafRef);
    expect(after.options).toBe(before.options);
  });

  test('?live=1 opens the page already in live follow', async ({ page }) => {
    await openBrowse(page, { query: '?live=1' });
    await expect(page.locator('#lfBody')).toBeVisible();
    await expect(page.locator('#lfToggle')).toHaveText('Turn off');
  });

  test('the old /live/ address lands here, in live follow, keeping its options', async ({ page }) => {
    await preparePage(page, { user: null });
    await serveDaf(page);
    await page.goto('/live/?raw=0&batch=0');
    await page.waitForURL(/\/browse\/\?live=1&raw=0&batch=0$/);
    await expect(page.locator('#lfBody')).toBeVisible();
    await expect.poll(() => page.evaluate(() => typeof dafLiveFollow)).toBe('object');
    await alias(page);
    expect(await page.evaluate(() => PAGE_OPTIONS)).toMatchObject({ raw: false, batch: false });
  });

  test('the daf is chosen with the page\'s own picker, and choosing it loads its text as the daf to follow', async ({ page }) => {
    const seen = await openBrowse(page);
    await page.locator('#lfToggle').click();
    await pick(page, 'Chullin 91a');
    await expect(page.locator('#lfDafName')).toHaveText('Chullin 91a');
    expect(seen.sefaria).toEqual(expect.arrayContaining(['Chullin 91a', 'Chullin 91b']));
    // The daf's paragraphs are the page's segments, none of them a recording's.
    const info = await page.evaluate(() => ({ n: state.segments.length, first: state.segments[0].ref, times: state.segments.every((s) => s.start === 0 && s.end === 0), title: document.getElementById('dafTitle').textContent }));
    expect(info.n).toBe(fixture.segments.length);
    expect(info.first).toBe('Chullin 91a.1');
    expect(info.times).toBe(true);
    expect(info.title).toBe('Chullin 91a');
  });

  test('the daf picker is on the page itself, not inside the video player', async ({ page }) => {
    await openBrowse(page);
    expect(await page.evaluate(() => document.getElementById('dafDafSelect').closest('.video-frame'))).toBeNull();
    await expect(page.locator('#dafDafSelect')).toBeVisible();
    await expect(page.locator('#playerDafButton')).toBeDisabled(); // the player's daf name is only a label
  });

  test('the picker lists every daf of the tractate, with the unsynced ones marked', async ({ page }) => {
    await openBrowse(page);
    await expect(page.locator('#dafTractateSelect')).toHaveValue('Chullin');
    const options = await page.locator('#dafDafSelect option').evaluateAll((o) => o.map((x) => [x.value, x.textContent]));
    expect(options.length).toBe(141); // 2..142: past the last synced daf
    expect(options.at(-1)[0]).toBe('142');
    expect(options.find(([v]) => v === '89')[1]).toBe('89');
    expect(options.find(([v]) => v === '120')[1]).toBe('120 · no recording yet');
    await page.locator('#dafDafSelect').selectOption('120');
    await expect(page.locator('#dafAmudToggle .amud-option[data-side="b"]')).toBeEnabled();
  });

  test('the Choose daf button takes you to the page\'s picker', async ({ page }) => {
    await openBrowse(page);
    await page.locator('#lfToggle').click();
    await page.locator('#lfChooseDafButton').click();
    await expect(page.locator('.setup-field.ref-field')).toHaveClass(/lf-picker-flash/);
    await expect(page.locator('#dafDafSelect')).toBeFocused();
    await expect(page.locator('#dafDafSelect')).toBeInViewport();
  });

  test('without a daf chosen, Start says so and starts nothing', async ({ page }) => {
    await openBrowse(page);
    await page.locator('#lfToggle').click();
    await alias(page);
    await page.evaluate(() => { document.getElementById('dafTractateSelect').innerHTML = ''; });
    await page.locator('#lfStartButton').click();
    await expect(page.locator('#toast')).toContainText('Choose a daf first');
    expect(await page.evaluate(() => live.micStream === null && live.ws === null)).toBe(true);
  });

  test('an unknown daf fails before the microphone is ever requested', async ({ page }) => {
    await openBrowse(page);
    await page.locator('#lfToggle').click();
    await alias(page);
    await page.evaluate(() => { dafPickerRef = () => 'Chullin 999a'; });
    await page.locator('#lfStartButton').click();
    await expect(status(page)).toHaveText('Error');
    await expect(detail(page)).toContainText('Could not load Chullin 999a');
    expect(await page.evaluate(() => window.__constraints)).toBeNull();
  });

  test('a denied microphone is reported gracefully, and Start works again', async ({ page }) => {
    await openChosen(page);
    await page.evaluate(() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' })); });
    await page.locator('#lfStartButton').click();
    await expect(status(page)).toHaveText('Error');
    await expect(detail(page)).toContainText('denied');
    await expect(page.locator('#lfStartButton')).toHaveText('Start live follow');
    await expect(page.locator('#lfStartButton')).toBeEnabled();
  });

  test('Start opens the microphone and asks for a token, with real audio frames flowing', async ({ page }) => {
    let tokenRequested = false;
    await openChosen(page);
    await page.route('**/api/live-token', (route) => { tokenRequested = true; return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"not configured in test"}' }); });
    await page.locator('#lfStartButton').click();
    await expect.poll(() => tokenRequested).toBe(true);
    await expect(status(page)).toHaveText('Error', { timeout: 5000 });
    expect(await page.evaluate(() => live.daf.keyterms.length)).toBeLessThanOrEqual(50);
    expect(await page.evaluate(() => window.__constraints)).not.toBeNull();
  });
});

// ---- Following: the matcher, the status, and the highlight ------------------------------------

test.describe('Live follow — following a reading', () => {
  test('every matchable word of the daf is on the page\'s own word list', async ({ page }) => {
    await openFollowing(page);
    expect(await page.evaluate(() => live.daf.canon.length)).toBe(fixture.canonNorms.length);
  });

  // A phrase under 6 words is never trusted on its own, so these use 5 words:
  // it takes two agreeing phrases to lock. (6+ clear words lock at once --
  // see the next test.)
  test('a short phrase needs a second agreeing one to lock, then follows the reading', async ({ page }) => {
    await openFollowing(page);
    await say(page, `so the Gemara says ${phrase(400, 5)}`);
    await expect(status(page)).toHaveText('Searching…');
    expect(await confirmed(page)).toBeNull();
    await expect(page.locator('#lfDebugPending')).toContainText('[400–404]');

    await say(page, phrase(406, 5));
    await expect(status(page)).toHaveText('Following');
    expect(await confirmed(page)).toEqual({ s: 406, e: 410 });
    await expect(page.locator('#lfDebugMatch')).not.toHaveText('—');
    await expect(activeBars(page).first()).toBeVisible();

    await say(page, phrase(412, 6));
    expect(await confirmed(page)).toEqual({ s: 412, e: 417 });
  });

  test('one long, clear phrase locks a fresh session straight away', async ({ page }) => {
    await openFollowing(page);
    await say(page, phrase(400, 7));
    await expect(status(page)).toHaveText('Following');
    expect(await confirmed(page)).toEqual({ s: 400, e: 406 });
  });

  test('a phrase that repeats elsewhere on the daf is held for confirmation, not trusted alone', async ({ page }) => {
    await openFollowing(page);
    await say(page, phrase(52, 6)); // words 52-57 appear twice on this daf
    await expect(status(page)).toHaveText('Searching…');
    expect(await confirmed(page)).toBeNull();
  });

  test('resuming far ahead after an explanation is followed at once, without saying Explaining', async ({ page }) => {
    await openFollowing(page);
    await say(page, phrase(400, 7));
    await say(page, 'so what is the question here? think about it for a second');
    await expect(status(page)).toHaveText('Explaining');
    await say(page, phrase(520, 8)); // well past the +60-word window
    await expect(status(page)).toHaveText('Following');
    expect(await confirmed(page)).toEqual({ s: 520, e: 527 });
    await quiet(page).not.toHaveClass(/lf-quiet/);
  });

  test('a lone Hebrew term inside English speech neither moves the highlight nor changes the status', async ({ page }) => {
    await openFollowing(page);
    await say(page, phrase(400, 7));
    await say(page, 'so what is the question here? think about it for a second');
    await expect(status(page)).toHaveText('Explaining');
    // ElevenLabs writes "Gemara" in Hebrew letters; a word on the daf near the cursor must not be "placed".
    const nearby = fixture.canonNorms[410];
    await say(page, `and now the ${nearby} says something`);
    await expect(status(page)).toHaveText('Explaining');
    expect(await confirmed(page)).toEqual({ s: 400, e: 406 });
    expect(await page.evaluate(() => live.tracker.cursor)).toBe(400);
  });

  // Real ElevenLabs output: at the end of a reading it recited the keyterm list it
  // had been given (after 9 genuine words). The list's daf-derived terms come out
  // in daf order, which used to look like steady forward reading and moved the
  // highlight to words 249-258.
  const LEAKED_COMMIT = 'אחר כך, במאי מסכינן, כגון דלייט בוקי זית, דתניא, אמר רבא, אמר אביי, בעי מיניה, איבעיא להו, אשי, איסור, אסור, ומזה, ליה, הכה, אחר, הכתוב, דהוה, איצטריך, אכלו, דפשיט, כאדם, שנטפל, עולא, בתרוייהו, כתיב, שנשה, דכתיב, והכן, לבדו, מגופם, שלא, אבהו, השמש, בנו, מבאר, שהתפללו, בעי, המקום, ראשו, סולם, הדדי, פרסי, שמעון, עליה, ויאמר, זמני.';

  test('the service reciting its keyterm list at the end of a reading does not move the highlight', async ({ page }) => {
    await openFollowing(page);
    await say(page, phrase(216, 8));
    await say(page, LEAKED_COMMIT);
    const spot = await confirmed(page);
    expect(spot.s).toBe(226); // the 9 real words placed where they belong...
    expect(spot.e).toBeLessThan(240); // ...and nothing from the recitation did
    expect(await page.evaluate(() => live.tracker.cursor)).toBe(226);
    await expect(status(page)).toHaveText('Following');
    const entry = await page.evaluate(() => live.log.filter((e) => e.kind === 'commit').pop());
    expect(entry.cleaned).toContain('·');
  });

  test('a word stuck on repeat is not read as a reading', async ({ page }) => {
    await openFollowing(page);
    await say(page, phrase(400, 7));
    await say(page, 'איננו, איננו, איננו, איננו, איננו, איננו');
    expect(await confirmed(page)).toEqual({ s: 400, e: 406 });
    await expect(status(page)).toHaveText('Explaining');
  });

  // The daf's words with each word's last letter wrong: still matches its true
  // place, but weakly -- the way garbled speech in a real session scored.
  const weakText = (start, length) => fixture.canonNorms.slice(start, start + length)
    .map((w) => [...w].map((c, i, all) => (i === all.length - 1 ? 'צ' : c)).join('')).join(' ');

  test('a weak match far from the highlight is held, not followed, and a phrase back near it carries on', async ({ page }) => {
    await openFollowing(page);
    await say(page, phrase(400, 7));
    await say(page, weakText(440, 2)); // 2 garbled words that match somewhere 34 words ahead
    expect(await confirmed(page)).toEqual({ s: 400, e: 406 });
    expect(await page.evaluate(() => live.tracker.cursor)).toBe(400);
    await expect(status(page)).toHaveText('Listening…');
    await expect(detail(page)).toContainText('possible new spot');
    await say(page, phrase(407, 6));
    expect(await confirmed(page)).toEqual({ s: 407, e: 412 });
    await expect(status(page)).toHaveText('Following');
  });

  test('a silent commit leaves the status and the highlight alone', async ({ page }) => {
    await openFollowing(page);
    await say(page, phrase(400, 7));
    await say(page, '');
    await expect(status(page)).toHaveText('Following');
    expect(await confirmed(page)).toEqual({ s: 400, e: 406 });
    const entry = await page.evaluate(() => live.log.filter((e) => e.kind === 'commit').pop());
    expect(entry.silent).toBe(true);
  });

  test('the speech-service settings are opt-in: nothing extra by default, language and filter when asked', async ({ page }) => {
    await openFollowing(page);
    const params = (url) => new URL(url).searchParams;
    const plain = params(await page.evaluate(() => buildWsUrl('tok', ['a'])));
    expect(plain.has('language_code')).toBe(false);
    expect(plain.has('filter_background_audio')).toBe(false);
    expect(plain.get('vad_silence_threshold_secs')).toBe('0.5');

    await page.goto('/browse/?lang=he&filter=1');
    await expect.poll(() => page.evaluate(() => typeof dafLiveFollow)).toBe('object');
    await alias(page);
    const tuned = params(await page.evaluate(() => buildWsUrl('tok', ['a'])));
    expect(tuned.get('language_code')).toBe('he');
    expect(tuned.getAll('secondary_languages')).toEqual(['en']);
    expect(tuned.get('filter_background_audio')).toBe('true');
    expect(tuned.get('token')).toBe('tok');
  });

  test('a bare one-word fragment leaves the status and the highlight alone', async ({ page }) => {
    await openFollowing(page);
    await say(page, phrase(400, 7));
    await say(page, fixture.canonNorms[407]); // just the word, nothing around it
    await expect(status(page)).toHaveText('Following');
    expect(await confirmed(page)).toEqual({ s: 400, e: 406 });
    expect(await page.evaluate(() => live.unplacedHebrew)).toBe(0);
  });

  test('hearing Hebrew in a partial stops it saying Explaining before the place is found', async ({ page }) => {
    await openFollowing(page);
    await say(page, phrase(400, 7));
    await say(page, 'so what is the question here? think about it for a second');
    await expect(status(page)).toHaveText('Explaining');
    // The resumed reading is somewhere the preview can't place yet: only 2 words so far.
    await page.evaluate((t) => handlePartial(t), `${fixture.canonNorms[600]} ${fixture.canonNorms[601]}`);
    await expect(status(page)).toHaveText('Listening…');
    await quiet(page).not.toHaveClass(/lf-quiet/);
  });

  test('the status says Following as soon as the preview has the place, before any commit has locked it', async ({ page }) => {
    await openFollowing(page);
    await page.evaluate((t) => handlePartial(t), phrase(300, 8)); // one decisive partial, nothing committed yet
    await expect(status(page)).toHaveText('Following', { timeout: 1500 });
    expect(await page.evaluate(() => live.tracker.locked)).toBe(false);
    expect((await page.evaluate(() => live.provisional)).s).toBe(302); // the preview follows the partial's last 6 words
  });

  test('Hebrew that cannot be placed says Listening, not Explaining, and eventually says what to do', async ({ page }) => {
    await openFollowing(page);
    await say(page, phrase(400, 7));
    const nonsense = (i) => `ברכתנו${'ם'.repeat(i)} ומקצתם לעיגול שפרקוד ננעמיה חלמוני דסבתקל`;
    await say(page, nonsense(0));
    await expect(status(page)).toHaveText('Listening…');
    await quiet(page).not.toHaveClass(/lf-quiet/);
    await expect(detail(page)).not.toContainText('tap the word');
    await say(page, nonsense(1));
    await say(page, nonsense(2));
    await expect(status(page)).toHaveText('Listening…');
    await expect(detail(page)).toContainText('tap the word being read');
    // ...and the highlight stayed where it was, rather than wandering.
    expect(await confirmed(page)).toEqual({ s: 400, e: 406 });
    // Placing something clears it.
    await say(page, phrase(407, 6));
    await expect(status(page)).toHaveText('Following');
    await expect(detail(page)).not.toContainText('tap the word');
  });

  test('an English explanation holds the last phrase, quieter, instead of guessing', async ({ page }) => {
    await openFollowing(page);
    await say(page, phrase(400, 6));
    await say(page, phrase(406, 6));
    await say(page, 'and what that means is the animal is permitted, you understand');
    await expect(status(page)).toHaveText('Explaining');
    await quiet(page).toHaveClass(/lf-quiet/);
    expect(await confirmed(page)).toEqual({ s: 406, e: 411 });
    await expect(activeBars(page).first()).toBeVisible(); // still on the page

    await say(page, phrase(412, 6));
    await expect(status(page)).toHaveText('Following');
    await quiet(page).not.toHaveClass(/lf-quiet/);
  });

  test('a partial transcript previews the next words without moving the tracker', async ({ page }) => {
    await openFollowing(page);
    await say(page, phrase(400, 6));
    await say(page, phrase(406, 6));
    await say(page, 'so what does that mean');
    await expect(status(page)).toHaveText('Explaining');
    await page.evaluate((t) => handlePartial(t), phrase(412, 4));
    await expect(page.locator('#vilnaLiveProvisionalOverlay > div').first()).toBeVisible();
    await expect(status(page)).toHaveText('Following', { timeout: 1000 });
    expect(await page.evaluate(() => live.provisional)).toEqual({ s: 412, e: 415 });
    expect(await page.evaluate(() => live.tracker.cursor)).toBe(406);

    await say(page, phrase(412, 6));
    await expect(page.locator('#vilnaLiveProvisionalOverlay > div')).toHaveCount(0);
    expect(await confirmed(page)).toEqual({ s: 412, e: 417 });
  });

  test('a long reading with no commit keeps the preview moving, widened a little ahead', async ({ page }) => {
    await openFollowing(page);
    await say(page, phrase(400, 6));
    await say(page, phrase(406, 6)); // locked at 406; the tracker's window ends at ~466
    // ~130 words of continuous reading as partials only -- the utterance never commits.
    for (let start = 412; start <= 532; start += 6) {
      await page.evaluate((t) => handlePartial(t), phrase(start, 6));
      await page.waitForTimeout(90); // past the page's partial throttle
    }
    const preview = await page.evaluate(() => live.provisional);
    expect(preview.s).toBe(532);
    expect(preview.e).toBeGreaterThanOrEqual(537);
    expect(preview.e).toBeLessThanOrEqual(540); // at most 3 words past the matched tail
    expect(await confirmed(page)).toEqual({ s: 406, e: 411 });
    expect(await page.evaluate(() => live.tracker.cursor)).toBe(406);
  });

  test('a short phrase far from the highlight moves it only once a second phrase confirms it', async ({ page }) => {
    await openFollowing(page);
    await say(page, phrase(400, 6));
    await say(page, phrase(406, 6));
    await say(page, phrase(412, 6));

    await say(page, `let's go back, ${phrase(100, 5)}`);
    expect(await confirmed(page)).toEqual({ s: 412, e: 417 });
    await expect(page.locator('#lfDebugPending')).toContainText('[100–104]');

    await say(page, phrase(105, 5));
    expect(await confirmed(page)).toEqual({ s: 105, e: 109 });
    await expect(status(page)).toHaveText('Following');
    await expect(page.locator('#lfDebugPending')).toHaveText('—');
  });

  test('a long continuous reading advances the highlight through it', async ({ page }) => {
    await openFollowing(page);
    await say(page, phrase(400, 6));
    await say(page, phrase(406, 6));
    await say(page, phrase(412, 24)); // one VAD-committed utterance, chunked internally
    const end = await confirmed(page);
    expect(end.e).toBe(435);
    expect(end.s).toBeGreaterThan(412);
  });
});

// ---- Pointing at the daf ------------------------------------------------------------------------

test.describe('Live follow — pointing at the daf', () => {
  test('tapping a word before Start marks it, and the session then begins locked there', async ({ page }) => {
    await openChosen(page);
    await tapWord(page, 300);
    await expect(page.locator('#vilnaLiveAnchorOverlay > div')).toHaveCount(1);
    await expect(detail(page)).toContainText('tap Start');
    expect(await page.evaluate(() => live.anchorIndex)).toBe(300);

    await page.locator('#lfStartButton').click(); // fake mic, a socket that never opens
    await expect.poll(() => page.evaluate(() => live.tracker?.locked && live.tracker.cursor)).toBe(300);
    // The very first phrase -- only 4 words, far too short to place by search -- places at once.
    await say(page, phrase(300, 4));
    expect(await confirmed(page)).toEqual({ s: 300, e: 303 });
    await expect(status(page)).toHaveText('Following');
    await expect(page.locator('#vilnaLiveAnchorOverlay > div')).toHaveCount(0);
  });

  test('the tapped start is used once: the next Start searches again unless a word is tapped', async ({ page }) => {
    await openChosen(page);
    await tapWord(page, 300);
    await page.locator('#lfStartButton').click();
    await expect.poll(() => page.evaluate(() => live.tracker !== null)).toBe(true);
    expect(await page.evaluate(() => live.anchorIndex)).toBeNull();
    await page.locator('#lfStartButton').click(); // Stop
    await expect(page.locator('#lfStartButton')).toHaveText('Start live follow');
    await page.locator('#lfStartButton').click();
    await expect.poll(() => page.evaluate(() => live.tracker !== null)).toBe(true);
    expect(await page.evaluate(() => live.tracker.locked)).toBe(false);
  });

  test('starting without tapping anything falls back to finding the place by listening', async ({ page }) => {
    await openChosen(page);
    await page.locator('#lfStartButton').click();
    await expect.poll(() => page.evaluate(() => live.tracker !== null)).toBe(true);
    expect(await page.evaluate(() => live.tracker.locked)).toBe(false);
    await say(page, phrase(200, 7)); // one long clear phrase is still enough to lock
    expect(await confirmed(page)).toEqual({ s: 200, e: 206 });
  });

  test('tapping mid-session replaces a drifted position, including where search could never place it', async ({ page }) => {
    await openChosen(page);
    await page.locator('#lfStartButton').click();
    await expect.poll(() => page.evaluate(() => live.tracker !== null)).toBe(true);
    await say(page, phrase(400, 7));
    expect(await confirmed(page)).toEqual({ s: 400, e: 406 });

    // Words 52-57 repeat verbatim on this daf: automatic search can't tell which copy.
    await tapWord(page, 52);
    await expect(page.locator('#vilnaLiveAnchorOverlay > div')).toHaveCount(1);
    expect(await confirmed(page)).toBeNull();
    expect(await page.evaluate(() => live.tracker.cursor)).toBe(52);
    await expect(status(page)).toHaveText('Following');
    await say(page, phrase(52, 6));
    expect(await confirmed(page)).toEqual({ s: 52, e: 57 });
  });

  test('a tap also unsticks a session stuck on Listening', async ({ page }) => {
    await openChosen(page);
    await page.locator('#lfStartButton').click();
    await expect.poll(() => page.evaluate(() => live.tracker !== null)).toBe(true);
    await say(page, phrase(400, 7));
    for (let i = 0; i < 3; i += 1) await say(page, `ברכתנו${'ם'.repeat(i)} ומקצתם לעיגול שפרקוד ננעמיה חלמוני דסבתקל`);
    await expect(detail(page)).toContainText('tap the word being read');
    await tapWord(page, 640);
    await expect(status(page)).toHaveText('Following');
    await expect(detail(page)).not.toContainText('Not finding your place');
    await say(page, phrase(644, 5));
    expect(await confirmed(page)).toEqual({ s: 644, e: 648 });
  });

  test('tapping the text view sets the place at the start of the paragraph tapped', async ({ page }) => {
    await openFollowing(page);
    await page.evaluate(() => switchDafView('text'));
    await page.locator('#dafPage .daf-segment').nth(1).click();
    const index = await page.evaluate(() => live.daf.firstCanonOfSegment.get(1));
    expect(await page.evaluate(() => live.log.filter((e) => e.kind === 'anchor').pop())).toMatchObject({ index });
    await expect(page.locator('#vilnaLiveAnchorOverlay')).toBeAttached();
  });

  test('a tap never plays a recording (nothing is seeked, nothing loaded)', async ({ page }) => {
    await openFollowing(page);
    await page.evaluate(() => { window.__seeks = 0; const seek = window.seek; window.seek = (...a) => { window.__seeks += 1; return seek(...a); }; });
    await tapWord(page, 120);
    await page.evaluate(() => { const w = live.daf.canon.words[130]; playWordInline(w.ref, w.wordIndex); seekToVilnaWord(w.ref, w.wordIndex); });
    expect(await page.evaluate(() => window.__seeks)).toBe(0);
    expect(await page.evaluate(() => live.log.filter((e) => e.kind === 'anchor').length)).toBe(3);
  });
});

test.describe('Live follow — session log', () => {
  test('Copy session log copies what was heard and what was decided', async ({ page }) => {
    await openFollowing(page);
    await page.evaluate(() => { live.log = []; live.logStart = performance.now(); window.__copied = null; navigator.clipboard.writeText = async (t) => { window.__copied = t; }; });
    await say(page, phrase(400, 7));
    await say(page, 'so what is the question here');
    await page.locator('#lfDebugConnection').scrollIntoViewIfNeeded().catch(() => {});
    await page.evaluate(() => document.querySelector('.lf-debug').setAttribute('open', ''));
    await page.locator('#lfCopyLogButton').click();
    await expect(page.locator('#toast')).toContainText('Session log copied');
    const log = JSON.parse(await page.evaluate(() => window.__copied));
    expect(log.daf).toBe('Chullin 91a');
    const commits = log.entries.filter((e) => e.kind === 'commit');
    expect(commits).toHaveLength(2);
    expect(commits[0].outcomes[0]).toMatchObject({ words: 7, kind: 'jump', s: 400, e: 406 });
    expect(commits[0].state).toBe('Following');
    expect(commits[1].outcomes).toEqual([]);
    expect(commits[1].state).toBe('Explaining');
  });
});

// ---- Batch second opinion -------------------------------------------------------------------------

test.describe('Live follow — batch second opinion (on by default, ?batch=0 turns it off)', () => {
  // Garbled beyond placing: the realtime model "heard" nothing the daf can use.
  const GARBLE = 'ברכתנו ומקצתם לעיגול שפרקוד ננעמיה חלמוני';

  async function open(page, { query = '', batchText = '', hold = null, status = 200 } = {}) {
    const requests = [];
    await openBrowse(page, { query });
    // After the page's own stubs (the latest route wins).
    await page.route('**/api/live-batch', async (route) => {
      requests.push(route.request().postDataJSON());
      if (hold) await hold;
      return route.fulfill({
        status, contentType: 'application/json',
        body: JSON.stringify(status === 200 ? { text: batchText, languageCode: 'heb', languageProbability: 0.9, ms: 1200 } : { error: 'no' }),
      });
    });
    await page.locator('#lfToggle').click();
    await pick(page, 'Chullin 91a');
    await expect.poll(() => page.evaluate(() => dafLiveFollow.__test.live.daf?.label)).toBe('Chullin 91a');
    await alias(page);
    await page.evaluate(() => {
      live.tracker = LiveMatcher.createTracker(live.daf.canon, { eagerRelocalize: true });
      live.preview = LiveMatcher.createPreview(live.daf.canon, live.tracker);
    });
    // A few seconds of "sent" audio, as the socket would have recorded.
    await page.evaluate(() => { for (let i = 0; i < 40; i += 1) recordSentAudio(new Int16Array(1600).fill(i + 1).buffer); });
    return requests;
  }
  const batchEntries = (page) => page.evaluate(() => live.log.filter((e) => e.kind === 'batch'));

  test('?batch=0 turns it off: nothing is sent to the batch function', async ({ page }) => {
    const requests = await open(page, { query: '?batch=0', batchText: phrase(407, 7) });
    await say(page, phrase(400, 7));
    await say(page, GARBLE);
    await page.waitForTimeout(300);
    expect(requests).toHaveLength(0);
  });

  test('when the live model places nothing and the batch model can, the batch placement is applied', async ({ page }) => {
    const requests = await open(page, { batchText: phrase(407, 7) });
    await say(page, phrase(400, 7));
    await expect.poll(() => requests.length).toBe(1); // the first commit's segment
    await say(page, GARBLE);
    await expect.poll(() => batchEntries(page).then((e) => e.filter((x) => x.seq === 2).length)).toBe(1);
    const rescued = (await batchEntries(page)).find((e) => e.seq === 2);
    expect(rescued.rescued).toEqual({ s: 407, e: 413 });
    expect(rescued.realtime.every((r) => r.miss)).toBe(true);
    expect(rescued.batch[0]).toMatchObject({ s: 407, e: 413 });
    expect(await confirmed(page)).toEqual({ s: 407, e: 413 });
    await expect(status(page)).toHaveText('Following');
    await expect(page.locator('#lfDebugBatch')).toContainText('placed it when the live model could not');
  });

  test('the side-by-side scoring also searches the whole daf when the reading jumps beyond the local window', async ({ page }) => {
    const requests = await open(page, { batchText: phrase(100, 8) });
    await say(page, phrase(400, 7)); // locked at 400
    await expect.poll(() => requests.length).toBe(1);
    await say(page, phrase(100, 8)); // jumps far back
    await expect.poll(() => batchEntries(page).then((e) => e.length)).toBe(2);
    const entry = (await batchEntries(page)).find((e) => e.seq === 2);
    expect(entry.realtime[0]).toMatchObject({ s: 100, e: 107, far: true });
    expect(entry.batch[0]).toMatchObject({ s: 100, e: 107, far: true });
  });

  test('the request carries the audio and the daf\'s keyterms, and no forced language', async ({ page }) => {
    const requests = await open(page, { batchText: '' });
    await say(page, phrase(400, 7));
    await expect.poll(() => requests.length).toBe(1);
    const [body] = requests;
    expect(Buffer.from(body.audioBase64, 'base64').length).toBeGreaterThanOrEqual(32000); // 1s+ of 16kHz 16-bit audio
    expect(body.keyterms.length).toBeGreaterThan(50);
    expect(body.keyterms.length).toBeLessThanOrEqual(412);
    expect(body.language).toBeUndefined();
  });

  test('it is only logged, never applied, when the live model placed the segment', async ({ page }) => {
    const requests = await open(page, { batchText: phrase(420, 7) });
    await say(page, phrase(400, 7));
    await expect.poll(() => requests.length).toBe(1);
    await expect.poll(() => batchEntries(page).then((e) => e.length)).toBe(1);
    const [entry] = await batchEntries(page);
    expect(entry.rescued).toBeNull();
    expect(entry.realtime[0]).toMatchObject({ s: 400, e: 406 });
    expect(await confirmed(page)).toEqual({ s: 400, e: 406 });
  });

  test('a late batch result never drags the highlight back over newer progress', async ({ page }) => {
    let release;
    const hold = new Promise((resolve) => { release = resolve; });
    const requests = await open(page, { batchText: phrase(407, 7), hold });
    await say(page, phrase(400, 7)); // its own batch request is held too
    await say(page, GARBLE); // realtime misses
    await expect.poll(() => requests.length).toBe(2);
    await say(page, phrase(414, 7)); // the reading moves on before the batch answers
    release();
    await expect.poll(() => batchEntries(page).then((e) => e.length)).toBe(3);
    expect((await batchEntries(page)).find((e) => e.seq === 2).rescued).toBeNull();
    expect(await confirmed(page)).toEqual({ s: 414, e: 420 });
  });

  test('a tap while the batch result is in flight also wins', async ({ page }) => {
    let release;
    const hold = new Promise((resolve) => { release = resolve; });
    const requests = await open(page, { batchText: phrase(407, 7), hold });
    await say(page, phrase(400, 7));
    await say(page, GARBLE);
    await expect.poll(() => requests.length).toBe(2);
    await page.evaluate(() => setAnchor(600));
    release();
    await expect.poll(() => batchEntries(page).then((e) => e.length)).toBe(2);
    expect(await confirmed(page)).toBeNull();
    expect(await page.evaluate(() => live.tracker.cursor)).toBe(600);
  });

  test('a segment under a second is not worth a round trip', async ({ page }) => {
    const requests = await open(page, { batchText: phrase(407, 7) });
    await page.evaluate(() => { live.audioChunks = []; live.sentSamples = 0; live.lastCommitSample = 0; recordSentAudio(new Int16Array(8000).buffer); });
    await say(page, phrase(400, 7));
    await page.waitForTimeout(300);
    expect(requests).toHaveLength(0);
  });

  test('a failing batch request is logged and changes nothing', async ({ page }) => {
    const requests = await open(page, { status: 502 });
    await say(page, phrase(400, 7));
    await say(page, GARBLE);
    await expect.poll(() => requests.length).toBe(2);
    await expect.poll(() => batchEntries(page).then((e) => e.length)).toBe(2);
    expect((await batchEntries(page))[0].error).toBe('no');
    expect(await confirmed(page)).toEqual({ s: 400, e: 406 });
    await expect(page.locator('#lfDebugBatch')).toContainText('error');
  });

  test('segmentAudio returns exactly the requested slice of what was sent', async ({ page }) => {
    await openFollowing(page);
    const sums = await page.evaluate(() => {
      live.audioChunks = []; live.sentSamples = 0;
      for (let i = 0; i < 5; i += 1) recordSentAudio(new Int16Array(1600).fill(i + 1).buffer); // 1600 each of 1,2,3,4,5
      const a = segmentAudio(1000, 4200); // spans chunks 0..2
      return { length: a.length, first: a[0], atBoundary: a[600], last: a[a.length - 1], empty: segmentAudio(5, 5).length, past: segmentAudio(7000, 99999).length };
    });
    expect(sums).toEqual({ length: 3200, first: 1, atBoundary: 2, last: 3, empty: 0, past: 1000 });
  });

  test('the audio kept is capped, not unbounded', async ({ page }) => {
    await openFollowing(page);
    const kept = await page.evaluate(() => {
      live.audioChunks = []; live.sentSamples = 0;
      for (let i = 0; i < 1500; i += 1) recordSentAudio(new Int16Array(1600).buffer); // 150 seconds
      return live.audioChunks.reduce((n, c) => n + c.data.length, 0) / 16000;
    });
    expect(kept).toBeLessThanOrEqual(91);
    expect(kept).toBeGreaterThanOrEqual(89);
  });
});

// ---- Audio-path switches and diagnostics ------------------------------------------------------------

test.describe('Live follow — audio-path switches and diagnostics', () => {
  async function startWithMic(page, query = '') {
    await openBrowse(page, { query });
    await page.locator('#lfToggle').click();
    await pick(page, 'Chullin 91a');
    await expect.poll(() => page.evaluate(() => dafLiveFollow.__test.live.daf?.label)).toBe('Chullin 91a');
    await alias(page);
    await page.locator('#lfStartButton').click();
    await expect.poll(() => page.evaluate(() => live.log.some((e) => e.kind === 'audio'))).toBe(true);
  }

  test('by default echo cancellation, noise suppression and automatic gain are turned off', async ({ page }) => {
    await startWithMic(page);
    const c = await page.evaluate(() => window.__constraints);
    expect(c.audio).toMatchObject({ channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false });
    const start = await page.evaluate(() => live.log.find((e) => e.kind === 'start'));
    expect(start.options.raw).toBe(true);
  });

  test('?raw=0 leaves the browser\'s own voice processing as the browser chooses', async ({ page }) => {
    await startWithMic(page, '?raw=0');
    const c = await page.evaluate(() => window.__constraints);
    expect(c).toEqual({ audio: { channelCount: 1 } });
    const start = await page.evaluate(() => live.log.find((e) => e.kind === 'start'));
    expect(start.options.raw).toBe(false);
  });

  test('the log records what the browser actually gave us, and level statistics are being gathered', async ({ page }) => {
    await startWithMic(page);
    const audio = await page.evaluate(() => live.log.find((e) => e.kind === 'audio'));
    expect(audio).toMatchObject({ contextRate: 16000, source: 'microphone' });
    for (const key of ['contextState', 'trackRate', 'echoCancellation', 'noiseSuppression', 'autoGainControl', 'channels']) {
      expect(audio, key).toHaveProperty(key);
    }
    expect(await page.evaluate(() => live.levelStats !== null && live.levelTimer !== null)).toBe(true);
    await page.locator('#lfStartButton').click(); // Stop
    await expect.poll(() => page.evaluate(() => live.levelStats === null && live.levelTimer === null)).toBe(true);
  });

  test('?keyterms=0 sends no bias list, and nothing is watched for in the transcript', async ({ page }) => {
    await startWithMic(page, '?keyterms=0');
    const url = new URL(await page.evaluate(() => buildWsUrl('t', activeKeyterms())));
    expect(url.searchParams.getAll('keyterms')).toEqual([]);
    expect(await page.evaluate(() => activeKeytermTokens().length)).toBe(0);
    expect(await page.evaluate(() => PAGE_OPTIONS.keyterms)).toBe(false);
  });

  test('by default the daf\'s keyterms are sent', async ({ page }) => {
    await startWithMic(page);
    const url = new URL(await page.evaluate(() => buildWsUrl('t', activeKeyterms())));
    expect(url.searchParams.getAll('keyterms').length).toBeGreaterThan(12);
  });
});

// ---- A video link, and the other ways to follow -----------------------------------------------------

test.describe('Live follow — video link and the page\'s own player', () => {
  const MEDIA = 'https://cdn.example.org/shiur/chullin-91.wav';
  const YT_LINK = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90';

  // A 30 second, 8kHz, 8-bit mono silent WAV: small, and a real <video> source.
  function wav() {
    const rate = 8000; const seconds = 30; const n = rate * seconds;
    const buf = Buffer.alloc(44 + n, 128);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + n, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate, 28);
    buf.writeUInt16LE(1, 32); buf.writeUInt16LE(8, 34); buf.write('data', 36); buf.writeUInt32LE(n, 40);
    return buf;
  }

  // The transcript a reading of the daf would give: phrases of 7 words every
  // 3 seconds, an English aside, then the reading again from further on.
  function transcriptWords() {
    const words = [];
    const read = (from, phrases, offset) => {
      for (let p = 0; p < phrases; p += 1) {
        fixture.canonNorms.slice(from + p * 7, from + p * 7 + 7).forEach((text, i) => {
          words.push([text, +(offset + p * 3 + i * 0.3).toFixed(2), +(offset + p * 3 + i * 0.3 + 0.25).toFixed(2)]);
        });
      }
    };
    read(407, 3, 1); // 1s..9s
    'so what is the gemara asking here and why does rav ashi need it'.split(' ').forEach((text, i) => words.push([text, +(10 + i * 0.3).toFixed(2), +(10.25 + i * 0.3).toFixed(2)]));
    read(500, 2, 20); // 20s..26s
    return words;
  }

  async function setup(page, { statuses, query = '', transcript = null, noTabShare = false } = {}) {
    await openBrowse(page, { query, noTabShare });
    const seen = { status: [], job: [], saves: [], ytLoads: [] };
    const queue = statuses ? [...statuses] : [{ status: 'done', words: transcript || transcriptWords(), languageCode: 'heb', seconds: 26 }];
    await page.route('**/api/live-video-status?*', (route) => {
      seen.status.push(new URL(route.request().url()).searchParams);
      const next = queue.length > 1 ? queue.shift() : queue[0];
      return route.fulfill({ status: next.__code || 200, contentType: 'application/json', body: JSON.stringify(next) });
    });
    await page.route('**/.netlify/functions/live-video-job-background', (route) => {
      seen.job.push(route.request().postDataJSON());
      return route.fulfill({ status: 202, body: '' });
    });
    // The link must never be saved as this daf's video, for everyone.
    await page.route('**/api/save-video-link', (route) => { seen.saves.push(route.request().postData()); return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }); });
    // With Range support, as a real file server has: without it a <video> cannot seek.
    const wavBytes = wav();
    await page.route(MEDIA, (route) => {
      const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range || '');
      if (!range) return route.fulfill({ status: 200, contentType: 'audio/wav', headers: { 'Accept-Ranges': 'bytes' }, body: wavBytes });
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), wavBytes.length - 1) : wavBytes.length - 1;
      return route.fulfill({
        status: 206, contentType: 'audio/wav',
        headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${wavBytes.length}` },
        body: wavBytes.subarray(start, end + 1),
      });
    });
    // The YouTube player itself is the page's own and out of scope here: a stand-in
    // for it, with the clock and the seek the page reads and drives.
    await page.evaluate(() => {
      window.__yt = { loads: [], time: 0, fail: false };
      window.ensureYouTubePlayer = async (id) => {
        window.__yt.loads.push(id);
        if (window.__yt.fail) throw new Error('The YouTube player did not load.');
        switchPlayerType('html5'); // keeps the page's player type valid without a real iframe
        state.playerType = 'youtube';
        state.youtubeReady = true;
        state.youtubePlayer = { getCurrentTime: () => window.__yt.time, seekTo: (t) => { window.__yt.time = t; }, getDuration: () => 600, pauseVideo() {}, playVideo() {} };
      };
    });
    await page.locator('#lfToggle').click();
    await pick(page, 'Chullin 91a');
    await expect.poll(() => page.evaluate(() => dafLiveFollow.__test.live.daf?.label)).toBe('Chullin 91a');
    await alias(page);
    await page.evaluate(() => { live.videoPollMs = 40; });
    return seen;
  }
  const loadLink = async (page, link) => {
    await chooseSource(page, 'transcript');
    await page.locator('#lfVideoInput').fill(link);
    await page.locator('#lfVideoLoadButton').click();
  };
  // The page's player clock, which the transcript is followed by.
  const setTime = (page, t) => page.evaluate((x) => { window.__time = x; window.getCurrentTime = () => window.__time; }, t);
  const hl = (page) => page.evaluate(() => live.confirmed);

  test('the ways to follow are all offered; the video link box appears with the transcript option', async ({ page }) => {
    await setup(page);
    await expect(page.locator('input[name="lfSource"][value="microphone"]')).toBeChecked();
    await expect(page.locator('input[name="lfSource"][value="tab"]')).toBeEnabled();
    await expect(page.locator('input[name="lfSource"][value="transcript"]')).toBeEnabled();
    await expect(page.locator('#lfVideoRow')).toBeHidden();
    await expect(page.locator('#lfSourceNote')).toContainText('Hears the shiur in the room');
    await chooseSource(page, 'transcript');
    await expect(page.locator('#lfVideoRow')).toBeVisible();
    await expect(page.locator('#lfSourceNote')).toContainText('Transcribes a video link once');
    await chooseSource(page, 'tab');
    await expect(page.locator('#lfVideoRow')).toBeHidden();
    await expect(page.locator('#lfSourceNote')).toContainText('no echo');
  });

  test('a link that is not a video link says so and loads nothing', async ({ page }) => {
    await setup(page);
    for (const bad of ['not a link', 'https://vimeo.com/123', 'https://example.org/page.html', 'http://example.org/a.mp3']) {
      await loadLink(page, bad);
      await expect(page.locator('#lfVideoMessage')).toContainText('isn’t a link I can use');
      await expect(page.locator('#lfVideoMessage')).toHaveClass(/error/);
    }
    expect(await page.evaluate(() => state.videoSource)).toBeNull();
  });

  test('a media link goes into the page\'s own player and is never saved as the daf\'s video', async ({ page }) => {
    const seen = await setup(page);
    await loadLink(page, MEDIA);
    await expect(page.locator('#lfVideoMessage')).toContainText('Video loaded');
    expect(await page.evaluate(() => state.videoSource)).toMatchObject({ type: 'direct', url: MEDIA });
    expect(await page.evaluate(() => document.getElementById('video').src)).toBe(MEDIA);
    await expect(page.locator('input[name="lfSource"][value="transcript"]')).toBeChecked();
    await page.waitForTimeout(300);
    expect(seen.saves).toEqual([]);
    // The page's clock, the one the transcript is followed by, is the real <video> clock.
    await expect.poll(() => page.evaluate(() => document.getElementById('video').readyState)).toBeGreaterThan(0);
    expect(await page.evaluate(() => { seek(12); return getCurrentTime(); })).toBeGreaterThan(11.9);
  });

  const DRIVE_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';
  const DRIVE_SHARE = `https://drive.google.com/file/d/${DRIVE_ID}/view?usp=sharing`;
  const DRIVE_FILE = `https://drive.usercontent.google.com/download?id=${DRIVE_ID}&export=download&confirm=t`;

  test('a Google Drive share link is turned into the file\'s own address, played by the page, and sent for transcription as that', async ({ page }) => {
    const seen = await setup(page);
    await page.route('https://drive.usercontent.google.com/download?*', (route) => route.fulfill({ status: 200, contentType: 'audio/wav', headers: { 'Accept-Ranges': 'bytes' }, body: wav() }));
    await loadLink(page, DRIVE_SHARE);
    await expect(page.locator('#lfVideoMessage')).toContainText('Video loaded');
    await expect(page.locator('#lfVideoMessage')).not.toHaveClass(/error/);
    expect(await page.evaluate(() => state.videoSource)).toMatchObject({ type: 'direct', url: DRIVE_FILE, label: 'Google Drive' });
    expect(await page.evaluate(() => document.getElementById('video').src)).toBe(DRIVE_FILE);
    await page.locator('#lfStartButton').click();
    await expect.poll(() => seen.status.length).toBeGreaterThan(0);
    expect(seen.status[0].get('url')).toBe(DRIVE_FILE); // what the server is asked about
    expect(seen.saves).toEqual([]);
  });

  // When the page's player cannot play a Drive file, the server asks Drive why (live-video-probe.mjs)
  // and the page says what it found.
  const WHY = [
    ['file', { outcome: 'file', status: 206, contentType: 'audio/x-ms-wma', size: 52428800 }, 'serving this file (audio/x-ms-wma, 50 MB), but this browser would not play it'],
    ['too-big', { outcome: 'too-big', status: 200, contentType: 'text/html', size: null }, 'virus-scan page'],
    ['private', { outcome: 'private', status: 403, contentType: 'text/html', size: null }, 'asking for a sign-in'],
    ['quota', { outcome: 'quota', status: 403, contentType: 'text/html', size: null }, 'paused downloads of this file'],
    ['missing', { outcome: 'missing', status: 404, contentType: 'text/html', size: null }, 'cannot find that file'],
    ['unreachable', { outcome: 'unreachable', detail: 'timeout' }, 'Could not reach Google Drive'],
    ['page', { outcome: 'page', status: 200, contentType: 'text/html', size: null }, 'would not play this file'],
  ];
  for (const [name, probeResult, expected] of WHY) {
    test(`a Drive file the player cannot play: the page says why (${name})`, async ({ page }) => {
      await setup(page);
      const asked = [];
      await page.route('**/api/live-video-probe?*', (route) => { asked.push(new URL(route.request().url()).searchParams.get('url')); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(probeResult) }); });
      // What Drive sends when it will not hand over the file: a web page, not audio.
      await page.route('https://drive.usercontent.google.com/download?*', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<html>Sign in</html>' }));
      await loadLink(page, DRIVE_SHARE);
      await expect(page.locator('#lfVideoMessage')).toContainText(expected);
      await expect(page.locator('#lfVideoMessage')).toHaveClass(/error/);
      expect(asked).toEqual([DRIVE_FILE]);
    });
  }

  test('if even the check fails, the page falls back to the general Drive message', async ({ page }) => {
    await setup(page);
    await page.route('**/api/live-video-probe?*', (route) => route.fulfill({ status: 502, contentType: 'application/json', body: '{}' }));
    await page.route('https://drive.usercontent.google.com/download?*', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<html>x</html>' }));
    await loadLink(page, DRIVE_SHARE);
    await expect(page.locator('#lfVideoMessage')).toContainText('Google Drive would not play this file');
    await expect(page.locator('#lfVideoMessage')).toContainText('anyone with the link');
  });

  test('a file that is not on Drive is not sent to the Drive check', async ({ page }) => {
    await setup(page);
    let asked = 0;
    await page.route('**/api/live-video-probe?*', (route) => { asked += 1; return route.fulfill({ status: 200, body: '{}' }); });
    await page.route('https://cdn.example.org/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<html>x</html>' }));
    await loadLink(page, 'https://cdn.example.org/shiur/x.mp3');
    await expect(page.locator('#lfVideoMessage')).toContainText('This browser could not play that file');
    expect(asked).toBe(0);
  });

  test('a Drive folder or a Google Doc is not a file link, and says so', async ({ page }) => {
    await setup(page);
    for (const bad of [`https://drive.google.com/drive/folders/${DRIVE_ID}`, `https://docs.google.com/document/d/${DRIVE_ID}/edit`]) {
      await loadLink(page, bad);
      await expect(page.locator('#lfVideoMessage')).toContainText('Google Drive link to an audio or video file');
      await expect(page.locator('#lfVideoMessage')).toHaveClass(/error/);
    }
  });

  test('a YouTube link goes into the page\'s own player, from its start time, and is not saved either', async ({ page }) => {
    const seen = await setup(page);
    await loadLink(page, YT_LINK);
    await expect(page.locator('#lfVideoMessage')).toContainText('Video loaded');
    expect(await page.evaluate(() => window.__yt.loads)).toEqual(['dQw4w9WgXcQ']);
    expect(await page.evaluate(() => state.videoSource)).toMatchObject({ type: 'youtube', videoId: 'dQw4w9WgXcQ', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
    expect(await page.evaluate(() => getCurrentTime())).toBe(90);
    await page.waitForTimeout(300);
    expect(seen.saves).toEqual([]);
  });

  test('a YouTube player that will not load is reported', async ({ page }) => {
    await setup(page);
    await page.evaluate(() => { window.__yt.fail = true; });
    await loadLink(page, YT_LINK);
    await expect(page.locator('#lfVideoMessage')).toContainText('did not load');
    await expect(page.locator('#lfVideoMessage')).toHaveClass(/error/);
    expect(await page.evaluate(() => state.videoSource)).toBeNull();
  });

  test('a video already on the page is the one the transcript option uses', async ({ page }) => {
    await openBrowse(page);
    await page.evaluate(() => { state.videoSource = { type: 'youtube', videoId: 'dQw4w9WgXcQ', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }; });
    await page.locator('#lfToggle').click();
    await expect(page.locator('input[name="lfSource"][value="transcript"]')).toBeChecked();
  });

  test('transcript mode: waits for the job, then the highlight follows the playhead, holds through English, and seeks both ways', async ({ page }) => {
    const seen = await setup(page, {
      statuses: [{ status: 'absent' }, { status: 'pending', elapsedMs: 2000 }, { status: 'pending', elapsedMs: 5000 },
        { status: 'done', words: transcriptWords(), languageCode: 'heb', seconds: 26 }],
    });
    await loadLink(page, MEDIA);
    await page.locator('#lfStartButton').click();
    await expect(status(page)).toHaveText('Transcribing…');
    await expect(page.locator('#lfStartButton')).toHaveText('Stop live follow');
    await expect(status(page)).not.toHaveText('Transcribing…');

    // What was asked of the server: this video, this daf, the bias list.
    expect(seen.job).toHaveLength(1);
    expect(seen.job[0].url).toBe(MEDIA);
    expect(seen.job[0].daf).toBe('Chullin 91a');
    expect(seen.job[0].keyterms.length).toBeGreaterThan(50);
    expect(seen.status[0].get('url')).toBe(MEDIA);
    expect(seen.status[0].get('kt')).toBe('1');

    await setTime(page, 0.5);
    await expect(status(page)).toHaveText('Waiting…');
    expect(await hl(page)).toBeNull();

    await setTime(page, 2);
    await expect.poll(() => hl(page)).toMatchObject({ s: 407 });
    await expect(status(page)).toHaveText('Following');
    await expect(detail(page)).toContainText('Following the video');
    await expect(activeBars(page).first()).toBeVisible();

    await setTime(page, 8);
    await expect.poll(() => hl(page).then((h) => h?.s)).toBe(407 + 14);

    await setTime(page, 12);
    await expect(status(page)).toHaveText('Explaining');
    expect((await hl(page)).s).toBe(407 + 14); // held on the last phrase read
    await quiet(page).toHaveClass(/lf-quiet/);

    await setTime(page, 22);
    await expect.poll(() => hl(page).then((h) => h?.s)).toBe(500);
    await expect(status(page)).toHaveText('Following');

    await setTime(page, 4); // back
    await expect.poll(() => hl(page).then((h) => h?.s)).toBe(407 + 7);
    await setTime(page, 1000);
    await expect.poll(() => hl(page).then((h) => h?.s)).toBe(500 + 7);

    const log = await page.evaluate(() => live.log);
    expect(log.find((e) => e.kind === 'transcript')).toMatchObject({ language: 'heb', placed: 5 });
    expect(log.find((e) => e.kind === 'start')).toMatchObject({ source: 'transcript', video: MEDIA });
    // No microphone and no socket were ever involved.
    expect(await page.evaluate(() => [window.__constraints, live.ws, live.micStream])).toEqual([null, null, null]);
  });

  test('transcript mode on a link whose job is already finished starts straight away without starting a job', async ({ page }) => {
    const seen = await setup(page);
    await loadLink(page, MEDIA);
    await page.locator('#lfStartButton').click();
    await setTime(page, 2);
    await expect.poll(() => hl(page).then((h) => h?.s)).toBe(407);
    expect(seen.job).toHaveLength(0);
  });

  test('a word tapped before Start is where the transcript is aligned from', async ({ page }) => {
    await setup(page);
    await loadLink(page, MEDIA);
    await tapWord(page, 407);
    await page.locator('#lfStartButton').click();
    await setTime(page, 2);
    await expect.poll(() => hl(page).then((h) => h?.s)).toBe(407);
    expect(await page.evaluate(() => live.log.find((e) => e.kind === 'anchor'))).toMatchObject({ index: 407, midSession: false });
  });

  test('tapping a word while following a video re-places the phrases from the playhead on', async ({ page }) => {
    await setup(page);
    await loadLink(page, MEDIA);
    await page.locator('#lfStartButton').click();
    await setTime(page, 2);
    await expect.poll(() => hl(page).then((h) => h?.s)).toBe(407);
    await setTime(page, 14); // in the English aside
    await expect(status(page)).toHaveText('Explaining');
    await tapWord(page, 498);
    await expect.poll(() => hl(page).then((h) => h?.s)).toBe(498);
    await setTime(page, 21);
    await expect.poll(() => hl(page).then((h) => h?.s)).toBe(500);
  });

  test('a transcript job that fails is reported with the way out, and Start works again', async ({ page }) => {
    const seen = await setup(page, { statuses: [{ status: 'absent' }, { status: 'error', error: 'ElevenLabs returned 422.', detail: 'cannot fetch' }] });
    await loadLink(page, MEDIA);
    await page.locator('#lfStartButton').click();
    await expect(status(page)).toHaveText('Error', { timeout: 20000 });
    await expect(detail(page)).toContainText('422');
    await expect(detail(page)).toContainText('Tab audio or the microphone');
    await expect(page.locator('#lfStartButton')).toHaveText('Start live follow');
    expect(await page.evaluate(() => live.videoFollow)).toBeNull();
    expect(seen.job.length).toBeGreaterThanOrEqual(1);
  });

  test('an old failure is retried once, not shown', async ({ page }) => {
    const seen = await setup(page, { statuses: [{ status: 'error', error: 'old failure' }, { status: 'pending' }, { status: 'done', words: transcriptWords(), languageCode: 'heb', seconds: 26 }] });
    await loadLink(page, MEDIA);
    await page.locator('#lfStartButton').click();
    await setTime(page, 2);
    await expect.poll(() => hl(page).then((h) => h?.s)).toBe(407);
    expect(seen.job).toHaveLength(1);
  });

  test('the server refusing the link (400) is shown', async ({ page }) => {
    await setup(page, { statuses: [{ __code: 400, error: 'Use a YouTube link, or a direct https link.' }] });
    await loadLink(page, MEDIA);
    await page.locator('#lfStartButton').click();
    await expect(status(page)).toHaveText('Error');
    await expect(detail(page)).toContainText('Use a YouTube link');
  });

  test('stopping while the transcript is being made cancels it cleanly', async ({ page }) => {
    const seen = await setup(page, { statuses: [{ status: 'absent' }, { status: 'pending' }] });
    await loadLink(page, MEDIA);
    await page.locator('#lfStartButton').click();
    await expect(status(page)).toHaveText('Transcribing…');
    await page.locator('#lfStartButton').click();
    await expect(status(page)).toHaveText('Ready');
    const polls = seen.status.length;
    await page.waitForTimeout(300);
    expect(seen.status.length).toBeLessThanOrEqual(polls + 1);
    await expect(page.locator('#lfStartButton')).toHaveText('Start live follow');
  });

  test('a transcript with no speech in it is reported', async ({ page }) => {
    await setup(page, { transcript: [] });
    await loadLink(page, MEDIA);
    await page.locator('#lfStartButton').click();
    await expect(detail(page)).toContainText('No speech was found');
  });

  test('transcript mode without a video loaded asks for one and starts nothing', async ({ page }) => {
    await setup(page);
    await chooseSource(page, 'transcript');
    await page.locator('#lfStartButton').click();
    await expect(detail(page)).toContainText('Paste a video link');
    expect(await page.evaluate(() => [live.videoFollow, live.micStream])).toEqual([null, null]);
  });

  test('a video playing on the page is left alone when live follow turns on and off', async ({ page }) => {
    await setup(page);
    await loadLink(page, MEDIA);
    await page.locator('#lfToggle').click();
    expect(await page.evaluate(() => state.videoSource)).toMatchObject({ type: 'direct', url: MEDIA });
    expect(await page.evaluate(() => document.getElementById('video').src)).toBe(MEDIA);
  });

  test('tab audio mode asks the browser for this tab\'s sound, with the voice processing off, and keeps no picture', async ({ page }) => {
    await setup(page);
    await chooseSource(page, 'tab');
    await page.locator('#lfStartButton').click();
    await expect.poll(() => page.evaluate(() => window.__display)).not.toBeNull();
    expect(await page.evaluate(() => window.__display)).toMatchObject({
      preferCurrentTab: true,
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    expect(await page.evaluate(() => window.__constraints)).toBeNull(); // not the microphone
    await expect(page.locator('#lfStartButton')).toHaveText('Stop live follow');
    expect(await page.evaluate(() => window.__displayStream.getVideoTracks().every((t) => t.enabled === false))).toBe(true);
    const log = await page.evaluate(() => live.log);
    expect(log.find((e) => e.kind === 'start')).toMatchObject({ source: 'tab' });
    expect(log.find((e) => e.kind === 'audio')).toMatchObject({ source: 'tab', contextRate: 16000 });
  });

  test('tab audio with no sound shared says what to tick', async ({ page }) => {
    await setup(page);
    await page.evaluate(() => { window.__noAudioShared = true; });
    await chooseSource(page, 'tab');
    await page.locator('#lfStartButton').click();
    await expect(detail(page)).toContainText('Share tab audio');
    await expect(page.locator('#lfStartButton')).toHaveText('Start live follow');
  });

  test('cancelling the tab-share dialog is reported as that, not as a microphone problem', async ({ page }) => {
    await setup(page);
    await page.evaluate(() => { navigator.mediaDevices.getDisplayMedia = () => Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' })); });
    await chooseSource(page, 'tab');
    await page.locator('#lfStartButton').click();
    await expect(detail(page)).toHaveText('Tab sharing was cancelled or denied.');
  });

  test('ending the tab share from the browser stops live follow', async ({ page }) => {
    await setup(page);
    await chooseSource(page, 'tab');
    await page.locator('#lfStartButton').click();
    await expect(page.locator('#lfStartButton')).toHaveText('Stop live follow');
    await page.evaluate(() => { const t = live.micStream.getAudioTracks()[0]; t.stop(); t.dispatchEvent(new Event('ended')); });
    await expect(page.locator('#lfStartButton')).toHaveText('Start live follow');
  });

  test('where the browser cannot share a tab, that option is disabled and says why', async ({ page }) => {
    await setup(page, { noTabShare: true });
    await expect(page.locator('input[name="lfSource"][value="tab"]')).toBeDisabled();
    await page.evaluate(() => { const r = document.querySelector('input[name="lfSource"][value="tab"]'); r.disabled = false; r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); });
    await expect(page.locator('#lfSourceNote')).toContainText('Not available in this browser');
  });

  test('switching how to follow mid-session restarts in the new mode', async ({ page }) => {
    await setup(page);
    await chooseSource(page, 'microphone');
    await page.locator('#lfStartButton').click();
    await expect(page.locator('#lfStartButton')).toHaveText('Stop live follow');
    expect(await page.evaluate(() => window.__constraints)).not.toBeNull();
    await chooseSource(page, 'tab');
    await expect.poll(() => page.evaluate(() => window.__display)).not.toBeNull();
    await expect(page.locator('#lfStartButton')).toHaveText('Stop live follow');
    await chooseSource(page, 'microphone');
    // The log starts afresh with each session, so the last start is the one now running.
    await expect.poll(() => page.evaluate(() => live.log.filter((e) => e.kind === 'start').map((e) => e.source))).toEqual(['microphone']);
    await expect(page.locator('#lfStartButton')).toHaveText('Stop live follow');
  });
});

// ---- The printed daf and the page's own views ---------------------------------------------------------

test.describe('Live follow — the page\'s own views follow the reading', () => {
  const barBoxes = (page, selector = '#vilnaActiveOverlay > div') => page.evaluate((sel) => [...document.querySelectorAll(sel)].map((el) => ({
    left: parseFloat(el.style.left) / 100, top: parseFloat(el.style.top) / 100, width: parseFloat(el.style.width) / 100, height: parseFloat(el.style.height) / 100,
  })), selector);
  const boxOf = (page, index) => page.evaluate((i) => { const w = live.daf.canon.words[i]; return state.vilnaPageMap.wordBoxes.find((b) => b.ref === w.ref && b.wordIndex === w.wordIndex) || null; }, index);

  test('the placed phrase is highlighted on the printed page: bars on the printed lines of exactly those words', async ({ page }) => {
    await openFollowing(page);
    await say(page, phrase(0, 7));
    expect(await confirmed(page)).toEqual({ s: 0, e: 6 });
    await expect(activeBars(page).first()).toBeVisible();
    const rects = await barBoxes(page);
    for (let i = 0; i <= 6; i += 1) {
      const b = await boxOf(page, i);
      if (!b) continue;
      const cy = b.y + b.h / 2;
      const hit = rects.find((r) => b.x >= r.left - 0.001 && b.x + b.w <= r.left + r.width + 0.001 && cy >= r.top - 0.004 && cy <= r.top + r.height + 0.004);
      expect(hit, `word ${i} is under a bar`).toBeTruthy();
    }
    for (const r of rects) expect(r.height).toBeLessThan(0.02); // a printed line's ink, not a fat block
  });

  test('a phrase that runs on from one paragraph into the next is highlighted in full, not cut at the paragraph', async ({ page }) => {
    await openFollowing(page);
    // Words 120-128: 120-122 end paragraph 5, 123-128 begin paragraph 6.
    await say(page, phrase(120, 9));
    expect(await confirmed(page)).toEqual({ s: 120, e: 128 });
    const first = await boxOf(page, 121);
    const last = await boxOf(page, 128);
    const rects = await barBoxes(page);
    expect(rects.length).toBeGreaterThanOrEqual(2); // the word at the line's end, and the next line
    const covers = (b) => rects.some((r) => b.x >= r.left - 0.001 && b.x + b.w <= r.left + r.width + 0.001 && Math.abs((b.y + b.h / 2) - (r.top + r.height / 2)) < 0.006);
    expect(covers(first)).toBe(true);
    expect(covers(last)).toBe(true); // a paragraph-6 word: the bar has to reach it
  });

  test('the bars are snapped to the printed ink, as in the player', async ({ page }) => {
    await openFollowing(page);
    await say(page, phrase(0, 7));
    await expect(activeBars(page).first()).toBeVisible();
    const [rect] = await barBoxes(page);
    const box = await boxOf(page, 0);
    // The stand-in page has ink from 20% to 75% of each box's height: a snapped bar spans exactly that.
    expect(Math.abs(rect.top - (box.y + box.h * 0.2))).toBeLessThan(0.0015);
    expect(Math.abs(rect.height - box.h * 0.55)).toBeLessThan(0.0025);
  });

  test('the highlight follows the reading from line to line, and clears when only a tapped word is shown', async ({ page }) => {
    await openFollowing(page);
    await say(page, phrase(0, 7));
    await expect(activeBars(page).first()).toBeVisible();
    const first = (await barBoxes(page))[0];
    await say(page, phrase(200, 7));
    await expect.poll(async () => (await barBoxes(page))[0]?.top).toBeGreaterThan(first.top + 0.05);
    await page.evaluate(() => setAnchor(10));
    await expect(activeBars(page)).toHaveCount(0);
    await expect(page.locator('#vilnaLiveAnchorOverlay > div')).toHaveCount(1);
  });

  test('the text view follows too: the paragraph being read is the active one, with its words narrowed to the phrase', async ({ page }) => {
    await openFollowing(page);
    await say(page, phrase(120, 7)); // words 120-122 end paragraph 5 (its words 34..37), the rest begin paragraph 6
    const info = await page.evaluate(() => ({ index: state.activeIndex, seg: state.segments[state.activeIndex] }));
    expect(info.seg.ref).toBe('Chullin 91a.5');
    expect([info.seg.w0, info.seg.w1]).toEqual([34, 37]); // the part of the phrase in this paragraph
    await page.evaluate(() => switchDafView('text'));
    await expect(page.locator('#dafPage .daf-segment.active')).toHaveCount(1);
    expect(await page.locator('#dafPage .daf-segment.active').getAttribute('data-index')).toBe(String(info.index));
    // The paragraph that was active goes back to being whole.
    await say(page, phrase(200, 7));
    const earlier = await page.evaluate(() => ({ w0: state.segments[4].w0, w1: state.segments[4].w1, tokens: live.daf.tokenCounts[4] }));
    expect([earlier.w0, earlier.w1]).toEqual([0, earlier.tokens - 1]);
  });

  test('the lighter in-progress highlight is drawn on the page too, and replaced by the confirmed one', async ({ page }) => {
    await openFollowing(page);
    await page.evaluate(() => setProvisional({ s: 30, e: 35 }));
    await expect(page.locator('#vilnaLiveProvisionalOverlay > div').first()).toBeVisible();
    await expect(activeBars(page)).toHaveCount(0);
    await say(page, phrase(30, 7));
    await expect(activeBars(page).first()).toBeVisible();
    await expect(page.locator('#vilnaLiveProvisionalOverlay > div')).toHaveCount(0);
  });

  test('while explaining the bar goes quiet, as the text does', async ({ page }) => {
    await openFollowing(page);
    await say(page, phrase(0, 7));
    await quiet(page).not.toHaveClass(/lf-quiet/);
    await say(page, 'and so the gemara goes on to explain what this means in plain english');
    await quiet(page).toHaveClass(/lf-quiet/);
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('#vilnaActiveOverlay .vilna-active-rect')).backgroundColor)).not.toBe('rgb(142, 205, 245)');
    await say(page, phrase(7, 7));
    await quiet(page).not.toHaveClass(/lf-quiet/);
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('#vilnaActiveOverlay .vilna-active-rect')).backgroundColor)).toBe('rgb(142, 205, 245)');
  });

  test('a tap on a printed word sets the place there, exactly as tapping the text does', async ({ page }) => {
    await openFollowing(page);
    await clickPrintedWord(page, 60);
    expect(await page.evaluate(() => live.log.filter((e) => e.kind === 'anchor').pop())).toMatchObject({ index: 60, midSession: true });
    await expect(page.locator('#vilnaLiveAnchorOverlay > div')).toHaveCount(1);
    await say(page, phrase(60, 6));
    expect(await confirmed(page)).toEqual({ s: 60, e: 65 });
    await expect(page.locator('#vilnaLiveAnchorOverlay > div')).toHaveCount(0);
  });

  test('the tap lands on the word, not the phrase: two words of one phrase are different places', async ({ page }) => {
    await openFollowing(page);
    for (const index of [100, 104]) {
      await clickPrintedWord(page, index);
      expect(await page.evaluate(() => live.log.filter((e) => e.kind === 'anchor').pop().index)).toBe(index);
    }
  });

  test('a tap on blank paper (or the commentary) sets nothing', async ({ page }) => {
    await openFollowing(page);
    await page.locator('#vilnaPageCanvas').scrollIntoViewIfNeeded();
    const corner = await page.evaluate(() => { const r = document.getElementById('vilnaPageCanvas').getBoundingClientRect(); return { x: r.left + r.width * 0.02, y: Math.min(r.bottom - 8, innerHeight - 8) }; });
    await page.mouse.click(corner.x, corner.y);
    expect(await page.evaluate(() => live.log.filter((e) => e.kind === 'anchor').length)).toBe(0);
  });

  test('zoom scales the page and the bars together, and a tap still lands on the right word', async ({ page }) => {
    await openFollowing(page);
    await page.locator('#vilnaZoomInButton').click();
    await page.locator('#vilnaZoomInButton').click();
    expect(await page.locator('#vilnaPageWrap').evaluate((el) => el.style.transform)).toBe('scale(1.4)');
    await clickPrintedWord(page, 12);
    expect(await page.evaluate(() => live.log.filter((e) => e.kind === 'anchor').pop())).toMatchObject({ index: 12 });
    const scaled = await page.evaluate(() => document.getElementById('vilnaPageCanvas').getBoundingClientRect().width / document.getElementById('vilnaPageCanvas').offsetWidth);
    expect(scaled).toBeCloseTo(1.4, 1);
  });

  test('reading across the join turns the printed page, and the picker with it', async ({ page }) => {
    const seen = await openFollowing(page);
    await say(page, phrase(0, 7));
    const firstOfB = await page.evaluate(() => live.daf.canon.words.findIndex((w) => w.ref.startsWith('Chullin 91b.')));
    expect(firstOfB).toBeGreaterThan(300);
    await say(page, phrase(firstOfB + 20, 7));
    await expect.poll(() => page.evaluate(() => state.browsePageRef)).toBe('Chullin 91b');
    await expect.poll(() => seen.pages.includes('Chullin-91b')).toBe(true);
    await expect(page.locator('#dafAmudToggle .amud-option.active')).toHaveText('b');
    expect(await page.evaluate(() => document.getElementById('dafTitle').textContent)).toBe('Chullin 91b');
    await say(page, phrase(0, 7)); // and back
    await expect.poll(() => page.evaluate(() => state.browsePageRef)).toBe('Chullin 91a');
    await expect(page.locator('#dafAmudToggle .amud-option.active')).toHaveText('a');
  });

  test('the page\'s Previous / Next buttons only turn the page while the daf followed covers it', async ({ page }) => {
    const seen = await openFollowing(page);
    const sefariaBefore = seen.sefaria.length;
    await page.locator('#browseNextButton').click(); // 91a -> 91b: the second page of the same pair
    await expect.poll(() => page.evaluate(() => state.browsePageRef)).toBe('Chullin 91b');
    expect(await page.evaluate(() => live.daf.key)).toBe('Chullin 91a|Chullin 91b');
    expect(seen.sefaria.length).toBe(sefariaBefore); // nothing was loaded
    expect(await page.evaluate(() => state.liveFollow.active)).toBe(true);
    await page.locator('#browseNextButton').click(); // 91b -> 92a: a different daf now
    await expect.poll(() => page.evaluate(() => live.daf.key)).toBe('Chullin 92a|Chullin 92b');
    await expect(page.locator('#lfDafName')).toHaveText('Chullin 92a');
  });

  test('picking another daf makes it the daf to follow, and stops a session that was running', async ({ page }) => {
    await openFollowing(page);
    await page.locator('#lfStartButton').click();
    await expect.poll(() => page.evaluate(() => live.micStream !== null)).toBe(true);
    await pick(page, 'Chullin 92a');
    await expect.poll(() => page.evaluate(() => live.daf.label)).toBe('Chullin 92a');
    expect(await page.evaluate(() => live.micStream)).toBeNull();
    await expect(page.locator('#lfStartButton')).toHaveText('Start live follow');
    expect(await page.evaluate(() => state.dafRef)).toBe('Chullin 92a');
  });

  test('the page\'s other viewing modes work with it: daf on video draws the same words over the video', async ({ page }) => {
    await openFollowing(page);
    await say(page, phrase(120, 9));
    await page.evaluate(() => setViewerMode('daf-on-video'));
    await page.evaluate(() => updateVideoOverlay(0));
    expect(await page.evaluate(() => state.videoOverlayEnabled)).toBe(true);
    await expect(page.locator('#videoVilnaOverlay')).toBeVisible();
    // It asks the same question the page asks for its printed highlight: the words being read.
    const asked = await page.evaluate(() => { const n = activeSegmentWordBoxes(state.segments[state.activeIndex]).length; return n; });
    expect(asked).toBeGreaterThan(5);
    expect(await page.evaluate(() => activeSegmentWordBoxes(state.segments[state.activeIndex]).map((b) => `${b.ref}#${b.wordIndex}`))).toEqual(
      await page.evaluate(() => dafLiveFollow.activeWordBoxes().map((b) => `${b.ref}#${b.wordIndex}`)),
    );
    await page.evaluate(() => setViewerMode('standard'));
  });

  test('with live follow off the page highlights exactly as before (the hooks do nothing)', async ({ page }) => {
    await openBrowse(page);
    const result = await page.evaluate(() => {
      state.vilnaPageMap = { wordBoxes: [
        { ref: 'Chullin 89a.1', wordIndex: 0, x: 0.8, y: 0.1, w: 0.1, h: 0.02 },
        { ref: 'Chullin 89a.1', wordIndex: 1, x: 0.7, y: 0.1, w: 0.1, h: 0.02 },
        { ref: 'Chullin 89a.1', wordIndex: 2, x: 0.6, y: 0.1, w: 0.1, h: 0.02 },
        { ref: 'Chullin 89a.2', wordIndex: 0, x: 0.8, y: 0.3, w: 0.1, h: 0.02 },
      ] };
      const seg = { ref: 'Chullin 89a.1', w0: 1, w1: 2 };
      return { live: state.liveFollow, ids: activeSegmentWordBoxes(seg).map((b) => b.wordIndex), seek: findSegmentAt(5) };
    });
    expect(result.live).toBeNull();
    expect(result.ids).toEqual([1, 2]);
    expect(result.seek).toBeGreaterThanOrEqual(-1);
  });
});
