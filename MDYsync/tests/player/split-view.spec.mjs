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
// Every page loads into 'standard' -- the exact plain .watch-layout grid
// shown before this feature existed -- never Split View automatically; a
// reader reaches Split View (like the other two modes) only by clicking the
// prominent selector. enterSplitView() below is that click, done once per
// test that actually needs Split View active.
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

async function enterSplitView(page) {
  await dismissErrorBanner(page);
  await page.click('#viewerModeSplitButton');
  await expect.poll(() => page.evaluate(() => state.viewerMode)).toBe('split');
}

test.describe('Unified viewing modes — the prominent selector', () => {
  test('the page loads into standard mode, not Split View, exactly as before this feature existed', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/browse/?ref=Chullin%2089a');
    await expect(page.locator('#viewerModeSplitButton')).toBeAttached();
    await dismissErrorBanner(page);

    await expect.poll(() => page.evaluate(() => state.viewerMode)).toBe('standard');
    await expect(page.locator('#viewerModeSplitButton')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#viewerModeDafOnVideoButton')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#viewerModeVideoOnDafButton')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.watch-layout')).not.toHaveClass(/split-active/);
    await expect(page.locator('body')).not.toHaveClass(/split-view-active/);
  });

  test('clicking Split view enters it, and it stays reachable across a switch to the other two modes', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    await expect.poll(() => page.evaluate(() => state.viewerMode)).toBe('standard');
    await enterSplitView(page);
    await expect(page.locator('#viewerModeSplitButton')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.watch-layout')).toHaveClass(/split-active/);
    await expect(page.locator('body')).toHaveClass(/split-view-active/);

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
    await enterSplitView(page);

    // watch/index.html has no Reading Mode, so .video-frame is never wrapped
    // in .reading-video-float the way player/browse wrap it -- it sits as a
    // direct child of .player-card instead. The flush-video rule that hides
    // every OTHER direct child of .player-card once exempted only
    // .reading-video-float, which on this page's different DOM shape hid
    // .video-frame itself along with everything else: a blank video pane,
    // no player controls, nothing. Guards that specifically.
    await expect(page.locator('.video-frame')).toBeVisible();
  });

  test('the toolbar pill mirrors the prominent selector and stays in sync', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    await expect(page.locator('#splitViewButton')).toBeAttached();
    await expect(page.locator('#splitViewButton')).toHaveAttribute('aria-pressed', 'false');
    await dismissErrorBanner(page);

    await page.click('#viewerModeDafOnVideoButton');
    await expect(page.locator('#splitViewButton')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#dafOnVideoButton')).toHaveAttribute('aria-pressed', 'true');

    await page.click('#splitViewButton');
    await expect.poll(() => page.evaluate(() => state.viewerMode)).toBe('split');
    await expect(page.locator('#viewerModeSplitButton')).toHaveAttribute('aria-pressed', 'true');
  });
});

test.describe('Split View — the video pane is flush, not a crop of the player card', () => {
  test('only the video wrapper renders in the video pane -- the card heading and "now learning" panel are hidden', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    await enterSplitView(page);

    // Whichever of these a given page actually has (player/index.html uses
    // .daf-header.video-header, browse/watch use .card-heading; all three
    // that have it use .now-learning) -- none of player-card's OWN
    // surrounding chrome may be visible once Split View replaces it with
    // just the video.
    for (const selector of ['.player-card > .daf-header', '.player-card > .card-heading', '.player-card > .now-learning', '.player-card > .overlay-controls-page']) {
      const el = page.locator(selector);
      if (await el.count()) await expect(el).toBeHidden();
    }
    await expect(page.locator('.player-card .reading-video-float')).toBeVisible();

    const playerCardPadding = await page.locator('.player-card').evaluate((el) => getComputedStyle(el).paddingLeft);
    expect(playerCardPadding).toBe('0px');
  });

  // player-chrome.js reparents the page's real .setup-field.ref-field (the
  // ONLY tractate/daf picker on these pages) into #playerDafButton's own
  // dropdown, inside .player-topbar -- and Split View's focus mode hides
  // every other place that picker could otherwise be reached from (.topbar,
  // .breadcrumb, .setup-strip). .split-video-pinch-surface (the pinch-zoom
  // gesture layer added over the video picture) sits at a higher z-index
  // than .player-topbar across that whole upper region regardless of where
  // the topbar itself is positioned, so without its own z-index bump the
  // topbar's buttons -- daf picker included -- silently eat nothing: every
  // click goes to the pinch surface instead. Regression coverage for
  // "none of the buttons work" once reported against Split View.
  for (const path of ['/player/', '/browse/', '/watch/']) {
    test(`the video's own daf picker (in .player-topbar) stays clickable in Split View on ${path}`, async ({ page }) => {
      failOnPageError(page);
      await preparePage(page, { user: null });
      await page.goto(`${path}?ref=Chullin%2089a`);
      await enterSplitView(page);

      const dafButton = page.locator('#playerDafButton');
      await expect(dafButton).toBeVisible();
      await dafButton.click();
      await expect(page.locator('#playerDafMenu')).toBeVisible();
      await expect(page.locator('#playerDafMenu #dafTractateSelect')).toBeAttached();
    });
  }
});

test.describe('Split View — divider and layout', () => {
  test('the divider is keyboard-resizable and exposes separator semantics', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    await enterSplitView(page);

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
    await enterSplitView(page);

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
    await enterSplitView(page);
    await expect.poll(() => page.evaluate(() => state.splitViewVideoPosition)).toBe('start');
    await dismissErrorBanner(page);

    await page.click('#splitSwapButton');
    await expect.poll(() => page.evaluate(() => state.splitViewVideoPosition)).toBe('end');
    await expect(page.locator('.watch-layout')).toHaveClass(/split-video-end/);
  });

  test('Escape exits Split View to standard, and the exit button does the same', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    await enterSplitView(page);

    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => state.viewerMode)).toBe('standard');
    await expect(page.locator('body')).not.toHaveClass(/split-view-active/);

    await page.click('#viewerModeSplitButton');
    await expect.poll(() => page.evaluate(() => state.viewerMode)).toBe('split');
    await expect(page.locator('#splitExitButton')).toBeVisible();
    await dismissErrorBanner(page);
    await page.click('#splitExitButton');
    await expect.poll(() => page.evaluate(() => state.viewerMode)).toBe('standard');
  });
});

test.describe('Split View — video zoom controls', () => {
  test('the zoom buttons adjust splitVideoZoom and stay clamped to 1x-3x', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/browse/?ref=Chullin%2089a');
    await enterSplitView(page);
    await expect(page.locator('#splitVideoZoomInButton')).toBeAttached();

    for (let i = 0; i < 10; i += 1) await page.click('#splitVideoZoomInButton');
    await expect.poll(() => page.evaluate(() => state.splitVideoZoom)).toBeLessThanOrEqual(3);
    await expect(page.locator('#splitVideoZoomResetButton')).toBeVisible();

    await page.click('#splitVideoZoomResetButton');
    await expect.poll(() => page.evaluate(() => state.splitVideoZoom)).toBe(1);
    await expect(page.locator('#splitVideoZoomResetButton')).toBeHidden();
  });
});

// Reported as "the whole page freezes" after pinch-zooming/scrolling the daf
// inside Split View, on a real phone, over a YouTube video -- none of which
// this suite can reproduce directly (no real touch hardware, and this
// sandbox's network policy cannot reliably stream real YouTube video). What
// IS directly testable and fixable: the daf-page pinch-zoom handler
// (vilnaScroll's own touchmove listener, unrelated to Split View's own video
// pinch surface) forced a synchronous layout read (getBoundingClientRect)
// plus a scroll-position write on EVERY raw touchmove event, a textbook
// layout-thrashing pattern that predates Split View entirely -- but Split
// View's daf pane is the full viewport rather than the small embedded card
// this handler had only ever run against before, so the identical per-event
// cost now repaints and re-composites a much larger surface on every one of
// however many touchmove events a real two-finger drag fires per second.
// Coalescing to at most once per animation frame (app.js) bounds that cost
// to the display's own refresh rate regardless of raw event rate.
test.describe('Split View — daf pinch-zoom does not layout-thrash on rapid touchmove', () => {
  test('20 rapid touchmove events coalesce to at most one or two real layout reads', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    await enterSplitView(page);

    await page.evaluate(() => {
      const scroll = document.getElementById('dafScroll');
      document.getElementById('vilnaPlaceholder').hidden = false;
      window.__rectCalls = 0;
      window.__origRect = Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect = function (...args) {
        if (this === scroll) window.__rectCalls++;
        return window.__origRect.apply(this, args);
      };
      const fire = (type, x1, y1, x2, y2) => {
        const t1 = new Touch({ identifier: 1, target: scroll, clientX: x1, clientY: y1 });
        const t2 = new Touch({ identifier: 2, target: scroll, clientX: x2, clientY: y2 });
        scroll.dispatchEvent(new TouchEvent(type, { touches: [t1, t2], bubbles: true, cancelable: true }));
      };
      fire('touchstart', 100, 100, 200, 200);
      for (let i = 0; i < 20; i++) fire('touchmove', 100 - i, 100 - i, 200 + i, 200 + i);
    });

    await page.waitForTimeout(300);
    const result = await page.evaluate(() => {
      Element.prototype.getBoundingClientRect = window.__origRect;
      return { rectCalls: window.__rectCalls, finalZoom: state.vilnaPageZoom };
    });

    expect(result.rectCalls).toBeLessThanOrEqual(2);
    // Correctness alongside the throttling: the LAST touch event's ratio is
    // still what wins, not some earlier, already-stale intermediate frame.
    expect(result.finalZoom).toBeGreaterThan(1);
  });
});

// The video pane stacks four absolutely-positioned layers inside
// .video-frame: the picture, the pinch-zoom surface (z-index 11), this
// pane's zoom buttons (12), and the player's own docked chrome -- the
// timeline (.scrubber-wrap, z-index 7) sitting directly on top of the
// control bar (z-index 6). Both of the Split View layers reserve room for
// that chrome by subtracting its height from their own bottom edge, and
// both originally subtracted only --pc-bar-h (the control bar) while the
// timeline lives ABOVE it, in its own --pc-timeline-h band. The timeline
// was therefore buried under the pinch surface: seeking did nothing at
// all, and because that surface reads a drag as a pan and a tap as
// tap-to-toggle-play, scrubbing made the video play or pause instead.
// Reported as the player freezing after pressing things on the control bar.
test.describe('Split View — its overlays never cover the player chrome', () => {
  test('neither the pinch surface nor the zoom buttons overlap the timeline or the control bar', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    await enterSplitView(page);

    const bands = await page.evaluate(() => {
      const box = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom };
      };
      return {
        pinch: box('#splitVideoPinchSurface'),
        zoom: box('#splitVideoZoomControls'),
        scrubber: box('.scrubber-wrap'),
        controls: box('.player-controls'),
      };
    });

    const overlaps = (a, b) => a.top < b.bottom && b.top < a.bottom;
    for (const [overlayName, overlay] of [['pinch surface', bands.pinch], ['zoom buttons', bands.zoom]]) {
      for (const [chromeName, chrome] of [['the timeline', bands.scrubber], ['the control bar', bands.controls]]) {
        expect(overlaps(overlay, chrome), `${overlayName} overlaps ${chromeName}`).toBe(false);
      }
    }
  });

  // On a YouTube shiur the picture is a cross-origin iframe, and an iframe
  // that reaches under the docked chrome is a different kind of surface from
  // the HTML drawn over it: the page's own hit-testing puts the bar on top,
  // but touch on a phone is routed by the compositor, which hands it to the
  // embedded frame's process instead. Reported as the bar below the seek bar
  // taking no touches at all while the Split View bar at the top of the
  // screen -- fixed OUTSIDE .video-frame, so never over the iframe -- kept
  // working. The overlap itself is what has to go.
  test('the video picture stops above the timeline and control bar, never under them', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    await enterSplitView(page);

    const bands = await page.evaluate(() => {
      // Stand the YouTube host up the way a real shiur does -- it is hidden
      // whenever the page has no YouTube video, which is exactly the state
      // that hid this bug from every earlier check.
      document.getElementById('youtubePlayerHost').hidden = false;
      const box = (sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; };
      return {
        video: box('#video'),
        host: box('#youtubePlayerHost'),
        scrubber: box('.scrubber-wrap'),
        controls: box('.player-controls'),
      };
    });

    const overlaps = (a, b) => a.top < b.bottom && b.top < a.bottom;
    for (const [pictureName, picture] of [['the <video>', bands.video], ['the YouTube host', bands.host]]) {
      for (const [chromeName, chrome] of [['the timeline', bands.scrubber], ['the control bar', bands.controls]]) {
        expect(overlaps(picture, chrome), `${pictureName} reaches under ${chromeName}`).toBe(false);
      }
    }
  });

  // An identity transform still promotes the element to its own composited
  // layer, and on a YouTube shiur that element is a cross-origin iframe
  // whose video the browser composites itself -- a known way for that video
  // to stop updating on mobile while the rest of the page keeps working.
  // Nothing needs the transform until a reader actually zooms.
  test('no transform is applied to the video until it is actually zoomed', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    await enterSplitView(page);

    const atRest = await page.evaluate(() => getComputedStyle(document.getElementById('video')).transform);
    expect(atRest).toBe('none');

    await page.click('#splitVideoZoomInButton');
    await expect.poll(() => page.evaluate(() => state.splitVideoZoom)).toBeGreaterThan(1);
    const zoomed = await page.evaluate(() => getComputedStyle(document.getElementById('video')).transform);
    expect(zoomed).not.toBe('none');

    await page.click('#splitVideoZoomResetButton');
    await expect.poll(() => page.evaluate(() => state.splitVideoZoom)).toBe(1);
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.getElementById('video')).transform)).toBe('none');
  });

  // With the row shifted off the frame's top edge and its own gradient
  // dropped, the span between its two pill groups is empty -- and it sits
  // above the pinch surface, so it must not intercept presses there.
  test('the video topbar only takes presses on its own controls, not the gap between them', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    await enterSplitView(page);

    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.player-topbar')).pointerEvents)).toBe('none');
    expect(await page.evaluate(() => getComputedStyle(document.getElementById('playerDafButton').parentElement).pointerEvents)).toBe('auto');
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
