import { test, expect } from '@playwright/test';
import { preparePage } from '../support/harness.mjs';

// Reported directly: "the 'select text' button and the full screen toggle on
// the written daf are overlapping ... on the regular video player screen and
// in interactive daf" -- i.e. /player/ and /browse/, both of which give the
// Vilna toolbar (#vilnaZoomControls) a compact pill layout via a page-scoped
// <style> block that loads after styles.css and wins on specificity.
//
// That block redraws every .vilna-zoom-btn-classed control as a uniform
// 30x30 icon square (see .daf-card[data-daf-view="page"] .vilna-zoom-btn,
// .vilna-fullscreen-button in each page's own <style>). #vilnaSelectTextModeButton
// carries .vilna-zoom-btn too (shared hover/border styling) even though it
// holds a text label, not an icon -- so it got squeezed to 30x30 as well.
// With no overflow:hidden, "Select text" simply painted past its own box
// edge and ran into the fullscreen button beside it, which these same pages
// also pull in from styles.css's margin-left:auto down to margin-left:2px
// (appropriate for a pill-shaped toolbar, but only once its neighbor isn't
// overflowing). /watch/ has no such page-scoped override, so it never showed
// the bug -- included below as the control case.
//
// Each page carries its own carve-out already, for .vilna-mark-toggle
// (admin-only, so never on screen for the ordinary reader this bug hit) --
// #vilnaSelectTextModeButton now gets the identical width:auto carve-out.

const PAGES_WITH_OVERRIDE = ['/player/', '/browse/'];
const ALL_PAGES = ['/watch/', '/player/', '/browse/'];

// Playwright's boundingBox() returns {x, y, width, height}, not
// {left, right, top, bottom} -- normalize before comparing edges.
function overlaps(a, b) {
  const aLeft = a.x, aRight = a.x + a.width, aTop = a.y, aBottom = a.y + a.height;
  const bLeft = b.x, bRight = b.x + b.width, bTop = b.y, bBottom = b.y + b.height;
  return !(aRight <= bLeft || bRight <= aLeft || aBottom <= bTop || bBottom <= aTop);
}

for (const path of ALL_PAGES) {
  test(`Select text and fullscreen buttons never overlap on ${path}`, async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto(`${path}?ref=Chullin%2089a`);
    await page.waitForTimeout(300);
    await page.evaluate(() => switchDafView('page'));
    await page.waitForTimeout(200);

    const selectBox = await page.locator('#vilnaSelectTextModeButton').boundingBox();
    const fullscreenBox = await page.locator('#vilnaFullscreenButton').boundingBox();

    expect(selectBox).not.toBeNull();
    expect(fullscreenBox).not.toBeNull();
    expect(overlaps(selectBox, fullscreenBox)).toBe(false);

    // Not just "not overlapping" -- there must be daylight between them, or
    // a 1px rounding difference would pass this test while still reading as
    // touching/crowded to a real user.
    const gap = fullscreenBox.x >= selectBox.x
      ? fullscreenBox.x - (selectBox.x + selectBox.width)
      : selectBox.x - (fullscreenBox.x + fullscreenBox.width);
    expect(gap).toBeGreaterThan(1);
  });
}

for (const path of PAGES_WITH_OVERRIDE) {
  test(`Select text keeps its full text label (not squeezed to an icon square) on ${path}`, async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto(`${path}?ref=Chullin%2089a`);
    await page.waitForTimeout(300);
    await page.evaluate(() => switchDafView('page'));
    await page.waitForTimeout(200);

    const button = page.locator('#vilnaSelectTextModeButton');
    const box = await button.boundingBox();
    // The page-scoped icon-square rule forces width to exactly 30px; a
    // properly auto-sized text pill holding "Select text" is well past
    // that -- this is the same regression the overlap was a symptom of.
    expect(box.width).toBeGreaterThan(40);
    await expect(button).toHaveText('Select text');
  });
}

// Reported directly, after the fix above widened "Select text" into a real
// text pill: on a narrow/zoomed screen there's no longer room for every
// button on one row, and the LAST one (Fullscreen) wrapped onto a new line
// by itself -- growing the whole sticky toolbar's height ("thicker than it
// should be"). #vilnaZoomControls used flex-wrap for a real reason (a
// different report: Fullscreen sitting on top of Discard changes in mark
// mode when nowrap's default just let them overlap) -- so the fix is
// scrolling the overflow horizontally instead of either wrapping or
// overlapping. ALL_PAGES here since this is the shared styles.css rule
// everything (including /watch/ and /studio/, not just the two pages with
// their own page-scoped override) inherits from.
for (const path of ALL_PAGES) {
  test(`the toolbar stays one row and scrolls instead of wrapping when it doesn't fit on ${path}`, async ({ page }) => {
    await preparePage(page, { user: null });
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto(`${path}?ref=Chullin%2089a`);
    await page.waitForTimeout(300);
    await page.evaluate(() => switchDafView('page'));
    await page.waitForTimeout(200);

    const controls = page.locator('#vilnaZoomControls');
    const flexWrap = await controls.evaluate((el) => getComputedStyle(el).flexWrap);
    const overflowX = await controls.evaluate((el) => getComputedStyle(el).overflowX);
    expect(flexWrap).toBe('nowrap');
    expect(overflowX).toBe('auto');

    // The first and last buttons in the row -- if either had wrapped onto
    // its own line, their vertical centers would land a button's height
    // apart instead of together.
    const firstBox = await page.locator('#vilnaZoomOutButton').boundingBox();
    const lastBox = await page.locator('#vilnaFullscreenButton').boundingBox();
    expect(firstBox).not.toBeNull();
    expect(lastBox).not.toBeNull();
    const firstCenterY = firstBox.y + firstBox.height / 2;
    const lastCenterY = lastBox.y + lastBox.height / 2;
    expect(Math.abs(firstCenterY - lastCenterY)).toBeLessThan(4);
  });
}
