// live-matcher.js (Live Follow's matcher) against the Python matcher it was
// ported from. Run with `npm run test:functions`.
//
// Two kinds of guard against the JS and Python copies drifting apart:
//   1. Parity: tests/fixtures/live-matcher-parity.json holds outputs the
//      real voice_align.py code produced on real Sefaria text (see
//      tools/caption-sync/gen_live_matcher_parity.py). Regenerate it after
//      changing the Python matcher; these tests then show what the JS port
//      needs to follow.
//   2. Constants: voice_align.py's own tuning constants are read straight
//      out of its source, so retuning a floor there fails here immediately,
//      even before anyone regenerates the fixture.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const M = require('../../live-matcher.js');
const fixture = JSON.parse(readFileSync(new URL('../fixtures/live-matcher-parity.json', import.meta.url), 'utf8'));
const voiceAlignSource = readFileSync(new URL('../../tools/caption-sync/voice_align.py', import.meta.url), 'utf8');

const canon = M.buildCanon(fixture.segments);

function pyConstant(name) {
  const match = new RegExp(`^${name} = (\\d+)`, 'm').exec(voiceAlignSource);
  assert.ok(match, `${name} not found in voice_align.py`);
  return Number(match[1]);
}
function pyStrings(blockStart) {
  const start = voiceAlignSource.indexOf(blockStart);
  assert.ok(start >= 0, `${blockStart} not found in voice_align.py`);
  const close = voiceAlignSource.indexOf(blockStart.endsWith('{') ? '}' : ']', start);
  return [...voiceAlignSource.slice(start, close).matchAll(/"([^"]*)"/g)].map((m) => m[1]);
}
function sameMatch(actual, expected, label) {
  if (expected === null) {
    assert.equal(actual, null, `${label}: expected no match`);
    return;
  }
  assert.ok(actual, `${label}: expected a match at [${expected[0]}-${expected[1]}]`);
  assert.deepEqual([actual.s, actual.e], [expected[0], expected[1]], `${label}: wrong span`);
  assert.equal(actual.phonScore, expected[2], `${label}: phonetic score`);
  assert.equal(actual.charScore, expected[3], `${label}: character score`);
}
const toRun = (norms) => norms.map((norm) => ({ norm, phon: M.phonetic(norm) }));

// --- Constants ---------------------------------------------------------------

test('matcher constants match voice_align.py', () => {
  for (const name of ['BACK_WINDOW', 'FWD_WINDOW', 'MIN_SCORE', 'MIN_SCORE_GLOBAL', 'MIN_SCORE_SINGLE', 'CHAR_FLOOR', 'RELOCALIZE_AFTER']) {
    assert.equal(M[name], pyConstant(name), name);
  }
});

test('phonetic classes match voice_align.py\'s built-in defaults', () => {
  const line = /classes = \[(.*)\]\n/.exec(voiceAlignSource);
  assert.ok(line, 'built-in phonetic classes line not found');
  const pairs = [...line[1].matchAll(/\("([^"]+)", "([^"]+)"\)/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(M.PHONETIC_CLASSES, pairs);
});

test('keyterm word lists match voice_align.py', () => {
  assert.deepEqual(M.COMMON_GEMARA_TERMS, pyStrings('COMMON_GEMARA_TERMS = ['));
  assert.deepEqual([...M.KEYTERM_STOPWORDS], pyStrings('_KEYTERM_STOPWORDS = {'));
});

// --- Parity with the Python matcher --------------------------------------------

test('buildCanon reproduces load_canonical\'s normalized word list on real Sefaria text', () => {
  assert.deepEqual(canon.words.map((w) => w.norm), fixture.canonNorms);
});

test('normalizeWord and phonetic match the Python helpers', () => {
  for (const { raw, norm, phon } of fixture.normalize) {
    assert.equal(M.normalizeWord(raw), norm, `normalize ${JSON.stringify(raw)}`);
    assert.equal(M.phonetic(M.normalizeWord(raw)), phon, `phonetic ${JSON.stringify(raw)}`);
  }
});

test('ratio matches rapidfuzz fuzz.ratio exactly', () => {
  for (const { a, b, ratio } of fixture.ratio) assert.equal(M.ratio(a, b), ratio, `${a} / ${b}`);
});

test('matchPhraseDual matches match_phrase_dual: local, global and windowed searches', () => {
  fixture.phrases.forEach((c, i) => {
    sameMatch(M.matchPhraseDual(canon, c.hlNorm, c.hlPhon, c.cursor), c.local, `case ${i} local`);
    sameMatch(M.matchPhraseDual(canon, c.hlNorm, c.hlPhon, c.cursor, { global: true }), c.global, `case ${i} global`);
    sameMatch(M.matchPhraseDual(canon, c.hlNorm, c.hlPhon, c.cursor, { window: c.window }), c.windowed, `case ${i} window`);
  });
});

test('matchPhraseDual breaks exact score ties between window sizes the way Python\'s set order does', () => {
  assert.ok(fixture.tieBreaks.length > 0);
  fixture.tieBreaks.forEach((c, i) => {
    const tieCanon = M.buildCanon([{ ref: 'synthetic', he: c.canonNorms.join(' ') }]);
    sameMatch(M.matchPhraseDual(tieCanon, c.hlNorm, c.hlPhon, c.cursor, { global: c.global }), c.expected, `tie case ${i}`);
  });
});

test('matchRuns reproduces match_runs over simulated shiurim', () => {
  fixture.sequences.forEach((sequence, i) => {
    const actual = M.matchRuns(canon, sequence.runs.map(toRun));
    assert.deepEqual(actual, sequence.expected, `sequence ${i}`);
  });
});

test('buildKeytermList matches build_keyterm_list', () => {
  assert.deepEqual(M.buildKeytermList(canon, 38), fixture.keyterms38);
});

// --- Live-only behaviour ------------------------------------------------------

function readRun(start, length) {
  return toRun(canon.words.slice(start, start + length).map((w) => w.norm));
}
function lockedTracker(at) {
  const tracker = M.createTracker(canon, { eagerRelocalize: true });
  assert.equal(tracker.step(readRun(at, 6), 0).kind, 'pending');
  assert.equal(tracker.step(readRun(at + 6, 6), 1).kind, 'confirmed');
  assert.equal(tracker.locked, true);
  return tracker;
}

test('a fresh lock still needs two agreeing matches, live or not', () => {
  const tracker = M.createTracker(canon, { eagerRelocalize: true });
  const first = tracker.step(readRun(200, 6), 0);
  assert.equal(first.kind, 'pending');
  assert.equal(tracker.locked, false);
});

test('eagerRelocalize follows a jump back without waiting for 12 misses', () => {
  const tracker = lockedTracker(400);
  tracker.step(readRun(412, 6), 2); // ordinary continuation
  const decoy = tracker.step(readRun(100, 6), 3);
  assert.equal(decoy.kind, 'pending', 'a far match is held, not committed');
  assert.equal(tracker.cursor, 412, 'the highlight has not moved yet');
  const confirm = tracker.step(readRun(106, 6), 4);
  assert.equal(confirm.kind, 'confirmed');
  assert.equal(tracker.cursor, 106);
});

test('a single far decoy is dropped once reading continues where it was', () => {
  const tracker = lockedTracker(400);
  assert.equal(tracker.step(readRun(100, 6), 2).kind, 'pending');
  const resumed = tracker.step(readRun(412, 6), 3);
  assert.equal(resumed.kind, 'local');
  assert.equal(tracker.pending, null);
  assert.equal(tracker.cursor, 412);
});

test('batch mode (matchRuns) does not relocalize early', () => {
  const tracker = M.createTracker(canon);
  tracker.step(readRun(400, 6), 0);
  tracker.step(readRun(406, 6), 1);
  assert.equal(tracker.locked, true);
  assert.equal(tracker.step(readRun(100, 6), 2).kind, 'miss');
});

test('peek never moves the cursor', () => {
  const tracker = lockedTracker(400);
  const before = tracker.cursor;
  assert.ok(tracker.peek(readRun(414, 4)));
  assert.equal(tracker.cursor, before);
  assert.equal(M.createTracker(canon).peek(readRun(0, 4)), null, 'nothing to peek from before a lock');
});

test('splitHebrewRuns breaks runs on English and keeps Hebrew order', () => {
  const runs = M.splitHebrewRuns('so the Gemara says אמר רב יהודה אמר שמואל, and then מאי טעמא');
  assert.deepEqual(runs.map((r) => r.map((w) => w.norm)), [['אמר', 'רב', 'יהודה', 'אמר', 'שמואל'], ['מאי', 'טעמא']]);
});

test('chunkRun splits evenly and never leaves a lone trailing word', () => {
  const run = readRun(0, 13);
  assert.deepEqual(M.chunkRun(run, 10).map((c) => c.length), [7, 6]);
  assert.deepEqual(M.chunkRun(readRun(0, 10), 10).map((c) => c.length), [10]);
  assert.deepEqual(M.chunkRun(readRun(0, 21), 10).map((c) => c.length), [7, 7, 7]);
});

test('realtime keyterms respect ElevenLabs\' 50-term / 20-character caps with no duplicates', () => {
  const terms = M.buildRealtimeKeyterms(canon);
  assert.ok(terms.length <= 50 && terms.length > M.COMMON_GEMARA_TERMS.length);
  assert.ok(terms.every((t) => t.length <= 20));
  assert.equal(new Set(terms).size, terms.length);
  assert.deepEqual(terms.slice(0, M.COMMON_GEMARA_TERMS.length), M.COMMON_GEMARA_TERMS);
});

test('a global search over a full daf stays fast enough to run per utterance', () => {
  const run = readRun(500, M.LIVE_MAX_RUN_WORDS);
  const started = performance.now();
  M.matchPhraseDual(canon, run.map((w) => w.norm), run.map((w) => w.phon), 0, { global: true });
  assert.ok(performance.now() - started < 250, 'global search took too long');
});
