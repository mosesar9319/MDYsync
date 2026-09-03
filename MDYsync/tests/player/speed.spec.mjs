import { test, expect } from '@playwright/test';
import { preparePage, failOnPageError } from '../support/harness.mjs';

// The video/daf player's own playback-speed control -- reader-facing on
// every page that embeds it (player/, watch/, browse/, studio/), and covered
// nowhere else in this suite: everything else here is Notes/Cloud Chabura.
//
// HTMLMediaElement.load() resets playbackRate to 1 -- confirmed directly
// against a real <video> element, not documented behaviour anyone would
// guess at a glance. app.js's YouTube video-switch path already re-applies
// the speed selector's chosen rate right after cueVideoById; the direct-link
// and local-file paths did not, so a reader who had picked e.g. 1.5x had it
// silently reset to 1x on every new video or daf switch, with the selector's
// own displayed value never changing to say so. And going back to "1x" from
// a selector that already SHOWS "1x" (its default, unchanged since page
// load) is a genuine no-op regardless: a native <select> fires no 'change'
// event at all when the option picked is the one already selected -- there
// is no event to listen for that would catch this. Reported directly as
// "the 1x button in the video player does not work."
//
// setPlaybackRate/loadDirectVideoUrl/handleVideoFile are plain top-level
// function declarations in app.js, a classic (non-module) script -- calling
// them via window.* here reaches the exact same functions the UI's own
// buttons call, without needing to sign in as admin to reach the (desktop-
// only, admin-gated) direct-link/local-file controls in the DOM.

test.describe('Video player -- playback speed survives a new video load', () => {
  test('a direct video link resyncs the chosen speed instead of leaving load()\'s silent reset in place', async ({ page }) => {
    const errors = [];
    failOnPageError(page, errors);
    await preparePage(page, { user: null });
    await page.goto('/browse/?ref=Chullin%2089a');
    await expect(page.locator('#speedSelect')).toBeAttached();

    await page.selectOption('#speedSelect', '1.5');
    await expect
      .poll(() => page.evaluate(() => document.getElementById('video').playbackRate))
      .toBe(1.5);

    // loadDirectVideoUrl calls htmlVideo.load(), which alone resets
    // playbackRate to 1 -- this needs no network fetch to actually succeed
    // to prove the point; it is a synchronous side effect of load() itself,
    // before anything arrives over the wire.
    await page.evaluate(() => window.loadDirectVideoUrl('https://example.invalid/a-shiur.mp4'));

    expect(await page.evaluate(() => document.getElementById('video').playbackRate)).toBe(1.5);
    // The selector must still read what it actually reflects -- a rate that
    // is right but a label that now disagrees would be its own bug.
    expect(await page.locator('#speedSelect').inputValue()).toBe('1.5');
    expect(errors).toEqual([]);
  });

  test('choosing a local video file resyncs the chosen speed the same way', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/browse/?ref=Chullin%2089a');
    await expect(page.locator('#speedSelect')).toBeAttached();

    await page.selectOption('#speedSelect', '0.75');
    await expect
      .poll(() => page.evaluate(() => document.getElementById('video').playbackRate))
      .toBe(0.75);

    await page.evaluate(() => {
      const file = new File(['not really a video, just proving load() fires'], 'shiur.mp4', { type: 'video/mp4' });
      window.handleVideoFile(file);
    });

    expect(await page.evaluate(() => document.getElementById('video').playbackRate)).toBe(0.75);
  });

  test('sanity: load() really does reset playbackRate on its own, so the fix above is not a no-op assertion', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/browse/?ref=Chullin%2089a');
    const result = await page.evaluate(() => {
      const v = document.getElementById('video');
      v.playbackRate = 1.5;
      const before = v.playbackRate;
      v.load();
      return { before, after: v.playbackRate };
    });
    expect(result).toEqual({ before: 1.5, after: 1 });
  });
});
