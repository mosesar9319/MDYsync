import { test, expect } from '@playwright/test';
import { preparePage, failOnPageError } from '../support/harness.mjs';

// Leaving Split steps the browser back one entry, and that Back lands a
// moment later. A reader who goes straight back into Split before it lands
// must stay in Split, and Back must still leave it afterwards.

test('going back into Split right after leaving it keeps Split on', async ({ page }) => {
  failOnPageError(page);
  await preparePage(page, { user: null });
  await page.goto('/player/?ref=Chullin%2089a');
  await expect.poll(() => page.evaluate(() => typeof setViewerMode)).toBe('function');

  await page.evaluate(() => setViewerMode('split'));
  await expect.poll(() => page.evaluate(() => state.viewerMode)).toBe('split');
  expect(await page.evaluate(() => history.state?.split)).toBe(true);

  // Leave, and go back in before the browser's Back has landed.
  await page.evaluate(() => { requestExitSplit(); setViewerMode('split'); });
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => state.viewerMode)).toBe('split');
  await expect(page.locator('body')).toHaveClass(/split-view-active/);
  expect(await page.evaluate(() => history.state?.split)).toBe(true);

  // Back still leaves Split.
  await page.goBack();
  await expect.poll(() => page.evaluate(() => state.viewerMode)).toBe('standard');
  await expect(page.locator('body')).not.toHaveClass(/split-view-active/);
});

test('leaving Split normally still takes its history entry with it', async ({ page }) => {
  failOnPageError(page);
  await preparePage(page, { user: null });
  await page.goto('/player/?ref=Chullin%2089a');
  await expect.poll(() => page.evaluate(() => typeof setViewerMode)).toBe('function');
  const before = await page.evaluate(() => history.length);
  await page.evaluate(() => setViewerMode('split'));
  await expect.poll(() => page.evaluate(() => history.state?.split)).toBe(true);
  await page.evaluate(() => requestExitSplit());
  await expect.poll(() => page.evaluate(() => Boolean(history.state?.split))).toBe(false);
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => state.viewerMode)).toBe('standard');
  // Entering again pushes a fresh entry (no stale one left behind).
  await page.evaluate(() => setViewerMode('split'));
  await expect.poll(() => page.evaluate(() => history.state?.split)).toBe(true);
  expect(await page.evaluate(() => history.length)).toBe(before + 1);
});
