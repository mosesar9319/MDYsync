import { test, expect } from '@playwright/test';
import { preparePage } from '../support/harness.mjs';

// The video player's control bar auto-hides (app.js: showVideoControls /
// CONTROLS_AUTO_HIDE_MS), and until this file nothing covered what that does
// to a reader who is trying to press something on it.
//
// The bug these cover was reported three separate times as "the 1x button
// does nothing", and survived two fixes aimed at the button itself, because
// the button was never the problem. mousemove over the frame was the only
// thing that re-armed the hide timeout, and a mouse RESTING on a control
// generates no mousemove -- so aiming at one for longer than the timeout
// faded .player-controls to opacity:0/pointer-events:none with the pointer
// still parked on it. The press then landed on .player-wake-layer (live
// exactly while the controls are hidden) and did nothing but bring the bar
// back. Every control had the same dead first press; the speed pill is where
// it got noticed, because reading what the rate currently says is what costs
// the seconds, and a menu that never opens reads as a broken button in a way
// a play button that "just needed another click" does not.
//
// These drive a REAL pointer and a REAL press. The rest of speed.spec.mjs
// drives the <select> programmatically, which is why a whole spec file for
// this control could stay green through all of it: a scripted selectOption
// neither waits nor hit-tests, so it cannot see a bar that has gone.

const hideDelay = (page) => page.evaluate(() => CONTROLS_AUTO_HIDE_MS);
const barHidden = (page) => page.evaluate(() => document.getElementById('videoFrame').classList.contains('controls-hidden'));

async function openPlayer(page) {
  await preparePage(page, { user: null });
  await page.goto('/watch/?ref=Chullin%2089a');
  await expect(page.locator('#speedSelect')).toBeAttached();
  return page.evaluate(() => {
    const r = document.getElementById('speedSelect').closest('.pc-speed').getBoundingClientRect();
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

    // Before the fix the bar was hidden by now and the pill's own screen
    // position belonged to .player-wake-layer.
    expect(await barHidden(page)).toBe(false);
    await expect
      .poll(() => page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id, pill))
      .toBe('speedSelect');

    // And the press reaches the select rather than being spent waking the bar.
    await page.mouse.down();
    await page.mouse.up();
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('speedSelect');
  });

  test('an open speed menu is not dismissed by the bar fading behind it', async ({ page }) => {
    const pill = await openPlayer(page);
    const delay = await hideDelay(page);

    // A native <select> popup takes the pointer while it is up, so the page
    // sees no mousemove for as long as the reader is choosing -- and the bar
    // hiding underneath is what made the browser dismiss the popup mid-choice.
    await page.mouse.move(pill.x, pill.y);
    await page.mouse.down();
    await page.mouse.up();
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('speedSelect');

    // Move the pointer off the bar so the "pointer resting on it" guard is
    // NOT what is being measured here -- this leaves focus alone to hold the
    // bar open, which is the part that keeps an open popup alive. Chrome
    // reports a mouse-clicked <select> as :focus-visible, unlike a
    // mouse-clicked <button>, which is why the guard is focus-visible rather
    // than bare activeElement: on the latter every click on the bar would
    // pin it open for good. Assert that distinction here rather than trust it.
    const away = await page.evaluate(() => {
      const r = document.getElementById('videoFrame').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + 20 };
    });
    await page.mouse.move(away.x, away.y);
    expect(await page.evaluate(() => {
      const sel = document.getElementById('speedSelect');
      return document.activeElement === sel && sel.matches(':focus-visible');
    })).toBe(true);

    await page.waitForTimeout(delay + 600);
    expect(await barHidden(page)).toBe(false);
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
// reported a fifth time -- from an Android phone, where the two symptoms were
// "most times nothing happens at all" and "sometimes something pops up for a
// split second and vanishes before I can even see what it was."
//
// Both come from the bar having auto-hidden, and the speed control is the one
// thing in the bar that does not survive it. A native <select> opens its
// picker on POINTERDOWN; while the controls are hidden that pointerdown
// belongs to .player-wake-layer, which spends it bringing the bar back, and
// only the click that follows reaches the select. Traced in order:
//     pointerdown -> DIV.player-wake-layer
//     touchstart  -> DIV.player-wake-layer
//     click       -> SELECT#speedSelect
// The select ends up focused with no menu. Every button in the bar activates
// on that same click and so was never affected -- which is exactly why the
// speed pill alone kept getting reported.
//
// A phone has no hover to hold the bar open, so once it has faded nearly
// every press arrives this way. That is the whole reason the previous fix,
// which keeps the bar alive under a resting MOUSE, did nothing here.
test.describe('Video player -- the speed menu opens from a touch that also wakes the bar', () => {
  test.skip(({ hasTouch }) => !hasTouch, 'touch-only: the desktop project has no touchscreen');

  // showPicker() opening a native menu is not observable from script, so
  // count the call itself rather than assert on something invisible.
  const countPickerCalls = (page) => page.evaluate(() => {
    const sel = document.getElementById('speedSelect');
    window.__pickerCalls = 0;
    const real = sel.showPicker.bind(sel);
    sel.showPicker = () => { window.__pickerCalls++; try { real(); } catch { /* headless */ } };
  });
  const pickerCalls = (page) => page.evaluate(() => window.__pickerCalls);

  async function openPlayerForTouch(page) {
    await preparePage(page, { user: null });
    await page.goto('/watch/?ref=Chullin%2089a');
    await expect(page.locator('#speedSelect')).toBeAttached();
    await countPickerCalls(page);
    return page.evaluate(() => {
      const f = document.getElementById('videoFrame').getBoundingClientRect();
      const r = document.getElementById('speedSelect').closest('.pc-speed').getBoundingClientRect();
      return {
        video: { x: Math.round(r.left + r.width / 2), y: Math.round(f.top + (f.bottom - f.top) * 0.3) },
        pill: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) },
      };
    });
  }

  test('a tap on the faded bar opens the speed menu instead of only waking it', async ({ page }) => {
    const geo = await openPlayerForTouch(page);
    const delay = await hideDelay(page);

    // Tap the video, then leave it alone long enough for the bar to fade --
    // the ordinary case on a phone, where reading the daf between taps is
    // exactly what uses up the timeout.
    await page.touchscreen.tap(geo.video.x, geo.video.y);
    await page.waitForTimeout(delay + 600);
    expect(await barHidden(page)).toBe(true);

    await page.touchscreen.tap(geo.pill.x, geo.pill.y);

    expect(await pickerCalls(page)).toBe(1);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('speedSelect');
  });

  test('the bar does not fade back out from behind the open menu', async ({ page }) => {
    const geo = await openPlayerForTouch(page);
    const delay = await hideDelay(page);

    await page.touchscreen.tap(geo.video.x, geo.video.y);
    await page.waitForTimeout(delay + 600);
    await page.touchscreen.tap(geo.pill.x, geo.pill.y);

    // A native picker takes the touch while it is up, so nothing re-arms the
    // timeout while the reader is choosing. The bar hiding underneath is what
    // the browser treats as reason to dismiss the picker.
    //
    // Honest caveat: this one passes with or without the guard it covers,
    // because emulated Chromium reports a TAPPED <select> as :focus-visible
    // and the older focus-visible test therefore already held the bar. It is
    // here because that heuristic is not something to depend on -- Chrome
    // does not promise focus-visible for pointer-initiated focus, the
    // reporter saw the menu "pop up for a split second and vanish" on a real
    // Android device, and a <select> is held open on plain focus now for
    // that reason. Treat this as a guard on the rule, not a reproduction of
    // the failure.
    await page.waitForTimeout(delay + 600);
    expect(await barHidden(page)).toBe(false);
  });

  test('a tap the select receives directly is not toggled shut again', async ({ page }) => {
    const geo = await openPlayerForTouch(page);

    // Bar already up, so the pointerdown reaches the select and the browser
    // opens the picker itself. Calling showPicker on the click after that
    // would shut the menu the reader just opened.
    expect(await barHidden(page)).toBe(false);
    await page.touchscreen.tap(geo.pill.x, geo.pill.y);

    expect(await pickerCalls(page)).toBe(0);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('speedSelect');
  });
});
