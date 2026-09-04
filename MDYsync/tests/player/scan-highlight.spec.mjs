import { test, expect } from '@playwright/test';
import { preparePage } from '../support/harness.mjs';

// DafScan's tap-to-jump click targets and its "word being spoken right now"
// highlight (player/'s dafscan feature). Covered nowhere else -- this whole
// feature had no prior test coverage at all.
//
// Two bugs, reported separately, both fixed here:
//   1. The highlight was still the old boxy, solid-yellow per-word box
//      (.scan-word-box.active), against the blue, narrow, merged-per-line
//      bar the Vilna page and the in-video overlay had already moved to.
//   2. The click targets were still one oversized box per WORD
//      (.scan-word-box, transform: scale(1.25, 1.8)), the same shape the
//      Vilna page moved away from when that oversizing was found to bleed
//      into the line above/below and steal taps meant for a neighboring
//      word -- reported directly as "the daf scan should have the same box
//      per phrase as all the other daf views on the website."
//
// state.dafRef is set to the target ref before calling renderScanMatch so its
// own `if (state.dafRef !== ref) loadDaf(ref)` guard is skipped, and
// state.segments is set BEFORE that call (not after, the way this file's
// tests originally did it before the phrase-box rewrite) -- renderScanMatch
// now reads state.segments directly to group the click targets into phrases,
// the same way renderVilnaWordBoxes does for the Vilna page. This is about
// the rendering renderScanMatch/updateScanOverlay do themselves, not a real
// photo-to-daf match round trip (which needs a real OCR result and a loaded
// video, well beyond this fix's scope). Likewise #scanResult/#scanResultPhoto
// are unhidden and given a source by hand here, the same two lines
// showScanResult itself does right before it calls renderScanMatch in the
// real flow -- see that function.
//
// A 1x1 transparent PNG, so .scan-result-wrap img's `height: auto` resolves
// to something nonzero (the wrap has no fixed height of its own) and the
// click targets inside it become real, clickable, visible elements.
const BLANK_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

// #scanResult lives inside #scanPlaceholder, which switchDafView('scan')
// unhides (along with everything else the Text/Vilna page/Scan tabs
// control) -- toggling #scanResult's own `hidden` alone leaves its hidden
// ancestor collapsing it to 0x0, which is what broke click-target
// visibility here before this was found.

// Two segments (phrases): the first covers wordIndex 0-1 of Chullin 89a.1,
// on one printed line, so groupBoxesIntoLineRects merges them into ONE
// phrase box; the second covers a single word of a different ref entirely,
// its own separate phrase box. wordIndex 2 of Chullin 89a.1 is deliberately
// NOT covered by any segment -- there is nothing to seek it to, so it must
// get no click target at all, same as an unaligned word on the Vilna page.
const WORD_BOXES = [
  { ref: 'Chullin 89a.1', wordIndex: 0, x: 0.10, y: 0.10, w: 0.05, h: 0.03 },
  { ref: 'Chullin 89a.1', wordIndex: 1, x: 0.16, y: 0.10, w: 0.05, h: 0.03 },
  { ref: 'Chullin 89a.1', wordIndex: 2, x: 0.22, y: 0.10, w: 0.05, h: 0.03 },
  { ref: 'Chullin 89a.2', wordIndex: 0, x: 0.10, y: 0.20, w: 0.05, h: 0.03 },
];

const SEGMENTS = [
  { ref: 'Chullin 89a.1', w0: 0, w1: 1 },
  { ref: 'Chullin 89a.2', w0: 0, w1: 0 },
];

async function renderMatch(page, { segments = SEGMENTS, activeIndex = -1 } = {}) {
  await page.evaluate(async ({ wordBoxes, photo, segments, activeIndex }) => {
    const ref = 'Chullin 89a';
    state.dafRef = ref;
    state.segments = segments;
    state.activeIndex = activeIndex;
    switchDafView('scan');
    $('scanResultPhoto').src = photo;
    $('scanResult').hidden = false;
    await renderScanMatch(ref, wordBoxes);
  }, { wordBoxes: WORD_BOXES, photo: BLANK_PNG, segments, activeIndex });
}

test.describe('DafScan -- click targets are grouped by phrase', () => {
  test('one merged region per phrase, not one box per word', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    await renderMatch(page);

    // Two segments, two phrase boxes -- NOT four (one per word box above),
    // and not three (wordIndex 2 has no segment covering it, so it
    // contributes no box of its own).
    await expect(page.locator('#scanWordOverlay .scan-phrase-box')).toHaveCount(2);
  });

  test('a word with no covering segment is not a click target at all', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    await renderMatch(page);

    // wordIndex 2 sits at x:0.22 -- outside both phrase boxes' left edges
    // (word 0-1's box spans roughly 0.096-0.216, word 0 of the second ref
    // sits at a different y entirely). No box anywhere near it.
    const boxes = await page.locator('#scanWordOverlay .scan-phrase-box').evaluateAll(
      (els) => els.map((el) => ({ left: parseFloat(el.style.left), top: parseFloat(el.style.top) })),
    );
    for (const box of boxes) {
      const coversUnalignedWord = box.top < 15 && box.left <= 22 && box.left + 10 >= 22;
      expect(coversUnalignedWord).toBe(false);
    }
  });

  test('tapping anywhere in a phrase seeks to that phrase\'s own first word, not the tapped word', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    await renderMatch(page);

    // Overriding the top-level tapScannedWord (a plain function declaration,
    // so this reassigns the exact binding the click handler's closure looks
    // up by name at call time) is simpler than instrumenting the real
    // function, which would otherwise try to seek a video that was never
    // loaded here.
    await page.evaluate(() => { window.__tapped = []; tapScannedWord = (ref, wordIndex) => window.__tapped.push({ ref, wordIndex }); });

    // dispatchEvent rather than click(): the scanned photo (a single 1x1
    // pixel stand-in image here, since there is no real camera capture in
    // this test) renders far taller than any real viewport, and Playwright's
    // real click() spends its retries on scrolling/hit-testing concerns this
    // test isn't about. The click handler itself is a plain DOM listener --
    // dispatching the same event type it listens for exercises it exactly.
    await page.locator('#scanWordOverlay .scan-phrase-box').first().dispatchEvent('click');
    // Segment 1 is { ref: 'Chullin 89a.1', w0: 0, w1: 1 } -- w0, not
    // whichever word inside the merged region happened to be under the
    // pointer, matching renderVilnaWordBoxes's own "always the phrase's own
    // first word" rule (seekToVilnaWord/tapScannedWord resolve a
    // (ref, wordIndex) pair back to the segment it falls within regardless,
    // so passing w0 is enough on its own).
    expect(await page.evaluate(() => window.__tapped)).toEqual([{ ref: 'Chullin 89a.1', wordIndex: 0 }]);
  });

  test('a phrase spanning two printed lines is two rects, and hovering either highlights both', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');

    // One segment, two words on two different lines (y 0.10 and y 0.30 --
    // well past splitBoxesIntoRows's row-break threshold of ~0.6x a box's
    // own height). groupBoxesIntoLineRects must produce two rect elements
    // for this one phrase, the same way a multi-word phrase on the Vilna
    // page renders as one bar per printed line.
    const twoLineWordBoxes = [
      { ref: 'Chullin 89a.1', wordIndex: 0, x: 0.10, y: 0.10, w: 0.05, h: 0.03 },
      { ref: 'Chullin 89a.1', wordIndex: 1, x: 0.10, y: 0.30, w: 0.05, h: 0.03 },
    ];
    await page.evaluate(async ({ wordBoxes }) => {
      const ref = 'Chullin 89a';
      state.dafRef = ref;
      state.segments = [{ ref: 'Chullin 89a.1', w0: 0, w1: 1 }];
      state.activeIndex = -1;
      switchDafView('scan');
      $('scanResultPhoto').src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
      $('scanResult').hidden = false;
      await renderScanMatch(ref, wordBoxes);
    }, { wordBoxes: twoLineWordBoxes });

    const boxes = page.locator('#scanWordOverlay .scan-phrase-box');
    await expect(boxes).toHaveCount(2);

    await boxes.first().dispatchEvent('pointerenter');
    await expect(boxes.nth(0)).toHaveClass(/phrase-hover/);
    await expect(boxes.nth(1)).toHaveClass(/phrase-hover/);

    await boxes.first().dispatchEvent('pointerleave');
    await expect(boxes.nth(0)).not.toHaveClass(/phrase-hover/);
    await expect(boxes.nth(1)).not.toHaveClass(/phrase-hover/);
  });
});

test.describe('DafScan -- "word being spoken right now" highlight', () => {
  test('draws a merged bar into #scanActiveOverlay, not a per-word yellow box', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    await renderMatch(page, { activeIndex: 0 }); // segment 0: Chullin 89a.1, w0-w1 0-1

    // One merged rect covering wordIndex 0-1, not one box per word.
    await expect(page.locator('#scanActiveOverlay .scan-active-rect')).toHaveCount(1);
    const rect = page.locator('#scanActiveOverlay .scan-active-rect');
    await expect(rect).toHaveCSS('background-color', 'rgb(142, 205, 245)'); // #8ecdf5, the same blue .vilna-active-rect uses
    await expect(rect).toHaveCSS('mix-blend-mode', 'multiply');
    const radius = await rect.evaluate((el) => getComputedStyle(el).borderRadius);
    expect(radius).not.toBe('2px'); // the old .scan-word-box.active box shape

    // The old per-word toggle is gone outright: nothing in #scanWordOverlay
    // ever gets .active any more, whatever segment is active.
    await expect(page.locator('#scanWordOverlay .scan-word-box.active')).toHaveCount(0);
  });

  test('no active segment leaves the highlight overlay empty', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');

    await renderMatch(page, { activeIndex: -1 });

    await expect(page.locator('#scanActiveOverlay .scan-active-rect')).toHaveCount(0);
  });
});
