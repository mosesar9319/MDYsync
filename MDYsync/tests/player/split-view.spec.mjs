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
    // The fixture's "No segments found" error (see this file's own header
    // comment) re-throws on this second entry too, showing the sitewide
    // banner again -- now sitting in the same top strip as the merged bar's
    // exit button, where the standalone toolbar's own lower position used
    // to keep it clear. Dismissed the same way enterSplitView() already
    // does for the first entry.
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

// The video pane stacks several absolutely-positioned layers inside
// .video-frame: the topbar (z-index 7), the picture, the pinch-zoom
// surface (11), this pane's own zoom buttons (12), and the player's own
// docked chrome -- the timeline (.scrubber-wrap, z-index 7) sitting
// directly on top of the control bar (z-index 6). The pinch surface and
// zoom buttons only carved room for the control bar out of their own
// bottom edge, leaving the timeline (which lives ABOVE the control bar, in
// its own --pc-timeline-h band) buried underneath: seeking did nothing at
// all, and because the pinch surface reads a drag as a pan and a tap as
// tap-to-toggle-play, a scrub attempt played or paused the video instead
// of seeking -- reported as "the seek bar doesn't work" and "the video
// pauses/plays when tapping anywhere". The pinch surface's top edge (0)
// also sat above the topbar's own z-index, silently swallowing its daf
// picker/bookmark/notes/more buttons the same way.
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

  test('the seek bar actually receives clicks in Split View, instead of the pinch surface swallowing them', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    await enterSplitView(page);
    // The fixture's own "No segments found" error (see this file's header
    // comment) can throw asynchronously, after enterSplitView()'s own
    // dismiss already ran -- defended against the same way a second entry
    // elsewhere in this file is.
    await dismissErrorBanner(page);

    const elAtScrubberCenter = await page.evaluate(() => {
      const scrubber = document.querySelector('.scrubber-wrap');
      const r = scrubber.getBoundingClientRect();
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return el?.closest('.scrubber-wrap') != null;
    });
    expect(elAtScrubberCenter).toBe(true);
  });

  test("the video topbar's own buttons receive clicks, instead of the pinch surface swallowing them", async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    await enterSplitView(page);
    await dismissErrorBanner(page);

    const elAtDafButton = await page.evaluate(() => {
      const btn = document.getElementById('playerDafButton');
      const r = btn.getBoundingClientRect();
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return el?.closest('#playerDafButton') != null;
    });
    expect(elAtDafButton).toBe(true);
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
});

// The daf pane sits flush against the video (no card padding/background/
// border of its own), and the standalone Split View toolbar is merged into
// the prominent mode selector as one combined bar that auto-hides on
// inactivity and reappears on interaction -- the second attempt at the
// feature this repo shipped, after the first one froze real devices. The
// key architectural difference from the first attempt: the reveal
// listeners are scoped to the daf pane and the bar itself, never the whole
// document, and specifically never the video's own control bar, which
// already has its own separate auto-hide system -- the first attempt's
// listening globally meant every tap on THAT bar (speed, captions,
// settings, ...) also retriggered this bar's own class churn, compounding
// whatever was actually happening on a real device when those exact
// buttons froze the page.
test.describe('Split View — the daf pane is flush, and the combined bar auto-hides safely', () => {
  test('the daf pane has no card padding/background/border of its own in Split View', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    await enterSplitView(page);

    const style = await page.evaluate(() => {
      const cs = getComputedStyle(document.querySelector('.daf-card'));
      return { padding: cs.padding, background: cs.backgroundColor, border: cs.borderWidth, boxShadow: cs.boxShadow };
    });
    expect(style.padding).toBe('0px');
    expect(style.background).toBe('rgba(0, 0, 0, 0)');
    expect(style.border).toBe('0px');
    expect(style.boxShadow).toBe('none');
  });

  test('the standalone Split View toolbar is merged into the prominent mode selector, with a divider', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    await enterSplitView(page);

    const merged = await page.evaluate(() => {
      const toolbar = document.getElementById('splitToolbar');
      const select = document.getElementById('viewerModeSelect');
      return {
        toolbarParentIsSelect: toolbar?.parentElement === select,
        hasDivider: !!select?.querySelector('.viewer-mode-bar-divider'),
      };
    });
    expect(merged.toolbarParentIsSelect).toBe(true);
    expect(merged.hasDivider).toBe(true);
  });

  test('the combined bar auto-hides after inactivity, and only the daf pane or the bar itself bring it back -- never the video control bar', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    await enterSplitView(page);

    await expect.poll(() => page.evaluate(() => document.body.classList.contains('split-chrome-hidden')), {
      timeout: 4000,
    }).toBe(true);

    // The video's own control bar must NOT bring it back -- that bar has
    // its own, separate auto-hide/reveal system, and this one has nothing
    // to do with it.
    await page.evaluate(() => {
      document.querySelector('.player-controls').dispatchEvent(new Event('touchstart', { bubbles: true }));
    });
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => document.body.classList.contains('split-chrome-hidden'))).toBe(true);

    // The daf pane -- the one place in Split View this bar's absence isn't
    // covered by anything else -- must bring it back.
    await page.evaluate(() => {
      document.querySelector('.daf-card').dispatchEvent(new Event('touchstart', { bubbles: true }));
    });
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => document.body.classList.contains('split-chrome-hidden'))).toBe(false);
  });

  test('a keyboard Tab into the page still brings the bar back, even from outside the player/daf area', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    await enterSplitView(page);

    await expect.poll(() => page.evaluate(() => document.body.classList.contains('split-chrome-hidden')), {
      timeout: 4000,
    }).toBe(true);

    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })));
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => document.body.classList.contains('split-chrome-hidden'))).toBe(false);
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
