import { test, expect } from '@playwright/test';
import { preparePage } from '../support/harness.mjs';

// The video player's control bar auto-hides (app.js: showVideoControls /
// CONTROLS_AUTO_HIDE_MS), and until this file nothing covered what that does
// to a reader who is trying to press something on it.
//
// The bug these cover was reported again and again as "the 1x button
// does nothing", and survived three fixes aimed at the button itself,
// because the button was never the problem:
//   #126 -- the pill's hit area (a wrapper bigger than the <select> it wrapped)
//   #127 -- the bar itself fading out from under a pointer resting on it
//   #128 -- a native <select> opening its picker on pointerdown, which the
//           wake layer swallowed, rather than on the click that followed
// Each held up in this repo's own tests and in a real Chromium build, and
// none of them was what the reporter kept seeing on their own Android
// phone. #speedSelect was replaced outright with a plain button and a
// listbox this page draws itself (see its construction in player-chrome.js)
// specifically because no automated check anywhere -- headless Chromium
// does not render a native popup at all -- could ever have confirmed the
// fourth attempt either.
//
// These drive a REAL pointer and a REAL press. speed.spec.mjs drives the
// control programmatically (a scripted .click()), which is why a whole spec
// file for this control could stay green through every one of those first
// three reports: a scripted click neither waits nor hit-tests the way a
// reader's own press does.

const hideDelay = (page) => page.evaluate(() => CONTROLS_AUTO_HIDE_MS);
const barHidden = (page) => page.evaluate(() => document.getElementById('videoFrame').classList.contains('controls-hidden'));

async function openPlayer(page) {
  await preparePage(page, { user: null });
  await page.goto('/watch/?ref=Chullin%2089a');
  await expect(page.locator('#speedSelect')).toBeAttached();
  return page.evaluate(() => {
    // #speedSelect's own rect, not a wrapper's -- there is no separate
    // wrapper any more (see speed.spec.mjs's "one element, not a pill
    // around a smaller one").
    const r = document.getElementById('speedSelect').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
}

test.describe('Video player -- the control bar does not fade out from under a press', () => {
  test('a control the reader takes a moment to aim at is still pressable', async ({ page }) => {
    const pill = await openPlayer(page);
    const delay = await hideDelay(page);

    // Move onto the speed pill and then STOP, the way someone does while
    // reading what the rate currently says. No further mousemove is
    // generated from here on -- that is the whole point.
    await page.mouse.move(pill.x, pill.y);
    await page.waitForTimeout(delay + 600);

    // Before #127's fix the bar was hidden by now and the pill's own screen
    // position belonged to .player-wake-layer.
    expect(await barHidden(page)).toBe(false);
    await expect
      .poll(() => page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id, pill))
      .toBe('speedSelect');

    // And the press reaches the button rather than being spent waking the
    // bar -- provably so, unlike the native <select> this replaced: a real
    // click on a real button opens a real, scriptable listbox, so this can
    // assert the menu actually opened rather than only that focus moved
    // somewhere plausible.
    await page.mouse.down();
    await page.mouse.up();
    expect(await page.locator('#speedMenu').isHidden()).toBe(false);
    expect(await page.locator('#speedSelect').getAttribute('aria-expanded')).toBe('true');
  });

  test('an open speed menu is not dismissed by the bar fading behind it', async ({ page }) => {
    const pill = await openPlayer(page);
    const delay = await hideDelay(page);

    // Opening the menu sets #speedSelect's own aria-expanded="true", which
    // controlsShouldStayVisible (app.js) checks directly -- unlike the old
    // native <select>, there is no browser-owned popup here for the bar
    // fading underneath to silently dismiss, but the menu still must not be
    // stranded over a bar that has visually gone.
    await page.mouse.move(pill.x, pill.y);
    await page.mouse.down();
    await page.mouse.up();
    expect(await page.locator('#speedSelect').getAttribute('aria-expanded')).toBe('true');

    // Move the pointer off the bar entirely, so the "pointer resting on it"
    // guard is NOT what is being measured here -- aria-expanded alone is.
    const away = await page.evaluate(() => {
      const r = document.getElementById('videoFrame').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + 20 };
    });
    await page.mouse.move(away.x, away.y);

    await page.waitForTimeout(delay + 600);
    expect(await barHidden(page)).toBe(false);
    expect(await page.locator('#speedMenu').isHidden()).toBe(false);
  });

  test('the bar still auto-hides once the pointer is off it', async ({ page }) => {
    const pill = await openPlayer(page);
    const delay = await hideDelay(page);

    await page.mouse.move(pill.x, pill.y);
    await page.waitForTimeout(delay + 400);
    expect(await barHidden(page)).toBe(false);

    // Off the bar and onto the video itself. Keeping the bar up is meant to
    // last exactly as long as the pointer is on it -- the timer re-arms
    // rather than being abandoned, so leaving hides the bar without needing
    // any further movement to prompt it.
    const away = await page.evaluate(() => {
      const r = document.getElementById('videoFrame').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + 20 };
    });
    await page.mouse.move(away.x, away.y);
    await page.waitForTimeout(delay + 600);

    expect(await barHidden(page)).toBe(true);
  });

  test('a touch on the bar does not pin it open', async ({ page }) => {
    const pill = await openPlayer(page);
    const delay = await hideDelay(page);

    // On a touchscreen the hover/pointerover state sticks wherever the last
    // tap landed, so honouring touch in the "pointer is resting on the bar"
    // guard would keep the bar up for good after any tap on it. Touch has no
    // resting pointer to be robbed of a press in the first place, so it keeps
    // the plain timeout behaviour.
    await page.evaluate(({ x, y }) => {
      // touchstart on the frame is what arms the hide timeout on a touch
      // device (nothing else has, here -- no mouse has been over the frame).
      document.getElementById('videoFrame').dispatchEvent(new TouchEvent('touchstart', { bubbles: true }));
      const target = document.elementFromPoint(x, y);
      target.dispatchEvent(new PointerEvent('pointerover', { pointerType: 'touch', bubbles: true, clientX: x, clientY: y }));
    }, pill);
    await page.waitForTimeout(delay + 600);

    expect(await barHidden(page)).toBe(true);
  });
});

// The touch path, which had no coverage at all until the same bug was
// reported a fifth time -- from an Android phone, where the two symptoms
// were "most times nothing happens at all" and "sometimes something pops up
// for a split second and vanishes before I can even see what it was." Both
// came from a NATIVE <select>'s picker opening on pointerdown, which the
// wake layer swallowed while the bar was hidden, and from the bar then
// fading again out from under a picker that briefly did open.
//
// #speedSelect is a plain <button> now, and a button activates on CLICK --
// exactly what every other control in this bar already did, and exactly
// what was never affected by any of this. The one thing worth proving here
// is that a tap on the FADED bar wakes it and opens the menu in the SAME
// gesture: pointerdown/touchstart reach .player-wake-layer first (which
// removes .controls-hidden synchronously), and the click that follows is
// hit-tested fresh against the now-visible, now-interactive button --
// unlike a native picker, which only ever asked to open on the pointerdown
// that the wake layer had already spent.
test.describe('Video player -- the speed menu opens from a touch that also wakes the bar', () => {
  test.skip(({ hasTouch }) => !hasTouch, 'touch-only: the desktop project has no touchscreen');

  async function openPlayerForTouch(page) {
    await preparePage(page, { user: null });
    await page.goto('/watch/?ref=Chullin%2089a');
    await expect(page.locator('#speedSelect')).toBeAttached();
    return page.evaluate(() => {
      const f = document.getElementById('videoFrame').getBoundingClientRect();
      const r = document.getElementById('speedSelect').getBoundingClientRect();
      return {
        video: { x: Math.round(r.left + r.width / 2), y: Math.round(f.top + (f.bottom - f.top) * 0.3) },
        pill: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) },
      };
    });
  }

  test('a tap on the faded bar wakes it and opens the menu in one gesture', async ({ page }) => {
    const geo = await openPlayerForTouch(page);
    const delay = await hideDelay(page);

    // Tap the video, then leave it alone long enough for the bar to fade --
    // the ordinary case on a phone, where reading the daf between taps is
    // exactly what uses up the timeout.
    await page.touchscreen.tap(geo.video.x, geo.video.y);
    await page.waitForTimeout(delay + 600);
    expect(await barHidden(page)).toBe(true);

    await page.touchscreen.tap(geo.pill.x, geo.pill.y);

    expect(await barHidden(page)).toBe(false);
    expect(await page.locator('#speedMenu').isHidden()).toBe(false);
    expect(await page.locator('#speedSelect').getAttribute('aria-expanded')).toBe('true');
  });

  test('choosing a rate from that same menu still applies it', async ({ page }) => {
    const geo = await openPlayerForTouch(page);
    const delay = await hideDelay(page);

    await page.touchscreen.tap(geo.video.x, geo.video.y);
    await page.waitForTimeout(delay + 600);
    await page.touchscreen.tap(geo.pill.x, geo.pill.y);

    await page.locator('#speedMenu li[data-value="1.5"]').tap();

    expect(await page.locator('#speedMenu').isHidden()).toBe(true);
    expect(await page.locator('#speedSelect').getAttribute('value')).toBe('1.5');
    expect(await page.evaluate(() => document.getElementById('video').playbackRate)).toBe(1.5);
  });

  test('the bar does not fade back out from behind the open menu', async ({ page }) => {
    const geo = await openPlayerForTouch(page);
    const delay = await hideDelay(page);

    await page.touchscreen.tap(geo.video.x, geo.video.y);
    await page.waitForTimeout(delay + 600);
    await page.touchscreen.tap(geo.pill.x, geo.pill.y);
    expect(await page.locator('#speedMenu').isHidden()).toBe(false);

    // aria-expanded, not focus-visible or any other heuristic about HOW the
    // press arrived -- see controlsShouldStayVisible (app.js). Reported as
    // the menu "popping up for a split second and vanishing before I can
    // even see what it was" against the old native picker; that whole class
    // of heuristic is gone along with the picker it existed to cover for.
    await page.waitForTimeout(delay + 600);
    expect(await barHidden(page)).toBe(false);
    expect(await page.locator('#speedMenu').isHidden()).toBe(false);
  });

  test('a tap that lands on the button while the bar is already up just toggles the menu once', async ({ page }) => {
    const geo = await openPlayerForTouch(page);

    expect(await barHidden(page)).toBe(false);
    await page.touchscreen.tap(geo.pill.x, geo.pill.y);
    expect(await page.locator('#speedMenu').isHidden()).toBe(false);

    // A second tap on the button (not an option, not outside) closes it --
    // ordinary toggle behaviour, the same as every other menu button in
    // this bar (the daf picker, "More", the tools overflow tray).
    await page.touchscreen.tap(geo.pill.x, geo.pill.y);
    expect(await page.locator('#speedMenu').isHidden()).toBe(true);
  });
});
