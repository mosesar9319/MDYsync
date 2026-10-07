import { test, expect } from '@playwright/test';
import { preparePage, failOnPageError } from '../support/harness.mjs';

// #largePlay, the big circular play/pause button centered over the video
// picture (distinct from #playButton, the small one in the control bar).
//
// Reported directly: it only ever worked once, right as a video first began
// playing -- after that it never came back, and on the rare occasion it did
// reappear (loading a fresh video resets it unconditionally), clicking it
// didn't pause anything either. Root cause was updatePlayUi's own
// `getCurrentTime() > 0.15` clause: once playback had moved even a fraction
// of a second past the very start, this button stayed hidden FOREVER
// regardless of paused state, so pausing later never brought it back -- and
// the one time it legitimately reappeared (a fresh video, paused at time 0)
// it could only ever mean "play", since the video was already paused with
// nothing left to pause. Dropped that clause: visibility now tracks `paused`
// alone, the same way the small button's own icon swap right beside it in
// updatePlayUi already does, via the same 100ms poll that runs throughout
// YouTube playback.
//
// state.videoSource has to be set directly -- this suite's stub harness
// never resolves a real video for a daf, so #largePlay's own `!state.
// videoSource` guard would otherwise keep it hidden regardless of anything
// else being tested here.
async function primeVideoSource(page) {
  await page.evaluate(() => {
    state.videoSource = { type: 'direct', url: 'https://example.invalid/a-shiur.mp4' };
    updatePlayUi();
  });
}

test.describe('The big center play/pause button keeps working past the very first moment', () => {
  test('it reappears after pausing mid-video, not just at time 0', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/browse/?ref=Chullin%2089a');
    await primeVideoSource(page);
    await expect(page.locator('#largePlay')).toBeVisible();

    await page.locator('#largePlay').click();
    await expect.poll(() => page.evaluate(() => document.getElementById('video').paused)).toBe(false);
    await expect(page.locator('#largePlay')).toBeHidden();

    // Well past the old 0.15s cutoff -- the exact case that used to leave
    // this button hidden forever, even once paused again.
    await page.evaluate(() => { document.getElementById('video').currentTime = 5; updatePlayUi(); });
    await page.locator('#playButton').click();
    await expect.poll(() => page.evaluate(() => document.getElementById('video').paused)).toBe(true);

    await expect(page.locator('#largePlay')).toBeVisible();
  });

  test('clicking it once visible again actually resumes playback', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/browse/?ref=Chullin%2089a');
    await primeVideoSource(page);

    await page.locator('#largePlay').click();
    await page.evaluate(() => { document.getElementById('video').currentTime = 5; updatePlayUi(); });
    await page.locator('#playButton').click(); // paused again, well past time 0
    await expect(page.locator('#largePlay')).toBeVisible();

    await page.locator('#largePlay').click();
    await expect.poll(() => page.evaluate(() => document.getElementById('video').paused)).toBe(false);
    await expect(page.locator('#largePlay')).toBeHidden();
  });

  test('it stays hidden while actually playing, never just a stale leftover', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/browse/?ref=Chullin%2089a');
    await primeVideoSource(page);

    await page.locator('#largePlay').click();
    await page.evaluate(() => { document.getElementById('video').currentTime = 5; });
    // No pause anywhere -- still playing well past the old cutoff.
    await page.waitForTimeout(150);
    await expect(page.locator('#largePlay')).toBeHidden();
  });
});
