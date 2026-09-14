// Direct tests for filterTokensBySize (shared/vision-header-ocr.mjs), run
// with `npm run test:functions` (node --test). extractHeaderTokens/
// extractTesseractTokens are already covered indirectly via
// tests/functions/scan-daf-page.test.mjs's __testing re-export; this file
// covers the one piece that's new here and directly exported.

import test from 'node:test';
import assert from 'node:assert/strict';
import { filterTokensBySize } from '../../shared/vision-header-ocr.mjs';

function tok(text, height) {
  return { text, x: 0, y: 0, width: 10, height };
}

test('filterTokensBySize keeps tokens at or above the default 0.6 relative-height floor', () => {
  // 40 is the tallest -- 24 is exactly 0.6 of it (kept), 23 is just under
  // (dropped), a real Rashi/Tosafot-sized fragment (12, well under 0.6 of
  // 40) is dropped too.
  const tokens = [tok('חולין', 40), tok('פט.', 24), tok('borderline', 23), tok('רש', 12)];
  const kept = filterTokensBySize(tokens).map((t) => t.text);
  assert.deepEqual(kept, ['חולין', 'פט.']);
});

test('filterTokensBySize keeps everything when all tokens are roughly the same size', () => {
  const tokens = [tok('חולין', 38), tok('פט.', 40), tok('פרק', 36)];
  const kept = filterTokensBySize(tokens).map((t) => t.text);
  assert.deepEqual(kept, ['חולין', 'פט.', 'פרק']);
});

test('filterTokensBySize keeps a token with missing/zero/non-finite height rather than dropping it', () => {
  const tokens = [
    tok('חולין', 40),
    { text: 'no-height', x: 0, y: 0, width: 10, height: undefined },
    { text: 'zero-height', x: 0, y: 0, width: 10, height: 0 },
    { text: 'nan-height', x: 0, y: 0, width: 10, height: NaN },
  ];
  const kept = filterTokensBySize(tokens).map((t) => t.text);
  assert.deepEqual(kept, ['חולין', 'no-height', 'zero-height', 'nan-height']);
});

test('filterTokensBySize is a no-op (returns tokens unfiltered) when no token has usable height at all', () => {
  const tokens = [{ text: 'a', height: undefined }, { text: 'b', height: NaN }];
  assert.deepEqual(filterTokensBySize(tokens), tokens);
});

test('filterTokensBySize respects a custom minRelativeHeight', () => {
  const tokens = [tok('big', 100), tok('half', 50), tok('quarter', 25)];
  // A strict 0.9 floor keeps only the tallest.
  assert.deepEqual(filterTokensBySize(tokens, 0.9).map((t) => t.text), ['big']);
  // A permissive 0.2 floor keeps everything here.
  assert.deepEqual(filterTokensBySize(tokens, 0.2).map((t) => t.text), ['big', 'half', 'quarter']);
});

test('filterTokensBySize never mutates the input array', () => {
  const tokens = [tok('a', 40), tok('b', 5)];
  const before = tokens.length;
  filterTokensBySize(tokens);
  assert.equal(tokens.length, before);
});
