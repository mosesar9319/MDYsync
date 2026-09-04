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

// The speed control's own hit area. Every other test in this file drives the
// <select> programmatically (selectOption / setting .value), which is exactly
// why they all passed while the control was, in practice, unpressable:
// reported directly as "still nothing happens when I press the 1x button."
//
// The pill a reader sees (.pc-speed -- border, background, the value, and a
// chevron) was 60x30 on desktop and 51x22 on a phone, but the <select> inside
// it was only 47x16 / 40x14, floating in the middle. Everything else --
// the padding, the border, and above all the chevron, which is the one part
// of a dropdown people actually aim at -- was inert .pc-speed div with no
// handler on it, so a press there did nothing at all.
test.describe('Video player -- the speed control is pressable across its whole pill', () => {
  for (const viewport of [{ name: 'desktop', width: 1440, height: 900 }, { name: 'phone', width: 412, height: 915 }]) {
    test(`the whole pill reaches the select, chevron included (${viewport.name})`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await preparePage(page, { user: null });
      await page.goto('/watch/?ref=Chullin%2089a');
      await expect(page.locator('#speedSelect')).toBeAttached();

      const result = await page.evaluate(() => {
        const sel = document.getElementById('speedSelect');
        const pill = sel.parentElement; // .pc-speed
        const p = pill.getBoundingClientRect();
        const s = sel.getBoundingClientRect();
        // Sampled a couple of px inside the pill's edges, so the 1px border
        // and the 8px corner radius are not what is being measured.
        const points = {
          center: [p.left + p.width / 2, p.top + p.height / 2],
          chevron: [p.right - 4, p.top + p.height / 2],
          nearTop: [p.left + p.width / 2, p.top + 2],
          nearBottom: [p.left + p.width / 2, p.bottom - 3],
          leftOfValue: [p.left + 4, p.top + p.height / 2],
        };
        const misses = [];
        for (const [name, [x, y]] of Object.entries(points)) {
          if (document.elementFromPoint(x, y) !== sel) misses.push(name);
        }
        return {
          misses,
          coverage: (s.width * s.height) / (p.width * p.height),
          selectHeight: s.height,
          pillHeight: p.height,
        };
      });

      // Every one of those points must land on the select itself.
      expect(result.misses).toEqual([]);
      // And the select must actually fill the pill rather than float inside
      // it -- the border and rounded corners are the only part that is not
      // the control.
      expect(result.coverage).toBeGreaterThan(0.8);
      // The select stretches to the pill's height (align-items: stretch),
      // rather than being a short line-height-sized box centred in it.
      expect(result.selectHeight).toBeGreaterThanOrEqual(result.pillHeight - 3);
    });
  }
});
