// Locates the printed Gemara column's own bounding box within a photographed
// page, given the page's already-solved corner homography -- the missing
// piece that lets word-position projection stop assuming every physical
// printing shares the SAME margins as the canonical reference PDF (see
// page_ocr_align.py's textBlock output, which this is the client-side/
// server-side counterpart of).
//
// Root cause this fixes: word positions used to be stored as fractions of
// the WHOLE marked page. That's only correct if the user's own physical
// book has the exact same margin proportions as shas.org's reference PDF --
// different print runs/publishers trim pages and set margins differently
// even when the underlying Vilna-pagination typeset content is identical,
// so a small margin mismatch compounds into several line-heights of drift
// by the lower half of a page (confirmed by direct simulation of the
// homography math against synthetic word grids -- a mere 5% mismatch in
// assumed page proportions produced ~3 line-heights of drift near the
// bottom). Normalizing against the TEXT BLOCK's own bounds instead removes
// that assumption entirely, since both sides (the reference data and this
// detector) measure their own text block independently.
//
// Why this can't just reuse the page-corner detector's Canny/contour
// approach: that technique finds a real, sharp CONTRAST edge (paper against
// a background) -- there's no equivalent hard edge where a text block
// starts, only a gradual shift in ink density. This uses the standard
// technique for that instead: project a grid of sample points through the
// page homography, read their luminance, and use row/column "ink density"
// profiles to find where dense (printed) content begins and ends -- the
// same idea document scanners use for text-region detection, and simple
// enough to run in plain JS against pixels Jimp already reads for the
// header-OCR crop, with no OpenCV.js/WASM dependency (and so none of that
// library's load-time/timeout risk) at all.
//
// NOT YET VALIDATED AGAINST REAL PHONE PHOTOS: verified here only against
// synthetic test images (see the scratchpad verification script this was
// developed with) -- real paper texture, uneven lighting, and the actual
// visual contrast between a Vilna page's ink and its background are all
// still open questions, the same caveat every other CV-ish piece of this
// feature has carried since it was first built.

import { applyHomography } from './perspective-transform.mjs';

const GRID_COLS = 120;
const GRID_ROWS = 160;
// Avoids sampling right up to the marked page's own edge, where photo
// artifacts (a sliver of background, a shadow, slight corner-marking
// imprecision) are most likely to show up as false "ink".
const SEARCH_MARGIN = 0.03;
// A grid row/column counts as part of the text block once at least this
// fraction of its sampled cells are "dark" -- low enough to survive gaps
// between letters/lines, high enough to reject a handful of stray dark
// pixels (photo noise, a smudge) as real content.
const MIN_ROW_DENSITY = 0.12;
const MIN_COL_DENSITY = 0.12;
// Column segments narrower than this fraction of the page's width are
// treated as noise, not a real column (Rashi/Tosafot/Gemara are all wide
// enough to comfortably clear this).
const MIN_SEGMENT_WIDTH_FRAC = 0.08;
// Below this, the detection isn't trustworthy enough to project word
// positions from -- fail closed to the old whole-page projection instead
// (see scan-daf-page.mjs), the same "wrong is worse than falling back"
// philosophy as scoreQuadConfidence for page corners.
const MIN_CONFIDENCE = 0.35;
// A real Gemara column should cover a meaningful share of the marked page's
// area -- used only to scale the confidence score, not as a hard cutoff.
const EXPECTED_MIN_AREA_FRAC = 0.15;

function luminance(rgba) {
  return 0.299 * rgba.r + 0.587 * rgba.g + 0.114 * rgba.b;
}

function gridToFraction(row, col) {
  return [
    SEARCH_MARGIN + (col / (GRID_COLS - 1)) * (1 - 2 * SEARCH_MARGIN),
    SEARCH_MARGIN + (row / (GRID_ROWS - 1)) * (1 - 2 * SEARCH_MARGIN),
  ];
}

// The first/last index whose density clears minDensity, or null if none do.
function findDenseRange(counts, minDensity) {
  const start = counts.findIndex((c) => c >= minDensity);
  if (start === -1) return null;
  let end = counts.length - 1;
  while (end > start && counts[end] < minDensity) end -= 1;
  return { start, end };
}

// Contiguous runs of dense cells, each at least minWidth long -- the
// candidate columns (Rashi / Gemara / Tosafot, in some order) separated by
// the lighter gutters between them.
function findDenseSegments(counts, minDensity, minWidth) {
  const segments = [];
  let start = null;
  for (let i = 0; i < counts.length; i += 1) {
    const dense = counts[i] >= minDensity;
    if (dense && start === null) start = i;
    if (!dense && start !== null) {
      if (i - 1 - start >= minWidth) segments.push({ start, end: i - 1 });
      start = null;
    }
  }
  if (start !== null && counts.length - 1 - start >= minWidth) segments.push({ start, end: counts.length - 1 });
  return segments;
}

/**
 * Detects the Gemara column's own bounding quadrilateral within a
 * photographed page.
 *
 * @param getPixel (x, y) => {r,g,b,a} -- reads one pixel from the photo, in
 *   the SAME pixel space pageHomography maps into (image-pixel space).
 *   Takes a reader function rather than a Jimp image directly so this stays
 *   testable/reusable without a hard Jimp dependency.
 * @param pageHomography the already-solved page-corners homography (unit
 *   square [0,1]x[0,1] -> the marked page's photo-pixel corners).
 * @param imageWidth/imageHeight photo pixel dimensions, for clamping.
 * @returns { corners, confidence, fractionBounds } in photo-pixel space, or
 *   null if nothing confident enough was found.
 */
export function detectTextBlockQuad(getPixel, pageHomography, imageWidth, imageHeight) {
  const grid = [];
  for (let r = 0; r < GRID_ROWS; r += 1) {
    const row = [];
    for (let c = 0; c < GRID_COLS; c += 1) {
      const [fx, fy] = gridToFraction(r, c);
      const [px, py] = applyHomography(pageHomography, fx, fy);
      const x = Math.min(imageWidth - 1, Math.max(0, Math.round(px)));
      const y = Math.min(imageHeight - 1, Math.max(0, Math.round(py)));
      row.push(luminance(getPixel(x, y)));
    }
    grid.push(row);
  }

  const flat = grid.flat();
  const mean = flat.reduce((a, b) => a + b, 0) / flat.length;
  // A fixed fraction of the sampled grid's own mean luminance -- adapts to
  // this specific photo's overall exposure instead of a hardcoded absolute
  // brightness, the same reasoning as scan-daf-page.mjs's normalize() step
  // for the header crop.
  const threshold = mean * 0.75;
  const dark = grid.map((row) => row.map((v) => v < threshold));

  const rowCounts = dark.map((row) => row.filter(Boolean).length / GRID_COLS);
  const rowRange = findDenseRange(rowCounts, MIN_ROW_DENSITY);
  if (!rowRange) return null;

  const colCounts = [];
  for (let c = 0; c < GRID_COLS; c += 1) {
    let count = 0;
    for (let r = rowRange.start; r <= rowRange.end; r += 1) if (dark[r][c]) count += 1;
    colCounts.push(count / (rowRange.end - rowRange.start + 1));
  }
  const segments = findDenseSegments(colCounts, MIN_COL_DENSITY, Math.round(GRID_COLS * MIN_SEGMENT_WIDTH_FRAC));
  if (!segments.length) return null;
  // The Gemara column is the single WIDE column in the middle -- Rashi and
  // Tosafot flank it in the outer margins (see page_ocr_align.py's own
  // module docstring) -- so among however many dense segments were found,
  // the widest one is it.
  const colRange = segments.reduce((best, seg) => (seg.end - seg.start > best.end - best.start ? seg : best));

  const rowSpan = (rowRange.end - rowRange.start) / GRID_ROWS;
  const colSpan = (colRange.end - colRange.start) / GRID_COLS;
  const confidence = Math.max(0, Math.min(1, (rowSpan * colSpan) / EXPECTED_MIN_AREA_FRAC));
  if (confidence < MIN_CONFIDENCE) return null;

  const [leftFrac] = gridToFraction(0, colRange.start);
  const [rightFrac] = gridToFraction(0, colRange.end);
  const [, topFrac] = gridToFraction(rowRange.start, 0);
  const [, bottomFrac] = gridToFraction(rowRange.end, 0);

  const fractionBounds = { left: leftFrac, top: topFrac, right: rightFrac, bottom: bottomFrac };
  const corners = [
    [leftFrac, topFrac], [rightFrac, topFrac], [rightFrac, bottomFrac], [leftFrac, bottomFrac],
  ].map(([fx, fy]) => applyHomography(pageHomography, fx, fy));

  return { corners, confidence, fractionBounds };
}
