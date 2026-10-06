import { test, expect } from '@playwright/test';
import { preparePage, failOnPageError } from '../support/harness.mjs';

// Covers only the V1 infrastructure live.js itself is responsible for --
// mic permission handling, the resample/base64 audio pipeline running on
// real (if silent) audio frames without throwing, and the token-fetch/error
// surfacing. It stubs /api/live-token rather than reaching the real
// ElevenLabs realtime WebSocket (no key in this test environment, and no
// interest in making this suite depend on a live, metered third-party
// service) -- the exact query-param/message shapes in live.js's own
// buildWsUrl()/connectWebSocket() are therefore unverified by this suite
// and need a real ElevenLabs API key to confirm (see live.js's own
// keyterms-encoding comment for the specific open question).

test('Live Follow page loads cleanly and validates empty ref', async ({ page }) => {
  const errors = failOnPageError(page);
  await preparePage(page, { user: null });
  await page.route('**/api/live-token', (route) =>
    route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"not configured in test"}' })
  );
  await page.goto('/live/');
  await expect(page.locator('#liveStartButton')).toBeVisible();
  await page.locator('#liveStartButton').click();
  await expect(page.locator('#toast')).toHaveClass(/show/);
  await expect(page.locator('#toast')).toContainText('Enter a daf reference');
  expect(errors).toEqual([]);
});

test('Live Follow handles a denied microphone gracefully', async ({ page, context }) => {
  const errors = failOnPageError(page);
  await preparePage(page, { user: null });
  await context.grantPermissions([]); // explicitly no mic permission
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }));
  });
  await page.goto('/live/');
  await page.locator('#liveRefInput').fill('Chullin 91a');
  await page.locator('#liveStartButton').click();
  await expect(page.locator('#liveStatusText')).toHaveText('Error');
  await expect(page.locator('#liveStatusDetail')).toContainText('denied');
  // live.js deliberately console.errors a mic-permission failure (same
  // convention as scan-live.js's own camera-denied path) -- expected here,
  // not a bug.
  expect(errors.filter((e) => !e.includes('Could not open the microphone'))).toEqual([]);
});

test('Live Follow opens the mic and attempts a token fetch', async ({ page }) => {
  const errors = failOnPageError(page);
  await preparePage(page, { user: null });
  let tokenRequested = false;
  await page.route('**/api/live-token', (route) => {
    tokenRequested = true;
    return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"not configured in test"}' });
  });
  await page.addInitScript(() => {
    // A real (silent) MediaStream via a throwaway AudioContext -- live.js's
    // createMediaStreamSource() needs a genuine MediaStream, not a plain
    // stand-in object.
    navigator.mediaDevices.getUserMedia = () => {
      const ctx = new AudioContext();
      return Promise.resolve(ctx.createMediaStreamDestination().stream);
    };
  });
  await page.goto('/live/');
  await page.locator('#liveRefInput').fill('Chullin 91a');
  await page.locator('#liveStartButton').click();
  await expect.poll(() => tokenRequested).toBe(true);
  // The 503 from the stub should surface as a clean error, not a thrown exception.
  await expect(page.locator('#liveStatusText')).toHaveText('Error', { timeout: 5000 });
  // Chrome itself logs a benign "Failed to load resource: ...503..." console
  // line for the stubbed failure response -- not a bug in live.js, so it's
  // filtered out rather than asserting on it.
  expect(errors.filter((e) => !e.includes('503'))).toEqual([]);
});
