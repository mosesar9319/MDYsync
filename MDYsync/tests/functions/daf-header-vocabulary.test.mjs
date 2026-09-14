// Direct tests for the daf-header vocabulary matcher, run with
// `npm run test:functions` (node --test). Covers two things:
//  1. Regression: matchHeader's text-matching still works the same way now
//     that it takes structured {text, x} tokens instead of a flat OCR
//     string (see the switch to support amud detection).
//  2. The new amud-from-header-layout detection itself (resolveAmud,
//     exercised only through matchHeader's own public `amud` field) --
//     daf number left of the tractate name means amud a, right means b,
//     and anything ambiguous falls back to no signal (null) rather than a
//     guess.

import test from 'node:test';
import assert from 'node:assert/strict';
import { matchHeader, buildHeaderVocabulary, toGematria } from '../../shared/daf-header-vocabulary.mjs';

const VOCAB = buildHeaderVocabulary([
  { tractate: 'Chullin', daf: 89 },
  { tractate: 'Chullin', daf: 86 },
  { tractate: 'Chullin', daf: 100 },
]);

function tok(text, x, y, width, height) {
  return { text, x, y, width, height };
}

test('matches a clean header (tractate + gematria tokens, no position data)', () => {
  const match = matchHeader([tok('חולין'), tok('פט.')], VOCAB);
  assert.ok(match);
  assert.equal(match.entry.tractate, 'Chullin');
  assert.equal(match.entry.daf, 89);
});

test('matches regardless of which token comes first in the OCR stream', () => {
  const forward = matchHeader([tok('חולין'), tok('פט.')], VOCAB);
  const reversed = matchHeader([tok('פט.'), tok('חולין')], VOCAB);
  assert.equal(forward.entry.daf, 89);
  assert.equal(reversed.entry.daf, 89);
});

test('returns null below minScore and on a too-close runner-up, same as before', () => {
  assert.equal(matchHeader([tok('בכלל לא קשור')], VOCAB), null);
  // "ק" (100) is a real prefix of "קא" (101) -- not in VOCAB here, but confirms
  // an unmatchable, low-signal token still fails closed.
  assert.equal(matchHeader([tok('ק')], VOCAB), null);
});

test('amud a: the gematria token sits to the left of the tractate name', () => {
  const match = matchHeader([tok('פט.', 100), tok('חולין', 400)], VOCAB);
  assert.equal(match.entry.daf, 89);
  assert.equal(match.amud, 'a');
});

test('amud b: the gematria token sits to the right of the tractate name', () => {
  const match = matchHeader([tok('חולין', 100), tok('פט:', 400)], VOCAB);
  assert.equal(match.entry.daf, 89);
  assert.equal(match.amud, 'b');
});

test('amud is null when tokens carry no position data at all', () => {
  const match = matchHeader([tok('חולין'), tok('פט.')], VOCAB);
  assert.equal(match.amud, null);
});

test('amud is null when the same token would have to win both comparisons', () => {
  const selfVocab = [{ tractate: 'Weird', daf: 1, hebrew: 'קא', gematria: 'קא' }];
  const match = matchHeader([tok('קא', 50)], selfVocab, 0, 0);
  assert.ok(match);
  assert.equal(match.amud, null);
});

test('toGematria still produces the printed forms amud detection relies on', () => {
  assert.equal(toGematria(89), 'פט');
  assert.equal(toGematria(15), 'טו'); // special-cased, not the literal יה
});

// --- hebrewScore/gematriaScore/hebrewToken/gematriaToken --------------------
// Added for scan-daf-header.mjs's stricter per-field confidence check (a
// bare passing `score` can hide one illegible half averaged against an
// accidentally-similar other-candidate score) and for its matchedWords
// highlight boxes.

test('a clean match reports both per-field scores near 100 and the winning tokens', () => {
  const match = matchHeader([tok('חולין', 400, 10, 80, 20), tok('פט.', 100, 10, 40, 20)], VOCAB);
  assert.ok(match.hebrewScore > 90);
  assert.ok(match.gematriaScore > 90);
  assert.equal(match.hebrewToken.text, 'חולין');
  assert.equal(match.gematriaToken.text, 'פט');
});

test('a header with only the daf number legible still WINS overall (score) but fails the per-field floor', () => {
  // No real tractate-name token at all -- just a short, semi-Hebrew-looking
  // noise fragment (a real credit-line abbreviation, "תוס" -- see
  // gematriaCandidates' own comment on stray margin-annotation fragments)
  // that happens to fuzzy-match "חולין" just well enough, on top of a
  // clean, confident daf-number read, to clear the averaged minScore/
  // minMargin gate outright. The averaged `score` alone doesn't reveal that
  // the tractate name itself was never actually read; hebrewScore does.
  const match = matchHeader([tok('פט.', 100), tok('תוס', 400)], VOCAB);
  assert.ok(match); // still returns a match -- the averaged score clears minScore/minMargin
  assert.ok(match.gematriaScore > 90);
  assert.ok(match.hebrewScore < 40); // this is the signal a caller has to check separately
});

test('hebrewToken/gematriaToken carry through y/width/height for highlight boxes', () => {
  const match = matchHeader([tok('חולין', 400, 20, 80, 24), tok('פט.', 100, 22, 40, 22)], VOCAB);
  assert.equal(match.hebrewToken.y, 20);
  assert.equal(match.hebrewToken.width, 80);
  assert.equal(match.hebrewToken.height, 24);
  assert.equal(match.gematriaToken.y, 22);
});
