// Direct tests for scan-daf-header.mjs's pure helper, run with
// `npm run test:functions` (node --test). The handler itself needs live
// network access (GitHub, Google Vision, a real photo) and has no existing
// test coverage, same reasoning as scan-daf-page.test.mjs's own __testing
// export -- resolveLanguageHints is the one piece worth pinning down with
// synthetic input alone.

import test from 'node:test';
import assert from 'node:assert/strict';
import { __testing } from '../../netlify/functions/scan-daf-header.mjs';

const { resolveLanguageHints, tokenToFractionalBox } = __testing;

// The default is 'he', NOT the 'iw' that Google's own language-support table
// lists for Hebrew. Measured against the same rendered header image: with
// 'iw' the endpoint returned no match at 280x56, 480x96, 700x140 and even
// 1200x240, while the legacy /api/scan-daf-page pipeline -- identical except
// that it sends 'he' -- matched at score 100. See the comment on
// DEFAULT_LANGUAGE_HINT in scan-daf-header.mjs.
test('resolveLanguageHints defaults to the Hebrew hint code that Vision actually honours', () => {
  assert.deepEqual(resolveLanguageHints(undefined), ['he']);
  assert.deepEqual(resolveLanguageHints(''), ['he']);
});

test('resolveLanguageHints passes through an explicitly configured hint', () => {
  assert.deepEqual(resolveLanguageHints('he'), ['he']);
  assert.deepEqual(resolveLanguageHints('iw'), ['iw']);
});

test('resolveLanguageHints trims whitespace around a configured hint', () => {
  assert.deepEqual(resolveLanguageHints('  iw  '), ['iw']);
});

test('resolveLanguageHints treats "auto" (any case) as no hints at all', () => {
  assert.deepEqual(resolveLanguageHints('auto'), []);
  assert.deepEqual(resolveLanguageHints('AUTO'), []);
  assert.deepEqual(resolveLanguageHints('  Auto  '), []);
});

// --- tokenToFractionalBox ----------------------------------------------------

test('tokenToFractionalBox converts a centered token box (scale 1) into fractions of the crop', () => {
  // A crop 200x100; a token centered at (100, 50) sized 40x20 -- spans
  // x 80-120, y 40-60 -- as fractions of the crop that's left 0.4, top 0.4,
  // width 0.2, height 0.2.
  const box = tokenToFractionalBox({ x: 100, y: 50, width: 40, height: 20 }, 1, 200, 100);
  assert.deepEqual(box, { left: 0.4, top: 0.4, width: 0.2, height: 0.2 });
});

test('tokenToFractionalBox divides out the Vision upscale factor before computing fractions', () => {
  // Same real-world token as above, but as it would come back from a Vision
  // request against a crop upscaled 2x first -- everything (position AND
  // crop dimensions used for the division) is in that same upscaled space,
  // so the token's coordinates need dividing by the scale, not the crop
  // dimensions (those are passed in as the ORIGINAL, pre-scale size).
  const box = tokenToFractionalBox({ x: 200, y: 100, width: 80, height: 40 }, 2, 200, 100);
  assert.deepEqual(box, { left: 0.4, top: 0.4, width: 0.2, height: 0.2 });
});

test('tokenToFractionalBox returns null for a token with no real geometry', () => {
  assert.equal(tokenToFractionalBox(null, 1, 200, 100), null);
  assert.equal(tokenToFractionalBox({ x: 10, y: 10, width: undefined, height: 5 }, 1, 200, 100), null);
  assert.equal(tokenToFractionalBox({ x: NaN, y: 10, width: 5, height: 5 }, 1, 200, 100), null);
});

test('tokenToFractionalBox returns null when the crop dimensions are missing', () => {
  assert.equal(tokenToFractionalBox({ x: 10, y: 10, width: 5, height: 5 }, 1, 0, 100), null);
});
