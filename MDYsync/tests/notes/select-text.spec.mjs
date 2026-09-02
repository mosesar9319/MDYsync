import { test, expect } from '@playwright/test';
import { preparePage, readTestCalls } from '../support/harness.mjs';
import { USERS } from '../fixtures/dataset.mjs';

// Regression cover for the Select Text engine in app.js -- reading order,
// multi-ref run grouping, and the word_ranges payload a saved note carries.
//
// This drives the selection engine directly (vilnaReadingOrder /
// extendTextSelection / groupBoxesIntoRuns are top-level function declarations,
// so they are real globals in a classic script) rather than dragging across a
// rendered PDF canvas. That keeps the suite fast and deterministic while still
// protecting the logic that actually decides what a selection MEANS -- which is
// the part the Cloud Chabura work must not disturb.

// Hebrew reads right-to-left, so within a row word 0 is the RIGHTMOST box.
// Laying the fixture out any other way silently inverts every expectation
// below (this bit the original development of this feature).
function pageMapFixture() {
  const boxes = [];
  const row = (ref, y, count, startIndex = 0) => {
    for (let i = 0; i < count; i += 1) {
      boxes.push({ ref, wordIndex: startIndex + i, x: 0.8 - i * 0.15, y, w: 0.1, h: 0.02 });
    }
  };
  row('Chullin 89a.1', 0.10, 5);            // indices 0..4, right to left
  row('Chullin 89a.1', 0.20, 3, 5);         // indices 5..7 on the next line
  row('Chullin 89a.2', 0.30, 4);            // a different ref, further down
  return { wordBoxes: boxes };
}

async function seedPageMap(page) {
  await page.evaluate((map) => {
    state.vilnaPageMap = map;
    state.textSelection = null;
  }, pageMapFixture());
}

test.describe('Select Text — reading order', () => {
  test.beforeEach(async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await page.goto('/browse/');
    await seedPageMap(page);
  });

  test('orders words top-to-bottom, right-to-left within a row', async ({ page }) => {
    const order = await page.evaluate(() =>
      vilnaReadingOrder(state.vilnaPageMap).boxes.map((b) => `${b.ref}#${b.wordIndex}`)
    );

    expect(order.slice(0, 5)).toEqual([
      'Chullin 89a.1#0', 'Chullin 89a.1#1', 'Chullin 89a.1#2', 'Chullin 89a.1#3', 'Chullin 89a.1#4',
    ]);
    expect(order.slice(5, 8)).toEqual(['Chullin 89a.1#5', 'Chullin 89a.1#6', 'Chullin 89a.1#7']);
    expect(order.slice(8)).toEqual([
      'Chullin 89a.2#0', 'Chullin 89a.2#1', 'Chullin 89a.2#2', 'Chullin 89a.2#3',
    ]);
  });
});

test.describe('Select Text — selection runs', () => {
  test.beforeEach(async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await page.goto('/browse/');
    await seedPageMap(page);
  });

  test('a selection inside one ref produces a single run', async ({ page }) => {
    const runs = await page.evaluate(() => {
      extendTextSelection('Chullin 89a.1', 1);
      extendTextSelection('Chullin 89a.1', 3);
      return state.textSelection.runs;
    });

    expect(runs).toEqual([{ ref: 'Chullin 89a.1', start: 1, end: 3 }]);
  });

  test('a selection crossing refs produces one run per ref, in reading order', async ({ page }) => {
    const runs = await page.evaluate(() => {
      extendTextSelection('Chullin 89a.1', 6);
      extendTextSelection('Chullin 89a.2', 1);
      return state.textSelection.runs;
    });

    expect(runs).toEqual([
      { ref: 'Chullin 89a.1', start: 6, end: 7 },
      { ref: 'Chullin 89a.2', start: 0, end: 1 },
    ]);
  });

  test('dragging backwards past the anchor shrinks and reverses correctly', async ({ page }) => {
    const runs = await page.evaluate(() => {
      extendTextSelection('Chullin 89a.2', 2); // anchor
      extendTextSelection('Chullin 89a.2', 3); // forward
      extendTextSelection('Chullin 89a.1', 6); // back past the anchor, across a ref
      return state.textSelection.runs;
    });

    // The anchor stays fixed at 89a.2#2, so the range is 89a.1#6 .. 89a.2#2.
    expect(runs).toEqual([
      { ref: 'Chullin 89a.1', start: 6, end: 7 },
      { ref: 'Chullin 89a.2', start: 0, end: 2 },
    ]);
  });

  test('the anchor is fixed for the life of one selection', async ({ page }) => {
    const anchors = await page.evaluate(() => {
      extendTextSelection('Chullin 89a.1', 2);
      const first = state.textSelection.anchorIndex;
      extendTextSelection('Chullin 89a.1', 7);
      const second = state.textSelection.anchorIndex;
      extendTextSelection('Chullin 89a.2', 0);
      return [first, second, state.textSelection.anchorIndex];
    });

    expect(new Set(anchors).size).toBe(1);
  });

  test('clearing resets the selection so the next drag re-anchors', async ({ page }) => {
    const runs = await page.evaluate(() => {
      extendTextSelection('Chullin 89a.1', 0);
      extendTextSelection('Chullin 89a.2', 3);
      clearTextSelection();
      extendTextSelection('Chullin 89a.2', 1);
      extendTextSelection('Chullin 89a.2', 2);
      return state.textSelection.runs;
    });

    expect(runs).toEqual([{ ref: 'Chullin 89a.2', start: 1, end: 2 }]);
  });

  test('a word absent from the current page map is ignored, not guessed at', async ({ page }) => {
    const selection = await page.evaluate(() => {
      extendTextSelection('Chullin 99z.1', 4);
      return state.textSelection;
    });

    expect(selection).toBeNull();
  });
});

test.describe('Select Text — saved note payload', () => {
  test('a multi-ref selection saves word_ranges and mirrors its first run', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await page.goto('/browse/');
    await seedPageMap(page);

    await page.evaluate(() => {
      extendTextSelection('Chullin 89a.1', 6);
      extendTextSelection('Chullin 89a.2', 1);
      state.dafRef = 'Chullin 89a';
    });

    // Open the composer on the live selection exactly as the context menu's
    // "Add note on this passage" action does.
    await page.evaluate(() => window.DafNotesComposer.openForSelection(state.textSelection.runs));
    await expect(page.locator('#noteDialog')).toBeVisible();

    await page.click('#notePrivacyToggle .note-privacy-option[data-privacy="live"]');
    await page.fill('#noteBodyInput', 'A note spanning two refs.');
    await page.click('#saveNoteButton');

    await expect.poll(async () => {
      const calls = await readTestCalls(page);
      return Boolean(calls.find((c) => c.table === 'line_notes' && c.operation === 'insert'));
    }).toBe(true);

    const calls = await readTestCalls(page);
    const row = calls.find((c) => c.table === 'line_notes' && c.operation === 'insert').rows[0];

    expect(row.word_ranges).toEqual([
      { ref: 'Chullin 89a.1', start: 6, end: 7 },
      { ref: 'Chullin 89a.2', start: 0, end: 1 },
    ]);
    // The legacy trio must keep mirroring the FIRST run for every consumer
    // that predates word_ranges (moderation queue, search, drift heuristic).
    expect(row.segment_ref).toBe('Chullin 89a.1');
    expect(row.start_word).toBe(6);
    expect(row.end_word).toBe(7);
    expect(row.is_private).toBe(false);
  });
});
