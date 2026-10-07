// A real Live Follow session (phone microphone, Chullin 91a), replayed through
// the matcher. Run with `npm run test:functions`.
//
// tests/fixtures/live-real-session.json is the speech service's committed
// transcripts and the reader's taps, copied from the debug panel's session log
// -- the first real-world data this feature has had, and very different from
// the clean synthetic audio everything earlier was tuned on: the service
// writes the reading as things like "סוףי, מישלון" for "סופג שמונים".
//
// Two things are pinned here. (1) Everything the matcher got right in that
// session still lands exactly where it did. (2) The four placements the
// reader's own taps showed to be wrong, or that cost seconds, changed, and
// only those four.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const M = require('../../live-matcher.js');
const parity = JSON.parse(readFileSync(new URL('../fixtures/live-matcher-parity.json', import.meta.url), 'utf8'));
const real = JSON.parse(readFileSync(new URL('../fixtures/live-real-session.json', import.meta.url), 'utf8'));

const canon = M.buildCanon(parity.segments);
const listTokens = M.keytermTokens(M.buildRealtimeKeyterms(canon));

// handleCommitted's matching, minus the page: what each commit placed, and
// where the tracker's cursor stood going into it.
function replay() {
  const tracker = M.createTracker(canon, { eagerRelocalize: true });
  const out = [];
  for (const [t, kind, payload] of real.session) {
    if (kind === 'anchor') { tracker.anchor(payload); continue; }
    const heard = M.cleanTranscript(payload, listTokens);
    const runs = M.splitHebrewRuns(heard).flatMap((r) => M.chunkRun(r)).filter((r) => r.length >= M.PLACEABLE_RUN_MIN_WORDS);
    const cursorBefore = tracker.cursor;
    let placed = null;
    for (const run of runs) {
      const result = tracker.step(run, 0);
      if (['local', 'confirmed', 'jump'].includes(result.kind)) placed = [result.match.s, result.match.e];
    }
    out.push({ t, placed, cursorBefore });
  }
  return out;
}

test('the fixture is the whole session', () => {
  assert.equal(real.expectedBefore.length, 72);
  assert.equal(real.session.filter(([, kind]) => kind === 'anchor').length, 8);
});

test('every placement that was right stays exactly where it was; only the four known-bad ones change', () => {
  const now = replay();
  const changed = real.expectedBefore
    .map((before, i) => ({ t: before.t, before: before.placed, after: now[i].placed }))
    .filter((d) => JSON.stringify(d.before) !== JSON.stringify(d.after));
  assert.deepEqual(changed, [
    { t: 84.96, before: [78, 78], after: null },    // 2 garbled words matched ONE word 33 ahead
    { t: 87.77, before: [80, 82], after: [54, 56] }, // ...and the next phrase then matched the verbatim repeat, not the real spot
    { t: 272.24, before: [144, 145], after: null },  // 3 weak words, +12
    { t: 274.42, before: null, after: [127, 130] },  // ...which had hidden the correct next phrase for 8 seconds
  ]);
});

test('the reader no longer needs the tap at 100s: the highlight is already on the word they tapped', () => {
  const tap = real.session.find(([t, kind]) => kind === 'anchor' && t === 100.72)[2];
  const placement = replay().find((r) => r.t === 87.77).placed;
  assert.equal(placement[0], tap);
});

test('a garbled 2-word phrase no longer drags the cursor 33 words ahead', () => {
  const at = (t) => replay().find((r) => r.t === t);
  assert.equal(at(84.96).cursorBefore, 45);
  assert.equal(at(87.77).cursorBefore, 45, 'the cursor stayed put');
});

test('a legitimate large move on a long phrase is still followed (7+ words, +14, after a garbled phrase was skipped)', () => {
  const placed = replay().find((r) => r.t === 320.47);
  assert.deepEqual(placed.placed, [150, 156]);
  assert.equal(placed.placed[0] - placed.cursorBefore, 14);
});
