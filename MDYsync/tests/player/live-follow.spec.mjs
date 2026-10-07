import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { preparePage, failOnPageError } from '../support/harness.mjs';

// /live/ (Live Follow) end to end, minus the one piece that can't run here:
// the real ElevenLabs realtime WebSocket (no key in this environment, and
// no interest in tying this suite to a live, metered third-party service).
// Transcripts are fed straight into live.js's own handleCommitted/
// handlePartial -- the exact functions the socket's message handler calls
// -- so everything from the transcript onward (run splitting, the matcher,
// the follow states, highlighting) is exercised for real. The matcher
// itself is held to the Python original separately, in
// tests/functions/live-matcher.test.mjs.
//
// The daf served here is real Sefaria text for Chullin 91a/91b, taken from
// that suite's own fixture, rather than the harness's two-line stub, so
// matching runs against a realistically sized and repetitive daf.

const fixture = JSON.parse(readFileSync(new URL('../fixtures/live-matcher-parity.json', import.meta.url), 'utf8'));
const phrase = (start, length) => fixture.canonNorms.slice(start, start + length).join(' ');

async function serveRealDaf(page) {
  await page.route('**/api/sefaria?*', (route) => {
    const ref = new URL(route.request().url()).searchParams.get('ref');
    const he = fixture.segments.filter((s) => s.ref.startsWith(`${ref}:`)).map((s) => s.he);
    return he.length
      ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ he }) })
      : route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not found"}' });
  });
  // live.js falls back to Sefaria directly when the proxy fails -- never
  // let that reach the real network from a test.
  await page.route('https://www.sefaria.org/**', (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"offline in tests"}' })
  );
}

// Loads Chullin 91a(+b) and arms the tracker exactly as startLiveFollow
// does, without opening a microphone or a socket.
// Chooses a daf the way a person does: tractate, daf, then side. (Choosing
// shows it -- see onDafPicked in live.js.)
async function pickDaf(page, ref) {
  const [, tractate, daf, side] = /^(.+?)\s+(\d+)([ab])$/.exec(ref);
  await expect.poll(() => page.locator('#liveTractateSelect option').count()).toBeGreaterThan(1);
  await page.locator('#liveTractateSelect').selectOption(tractate);
  await page.locator('#liveDafSelect').selectOption(daf);
  await page.locator(`#liveAmudToggle .amud-option[data-side="${side}"]`).click();
  await expect(page.locator('#liveRefInput')).toHaveValue(ref);
}

async function openFollowing(page, query = '') {
  await preparePage(page, { user: null });
  await serveRealDaf(page);
  await page.goto(`/live/${query}`);
  await page.evaluate(async () => {
    await loadDaf(parseDafInput('Chullin 91a'));
    live.tracker = LiveMatcher.createTracker(live.daf.canon, { eagerRelocalize: true });
    live.preview = LiveMatcher.createPreview(live.daf.canon, live.tracker);
  });
}
const say = (page, text) => page.evaluate((t) => handleCommitted(t), text);
const confirmed = (page) => page.evaluate(() => live.confirmed);

test.describe('Live Follow page basics', () => {
  test('loads cleanly and validates an empty daf', async ({ page }) => {
    const errors = failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/live/');
    await expect(page.locator('#liveStartButton')).toBeVisible();
    await page.evaluate(() => { document.getElementById('liveRefInput').value = ''; });
    await page.locator('#liveStartButton').click();
    await expect(page.locator('#toast')).toHaveClass(/show/);
    await expect(page.locator('#toast')).toContainText('Choose a daf first');
    expect(errors).toEqual([]);
  });

  test('an unknown daf fails before the microphone is ever requested', async ({ page }) => {
    const errors = failOnPageError(page);
    await preparePage(page, { user: null });
    await serveRealDaf(page);
    await page.addInitScript(() => {
      window.__micRequests = 0;
      navigator.mediaDevices.getUserMedia = () => { window.__micRequests += 1; return Promise.reject(new Error('should not be called')); };
    });
    await page.goto('/live/');
    await expect.poll(() => page.locator('#liveTractateSelect option').count()).toBeGreaterThan(1);
    await page.evaluate(() => { document.getElementById('liveRefInput').value = 'Chullin 999a'; });
    await page.locator('#liveStartButton').click();
    await expect(page.locator('#liveStatusText')).toHaveText('Error');
    await expect(page.locator('#liveStatusDetail')).toContainText('Could not load Chullin 999a');
    expect(await page.evaluate(() => window.__micRequests)).toBe(0);
    expect(errors.filter((e) => !e.includes('Could not load the daf') && !e.includes('404'))).toEqual([]);
  });

  test('handles a denied microphone gracefully', async ({ page }) => {
    const errors = failOnPageError(page);
    await preparePage(page, { user: null });
    await serveRealDaf(page);
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }));
    });
    await page.goto('/live/');
    await pickDaf(page, 'Chullin 91a');
    await page.locator('#liveStartButton').click();
    await expect(page.locator('#liveStatusText')).toHaveText('Error');
    await expect(page.locator('#liveStatusDetail')).toContainText('denied');
    await expect(page.locator('#liveStartButton')).toHaveText('Start Live Follow');
    // live.js deliberately console.errors a mic-permission failure (same
    // convention as scan-live.js's own camera-denied path).
    expect(errors.filter((e) => !e.includes('Could not open the microphone'))).toEqual([]);
  });

  test('loads the daf, opens the mic and requests a token with real audio frames flowing', async ({ page }) => {
    const errors = failOnPageError(page);
    await preparePage(page, { user: null });
    await serveRealDaf(page);
    let tokenRequested = false;
    await page.route('**/api/live-token', (route) => {
      tokenRequested = true;
      return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"not configured in test"}' });
    });
    await page.addInitScript(() => {
      // A real (silent) MediaStream -- createMediaStreamSource() needs a
      // genuine one, not a stand-in object.
      navigator.mediaDevices.getUserMedia = () => Promise.resolve(new AudioContext().createMediaStreamDestination().stream);
    });
    await page.goto('/live/');
    await pickDaf(page, 'Chullin 91a');
    await page.locator('#liveStartButton').click();
    await expect.poll(() => tokenRequested).toBe(true);
    await expect(page.locator('#liveStatusText')).toHaveText('Error', { timeout: 5000 });
    await expect(page.locator('#liveDafHeading')).toHaveText('Chullin 91a – Chullin 91b');
    expect(await page.evaluate(() => live.daf.keyterms.length)).toBeLessThanOrEqual(50);
    // Chrome logs the stubbed 503 itself; not a live.js error.
    expect(errors.filter((e) => !e.includes('503'))).toEqual([]);
  });
});

test.describe('Live Follow — daf picker', () => {
  async function open(page, query = '') {
    await preparePage(page, { user: null });
    await serveRealDaf(page);
    await page.goto(`/live/${query}`);
    await expect.poll(() => page.locator('#liveTractateSelect option').count()).toBeGreaterThan(1);
  }

  test('lists all 36 tractates and starts on today\'s daf, without loading its text', async ({ page }) => {
    await open(page);
    expect(await page.locator('#liveTractateSelect option').count()).toBe(36);
    await expect(page.locator('#liveTractateSelect')).toHaveValue('Chullin'); // the harness's calendar says Chullin 89
    await expect(page.locator('#liveDafSelect')).toHaveValue('89');
    await expect(page.locator('#liveAmudToggle .amud-option.active')).toHaveText('a');
    await expect(page.locator('#liveRefInput')).toHaveValue('Chullin 89a');
    expect(await page.locator('#liveDafText .w').count()).toBe(0);
  });

  test('the daf list follows the tractate, and the sides follow the daf', async ({ page }) => {
    await open(page);
    await page.locator('#liveTractateSelect').selectOption('Berakhot');
    const dafs = await page.locator('#liveDafSelect option').evaluateAll((o) => o.map((x) => Number(x.value)));
    expect([dafs[0], dafs[dafs.length - 1], dafs.length]).toEqual([2, 64, 63]);
    // Berakhot ends on 64a: no b side there.
    await page.locator('#liveDafSelect').selectOption('64');
    await expect(page.locator('#liveAmudToggle .amud-option[data-side="b"]')).toBeDisabled();
    await expect(page.locator('#liveAmudToggle .amud-option.active')).toHaveText('a');
    await expect(page.locator('#liveRefInput')).toHaveValue('Berakhot 64a');
    // ...and back to a daf with both sides, the side that was chosen stays.
    await page.locator('#liveDafSelect').selectOption('10');
    await expect(page.locator('#liveAmudToggle .amud-option[data-side="b"]')).toBeEnabled();
    await page.locator('#liveAmudToggle .amud-option[data-side="b"]').click();
    await expect(page.locator('#liveRefInput')).toHaveValue('Berakhot 10b');
    await page.locator('#liveDafSelect').selectOption('11');
    await expect(page.locator('#liveRefInput')).toHaveValue('Berakhot 11b');
  });

  test('a page that does not exist (Nazir 33b) cannot be picked', async ({ page }) => {
    await open(page);
    await page.locator('#liveTractateSelect').selectOption('Nazir');
    await page.locator('#liveDafSelect').selectOption('33');
    await expect(page.locator('#liveAmudToggle .amud-option[data-side="b"]')).toBeDisabled();
    await expect(page.locator('#liveRefInput')).toHaveValue('Nazir 33a');
  });

  test('a ?daf= link opens on that daf and shows it', async ({ page }) => {
    await open(page, '?daf=Chullin%2091a');
    await expect(page.locator('#liveRefInput')).toHaveValue('Chullin 91a');
    await expect(page.locator('#liveDafHeading')).toHaveText('Chullin 91a – Chullin 91b');
  });

  test('a ?daf= link to a daf that does not exist is ignored', async ({ page }) => {
    await open(page, '?daf=Chullin%20999a');
    await expect(page.locator('#liveRefInput')).toHaveValue('Chullin 89a'); // today's daf, as with no link
  });

  test('changing the tractate alone loads nothing; choosing the daf does', async ({ page }) => {
    await open(page);
    let requests = 0;
    await page.route('**/api/sefaria?*', (route) => { requests += 1; return route.fulfill({ status: 200, contentType: 'application/json', body: '{"he":["שלום"]}' }); });
    await page.locator('#liveTractateSelect').selectOption('Berakhot');
    await page.waitForTimeout(200);
    expect(requests).toBe(0);
    await expect(page.locator('#liveRefInput')).toHaveValue(/^Berakhot \d+a$/);
    await page.locator('#liveDafSelect').selectOption('5');
    await expect.poll(() => requests).toBeGreaterThan(0);
    await expect(page.locator('#liveDafHeading')).toHaveText('Berakhot 5a – Berakhot 5b');
  });

  test('the b side is a real choice: starting on it follows 91b then 92a', async ({ page }) => {
    await open(page);
    await page.route('**/api/sefaria?*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"he":["שלום"]}' }));
    await page.locator('#liveTractateSelect').selectOption('Chullin');
    await page.locator('#liveDafSelect').selectOption('91');
    await page.locator('#liveAmudToggle .amud-option[data-side="b"]').click();
    await expect(page.locator('#liveDafHeading')).toHaveText('Chullin 91b – Chullin 92a');
  });
});

test.describe('Live Follow tracking', () => {
  test('renders every matchable word of the daf as its own highlightable span', async ({ page }) => {
    await openFollowing(page);
    expect(await page.locator('#liveDafText .w').count()).toBe(fixture.canonNorms.length);
  });

  // A phrase under 6 words is never trusted on its own, so these use 5 words:
  // it takes two agreeing phrases to lock. (6+ clear words lock at once --
  // see the next test.)
  test('a short phrase needs a second agreeing one to lock, then follows the reading', async ({ page }) => {
    await openFollowing(page);
    await say(page, `so the Gemara says ${phrase(400, 5)}`);
    await expect(page.locator('#liveStatusText')).toHaveText('Searching…');
    expect(await confirmed(page)).toBeNull();
    await expect(page.locator('#liveDebugPending')).toContainText('[400–404]');

    await say(page, phrase(406, 5));
    await expect(page.locator('#liveStatusText')).toHaveText('Following');
    expect(await confirmed(page)).toEqual({ s: 406, e: 410 });
    await expect(page.locator('#liveDafText .w.hl')).toHaveCount(5);
    await expect(page.locator('#livePhraseText')).not.toHaveClass(/empty/);

    await say(page, phrase(412, 6));
    expect(await confirmed(page)).toEqual({ s: 412, e: 417 });
    await expect(page.locator('#liveDafText .w.hl')).toHaveCount(6);
  });

  test('one long, clear phrase locks a fresh session straight away', async ({ page }) => {
    await openFollowing(page);
    await say(page, phrase(400, 7));
    await expect(page.locator('#liveStatusText')).toHaveText('Following');
    expect(await confirmed(page)).toEqual({ s: 400, e: 406 });
  });

  test('a phrase that repeats elsewhere on the daf is held for confirmation, not trusted alone', async ({ page }) => {
    await openFollowing(page);
    await say(page, phrase(52, 6)); // words 52-57 appear twice on this daf
    await expect(page.locator('#liveStatusText')).toHaveText('Searching…');
    expect(await confirmed(page)).toBeNull();
  });

  test('resuming far ahead after an explanation is followed at once, without saying Explaining', async ({ page }) => {
    await openFollowing(page);
    await say(page, phrase(400, 7));
    await say(page, 'so what is the question here? think about it for a second');
    await expect(page.locator('#liveStatusText')).toHaveText('Explaining');
    await say(page, phrase(520, 8)); // well past the +60-word window
    await expect(page.locator('#liveStatusText')).toHaveText('Following');
    expect(await confirmed(page)).toEqual({ s: 520, e: 527 });
    await expect(page.locator('#liveDafText')).not.toHaveClass(/dimmed/);
  });

  test('a lone Hebrew term inside English speech neither moves the highlight nor changes the status', async ({ page }) => {
    await openFollowing(page);
    await say(page, phrase(400, 7));
    await say(page, 'so what is the question here? think about it for a second');
    await expect(page.locator('#liveStatusText')).toHaveText('Explaining');
    // ElevenLabs writes "Gemara" in Hebrew letters; a word on the daf near the cursor must not be "placed".
    const nearby = fixture.canonNorms[410];
    await say(page, `and now the ${nearby} says something`);
    await expect(page.locator('#liveStatusText')).toHaveText('Explaining');
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
    await expect(page.locator('#liveStatusText')).toHaveText('Following');
    const entry = await page.evaluate(() => live.log.filter((e) => e.kind === 'commit').pop());
    expect(entry.cleaned).toContain('·');
  });

  test('a word stuck on repeat is not read as a reading', async ({ page }) => {
    await openFollowing(page);
    await say(page, phrase(400, 7));
    await say(page, 'איננו, איננו, איננו, איננו, איננו, איננו');
    expect(await confirmed(page)).toEqual({ s: 400, e: 406 });
    await expect(page.locator('#liveStatusText')).toHaveText('Explaining');
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
    await expect(page.locator('#liveStatusText')).toHaveText('Listening…');
    await expect(page.locator('#liveStatusDetail')).toContainText('possible new spot');
    await say(page, phrase(407, 6));
    expect(await confirmed(page)).toEqual({ s: 407, e: 412 });
    await expect(page.locator('#liveStatusText')).toHaveText('Following');
  });

  test('a silent commit leaves the status and the highlight alone', async ({ page }) => {
    await openFollowing(page);
    await say(page, phrase(400, 7));
    await say(page, '');
    await expect(page.locator('#liveStatusText')).toHaveText('Following');
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

    await page.goto('/live/?lang=he&filter=1');
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
    await expect(page.locator('#liveStatusText')).toHaveText('Following');
    expect(await confirmed(page)).toEqual({ s: 400, e: 406 });
    expect(await page.evaluate(() => live.unplacedHebrew)).toBe(0);
  });

  test('hearing Hebrew in a partial stops it saying Explaining before the place is found', async ({ page }) => {
    await openFollowing(page);
    await say(page, phrase(400, 7));
    await say(page, 'so what is the question here? think about it for a second');
    await expect(page.locator('#liveStatusText')).toHaveText('Explaining');
    // The resumed reading is somewhere the preview can't place yet: only 2 words so far.
    await page.evaluate((t) => handlePartial(t), `${fixture.canonNorms[600]} ${fixture.canonNorms[601]}`);
    await expect(page.locator('#liveStatusText')).toHaveText('Listening…');
    await expect(page.locator('#liveDafText')).not.toHaveClass(/dimmed/);
  });

  test('the status says Following as soon as the preview has the place, before any commit has locked it', async ({ page }) => {
    await openFollowing(page);
    await page.evaluate((t) => handlePartial(t), phrase(300, 8)); // one decisive partial, nothing committed yet
    await expect(page.locator('#liveStatusText')).toHaveText('Following', { timeout: 1500 });
    expect(await page.evaluate(() => live.tracker.locked)).toBe(false);
    expect((await page.evaluate(() => live.provisional)).s).toBe(302); // the preview follows the partial's last 6 words
  });

  test('Hebrew that cannot be placed says Listening, not Explaining, and eventually says what to do', async ({ page }) => {
    await openFollowing(page);
    await say(page, phrase(400, 7));
    const nonsense = (i) => `ברכתנו${'ם'.repeat(i)} ומקצתם לעיגול שפרקוד ננעמיה חלמוני דסבתקל`;
    await say(page, nonsense(0));
    await expect(page.locator('#liveStatusText')).toHaveText('Listening…');
    await expect(page.locator('#liveDafText')).not.toHaveClass(/dimmed/);
    await expect(page.locator('#liveStatusDetail')).not.toContainText('tap the word');
    await say(page, nonsense(1));
    await say(page, nonsense(2));
    await expect(page.locator('#liveStatusText')).toHaveText('Listening…');
    await expect(page.locator('#liveStatusDetail')).toContainText('tap the word being read');
    // ...and the highlight stayed where it was, rather than wandering.
    expect(await confirmed(page)).toEqual({ s: 400, e: 406 });
    // Placing something clears it.
    await say(page, phrase(407, 6));
    await expect(page.locator('#liveStatusText')).toHaveText('Following');
    await expect(page.locator('#liveStatusDetail')).not.toContainText('tap the word');
  });

  test('an English explanation holds the last phrase, dimmed, instead of guessing', async ({ page }) => {
    await openFollowing(page);
    await say(page, phrase(400, 6));
    await say(page, phrase(406, 6));
    await say(page, 'and what that means is the animal is permitted, you understand');
    await expect(page.locator('#liveStatusText')).toHaveText('Explaining');
    await expect(page.locator('#liveDafText')).toHaveClass(/dimmed/);
    expect(await confirmed(page)).toEqual({ s: 406, e: 411 });
    await expect(page.locator('#liveDafText .w.hl')).toHaveCount(6);

    await say(page, phrase(412, 6));
    await expect(page.locator('#liveStatusText')).toHaveText('Following');
    await expect(page.locator('#liveDafText')).not.toHaveClass(/dimmed/);
  });

  test('a partial transcript previews the next words without moving the tracker', async ({ page }) => {
    await openFollowing(page);
    await say(page, phrase(400, 6));
    await say(page, phrase(406, 6));
    await say(page, 'so what does that mean');
    await expect(page.locator('#liveStatusText')).toHaveText('Explaining');
    await page.evaluate((t) => handlePartial(t), phrase(412, 4));
    await expect(page.locator('#liveDafText .w.hl-provisional')).toHaveCount(4);
    await expect(page.locator('#liveStatusText')).toHaveText('Following', { timeout: 1000 });
    expect(await page.evaluate(() => live.provisional)).toEqual({ s: 412, e: 415 });
    expect(await page.evaluate(() => live.tracker.cursor)).toBe(406);

    await say(page, phrase(412, 6));
    await expect(page.locator('#liveDafText .w.hl-provisional')).toHaveCount(0);
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
    await expect(page.locator('#liveDebugPending')).toContainText('[100–104]');

    await say(page, phrase(105, 5));
    expect(await confirmed(page)).toEqual({ s: 105, e: 109 });
    await expect(page.locator('#liveStatusText')).toHaveText('Following');
    await expect(page.locator('#liveDebugPending')).toHaveText('—');
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

test.describe('Live Follow — pointing at the daf', () => {
  // Shows the daf the way a reader does (Show daf), without starting.
  async function showDaf(page) {
    await preparePage(page, { user: null });
    await serveRealDaf(page);
    // A token that works and a socket that just sits connecting: Start completes
    // and then nothing asynchronous (a failed token request, a dropped socket)
    // can change the status underneath what a test is asserting.
    await page.route('**/api/live-token', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"token":"test-token"}' }));
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.resolve(new AudioContext().createMediaStreamDestination().stream);
      window.WebSocket = class { constructor() { this.readyState = 0; } addEventListener() {} send() {} close() {} };
    });
    await page.goto('/live/');
    await pickDaf(page, 'Chullin 91a');
    await page.locator('#liveShowDafButton').click();
    await expect(page.locator('#liveDafHeading')).toHaveText('Chullin 91a – Chullin 91b');
  }
  const word = (page, i) => page.locator('#liveDafText .w').nth(i);

  test('Show daf loads the text without starting anything', async ({ page }) => {
    await showDaf(page);
    expect(await page.locator('#liveDafText .w').count()).toBe(fixture.canonNorms.length);
    await expect(page.locator('#liveStatusText')).toHaveText('Ready');
    expect(await page.evaluate(() => live.micStream === null && live.ws === null && live.tracker === null)).toBe(true);
  });

  test('choosing a daf in the picker shows it, without pressing anything else', async ({ page }) => {
    await preparePage(page, { user: null });
    await serveRealDaf(page);
    await page.goto('/live/');
    await pickDaf(page, 'Chullin 91a');
    await expect(page.locator('#liveDafHeading')).toHaveText('Chullin 91a – Chullin 91b');
    expect(await page.locator('#liveDafText .w').count()).toBe(fixture.canonNorms.length);
  });

  test('tapping a word before Start marks it, and the session then begins locked there', async ({ page }) => {
    await showDaf(page);
    await word(page, 300).click();
    await expect(word(page, 300)).toHaveClass(/anchor/);
    await expect(page.locator('#liveStatusDetail')).toContainText('tap Start');
    expect(await page.evaluate(() => live.anchorIndex)).toBe(300);

    await page.evaluate(() => startLiveFollow()); // fake mic, a socket that never opens
    expect(await page.evaluate(() => live.tracker.locked && live.tracker.cursor)).toBe(300);
    // The very first phrase -- only 4 words, far too short to place by search -- places at once.
    await say(page, phrase(300, 4));
    expect(await confirmed(page)).toEqual({ s: 300, e: 303 });
    await expect(page.locator('#liveStatusText')).toHaveText('Following');
    await expect(page.locator('#liveDafText .w.anchor')).toHaveCount(0);
  });

  test('the tapped start is used once: the next Start searches again unless a word is tapped', async ({ page }) => {
    await showDaf(page);
    await word(page, 300).click();
    await page.evaluate(() => startLiveFollow());
    expect(await page.evaluate(() => live.anchorIndex)).toBeNull();
    await page.evaluate(() => stopLiveFollow());
    await page.evaluate(() => startLiveFollow());
    expect(await page.evaluate(() => live.tracker.locked)).toBe(false);
  });

  test('starting without tapping anything falls back to finding the place by listening', async ({ page }) => {
    await showDaf(page);
    await page.evaluate(() => startLiveFollow());
    expect(await page.evaluate(() => live.tracker.locked)).toBe(false);
    await say(page, phrase(200, 7)); // one long clear phrase is still enough to lock
    expect(await confirmed(page)).toEqual({ s: 200, e: 206 });
  });

  test('tapping mid-session replaces a drifted position, including where search could never place it', async ({ page }) => {
    await showDaf(page);
    await page.evaluate(() => startLiveFollow());
    await say(page, phrase(400, 7));
    expect(await confirmed(page)).toEqual({ s: 400, e: 406 });

    // Words 52-57 repeat verbatim on this daf: automatic search can't tell which copy.
    await word(page, 52).click();
    await expect(word(page, 52)).toHaveClass(/anchor/);
    expect(await confirmed(page)).toBeNull();
    expect(await page.evaluate(() => live.tracker.cursor)).toBe(52);
    await expect(page.locator('#liveStatusText')).toHaveText('Following');
    await say(page, phrase(52, 6));
    expect(await confirmed(page)).toEqual({ s: 52, e: 57 });
  });

  test('a tap also unsticks a session stuck on Listening', async ({ page }) => {
    await showDaf(page);
    await page.evaluate(() => startLiveFollow());
    await say(page, phrase(400, 7));
    for (let i = 0; i < 3; i += 1) await say(page, `ברכתנו${'ם'.repeat(i)} ומקצתם לעיגול שפרקוד ננעמיה חלמוני דסבתקל`);
    await expect(page.locator('#liveStatusDetail')).toContainText('tap the word being read');
    await word(page, 640).click();
    await expect(page.locator('#liveStatusText')).toHaveText('Following');
    await expect(page.locator('#liveStatusDetail')).not.toContainText('Not finding your place');
    await say(page, phrase(644, 5));
    expect(await confirmed(page)).toEqual({ s: 644, e: 648 });
  });

  test('the daf pickers are locked while listening, and free again after Stop', async ({ page }) => {
    await showDaf(page);
    await page.evaluate(() => startLiveFollow());
    for (const id of ['#liveTractateSelect', '#liveDafSelect', '#liveShowDafButton']) await expect(page.locator(id)).toBeDisabled();
    await expect(page.locator('#liveAmudToggle .amud-option').first()).toBeDisabled();
    await page.evaluate(() => stopLiveFollow());
    for (const id of ['#liveTractateSelect', '#liveDafSelect', '#liveShowDafButton']) await expect(page.locator(id)).toBeEnabled();
    await expect(page.locator('#liveAmudToggle .amud-option.active')).toBeEnabled();
  });

  test('selecting text does not also move the position', async ({ page }) => {
    await showDaf(page);
    await page.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelectorAll('#liveDafText p')[1]);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    });
    await page.evaluate(() => document.querySelectorAll('#liveDafText .w')[300].click());
    await expect(page.locator('#liveDafText .w.anchor')).toHaveCount(0);
  });
});

test.describe('Live Follow — session log', () => {
  test('Copy session log copies what was heard and what was decided', async ({ page }) => {
    await openFollowing(page);
    await page.evaluate(() => { live.log = []; live.logStart = performance.now(); window.__copied = null; navigator.clipboard.writeText = async (t) => { window.__copied = t; }; });
    await say(page, phrase(400, 7));
    await say(page, 'so what is the question here');
    await page.locator('#liveCopyLogButton').click();
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

test.describe('Live Follow — batch second opinion (on by default, ?batch=0 turns it off)', () => {
  const weakText = (start, length) => fixture.canonNorms.slice(start, start + length)
    .map((w) => [...w].map((c, i, all) => (i === all.length - 1 ? 'צ' : c)).join('')).join(' ');
  // Garbled beyond placing: the realtime model "heard" nothing the daf can use.
  const GARBLE = 'ברכתנו ומקצתם לעיגול שפרקוד ננעמיה חלמוני';

  async function open(page, { query = '', batchText = '', hold = null, status = 200 } = {}) {
    const requests = [];
    await openFollowing(page, query);
    // Registered after the page is up: preparePage's catch-all /api/** stub is
    // added during openFollowing, and the most recently added route wins.
    await page.route('**/api/live-batch', async (route) => {
      requests.push(route.request().postDataJSON());
      if (hold) await hold;
      return route.fulfill({
        status, contentType: 'application/json',
        body: JSON.stringify(status === 200 ? { text: batchText, languageCode: 'heb', languageProbability: 0.9, ms: 1200 } : { error: 'no' }),
      });
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
    await expect(page.locator('#liveStatusText')).toHaveText('Following');
    await expect(page.locator('#liveDebugBatch')).toContainText('placed it when the live model could not');
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
    await expect(page.locator('#liveDebugBatch')).toContainText('error');
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

test.describe('Live Follow — audio-path switches and diagnostics', () => {
  async function startWithMic(page, query) {
    await preparePage(page, { user: null });
    await serveRealDaf(page);
    await page.route('**/api/live-token', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"token":"t"}' }));
    await page.addInitScript(() => {
      window.__constraints = null;
      navigator.mediaDevices.getUserMedia = (c) => {
        window.__constraints = c;
        return Promise.resolve(new AudioContext().createMediaStreamDestination().stream);
      };
      window.WebSocket = class { constructor() { this.readyState = 0; } addEventListener() {} send() {} close() {} };
    });
    await page.goto(`/live/${query}`);
    await pickDaf(page, 'Chullin 91a');
    await page.locator('#liveShowDafButton').click();
    await expect(page.locator('#liveDafHeading')).toHaveText('Chullin 91a – Chullin 91b');
    await page.evaluate(() => startLiveFollow());
  }

  test('by default echo cancellation, noise suppression and automatic gain are turned off', async ({ page }) => {
    await startWithMic(page, '');
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
    await startWithMic(page, '');
    const audio = await page.evaluate(() => live.log.find((e) => e.kind === 'audio'));
    expect(audio).toMatchObject({ contextRate: 16000 });
    for (const key of ['contextState', 'trackRate', 'echoCancellation', 'noiseSuppression', 'autoGainControl', 'channels']) {
      expect(audio, key).toHaveProperty(key);
    }
    expect(await page.evaluate(() => live.levelStats !== null && live.levelTimer !== null)).toBe(true);
    await page.evaluate(() => stopLiveFollow());
    expect(await page.evaluate(() => live.levelStats === null && live.levelTimer === null)).toBe(true);
  });

  test('?keyterms=0 sends no bias list, and nothing is watched for in the transcript', async ({ page }) => {
    await startWithMic(page, '?keyterms=0');
    const url = new URL(await page.evaluate(() => buildWsUrl('t', activeKeyterms())));
    expect(url.searchParams.getAll('keyterms')).toEqual([]);
    expect(await page.evaluate(() => activeKeytermTokens().length)).toBe(0);
    const plain = await page.evaluate(() => PAGE_OPTIONS.keyterms);
    expect(plain).toBe(false);
  });

  test('by default the daf\'s keyterms are sent', async ({ page }) => {
    await startWithMic(page, '');
    const url = new URL(await page.evaluate(() => buildWsUrl('t', activeKeyterms())));
    expect(url.searchParams.getAll('keyterms').length).toBeGreaterThan(12);
  });
});

// ---- Video links: embed, tab audio, server transcript ---------------------------

test.describe('Live Follow — video link', () => {
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
    await preparePage(page, { user: null });
    await serveRealDaf(page);
    const seen = { status: [], job: [] };
    const queue = statuses ? [...statuses] : [{ status: 'done', words: transcript || transcriptWords(), languageCode: 'heb', seconds: 26 }];
    await page.route('**/api/live-video-status?*', (route) => {
      seen.status.push(new URL(route.request().url()).searchParams);
      const next = queue.length > 1 ? queue.shift() : queue[0];
      const code = next.__code || 200;
      return route.fulfill({ status: code, contentType: 'application/json', body: JSON.stringify(next) });
    });
    await page.route('**/.netlify/functions/live-video-job-background', (route) => {
      seen.job.push(route.request().postDataJSON());
      return route.fulfill({ status: 202, body: '' });
    });
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
    await page.route('https://www.youtube.com/iframe_api', (route) => route.fulfill({
      status: 200, contentType: 'application/javascript',
      body: `window.__yt = { created: [], time: 0 };
        window.YT = { Player: class { constructor(el, opts) { this.opts = opts; window.__yt.created.push({ videoId: opts.videoId, start: opts.playerVars.start });
          window.__yt.player = this; setTimeout(() => opts.events.onReady({}), 0); }
          getCurrentTime() { return window.__yt.time; } seekTo(t) { window.__yt.time = t; } destroy() { window.__yt.destroyed = true; } } };
        setTimeout(() => window.onYouTubeIframeAPIReady && window.onYouTubeIframeAPIReady(), 0);`,
    }));
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
    await page.goto(`/live/${query}`);
    await page.evaluate(() => { live.videoPollMs = 40; });
    await pickDaf(page, 'Chullin 91a');
    await page.locator('#liveShowDafButton').click();
    await expect(page.locator('#liveDafHeading')).toHaveText('Chullin 91a – Chullin 91b');
    return seen;
  }
  const loadLink = async (page, link) => {
    await page.locator('#liveVideoInput').fill(link);
    await page.locator('#liveVideoLoadButton').click();
  };
  const setTime = (page, t) => page.evaluate((x) => { window.__time = x; live.video.getTime = () => window.__time; }, t);
  const hl = (page) => page.evaluate(() => live.confirmed);
  const wordAt = (index) => fixture.canonNorms[index];

  test('before any link: transcript mode is unavailable, and so is nothing else but tab audio where the browser has it', async ({ page }) => {
    await setup(page);
    await expect(page.locator('input[value="transcript"]')).toBeDisabled();
    await expect(page.locator('input[value="microphone"]')).toBeChecked();
    await expect(page.locator('input[value="tab"]')).toBeEnabled();
    await expect(page.locator('#liveVideoWrap')).toBeHidden();
  });

  test('a link that is not a video link says so and loads nothing', async ({ page }) => {
    await setup(page);
    for (const bad of ['not a link', 'https://vimeo.com/123', 'https://example.org/page.html', 'http://example.org/a.mp3']) {
      await loadLink(page, bad);
      await expect(page.locator('#liveVideoMessage')).toContainText('isn’t a link I can use');
      await expect(page.locator('#liveVideoMessage')).toHaveClass(/error/);
      await expect(page.locator('#liveVideoWrap')).toBeHidden();
      await expect(page.locator('input[value="transcript"]')).toBeDisabled();
    }
  });

  test('a media link embeds a player, enables the transcript mode and selects it', async ({ page }) => {
    await setup(page);
    await loadLink(page, MEDIA);
    await expect(page.locator('#liveVideoWrap video')).toBeVisible();
    await expect(page.locator('#liveVideoWrap video')).toHaveAttribute('src', MEDIA);
    await expect(page.locator('input[value="transcript"]')).toBeEnabled();
    await expect(page.locator('input[value="transcript"]')).toBeChecked();
    await expect(page.locator('#liveVideoMessage')).toContainText('Video loaded');
    // The real <video> clock is what the page reads, and seeking it works.
    await expect.poll(() => page.evaluate(() => document.querySelector('#liveVideoWrap video').readyState)).toBeGreaterThan(0);
    expect(await page.evaluate(() => { document.querySelector('#liveVideoWrap video').currentTime = 12; return live.video.getTime(); })).toBeGreaterThan(11.9);
  });

  test('a YouTube link creates the YouTube player with the video id and start time', async ({ page }) => {
    await setup(page);
    await loadLink(page, YT_LINK);
    await expect(page.locator('#liveVideoMessage')).toContainText('Video loaded');
    expect(await page.evaluate(() => window.__yt.created)).toEqual([{ videoId: 'dQw4w9WgXcQ', start: 90 }]);
    await expect(page.locator('#liveVideoWrap')).toHaveClass(/youtube/);
    await page.evaluate(() => { window.__yt.time = 33; });
    expect(await page.evaluate(() => live.video.getTime())).toBe(33);
    // Loading another link replaces it.
    await loadLink(page, MEDIA);
    expect(await page.evaluate(() => window.__yt.destroyed)).toBe(true);
    await expect(page.locator('#liveVideoWrap video')).toBeVisible();
  });

  test('a YouTube video that cannot be embedded is reported, not half-loaded', async ({ page }) => {
    await setup(page);
    await page.route('https://www.youtube.com/iframe_api', (route) => route.fulfill({
      status: 200, contentType: 'application/javascript',
      body: `window.YT = { Player: class { constructor(el, opts) { setTimeout(() => opts.events.onError({ data: 101 }), 0); } } };
        setTimeout(() => window.onYouTubeIframeAPIReady(), 0);`,
    }));
    await loadLink(page, YT_LINK);
    await expect(page.locator('#liveVideoMessage')).toContainText('doesn’t allow it to be played here');
    await expect(page.locator('input[value="transcript"]')).toBeDisabled();
  });

  test('transcript mode: waits for the job, then the highlight follows the playhead, holds through English, and seeks both ways', async ({ page }) => {
    const seen = await setup(page, {
      statuses: [{ status: 'absent' }, { status: 'pending', elapsedMs: 2000 }, { status: 'pending', elapsedMs: 5000 },
        { status: 'done', words: transcriptWords(), languageCode: 'heb', seconds: 26 }],
    });
    await loadLink(page, MEDIA);
    await page.locator('#liveStartButton').click();
    await expect(page.locator('#liveStatusText')).toHaveText('Transcribing…');
    await expect(page.locator('#liveStartButton')).toHaveText('Stop Live Follow');
    await expect(page.locator('#liveStatusText')).not.toHaveText('Transcribing…');

    // What was asked of the server: this video, this daf, the bias list.
    expect(seen.job).toHaveLength(1);
    expect(seen.job[0].url).toBe(MEDIA);
    expect(seen.job[0].daf).toBe('Chullin 91a');
    expect(seen.job[0].keyterms.length).toBeGreaterThan(50);
    expect(seen.status[0].get('url')).toBe(MEDIA);
    expect(seen.status[0].get('kt')).toBe('1');

    await setTime(page, 0.5);
    await expect(page.locator('#liveStatusText')).toHaveText('Waiting…');
    expect(await hl(page)).toBeNull();

    await setTime(page, 2);
    await expect.poll(() => hl(page)).toMatchObject({ s: 407 });
    await expect(page.locator('#liveStatusText')).toHaveText('Following');
    await expect(page.locator('#liveStatusDetail')).toContainText('Following the video');
    expect(await page.locator('#liveDafText .w.hl').count()).toBeGreaterThan(0);

    await setTime(page, 8);
    await expect.poll(() => hl(page).then((h) => h?.s)).toBe(407 + 14);

    await setTime(page, 12);
    await expect(page.locator('#liveStatusText')).toHaveText('Explaining');
    expect((await hl(page)).s).toBe(407 + 14); // held on the last phrase read
    await expect(page.locator('#liveDafText')).toHaveClass(/dimmed/);

    await setTime(page, 22);
    await expect.poll(() => hl(page).then((h) => h?.s)).toBe(500);
    await expect(page.locator('#liveStatusText')).toHaveText('Following');

    await setTime(page, 4); // back
    await expect.poll(() => hl(page).then((h) => h?.s)).toBe(407 + 7);
    await setTime(page, 1000);
    await expect.poll(() => hl(page).then((h) => h?.s)).toBe(500 + 7);

    const log = await page.evaluate(() => live.log);
    const t = log.find((e) => e.kind === 'transcript');
    expect(t).toMatchObject({ language: 'heb', placed: 5 });
    expect(log.find((e) => e.kind === 'start')).toMatchObject({ source: 'transcript', video: MEDIA });
    // No microphone and no socket were ever involved.
    expect(await page.evaluate(() => [window.__constraints, live.ws, live.micStream])).toEqual([null, null, null]);
  });

  test('transcript mode on a link whose job is already finished starts straight away without starting a job', async ({ page }) => {
    const seen = await setup(page);
    await loadLink(page, MEDIA);
    await page.locator('#liveStartButton').click();
    await setTime(page, 2);
    await expect.poll(() => hl(page).then((h) => h?.s)).toBe(407);
    expect(seen.job).toHaveLength(0);
  });

  test('a word tapped before Start is where the transcript is aligned from', async ({ page }) => {
    await setup(page);
    await loadLink(page, MEDIA);
    await page.locator(`#liveDafText .w[data-i="${407}"]`).click();
    await page.locator('#liveStartButton').click();
    await setTime(page, 2);
    await expect.poll(() => hl(page).then((h) => h?.s)).toBe(407);
    expect(await page.evaluate(() => live.log.find((e) => e.kind === 'anchor'))).toMatchObject({ index: 407, midSession: false });
  });

  test('tapping a word while following a video re-places the phrases from the playhead on', async ({ page }) => {
    await setup(page);
    await loadLink(page, MEDIA);
    await page.locator('#liveStartButton').click();
    await setTime(page, 2);
    await expect.poll(() => hl(page).then((h) => h?.s)).toBe(407);
    await setTime(page, 14); // in the English aside
    await expect(page.locator('#liveStatusText')).toHaveText('Explaining');
    await page.locator('#liveDafText .w[data-i="498"]').click();
    await expect.poll(() => hl(page).then((h) => h?.s)).toBe(498);
    await setTime(page, 21);
    await expect.poll(() => hl(page).then((h) => h?.s)).toBe(500);
  });

  test('a transcript job that fails is reported with the way out, and Start works again', async ({ page }) => {
    const failure = { status: 'error', error: 'ElevenLabs returned 422.', detail: 'cannot fetch' };
    const seen = await setup(page, { statuses: [{ status: 'absent' }, failure] });
    await loadLink(page, MEDIA);
    await page.locator('#liveStartButton').click();
    await expect(page.locator('#liveStatusText')).toHaveText('Error', { timeout: 20000 });
    await expect(page.locator('#liveStatusDetail')).toContainText('422');
    await expect(page.locator('#liveStatusDetail')).toContainText('Tab audio or the microphone');
    await expect(page.locator('#liveStartButton')).toHaveText('Start Live Follow');
    expect(await page.evaluate(() => live.videoFollow)).toBeNull();
    expect(seen.job.length).toBeGreaterThanOrEqual(1);
  });

  test('an old failure is retried once, not shown', async ({ page }) => {
    const seen = await setup(page, {
      statuses: [{ status: 'error', error: 'old failure' }, { status: 'pending' }, { status: 'done', words: transcriptWords(), languageCode: 'heb', seconds: 26 }],
    });
    await loadLink(page, MEDIA);
    await page.locator('#liveStartButton').click();
    await setTime(page, 2);
    await expect.poll(() => hl(page).then((h) => h?.s)).toBe(407);
    expect(seen.job).toHaveLength(1);
  });

  test('the server refusing the link (400) is shown', async ({ page }) => {
    await setup(page, { statuses: [{ __code: 400, error: 'Use a YouTube link, or a direct https link.' }] });
    await loadLink(page, MEDIA);
    await page.locator('#liveStartButton').click();
    await expect(page.locator('#liveStatusText')).toHaveText('Error');
    await expect(page.locator('#liveStatusDetail')).toContainText('Use a YouTube link');
  });

  test('stopping while the transcript is being made cancels it cleanly', async ({ page }) => {
    const seen = await setup(page, { statuses: [{ status: 'absent' }, { status: 'pending' }] });
    await loadLink(page, MEDIA);
    await page.locator('#liveStartButton').click();
    await expect(page.locator('#liveStatusText')).toHaveText('Transcribing…');
    await page.locator('#liveStartButton').click();
    await expect(page.locator('#liveStatusText')).toHaveText('Idle');
    const polls = seen.status.length;
    await page.waitForTimeout(300);
    expect(seen.status.length).toBeLessThanOrEqual(polls + 1);
    await expect(page.locator('#liveStartButton')).toHaveText('Start Live Follow');
  });

  test('a transcript with no speech in it is reported', async ({ page }) => {
    await setup(page, { transcript: [] });
    await loadLink(page, MEDIA);
    await page.locator('#liveStartButton').click();
    await expect(page.locator('#liveStatusDetail')).toContainText('No speech was found');
  });

  test('transcript mode without a video loaded asks for one and starts nothing', async ({ page }) => {
    await setup(page);
    await page.evaluate(() => { const r = document.querySelector('input[value="transcript"]'); r.disabled = false; r.checked = true; });
    await page.locator('#liveStartButton').click();
    await expect(page.locator('#liveStatusDetail')).toContainText('Paste a video link');
    expect(await page.evaluate(() => [live.videoFollow, live.micStream])).toEqual([null, null]);
  });

  test('tab audio mode asks the browser for this tab\'s sound, with the voice processing off, and keeps no picture', async ({ page }) => {
    await setup(page);
    await page.locator('input[value="tab"]').check();
    await page.locator('#liveStartButton').click();
    await expect.poll(() => page.evaluate(() => window.__display)).not.toBeNull();
    const display = await page.evaluate(() => window.__display);
    expect(display).toMatchObject({
      preferCurrentTab: true,
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    expect(await page.evaluate(() => window.__constraints)).toBeNull(); // not the microphone
    await expect(page.locator('#liveStartButton')).toHaveText('Stop Live Follow');
    expect(await page.evaluate(() => window.__displayStream.getVideoTracks().every((t) => t.enabled === false))).toBe(true);
    const log = await page.evaluate(() => live.log);
    expect(log.find((e) => e.kind === 'start')).toMatchObject({ source: 'tab' });
    expect(log.find((e) => e.kind === 'audio')).toMatchObject({ source: 'tab', contextRate: 16000 });
  });

  test('tab audio with no sound shared says what to tick', async ({ page }) => {
    await setup(page);
    await page.evaluate(() => { window.__noAudioShared = true; });
    await page.locator('input[value="tab"]').check();
    await page.locator('#liveStartButton').click();
    await expect(page.locator('#liveStatusDetail')).toContainText('Share tab audio');
    await expect(page.locator('#liveStartButton')).toHaveText('Start Live Follow');
  });

  test('cancelling the tab-share dialog is reported as that, not as a microphone problem', async ({ page }) => {
    await setup(page);
    await page.evaluate(() => { navigator.mediaDevices.getDisplayMedia = () => Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' })); });
    await page.locator('input[value="tab"]').check();
    await page.locator('#liveStartButton').click();
    await expect(page.locator('#liveStatusDetail')).toHaveText('Tab sharing was cancelled or denied.');
  });

  test('ending the tab share from the browser stops Live Follow', async ({ page }) => {
    await setup(page);
    await page.locator('input[value="tab"]').check();
    await page.locator('#liveStartButton').click();
    await expect(page.locator('#liveStartButton')).toHaveText('Stop Live Follow');
    await page.evaluate(() => { const t = live.micStream.getAudioTracks()[0]; t.stop(); t.dispatchEvent(new Event('ended')); });
    await expect(page.locator('#liveStartButton')).toHaveText('Start Live Follow');
  });

  test('where the browser cannot share a tab, that option is disabled and says why', async ({ page }) => {
    await setup(page, { noTabShare: true });
    await expect(page.locator('input[value="tab"]')).toBeDisabled();
    await expect(page.locator('#liveSourceTabNote')).toContainText('not available in this browser');
  });

  test('switching how to follow mid-session restarts in the new mode', async ({ page }) => {
    await setup(page);
    await loadLink(page, MEDIA);
    await page.locator('input[value="microphone"]').check();
    await page.locator('#liveStartButton').click();
    await expect(page.locator('#liveStartButton')).toHaveText('Stop Live Follow');
    expect(await page.evaluate(() => window.__constraints)).not.toBeNull();
    await page.locator('input[value="tab"]').check();
    await expect.poll(() => page.evaluate(() => window.__display)).not.toBeNull();
    await expect(page.locator('#liveStartButton')).toHaveText('Stop Live Follow');
    await page.locator('input[value="transcript"]').check();
    await expect.poll(() => page.evaluate(() => live.videoFollow !== null)).toBe(true);
    expect(await page.evaluate(() => live.micStream)).toBeNull();
    await page.locator('#liveStartButton').click();
    await expect(page.locator('#liveStatusText')).toHaveText('Idle');
    const sources = await page.evaluate(() => live.log.filter((e) => e.kind === 'start').map((e) => e.source));
    expect(sources).toEqual(['transcript']); // the log restarts with each session
  });
});

// ---- The printed daf ------------------------------------------------------------------

const pageMap91a = JSON.parse(readFileSync(new URL('../fixtures/pagemap-chullin-91a.json', import.meta.url), 'utf8'));

test.describe('Live Follow — printed daf', () => {
  // pdf.js is replaced by a stand-in module that "renders" a page with dark
  // bars exactly where the real page map says the printed words are (so the
  // ink-snapping, which reads the canvas, has real lines to find). The
  // geometry, the page map and the real Chullin 91a text are all real.
  const PDFJS = /^https:\/\/cdn\.jsdelivr\.net\/npm\/pdfjs-dist@[^/]+\/build\/pdf\.min\.mjs$/;
  const mockPdfJs = (maps) => `
    const MAPS = ${JSON.stringify(maps)};
    export const GlobalWorkerOptions = {};
    export function getDocument({ data }) {
      const text = new TextDecoder().decode(data);
      const key = /key=(\\S+)/.exec(text)?.[1];
      window.__pdfLoads = (window.__pdfLoads || []).concat(key);
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

  async function servePrinted(page, { maps = { 'Chullin-91a': pageMap91a }, pageStatus = {}, jobStatus = 202 } = {}) {
    const seen = { pages: [], maps: [], jobs: [] };
    await page.route(PDFJS, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: mockPdfJs(maps) }));
    await page.route('**/api/daf-page?*', (route) => {
      const q = new URL(route.request().url()).searchParams;
      const key = `${q.get('tractate')}-${q.get('daf')}${q.get('amud')}`;
      seen.pages.push(key);
      if (pageStatus[key]) return route.fulfill({ status: pageStatus[key], contentType: 'application/json', body: '{"error":"No page image available."}' });
      return route.fulfill({ status: 200, contentType: 'application/pdf', body: `%PDF-fake key=${key}` });
    });
    await page.route('**/api/get-results-file?*', (route) => {
      const key = /pages\/([^.]+)\.json/.exec(decodeURIComponent(new URL(route.request().url()).searchParams.get('path')))?.[1];
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

  async function openPrinted(page, options = {}) {
    await openFollowing(page, '');
    // After the page is prepared: preparePage's catch-all /api/** stub is the
    // most recently added route until then, and the latest route wins.
    const seen = await servePrinted(page, options);
    await page.locator('#liveDafViewToggle [data-view="page"]').click();
    return seen;
  }
  const bars = (page, id = 'liveVilnaActive') => page.locator(`#${id} > div`);
  const barBoxes = (page, id = 'liveVilnaActive') => page.evaluate((x) => [...document.querySelectorAll(`#${x} > div`)].map((el) => ({
    left: parseFloat(el.style.left) / 100, top: parseFloat(el.style.top) / 100, width: parseFloat(el.style.width) / 100, height: parseFloat(el.style.height) / 100,
  })), id);
  const lastAnchor = (page) => page.evaluate(() => live.log.filter((e) => e.kind === 'anchor').pop());
  const drawn = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  // The printed words of canon words s..e: their boxes from the real page map.
  const boxesOf = (s, e) => {
    const out = [];
    for (let i = s; i <= e; i += 1) {
      const w = fixture.canonRefs?.[i];
      if (w) { const box = pageMap91a.wordBoxes.find((b) => b.ref === w.ref && b.wordIndex === w.wordIndex); if (box) out.push(box); }
    }
    return out;
  };

  test('Text is the view to begin with; Printed daf swaps it for the page', async ({ page }) => {
    await openFollowing(page, '');
    await expect(page.locator('#liveDafScroll')).toBeVisible();
    await expect(page.locator('#liveDafPageView')).toBeHidden();
    await expect(page.locator('#liveDafViewToggle .active')).toHaveText('Text');
    await servePrinted(page);
    await page.locator('#liveDafViewToggle [data-view="page"]').click();
    await expect(page.locator('#liveDafPageView')).toBeVisible();
    await expect(page.locator('#liveDafScroll')).toBeHidden();
    await expect(page.locator('#liveDafViewToggle .active')).toHaveText('Printed daf');
    await page.locator('#liveDafViewToggle [data-view="text"]').click();
    await expect(page.locator('#liveDafScroll')).toBeVisible();
    await expect(page.locator('#liveDafPageView')).toBeHidden();
  });

  test('the first page of the daf is fetched the way the player fetches it: the page image and its word map', async ({ page }) => {
    const seen = await openPrinted(page);
    await expect(page.locator('#liveVilnaCanvas')).toBeVisible();
    await expect(page.locator('#liveVilnaStatus')).toBeHidden();
    expect(seen.pages).toEqual(['Chullin-91a']);
    await expect.poll(() => seen.maps).toEqual(['Chullin-91a']);
    const size = await page.locator('#liveVilnaCanvas').evaluate((c) => [c.width > 0, c.height > c.width]);
    expect(size).toEqual([true, true]);
  });

  test('a placed phrase is highlighted on the page, in bars on the printed lines of those words', async ({ page }) => {
    await openPrinted(page);
    await expect(page.locator('#liveVilnaCanvas')).toBeVisible();
    await expect.poll(() => page.evaluate(() => LiveDafPage.state.map !== null)).toBe(true);
    await say(page, phrase(0, 7));
    expect(await confirmed(page)).toEqual({ s: 0, e: 6 });
    await expect(bars(page).first()).toBeVisible();
    const rects = await barBoxes(page);
    const expected = await page.evaluate(() => {
      const out = [];
      for (let i = 0; i <= 6; i += 1) {
        const w = live.daf.canon.words[i];
        const b = LiveDafPage.state.boxIndex.get(`${w.ref.replace(/:(\d+)$/, '.$1')}#${w.wordIndex}`);
        if (b) out.push(b);
      }
      return out;
    });
    expect(expected.length).toBeGreaterThan(3);
    // Every word of the phrase lies within one of the bars (its row, its x-range).
    for (const b of expected) {
      const cy = b.y + b.h / 2;
      const hit = rects.find((r) => b.x >= r.left - 0.001 && b.x + b.w <= r.left + r.width + 0.001 && cy >= r.top - 0.004 && cy <= r.top + r.height + 0.004);
      expect(hit, `word at ${b.x.toFixed(3)},${b.y.toFixed(3)} is under a bar`).toBeTruthy();
    }
    // Thin bars (a printed line's ink, not a fat block) and not stacked on one another.
    for (const r of rects) expect(r.height).toBeLessThan(0.02);
    expect(rects.length).toBeLessThanOrEqual(3);
  });

  test('the bars are snapped to the printed ink, as in the player', async ({ page }) => {
    await openPrinted(page);
    await expect.poll(() => page.evaluate(() => LiveDafPage.state.map !== null)).toBe(true);
    await say(page, phrase(0, 7));
    await expect(bars(page).first()).toBeVisible();
    const [rect] = await barBoxes(page);
    const snapped = await page.evaluate(() => {
      const bands = (() => { const c = document.getElementById('liveVilnaCanvas'); return LiveDafPage.state.inkCache.bands && c.width > 0 ? LiveDafPage.state.inkCache.bands : null; })();
      return bands;
    });
    expect(snapped, 'the ink bands were measured off the canvas').not.toBeNull();
    // The stand-in page has ink from 20% to 75% of each box's height: a snapped bar spans exactly that.
    const box = (await page.evaluate(() => { const w = live.daf.canon.words[0]; return LiveDafPage.state.boxIndex.get(`${w.ref.replace(/:(\d+)$/, '.$1')}#${w.wordIndex}`); }));
    expect(Math.abs(rect.top - (box.y + box.h * 0.2))).toBeLessThan(0.0015);
    expect(Math.abs(rect.height - box.h * 0.55)).toBeLessThan(0.0025);
  });

  test('the highlight follows the reading from line to line, and clears when nothing is placed', async ({ page }) => {
    await openPrinted(page);
    await expect.poll(() => page.evaluate(() => LiveDafPage.state.map !== null)).toBe(true);
    await say(page, phrase(0, 7));
    await expect(bars(page).first()).toBeVisible();
    const first = (await barBoxes(page))[0];
    await say(page, phrase(200, 7));
    await expect.poll(async () => (await barBoxes(page))[0]?.top).toBeGreaterThan(first.top + 0.05);
    await page.evaluate(() => { setAnchor(10); });
    await expect(bars(page)).toHaveCount(0);
    await expect(bars(page, 'liveVilnaAnchor')).toHaveCount(1);
  });

  test('the lighter in-progress highlight is drawn too, and replaced by the confirmed one', async ({ page }) => {
    await openPrinted(page);
    await expect.poll(() => page.evaluate(() => LiveDafPage.state.map !== null)).toBe(true);
    await page.evaluate(() => setProvisional({ s: 30, e: 35 }));
    await expect(bars(page, 'liveVilnaProvisional').first()).toBeVisible();
    await expect(bars(page)).toHaveCount(0);
    await say(page, phrase(30, 7));
    await expect(bars(page).first()).toBeVisible();
    await expect(bars(page, 'liveVilnaProvisional')).toHaveCount(0);
  });

  test('while explaining the bar goes quiet, as the text does', async ({ page }) => {
    await openPrinted(page);
    await expect.poll(() => page.evaluate(() => LiveDafPage.state.map !== null)).toBe(true);
    await say(page, phrase(0, 7));
    await expect(page.locator('#liveDafPageView')).not.toHaveClass(/dimmed/);
    await say(page, 'and so the gemara goes on to explain what this means in plain english');
    await expect(page.locator('#liveDafPageView')).toHaveClass(/dimmed/);
    await say(page, phrase(7, 7));
    await expect(page.locator('#liveDafPageView')).not.toHaveClass(/dimmed/);
  });

  test('tapping a printed word sets the place there, exactly as tapping it in the text does', async ({ page }) => {
    await openPrinted(page);
    await expect.poll(() => page.evaluate(() => LiveDafPage.state.map !== null)).toBe(true);
    const target = await page.evaluate(() => {
      const w = live.daf.canon.words[60];
      const b = LiveDafPage.state.boxIndex.get(`${w.ref.replace(/:(\d+)$/, '.$1')}#${w.wordIndex}`);
      const r = document.getElementById('liveVilnaCanvas').getBoundingClientRect();
      return { x: (b.x + b.w / 2) * r.width, y: (b.y + b.h / 2) * r.height };
    });
    await page.locator('#liveVilnaCanvas').click({ position: target }); // scrolls it into view first
    expect(await lastAnchor(page)).toMatchObject({ index: 60, midSession: true });
    await expect(bars(page, 'liveVilnaAnchor')).toHaveCount(1);
    await expect(page.locator('#liveDafText .w.anchor')).toHaveCount(1);
    // The session carries on from it: the next phrase placed near there is taken.
    await say(page, phrase(60, 6));
    expect(await confirmed(page)).toEqual({ s: 60, e: 65 });
    await expect(bars(page, 'liveVilnaAnchor')).toHaveCount(0);
  });

  test('a tap on blank paper (or the commentary) sets nothing', async ({ page }) => {
    await openPrinted(page);
    await expect.poll(() => page.evaluate(() => LiveDafPage.state.map !== null)).toBe(true);
    const corner = await page.evaluate(() => { const r = document.getElementById('liveVilnaCanvas').getBoundingClientRect(); return { x: r.left + r.width * 0.02, y: r.top + r.height * 0.97 }; });
    await page.mouse.click(corner.x, corner.y);
    expect(await lastAnchor(page)).toBeUndefined();
  });

  test('zoom scales the page and the bars together, and a tap still lands on the right word', async ({ page }) => {
    await openPrinted(page);
    await expect.poll(() => page.evaluate(() => LiveDafPage.state.map !== null)).toBe(true);
    await page.locator('#liveVilnaZoomIn').click();
    await page.locator('#liveVilnaZoomIn').click();
    await expect(page.locator('#liveVilnaZoomLabel')).toHaveText('140%');
    expect(await page.locator('#liveVilnaWrap').evaluate((el) => el.style.transform)).toBe('scale(1.4)');
    const target = await page.evaluate(() => {
      const w = live.daf.canon.words[12];
      const b = LiveDafPage.state.boxIndex.get(`${w.ref.replace(/:(\d+)$/, '.$1')}#${w.wordIndex}`);
      const r = document.getElementById('liveVilnaCanvas').getBoundingClientRect(); // includes the 140% transform
      return { x: (b.x + b.w / 2) * r.width, y: (b.y + b.h / 2) * r.height, scaledWidth: r.width / document.getElementById('liveVilnaCanvas').offsetWidth };
    });
    expect(target.scaledWidth).toBeCloseTo(1.4, 2);
    await page.locator('#liveVilnaCanvas').click({ position: target });
    expect(await lastAnchor(page)).toMatchObject({ index: 12 });
    await page.locator('#liveVilnaZoomReset').click();
    await expect(page.locator('#liveVilnaZoomLabel')).toHaveText('100%');
  });

  test('reading across the join turns the page, and turns back without fetching 91a again', async ({ page }) => {
    const seen = await openPrinted(page);
    await expect.poll(() => page.evaluate(() => LiveDafPage.state.map !== null)).toBe(true);
    await say(page, phrase(0, 7));
    const firstOfB = await page.evaluate(() => live.daf.canon.words.findIndex((w) => w.ref.startsWith('Chullin 91b:')));
    expect(firstOfB).toBeGreaterThan(300);
    await say(page, phrase(firstOfB + 20, 7));
    await expect.poll(() => seen.pages).toEqual(['Chullin-91a', 'Chullin-91b']);
    await expect.poll(() => page.evaluate(() => LiveDafPage.state.key)).toBe('Chullin-91b');
    // 91b has no word map in this test: said plainly, and the job that makes one is asked for.
    await expect(page.locator('#liveVilnaStatus')).toContainText('being prepared');
    expect(seen.jobs).toEqual([{ tractate: 'Chullin', daf: 91, amud: 'b' }]);
    await say(page, phrase(0, 7));
    await expect.poll(() => page.evaluate(() => LiveDafPage.state.key)).toBe('Chullin-91a');
    await expect(bars(page).first()).toBeVisible();
    expect(seen.pages).toEqual(['Chullin-91a', 'Chullin-91b']); // 91a came from the cache
    expect(seen.maps.filter((k) => k === 'Chullin-91a')).toHaveLength(1);
  });

  test('a page with no word map yet: the job is started once, polled, and the highlight appears when the map arrives', async ({ page }) => {
    let ready = false;
    const seen = await openPrinted(page, { maps: { 'Chullin-91a': () => (ready ? pageMap91a : null) } });
    await page.evaluate(() => { LiveDafPage.state.mapPollMs = 80; });
    await expect(page.locator('#liveVilnaStatus')).toContainText('being prepared');
    await say(page, phrase(0, 7));
    await expect(bars(page)).toHaveCount(0);
    ready = true;
    await expect(bars(page).first()).toBeVisible({ timeout: 10000 });
    expect(seen.jobs).toHaveLength(1);
    await expect(page.locator('#liveVilnaStatus')).toBeHidden();
  });

  test('if the job cannot be started the page is still shown, with the reason', async ({ page }) => {
    await openPrinted(page, { maps: {}, jobStatus: 500 });
    await expect(page.locator('#liveVilnaStatus')).toContainText('can’t be highlighted here');
    await expect(page.locator('#liveVilnaCanvas')).toBeVisible();
  });

  test('a page image that cannot be had is reported', async ({ page }) => {
    await openPrinted(page, { pageStatus: { 'Chullin-91a': 404 } });
    await expect(page.locator('#liveVilnaStatus')).toContainText('Couldn’t load the printed page for Chullin 91a');
    await expect(page.locator('#liveVilnaCanvas')).toBeHidden();
  });

  test('the text view keeps its own highlight while the page is shown, and the choice is remembered', async ({ page }) => {
    await openPrinted(page);
    await expect.poll(() => page.evaluate(() => LiveDafPage.state.map !== null)).toBe(true);
    await say(page, phrase(0, 7));
    await page.locator('#liveDafViewToggle [data-view="text"]').click();
    await expect(page.locator('#liveDafText .w.hl')).toHaveCount(7);
    await page.locator('#liveDafViewToggle [data-view="page"]').click();
    await page.reload();
    await expect(page.locator('#liveDafPageView')).toBeVisible();
    await expect(page.locator('#liveDafViewToggle .active')).toHaveText('Printed daf');
  });

  test('choosing another daf while on the page view loads that daf\'s page', async ({ page }) => {
    const seen = await openPrinted(page);
    await expect.poll(() => seen.pages).toEqual(['Chullin-91a']);
    await page.evaluate(() => { document.getElementById('liveRefInput').value = 'Chullin 91b'; });
    await page.route('**/api/sefaria?*', (route) => {
      const ref = new URL(route.request().url()).searchParams.get('ref');
      const he = fixture.segments.filter((s) => s.ref.startsWith(`${ref}:`)).map((s) => s.he);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ he: he.length ? he : ['שלום'] }) });
    });
    await page.evaluate(() => showDaf());
    await expect.poll(() => seen.pages).toEqual(['Chullin-91a', 'Chullin-91b']);
  });
});
