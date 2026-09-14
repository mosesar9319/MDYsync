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

test('amud a: position and punctuation agree (daf number left, trailing period)', () => {
  const match = matchHeader([tok('פט.', 100), tok('חולין', 400)], VOCAB);
  assert.equal(match.entry.daf, 89);
  assert.equal(match.amud, 'a');
  assert.equal(match.amudConflict, false);
});

test('amud b: position and punctuation agree (daf number right, trailing colon)', () => {
  const match = matchHeader([tok('חולין', 100), tok('פט:', 400)], VOCAB);
  assert.equal(match.entry.daf, 89);
  assert.equal(match.amud, 'b');
  assert.equal(match.amudConflict, false);
});

// The real-world case resolveAmud's own comment describes: a page can
// never actually print these two signals contradicting each other, so this
// only happens when OCR misread one of them -- e.g. a period misread as a
// colon (or vice versa) while position was read correctly. Both signals
// ARE legible here, they just disagree, so this must fail closed (null,
// conflict:true) rather than trust one arbitrarily.
test('amudConflict: position says a (daf number on the left) but punctuation says b (colon)', () => {
  const match = matchHeader([tok('פט:', 100), tok('חולין', 400)], VOCAB);
  assert.ok(match);
  assert.equal(match.entry.daf, 89); // the daf itself is still identified
  assert.equal(match.amud, null);
  assert.equal(match.amudConflict, true);
});

test('amudConflict: position says b (daf number on the right) but punctuation says a (period)', () => {
  const match = matchHeader([tok('חולין', 100), tok('פט.', 400)], VOCAB);
  assert.ok(match);
  assert.equal(match.entry.daf, 89);
  assert.equal(match.amud, null);
  assert.equal(match.amudConflict, true);
});

// A colon split into its own separate token (see the PUNCTUATION_ONLY
// tests below) leaves the winning gematria token's rawText as "פט" -- no
// trailing punctuation at all, so there is genuinely no punctuation signal
// to disagree with position. This must NOT be treated as a conflict.
test('a split-off colon token yields no punctuation signal, not a false conflict', () => {
  const match = matchHeader([tok('חולין', 100), tok('פט', 400), tok(':', 430)], VOCAB);
  assert.ok(match);
  assert.equal(match.entry.daf, 89);
  assert.equal(match.amud, 'b'); // position alone still resolves it
  assert.equal(match.amudConflict, false);
});

// No POSITION data at all here (tok() with no x/y/width/height), but the
// daf-number token still carries its trailing period -- punctuation alone
// is now enough to resolve amud when position can't (see resolveAmud's
// "use both" comment), so this is 'a', not null.
test('punctuation alone resolves amud when there is no position data at all', () => {
  const match = matchHeader([tok('חולין'), tok('פט.')], VOCAB);
  assert.equal(match.amud, 'a');
  assert.equal(match.amudConflict, false);
});

test('punctuation alone resolves amud b the same way', () => {
  const match = matchHeader([tok('חולין'), tok('פט:')], VOCAB);
  assert.equal(match.amud, 'b');
  assert.equal(match.amudConflict, false);
});

test('amud is null when NEITHER position nor punctuation carry any signal', () => {
  const match = matchHeader([tok('חולין'), tok('פט')], VOCAB);
  assert.equal(match.amud, null);
  assert.equal(match.amudConflict, false);
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

test('a colon split into its own token does not disqualify the real daf-number token', () => {
  // Some crops come back from OCR as "פט" + ":" rather than one "פט:"
  // token. The bare ":" satisfies the "ends in punctuation" test used to
  // pick out daf-number candidates, so it used to become the ONLY candidate
  // -- and it strips to the empty string, which matches no daf at all.
  // Reproduced against the live endpoint: identical crops differing only in
  // that trailing character matched with "פט." and failed with "פט:", at
  // 480px, 800px and 1200px wide alike.
  const match = matchHeader([tok('חולין', 100), tok('פט', 400), tok(':', 430)], VOCAB);
  assert.ok(match, 'expected a match despite the split-off colon');
  assert.equal(match.entry.daf, 89);
  // And the position signal still reads off the real token, not the colon.
  assert.equal(match.amud, 'b');
});

test('an attached colon still works exactly as before (the common real-photo case)', () => {
  const match = matchHeader([tok('חולין', 100), tok('פט:', 400)], VOCAB);
  assert.ok(match);
  assert.equal(match.entry.daf, 89);
  assert.equal(match.amud, 'b');
});

test('a crop of nothing but punctuation still returns no match rather than throwing', () => {
  assert.equal(matchHeader([tok('.', 10), tok(':', 20)], VOCAB), null);
});
