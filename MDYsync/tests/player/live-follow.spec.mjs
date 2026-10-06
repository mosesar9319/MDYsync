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
async function openFollowing(page) {
  await preparePage(page, { user: null });
  await serveRealDaf(page);
  await page.goto('/live/');
  await page.evaluate(async () => {
    await loadDaf(parseDafInput('Chullin 91a'));
    live.tracker = LiveMatcher.createTracker(live.daf.canon, { eagerRelocalize: true });
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

  test('locks on after two agreeing phrases, then follows the reading', async ({ page }) => {
    await openFollowing(page);
    await say(page, `so the Gemara says ${phrase(400, 6)}`);
    await expect(page.locator('#liveStatusText')).toHaveText('Searching…');
    expect(await confirmed(page)).toBeNull();
    await expect(page.locator('#liveDebugPending')).toContainText('[400–405]');

    await say(page, phrase(406, 6));
    await expect(page.locator('#liveStatusText')).toHaveText('Following');
    expect(await confirmed(page)).toEqual({ s: 406, e: 411 });
    await expect(page.locator('#liveDafText .w.hl')).toHaveCount(6);
    await expect(page.locator('#livePhraseText')).not.toHaveClass(/empty/);

    await say(page, phrase(412, 6));
    expect(await confirmed(page)).toEqual({ s: 412, e: 417 });
    await expect(page.locator('#liveDafText .w.hl')).toHaveCount(6);
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

  test('a jump back moves the highlight only once a second phrase confirms it', async ({ page }) => {
    await openFollowing(page);
    await say(page, phrase(400, 6));
    await say(page, phrase(406, 6));
    await say(page, phrase(412, 6));

    await say(page, `let's go back, ${phrase(100, 6)}`);
    expect(await confirmed(page)).toEqual({ s: 412, e: 417 });
    await expect(page.locator('#liveDebugPending')).toContainText('[100–105]');

    await say(page, phrase(106, 6));
    expect(await confirmed(page)).toEqual({ s: 106, e: 111 });
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
