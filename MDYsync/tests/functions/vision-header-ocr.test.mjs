// Direct tests for the glyph-size filter (shared/vision-header-ocr.mjs), run
// with `npm run test:functions` (node --test). extractHeaderTokens/
// extractTesseractTokens are already covered indirectly via
// tests/functions/scan-daf-page.test.mjs's __testing re-export; this file
// covers the pieces that are new here and directly exported.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  expectedGlyphSpan,
  estimateGlyphUnit,
  filterTokensBySize,
} from '../../shared/vision-header-ocr.mjs';

function tok(text, height) {
  return { text, x: 0, y: 0, width: 10, height };
}

test('expectedGlyphSpan is 1 for text with no Hebrew ascender or descender', () => {
  assert.equal(expectedGlyphSpan('פט.'), 1);
  assert.equal(expectedGlyphSpan('מאימתי'), 1);
  assert.equal(expectedGlyphSpan(''), 1);
  assert.equal(expectedGlyphSpan(undefined), 1);
});

// Spans are sums of floating-point extents, so compare with a tolerance
// rather than for exact equality (1 + 0.4 + 0.4 is 1.7999999999999998).
function assertSpan(text, expected) {
  const actual = expectedGlyphSpan(text);
  assert.ok(Math.abs(actual - expected) < 1e-9, `${text}: ${actual} != ${expected}`);
}

test('expectedGlyphSpan adds one extent for an ascender and one for a descender', () => {
  assertSpan('כל', 1.4);     // ל ascends
  assertSpan('דין', 1.4);    // ן descends
  assertSpan('חולין', 1.8);  // ל ascends AND ן descends
  assertSpan('קל.', 1.8);    // ק descends AND ל ascends
});

test('expectedGlyphSpan counts each direction once, no matter how many such letters', () => {
  // Two ascenders and two descenders still only reach the same ink extremes.
  assertSpan('ללךך', 1.8);
});

test('estimateGlyphUnit normalizes away the ascender/descender height bonus', () => {
  // The real measured case that broke matching: rendered at one font size,
  // חולין's ink box is 118px tall while פט.'s is only 66px -- a raw ratio of
  // 0.56, under the 0.6 floor, so the daf number was being thrown away as if
  // it were Rashi text. Normalized, the two agree within ~2%.
  const chullin = estimateGlyphUnit(tok('חולין', 118));
  const daf = estimateGlyphUnit(tok('פט.', 66));
  assert.ok(Math.abs(chullin - daf) / daf < 0.03, `${chullin} vs ${daf}`);
});

test('estimateGlyphUnit returns null for missing, zero or non-finite heights', () => {
  assert.equal(estimateGlyphUnit(tok('א', undefined)), null);
  assert.equal(estimateGlyphUnit(tok('א', 0)), null);
  assert.equal(estimateGlyphUnit(tok('א', NaN)), null);
  assert.equal(estimateGlyphUnit(tok('א', -5)), null);
  assert.equal(estimateGlyphUnit(null), null);
});

test('filterTokensBySize keeps a full header and drops genuinely smaller body text', () => {
  // Header words at one size (חולין taller only because of ל+ן), Rashi- and
  // Tosafot-sized fragments at roughly half that.
  const tokens = [
    tok('חולין', 118),
    tok('פט.', 66),
    tok('הכל', 92),
    tok('שוחטין', 92),
    tok('רש', 30),
    tok('תוס', 34),
  ];
  const kept = filterTokensBySize(tokens).map((t) => t.text);
  assert.deepEqual(kept, ['חולין', 'פט.', 'הכל', 'שוחטין']);
});

test('filterTokensBySize no longer drops the daf number just for lacking tall letters', () => {
  // This is the regression the normalization exists to prevent: raw heights
  // 118 and 66 are a 0.56 ratio, which the old max-raw-height filter cut.
  const kept = filterTokensBySize([tok('חולין', 118), tok('פט.', 66)]).map((t) => t.text);
  assert.deepEqual(kept, ['חולין', 'פט.']);
});

test('filterTokensBySize keeps everything when all tokens are the same glyph size', () => {
  const tokens = [tok('חולין', 72), tok('פט.', 40), tok('פרק', 40)];
  const kept = filterTokensBySize(tokens).map((t) => t.text);
  assert.deepEqual(kept, ['חולין', 'פט.', 'פרק']);
});

test('filterTokensBySize keeps a token with missing/zero/non-finite height rather than dropping it', () => {
  const tokens = [
    tok('חולין', 40),
    tok('פט.', 22),
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
