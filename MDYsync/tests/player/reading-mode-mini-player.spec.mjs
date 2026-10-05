import { test, expect } from '@playwright/test';
import { preparePage, failOnPageError } from '../support/harness.mjs';

// Reading Mode's floating "mini player" (#readingVideoFloat) -- the small,
// draggable/resizable video that floats over the printed daf once "Video on
// daf" is toggled on. Two real bugs reported against it:
//
//   1. The mini player started at a modest default width (360px, well under
//      its own 560px cap) with NO usable way for a desktop mouse user to
//      make it bigger. Pinch and Ctrl+wheel resize both existed and worked,
//      but neither is discoverable with a plain mouse, and the one obvious
//      affordance for it -- #readingVideoResizeHandle, the little diagonal
//      grip in the corner -- was permanently display:none. The base rule
//      ("#readingVideoResizeHandle's own class, .reading-video-resize, is
//      display:none by default") was correctly un-hidden for the pinch
//      surface once Reading Mode activated, but the SAME un-hide was missing
//      for the resize handle itself -- so it stayed invisible, unfocusable
//      and unclickable even with Reading Mode on.
//
//   2. #fullscreenButton (the mini player's own fullscreen toggle, distinct
//      from #vilnaFullscreenButton which fullscreens the whole daf)
//      only checked/requested the UNPREFIXED Fullscreen API.
//      toggleVilnaFullscreen already had a WebKit-prefixed fallback for
//      Safari versions before 16.4; toggleVideoFullscreen did not, so on
//      those the click silently did nothing at all (the optional-chained
//      requestFullscreen?.() call short-circuits its own .catch(), so not
//      even an error toast fired).
//
// Both are exercised here without a live YouTube video: #readingVideoFloat
// and its own resize/fullscreen chrome exist and behave the same way
// whether or not a video has actually loaded into #videoFrame.

test.describe('Reading Mode mini player — resizing', () => {
  test('the resize handle is visible and reachable once Reading Mode is on', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/browse/?ref=Chullin%2089a');
    await expect(page.locator('#readingModeButton')).toBeAttached();

    // Never visible before Reading Mode is entered.
    await expect(page.locator('#readingVideoResizeHandle')).toBeHidden();

    await page.click('#readingModeButton');
    await expect(page.locator('#readingVideoFloat')).toBeVisible();

    const handle = page.locator('#readingVideoResizeHandle');
    await expect(handle).toBeVisible();
    const box = await handle.boundingBox();
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
  });

  // setReadingMode enters through a double requestAnimationFrame
  // (restoreReadingVideoPlacement is scheduled two frames out) before it
  // sets the float's real width, and .reading-video-float itself transitions
  // width over .18s -- so a read taken right after the element becomes
  // "visible" can catch either the pre-JS CSS default or a still-animating
  // in-between value, not the settled default. Waiting for
  // state.readingVideoWidth to actually be assigned first, then a beat for
  // the transition to finish, is what a real reader also waits through
  // (however briefly) before the layout looks stable to them.
  async function waitForMiniPlayerSettled(page) {
    await expect.poll(() => page.evaluate(() => state.readingVideoWidth)).not.toBeNull();
    await page.waitForTimeout(250);
  }

  // Drives #readingVideoResizeHandle's own pointerdown/pointermove/pointerup
  // listeners with dispatched PointerEvents rather than page.mouse -- on a
  // touch-enabled context (the mobile project's Pixel 7 emulation),
  // page.mouse's synthetic mouse input landed on the handle (confirmed by
  // its bounding box) but never actually resized the float, apparently lost
  // to Chromium's own mouse/touch arbitration in that mode. The handle's
  // listeners have no pointerType check of their own (unlike the pinch
  // surface's separate 1-vs-2-pointer logic) -- dispatching the events
  // directly tests that application logic without depending on the test
  // harness's platform-specific input synthesis.
  async function dragResizeHandle(page, dx, dy) {
    await page.evaluate(({ dx, dy }) => {
      const handle = document.getElementById('readingVideoResizeHandle');
      const rect = handle.getBoundingClientRect();
      const startX = rect.left + rect.width / 2;
      const startY = rect.top + rect.height / 2;
      const fire = (type, x, y) => handle.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse',
        clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1,
      }));
      fire('pointerdown', startX, startY);
      fire('pointermove', startX + dx / 2, startY + dy / 2);
      fire('pointermove', startX + dx, startY + dy);
      fire('pointerup', startX + dx, startY + dy);
    }, { dx, dy });
  }

  test('dragging the resize handle actually makes the mini player bigger', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/browse/?ref=Chullin%2089a');
    await page.click('#readingModeButton');
    await expect(page.locator('#readingVideoFloat')).toBeVisible();
    await waitForMiniPlayerSettled(page);

    const before = await page.evaluate(() => document.getElementById('readingVideoFloat').getBoundingClientRect().width);
    await dragResizeHandle(page, 100, 50);

    const after = await page.evaluate(() => document.getElementById('readingVideoFloat').getBoundingClientRect().width);
    expect(after).toBeGreaterThan(before);
  });

  test('dragging the handle the other way makes it smaller, down to the floor', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/browse/?ref=Chullin%2089a');
    await page.click('#readingModeButton');
    await expect(page.locator('#readingVideoFloat')).toBeVisible();
    await waitForMiniPlayerSettled(page);

    await dragResizeHandle(page, -400, -200);

    // READING_VIDEO_MIN_WIDTH in app.js.
    const width = await page.evaluate(() => document.getElementById('readingVideoFloat').getBoundingClientRect().width);
    expect(width).toBeGreaterThanOrEqual(190);
  });
});

test.describe('Reading Mode mini player — fullscreen', () => {
  test('the mini player\'s own fullscreen button targets #videoFrame', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/browse/?ref=Chullin%2089a');
    await page.click('#readingModeButton');
    await expect(page.locator('#readingVideoFloat')).toBeVisible();

    await page.click('#fullscreenButton');
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('videoFrame');

    await page.evaluate(() => document.exitFullscreen());
    await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
  });

  test('falls back to the WebKit-prefixed Fullscreen API when the unprefixed one is unavailable', async ({ page }) => {
    // Simulates Safari < 16.4, where element.requestFullscreen is undefined
    // and only the webkit-prefixed name exists. Before the fix,
    // toggleVideoFullscreen only ever checked/called the unprefixed API, so
    // this scenario silently did nothing at all.
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/browse/?ref=Chullin%2089a');
    await expect(page.locator('#fullscreenButton')).toBeAttached();

    const usedFallback = await page.evaluate(() => {
      const frame = document.getElementById('videoFrame');
      const real = frame.requestFullscreen.bind(frame);
      let called = false;
      Object.defineProperty(frame, 'requestFullscreen', { value: undefined, configurable: true });
      Object.defineProperty(frame, 'webkitRequestFullscreen', {
        value: () => { called = true; return real(); },
        configurable: true,
      });
      toggleVideoFullscreen();
      return called;
    });
    expect(usedFallback).toBe(true);
    await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
    await page.evaluate(() => document.exitFullscreen());
  });

  test('exiting also falls back to the WebKit-prefixed API when needed', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/browse/?ref=Chullin%2089a');
    await page.click('#fullscreenButton');
    await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);

    const usedFallback = await page.evaluate(() => {
      let called = false;
      Object.defineProperty(document, 'exitFullscreen', { value: undefined, configurable: true });
      Object.defineProperty(document, 'webkitExitFullscreen', {
        value: () => { called = true; return document.webkitCancelFullScreen?.() ?? Promise.resolve(); },
        configurable: true,
      });
      toggleVideoFullscreen();
      return called;
    });
    expect(usedFallback).toBe(true);
  });
});

// Reported directly, against Split View's own identical pinch surface
// (splitVideoTap, see app.js): every tap anywhere on the video paused it.
// Root cause: both readingVideoTap here and splitVideoTap sit on a
// transparent surface over the video picture to catch pinch/pan gestures
// the cross-origin YouTube iframe can't bubble, and both fell back to
// togglePlay() unconditionally for a plain tap, on the premise that a tap
// would otherwise be "silently swallowed" the way it is for the direct-
// link <video> path. That premise is wrong for YouTube: with this surface
// absent, a tap on a YouTube iframe outside Reading Mode/Split View does
// nothing this app's own JS can observe, let alone toggle -- so calling
// togglePlay() unconditionally manufactured a "tap always pauses it"
// behavior neither mode ever had for YouTube before this surface existed.
test.describe('Reading Mode mini player — tapping the video does not manufacture a pause', () => {
  async function tapPinchSurface(page) {
    await page.evaluate(async () => {
      const surface = document.getElementById('readingVideoPinchSurface');
      const rect = surface.getBoundingClientRect();
      const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
      surface.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: x, clientY: y, bubbles: true }));
      await new Promise((r) => setTimeout(r, 30));
      surface.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: x, clientY: y, bubbles: true }));
      await new Promise((r) => setTimeout(r, 30));
    });
  }

  test('a plain tap never pauses (or plays) a YouTube video', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/browse/?ref=Chullin%2089a');
    await page.click('#readingModeButton');
    await expect(page.locator('#readingVideoFloat')).toBeVisible();

    const result = await page.evaluate(async () => {
      state.playerType = 'youtube';
      state.youtubeReady = true;
      window.__paused = 0; window.__played = 0;
      state.youtubePlayer = {
        getPlayerState: () => 1, // playing
        pauseVideo: () => { window.__paused++; },
        playVideo: () => { window.__played++; },
      };
    }).then(() => tapPinchSurface(page)).then(() => page.evaluate(() => ({ paused: window.__paused, played: window.__played })));

    expect(result).toEqual({ paused: 0, played: 0 });
  });

  test('a plain tap still toggles play/pause for a direct-link <video>, exactly as before', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/browse/?ref=Chullin%2089a');
    await page.click('#readingModeButton');
    await expect(page.locator('#readingVideoFloat')).toBeVisible();

    const before = await page.evaluate(() => document.getElementById('video').paused);
    await tapPinchSurface(page);
    await page.waitForTimeout(100);
    const after = await page.evaluate(() => document.getElementById('video').paused);

    expect(after).not.toBe(before);
  });
});
