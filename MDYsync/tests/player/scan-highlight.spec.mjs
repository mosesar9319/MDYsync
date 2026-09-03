import { test, expect } from '@playwright/test';
import { preparePage } from '../support/harness.mjs';

// The scanned-page "word being spoken right now" highlight (player/'s dafscan
// feature), reported directly as still "boxy and yellow" against the blue,
// narrow, merged-per-line bar the Vilna page and the in-video overlay had
// already moved to. Covered nowhere else -- this whole feature had no prior
// test coverage at all.
//
// state.dafRef is set to the target ref before calling renderScanMatch so its
// own `if (state.dafRef !== ref) loadDaf(ref)` guard is skipped -- this is
// about the highlight rendering renderScanMatch/updateScanOverlay do
// themselves, not a real photo-to-daf match round trip (which needs a real
// OCR result and a loaded video, well beyond this fix's scope). Likewise
// #scanResult/#scanResultPhoto are unhidden and given a source by hand here,
// the same two lines showScanResult itself does right before it calls
// renderScanMatch in the real flow -- see that function.
//
// A 1x1 transparent PNG, so .scan-result-wrap img's `height: auto` resolves
// to something nonzero (the wrap has no fixed height of its own) and the
// per-word click targets inside it become real, clickable, visible elements.
const BLANK_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

// #scanResult lives inside #scanPlaceholder, which switchDafView('scan')
// unhides (along with everything else the Text/Vilna page/Scan tabs
// control) -- toggling #scanResult's own `hidden` alone leaves its hidden
// ancestor collapsing it to 0x0, which is what actually broke click-target
// visibility here before this was found.

const WORD_BOXES = [
  { ref: 'Chullin 89a.1', wordIndex: 0, x: 0.10, y: 0.10, w: 0.05, h: 0.03 },
  { ref: 'Chullin 89a.1', wordIndex: 1, x: 0.16, y: 0.10, w: 0.05, h: 0.03 },
  // Outside the active segment's word range -- must not be highlighted.
  { ref: 'Chullin 89a.1', wordIndex: 2, x: 0.22, y: 0.10, w: 0.05, h: 0.03 },
  // A different ref entirely -- must not be highlighted either.
  { ref: 'Chullin 89a.2', wordIndex: 0, x: 0.10, y: 0.20, w: 0.05, h: 0.03 },
];

async function renderMatchAndHighlight(page, { activeSegmentRef = 'Chullin 89a.1' } = {}) {
  await page.evaluate(async ({ wordBoxes, photo, activeSegmentRef }) => {
    const ref = 'Chullin 89a';
    state.dafRef = ref;
    switchDafView('scan');
    $('scanResultPhoto').src = photo;
    $('scanResult').hidden = false;
    await renderScanMatch(ref, wordBoxes);
    state.segments = [{ ref: activeSegmentRef, w0: 0, w1: 1 }];
    state.activeIndex = 0;
    updateScanOverlay(0);
  }, { wordBoxes: WORD_BOXES, photo: BLANK_PNG, activeSegmentRef });
}

test.describe('DafScan -- "word being spoken right now" highlight', () => {
  test('draws a merged bar into #scanActiveOverlay, not a per-word yellow box', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    await expect(page.locator('#scanWordOverlay')).toBeAttached();

    await renderMatchAndHighlight(page);

    // One merged rect covering wordIndex 0-1 (the active segment's w0/w1),
    // not one box per word and not the third or fourth box above.
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

  test('the click targets in #scanWordOverlay are untouched -- still one per word, still jump the video', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    await renderMatchAndHighlight(page);

    await expect(page.locator('#scanWordOverlay .scan-word-box')).toHaveCount(WORD_BOXES.length);

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
    await page.locator('#scanWordOverlay .scan-word-box').nth(1).dispatchEvent('click');
    expect(await page.evaluate(() => window.__tapped)).toEqual([{ ref: 'Chullin 89a.1', wordIndex: 1 }]);
  });

  test('an inactive segment leaves the highlight overlay empty', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');

    await renderMatchAndHighlight(page, { activeSegmentRef: 'Some Other Ref 1.1' });

    await expect(page.locator('#scanActiveOverlay .scan-active-rect')).toHaveCount(0);
  });
});
