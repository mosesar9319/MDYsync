import { test, expect } from '@playwright/test';
import { preparePage, failOnPageError } from '../support/harness.mjs';

// The gear's own settings panel (#videoSettings, a native <details>) --
// reported alongside the speed control as one of the player's recurring
// trouble spots, but unlike speed.spec.mjs/controls-autohide.spec.mjs it had
// no coverage of its own at all.
//
// Reported directly: once opened, the panel never closed again except by
// tapping the gear a second time. Every other menu in this bar (the daf
// picker, "More", the speed listbox, the tools overflow tray) closes on an
// outside click; player-chrome.js's own comment on the tools overflow tray
// even CLAIMED "that panel already has its own outside-click handling" --
// but nothing had ever actually wired one up. A native <details> element
// does not close itself on an outside click the way a native <select>'s
// popup does; that has to be asked for explicitly, the same as every other
// menu here already does, and this one never did.
//
// Left open, the panel (position:fixed, z-index 30 -- see
// .video-settings-body-portal in styles.css, reparented to <body> so it
// escapes .player-controls' own stacking context and .video-frame's
// overflow:hidden) sat on top of the video indefinitely. It also kept the
// control bar itself pinned visible the whole time: controlsShouldStayVisible
// (app.js) treats #videoSettings.open as a standing reason never to
// auto-hide, so a reader who opened the gear and then tapped away into the
// video got a bar -- and a settings panel -- that both refused to go away
// until they found and re-tapped the tiny gear icon again.

test.describe('The settings (gear) panel behaves like every other menu in the bar', () => {
  test('opening it shows the panel and stops the control bar auto-hiding', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/watch/?ref=Chullin%2089a');
    await expect(page.locator('#videoSettings')).toBeAttached();

    await page.locator('#videoSettings summary').click();

    expect(await page.evaluate(() => document.getElementById('videoSettings').open)).toBe(true);
    await expect(page.locator('.video-settings-body')).toBeVisible();
    expect(await page.evaluate(() => controlsShouldStayVisible())).toBe(true);
  });

  test('an outside click closes it, the same as the daf menu, "More", and the speed listbox', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/watch/?ref=Chullin%2089a');
    await expect(page.locator('#videoSettings')).toBeAttached();

    await page.locator('#videoSettings summary').click();
    await expect(page.locator('.video-settings-body')).toBeVisible();

    // Nowhere near the panel or the gear -- the top-left corner of the page.
    await page.mouse.click(20, 20);

    expect(await page.evaluate(() => document.getElementById('videoSettings').open)).toBe(false);
    await expect(page.locator('.video-settings-body')).toBeHidden();
  });

  test('Escape closes it too', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/watch/?ref=Chullin%2089a');
    await expect(page.locator('#videoSettings')).toBeAttached();

    await page.locator('#videoSettings summary').click();
    await expect(page.locator('.video-settings-body')).toBeVisible();

    await page.keyboard.press('Escape');

    expect(await page.evaluate(() => document.getElementById('videoSettings').open)).toBe(false);
    await expect(page.locator('.video-settings-body')).toBeHidden();
  });

  test('a click INSIDE the panel (the quality select, say) does not close it', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/watch/?ref=Chullin%2089a');
    await expect(page.locator('#videoSettings')).toBeAttached();

    await page.locator('#videoSettings summary').click();
    await expect(page.locator('.video-settings-body')).toBeVisible();

    // The speed control itself lives inside the portaled panel here (it
    // only moves out into the bar's own .pc-tools group once player-chrome.js
    // runs its OWN relocation -- which it does, so this also doubles as
    // proof the outside-click guard checks the portaled panel's current
    // location, not a stale reference to where it started in the DOM).
    await page.locator('.video-settings-body').click();

    expect(await page.evaluate(() => document.getElementById('videoSettings').open)).toBe(true);
    await expect(page.locator('.video-settings-body')).toBeVisible();
  });

  test('clicking the gear a second time still closes it (unaffected by the new outside-click handler)', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/watch/?ref=Chullin%2089a');
    await expect(page.locator('#videoSettings')).toBeAttached();

    await page.locator('#videoSettings summary').click();
    await expect(page.locator('.video-settings-body')).toBeVisible();

    await page.locator('#videoSettings summary').click();

    expect(await page.evaluate(() => document.getElementById('videoSettings').open)).toBe(false);
    await expect(page.locator('.video-settings-body')).toBeHidden();
  });
});
