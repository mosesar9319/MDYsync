// tools/test-shiur/live-engine.mjs: the live engine run offline over a whole
// recording, written as the alignment document the player loads.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { alignTranscript, buildAlignment } from '../../tools/test-shiur/live-engine.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const LM = require('../../live-matcher.js');
const LV = require('../../live-video.js');
const fixture = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'fixtures', 'live-matcher-parity.json'), 'utf8'));
// The page's paragraphs, as Sefaria names them ("Chullin 91a.3"); the fixture, written by the Python engine, uses a colon.
const paragraphs = fixture.segments.map((s) => ({ ref: s.ref.replace(/:(\d+)$/, '.$1'), he: s.he }));
const canon = LM.buildCanon(paragraphs);

// A reader reading canon words [from, from + count) aloud, two words a second, with a pause every `chunk` words.
function reading(from, count, { startAt = 10, chunk = 7 } = {}) {
  const words = [];
  let t = startAt;
  for (let i = 0; i < count; i += 1) {
    if (i && i % chunk === 0) t += 1.5; // the pause that ends a phrase
    words.push([canon.words[from + i].text, +t.toFixed(2), +(t + 0.4).toFixed(2)]);
    t += 0.5;
  }
  return words;
}

test('a stretch read aloud is placed, and the alignment says where in the daf and when', () => {
  const words = reading(100, 28);
  const { timeline } = alignTranscript({ words, paragraphs, startRef: paragraphs[0].ref.replace(/\.\d+$/, '') });
  const alignment = buildAlignment({ timeline, canon, paragraphs, videoId: 'Zsy7oDUP6Pw', videoUrl: 'https://www.youtube.com/watch?v=Zsy7oDUP6Pw', refs: ['Chullin 91a', 'Chullin 91b'], duration: 90 });
  assert.equal(alignment.schema, 'dafsync-alignment-v2');
  assert.equal(alignment.generator, 'live-video.js');
  assert.equal(alignment.videoId, 'Zsy7oDUP6Pw');
  assert.deepEqual(alignment.coveredRefs, ['Chullin 91a', 'Chullin 91b']);
  assert.ok(alignment.wordTimeline.length >= 3, `placed ${alignment.wordTimeline.length} stretches`);
  assert.ok(alignment.matchStats.matchedWords >= 20, `matched ${alignment.matchStats.matchedWords} words`);
  for (const entry of alignment.wordTimeline) {
    assert.match(entry.ref, /^Chullin 91[ab]:\d+$/, 'colon form, like the regular engine\'s');
    assert.ok(Number.isInteger(entry.w0) && entry.w1 >= entry.w0);
    assert.ok(entry.start >= 10 && entry.end >= entry.start);
  }
});

test('every paragraph of the daf is there, the unplaced ones estimated between their neighbours', () => {
  const words = reading(100, 28);
  const { timeline } = alignTranscript({ words, paragraphs });
  const alignment = buildAlignment({ timeline, canon, paragraphs, videoId: 'Zsy7oDUP6Pw', videoUrl: 'u', refs: ['Chullin 91a'] });
  const refs = new Set(alignment.segments.map((s) => s.ref));
  for (const p of paragraphs) assert.ok(refs.has(p.ref.replace(/\.(\d+)$/, ':$1')), `${p.ref} has a segment`);
  const estimated = alignment.segments.filter((s) => s.estimated);
  assert.ok(estimated.length > 0 && estimated.length < alignment.segments.length);
  for (const segment of alignment.segments) assert.ok(segment.end > segment.start, 'every segment has a positive length');
  const starts = alignment.segments.map((s) => s.start);
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b), 'in time order');
});

test('read back by the page\'s own timeline reader, the alignment gives the same places', () => {
  const words = reading(200, 21);
  const { timeline } = alignTranscript({ words, paragraphs });
  const alignment = buildAlignment({ timeline, canon, paragraphs, videoId: 'Zsy7oDUP6Pw', videoUrl: 'u', refs: ['Chullin 91a'] });
  const canonIndex = new Map(canon.words.map((w, i) => [`${w.ref}#${w.wordIndex}`, i]));
  const back = LV.timelineFromAlignment(alignment, canonIndex);
  assert.equal(back.mapped, back.total, 'every entry maps back onto the canon');
  const placedWords = (list) => list.filter((e) => e.state === 'read').reduce((n, e) => n + (e.e - e.s + 1), 0);
  assert.equal(placedWords(back.timeline), placedWords(timeline));
  const firstRead = timeline.find((e) => e.state === 'read');
  assert.ok(back.timeline.some((e) => e.s === firstRead.s && e.start === firstRead.start));
});

test('English explanation places nothing and leaves no entries', () => {
  const words = [];
  let t = 5;
  for (const w of 'so the husband had to catch a flight the next morning and he asked his wife to wake him up'.split(' ')) {
    words.push([w, t, t + 0.3]); t += 0.4;
  }
  const { timeline } = alignTranscript({ words, paragraphs });
  const alignment = buildAlignment({ timeline, canon, paragraphs, videoId: 'Zsy7oDUP6Pw', videoUrl: 'u', refs: ['Chullin 91a'] });
  assert.equal(alignment.wordTimeline.length, 0);
  assert.equal(alignment.matchStats.placedRuns, 0);
  assert.ok(alignment.matchStats.explainRuns >= 1);
  assert.ok(alignment.segments.every((s) => s.estimated), 'the whole daf is still there to read');
});
