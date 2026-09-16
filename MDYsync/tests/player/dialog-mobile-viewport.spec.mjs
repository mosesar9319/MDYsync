import { test, expect } from '@playwright/test';
import { preparePage, failOnPageError } from '../support/harness.mjs';
import { sessionFor, USERS } from '../fixtures/dataset.mjs';

// Every modal <dialog> on the daf pages (browse/player/watch) was clipped at
// phone widths, site-wide and pre-existing. Root cause: .reading-mode-tip
// (browse/player only) is white-space: nowrap with a max-width cap but no
// overflow:hidden, so its long sentence rendered past that cap at its full
// intrinsic width -- invisible at rest (opacity: 0), but real ink overflow
// all the same. Chromium's mobile layout-viewport sizing counted it, so
// window.innerWidth read wider than window.visualViewport.width for the
// whole page load, not just while the tip itself was ever shown. A modal
// dialog centers against that inflated layout viewport (position: fixed;
// inset: 0; margin: auto is relative to the ICB, not the visual viewport),
// so it rendered off-centre relative to what a reader can actually see --
// on /browse/ specifically, ~41px of its left edge sat outside the visible
// screen. Fixed by adding overflow: hidden (+ text-overflow: ellipsis) to
// .reading-mode-tip in both pages' own local <style> blocks.
//
// A second, seemingly separate symptom traced back to the exact same root
// cause: Playwright's own hit test refused every .dialog-close click at
// mobile widths (".eyebrow intercepts pointer events"), because the click
// coordinate Playwright computes from getBoundingClientRect() was itself
// thrown off by the same viewport mismatch. tests/notes/note-citation.spec.mjs
// used to press Escape instead of clicking the x for exactly this reason --
// that workaround is gone now that a real click works again.
//
// #noteDialog is deliberately excluded: it's a non-modal right-side panel
// opened with .show(), not a centered modal, and was never affected by this
// (see its own comment in styles.css).

const PAGES = ['/browse/', '/player/', '/watch/'];

test.describe('Modal dialogs are not clipped at phone widths', () => {
  for (const path of PAGES) {
    test(`${path}: the layout viewport matches the visual viewport (no ink overflow inflating it)`, async ({ page }) => {
      failOnPageError(page);
      await preparePage(page, { user: null });
      await page.goto(path);
      await expect(page.locator('#searchNotesButton')).toBeAttached();

      const widths = await page.evaluate(() => ({
        innerWidth: window.innerWidth,
        visualViewportWidth: window.visualViewport?.width ?? window.innerWidth,
      }));
      expect(widths.innerWidth).toBe(widths.visualViewportWidth);
    });

    test(`${path}: #searchNotesDialog renders fully within the visible viewport`, async ({ page }) => {
      failOnPageError(page);
      await preparePage(page, { user: null });
      await page.goto(path);

      await page.click('#searchNotesButton');
      const dialog = page.locator('#searchNotesDialog');
      await expect(dialog).toBeVisible();

      const box = await dialog.boundingBox();
      const viewportWidth = await page.evaluate(() => window.visualViewport?.width ?? window.innerWidth);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewportWidth + 1);

      // The real regression: a real click on the x, not Escape.
      await page.click('#closeSearchNotesDialog');
      await expect(dialog).toBeHidden();
    });
  }

  test('/browse/: #noteCiteDialog also renders fully within the visible viewport', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author) });
    await page.goto('/browse/');
    await page.evaluate(() => {
      state.dafRef = 'Chullin 89a';
      window.DafNotes.open('Chullin 89a.1', '');
    });
    await expect(page.locator('#noteCompose')).toBeVisible();
    await page.click('#noteCiteButton');

    const dialog = page.locator('#noteCiteDialog');
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    const viewportWidth = await page.evaluate(() => window.visualViewport?.width ?? window.innerWidth);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewportWidth + 1);

    await page.click('#closeNoteCiteDialog');
    await expect(dialog).toBeHidden();
  });

  test('desktop stays centred (no regression from the phone-width fix)', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'desktop-only assertion; the mobile project covers the phone-width case above');
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/browse/');
    await page.click('#searchNotesButton');

    const box = await page.locator('#searchNotesDialog').boundingBox();
    const viewportWidth = await page.evaluate(() => window.innerWidth);
    const centerX = box.x + box.width / 2;
    expect(Math.abs(centerX - viewportWidth / 2)).toBeLessThan(5);
  });
});
