import { test, expect } from '@playwright/test';
import { preparePage, failOnPageError } from '../support/harness.mjs';

// ?embed=1: the player inside the welcome page's "Try it" sample (EMBED in
// app.js). It shows only the video and the daf in Split view, remembers
// nothing about the visit, and pauses after ?limit= seconds of playing with a
// link into the full shiur.

const SAMPLE = '/player/?ref=Chullin%2089a&embed=1&mode=split&t=120&limit=1&zoom=1.6';

test.describe('Embedded sample', () => {
  test('opens in Split view with only the video and the daf, and remembers nothing', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto(SAMPLE);
    await expect(page.locator('html')).toHaveClass(/is-embed/);
    await expect.poll(() => page.evaluate(() => state.viewerMode)).toBe('split');
    expect(await page.evaluate(() => state.vilnaPageZoom)).toBeCloseTo(1.6);
    await expect(page.locator('.sidebar')).toBeHidden();
    await expect(page.locator('#splitBackToDaf')).toBeHidden();
    const historyLength = await page.evaluate(() => history.length);

    await page.evaluate(() => {
      state.videoSource = { type: 'youtube', videoId: 'EMBEDVID001' };
      window.getCurrentTime = () => 300;
      window.getDuration = () => 2400;
      window.dispatchEvent(new Event('pagehide'));
      setVilnaPageZoom(2);
      saveSplitViewPreferences();
    });
    const stored = await page.evaluate(() => Object.keys(localStorage).filter((key) => /watchHistory|dafView|splitView/i.test(key)));
    expect(stored).toEqual([]);
    expect(await page.evaluate(() => history.length)).toBe(historyLength);
  });

  test('after the limit it pauses and offers the full shiur from the same moment', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto(SAMPLE);
    await expect.poll(() => page.evaluate(() => state.viewerMode)).toBe('split');
    await page.evaluate(async () => {
      let playing = true;
      window.isPaused = () => !playing;
      window.togglePlay = async () => { playing = !playing; };
      window.getCurrentTime = () => 135.4;
      for (let i = 0; i < 8; i += 1) {
        updateTimeline();
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    });
    const end = page.locator('#embedEnd');
    await expect(end).toBeVisible();
    expect(await page.evaluate(() => isPaused())).toBe(true);
    await expect(end.locator('.embed-end-cta')).toHaveAttribute('href', '/player/?ref=Chullin+89a&mode=split&t=135');
    await expect(end.locator('.embed-end-cta')).toHaveAttribute('target', '_top');

    await end.locator('.embed-end-again').click();
    await expect(end).toBeHidden();
    expect(await page.evaluate(() => isPaused())).toBe(false);
  });

  test('a normal player link is not a sample', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    await expect(page.locator('html')).not.toHaveClass(/is-embed/);
    expect(await page.evaluate(() => EMBED)).toBeNull();
  });
});

test.describe('Welcome page sample', () => {
  test('Try it loads the sample player only when asked', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/welcome/');
    await expect(page.locator('#tryStage iframe')).toHaveCount(0);
    await page.locator('#tryButton').click();
    const frame = page.locator('#tryStage iframe');
    await expect(frame).toHaveCount(1);
    const src = new URL(await frame.getAttribute('src'), 'http://x');
    expect(src.pathname).toBe('/player/');
    expect(Object.fromEntries(src.searchParams)).toMatchObject({ embed: '1', mode: 'split', limit: '180', ref: 'Bekhorot 40a' });
    expect(await frame.getAttribute('allow')).toContain('autoplay');
  });
});
