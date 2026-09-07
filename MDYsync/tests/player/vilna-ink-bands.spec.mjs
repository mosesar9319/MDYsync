import { test, expect } from '@playwright/test';
import { preparePage } from '../support/harness.mjs';

// measureInkBands (app.js) scans the rendered Vilna page for real printed-
// line boundaries, so the "now playing"/selection highlight bars can snap to
// where the letters actually are instead of guessing from OCR word boxes
// (see its own long comment for the measured numbers behind that). It uses
// ONE threshold -- a fraction of the single darkest row anywhere on the
// scanned page -- to decide which rows count as "inked". That serves an
// ordinary, densely-set line fine, but a line with noticeably less ink
// overall (a short line at a paragraph's end, or simply fewer/thinner
// letters) can have every one of its OWN rows fall well under that page-wide
// bar, so only its darkest row or two ever clears it -- clipping its
// measured band down from the letters' real height. Reported directly as
// some highlighted lines still rendering very thin.
//
// This draws a synthetic page directly onto a canvas (no PDF, no real OCR
// needed -- measureInkBands only ever reads pixels and a few wordBoxes) with
// two normal, dense lines flanking one much lighter line, all three the same
// real height, and checks the light line's measured band isn't clipped down
// relative to the dense ones around it.

function pitchFraction(canvasHeight) {
  return 14 / canvasHeight; // matches the real ~14px ink band this module's own comments measure
}

async function buildSyntheticPage(page, { lineAlpha }) {
  return page.evaluate(({ lineAlpha }) => {
    const canvas = document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 200;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const lineHeight = 14;
    const lineTops = [20, 60, 100]; // dense, light (lineAlpha), dense
    const alphas = [1, lineAlpha, 1];
    ctx.filter = 'blur(2px)'; // soft top/bottom edge, like real anti-aliased letters
    lineTops.forEach((top, i) => {
      ctx.fillStyle = `rgba(0,0,0,${alphas[i]})`;
      ctx.fillRect(20, top, 360, lineHeight);
    });
    ctx.filter = 'none';

    const wordBoxes = lineTops.map((top) => ({
      x: 20 / canvas.width, y: top / canvas.height, w: 360 / canvas.width, h: lineHeight / canvas.height,
    }));
    const bands = measureInkBands(canvas, wordBoxes);
    return {
      canvasHeight: canvas.height,
      heightsPx: (bands || []).map((b) => (b.bottom - b.top) * canvas.height),
    };
  }, { lineAlpha });
}

test.describe('measureInkBands -- a lighter line is not clipped thinner than its dense neighbours', () => {
  test.beforeEach(async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/browse/');
  });

  test('three same-height lines, one noticeably lighter, all measure close to the same height', async ({ page }) => {
    const { heightsPx } = await buildSyntheticPage(page, { lineAlpha: 0.2 });
    expect(heightsPx.length).toBe(3);
    const [dense1, light, dense2] = heightsPx;
    const denseAvg = (dense1 + dense2) / 2;
    // The light line's measured band should be within a real letter's worth
    // of its dense neighbours -- not dramatically shorter, which is exactly
    // what "still renders very thin" looks like. (Pre-fix, this same page
    // measures the light line at ~10px against ~16.5px dense neighbours --
    // well under this bar.)
    expect(light).toBeGreaterThan(denseAvg * 0.85);
  });

  test('a line so faint it produces no raw band at all does not corrupt its dense neighbours\' measurements', async ({ page }) => {
    // Faint enough that even its own darkest row never clears the global
    // threshold -- the raw pass finds no band for it at all, leaving
    // exactly two raw bands (both dense), an EVEN count. medianOf averages
    // an even count's two middle values into a fraction, which is exactly
    // what exposed the rounding bug this guards: a fractional window bound
    // read as `undefined` from the typed array, zeroing the local
    // threshold and letting a neighbour's band balloon into the blank
    // whitespace where the vanished line used to be.
    const { heightsPx } = await buildSyntheticPage(page, { lineAlpha: 0.05 });
    expect(heightsPx.length).toBe(2);
    for (const h of heightsPx) expect(h).toBeLessThan(20); // real letter height, not ballooned into blank space
  });

  test('a solidly dense page (no light line) is unaffected -- every band still measures the same', async ({ page }) => {
    const { heightsPx } = await buildSyntheticPage(page, { lineAlpha: 1 });
    expect(heightsPx.length).toBe(3);
    const [a, b, c] = heightsPx;
    expect(Math.abs(a - b)).toBeLessThan(2.5);
    expect(Math.abs(b - c)).toBeLessThan(2.5);
  });
});
