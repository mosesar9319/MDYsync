// The printed daf's geometry for Live Follow: where a word range sits on the
// Vilna page image, and the bars drawn over it.
//
// Every declaration below is copied character for character from app.js --
// the player's own code, so a highlight lands on the printed page exactly as
// it does in a dafsync video (same per-line bars, same snapping to the
// printed ink). app.js is a page script, not a module this page can load,
// hence the copy; tests/functions/vilna-geometry.test.mjs holds each one to
// the original, so the two cannot drift apart unnoticed. The reasoning behind
// the numbers is in the comments on the originals in app.js.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VilnaGeometry = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  function pageMapKey(parsed) {
    return `${parsed.tractate.replace(/\s+/g, '-')}-${parsed.daf}${parsed.amud}`;
  }

  function normalizeDafParagraphRef(ref) {
    return String(ref || '').trim()
      // A Vilna page/scan word box's ref is always the plain tractate/daf/
      // amud form, never carrying a "(Chazarah Daf)"/"(Hebrew)" marker (the
      // variant is tracked by the alignment's own key -- see refKey), so a
      // segment ref that does carry one could never string-equal the word
      // box it belongs to. Stripped here so both sides land in the same
      // shape, which is what the exact-string comparisons in
      // updateVilnaOverlay/updateScanOverlay/seekToVilnaWord all rely on.
      // No-op for the refs that were already plain.
      .replace(/\s*\((?:Chazarah Daf|Hebrew)\)/gi, '')
      .replace(/(\d+[ab])[:.](\d+)$/i, '$1.$2');
  }

  function normalizePageWordBoxes(wordBoxes) {
    return Array.isArray(wordBoxes)
      ? wordBoxes.map((box) => ({ ...box, ref: normalizeDafParagraphRef(box.ref) }))
      : [];
  }

  function restrictWordBoxesToGemaraBlock(wordBoxes, textBlock) {
    if (!textBlock) return wordBoxes;
    const { left, right, top, bottom } = textBlock;
    if (![left, right, top, bottom].every(Number.isFinite)) return wordBoxes;
    return wordBoxes.filter((box) => {
      const cx = box.x + box.w / 2;
      const cy = box.y + box.h / 2;
      return cx >= left && cx <= right && cy >= top && cy <= bottom;
    });
  }

  function medianOf(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function splitBoxesIntoRows(boxes) {
    const rows = [];
    let current = [];
    let prevBox = null;
    for (const box of boxes) {
      if (prevBox && Math.abs(box.y - prevBox.y) > prevBox.h * 0.6) {
        rows.push(current);
        current = [];
      }
      current.push(box);
      prevBox = box;
    }
    if (current.length) rows.push(current);
    return rows;
  }

  const INK_PITCH_RATIO = 0.5601;

  const INK_CENTER_BIAS = 0.00078;

  const INK_BOX_RATIO = 0.53;

  const linePitchCache = new WeakMap();

  function pageLinePitch(pageMap) {
    if (!pageMap) return 0;
    const cached = linePitchCache.get(pageMap);
    if (cached !== undefined) return cached;
    const rows = splitBoxesIntoRows(
      [...(pageMap.wordBoxes || [])].sort((a, b) => (a.y - b.y) || (b.x - a.x)),
    ).filter((row) => row.length >= 3);
    const tops = rows.map((row) => Math.min(...row.map((b) => b.y))).sort((a, b) => a - b);
    const gaps = [];
    for (let i = 0; i + 1 < tops.length; i += 1) {
      const gap = tops[i + 1] - tops[i];
      // Discards both a line accidentally split in two (too small a gap)
      // and a line the OCR missed entirely, which would otherwise read as
      // one double-height gap. Taking the median of what's left is what
      // makes this robust to either.
      if (gap > 0.004 && gap < 0.03) gaps.push(gap);
    }
    const pitch = gaps.length >= 3 ? medianOf(gaps) : 0;
    linePitchCache.set(pageMap, pitch);
    return pitch;
  }

  function measureInkBands(canvas, wordBoxes) {
    const sortedVals = (vals) => [...vals].sort((a, b) => a - b);
    const at = (arr, p) => arr[Math.max(0, Math.min(arr.length - 1, Math.floor(arr.length * p)))];
    // Percentiles rather than min/max: a few marginal reference marks sit
    // well outside the Gemara column, and including them would widen the
    // scan across the commentary columns, whose lines are set to a
    // different rhythm entirely.
    const x0 = Math.max(0, Math.floor(at(sortedVals(wordBoxes.map((b) => b.x)), 0.05) * canvas.width));
    const x1 = Math.min(canvas.width, Math.ceil(at(sortedVals(wordBoxes.map((b) => b.x + b.w)), 0.95) * canvas.width));
    const y0 = Math.max(0, Math.floor(at(sortedVals(wordBoxes.map((b) => b.y)), 0.02) * canvas.height));
    const y1 = Math.min(canvas.height, Math.ceil(at(sortedVals(wordBoxes.map((b) => b.y + b.h)), 0.98) * canvas.height));
    const width = x1 - x0;
    const height = y1 - y0;
    if (width < 8 || height < 8) return null;

    // Squeeze the column down to a narrow strip first, at full height. Only
    // the vertical resolution carries meaning here -- each row becomes a
    // single "how much ink is on this line" number either way -- so the
    // horizontal axis can be collapsed by the scaling blit rather than by
    // reading every pixel. getImageData is what costs: pulling the column
    // at full width measured 400ms on the largest raster this app allows
    // (MAX_CANVAS_WIDTH_PX), against ~50ms for blit-plus-strip-read. Still
    // not free, but it happens once per raster, not once per repaint.
    // Verified to give the same 57 lines on the same daf rasterised at 75,
    // 150 and 300 dpi, agreeing on every line edge to within a pixel, so
    // the squeeze costs nothing in precision.
    const SCAN_COLUMNS = 160;
    let data;
    let strip;
    try {
      strip = document.createElement('canvas');
      strip.width = Math.min(SCAN_COLUMNS, width);
      strip.height = height;
      const stripContext = strip.getContext('2d', { willReadFrequently: true });
      stripContext.drawImage(canvas, x0, y0, width, height, 0, 0, strip.width, strip.height);
      data = stripContext.getImageData(0, 0, strip.width, strip.height).data;
    } catch (error) {
      return null; // e.g. a tainted canvas -- the box-derived estimate still stands
    }

    // Total darkness per row rather than a count of dark pixels: after the
    // horizontal squeeze each sample is an average of the pixels behind it,
    // so a row of text reads as many middling-grey samples rather than a
    // few black ones.
    const inkPerRow = new Float64Array(height);
    const stripWidth = strip.width;
    for (let row = 0; row < height; row += 1) {
      let ink = 0;
      for (let i = row * stripWidth * 4, col = 0; col < stripWidth; col += 1, i += 4) {
        ink += 255 - (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
      }
      inkPerRow[row] = ink;
    }
    let peak = 0;
    for (const ink of inkPerRow) if (ink > peak) peak = ink;
    if (!peak) return null; // nothing rendered yet

    const threshold = peak * 0.15;
    const minBandPx = Math.max(3, Math.round(canvas.height * 0.002));
    const rawBands = [];
    let start = -1;
    for (let row = 0; row <= height; row += 1) {
      const inked = row < height && inkPerRow[row] >= threshold;
      if (inked && start < 0) start = row;
      else if (!inked && start >= 0) {
        if (row - start >= minBandPx) rawBands.push({ start, end: row });
        start = -1;
      }
    }
    if (!rawBands.length) return null;

    // `threshold` is one fraction of the single darkest row on the WHOLE
    // page -- fine for a typical, densely-set line, but a line with
    // noticeably less ink overall (a short line at a paragraph's end, or
    // simply fewer/thinner letters at that row) can have every one of its
    // OWN rows fall well under it, so only its darkest row or two ever
    // clears the bar. That clips the measured band down from the letters'
    // real height, reported directly as some highlighted lines still
    // rendering very thin. Every band is re-measured against its own LOCAL
    // peak (the darkest row within roughly one line's height around it)
    // instead of the page's -- a no-op for a normally-dense line (its local
    // peak already IS the page's, or close enough that the same rows still
    // clear the bar), but it recovers the rest of a light line's real ink
    // instead of clipping it to whatever the darkest line elsewhere happens
    // to allow.
    // Rounded: an even count of raw bands makes medianOf average its two
    // middle values into a non-integer, and a fractional row silently reads
    // as undefined from a typed array (never negative, so a bare `>=
    // threshold` comparison against it is always false, and the local-peak
    // scan below would find nothing without ever throwing) -- which zeroed
    // localPeak/localThreshold outright and let the walk below treat every
    // row in the window as inked, expanding the band into blank whitespace
    // instead of recovering real ink. Caught directly by this fix's own
    // test once the sampled dapim happened to produce an even band count.
    const typicalRows = Math.round(medianOf(rawBands.map((band) => band.end - band.start)));
    const bands = rawBands.map((band) => {
      const windowStart = Math.max(0, band.start - typicalRows);
      const windowEnd = Math.min(height, band.end + typicalRows);
      let localPeak = 0;
      for (let row = windowStart; row < windowEnd; row += 1) {
        if (inkPerRow[row] > localPeak) localPeak = inkPerRow[row];
      }
      const localThreshold = localPeak * 0.15;
      let refinedStart = band.start;
      while (refinedStart > windowStart && inkPerRow[refinedStart - 1] >= localThreshold) refinedStart -= 1;
      let refinedEnd = band.end;
      while (refinedEnd < windowEnd && inkPerRow[refinedEnd] >= localThreshold) refinedEnd += 1;
      return { start: refinedStart, end: refinedEnd };
    });

    return bands.map((band) => ({
      top: (y0 + band.start) / canvas.height,
      bottom: (y0 + band.end) / canvas.height,
    }));
  }

  function matchInkBand(bands, centre, pitch) {
    if (!bands?.length) return null;
    let best = null;
    let bestDistance = Infinity;
    for (const band of bands) {
      const distance = Math.abs((band.top + band.bottom) / 2 - centre);
      if (distance < bestDistance) { bestDistance = distance; best = band; }
    }
    // Only accept a band that lines up with where the words say they are.
    // A miss of more than half a line means the map and the raster disagree
    // about this page, and the estimate is the safer of the two answers.
    return bestDistance <= (pitch || 0.012) * 0.5 ? best : null;
  }

  function groupBoxesIntoLineRects(boxes, pageMap, inkBands) {
    if (!boxes.length) return [];
    const rows = splitBoxesIntoRows(boxes);
    const pitch = pageLinePitch(pageMap);
    // Horizontal padding only, to give the rounded end caps a little room
    // so they don't clip the first and last letter. There is deliberately
    // no vertical padding: the whole point is that the bar starts and ends
    // where the letters do.
    const PAD_X = 0.004;

    return rows.map((row) => {
      const left = Math.min(...row.map((b) => b.x)) - PAD_X;
      const right = Math.max(...row.map((b) => b.x + b.w)) + PAD_X;
      const centre = medianOf(row.map((b) => b.y + b.h / 2)) + INK_CENTER_BIAS;
      const band = matchInkBand(inkBands, centre, pitch);
      if (band) {
        return { left, top: band.top, width: right - left, height: band.bottom - band.top };
      }
      const height = pitch
        ? pitch * INK_PITCH_RATIO
        : medianOf(row.map((b) => b.h)) * INK_BOX_RATIO;
      return { left, top: centre - height / 2, width: right - left, height };
    });
  }

  function appendLineRects(overlay, rects, className) {
    for (const rect of rects) {
      const el = document.createElement('div');
      el.className = className;
      el.style.left = `${rect.left * 100}%`;
      el.style.top = `${rect.top * 100}%`;
      el.style.width = `${rect.width * 100}%`;
      el.style.height = `${rect.height * 100}%`;
      overlay.appendChild(el);
    }
  }

  return {
    pageMapKey,
    normalizeDafParagraphRef,
    normalizePageWordBoxes,
    restrictWordBoxesToGemaraBlock,
    medianOf,
    splitBoxesIntoRows,
    pageLinePitch,
    measureInkBands,
    matchInkBand,
    groupBoxesIntoLineRects,
    appendLineRects,
  };
}));
