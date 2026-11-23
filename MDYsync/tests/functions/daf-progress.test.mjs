import test from 'node:test';
import assert from 'node:assert/strict';
import { dafProgress, heardMostOf, mergeRanges, placeOf, shiurCoverage, wordCounts } from '../../shared/daf-progress.mjs';

// A made-up masechta with small dapim: every amud is 5 paragraphs of 20
// words (100 words), and a maggid reads one paragraph every 10 seconds, each
// in two halves. `shiur` builds a sync file reading from one word of the daf
// to another, with a stretch of announcements before and after.
const PARAGRAPH = 20;
const AMUD = 100;
function shiur({ from, to, lead = 30, skip = [] }) {
  // from/to: [daf, 'a'|'b', offset] inclusive.
  const order = (daf, amud) => daf * 2 + (amud === 'b' ? 1 : 0);
  const first = order(from[0], from[1]) * AMUD + from[2];
  const last = order(to[0], to[1]) * AMUD + to[2];
  const segments = [];
  // Every word of every amud touched is listed, as a sync file lists them;
  // the ones outside what is read, or skipped, are estimated.
  const firstAmud = Math.floor(first / AMUD);
  const lastAmud = Math.floor(last / AMUD);
  let clock = lead;
  for (let amud = firstAmud; amud <= lastAmud; amud += 1) {
    const name = `Tester ${Math.floor(amud / 2)}${amud % 2 ? 'b' : 'a'}`;
    for (let n = 1; n <= AMUD / PARAGRAPH; n += 1) {
      for (const [w0, w1] of [[0, 9], [10, 19]]) {
        const lo = amud * AMUD + (n - 1) * PARAGRAPH + w0;
        const hi = amud * AMUD + (n - 1) * PARAGRAPH + w1;
        const read = hi >= first && lo <= last;
        const skipped = skip.some(([a, b]) => lo >= a && hi <= b);
        const a = Math.max(lo, first) - (amud * AMUD + (n - 1) * PARAGRAPH);
        const b = Math.min(hi, last) - (amud * AMUD + (n - 1) * PARAGRAPH);
        if (read && !skipped) {
          segments.push({ ref: `${name}:${n}`, start: clock, end: clock + 4, w0: a, w1: b });
          if (a > w0) segments.push({ ref: `${name}:${n}`, start: clock, end: clock, w0, w1: a - 1, estimated: true });
          if (b < w1) segments.push({ ref: `${name}:${n}`, start: clock + 4, end: clock + 4, w0: b + 1, w1, estimated: true });
          clock += 5;
        } else {
          segments.push({ ref: `${name}:${n}`, start: clock, end: clock, w0, w1, estimated: true });
        }
      }
    }
  }
  return { segments, reading: [lead, clock], duration: clock + 60 };
}

// A row of the learning table for a shiur on `daf`, heard over `ranges`.
function record(daf, file, ranges, more = {}) {
  const coverage = shiurCoverage(file.segments, ranges);
  return { shiur_key: `default:en:regular:Tester:${daf}`, tractate: 'Tester', daf, maggid: 'default', variant: 'regular', language: 'en',
    position_seconds: Math.max(0, ...ranges.map((r) => r[1])), duration_seconds: file.duration, ...coverage, ...more };
}
const whole = (file) => [[0, file.duration]];

test('stretches of time are merged, and a shiur with no sync is heard when nearly all of it was', () => {
  assert.deepEqual(mergeRanges([[10, 20], [0, 5], [19, 30], [5.5, 9.5]], 0.75), [[0, 30]]);
  assert.deepEqual(mergeRanges([[4, 6], [0, 2]], 1), [[0, 2], [4, 6]]);
  assert.equal(heardMostOf([[0, 1700], [1750, 3500]], 3600), true);
  assert.equal(heardMostOf([[0, 1700]], 3600), false);
});

test('a sync file gives the words of each paragraph, and a place for any word', () => {
  const file = shiur({ from: [6, 'a', 0], to: [6, 'b', 99] });
  const counts = wordCounts(file.segments);
  assert.deepEqual(counts['Tester 6a'], [20, 20, 20, 20, 20]);
  assert.deepEqual(placeOf(counts['Tester 6a'], 45), { n: 3, w: 5 });
  assert.equal(placeOf(counts['Tester 6a'], 100), null);
});

test('a shiur heard to its end covers what the maggid read, not the announcements', () => {
  const file = shiur({ from: [6, 'a', 0], to: [6, 'b', 99] });
  const all = shiurCoverage(file.segments, whole(file));
  assert.equal(all.finished, true);
  assert.deepEqual(all.reads, { 'Tester 6a': [0, 99], 'Tester 6b': [0, 99] });
  assert.deepEqual(all.heard, { 'Tester 6a': [[0, 99]], 'Tester 6b': [[0, 99]] });
  // Leaving at the last line read, before the announcements: still finished.
  assert.equal(shiurCoverage(file.segments, [[0, file.reading[1]]]).finished, true);
  // Half of it: not finished, and only the first amud heard.
  const half = shiurCoverage(file.segments, [[0, file.reading[0] + 50]]);
  assert.equal(half.finished, false);
  assert.deepEqual(half.heard, { 'Tester 6a': [[0, 99]] });
  // Skimming through with the seek bar hears nothing.
  assert.deepEqual(shiurCoverage(file.segments, [[40, 40.4], [80, 80.3], [120, 120.2]]).heard, {});
});

test('words the maggid skips inside a stretch that was listened through are not held against the learner', () => {
  // Amud a's third paragraph is never placed (skipped, or the sync missed it).
  const file = shiur({ from: [6, 'a', 0], to: [6, 'b', 99], skip: [[6 * 2 * AMUD + 40, 6 * 2 * AMUD + 59]] });
  assert.deepEqual(shiurCoverage(file.segments, whole(file)).heard['Tester 6a'], [[0, 99]]);
  const progress = dafProgress({ tractate: 'Tester', daf: 6, records: [record(6, file, whole(file))] });
  assert.equal(progress.status, 'done');
});

test('the rule: a finished shiur that stops 20 words short of the end of amud b still completes the daf', () => {
  const sixth = shiur({ from: [6, 'a', 0], to: [6, 'b', 79] });
  const progress = dafProgress({ tractate: 'Tester', daf: 6, records: [record(6, sixth, whole(sixth))] });
  assert.equal(progress.status, 'done');
  assert.equal(progress.percent, 1);
  assert.deepEqual(progress.gaps, []);
  // The 20 words are remembered as allowed for now.
  assert.deepEqual(progress.tail, { amud: 'Tester 6b', from: 80, count: 20 });
});

test('the rule: the next day with the same maggid, whose shiur opens with those 20 words, keeps it complete', () => {
  const sixth = shiur({ from: [6, 'a', 0], to: [6, 'b', 79] });
  const seventh = shiur({ from: [6, 'b', 80], to: [7, 'b', 99] });
  const records = [record(6, sixth, whole(sixth)), record(7, seventh, whole(seventh))];
  const six = dafProgress({ tractate: 'Tester', daf: 6, records });
  assert.equal(six.status, 'done');
  assert.equal(six.tail, null);
  assert.equal(dafProgress({ tractate: 'Tester', daf: 7, records }).status, 'done');
});

test('the rule: the next day with another maggid, who opens at the last 12 words, leaves 8 words outstanding', () => {
  const sixth = shiur({ from: [6, 'a', 0], to: [6, 'b', 79] });
  const other = shiur({ from: [6, 'b', 88], to: [7, 'b', 99] });
  const records = [record(6, sixth, whole(sixth)), record(7, other, whole(other), { shiur_key: 'bornstein:en:regular:Tester:7', maggid: 'bornstein' })];
  const six = dafProgress({ tractate: 'Tester', daf: 6, records });
  assert.equal(six.status, 'gap');
  assert.equal(six.outstanding, 8);
  // Words 80-87 of amud b: the fifth paragraph, from its first word.
  assert.deepEqual(six.gaps, [{ amud: 'Tester 6b', from: 80, to: 87, count: 8, n: 5, w: 0 }]);
  assert.equal(six.tail, null);
  assert.equal(dafProgress({ tractate: 'Tester', daf: 7, records }).status, 'done');
});

test('the gap closes when the eight words are heard, in whichever shiur reads them', () => {
  const sixth = shiur({ from: [6, 'a', 0], to: [6, 'b', 79] });
  const other = shiur({ from: [6, 'b', 88], to: [7, 'b', 99] });
  const own = shiur({ from: [6, 'b', 80], to: [7, 'b', 99] });
  // The first maggid's next shiur, heard only for its opening lines.
  const opening = record(7, own, [[0, own.reading[0] + 12]]);
  const records = [record(6, sixth, whole(sixth)), record(7, other, whole(other), { shiur_key: 'bornstein:en:regular:Tester:7', maggid: 'bornstein' }), opening];
  assert.equal(dafProgress({ tractate: 'Tester', daf: 6, records }).status, 'done');
});

test('a next-day shiur that opens on the new daf leaves the whole tail outstanding', () => {
  const sixth = shiur({ from: [6, 'a', 0], to: [6, 'b', 79] });
  const fresh = shiur({ from: [7, 'a', 0], to: [7, 'b', 99] });
  const six = dafProgress({ tractate: 'Tester', daf: 6, records: [record(6, sixth, whole(sixth)), record(7, fresh, whole(fresh))] });
  assert.equal(six.status, 'gap');
  assert.equal(six.outstanding, 20);
});

test('a shiur left in the middle: in progress, and up to the first word not heard', () => {
  const sixth = shiur({ from: [6, 'a', 0], to: [6, 'b', 99] });
  // Thirteen half-paragraphs heard: 130 words, up to amud b's second paragraph, word 10.
  const progress = dafProgress({ tractate: 'Tester', daf: 6, records: [record(6, sixth, [[0, sixth.reading[0] + 13 * 5]])] });
  assert.equal(progress.status, 'partial');
  assert.equal(progress.learned, 130);
  assert.equal(progress.percent, 0.65);
  assert.equal(progress.tail, null);
  assert.deepEqual(progress.gaps, [{ amud: 'Tester 6b', from: 30, to: 99, count: 70, n: 2, w: 10 }]);
});

test('a stretch skipped with the seek bar is a gap, even in a shiur heard to its end', () => {
  const sixth = shiur({ from: [6, 'a', 0], to: [6, 'b', 99] });
  const [from, to] = sixth.reading;
  // Left after 40 words, came back for the last 120.
  const progress = dafProgress({ tractate: 'Tester', daf: 6, records: [record(6, sixth, [[0, from + 20], [from + 40, to]])] });
  assert.equal(progress.status, 'gap');
  assert.deepEqual(progress.gaps, [{ amud: 'Tester 6a', from: 40, to: 79, count: 40, n: 3, w: 0 }]);
  // Skipping most of it is not "a few words left".
  const most = dafProgress({ tractate: 'Tester', daf: 6, records: [record(6, sixth, [[0, from + 10], [to - 10, to]])] });
  assert.equal(most.status, 'partial');
});

test('hearing the end of yesterday’s daf at the start of today’s shiur does not start yesterday’s daf', () => {
  const seventh = shiur({ from: [6, 'b', 80], to: [7, 'b', 99] });
  const records = [record(7, seventh, whole(seventh))];
  const six = dafProgress({ tractate: 'Tester', daf: 6, records });
  assert.equal(six.started, false);
  assert.equal(six.status, 'none');
  assert.equal(dafProgress({ tractate: 'Tester', daf: 7, records }).status, 'done');
});

test('two shiurim on one daf add up', () => {
  const sixth = shiur({ from: [6, 'a', 0], to: [6, 'b', 99] });
  const [from, to] = sixth.reading;
  const first = record(6, sixth, [[0, from + 50]]);
  const second = record(6, sixth, [[from + 50, to]], { shiur_key: 'bornstein:en:regular:Tester:6', maggid: 'bornstein' });
  assert.equal(dafProgress({ tractate: 'Tester', daf: 6, records: [first] }).status, 'partial');
  const both = dafProgress({ tractate: 'Tester', daf: 6, records: [first, second] });
  assert.equal(both.status, 'done');
  assert.deepEqual(both.shiurim.map((s) => s.maggid), ['bornstein', 'default']);
});

test('a daf marked by hand is done; a shiur with no sync goes by the shiur itself', () => {
  const marked = dafProgress({ tractate: 'Tester', daf: 6, records: [{ shiur_key: 'manual:Tester:6', tractate: 'Tester', daf: 6, manual: true }] });
  assert.equal(marked.status, 'done');
  assert.equal(marked.manual, true);
  const plain = { shiur_key: 'default:en:regular:Tester:6', tractate: 'Tester', daf: 6, heard: {}, reads: {}, words: {}, position_seconds: 900, duration_seconds: 3600 };
  const part = dafProgress({ tractate: 'Tester', daf: 6, records: [plain] });
  assert.equal(part.status, 'partial');
  assert.equal(part.percent, 0.25);
  assert.equal(part.known, false);
  assert.equal(dafProgress({ tractate: 'Tester', daf: 6, records: [{ ...plain, finished: true }] }).status, 'done');
  assert.equal(dafProgress({ tractate: 'Tester', daf: 6, records: [] }).status, 'none');
  // Another masechta's records do not count.
  assert.equal(dafProgress({ tractate: 'Other', daf: 6, records: [plain] }).status, 'none');
});
