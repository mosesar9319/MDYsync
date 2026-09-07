import { test, expect } from '@playwright/test';
import { preparePage } from '../support/harness.mjs';

// Tapping a word on the Vilna page seeks the video AND is supposed to move
// the "currently playing" highlight to the tapped phrase -- reported
// directly as the video jumping to the right place while the highlight
// stayed stuck on whatever was playing before the tap.
//
// Root cause: seek() (app.js) already forces an active-segment update using
// the exact target time it was just given -- correct and race-free.
// seekToVilnaWord (the function every tap on a Vilna word, a scanned photo,
// or the Daf browser's inline player funnels through) used to follow that
// with a SECOND, redundant updateActiveSegment(true) call with no time
// override, which falls back to reading getCurrentTime() instead.
//
// For a YouTube-sourced shiur, player.seekTo() is asynchronous: calling
// getCurrentTime() immediately afterward still reports the OLD position,
// often for a couple hundred milliseconds. That second call therefore
// clobbered the correct, just-set activeIndex with the stale one a moment
// later -- reliably, on every single tap, since it always ran synchronously
// right after the correct one. An HTML5 <video>'s currentTime setter is
// synchronous enough that this never showed up there, which is exactly why
// it reached production: every daf in this project with a real recording is
// a YouTube shiur.
//
// The fix removed the redundant call outright. These tests simulate the
// same asynchronous seekTo() a real YouTube player has, so they exercise
// the actual race rather than the HTML5 path that happened to hide it.

// state.vilnaOverlayKey's own format is `${ref}:${w0}:${w1}`, plus a
// trailing `:${selectionSignature}` (see updateVilnaOverlay) that's this
// test's own concern to ignore -- these tests are about which SEGMENT the
// highlight follows, not about Select-text's own dedup guard against a
// concurrent selection, which is never active here. Checking the prefix
// rather than the exact string keeps this from being coupled to a detail
// this file has nothing to do with.
function overlayKeyPrefix(ref, w0, w1) {
  return `${ref}:${w0}:${w1}`;
}

function pageMapFixture() {
  const boxes = [];
  const row = (ref, y, count) => {
    for (let i = 0; i < count; i += 1) boxes.push({ ref, wordIndex: i, x: 0.8 - i * 0.15, y, w: 0.1, h: 0.02 });
  };
  row('Chullin 89a.1', 0.10, 5); // segment 0's words, indices 0-4
  row('Chullin 89a.2', 0.30, 4); // segment 1's words, indices 0-3
  return { wordBoxes: boxes };
}

async function seedAsyncYoutubeScenario(page) {
  await page.evaluate((map) => {
    state.vilnaPageMap = map;

    // A stand-in for the real YouTube IFrame API: seekTo() only takes
    // effect after a delay, the same as the real one does. getCurrentTime()
    // called synchronously right after seekTo() still reports the position
    // from BEFORE the seek -- the exact gap the bug fell into.
    state.playerType = 'youtube';
    state.youtubeReady = true;
    window.__simTime = 5;
    state.youtubePlayer = {
      seekTo: (t) => { setTimeout(() => { window.__simTime = t; }, 300); },
      getCurrentTime: () => window.__simTime,
      getDuration: () => 1000,
    };

    state.segments = [
      { ref: 'Chullin 89a.1', w0: 0, w1: 4, start: 0, end: 10, he: 'seg1', en: 'seg1' },
      { ref: 'Chullin 89a.2', w0: 0, w1: 3, start: 100, end: 110, he: 'seg2', en: 'seg2' },
    ];
    state.wordTimeline = [
      { ref: 'Chullin 89a.1', w0: 0, w1: 4, start: 0 },
      { ref: 'Chullin 89a.2', w0: 0, w1: 3, start: 100 },
    ];
    state.activeIndex = 0;

    switchDafView('page');
    renderVilnaWordBoxes();
    updateVilnaOverlay();
  }, pageMapFixture());
}

test.describe('Vilna page -- tapping a word moves the "now playing" highlight', () => {
  test('clicking a word in a later segment moves the highlight there, not just the video', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/watch/?ref=Chullin%2089a');
    await seedAsyncYoutubeScenario(page);

    expect(await page.evaluate(() => state.vilnaOverlayKey)).toContain(overlayKeyPrefix('Chullin 89a.1', 0, 4));

    // Two phrase boxes exist, in segment order (renderVilnaWordBoxes builds
    // them from spans.values(), first-seen order) -- the second is segment 1
    // (Chullin 89a.2). dispatchEvent rather than .click(): the fixture has
    // no real page image, so the overlay renders at 0x0 and a real pointer
    // click can never land on it -- see scan-highlight.spec.mjs for the
    // same workaround on the same kind of fixture.
    await expect(page.locator('.vilna-phrase-box')).toHaveCount(2);
    await page.locator('.vilna-phrase-box').nth(1).dispatchEvent('click');

    // The video's seek target is right immediately -- this was never in
    // doubt; the bug was specifically that the HIGHLIGHT didn't follow it.
    expect(await page.evaluate(() => state.activeIndex)).toBe(1);
    expect(await page.evaluate(() => state.vilnaOverlayKey)).toContain(overlayKeyPrefix('Chullin 89a.2', 0, 3));
    await expect(page.locator('#vilnaActiveOverlay .vilna-active-rect')).toHaveCount(1);

    // And it STAYS moved once the simulated async seek actually lands --
    // the bug's other half was that nothing corrected it afterward either,
    // short of the next real playback tick.
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => state.activeIndex)).toBe(1);
    expect(await page.evaluate(() => state.vilnaOverlayKey)).toContain(overlayKeyPrefix('Chullin 89a.2', 0, 3));
  });

  test('the same fix applies to jumping backward to an earlier segment', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/watch/?ref=Chullin%2089a');
    await seedAsyncYoutubeScenario(page);

    // Start on the LATER segment, ACTUALLY playing there (simTime inside
    // its 100-110 range, not just activeIndex set by hand) -- otherwise the
    // redundant getCurrentTime() read the old code made would happen to
    // land back in segment 0 anyway (simTime was still 5, segment 0's own
    // range), passing regardless of whether the fix is present. findSegmentAt's
    // own "never move the highlight backward" guard is for ordinary
    // playback ticks (force=false) only; a deliberate tap always passes
    // force=true and must be able to move either direction.
    await page.evaluate(() => { window.__simTime = 105; state.activeIndex = 1; updateVilnaOverlay(); });
    expect(await page.evaluate(() => state.vilnaOverlayKey)).toContain(overlayKeyPrefix('Chullin 89a.2', 0, 3));

    await page.locator('.vilna-phrase-box').first().dispatchEvent('click');

    expect(await page.evaluate(() => state.activeIndex)).toBe(0);
    expect(await page.evaluate(() => state.vilnaOverlayKey)).toContain(overlayKeyPrefix('Chullin 89a.1', 0, 4));
  });

  test('the scanned-photo tap-to-jump path shares the same fix', async ({ page }) => {
    // tapScannedWord (player/) funnels through seekToVilnaWord exactly like
    // the Vilna page's own click handler -- covering it here directly
    // rather than duplicating the whole DafScan render pipeline, since the
    // fix lives in the one function both paths share.
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    await page.evaluate(() => {
      state.dafRef = 'Chullin 89a';
      state.scanSelectedRef = 'Chullin 89a';
      state.playerType = 'youtube';
      state.youtubeReady = true;
      window.__simTime = 5;
      state.youtubePlayer = {
        seekTo: (t) => { setTimeout(() => { window.__simTime = t; }, 300); },
        getCurrentTime: () => window.__simTime,
        getDuration: () => 1000,
      };
      state.segments = [
        { ref: 'Chullin 89a.1', w0: 0, w1: 4, start: 0, end: 10, he: 'seg1', en: 'seg1' },
        { ref: 'Chullin 89a.2', w0: 0, w1: 3, start: 100, end: 110, he: 'seg2', en: 'seg2' },
      ];
      state.wordTimeline = [
        { ref: 'Chullin 89a.1', w0: 0, w1: 4, start: 0 },
        { ref: 'Chullin 89a.2', w0: 0, w1: 3, start: 100 },
      ];
      state.activeIndex = 0;
    });

    await page.evaluate(() => tapScannedWord('Chullin 89a.2', 2));

    expect(await page.evaluate(() => state.activeIndex)).toBe(1);
  });
});
