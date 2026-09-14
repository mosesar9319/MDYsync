// Direct tests for the size-based filter (shared/vision-header-ocr.mjs), run
// with `npm run test:functions` (node --test). extractHeaderTokens/
// extractTesseractTokens are already covered indirectly via
// tests/functions/scan-daf-page.test.mjs's __testing re-export; this file
// covers the piece that's directly exported here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { filterTokensBySize } from '../../shared/vision-header-ocr.mjs';

function tok(text, height) {
  return { text, x: 0, y: 0, width: 10, height };
}

test('filterTokensBySize keeps a full header and drops genuinely smaller body text', () => {
  const tokens = [
    tok('חולין', 118),
    tok('פט.', 112),
    tok('הכל', 116),
    tok('שוחטין', 114),
    tok('רש', 30),
    tok('תוס', 34),
  ];
  const kept = filterTokensBySize(tokens).map((t) => t.text);
  assert.deepEqual(kept, ['חולין', 'פט.', 'הכל', 'שוחטין']);
});

// Pinned directly to a real photo's own measured OCR output (a real Vilna
// Shas header, Chullin 131a): "הזרוע"/"עשירי" (no ascender or descender
// letter) at 119px, "והלחיים" (ascender only) at 120px, "פרק" (descender
// only) at 118px, and -- the two words this feature actually needs to
// identify -- "חולין" (BOTH an ascender letter ל and a descender letter ן)
// at 117px and "קלא" (also both) at 112px. All six, printed at the exact
// same size on the real page, land within 8% of each other in raw OCR box
// height. This is the regression test for a real production bug: an
// earlier version of this filter normalized each height by the vertical
// span its own letters were expected to occupy, calibrated against
// synthetic text rendered in generic system fonts where an ascender or
// descender genuinely adds ~35-45% extra box height -- a model that does
// NOT hold for this real printed typeface. It scored "חולין" and "קלא" as
// if they should be ~80% taller than they actually are, made them look
// smaller than the surrounding words, and the 0.6 relative-size cutoff
// dropped both of them outright -- reproduced live: this exact header
// returned matched:false, with the endpoint's own raw OCR tokens showing
// both the tractate-name and daf-number tokens missing from the filtered
// list while the five unrelated perek-name words survived.
test('a real photo\'s own measured header heights all survive together (regression: Chullin 131a)', () => {
  const tokens = [
    tok('הזרוע', 119),
    tok('והלחיים', 120),
    tok('פרק', 118),
    tok('עשירי', 119),
    tok('חולין', 117),
    tok('קלא', 112),
    tok('.', 109),
  ];
  const kept = filterTokensBySize(tokens).map((t) => t.text);
  assert.deepEqual(kept, ['הזרוע', 'והלחיים', 'פרק', 'עשירי', 'חולין', 'קלא', '.']);
});

test('filterTokensBySize keeps everything when all tokens are the same size', () => {
  const tokens = [tok('חולין', 72), tok('פט.', 70), tok('פרק', 71)];
  const kept = filterTokensBySize(tokens).map((t) => t.text);
  assert.deepEqual(kept, ['חולין', 'פט.', 'פרק']);
});

test('filterTokensBySize keeps a token with missing/zero/non-finite height rather than dropping it', () => {
  const tokens = [
    tok('חולין', 40),
    tok('פט.', 39),
    { text: 'no-height', x: 0, y: 0, width: 10, height: undefined },
    { text: 'zero-height', x: 0, y: 0, width: 10, height: 0 },
    { text: 'nan-height', x: 0, y: 0, width: 10, height: NaN },
  ];
  const kept = filterTokensBySize(tokens).map((t) => t.text);
  assert.deepEqual(kept, ['חולין', 'פט.', 'no-height', 'zero-height', 'nan-height']);
});

test('filterTokensBySize is a no-op (returns tokens unfiltered) when no token has usable height at all', () => {
  const tokens = [{ text: 'a', height: undefined }, { text: 'b', height: NaN }];
  assert.deepEqual(filterTokensBySize(tokens), tokens);
});

test('filterTokensBySize falls back to the unfiltered list rather than leaving under two tokens', () => {
  // A header match needs both a name token and a daf-number token; a filter
  // aggressive enough to leave one (or none) has certainly cut real header
  // text, so it is safer to match against everything and let the closed
  // vocabulary sort it out.
  const tokens = [tok('גדול', 100), tok('קטן', 40), tok('זעיר', 20)];
  const kept = filterTokensBySize(tokens, 0.9).map((t) => t.text);
  assert.deepEqual(kept, ['גדול', 'קטן', 'זעיר']);
});

test('filterTokensBySize respects a custom minRelativeSize when enough tokens survive', () => {
  const tokens = [tok('אאא', 100), tok('בבב', 95), tok('גגג', 25)];
  assert.deepEqual(filterTokensBySize(tokens, 0.9).map((t) => t.text), ['אאא', 'בבב']);
  assert.deepEqual(filterTokensBySize(tokens, 0.2).map((t) => t.text), ['אאא', 'בבב', 'גגג']);
});

test('filterTokensBySize never mutates the input array', () => {
  const tokens = [tok('אאא', 40), tok('בבב', 38), tok('ג', 5)];
  const before = tokens.length;
  filterTokensBySize(tokens);
  assert.equal(tokens.length, before);
});
