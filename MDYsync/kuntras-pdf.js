'use strict';

// Kuntras Builder, slice 5: turn a kuntras' tree into a downloadable PDF.
//
// pdf-lib has no bidi engine at all -- font.layout()/drawText place glyphs in
// exactly the order the string is given, left to right. Fed a mixed
// Hebrew+English line as-is, it does not selectively reverse the Hebrew: it
// reverses the WHOLE line, so "שלום עולם Hello 123" comes out with "Hello 123"
// backwards too ("321 olleH"). See layoutBidiLine below for the word-level
// fix. This is a deliberately simplified stand-in for real UAX#9 (see that
// function's own header for exactly what it does and does not handle) --
// good enough for the kind of mixed Hebrew/Aramaic-plus-English study notes
// this feature exists for, not a general bidi implementation.

(function () {
  // --- Lazily loading the vendored libraries ------------------------------
  //
  // pdf-lib's own ESM build has no external imports, but @pdf-lib/fontkit's
  // ESM build does (a bare `import "pako"`, unresolvable without a bundler
  // or import map, neither of which this project has). Its UMD build inlines
  // pako instead, so both libraries are vendored as UMD and loaded the same
  // way here -- a plain <script> tag, attaching a global -- rather than
  // pdf.min.mjs's dynamic import(), which only pdf-lib alone could have used.
  // Nothing here loads until exportKuntrasToPdf is actually called.

  const PDF_LIB_URL = '/vendor/pdf-lib.min.js';
  const FONTKIT_URL = '/vendor/fontkit.umd.min.js';
  const FONT_REGULAR_URL = '/vendor/FrankRuhlLibre-Regular.ttf';
  const FONT_BOLD_URL = '/vendor/FrankRuhlLibre-Bold.ttf';

  function loadScriptOnce(src, globalName) {
    if (window[globalName]) return Promise.resolve(window[globalName]);
    const existing = document.querySelector(`script[src="${src}"]`);
    return new Promise((resolve, reject) => {
      const onReady = () => (window[globalName] ? resolve(window[globalName]) : reject(new Error(`${src} loaded but did not define window.${globalName}`)));
      if (existing) {
        if (window[globalName]) return resolve(window[globalName]);
        existing.addEventListener('load', onReady, { once: true });
        existing.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), { once: true });
        return;
      }
      const script = document.createElement('script');
      script.src = src;
      script.addEventListener('load', onReady, { once: true });
      script.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), { once: true });
      document.head.appendChild(script);
    });
  }

  async function fetchFontBytes(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
    return res.arrayBuffer();
  }

  let pdfEnginePromise = null;
  // Everything exportKuntrasToPdf needs before it can draw a single glyph:
  // both libraries plus both font weights, fetched once and reused for every
  // export in the page's lifetime -- there is no per-export state here, so
  // caching the whole bundle behind one promise is simpler than caching each
  // piece separately.
  function loadPdfEngine() {
    if (!pdfEnginePromise) {
      pdfEnginePromise = Promise.all([
        loadScriptOnce(PDF_LIB_URL, 'PDFLib'),
        loadScriptOnce(FONTKIT_URL, 'fontkit'),
        fetchFontBytes(FONT_REGULAR_URL),
        fetchFontBytes(FONT_BOLD_URL),
      ]).then(([PDFLib, fontkit, regularBytes, boldBytes]) => ({ PDFLib, fontkit, regularBytes, boldBytes }));
    }
    return pdfEnginePromise;
  }

  // --- Bidi-ish line layout ------------------------------------------------
  //
  // NOT a UAX#9 implementation. It handles exactly the two-level case this
  // app actually produces -- a paragraph that is mostly Hebrew/Aramaic with
  // occasional English or numeric words, or the reverse -- by classifying
  // each WORD (never splitting inside one) and reordering at the word level
  // only. What it does not handle: nested embedding levels (e.g. an English
  // phrase quoted inside a Hebrew phrase inside an English sentence), RTL
  // punctuation/parenthesis mirroring, and mixed-script words (a single token
  // with both Hebrew and Latin letters is classified by whichever script it
  // contains rather than being split further).

  const HEBREW_RE = /[֐-׿]/;
  const LATIN_RE = /[A-Za-z]/;

  // A word's own direction, or 'neutral' for one with no directional letters
  // at all (pure digits/punctuation, e.g. "123" or "5,"). Neutral words never
  // start their own run -- seeing "123" alone tells you nothing about which
  // way it should go; it belongs with whichever real text surrounds it (see
  // resolveDirections), the same way a lone European number behaves inside
  // real bidi text.
  function classifyWord(word) {
    if (HEBREW_RE.test(word)) return 'rtl';
    if (LATIN_RE.test(word)) return 'ltr';
    return 'neutral';
  }

  // Resolves every 'neutral' word to its neighbor's direction: the preceding
  // classified word if there is one, else the following one, else the
  // paragraph's own base direction if the whole line is neutral. Returns a
  // parallel array of resolved directions ('rtl'/'ltr'), one per word.
  function resolveDirections(words, baseDir) {
    const raw = words.map(classifyWord);
    const resolved = raw.slice();
    for (let i = 0; i < resolved.length; i += 1) {
      if (resolved[i] !== 'neutral') continue;
      let dir = null;
      for (let j = i - 1; j >= 0; j -= 1) {
        if (raw[j] !== 'neutral') { dir = raw[j]; break; }
      }
      if (!dir) {
        for (let j = i + 1; j < resolved.length; j += 1) {
          if (raw[j] !== 'neutral') { dir = raw[j]; break; }
        }
      }
      resolved[i] = dir || baseDir;
    }
    return resolved;
  }

  // Groups words (in logical/typed order) into maximal runs of the same
  // resolved direction.
  function groupRuns(words, directions) {
    const runs = [];
    for (let i = 0; i < words.length; i += 1) {
      const dir = directions[i];
      const last = runs[runs.length - 1];
      if (last && last.dir === dir) {
        last.words.push(words[i]);
      } else {
        runs.push({ dir, words: [words[i]] });
      }
    }
    return runs;
  }

  // The paragraph-level direction used to (a) resolve any all-neutral line
  // and (b) decide whether a whole entry's lines are right- or left-aligned
  // on the page -- one decision per entry body, not per line, so a multi-line
  // Hebrew paragraph that happens to have one all-English line still reads
  // as part of the same right-aligned block instead of visually jumping
  // sides. Majority by character count, not word count, since a single long
  // English citation among short Hebrew words should not flip the paragraph.
  function paragraphBaseDirection(text) {
    let hebrew = 0;
    let latin = 0;
    for (const ch of text) {
      if (HEBREW_RE.test(ch)) hebrew += 1;
      else if (LATIN_RE.test(ch)) latin += 1;
    }
    return hebrew >= latin ? 'rtl' : 'ltr';
  }

  // Takes one physical LINE's words in logical (typed) order and returns them
  // in VISUAL left-to-right draw order -- i.e. what a caller can hand to a
  // plain LTR text drawer word by word, left to right, and see the correct
  // result. For an RTL-base line: runs are placed in the REVERSE of their
  // typed order, and within any run that is itself RTL, its own words are
  // also reversed (an RTL run of multiple words reads right-to-left, so the
  // word typed FIRST ends up rightmost -- i.e. last when placed left to
  // right). An embedded LTR run's word order is left untouched either way,
  // matching how "PYTHON" or "1990" reads normally even inside a Hebrew
  // sentence. For an LTR-base line, the same rule applies with the roles
  // swapped: runs stay in typed order, and only an embedded RTL run has its
  // own words reversed.
  function layoutBidiLine(words, baseDir) {
    if (!words.length) return [];
    const directions = resolveDirections(words, baseDir);
    const runs = groupRuns(words, directions);
    // Top level: for an RTL paragraph the runs themselves read right to
    // left, so their LEFT-TO-RIGHT draw order is the reverse of how they
    // were typed; an LTR paragraph draws its runs in typed order.
    const orderedRuns = baseDir === 'rtl' ? runs.slice().reverse() : runs;
    const visual = [];
    orderedRuns.forEach((run) => {
      // Within a run: an RTL run always reads right to left internally, so
      // its words are reversed for left-to-right drawing regardless of the
      // paragraph's base direction; an LTR run's words are never reversed,
      // for the same reason "PYTHON" or "1990" reads normally even quoted
      // inside a Hebrew sentence.
      const runWords = run.dir === 'rtl' ? run.words.slice().reverse() : run.words;
      runWords.forEach((word) => visual.push({ text: word, rtl: run.dir === 'rtl' }));
    });
    return visual;
  }

  // --- Word wrapping ---------------------------------------------------
  //
  // pdf-lib draws a single line at a known width; wrapping to a page is this
  // module's own job. Wraps in LOGICAL (typed) order regardless of direction
  // -- exactly like wrapping any other text -- since the stored string is
  // always logical order (the browser only ever displayed it right to left;
  // it never reordered the underlying characters). Only the drawing step
  // (layoutBidiLine, above) needs to know about direction.
  function wrapParagraph(text, font, size, maxWidth) {
    const words = text.split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const spaceWidth = font.widthOfTextAtSize(' ', size);
    const lines = [];
    let current = [];
    let currentWidth = 0;
    words.forEach((word) => {
      const wordWidth = font.widthOfTextAtSize(word, size);
      const nextWidth = current.length ? currentWidth + spaceWidth + wordWidth : wordWidth;
      if (current.length && nextWidth > maxWidth) {
        lines.push(current);
        current = [word];
        currentWidth = wordWidth;
      } else {
        current.push(word);
        currentWidth = nextWidth;
      }
    });
    if (current.length) lines.push(current);
    return lines;
  }

  // --- Tree walking ---------------------------------------------------
  //
  // Duplicates kuntras.js's own childSections/entriesIn/renderLevel shape
  // rather than importing it: kuntras.js holds that logic inside its own
  // closure as private UI state (state.sections/state.entries), and the two
  // dozen lines it takes to re-derive a tree from the same flat arrays are
  // cheap enough to keep this module independently testable with its own
  // fixture arrays, matching why kuntras-data.js never builds a tree either
  // (see that file's own header on fetchKuntrasTree).

  function childSections(sections, parentId) {
    return sections.filter((s) => s.parent_section_id === parentId).sort((a, b) => a.position - b.position);
  }

  function entriesIn(entries, sectionId) {
    return entries.filter((e) => e.section_id === sectionId).sort((a, b) => a.position - b.position);
  }

  // --- Drawing ---------------------------------------------------------

  const PAGE_WIDTH = 595.28; // A4
  const PAGE_HEIGHT = 841.89;
  const MARGIN = 50;
  const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN;
  const INDENT_PER_DEPTH = 18;

  // One mutable cursor shared across the whole document -- pages, current y,
  // the two embedded fonts -- so every draw* helper below can add a page and
  // keep going without the caller re-threading state through each call.
  function makeCursor(doc, regularFont, boldFont) {
    return {
      doc, regularFont, boldFont,
      page: doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]),
      y: PAGE_HEIGHT - MARGIN,
    };
  }

  function ensureSpace(cursor, neededHeight) {
    if (cursor.y - neededHeight < MARGIN) {
      cursor.page = cursor.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      cursor.y = PAGE_HEIGHT - MARGIN;
    }
  }

  // Draws one already-wrapped line at the given indent, applying
  // layoutBidiLine for word order and right-aligning (from the indent to the
  // right margin) when the paragraph's base direction is RTL, left-aligning
  // from the indent otherwise -- the same "which side does this paragraph
  // hug" question a word processor's own paragraph direction answers.
  function drawLine(cursor, words, font, size, color, indent, baseDir, lineHeight) {
    const visual = layoutBidiLine(words, baseDir);
    const spaceWidth = font.widthOfTextAtSize(' ', size);
    const totalWidth = visual.reduce((sum, w, i) => sum + font.widthOfTextAtSize(w.text, size) + (i ? spaceWidth : 0), 0);
    const maxWidth = CONTENT_WIDTH - indent;
    let x = baseDir === 'rtl' ? MARGIN + indent + Math.max(0, maxWidth - totalWidth) : MARGIN + indent;
    visual.forEach((w, i) => {
      if (i) x += spaceWidth;
      cursor.page.drawText(w.text, { x, y: cursor.y, size, font, color });
      x += font.widthOfTextAtSize(w.text, size);
    });
    cursor.y -= lineHeight;
  }

  function drawParagraph(cursor, text, { font, size, color, indent = 0 }) {
    const baseDir = paragraphBaseDirection(text);
    const lineHeight = size * 1.4;
    const lines = wrapParagraph(text, font, size, CONTENT_WIDTH - indent);
    lines.forEach((words) => {
      ensureSpace(cursor, lineHeight);
      drawLine(cursor, words, font, size, color, indent, baseDir, lineHeight);
    });
  }

  function drawEntry(cursor, PDFLib, entry, depth) {
    const indent = INDENT_PER_DEPTH * depth;
    const black = PDFLib.rgb(0, 0, 0);
    if (entry.title) {
      ensureSpace(cursor, 20);
      drawParagraph(cursor, entry.title, { font: cursor.boldFont, size: 12, color: black, indent });
      cursor.y -= 2;
    }
    drawParagraph(cursor, entry.body, { font: cursor.regularFont, size: 11, color: black, indent });
    cursor.y -= 10;
  }

  function drawSection(cursor, PDFLib, section, sections, entries, depth) {
    const indent = INDENT_PER_DEPTH * depth;
    ensureSpace(cursor, 24);
    drawParagraph(cursor, section.title, { font: cursor.boldFont, size: 14, color: PDFLib.rgb(0, 0, 0), indent });
    cursor.y -= 6;
    drawLevel(cursor, PDFLib, sections, entries, section.id, depth + 1);
  }

  // Entries at this level first, then child sections -- the same order
  // renderLevel in kuntras.js draws in the builder UI, so the PDF matches
  // what the owner sees on screen.
  function drawLevel(cursor, PDFLib, sections, entries, sectionId, depth) {
    entriesIn(entries, sectionId).forEach((entry) => drawEntry(cursor, PDFLib, entry, depth));
    childSections(sections, sectionId).forEach((section) => drawSection(cursor, PDFLib, section, sections, entries, depth));
  }

  // --- Public entry point ------------------------------------------------

  async function exportKuntrasToPdf({ kuntras, sections, entries }) {
    const { PDFLib, fontkit, regularBytes, boldBytes } = await loadPdfEngine();
    const doc = await PDFLib.PDFDocument.create();
    doc.registerFontkit(fontkit);
    const regularFont = await doc.embedFont(regularBytes);
    const boldFont = await doc.embedFont(boldBytes);

    const cursor = makeCursor(doc, regularFont, boldFont);
    drawParagraph(cursor, kuntras.title, { font: boldFont, size: 20, color: PDFLib.rgb(0, 0, 0) });
    cursor.y -= 14;

    drawLevel(cursor, PDFLib, sections, entries, null, 0);

    return doc.save();
  }

  function downloadBytes(bytes, filename) {
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function filenameFor(title) {
    const safe = (title || 'kuntras').trim().replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
    return `${safe || 'kuntras'}.pdf`;
  }

  async function downloadKuntrasPdf(tree) {
    const bytes = await exportKuntrasToPdf(tree);
    downloadBytes(bytes, filenameFor(tree.kuntras.title));
  }

  window.DafSyncKuntras = window.DafSyncKuntras || {};
  window.DafSyncKuntras.pdf = {
    exportKuntrasToPdf,
    downloadKuntrasPdf,
    // Exposed for unit tests only -- not used by kuntras.js.
    classifyWord,
    paragraphBaseDirection,
    layoutBidiLine,
    wrapParagraph,
  };
})();
