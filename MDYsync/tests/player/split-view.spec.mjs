import { test, expect } from '@playwright/test';
import { preparePage, failOnPageError } from '../support/harness.mjs';

// The unified viewing-mode system: the prominent 3-button selector above the
// player, and the new Split View mode (video and daf in separate,
// non-overlapping panes, replacing the plain default .watch-layout grid).
//
// setViewerMode() (app.js) is the one authoritative entry point; these tests
// exercise it through the real UI controls a reader would actually click,
// the same way reading-mode-mini-player.spec.mjs does for Reading Mode --
// not by calling app.js functions directly -- so a wiring regression in the
// markup (a missing id, a button that doesn't call through) would actually
// fail here.
//
// Navigating straight to `?ref=Chullin 89a` with this suite's fixture stub
// (no real synced alignment data behind that exact ref) makes loadAlignmentData
// throw "No segments found" on load -- a pre-existing, harmless-in-fixtures
// condition every other test using the same ref already tolerates (see
// speed.spec.mjs's own identical navigation). It surfaces as the sitewide
// top-of-page error banner (index.html's own inline <script>, position:fixed,
// z-index 99999) -- which every OTHER test's target controls happen to sit
// below, but this feature's own prominent selector and Split View toolbar
// are deliberately pinned to the very top of the viewport too, so the banner
// can cover them. Dismissed defensively before interacting with anything up
// there, the same way a reader would just close it themselves.
async function dismissErrorBanner(page) {
  const dismiss = page.locator('[aria-label="Dismiss"]');
  if (await dismiss.count()) await dismiss.first().click({ timeout: 1000 }).catch(() => {});
}

test.describe('Unified viewing modes — the prominent selector', () => {
  test('Split View is the default mode on load, and the selector reflects it', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/browse/?ref=Chullin%2089a');
    await expect(page.locator('#viewerModeSplitButton')).toBeAttached();

    await expect.poll(() => page.evaluate(() => state.viewerMode)).toBe('split');
    await dismissErrorBanner(page);
    await expect(page.locator('#viewerModeSplitButton')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#viewerModeDafOnVideoButton')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#viewerModeVideoOnDafButton')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.watch-layout')).toHaveClass(/split-active/);
    await expect(page.locator('body')).toHaveClass(/split-view-active/);
  });

  test('switching to Daf on video and Video on daf is mutually exclusive with Split View', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    await expect.poll(() => page.evaluate(() => state.viewerMode)).toBe('split');
    await dismissErrorBanner(page);

    await page.click('#viewerModeDafOnVideoButton');
    await expect.poll(() => page.evaluate(() => state.viewerMode)).toBe('daf-on-video');
    await expect.poll(() => page.evaluate(() => state.videoOverlayEnabled)).toBe(true);
    await expect.poll(() => page.evaluate(() => state.splitViewEnabled)).toBe(false);
    await expect(page.locator('body')).not.toHaveClass(/split-view-active/);
    await expect(page.locator('#viewerModeDafOnVideoButton')).toHaveAttribute('aria-pressed', 'true');

    await page.click('#viewerModeVideoOnDafButton');
    await expect.poll(() => page.evaluate(() => state.viewerMode)).toBe('video-on-daf');
    await expect.poll(() => page.evaluate(() => state.readingModeEnabled)).toBe(true);
    await expect.poll(() => page.evaluate(() => state.videoOverlayEnabled)).toBe(false);
    await expect.poll(() => page.evaluate(() => state.splitViewEnabled)).toBe(false);
    await expect(page.locator('#viewerModeVideoOnDafButton')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#viewerModeDafOnVideoButton')).toHaveAttribute('aria-pressed', 'false');

    // Back to Split View -- the video/daf DOM nodes must be the SAME nodes
    // (never recreated) across every one of these transitions.
    const videoFrameHandle = await page.evaluateHandle(() => document.getElementById('videoFrame'));
    await page.click('#viewerModeSplitButton');
    await expect.poll(() => page.evaluate(() => state.viewerMode)).toBe('split');
    await dismissErrorBanner(page);
    await expect.poll(() => page.evaluate(() => state.readingModeEnabled)).toBe(false);
    const stillSameNode = await page.evaluate((el) => el === document.getElementById('videoFrame'), videoFrameHandle);
    expect(stillSameNode).toBe(true);
  });

  test('watch/index.html only offers Split View and Daf on video (no Reading Mode there)', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/watch/');
    await expect(page.locator('#viewerModeSplitButton')).toBeAttached();
    await expect(page.locator('#viewerModeDafOnVideoButton')).toBeAttached();
    await expect(page.locator('#viewerModeVideoOnDafButton')).toHaveCount(0);
    await expect(page.locator('#readingModeButton')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => state.viewerMode)).toBe('split');
    await dismissErrorBanner(page);
  });

  test('the toolbar pill mirrors the prominent selector and stays in sync', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    await expect(page.locator('#splitViewButton')).toBeAttached();
    await expect(page.locator('#splitViewButton')).toHaveAttribute('aria-pressed', 'true');
    await dismissErrorBanner(page);

    await page.click('#viewerModeDafOnVideoButton');
    await expect(page.locator('#splitViewButton')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#dafOnVideoButton')).toHaveAttribute('aria-pressed', 'true');

    await page.click('#splitViewButton');
    await expect.poll(() => page.evaluate(() => state.viewerMode)).toBe('split');
    await dismissErrorBanner(page);
    await expect(page.locator('#viewerModeSplitButton')).toHaveAttribute('aria-pressed', 'true');
  });
});

test.describe('Split View — divider and layout', () => {
  test('the divider is keyboard-resizable and exposes separator semantics', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    await expect.poll(() => page.evaluate(() => state.viewerMode)).toBe('split');
    await dismissErrorBanner(page);

    const divider = page.locator('#splitDivider');
    await expect(divider).toBeVisible();
    await expect(divider).toHaveAttribute('role', 'separator');
    const before = Number(await divider.getAttribute('aria-valuenow'));
    // Stacked layout (the default on a narrow portrait viewport) resizes on
    // ArrowDown/ArrowUp instead of ArrowRight/ArrowLeft -- see the divider's
    // own keydown handler in app.js.
    const growKey = (await page.evaluate(() => state.splitViewLayout)) === 'stacked' ? 'ArrowDown' : 'ArrowRight';

    await divider.focus();
    await page.keyboard.press(growKey);
    await page.keyboard.press(growKey);
    const after = Number(await divider.getAttribute('aria-valuenow'));
    expect(after).toBeGreaterThan(before);
    await expect.poll(() => page.evaluate(() => state.splitViewRatio)).not.toBeNull();
  });

  test('the layout toggle switches side-by-side and stacked without reloading the video', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/browse/?ref=Chullin%2089a');
    await expect.poll(() => page.evaluate(() => state.viewerMode)).toBe('split');
    await dismissErrorBanner(page);

    const videoFrameHandle = await page.evaluateHandle(() => document.getElementById('videoFrame'));
    const before = await page.evaluate(() => state.splitViewLayout);
    await page.click('#splitLayoutToggleButton');
    await expect.poll(() => page.evaluate(() => state.splitViewLayout)).toBe(before === 'stacked' ? 'side-by-side' : 'stacked');
    await expect.poll(() => page.evaluate(() => state.splitViewLayoutExplicit)).toBe(true);
    const stillSameNode = await page.evaluate((el) => el === document.getElementById('videoFrame'), videoFrameHandle);
    expect(stillSameNode).toBe(true);
  });

  test('swap flips which side the video pane sits on', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    await expect.poll(() => page.evaluate(() => state.viewerMode)).toBe('split');
    await dismissErrorBanner(page);
    await expect.poll(() => page.evaluate(() => state.splitViewVideoPosition)).toBe('start');

    await page.click('#splitSwapButton');
    await expect.poll(() => page.evaluate(() => state.splitViewVideoPosition)).toBe('end');
    await expect(page.locator('.watch-layout')).toHaveClass(/split-video-end/);
  });

  test('Escape exits Split View to standard, and the exit button does the same', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    await expect.poll(() => page.evaluate(() => state.viewerMode)).toBe('split');
    await dismissErrorBanner(page);

    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => state.viewerMode)).toBe('standard');
    await expect(page.locator('body')).not.toHaveClass(/split-view-active/);

    await page.click('#viewerModeSplitButton');
    await expect.poll(() => page.evaluate(() => state.viewerMode)).toBe('split');
    await dismissErrorBanner(page);
    await expect(page.locator('#splitExitButton')).toBeVisible();
    await page.click('#splitExitButton');
    await expect.poll(() => page.evaluate(() => state.viewerMode)).toBe('standard');
  });
});

test.describe('Split View — video zoom controls', () => {
  test('the zoom buttons adjust splitVideoZoom and stay clamped to 1x-3x', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/browse/?ref=Chullin%2089a');
    await expect.poll(() => page.evaluate(() => state.viewerMode)).toBe('split');
    await dismissErrorBanner(page);
    await expect(page.locator('#splitVideoZoomInButton')).toBeAttached();

    for (let i = 0; i < 10; i += 1) await page.click('#splitVideoZoomInButton');
    await expect.poll(() => page.evaluate(() => state.splitVideoZoom)).toBeLessThanOrEqual(3);
    await expect(page.locator('#splitVideoZoomResetButton')).toBeVisible();

    await page.click('#splitVideoZoomResetButton');
    await expect.poll(() => page.evaluate(() => state.splitVideoZoom)).toBe(1);
    await expect(page.locator('#splitVideoZoomResetButton')).toBeHidden();
  });
});

test.describe('Split View — no duplicate ids or broken markup', () => {
  for (const [path, label] of [['/player/?ref=Chullin%2089a', 'player'], ['/browse/?ref=Chullin%2089a', 'browse'], ['/watch/', 'watch']]) {
    test(`${label}: every id introduced by this feature is unique on the page`, async ({ page }) => {
      failOnPageError(page);
      await preparePage(page, { user: null });
      await page.goto(path);
      const ids = ['viewerModeSelect', 'viewerModeSplitButton', 'viewerModeDafOnVideoButton', 'splitDivider', 'splitToolbar', 'splitVideoPinchSurface', 'splitVideoZoomIndicator', 'splitVideoZoomControls', 'splitViewButton'];
      for (const id of ids) {
        const count = await page.locator(`#${id}`).count();
        expect(count, `#${id} on ${label}`).toBeLessThanOrEqual(1);
      }
    });
  }
});
