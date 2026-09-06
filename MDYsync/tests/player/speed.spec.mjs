import { test, expect } from '@playwright/test';
import { preparePage, failOnPageError } from '../support/harness.mjs';

// The video/daf player's own playback-speed control -- reader-facing on
// every page that embeds it (player/, watch/, browse/, studio/), and covered
// nowhere else in this suite: everything else here is Notes/Cloud Chabura.
//
// #speedSelect is a plain <button> plus a listbox this file's page
// (player-chrome.js) draws and owns outright -- not a <select>. It was
// replaced outright after "the 1x button does nothing" kept being
// reported: each previous fix was a real defect in getting a press through
// to a NATIVE <select>'s own picker (hit area, the control bar fading under
// a resting pointer, a picker opening on pointerdown rather than click on
// touch -- PRs #126/#127/#128) and each held up in this repo's own tests
// and in a real Chromium build -- yet the picker still would not reliably
// open on the reporting reader's own Android phone. See player-chrome.js's own
// comment on the button's construction for the full story; this file covers
// what a <select> replacement needs to keep proving.
//
// HTMLMediaElement.load() resets playbackRate to 1 -- confirmed directly
// against a real <video> element, not documented behaviour anyone would
// guess at a glance. app.js's YouTube video-switch path already re-applies
// the speed control's chosen rate right after cueVideoById; the direct-link
// and local-file paths did not, so a reader who had picked e.g. 1.5x had it
// silently reset to 1x on every new video or daf switch, with the control's
// own displayed value never changing to say so.
//
// setPlaybackRate/loadDirectVideoUrl/handleVideoFile are plain top-level
// function declarations in app.js, a classic (non-module) script -- calling
// them via window.* here reaches the exact same functions the UI's own
// buttons call, without needing to sign in as admin to reach the (desktop-
// only, admin-gated) direct-link/local-file controls in the DOM.

async function chooseSpeed(page, value) {
  await page.locator('#speedSelect').click();
  await page.locator(`#speedMenu li[data-value="${value}"]`).click();
}

test.describe('Video player -- playback speed survives a new video load', () => {
  test('a direct video link resyncs the chosen speed instead of leaving load()\'s silent reset in place', async ({ page }) => {
    const errors = [];
    failOnPageError(page, errors);
    await preparePage(page, { user: null });
    await page.goto('/browse/?ref=Chullin%2089a');
    await expect(page.locator('#speedSelect')).toBeAttached();

    await chooseSpeed(page, '1.5');
    await expect
      .poll(() => page.evaluate(() => document.getElementById('video').playbackRate))
      .toBe(1.5);

    // loadDirectVideoUrl calls htmlVideo.load(), which alone resets
    // playbackRate to 1 -- this needs no network fetch to actually succeed
    // to prove the point; it is a synchronous side effect of load() itself,
    // before anything arrives over the wire.
    await page.evaluate(() => window.loadDirectVideoUrl('https://example.invalid/a-shiur.mp4'));

    expect(await page.evaluate(() => document.getElementById('video').playbackRate)).toBe(1.5);
    // The control must still read what it actually reflects -- a rate that
    // is right but a label that now disagrees would be its own bug.
    expect(await page.locator('#speedSelect').getAttribute('value')).toBe('1.5');
    expect(await page.locator('#speedSelectValue').textContent()).toBe('1.5×');
    expect(errors).toEqual([]);
  });

  test('choosing a local video file resyncs the chosen speed the same way', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/browse/?ref=Chullin%2089a');
    await expect(page.locator('#speedSelect')).toBeAttached();

    await chooseSpeed(page, '0.75');
    await expect
      .poll(() => page.evaluate(() => document.getElementById('video').playbackRate))
      .toBe(0.75);

    await page.evaluate(() => {
      const file = new File(['not really a video, just proving load() fires'], 'shiur.mp4', { type: 'video/mp4' });
      window.handleVideoFile(file);
    });

    expect(await page.evaluate(() => document.getElementById('video').playbackRate)).toBe(0.75);
  });

  test('sanity: load() really does reset playbackRate on its own, so the fix above is not a no-op assertion', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/browse/?ref=Chullin%2089a');
    const result = await page.evaluate(() => {
      const v = document.getElementById('video');
      v.playbackRate = 1.5;
      const before = v.playbackRate;
      v.load();
      return { before, after: v.playbackRate };
    });
    expect(result).toEqual({ before: 1.5, after: 1 });
  });
});

// The very first report this control ever got, before any of the later
// ones: the rate had drifted (load() silently reset it, same as above) while
// the control's own label still read "1x" -- unchanged since page load --
// and picking "1x" again did nothing, because a native <select> fires no
// 'change' event at all when the option chosen is the one already shown.
// There was no event to listen for that would have caught this.
//
// The button's own click handler dispatches 'change' unconditionally on
// every pick, whatever the previous value was -- so this is fixed by the
// architecture itself, not by a special case for it.
test.describe('Video player -- picking the rate already shown still re-applies it', () => {
  test('reselecting the displayed value fires a real resync, not a no-op', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/browse/?ref=Chullin%2089a');
    await expect(page.locator('#speedSelect')).toBeAttached();

    // Simulate the drift directly, the same silent desync load() causes:
    // the control still shows its default "1x" (untouched since page load)
    // while the actual rate is something else.
    await page.evaluate(() => { document.getElementById('video').playbackRate = 1.5; });
    expect(await page.locator('#speedSelect').getAttribute('value')).toBe('1');

    await chooseSpeed(page, '1');

    expect(await page.evaluate(() => document.getElementById('video').playbackRate)).toBe(1);
  });
});

// Every other test in this file drives the control programmatically
// (chooseSpeed above), which is exactly why a whole spec file for this
// control could stay green through "the 1x button does nothing" being
// reported five times: a scripted click neither waits nor hit-tests the way
// a reader's own press does. tests/player/controls-autohide.spec.mjs is
// where the interaction with the auto-hiding bar itself -- the actual
// defect behind four of those five reports -- is covered with a real
// pointer and real waits.
//
// What belongs here instead is the one thing a wrapper-vs-inner-control
// size mismatch (#126's bug class) needs to be structurally impossible:
// there being no wrapper at all. #speedSelect is not a styled box around a
// smaller, separately-hit-tested <select> the way it used to be -- the
// visible pill and the clickable element are the same button, the same as
// every other control in this bar.
test.describe('Video player -- the speed control is one element, not a pill around a smaller one', () => {
  test('the whole visible pill, chevron included, is the button itself', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/watch/?ref=Chullin%2089a');
    await expect(page.locator('#speedSelect')).toBeAttached();

    const result = await page.evaluate(() => {
      const button = document.getElementById('speedSelect');
      // Not .pc-speed or any other wrapper -- stack() (player-chrome.js)
      // wraps every control in the bar the same way, for the icon/value +
      // caption layout, and that wrapper is bigger than the control on
      // purpose (it also holds the "Speed" caption underneath). The
      // pressable BOX is the button's own rect, not the stack's.
      const r = button.getBoundingClientRect();
      const points = {
        center: [r.left + r.width / 2, r.top + r.height / 2],
        chevron: [r.right - 4, r.top + r.height / 2],
        nearTop: [r.left + r.width / 2, r.top + 2],
        nearBottom: [r.left + r.width / 2, r.bottom - 2],
        leftOfValue: [r.left + 4, r.top + r.height / 2],
      };
      const misses = [];
      for (const [name, [x, y]] of Object.entries(points)) {
        if (document.elementFromPoint(x, y) !== button) misses.push(name);
      }
      return { misses, wrapperClass: button.parentElement.className };
    });

    expect(result.misses).toEqual([]);
    // Confirms the premise above -- stack()'s own wrapper, not a
    // control-specific one a future edit could accidentally resize wrong.
    expect(result.wrapperClass).toBe('pc-stack');
  });

  // The button's markup ORIGINALLY gave it aria-labelledby="speedControlCaption
  // speedSelectValue", reusing the "Speed" caption already sitting next to it
  // in .video-settings-body's own fallback layout -- reasonable-looking, and
  // silently wrong: only the BUTTON moves into the bar (stack() above), not
  // the wrapper it currently sits in, and the leftover wrapper -- caption
  // included -- is exactly what $('videoSettings')?.querySelector('.speed-
  // control')?.remove() cleans up a few lines later. That left
  // aria-labelledby pointing at an id that no longer existed anywhere in the
  // document, degrading the accessible name to just "1x" with no indication
  // of what the control even was. Every other control in this same bar (PiP,
  // Captions, Settings, Fullscreen) already gives itself a direct aria-label
  // rather than relying on an external element, for what turns out to be
  // exactly this reason.
  test('the accessible name does not depend on an element that gets cleaned up out from under it', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/watch/?ref=Chullin%2089a');
    await expect(page.locator('#speedSelect')).toBeAttached();

    expect(await page.evaluate(() => document.getElementById('speedControlCaption'))).toBeNull();
    expect(await page.locator('#speedSelect').getAttribute('aria-labelledby')).toBeNull();
    expect(await page.locator('#speedSelect').getAttribute('aria-label')).toBe('Playback speed, 1×');
  });
});

// The listbox itself: opening, choosing, keyboard use, and backing out
// without choosing. None of this is native-<select> behaviour any more --
// it's a button plus a role="listbox" this file's page draws and owns, so
// none of it can be taken for granted just because it "looks like" a
// dropdown.
test.describe('Video player -- the speed menu', () => {
  test('lists every rate, marks the current one, and opens/closes on the button', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/watch/?ref=Chullin%2089a');
    await expect(page.locator('#speedSelect')).toBeAttached();

    expect(await page.locator('#speedMenu').isHidden()).toBe(true);
    expect(await page.locator('#speedSelect').getAttribute('aria-expanded')).toBe('false');

    await page.locator('#speedSelect').click();

    expect(await page.locator('#speedMenu').isHidden()).toBe(false);
    expect(await page.locator('#speedSelect').getAttribute('aria-expanded')).toBe('true');
    await expect(page.locator('#speedMenu li')).toHaveCount(5);
    expect(await page.locator('#speedMenu li').allTextContents())
      .toEqual(['0.75×', '1×', '1.25×', '1.5×', '2×']);
    expect(await page.locator('#speedMenu li[data-value="1"]').getAttribute('aria-selected')).toBe('true');
    expect(await page.locator('#speedMenu li[data-value="1.5"]').getAttribute('aria-selected')).toBe('false');

    // Clicking the button again closes it without choosing anything.
    await page.locator('#speedSelect').click();
    expect(await page.locator('#speedMenu').isHidden()).toBe(true);
    expect(await page.evaluate(() => document.getElementById('video').playbackRate)).toBe(1);
  });

  test('choosing an option updates the rate, the label, aria-selected, and returns focus to the button', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/watch/?ref=Chullin%2089a');
    await expect(page.locator('#speedSelect')).toBeAttached();

    await chooseSpeed(page, '1.25');

    expect(await page.locator('#speedMenu').isHidden()).toBe(true);
    expect(await page.locator('#speedSelect').getAttribute('aria-expanded')).toBe('false');
    expect(await page.locator('#speedSelect').getAttribute('value')).toBe('1.25');
    expect(await page.locator('#speedSelectValue').textContent()).toBe('1.25×');
    expect(await page.evaluate(() => document.getElementById('video').playbackRate)).toBe(1.25);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('speedSelect');
    // Not aria-labelledby pointing at a caption span that no longer exists
    // by this point (see the next test) -- a direct, self-contained label,
    // updated to say what it now announces.
    expect(await page.locator('#speedSelect').getAttribute('aria-label')).toBe('Playback speed, 1.25×');

    // Reopening highlights the NEWLY current rate, not whatever was first.
    await page.locator('#speedSelect').click();
    expect(await page.locator('#speedMenu li[data-value="1.25"]').getAttribute('aria-selected')).toBe('true');
    expect(await page.locator('#speedMenu li[data-value="1"]').getAttribute('aria-selected')).toBe('false');
  });

  test('clicking outside closes the menu without changing anything', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/watch/?ref=Chullin%2089a');
    await expect(page.locator('#speedSelect')).toBeAttached();

    await page.locator('#speedSelect').click();
    await page.mouse.click(20, 20);

    expect(await page.locator('#speedMenu').isHidden()).toBe(true);
    expect(await page.evaluate(() => document.getElementById('video').playbackRate)).toBe(1);
  });

  test('keyboard: Enter opens it, arrows move the highlighted option, Enter chooses it', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/watch/?ref=Chullin%2089a');
    await expect(page.locator('#speedSelect')).toBeAttached();

    await page.locator('#speedSelect').focus();
    await page.keyboard.press('Enter');
    expect(await page.locator('#speedMenu').isHidden()).toBe(false);
    // Opens with the CURRENT rate highlighted, not the first option.
    expect(await page.evaluate(() => document.getElementById('speedMenu').getAttribute('aria-activedescendant')))
      .toBe('speedOption-1');

    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => document.getElementById('speedMenu').getAttribute('aria-activedescendant')))
      .toBe('speedOption-1.5');

    await page.keyboard.press('Enter');
    expect(await page.locator('#speedMenu').isHidden()).toBe(true);
    expect(await page.locator('#speedSelect').getAttribute('value')).toBe('1.5');
    expect(await page.evaluate(() => document.getElementById('video').playbackRate)).toBe(1.5);
    // Chosen via keyboard, so focus was never sent anywhere else to return from.
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('speedSelect');
  });

  test('keyboard: Escape backs out without choosing, and returns focus to the button', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/watch/?ref=Chullin%2089a');
    await expect(page.locator('#speedSelect')).toBeAttached();

    await page.locator('#speedSelect').focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Escape');

    expect(await page.locator('#speedMenu').isHidden()).toBe(true);
    expect(await page.locator('#speedSelect').getAttribute('value')).toBe('1');
    expect(await page.evaluate(() => document.getElementById('video').playbackRate)).toBe(1);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('speedSelect');
  });
});
