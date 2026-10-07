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
    await page.locator('#liveStartButton').click();
    await expect(page.locator('#toast')).toHaveClass(/show/);
    await expect(page.locator('#toast')).toContainText('Enter a daf like');
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
    await page.locator('#liveRefInput').fill('Chullin 999a');
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
    await page.locator('#liveRefInput').fill('Chullin 91a');
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
    await page.locator('#liveRefInput').fill('Chullin 91a');
    await page.locator('#liveStartButton').click();
    await expect.poll(() => tokenRequested).toBe(true);
    await expect(page.locator('#liveStatusText')).toHaveText('Error', { timeout: 5000 });
    await expect(page.locator('#liveDafHeading')).toHaveText('Chullin 91a – Chullin 91b');
    expect(await page.evaluate(() => live.daf.keyterms.length)).toBeLessThanOrEqual(50);
    // Chrome logs the stubbed 503 itself; not a live.js error.
    expect(errors.filter((e) => !e.includes('503'))).toEqual([]);
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
    await page.locator('#liveRefInput').fill('Chullin 91a');
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

  test('Enter in the daf field shows the daf, like the button', async ({ page }) => {
    await preparePage(page, { user: null });
    await serveRealDaf(page);
    await page.goto('/live/');
    await page.locator('#liveRefInput').fill('Chullin 91a');
    await page.locator('#liveRefInput').press('Enter');
    await expect(page.locator('#liveDafHeading')).toHaveText('Chullin 91a – Chullin 91b');
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

  test('the daf field is locked while listening, and free again after Stop', async ({ page }) => {
    await showDaf(page);
    await page.evaluate(() => startLiveFollow());
    await expect(page.locator('#liveRefInput')).toBeDisabled();
    await expect(page.locator('#liveShowDafButton')).toBeDisabled();
    await page.evaluate(() => stopLiveFollow());
    await expect(page.locator('#liveRefInput')).toBeEnabled();
    await expect(page.locator('#liveShowDafButton')).toBeEnabled();
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

test.describe('Live Follow — batch second opinion (?batch=1)', () => {
  const weakText = (start, length) => fixture.canonNorms.slice(start, start + length)
    .map((w) => [...w].map((c, i, all) => (i === all.length - 1 ? 'צ' : c)).join('')).join(' ');
  // Garbled beyond placing: the realtime model "heard" nothing the daf can use.
  const GARBLE = 'ברכתנו ומקצתם לעיגול שפרקוד ננעמיה חלמוני';

  async function open(page, { query = '?batch=1', batchText = '', hold = null, status = 200 } = {}) {
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

  test('off by default: nothing is sent to the batch function', async ({ page }) => {
    const requests = await open(page, { query: '', batchText: phrase(407, 7) });
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
    await openFollowing(page, '?batch=1');
    const sums = await page.evaluate(() => {
      live.audioChunks = []; live.sentSamples = 0;
      for (let i = 0; i < 5; i += 1) recordSentAudio(new Int16Array(1600).fill(i + 1).buffer); // 1600 each of 1,2,3,4,5
      const a = segmentAudio(1000, 4200); // spans chunks 0..2
      return { length: a.length, first: a[0], atBoundary: a[600], last: a[a.length - 1], empty: segmentAudio(5, 5).length, past: segmentAudio(7000, 99999).length };
    });
    expect(sums).toEqual({ length: 3200, first: 1, atBoundary: 2, last: 3, empty: 0, past: 1000 });
  });

  test('the audio kept is capped, not unbounded', async ({ page }) => {
    await openFollowing(page, '?batch=1');
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
    await page.locator('#liveRefInput').fill('Chullin 91a');
    await page.locator('#liveShowDafButton').click();
    await expect(page.locator('#liveDafHeading')).toHaveText('Chullin 91a – Chullin 91b');
    await page.evaluate(() => startLiveFollow());
  }

  test('by default the browser\'s own voice processing is left as the browser chooses', async ({ page }) => {
    await startWithMic(page, '');
    const c = await page.evaluate(() => window.__constraints);
    expect(c).toEqual({ audio: { channelCount: 1 } });
  });

  test('?raw=1 turns off echo cancellation, noise suppression and automatic gain', async ({ page }) => {
    await startWithMic(page, '?raw=1');
    const c = await page.evaluate(() => window.__constraints);
    expect(c.audio).toMatchObject({ channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false });
    const start = await page.evaluate(() => live.log.find((e) => e.kind === 'start'));
    expect(start.options.raw).toBe(true);
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
