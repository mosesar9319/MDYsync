// Traces a printed Vilna daf page purely from ink density -- no OCR, no text
// recognition -- and maps Sefaria's already-known word sequence onto the
// traced positions in reading order. Validated by hand against a real page
// (Chullin 86a: 57 of the page's real printed lines found exactly, 411 of
// 415 real Gemara words placed, boxes landing on the correct printed word)
// before this module existed; this is that approach, generalized for the
// manual trace tool in studio/trace.html.
//
// Three things this version fixes that the one-shot prototype didn't handle:
//
// 1. Column width isn't constant down the page. Early lines are often
//    flanked by Rashi/Tosefet-Rashi commentary (narrow Gemara column); once
//    a page's commentary runs out, Gemara continues alone at the text
//    block's full width for the remaining lines. detectLineExtent below
//    re-finds each line's own left/right ink extent independently -- the
//    same "pick the widest dense segment" rule the original column
//    detector uses, just run fresh per line instead of once for the whole
//    page, so it naturally comes out narrow where flanked and wide where
//    not, with no need to know in advance where the transition happens.
//
// 2. The Vilna print abbreviates common multi-word Talmudic phrases
//    (תנו רבנן -> ת"ר) while Sefaria's text always spells them out in full.
//    Counting printed words 1:1 against canon words drifts the moment one
//    of these appears. collapseAbbreviations folds a known phrase into a
//    single token *before* the count-based assignment runs, using
//    shared/abbreviations.json (a small, growable, human-editable
//    dictionary) -- so the common cases need no manual marking at all, and
//    only genuinely unrecognized abbreviations need a person's attention.
//
// 3. Every automatic step here is a starting point for a human to correct,
//    not a final answer -- see studio/trace.js for the box-adjust/split/
//    merge UI and the abbreviation-marking flow that feeds back into the
//    dictionary.

const MIN_ROW_DENSITY = 0.03;
const MIN_COL_DENSITY = 0.10;
const CHAR_RUN_DENSITY = 0.08;
const MIN_SEGMENT_WIDTH_FRAC = 0.03; // of the search width, for line-extent segments

/** Strips niqqud, cantillation marks, and punctuation for matching only --
 * never for display. Sefaria's text is vocalized; the printed Vilna page
 * isn't, but that doesn't matter here since this tool never reads glyphs
 * off the page at all, only ink position. This normalizer exists purely so
 * the abbreviation dictionary's phrase arrays match Sefaria words reliably. */
export function normalizeHebrewWord(word) {
  return String(word || '')
    .replace(/[֑-ׇ]/g, '') // niqqud + cantillation + gershayim/geresh marks
    .replace(/[^א-ת]/g, ''); // keep only Hebrew consonant letters
}

function luminance(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Reads a sub-rectangle of a canvas ImageData-like object into a flat
 * grayscale Float32Array (row-major, `w`*`h` long). Isolated so every
 * detection step below shares one read of the pixels it needs. */
export function grayscaleCrop(imageData, x0, y0, w, h) {
  const { data, width: imgW, height: imgH } = imageData;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) {
    const sy = Math.min(imgH - 1, Math.max(0, y0 + y));
    const rowOff = sy * imgW * 4;
    for (let x = 0; x < w; x += 1) {
      const sx = Math.min(imgW - 1, Math.max(0, x0 + x));
      const i = rowOff + sx * 4;
      out[y * w + x] = luminance(data[i], data[i + 1], data[i + 2]);
    }
  }
  return out;
}

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

function widestSegment(segments) {
  if (!segments.length) return null;
  return segments.reduce((best, seg) => (seg.end - seg.start > best.end - best.start ? seg : best));
}

/** Box-blurs a 1D density profile with a simple running-sum moving average.
 * A single line is only ~15-40px tall, so its raw per-column ink density
 * (averaged over that few rows) is noisy enough to fragment one real word
 * into several -- smoothing over roughly one inter-word gap's width merges
 * those fragments back into a single dense run without also bridging the
 * much larger gap to a neighboring column's ink. */
function movingAverage(counts, kernel) {
  const k = Math.max(1, Math.round(kernel));
  const n = counts.length;
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i += 1) prefix[i + 1] = prefix[i] + counts[i];
  const half = Math.floor(k / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n, i + (k - half));
    out[i] = (prefix[hi] - prefix[lo]) / (hi - lo);
  }
  return out;
}

/** Finds every printed line within a cropped region (in the crop's own
 * pixel space), merging stray sub-half-median-height bands -- letter
 * descenders, a colon-style Talmudic full stop sitting just below the
 * baseline -- into whichever real line they're adjacent to, so they don't
 * count as their own line. Returns [{top, bottom}], sorted top to bottom. */
export function detectLines(imageData, crop) {
  const { x, y, w, h } = crop;
  const gray = grayscaleCrop(imageData, x, y, w, h);
  let sum = 0;
  for (let i = 0; i < gray.length; i += 1) sum += gray[i];
  const threshold = (sum / gray.length) * 0.75;

  const rowCounts = new Float32Array(h);
  for (let ry = 0; ry < h; ry += 1) {
    let dark = 0;
    const rowOff = ry * w;
    for (let rx = 0; rx < w; rx += 1) if (gray[rowOff + rx] < threshold) dark += 1;
    rowCounts[ry] = dark / w;
  }

  const raw = findDenseSegments(rowCounts, MIN_ROW_DENSITY, 1);
  if (!raw.length) return [];
  const heights = raw.map((s) => s.end - s.start + 1).sort((a, b) => a - b);
  const medianH = heights[Math.floor(heights.length / 2)];

  const lines = [];
  for (const seg of raw) {
    const segH = seg.end - seg.start + 1;
    if (segH < medianH * 0.5 && lines.length) {
      lines[lines.length - 1].bottom = seg.end;
    } else {
      lines.push({ top: seg.start, bottom: seg.end });
    }
  }
  return lines;
}

/** Re-finds one line's own left/right ink extent across the *entire* crop
 * width (not a fixed narrow band), independent of every other line --
 * the fix for Gemara narrowing where flanked by commentary and widening
 * once it isn't. Returns {left, right} in crop-relative pixel space, or
 * null if the line has no real ink (shouldn't happen for a genuine line,
 * but a manually mis-drawn crop can produce one). */
export function detectLineExtent(imageData, crop, line) {
  const { x, y, w } = crop;
  const lineH = line.bottom - line.top + 1;
  const gray = grayscaleCrop(imageData, x, y + line.top, w, lineH);
  let sum = 0;
  for (let i = 0; i < gray.length; i += 1) sum += gray[i];
  const threshold = (sum / gray.length) * 0.75;

  const colCounts = new Float32Array(w);
  for (let cx = 0; cx < w; cx += 1) {
    let dark = 0;
    for (let cy = 0; cy < lineH; cy += 1) if (gray[cy * w + cx] < threshold) dark += 1;
    colCounts[cx] = dark / lineH;
  }
  // A single line is too short (rows) for its raw per-column density to be
  // smooth -- bridge the real inter-word gap (empirically ~16-32px on a
  // 300dpi/~29px-line render, well above the ~1-4px inter-*letter* gap;
  // see detectWordsInLine's own, much narrower, gap threshold for splitting
  // words back apart) so a whole line reads as one dense run instead of
  // fragmenting at every space between its words. Still well short of the
  // gap to a neighboring column, which the widest-segment pick below relies
  // on to not bridge across.
  const smoothed = movingAverage(colCounts, Math.max(8, lineH * 1.3));
  const segments = findDenseSegments(smoothed, MIN_COL_DENSITY, Math.round(w * MIN_SEGMENT_WIDTH_FRAC));
  const best = widestSegment(segments);
  return best ? { left: best.start, right: best.end } : null;
}

/** Splits one line's own ink into words. Gap threshold is relative to the
 * line's own height (~0.28x, matched against a real 300dpi page where a
 * 29px line used an 8px gap threshold) rather than a fixed pixel count, so
 * it holds up across different render resolutions. */
export function detectWordsInLine(imageData, crop, line, extent) {
  const { x, y } = crop;
  const left = extent.left;
  const lineW = extent.right - extent.left + 1;
  const lineH = line.bottom - line.top + 1;
  const gray = grayscaleCrop(imageData, x + left, y + line.top, lineW, lineH);
  let sum = 0;
  for (let i = 0; i < gray.length; i += 1) sum += gray[i];
  const threshold = (sum / gray.length) * 0.75;

  const colCounts = new Float32Array(lineW);
  for (let cx = 0; cx < lineW; cx += 1) {
    let dark = 0;
    for (let cy = 0; cy < lineH; cy += 1) if (gray[cy * lineW + cx] < threshold) dark += 1;
    colCounts[cx] = dark / lineH;
  }

  const runs = [];
  let start = null;
  for (let i = 0; i < lineW; i += 1) {
    const dense = colCounts[i] > CHAR_RUN_DENSITY;
    if (dense && start === null) start = i;
    if (!dense && start !== null) {
      runs.push([start, i - 1]);
      start = null;
    }
  }
  if (start !== null) runs.push([start, lineW - 1]);
  if (!runs.length) return [];

  const gapThresh = Math.max(2, lineH * 0.28);
  const words = [runs[0].slice()];
  for (let i = 1; i < runs.length; i += 1) {
    const gap = runs[i][0] - words[words.length - 1][1] - 1;
    if (gap <= gapThresh) {
      words[words.length - 1][1] = runs[i][1];
    } else {
      words.push(runs[i].slice());
    }
  }
  // Convert back to crop-relative pixel coordinates.
  return words.map(([a, b]) => ({ left: left + a, right: left + b }));
}

/** Flattens Sefaria's per-segment word lists into one ordered token stream,
 * collapsing any run of words matching a dictionary phrase into a single
 * token -- one token per printed word, which is what the line/word
 * detection above actually counts. `segments` is [{ref, words: [string]}],
 * already split on whitespace with niqqud intact (display text); matching
 * itself uses normalizeHebrewWord so niqqud differences never matter. */
export function collapseAbbreviations(segments, dictionary) {
  const entries = (dictionary?.entries || [])
    .map((e) => ({ phrase: e.phrase.map(normalizeHebrewWord), abbr: e.abbr }))
    .sort((a, b) => b.phrase.length - a.phrase.length); // longest phrase first

  const tokens = [];
  for (const seg of segments) {
    const norm = seg.words.map(normalizeHebrewWord);
    let i = 0;
    while (i < seg.words.length) {
      let matched = null;
      for (const entry of entries) {
        const n = entry.phrase.length;
        if (n < 2 || i + n > seg.words.length) continue;
        let ok = true;
        for (let k = 0; k < n; k += 1) if (norm[i + k] !== entry.phrase[k]) { ok = false; break; }
        if (ok) { matched = entry; break; }
      }
      const span = matched ? matched.phrase.length : 1;
      tokens.push({
        ref: seg.ref,
        wordIndexStart: i,
        wordIndexEnd: i + span - 1,
        text: seg.words.slice(i, i + span).join(' '),
        abbr: matched ? matched.abbr : null,
      });
      i += span;
    }
  }
  return tokens;
}
