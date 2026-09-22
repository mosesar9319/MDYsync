import { test, expect } from '@playwright/test';
import { preparePage, failOnPageError } from '../support/harness.mjs';

// player-chrome.js's fitChrome() re-runs on essentially every interaction
// (it's both a MutationObserver callback watching .player-controls, and a
// ResizeObserver callback watching .video-frame -- see its own comments).
// It used to unconditionally tools.append(...TOOLS_ORDER) every single
// control on every run, even when every control already sat exactly where
// it belonged and nothing had overflowed. That's a real "remove, then
// re-insert" of every node in the bar -- including whichever one the reader
// might be actively touching, since this callback can fire mid-gesture (a
// tap reveals the bar again via showVideoControls, which is exactly the
// kind of class change the ResizeObserver reacts to).
//
// A real-device diagnostic (?debugtouch=1 in app.js) confirmed the actual
// failure this caused: a tap on the speed control logged a clean
// touchstart -> touchend, but the browser's own synthesized click never
// followed, and the whole page then stopped responding to ANY input,
// including a heartbeat timer with no relation to this code at all -- a
// real mobile browser's touch/pointer-capture bookkeeping getting
// confused by its live touch target being reparented out from under it.
// No headless/synthetic-touch environment reproduces the freeze itself,
// but the DOM churn that triggers it is directly observable: this asserts
// fitChrome's reorder step now leaves an already-correct bar completely
// untouched.
test.describe('player-chrome.js — fitChrome() does not reparent controls needlessly', () => {
  test('re-running fitChrome with nothing out of place does not touch the DOM', async ({ page }) => {
    failOnPageError(page);
    // A no-op tools.append(...TOOLS_ORDER) (every node already exactly
    // where it belongs) doesn't necessarily produce an observable
    // MutationRecord -- browsers can skip firing one when a node is
    // appended back to the position it already occupies. What's NOT
    // skipped, because it's a JS-level call regardless of its DOM effect,
    // is Element.prototype.append itself -- so this counts calls, not
    // their (possibly optimized-away) mutation records.
    await page.addInitScript(() => {
      window.__appendCalls = 0;
      const original = Element.prototype.append;
      Element.prototype.append = function (...args) {
        if (this.classList?.contains('pc-tools')) window.__appendCalls += 1;
        return original.apply(this, args);
      };
    });
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    await expect(page.locator('#speedSelect')).toBeAttached();
    await page.waitForTimeout(200);
    const callsBefore = await page.evaluate(() => window.__appendCalls);

    // Re-trigger fitChrome the same way a real control-bar change does --
    // controlsObserver (a MutationObserver on .player-controls) reacts to
    // exactly this class churn on any descendant. Nothing about the bar's
    // own contents or width has actually changed, so fitChrome (however
    // it gets triggered) has nothing left to reorder.
    await page.evaluate(() => {
      document.getElementById('speedSelect').classList.add('zzz-test-probe');
      document.getElementById('speedSelect').classList.remove('zzz-test-probe');
    });
    // Give the MutationObserver microtask a chance to run.
    await page.waitForTimeout(300);

    const callsAfter = await page.evaluate(() => window.__appendCalls);
    expect(callsAfter).toBe(callsBefore);
  });

  test('fitChrome still recovers a control that was actually stranded in the overflow menu', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    await expect(page.locator('#speedSelect')).toBeAttached();

    // Force is-tiny by shrinking the viewport, which should strand at least
    // one control in the "More" overflow menu.
    await page.setViewportSize({ width: 340, height: 800 });
    await page.waitForTimeout(300);
    const strandedBefore = await page.evaluate(() => document.getElementById('toolsMoreMenu')?.children.length ?? 0);
    expect(strandedBefore).toBeGreaterThan(0);

    // Widen back out -- the stranded control should come back to .pc-tools,
    // proving the skip-when-already-in-place fix didn't also break recovery.
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.waitForTimeout(300);
    const strandedAfter = await page.evaluate(() => document.getElementById('toolsMoreMenu')?.children.length ?? 0);
    expect(strandedAfter).toBe(0);
  });

  // The timer (#currentTime/#duration, .pc-time) is the one thing in
  // .player-controls that legitimately changes on its own, continuously,
  // for as long as a video plays (updateTimeline polls every 100ms -- see
  // app.js). Confirmed directly against a real device (?debugtouch=1) to
  // retrigger a full fitChrome measure-and-reorder pass on very nearly
  // every one of those ticks -- not a logging artifact, but genuine,
  // repeated DOM work with nothing behind it but a clock ticking, fast
  // enough to scroll any other diagnostic output out of view before it
  // could be read. A real resize (the next test) must still go through.
  test('the playback timer ticking does not retrigger fitChrome at all', async ({ page }) => {
    failOnPageError(page);
    await page.addInitScript(() => {
      window.__appendCalls = 0;
      const original = Element.prototype.append;
      Element.prototype.append = function (...args) {
        if (this.classList?.contains('pc-tools')) window.__appendCalls += 1;
        return original.apply(this, args);
      };
    });
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    await expect(page.locator('#speedSelect')).toBeAttached();
    await page.waitForTimeout(200);
    const callsBefore = await page.evaluate(() => window.__appendCalls);

    for (let i = 0; i < 8; i++) {
      await page.evaluate((i) => {
        document.getElementById('currentTime').textContent = `0:0${i}`;
        document.getElementById('duration').textContent = '5:00';
      }, i);
      await page.waitForTimeout(60);
    }

    const callsAfter = await page.evaluate(() => window.__appendCalls);
    expect(callsAfter).toBe(callsBefore);
  });

  // The already-fixed "skip when nothing needs to move" logic wasn't
  // enough on its own: a real device report showed fitChrome() genuinely
  // reordering -- an ACTUAL move, not the no-op case above -- three times
  // over the course of ONE touch gesture, because something (this bar's
  // own class churn from other event handlers, not the already-filtered
  // timer text) can shift its available width by a pixel or two on a real
  // page with real content, tipping is-tiny's fit/no-fit boundary each way
  // in turn. A reorder that's genuinely needed is just as dangerous mid-
  // touch as a needless one -- both reparent a node the reader's finger
  // may still be on. fitChrome now defers ANY reorder while a pointer is
  // down anywhere on the page, and catches up the moment it's released.
  test('a genuinely-needed reorder is deferred while a pointer is down, and catches up on release', async ({ page }) => {
    failOnPageError(page);
    await page.addInitScript(() => {
      window.__appendCalls = 0;
      const original = Element.prototype.append;
      Element.prototype.append = function (...args) {
        if (this.classList?.contains('pc-tools')) window.__appendCalls += 1;
        return original.apply(this, args);
      };
    });
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    await page.setViewportSize({ width: 340, height: 800 });
    await page.waitForTimeout(300);

    const speedBox = await page.locator('#speedSelect').boundingBox();
    await page.mouse.move(speedBox.x + speedBox.width / 2, speedBox.y + speedBox.height / 2);
    await page.mouse.down();
    const callsWhileDown = await page.evaluate(() => window.__appendCalls);

    // A real width change while the pointer is still down -- exactly the
    // circumstance that triggered a genuine mid-gesture reorder on device.
    await page.setViewportSize({ width: 320, height: 800 });
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__appendCalls)).toBe(callsWhileDown);

    await page.mouse.up();
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__appendCalls)).toBeGreaterThan(callsWhileDown);
  });

  // pointerup is not the end of a gesture: real-device evidence caught a
  // reorder landing in the narrow window AFTER pointerup but BEFORE
  // touchend, exactly where the fix above looked safe to run its own
  // catch-up pass. touchend, and whatever click the browser synthesizes
  // from it, still have to be dispatched after pointerup fires, and
  // reparenting the pressed control in that gap is just as capable of
  // corrupting them as reparenting it mid-touch. The deferral now holds
  // for a short grace period past release, not just until pointerup.
  test('a reorder stays deferred through a grace period after release, then catches up', async ({ page }) => {
    failOnPageError(page);
    await page.addInitScript(() => {
      window.__appendCalls = 0;
      const original = Element.prototype.append;
      Element.prototype.append = function (...args) {
        if (this.classList?.contains('pc-tools')) window.__appendCalls += 1;
        return original.apply(this, args);
      };
    });
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    await page.setViewportSize({ width: 340, height: 800 });
    await page.waitForTimeout(300);

    const speedBox = await page.locator('#speedSelect').boundingBox();
    await page.mouse.move(speedBox.x + speedBox.width / 2, speedBox.y + speedBox.height / 2);
    await page.mouse.down();
    await page.setViewportSize({ width: 320, height: 800 });
    await page.waitForTimeout(100);
    await page.mouse.up();

    const callsRightAfterRelease = await page.evaluate(() => window.__appendCalls);
    await page.waitForTimeout(30);
    expect(await page.evaluate(() => window.__appendCalls)).toBe(callsRightAfterRelease);

    await page.waitForTimeout(200);
    expect(await page.evaluate(() => window.__appendCalls)).toBeGreaterThan(callsRightAfterRelease);
  });
});
