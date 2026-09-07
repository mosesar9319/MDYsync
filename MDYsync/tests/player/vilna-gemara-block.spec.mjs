import { test, expect } from '@playwright/test';
import { preparePage, failOnPageError } from '../support/harness.mjs';

// Reported directly: the "now playing" highlight sometimes jumping fully or
// partially into Rashi or Tosafot -- a technically correct word match
// (Rashi/Tosafot routinely quote the Gemara verbatim, a "dibur hamatchil",
// before commenting on it), but the wrong physical occurrence of it.
//
// The OCR pipeline (tools/caption-sync/page_ocr_align.py) deliberately reads
// the WHOLE page -- Gemara, Rashi, Tosafot, marginal reference columns --
// and separates real Gemara words from everything else purely by matching
// against the KNOWN Gemara word list (see that file's own comment on why: a
// fixed spatial crop doesn't work, since real pages don't hold Gemara to one
// constant column width). That textual match has no way to prefer the real
// Gemara occurrence over an identical-looking quotation sitting in a
// different column -- which is exactly the gap this covers.
//
// The pipeline already computes textBlock -- the Gemara column's own
// bounding box on that specific page -- and stores it alongside wordBoxes,
// but the client never used it. restrictWordBoxesToGemaraBlock (app.js) is
// applied once, at the one place a results file becomes state.vilnaPageMap,
// so every consumer (click targets, the highlight, Select Text, ...) only
// ever sees words inside that box.

test.describe('restrictWordBoxesToGemaraBlock -- the filter itself', () => {
  test('drops a box whose center sits outside the Gemara text block', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/watch/?ref=Chullin%2089a');

    const result = await page.evaluate(() => {
      const textBlock = { left: 0.15, right: 0.655, top: 0.05, bottom: 0.95 };
      const wordBoxes = [
        { ref: 'Chullin 89a.1', wordIndex: 0, x: 0.30, y: 0.10, w: 0.05, h: 0.02 }, // real Gemara word
        { ref: 'Chullin 89a.1', wordIndex: 1, x: 0.35, y: 0.10, w: 0.05, h: 0.02 }, // real Gemara word
        { ref: 'Chullin 89a.1', wordIndex: 1, x: 0.75, y: 0.12, w: 0.05, h: 0.02 }, // stray: Rashi's own column, to the right
        { ref: 'Chullin 89a.1', wordIndex: 2, x: 0.05, y: 0.10, w: 0.05, h: 0.02 }, // stray: Tosafot's own column, to the left
        { ref: 'Chullin 89a.1', wordIndex: 3, x: 0.30, y: 0.98, w: 0.05, h: 0.02 }, // stray: below the text block entirely
      ];
      return restrictWordBoxesToGemaraBlock(wordBoxes, textBlock)
        .map((b) => `${b.ref}#${b.wordIndex}`);
    });

    expect(result).toEqual(['Chullin 89a.1#0', 'Chullin 89a.1#1']);
  });

  test('a box straddling the block edge is judged by its CENTER, not its whole extent', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/watch/?ref=Chullin%2089a');

    const result = await page.evaluate(() => {
      const textBlock = { left: 0.15, right: 0.655, top: 0.05, bottom: 0.95 };
      // A wide box (w: 0.06) centered just inside the right edge (0.655):
      // center at 0.65, well inside; its own right edge (0.68) technically
      // pokes past the block. Should still be kept -- ordinary OCR jitter
      // at a column boundary, not a misplaced word.
      const insideByCenter = [{ ref: 'a', wordIndex: 0, x: 0.62, y: 0.5, w: 0.06, h: 0.02 }];
      // The mirror case: centered just OUTSIDE, should be dropped even
      // though its left edge dips back inside the block.
      const outsideByCenter = [{ ref: 'a', wordIndex: 0, x: 0.63, y: 0.5, w: 0.06, h: 0.02 }];
      return {
        kept: restrictWordBoxesToGemaraBlock(insideByCenter, textBlock).length,
        dropped: restrictWordBoxesToGemaraBlock(outsideByCenter, textBlock).length,
      };
    });

    expect(result).toEqual({ kept: 1, dropped: 0 });
  });

  test('no textBlock at all (a pre-v2 results file) leaves every box in place', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/watch/?ref=Chullin%2089a');

    const kept = await page.evaluate(() => {
      const wordBoxes = [{ ref: 'a', wordIndex: 0, x: 0.95, y: 0.95, w: 0.05, h: 0.02 }];
      return restrictWordBoxesToGemaraBlock(wordBoxes, null).length;
    });

    expect(kept).toBe(1);
  });
});

test.describe('The Vilna page load -- wired end to end', () => {
  test('a results file with a stray Rashi/Tosafot match never reaches state.vilnaPageMap', async ({ page }) => {
    const errors = [];
    failOnPageError(page, errors);
    await preparePage(page, { user: null });

    // Stands in for /api/get-results-file's real answer for a page whose
    // OCR pass matched a Rashi quotation as well as the genuine Gemara
    // occurrence -- exactly the shape page_ocr_align.py can produce.
    await page.route('**/api/get-results-file**', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        textBlock: { left: 0.15, right: 0.655, top: 0.05, bottom: 0.95 },
        wordBoxes: [
          { ref: 'Chullin 89a.1', wordIndex: 0, x: 0.30, y: 0.10, w: 0.05, h: 0.02 },
          { ref: 'Chullin 89a.1', wordIndex: 1, x: 0.35, y: 0.10, w: 0.05, h: 0.02 },
          { ref: 'Chullin 89a.1', wordIndex: 1, x: 0.75, y: 0.12, w: 0.05, h: 0.02 },
        ],
      }),
    }));

    // The Daf browser (browseMode), not /watch/ -- its ?ref= handling just
    // renders the page image (syncDafPickerFromRef) rather than also
    // auto-triggering a full video+alignment load, which needs a published
    // sync job this fixture doesn't have and isn't what this test is about.
    await page.goto('/browse/?ref=Chullin%2089a');
    await page.waitForTimeout(500);

    // loadVilnaPageMap called directly (parseDafRef gives it exactly the
    // {tractate, daf, amud} shape it expects) -- standalone, the same way
    // renderVilnaPage's own call to it is, so this exercises the real fetch
    // -> normalize -> filter -> state.vilnaPageMap pipeline without needing
    // a full PDF render or a published alignment first.
    await page.evaluate(async () => {
      await loadVilnaPageMap(parseDafRef('Chullin 89a'), () => true);
    });

    const result = await page.evaluate(() => ({
      count: state.vilnaPageMap.wordBoxes.length,
      boxes: state.vilnaPageMap.wordBoxes.map((b) => `${b.ref}#${b.wordIndex}`),
    }));

    expect(result.count).toBe(2);
    expect(result.boxes).toEqual(['Chullin 89a.1#0', 'Chullin 89a.1#1']);
    expect(errors).toEqual([]);
  });

  test('the surviving boxes are what renderVilnaWordBoxes actually draws click targets from', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/watch/?ref=Chullin%2089a');

    await page.evaluate(() => {
      // Pre-filtered, standing in for what loadVilnaPageMap would have
      // produced from the fixture above -- this test is about
      // renderVilnaWordBoxes only ever seeing the survivors, not about the
      // fetch pipeline (covered above).
      state.vilnaPageMap = {
        textBlock: { left: 0.15, right: 0.655, top: 0.05, bottom: 0.95 },
        wordBoxes: [
          { ref: 'Chullin 89a.1', wordIndex: 0, x: 0.30, y: 0.10, w: 0.05, h: 0.02 },
          { ref: 'Chullin 89a.1', wordIndex: 1, x: 0.35, y: 0.10, w: 0.05, h: 0.02 },
        ],
      };
      state.segments = [
        { ref: 'Chullin 89a.1', w0: 0, w1: 1, start: 0, end: 10, he: 'seg1', en: 'seg1' },
      ];
      switchDafView('page');
      renderVilnaWordBoxes();
    });

    // One merged phrase box (both surviving words are on the same printed
    // line), nowhere near the 0.75/0.05 x-fractions the stray boxes above
    // would have produced if they'd made it through.
    await expect(page.locator('.vilna-phrase-box')).toHaveCount(1);
    const left = await page.locator('.vilna-phrase-box').evaluate((el) => parseFloat(el.style.left));
    expect(left).toBeLessThan(65.5); // inside the Gemara block's own right edge (65.5%)
  });
});
