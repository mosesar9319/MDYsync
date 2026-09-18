import { test, expect } from '@playwright/test';
import { preparePage, failOnPageError } from '../support/harness.mjs';

// The ?debugtouch=1 on-screen log (app.js) exists solely to chase real-
// device-only Split View touch bugs this repo's own tests can't reproduce
// (see its own comment block in app.js). It has caused two real problems
// of its own along the way, both fixed here and worth locking in:
//
// 1. index.html's sitewide "Something on this page failed to load" banner
//    (inline <script>, position:fixed, top:0, z-index 99999) shows on ANY
//    uncaught error or unhandled rejection and stays until dismissed --
//    confirmed directly to intercept clicks on anything underneath it,
//    not just its own strip. Since ?debugtouch=1 is specifically trying
//    to surface exactly the errors this banner reacts to, it would show
//    every single time something worth debugging actually happened,
//    silently blocking the very interaction being diagnosed. Reported as
//    "a debugging box obscuring the video" and "controls freeze, can't
//    even pause" -- both explained by this banner, not a real freeze.
test.describe('the ?debugtouch=1 diagnostic', () => {
  test('auto-dismisses the sitewide error banner instead of leaving it to block clicks', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    // This ref triggers "No segments found" on load against this suite's
    // fixture stub -- a real unhandled rejection, deliberately left
    // untouched rather than special-cased, so this is a faithful
    // reproduction of the banner appearing during ordinary use.
    await page.goto('/player/?debugtouch=1&ref=Chullin%2089a');
    await page.waitForTimeout(500);

    await expect(page.locator('[aria-label="Dismiss"]')).toHaveCount(0);

    // The prominent mode selector sits in the exact strip the banner used
    // to cover -- a real, un-forced click here is the actual regression
    // this covers (Playwright's own actionability check fails first if
    // anything still intercepts the point).
    await page.click('#viewerModeSplitButton', { timeout: 2000 });
    await expect.poll(() => page.evaluate(() => state.viewerMode)).toBe('split');
  });

  test('still logs the error into the on-screen panel after dismissing it', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/player/?debugtouch=1&ref=Chullin%2089a');
    await page.waitForTimeout(500);

    const rows = await page.evaluate(() => {
      const panel = Array.from(document.querySelectorAll('div')).find((d) => d.style.zIndex === '2147483647');
      const logBox = panel?.firstElementChild;
      return logBox ? Array.from(logBox.children).map((r) => r.textContent) : [];
    });
    expect(rows.some((r) => r.includes('UNHANDLED REJECTION'))).toBe(true);
  });
});
