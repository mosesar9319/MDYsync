import { test, expect } from '@playwright/test';
import { preparePage } from '../support/harness.mjs';

// "Select this word" / "Select whole phrase" -- two new context-menu items
// that start a Select-text selection directly from a right-click/long-press,
// instead of requiring the toolbar's Select text toggle first. Covers three
// layers: the selection engine itself (selectVilnaWord/selectVilnaPhrase in
// app.js), that the "now playing" blue highlight defers to an active
// selection over the same words (reported directly: "Select whole phrase"
// should replace the phrase's blue sync highlight with the yellow selection
// highlight for as long as it's selected), and the menu wiring
// (daf-context-menu.js) that reaches them from the literal word under the
// pointer -- not whatever a pre-existing selection had already widened the
// menu's own target to (see vilnaTargetAt's own `word` field).

function pageMapFixture() {
  const boxes = [];
  const row = (ref, y, count, startIndex = 0) => {
    for (let i = 0; i < count; i += 1) {
      boxes.push({ ref, wordIndex: startIndex + i, x: 0.8 - i * 0.15, y, w: 0.1, h: 0.02 });
    }
  };
  row('Chullin 89a.1', 0.10, 5); // indices 0..4
  row('Chullin 89a.2', 0.20, 4); // a second ref, indices 0..3
  return { wordBoxes: boxes };
}

async function seed(page, { segments = [] } = {}) {
  await page.evaluate(({ map, segments }) => {
    state.vilnaPageMap = map;
    state.textSelection = null;
    state.vilnaSelectTextMode = false;
    state.segments = segments;
    state.activeIndex = -1;
    switchDafView('page');
  }, { map: pageMapFixture(), segments });
}

test.describe('selectVilnaWord / selectVilnaPhrase — the selection engine', () => {
  test.beforeEach(async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/browse/');
  });

  test('selectVilnaWord selects only that word and enters select-text mode', async ({ page }) => {
    await seed(page);
    const result = await page.evaluate(() => {
      selectVilnaWord('Chullin 89a.1', 2);
      return { mode: state.vilnaSelectTextMode, runs: state.textSelection.runs };
    });
    expect(result.mode).toBe(true);
    expect(result.runs).toEqual([{ ref: 'Chullin 89a.1', start: 2, end: 2 }]);
  });

  test('selectVilnaWord replaces an existing selection instead of extending it', async ({ page }) => {
    await seed(page);
    const runs = await page.evaluate(() => {
      extendTextSelection('Chullin 89a.1', 0);
      extendTextSelection('Chullin 89a.1', 3); // selection now spans 0..3
      selectVilnaWord('Chullin 89a.1', 4);      // must NOT grow to 0..4
      return state.textSelection.runs;
    });
    expect(runs).toEqual([{ ref: 'Chullin 89a.1', start: 4, end: 4 }]);
  });

  test('selectVilnaWord builds the interactive word-target overlay so a drag can extend it', async ({ page }) => {
    await seed(page);
    await page.evaluate(() => selectVilnaWord('Chullin 89a.1', 2));
    await expect(page.locator('.vilna-select-text-word-target')).toHaveCount(9); // 5 + 4 fixture words
    await expect(page.locator('#vilnaPageWrap')).toHaveClass(/select-text-mode/);
  });

  test('selectVilnaPhrase selects the whole word-aligned synchronized segment', async ({ page }) => {
    await seed(page, { segments: [{ ref: 'Chullin 89a.1', w0: 1, w1: 3, start: 0, end: 10, he: 'x', en: 'x' }] });
    const runs = await page.evaluate(() => {
      selectVilnaPhrase('Chullin 89a.1', 2); // word 2 is inside the 1..3 segment
      return state.textSelection.runs;
    });
    expect(runs).toEqual([{ ref: 'Chullin 89a.1', start: 1, end: 3 }]);
  });

  test('selectVilnaPhrase falls back to the WHOLE REF when the segment has no word-level w0/w1', async ({ page }) => {
    await seed(page, { segments: [{ ref: 'Chullin 89a.1', w0: null, w1: null, start: 0, end: 10, he: 'x', en: 'x' }] });
    const runs = await page.evaluate(() => {
      selectVilnaPhrase('Chullin 89a.1', 2);
      return state.textSelection.runs;
    });
    expect(runs).toEqual([{ ref: 'Chullin 89a.1', start: 0, end: 4 }]); // all 5 fixture words for this ref
  });

  test('selectVilnaPhrase falls back to just the one word when there is no synchronized segment at all for this ref', async ({ page }) => {
    await seed(page, { segments: [] });
    const runs = await page.evaluate(() => {
      selectVilnaPhrase('Chullin 89a.1', 2);
      return state.textSelection.runs;
    });
    expect(runs).toEqual([{ ref: 'Chullin 89a.1', start: 2, end: 2 }]);
  });

  test('after either action, the selection can be dragged past the original bounds — not limited by phrase boundaries', async ({ page }) => {
    await seed(page, { segments: [{ ref: 'Chullin 89a.1', w0: 1, w1: 2, start: 0, end: 10, he: 'x', en: 'x' }] });
    const runs = await page.evaluate(() => {
      selectVilnaPhrase('Chullin 89a.1', 1); // selects words 1..2
      // A drag onto a word in the SECOND ref -- well past this phrase's own
      // boundary, and past the end of ref 1 entirely.
      extendTextSelection('Chullin 89a.2', 1);
      return state.textSelection.runs;
    });
    expect(runs).toEqual([
      { ref: 'Chullin 89a.1', start: 1, end: 4 },
      { ref: 'Chullin 89a.2', start: 0, end: 1 },
    ]);
  });
});

test.describe('word-target tap wiring -- drag/tap-to-extend disabled for now', () => {
  // Reported directly: tapping a word further down the page could extend
  // the selection from its old anchor all the way there, highlighting a
  // huge chunk of intervening text -- and long-pressing a word INSIDE an
  // existing selection (to add a note on the whole thing) could shrink the
  // selection before the context menu even opened, because pointerdown on
  // the word-target overlay used to mutate state.textSelection immediately.
  // extendTextSelection itself still knows how to extend (selectVilnaPhrase
  // and the tests above call it directly) -- only the tap/drag WIRING is
  // disabled here.
  test.beforeEach(async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/browse/');
  });

  test('a plain tap on a word target starts a fresh single-word selection instead of extending the old one', async ({ page }) => {
    await seed(page);
    await page.evaluate(() => selectVilnaWord('Chullin 89a.1', 0));
    const targets = page.locator('.vilna-select-text-word-target');
    await targets.nth(4).dispatchEvent('pointerdown', { button: 0 }); // ref 1, wordIndex 4
    const runs = await page.evaluate(() => state.textSelection.runs);
    expect(runs).toEqual([{ ref: 'Chullin 89a.1', start: 4, end: 4 }]); // not extended to 0..4
  });

  test('a tap on a word already inside the current selection leaves the selection untouched', async ({ page }) => {
    await seed(page, { segments: [{ ref: 'Chullin 89a.1', w0: 1, w1: 3, start: 0, end: 10, he: 'x', en: 'x' }] });
    await page.evaluate(() => selectVilnaPhrase('Chullin 89a.1', 2)); // selects words 1..3
    const targets = page.locator('.vilna-select-text-word-target');
    await targets.nth(2).dispatchEvent('pointerdown', { button: 0 }); // wordIndex 2, inside 1..3
    const runs = await page.evaluate(() => state.textSelection.runs);
    expect(runs).toEqual([{ ref: 'Chullin 89a.1', start: 1, end: 3 }]); // untouched, not collapsed
  });

  test('a tap on a word outside the current selection replaces it, not extends it', async ({ page }) => {
    await seed(page, { segments: [{ ref: 'Chullin 89a.1', w0: 1, w1: 2, start: 0, end: 10, he: 'x', en: 'x' }] });
    await page.evaluate(() => selectVilnaPhrase('Chullin 89a.1', 1)); // selects words 1..2
    const targets = page.locator('.vilna-select-text-word-target');
    await targets.nth(4).dispatchEvent('pointerdown', { button: 0 }); // wordIndex 4, outside 1..2
    const runs = await page.evaluate(() => state.textSelection.runs);
    expect(runs).toEqual([{ ref: 'Chullin 89a.1', start: 4, end: 4 }]); // replaced, not 1..4
  });
});

test.describe('the "now playing" blue highlight defers to an active selection', () => {
  test.beforeEach(async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/browse/');
  });

  test('selecting the currently-playing phrase replaces its blue highlight with the yellow selection', async ({ page }) => {
    await seed(page, { segments: [{ ref: 'Chullin 89a.1', w0: 0, w1: 4, start: 0, end: 10, he: 'x', en: 'x' }] });
    await page.evaluate(() => { state.activeIndex = 0; updateVilnaOverlay(); });
    await expect(page.locator('.vilna-active-rect')).toHaveCount(1); // whole 5-word row, before selection

    await page.evaluate(() => selectVilnaPhrase('Chullin 89a.1', 2));
    await expect(page.locator('.vilna-active-rect')).toHaveCount(0); // fully replaced by yellow
    await expect(page.locator('.vilna-select-text-selection-rect')).toHaveCount(1);
  });

  test('a selection on an UNRELATED ref leaves the blue highlight alone', async ({ page }) => {
    await seed(page, { segments: [{ ref: 'Chullin 89a.1', w0: 0, w1: 4, start: 0, end: 10, he: 'x', en: 'x' }] });
    await page.evaluate(() => { state.activeIndex = 0; updateVilnaOverlay(); });

    await page.evaluate(() => selectVilnaWord('Chullin 89a.2', 1));
    await expect(page.locator('.vilna-active-rect')).toHaveCount(1); // untouched
    await expect(page.locator('.vilna-select-text-selection-rect')).toHaveCount(1);
  });

  test('clearing the selection brings the blue highlight back', async ({ page }) => {
    await seed(page, { segments: [{ ref: 'Chullin 89a.1', w0: 0, w1: 4, start: 0, end: 10, he: 'x', en: 'x' }] });
    await page.evaluate(() => { state.activeIndex = 0; updateVilnaOverlay(); selectVilnaPhrase('Chullin 89a.1', 2); });
    await expect(page.locator('.vilna-active-rect')).toHaveCount(0);

    await page.evaluate(() => clearTextSelection());
    await expect(page.locator('.vilna-active-rect')).toHaveCount(1);
  });
});

test.describe('the context menu — Select this word / Select whole phrase', () => {
  test.beforeEach(async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/browse/');
    await seed(page, { segments: [{ ref: 'Chullin 89a.1', w0: 1, w1: 3, start: 0, end: 10, he: 'x', en: 'x' }] });
  });

  test('both items appear first for a Vilna-page target', async ({ page }) => {
    const labels = await page.evaluate(() => {
      const target = {
        source: 'vilna', ref: 'Chullin 89a.1', start: 2, end: 2, text: null, segment: null,
        runs: [{ ref: 'Chullin 89a.1', start: 2, end: 2 }],
        word: { ref: 'Chullin 89a.1', wordIndex: 2 },
      };
      return buildMenuItems(target).map((item) => item.label);
    });
    expect(labels.slice(0, 2)).toEqual(['Select this word', 'Select whole phrase']);
  });

  test('neither item appears for a plain text-view target', async ({ page }) => {
    const labels = await page.evaluate(() => {
      const target = {
        source: 'text', ref: 'Chullin 89a.1', start: 0, end: 0, text: 'foo', segment: null,
        runs: [{ ref: 'Chullin 89a.1', start: 0, end: 0 }],
      };
      return buildMenuItems(target).map((item) => item.label);
    });
    expect(labels).not.toContain('Select this word');
    expect(labels).not.toContain('Select whole phrase');
  });

  test('clicking "Select this word" replaces a wider active selection with just the literal clicked word', async ({ page }) => {
    await page.evaluate(() => {
      extendTextSelection('Chullin 89a.1', 0);
      extendTextSelection('Chullin 89a.1', 4); // an existing 0..4 selection
      const target = {
        source: 'vilna', ref: 'Chullin 89a.1', start: 0, end: 4, text: null, segment: null,
        runs: state.textSelection.runs,
        word: { ref: 'Chullin 89a.1', wordIndex: 2 }, // the literal word actually clicked
      };
      buildMenuItems(target).find((item) => item.label === 'Select this word').onClick();
    });
    const runs = await page.evaluate(() => state.textSelection.runs);
    expect(runs).toEqual([{ ref: 'Chullin 89a.1', start: 2, end: 2 }]);
  });

  test('clicking "Select whole phrase" selects the synchronized segment covering the clicked word', async ({ page }) => {
    await page.evaluate(() => {
      const target = {
        source: 'vilna', ref: 'Chullin 89a.1', start: 2, end: 2, text: null, segment: null,
        runs: [{ ref: 'Chullin 89a.1', start: 2, end: 2 }],
        word: { ref: 'Chullin 89a.1', wordIndex: 2 },
      };
      buildMenuItems(target).find((item) => item.label === 'Select whole phrase').onClick();
    });
    const runs = await page.evaluate(() => state.textSelection.runs);
    expect(runs).toEqual([{ ref: 'Chullin 89a.1', start: 1, end: 3 }]);
  });

  test('a real tap on a menu item is not swallowed by the long-press click-suppression window', async ({ page }) => {
    // Reported directly: "Select whole phrase" doing nothing -- the same
    // single word stayed highlighted. Root cause: the long press that opens
    // this menu arms a short window (SUPPRESS_CLICK_WINDOW_MS) meant to eat
    // the ONE stray click some browsers synthesize afterward, so it doesn't
    // fall through and seek the video. But plenty of mobile browsers never
    // fire that synthesized click at all once a long press already opened a
    // context menu -- and this document-level listener can't tell the
    // difference, so it ends up eating the reader's own very next tap
    // instead, menu item included, whenever they tap quickly (which is
    // normal). Simulates that: a menu is open and the suppression window is
    // still armed (as it would be right after the long press that opened
    // it), and a real click lands on a menu item.
    await page.evaluate(() => {
      const target = {
        source: 'vilna', ref: 'Chullin 89a.1', start: 2, end: 2, text: null, segment: null,
        runs: [{ ref: 'Chullin 89a.1', start: 2, end: 2 }],
        word: { ref: 'Chullin 89a.1', wordIndex: 2 },
      };
      openDafMenu(target, 100, 100);
      suppressClickUntil = Date.now() + 500;
    });
    await page.getByRole('menuitem', { name: 'Select whole phrase' }).click();
    const runs = await page.evaluate(() => state.textSelection?.runs);
    expect(runs).toEqual([{ ref: 'Chullin 89a.1', start: 1, end: 3 }]);
  });

  test('a stray click elsewhere within the suppression window is still swallowed', async ({ page }) => {
    await page.evaluate(() => {
      const target = {
        source: 'vilna', ref: 'Chullin 89a.1', start: 2, end: 2, text: null, segment: null,
        runs: [{ ref: 'Chullin 89a.1', start: 2, end: 2 }],
        word: { ref: 'Chullin 89a.1', wordIndex: 2 },
      };
      openDafMenu(target, 100, 100);
      suppressClickUntil = Date.now() + 500;
    });
    // Far outside the menu -- the stray synthesized click this window
    // exists for lands on the page underneath, not on the menu itself. The
    // swallow returns before ever reaching closeDafMenu, so the menu stays
    // open exactly as it did before this fix -- only the "was this click ON
    // the menu" carve-out is new.
    await page.mouse.click(5, 5);
    const selection = await page.evaluate(() => state.textSelection);
    expect(selection).toBeNull(); // no menu item ran
    await expect(page.locator('.daf-context-menu')).toBeVisible();
  });

  test('vilnaTargetAt exposes the literal clicked word even inside an active selection', async ({ page }) => {
    const target = await page.evaluate(() => {
      const wrap = document.getElementById('vilnaPageWrap');
      // Only forced tall enough to have a real height to hit-test against --
      // width is left alone and the click point derived from the wrap's own
      // MEASURED rect below, since a fixed inline width here gets capped by
      // this page's own responsive max-width on a narrow (mobile) viewport,
      // silently placing every fixed pixel coordinate outside the page.
      wrap.style.position = 'fixed';
      wrap.style.left = '0px';
      wrap.style.top = '0px';
      wrap.style.height = '1000px';
      extendTextSelection('Chullin 89a.1', 0);
      extendTextSelection('Chullin 89a.1', 4); // selection covers 0..4
      const rect = wrap.getBoundingClientRect();
      // Fixture box for wordIndex 2 on ref 1: x in [0.5, 0.6], y in [0.10, 0.12]
      // (fractions) -- well inside its own box at these proportions.
      return vilnaTargetAt(rect.left + rect.width * 0.55, rect.top + rect.height * 0.11);
    });
    expect(target?.word).toEqual({ ref: 'Chullin 89a.1', wordIndex: 2 });
    // target.runs/start/end still widen to the WHOLE active selection -- that
    // is what every other menu item (Add note, Highlight, Copy, ...) should
    // act on. Only .word stays the literal word under the pointer.
    expect(target?.start).toBe(0);
    expect(target?.end).toBe(4);
  });
});
