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
// Phrases under DECISIVE_MIN_WORDS (6) are never trusted alone, so 5-word runs
// are what exercise the two-agreeing-matches rule; 6+ clean, unambiguous
// words are 'decisive' (see the tests further down).
function lockedTracker(at) {
  const tracker = M.createTracker(canon, { eagerRelocalize: true });
  assert.equal(tracker.step(readRun(at, 5), 0).kind, 'pending');
  assert.equal(tracker.step(readRun(at + 6, 5), 1).kind, 'confirmed');
  assert.equal(tracker.locked, true);
  assert.equal(tracker.cursor, at + 6);
  return tracker;
}

test('a short fresh phrase still needs a second agreeing match, live or not', () => {
  const tracker = M.createTracker(canon, { eagerRelocalize: true });
  const first = tracker.step(readRun(200, 5), 0);
  assert.equal(first.kind, 'pending');
  assert.equal(tracker.locked, false);
});

test('eagerRelocalize follows a jump back without waiting for 12 misses', () => {
  const tracker = lockedTracker(400);
  tracker.step(readRun(412, 6), 2); // ordinary continuation
  const decoy = tracker.step(readRun(100, 5), 3);
  assert.equal(decoy.kind, 'pending', 'a far match is held, not committed');
  assert.equal(tracker.cursor, 412, 'the highlight has not moved yet');
  const confirm = tracker.step(readRun(105, 5), 4);
  assert.equal(confirm.kind, 'confirmed');
  assert.equal(tracker.cursor, 105);
});

test('a single far decoy is dropped once reading continues where it was', () => {
  const tracker = lockedTracker(400);
  assert.equal(tracker.step(readRun(100, 5), 2).kind, 'pending');
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

// --- Trusting one decisive phrase, and pointing at the daf ------------------------

// Words 52-57 ("סוֹפֵג שְׁמוֹנִים, רַבִּי יְהוּדָה אוֹמֵר: אֵינוֹ") are repeated
// verbatim elsewhere on this daf: the real-world case a single phrase must NOT
// be trusted for. About 94% of 6-word windows here are unambiguous.
const REPEATED_PHRASE_AT = 52;

test('one long, unambiguous phrase locks a fresh session straight away', () => {
  const tracker = M.createTracker(canon, { eagerRelocalize: true });
  const result = tracker.step(readRun(200, 6), 0);
  assert.equal(result.kind, 'jump');
  assert.equal(tracker.locked, true);
  assert.equal(tracker.cursor, 200);
  assert.equal(tracker.step(readRun(206, 6), 1).kind, 'local', 'and reading continues from there');
});

test('a locked session follows a decisive phrase far beyond its search window at once', () => {
  const tracker = lockedTracker(400); // cursor 406; the local window ends near 466
  const result = tracker.step(readRun(520, 7), 2);
  assert.equal(result.kind, 'jump');
  assert.equal(tracker.cursor, 520);
  assert.equal(tracker.pending, null);
});

test('a phrase that repeats elsewhere on the daf is never trusted alone', () => {
  const run = readRun(REPEATED_PHRASE_AT, 6);
  const found = M.matchGlobalWithMargin(canon, run.map((w) => w.norm), run.map((w) => w.phon));
  assert.ok(found.margin < 10, `expected an ambiguous phrase, margin was ${found.margin}`);
  assert.equal(M.isDecisive(found, run.length), false);
  const tracker = M.createTracker(canon, { eagerRelocalize: true });
  assert.equal(tracker.step(run, 0).kind, 'pending');
  assert.equal(tracker.locked, false);
});

test('a short phrase is never decisive, however clean', () => {
  const run = readRun(300, 5);
  const found = M.matchGlobalWithMargin(canon, run.map((w) => w.norm), run.map((w) => w.phon));
  assert.ok(found.phonScore >= 99 && found.margin >= 10);
  assert.equal(M.isDecisive(found, run.length), false);
});

test('Hebrew-script speech that is not on the daf is never accepted as a jump', () => {
  const nonsense = ['ברכתנו', 'ומקצתם', 'לעיגול', 'שפרקוד', 'ננעמיה', 'חלמוני', 'דסבתקל', 'נצפדים'];
  const tracker = lockedTracker(400);
  const run = toRun(nonsense);
  assert.notEqual(tracker.step(run, 2).kind, 'jump');
  assert.equal(tracker.cursor, 406);
});

test('batch mode (matchRuns) never takes a decisive jump', () => {
  const tracker = M.createTracker(canon);
  assert.equal(tracker.step(readRun(200, 8), 0).kind, 'pending');
});

test('pointing at a word locks the tracker there, and the next phrase places without a confirmation', () => {
  const tracker = M.createTracker(canon, { eagerRelocalize: true });
  tracker.anchor(REPEATED_PHRASE_AT);
  assert.equal(tracker.locked, true);
  assert.equal(tracker.cursor, REPEATED_PHRASE_AT);
  // The repeated phrase is exactly the case automatic search cannot place.
  const result = tracker.step(readRun(REPEATED_PHRASE_AT, 4), 0);
  assert.equal(result.kind, 'local');
  assert.equal(result.match.s, REPEATED_PHRASE_AT);
});

test('a tap a few words off still lets the reading match', () => {
  const tracker = M.createTracker(canon, { eagerRelocalize: true });
  tracker.anchor(310);
  assert.equal(tracker.step(readRun(318, 5), 0).kind, 'local');
  const behind = M.createTracker(canon, { eagerRelocalize: true });
  behind.anchor(310);
  assert.equal(behind.step(readRun(302, 5), 0).kind, 'local');
});

test('pointing at a word mid-session replaces the position and drops any pending jump', () => {
  const tracker = lockedTracker(400);
  tracker.step(readRun(100, 5), 2); // a held far candidate
  assert.ok(tracker.pending);
  tracker.anchor(700);
  assert.equal(tracker.cursor, 700);
  assert.equal(tracker.pending, null);
  assert.equal(tracker.step(readRun(705, 5), 3).kind, 'local');
});

test('anchor clamps to the daf', () => {
  const tracker = M.createTracker(canon, { eagerRelocalize: true });
  tracker.anchor(-5);
  assert.equal(tracker.cursor, 0);
  tracker.anchor(canon.length + 500);
  assert.equal(tracker.cursor, canon.length - 1);
});

test('the preview takes one decisive partial as soon as it arrives, with no lock and no second partial', () => {
  const preview = M.createPreview(canon, M.createTracker(canon, { eagerRelocalize: true }));
  const m = preview.update(readRun(250, 7), 0);
  assert.ok(m);
  assert.equal(m.s, 250);
});

test('the preview does not take an ambiguous partial on its own, from a cold start', () => {
  const preview = M.createPreview(canon, M.createTracker(canon, { eagerRelocalize: true }));
  assert.equal(preview.update(readRun(REPEATED_PHRASE_AT, 6), 0), null);
});

// --- Weak far-away matches are held, not believed -------------------------------

// Garbled speech matches SOMETHING somewhere. Near the cursor that costs little;
// far from it, it moves the tracker. See LOCAL_JUMP_WORDS in live-matcher.js.
// weakRun is the daf's words with each word's last letter wrong: it still
// matches its true place, but at phonetic scores of ~72-76 -- the range the
// garbled phrases in a real phone-microphone session scored.
const garbleWord = (w) => [...w].map((c, i, all) => (i === all.length - 1 ? 'צ' : c)).join('');
function weakRun(start, length) {
  return toRun(canon.words.slice(start, start + length).map((w) => garbleWord(w.norm)));
}

test('the weak test phrases really are weak', () => {
  for (const [start, length] of [[440, 2], [440, 3], [412, 2]]) {
    const run = weakRun(start, length);
    const found = M.matchPhraseDual(canon, run.map((w) => w.norm), run.map((w) => w.phon), 406);
    assert.ok(found && found.s === start, `${start}/${length} should still match its true place`);
    assert.ok(found.phonScore < 80 && found.phonScore >= 60, `phon ${found.phonScore}`);
    assert.equal(M.strongLocal(found, length), false);
  }
});

test('a weak far-away match is held, and does not move the cursor', () => {
  const tracker = lockedTracker(400); // cursor 406
  const result = tracker.step(weakRun(440, 2), 2); // 2 words, +34: far, and far too little evidence
  assert.equal(result.kind, 'pending');
  assert.equal(result.held, true);
  assert.equal(tracker.cursor, 406);
});

test('a later phrase back near the cursor drops the held decoy', () => {
  const tracker = lockedTracker(400);
  tracker.step(weakRun(440, 2), 2);
  const next = tracker.step(readRun(412, 6), 3);
  assert.equal(next.kind, 'local');
  assert.equal(tracker.cursor, 412);
  assert.equal(tracker.step(weakRun(446, 3), 4).kind, 'pending', 'a new far weak match is held afresh, not confirmed against the dropped decoy');
});

test('a held move is believed once the next phrase carries on from it', () => {
  const tracker = lockedTracker(400);
  assert.equal(tracker.step(weakRun(440, 3), 2).kind, 'pending');
  const next = tracker.step(weakRun(443, 3), 3);
  assert.equal(next.kind, 'confirmed');
  assert.equal(tracker.cursor, 443);
});

test('a far move on strong evidence is not held', () => {
  const tracker = lockedTracker(400);
  const result = tracker.step(readRun(420, 6), 2); // +14, 6 clean words
  assert.equal(result.kind, 'local');
  assert.equal(tracker.cursor, 420);
});

test('a near move is never held, however weak', () => {
  const tracker = lockedTracker(400);
  const result = tracker.step(weakRun(412, 2), 2);
  assert.equal(result.kind, 'local');
  assert.equal(tracker.cursor, 412);
});

test('a tap drops a held move', () => {
  const tracker = lockedTracker(400);
  tracker.step(weakRun(440, 2), 2);
  tracker.anchor(500);
  assert.equal(tracker.step(weakRun(503, 2), 3).kind, 'local', 'matched around the tap, not confirmed against the stale hold');
  assert.equal(tracker.cursor, 503);
});

test('the preview ignores a weak far-away match too', () => {
  const tracker = lockedTracker(400);
  const preview = M.createPreview(canon, tracker);
  assert.equal(preview.update(weakRun(440, 3), 0), null);
  assert.ok(preview.update(readRun(412, 3), 1));
});

// --- The partial-transcript preview -------------------------------------------

test('the preview follows a long reading far past the confirmed spot with no commit', () => {
  const tracker = lockedTracker(400);
  const preview = M.createPreview(canon, tracker);
  // A 130-word reading with nothing committed: well beyond the tracker's own
  // +60-word search window, which is what used to leave the highlight blind.
  for (let i = 0; i < 26; i += 1) {
    const start = 412 + i * 5;
    const m = preview.update(readRun(start, 6), i);
    assert.ok(m, `update ${i} (words ${start}+) found nothing`);
    assert.equal(m.s, start);
  }
  assert.equal(tracker.cursor, 406, 'the confirmed position never moved');
  assert.equal(preview.cursor, 412 + 25 * 5);
});

test('the preview finds the reading before any lock, once two partials agree', () => {
  const tracker = M.createTracker(canon, { eagerRelocalize: true });
  const preview = M.createPreview(canon, tracker);
  assert.equal(preview.update(readRun(300, 5), 0), null, 'one global match is only a candidate');
  const m = preview.update(readRun(303, 5), 1);
  assert.ok(m);
  assert.equal(m.s, 303);
  assert.equal(tracker.locked, false, 'the preview never locks the tracker');
});

test('a short tail never starts a preview from nowhere', () => {
  const preview = M.createPreview(canon, M.createTracker(canon, { eagerRelocalize: true }));
  assert.equal(preview.update(readRun(300, 3), 0), null);
  assert.equal(preview.update(readRun(300, 3), 1), null);
});

test('the preview ignores a tail of fewer than 3 words, even right beside the cursor', () => {
  const tracker = lockedTracker(400);
  const preview = M.createPreview(canon, tracker);
  assert.equal(preview.update(readRun(412, 2), 0), null, 'a lone term inside English speech must not move the highlight');
  assert.equal(preview.update(readRun(412, 1), 1), null);
  assert.ok(preview.update(readRun(412, 3), 2), 'but three words are enough');
});

test('a decoy match elsewhere in the daf is not previewed on its own', () => {
  const tracker = lockedTracker(400);
  const preview = M.createPreview(canon, tracker);
  preview.update(readRun(412, 6), 0);
  for (let i = 0; i < 3; i += 1) preview.update(readRun(100, 5), i + 1); // 3 local misses: thread lost
  assert.equal(preview.cursor, null);
  assert.equal(preview.update(readRun(100, 5), 4), null, 'first global hit is only a candidate');
  assert.ok(preview.update(readRun(105, 5), 5), 'a second agreeing partial confirms the jump');
});

test('reset hands the preview back to the confirmed position', () => {
  const tracker = lockedTracker(400);
  const preview = M.createPreview(canon, tracker);
  preview.update(readRun(412, 6), 0);
  preview.update(readRun(440, 6), 1);
  assert.equal(preview.cursor, 440);
  preview.reset();
  assert.equal(preview.cursor, null);
  assert.equal(preview.update(readRun(412, 6), 2).s, 412, 'anchored to the tracker (cursor 406) again');
});

test('the preview\'s look-ahead scales with reading pace, is capped, and restarts after a jump back', () => {
  const lead = (preview, start, t) => preview.update(readRun(start, 6), t)?.lead;
  const slow = M.createPreview(canon, lockedTracker(400));
  assert.equal(lead(slow, 412, 0), 0, 'no pace can be measured from a single placement');
  assert.equal(lead(slow, 415, 1), 2, '3 words/s -> 0.8s of reading = 2 words');
  const fast = M.createPreview(canon, lockedTracker(400));
  lead(fast, 412, 0);
  assert.equal(lead(fast, 417, 1), 3, '5 words/s -> 4 words, capped at 3');
  assert.equal(lead(fast, 412, 2), 0, 'a jump back starts the pace measurement over');
  const noClock = M.createPreview(canon, lockedTracker(400));
  assert.equal(noClock.update(readRun(412, 6)).lead, 0, 'no timestamps, no look-ahead');
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

// --- Hallucinations: keyterm recitation and stuck repeats -----------------------

// Real ElevenLabs output from an end-to-end run: after the audio ended, the
// model recited the keyterm list it was given. Before the fix this commit
// moved the highlight to words 249-258 -- nowhere near where the reading was.
const LEAKED_COMMIT = 'אחר כך, במאי מסכינן, כגון דלייט בוקי זית, דתניא, אמר רבא, אמר אביי, בעי מיניה, איבעיא להו, אשי, איסור, אסור, ומזה, ליה, הכה, אחר, הכתוב, דהוה, איצטריך, אכלו, דפשיט, כאדם, שנטפל, עולא, בתרוייהו, כתיב, שנשה, דכתיב, והכן, לבדו, מגופם, שלא, אבהו, השמש, בנו, מבאר, שהתפללו, בעי, המקום, ראשו, סולם, הדדי, פרסי, שמעון, עליה, ויאמר, זמני.';
const listTokens = M.keytermTokens(M.buildRealtimeKeyterms(canon));
const hebrewWordsOf = (text) => M.splitHebrewRuns(text).flatMap((run) => run.map((w) => w.norm));

test('a recitation of the keyterm list is stripped, leaving the real words before it', () => {
  const cleaned = M.cleanTranscript(LEAKED_COMMIT, listTokens);
  assert.deepEqual(hebrewWordsOf(cleaned), ['אחר', 'כך', 'במאי', 'מסכינן', 'כגון', 'דלייט', 'בוקי', 'זית', 'דתניא']);
});

test('the recitation no longer moves the tracker', () => {
  const tracker = M.createTracker(canon, { eagerRelocalize: true });
  tracker.anchor(224);
  const cleaned = M.cleanTranscript(LEAKED_COMMIT, listTokens);
  for (const run of M.splitHebrewRuns(cleaned).flatMap((r) => M.chunkRun(r))) {
    if (run.length >= M.PLACEABLE_RUN_MIN_WORDS) tracker.step(run, 0);
  }
  assert.ok(Math.abs(tracker.cursor - 226) <= 2, `cursor jumped to ${tracker.cursor}`);
});

test('a word stuck on repeat is stripped', () => {
  const cleaned = M.cleanTranscript('כגון דלית בו איננו, איננו, איננו, איננו, כזית', listTokens);
  assert.deepEqual(hebrewWordsOf(cleaned), ['כגון', 'דלית', 'בו', 'כזית']);
});

test('real reading is left alone: ordinary phrases, a doubled word, and a short run of common terms', () => {
  for (const text of [
    phraseText(130, 12),
    phraseText(400, 9),
    'ושמע ושמע מינה מינה לכל', // a word said twice is fine
    'אמר רבא אמר אביי מאי טעמא', // adjacent common terms, but under the recitation bar
  ]) {
    assert.equal(M.cleanTranscript(text, listTokens), text, text);
  }
});

test('any stretch of the list long enough is a recitation, wherever it starts', () => {
  const some = listTokens.slice(20, 28).join(' ');
  const cleaned = M.cleanTranscript(`שלום ${some} ושלום`, listTokens);
  assert.deepEqual(hebrewWordsOf(cleaned), ['שלום', 'ושלום']);
});

function phraseText(start, length) {
  return canon.words.slice(start, start + length).map((w) => w.norm).join(' ');
}
