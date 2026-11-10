import { test, expect } from '@playwright/test';
import { preparePage, failOnPageError } from '../support/harness.mjs';
import { USERS } from '../fixtures/dataset.mjs';

// On a phone the notes panel fills only what is visible -- the browser's
// bars and the keyboard take part of the screen -- and its Save button stays
// pinned at the bottom of the form, so a note can always be saved (the
// save itself, with a daf loaded, is in mobile-layout.spec.mjs).

for (const height of [640, 380]) {
  test(`the notes panel fits a ${height}px-tall phone screen and Save can be tapped`, async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'phone layout');
    failOnPageError(page);
    await page.setViewportSize({ width: 412, height });
    await preparePage(page, { user: USERS.ordinary });
    await page.goto('/player/?ref=Chullin%2089a');
    await expect.poll(() => page.evaluate(() => typeof window.DafNotes?.open)).toBe('function');
    await page.evaluate(() => window.DafNotes.open('Chullin 89a:1', 'שורה'));
    const dialog = page.locator('#noteDialog');
    await expect(dialog).toBeVisible();
    await expect(page.locator('#noteCompose')).toBeVisible();
    const fit = await page.evaluate(() => {
      const box = document.getElementById('noteDialog').getBoundingClientRect();
      const save = document.getElementById('saveNoteButton').getBoundingClientRect();
      const hit = document.elementFromPoint(save.x + save.width / 2, save.y + save.height / 2);
      return { bottom: box.bottom, saveBottom: save.bottom, onTop: hit?.id === 'saveNoteButton', height: innerHeight };
    });
    expect(fit.bottom).toBeLessThanOrEqual(fit.height + 1);
    expect(fit.saveBottom).toBeLessThanOrEqual(fit.height);
    expect(fit.onTop).toBe(true);
  });
}

test('on a computer the notes panel keeps its full-height sidebar', async ({ page }, info) => {
  test.skip(info.project.name === 'mobile', 'desktop layout');
  await preparePage(page, { user: USERS.ordinary });
  await page.goto('/player/?ref=Chullin%2089a');
  await expect.poll(() => page.evaluate(() => typeof window.DafNotes?.open)).toBe('function');
  await page.evaluate(() => window.DafNotes.open('Chullin 89a:1', 'שורה'));
  const box = await page.locator('#noteDialog').boundingBox();
  const view = page.viewportSize();
  expect(Math.round(box.height)).toBe(view.height);
  expect(box.width).toBeLessThanOrEqual(421);
});
