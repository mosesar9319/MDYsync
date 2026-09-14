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

function tok(text, x) {
  return { text, x };
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
