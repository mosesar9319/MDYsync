import { test, expect } from '@playwright/test';
import { preparePage } from '../support/harness.mjs';
import { USERS } from '../fixtures/dataset.mjs';

// Reported directly: the yellow Select Text highlight was "too narrow" and
// "clipped, uneven" compared to the blue "playing right now" highlight.
//
// Both draw from the exact same geometry (groupBoxesIntoLineRects, same
// PAD_X end-cap padding, same containing overlay) -- .vilna-select-text-
// selection-rect and .vilna-active-rect always covered the identical boxes.
// The gap was purely CSS: the selection rect used a thin rgba fill boxed in
// a 1px border with 4px corners, which clipped the rounded end-cap padding
// PAD_X exists for and made a multi-line selection read as separate,
// disconnected boxes. This locks the selection rect to the same solid-fill/
// multiply-blend/999px-pill treatment .vilna-active-rect already has (see
// styles.css), so the two only ever differ in color.

function pageMapFixture() {
  const boxes = [];
  const row = (ref, y, count, startIndex = 0) => {
    for (let i = 0; i < count; i += 1) {
      boxes.push({ ref, wordIndex: startIndex + i, x: 0.8 - i * 0.15, y, w: 0.1, h: 0.02 });
    }
  };
  row('Chullin 89a.1', 0.10, 5);
  row('Chullin 89a.1', 0.20, 3, 5);
  return { wordBoxes: boxes };
}

test.describe('Select Text — the rendered highlight', () => {
  test.beforeEach(async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await page.goto('/browse/');
    await page.evaluate((map) => {
      state.vilnaPageMap = map;
      state.textSelection = null;
      switchDafView('page');
    }, pageMapFixture());
  });

  test('the selection rect gets the same fill/blend/shape treatment as the "now playing" rect', async ({ page }) => {
    // A stand-in "now playing" rect, drawn with the real production
    // function so this compares against the real computed styles rather
    // than a copy of the values pasted into the test.
    await page.evaluate((map) => {
      const overlay = document.getElementById('vilnaActiveOverlay');
      const boxes = map.wordBoxes.filter((b) => b.wordIndex <= 4);
      appendLineRects(overlay, groupBoxesIntoLineRects(boxes, map, null), 'vilna-active-rect');
    }, pageMapFixture());

    await page.evaluate(() => {
      extendTextSelection('Chullin 89a.1', 0);
      extendTextSelection('Chullin 89a.1', 4);
    });

    const activeStyle = await page.locator('.vilna-active-rect').first().evaluate((el) => {
      const s = getComputedStyle(el);
      return { blend: s.mixBlendMode, radius: s.borderRadius, borderWidth: s.borderTopWidth };
    });
    const selectionStyle = await page.locator('.vilna-select-text-selection-rect').first().evaluate((el) => {
      const s = getComputedStyle(el);
      return { blend: s.mixBlendMode, radius: s.borderRadius, borderWidth: s.borderTopWidth };
    });

    expect(selectionStyle.blend).toBe('multiply');
    expect(selectionStyle.blend).toBe(activeStyle.blend);
    // Both fully rounded (a "pill"), not the old 4px boxy corner.
    expect(selectionStyle.radius).toBe(activeStyle.radius);
    expect(parseFloat(selectionStyle.radius)).toBeGreaterThan(20);
    // No border boxing each line-rect off from its neighbors.
    expect(selectionStyle.borderWidth).toBe('0px');
    expect(selectionStyle.borderWidth).toBe(activeStyle.borderWidth);
  });

  test('a selection spanning two printed lines still covers full word width per line, same geometry function the "now playing" highlight uses', async ({ page }) => {
    // Checked via the percentage values appendLineRects writes directly
    // (el.style.left/top/width/height), not rendered boundingBox() pixels --
    // this fixture never loads a real page image, so #vilnaPageWrap has no
    // real intrinsic size for a percentage box to resolve against. Same
    // approach tests/player/vilna-gemara-block.spec.mjs already uses for
    // exactly this reason.
    await page.evaluate(() => {
      extendTextSelection('Chullin 89a.1', 0);
      extendTextSelection('Chullin 89a.1', 7); // crosses onto the second row
    });

    const rects = await page.locator('.vilna-select-text-selection-rect').all();
    expect(rects.length).toBe(2); // one per printed line

    for (const rect of rects) {
      const style = await rect.evaluate((el) => ({
        width: parseFloat(el.style.width),
        height: parseFloat(el.style.height),
      }));
      // Real coverage, not a sliver -- each row's fixture words span 0.65
      // (5 words * 0.15 spacing on the first row) to 0.3 (3 words on the
      // second) of the page's fractional width; either way a properly
      // covering rect is well past a hairline fraction of a percent.
      expect(style.width).toBeGreaterThan(1);
      expect(style.height).toBeGreaterThan(0.1);
    }
  });

  test('the selection stays visually distinct from the blue "now playing" color -- only the treatment was borrowed', async ({ page }) => {
    // watch-theme.css legitimately overrides --highlight per reading page,
    // so this checks the selection rect differs from .vilna-active-rect's
    // own blue rather than hardcoding a hex that would drift with the theme.
    await page.evaluate((map) => {
      const overlay = document.getElementById('vilnaActiveOverlay');
      const boxes = map.wordBoxes.filter((b) => b.wordIndex <= 4);
      appendLineRects(overlay, groupBoxesIntoLineRects(boxes, map, null), 'vilna-active-rect');
    }, pageMapFixture());
    await page.evaluate(() => {
      extendTextSelection('Chullin 89a.1', 5);
      extendTextSelection('Chullin 89a.1', 6);
    });

    const selectionBg = await page.locator('.vilna-select-text-selection-rect').first()
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    const activeBg = await page.locator('.vilna-active-rect').first()
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(selectionBg).not.toBe(activeBg);
    expect(activeBg).toBe('rgb(142, 205, 245)'); // #8ecdf5, unchanged
  });
});
