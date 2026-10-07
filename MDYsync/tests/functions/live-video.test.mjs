// live-video.js: link parsing, phrase cutting, and aligning a word-timed
// transcript onto the daf with the same tracker the microphone modes use.
// Run with `npm run test:functions`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const LM = require('../../live-matcher.js');
const LV = require('../../live-video.js');
const fixture = JSON.parse(readFileSync(new URL('../fixtures/live-matcher-parity.json', import.meta.url), 'utf8'));
const canon = LM.buildCanon(fixture.segments);

// --- parseVideoLink -----------------------------------------------------------

test('YouTube links in every common shape reduce to one canonical watch URL', () => {
  const id = 'dQw4w9WgXcQ';
  for (const input of [
    `https://www.youtube.com/watch?v=${id}`,
    `youtube.com/watch?v=${id}&list=PL123`,
    `https://m.youtube.com/watch?v=${id}`,
    `https://youtu.be/${id}`,
    `https://youtu.be/${id}?si=abc`,
    `https://www.youtube.com/embed/${id}`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/live/${id}?feature=share`,
    `  https://www.youtube.com/watch?v=${id}  `,
  ]) {
    assert.deepEqual(LV.parseVideoLink(input), { kind: 'youtube', id, url: `https://www.youtube.com/watch?v=${id}`, startSeconds: 0 }, input);
  }
});

test('a start time on a YouTube link is carried', () => {
  const id = 'dQw4w9WgXcQ';
  assert.equal(LV.parseVideoLink(`https://youtu.be/${id}?t=90`).startSeconds, 90);
  assert.equal(LV.parseVideoLink(`https://www.youtube.com/watch?v=${id}&t=1h2m3s`).startSeconds, 3723);
  assert.equal(LV.parseVideoLink(`https://www.youtube.com/watch?v=${id}&t=2m`).startSeconds, 120);
  assert.equal(LV.parseVideoLink(`https://www.youtube.com/watch?v=${id}&t=nonsense`).startSeconds, 0);
});

test('Google Drive links, in every shape, become the address of the file itself', () => {
  const id = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';
  const file = { kind: 'media', source: 'drive', url: `https://drive.google.com/uc?export=download&id=${id}`, startSeconds: 0 };
  for (const input of [
    `https://drive.google.com/file/d/${id}/view?usp=sharing`,
    `https://drive.google.com/file/d/${id}/view`,
    `https://drive.google.com/file/d/${id}`,
    `https://drive.google.com/u/0/file/d/${id}/view`,
    `https://drive.google.com/open?id=${id}`,
    `https://drive.google.com/uc?export=download&id=${id}`,
    `https://docs.google.com/uc?id=${id}`,
    `drive.google.com/file/d/${id}/view?usp=drive_link`,
  ]) assert.deepEqual(LV.parseVideoLink(input), file, input);
  for (const bad of [
    `https://drive.google.com/drive/folders/${id}`, // a folder, not a file
    'https://drive.google.com/file/d/short/view',
    'https://drive.google.com/file/d//view',
    'https://drive.google.com/',
    `http://drive.google.com/file/d/${id}/view`,
    `https://drive.google.com.evil.example/file/d/${id}/view`,
    `https://docs.google.com/document/d/${id}/edit`, // a Google Doc
  ]) assert.equal(LV.parseVideoLink(bad), null, bad);
});

test('direct media files are accepted over https; anything else is not', () => {
  assert.deepEqual(LV.parseVideoLink('https://cdn.example.org/shiur/chullin-91.mp3'), { kind: 'media', url: 'https://cdn.example.org/shiur/chullin-91.mp3', startSeconds: 0 });
  assert.equal(LV.parseVideoLink('https://example.org/a/b.MP4?token=1').kind, 'media');
  assert.equal(LV.parseVideoLink('http://example.org/a.mp3'), null, 'plain http is not fetched');
  for (const bad of ['', '   ', 'not a link', 'https://example.org/page.html', 'https://vimeo.com/12345', 'ftp://example.org/a.mp3',
    'https://www.youtube.com/watch', 'https://www.youtube.com/watch?v=short', 'https://www.youtube.com/', 'javascript:alert(1)']) {
    assert.equal(LV.parseVideoLink(bad), null, JSON.stringify(bad));
  }
});

// --- wordsToSegments ------------------------------------------------------------

const w = (text, start, end) => ({ text, start, end });

test('phrases break at pauses, and over-long runs are cut', () => {
  const words = [w('a', 0, .3), w('b', .4, .7), w('c', 2, 2.3), w('d', 2.4, 2.7)];
  assert.deepEqual(LV.wordsToSegments(words), [
    { start: 0, end: .7, text: 'a b' },
    { start: 2, end: 2.7, text: 'c d' },
  ]);
  const long = Array.from({ length: 30 }, (_, i) => w(`x${i}`, i * .3, i * .3 + .25));
  const segments = LV.wordsToSegments(long);
  assert.ok(segments.length >= 3);
  for (const s of segments) {
    assert.ok(s.text.split(' ').length <= LV.MAX_WORDS);
    assert.ok(s.end - s.start <= LV.MAX_SECONDS + 0.3);
  }
  assert.equal(segments.map((s) => s.text).join(' '), long.map((x) => x.text).join(' '));
});

test('blank and untimed words are skipped', () => {
  assert.deepEqual(LV.wordsToSegments([w('  ', 0, 1), w('a', 1, 1.2), { text: 'b' }, w('c', 1.3, 1.5)]), [{ start: 1, end: 1.5, text: 'a c' }]);
  assert.deepEqual(LV.wordsToSegments([]), []);
});

// --- alignSegments / positionAt ---------------------------------------------------

// A reading of the daf from word `start`, `length` words at a time, one phrase
// every three seconds, as a word-timed transcript would give it.
function reading(startWord, phrases, { perPhrase = 7, secondsEach = 3, offset = 0 } = {}) {
  const words = [];
  for (let p = 0; p < phrases; p += 1) {
    const norms = fixture.canonNorms.slice(startWord + p * perPhrase, startWord + (p + 1) * perPhrase);
    norms.forEach((text, i) => words.push(w(text, offset + p * secondsEach + i * .3, offset + p * secondsEach + i * .3 + .25)));
  }
  return words;
}

test('a reading is placed phrase by phrase and the highlight follows it', () => {
  const { timeline } = LV.alignSegments(LM, canon, LV.wordsToSegments(reading(407, 4)));
  assert.equal(timeline.length, 4);
  assert.ok(timeline.every((e) => e.state === 'read'), JSON.stringify(timeline.map((e) => e.state)));
  assert.equal(timeline[0].s, 407);
  assert.equal(timeline[3].s, 407 + 21);
  for (let i = 1; i < timeline.length; i += 1) assert.ok(timeline[i].s > timeline[i - 1].s);
});

test('looking up by playhead: before, during, after, and seeking back', () => {
  const { timeline } = LV.alignSegments(LM, canon, LV.wordsToSegments(reading(407, 4, { offset: 10 })));
  assert.equal(LV.positionAt(timeline, 3).state, 'before');
  assert.equal(LV.positionAt(timeline, 3).placement, null);
  assert.equal(LV.positionAt(timeline, 10.5).placement.s, 407);
  assert.equal(LV.positionAt(timeline, 14).placement.s, 407 + 7);
  assert.equal(LV.positionAt(timeline, 1000).placement.s, 407 + 21);
  assert.equal(LV.positionAt(timeline, 10.5).placement.s, 407, 'seeking back lands on the earlier phrase again');
});

test('English explanation holds the last placed words and says so', () => {
  const words = [
    ...reading(407, 2),
    ...'so what the gemara is asking here is why does rav ashi need this case at all'.split(' ').map((t, i) => w(t, 20 + i * .3, 20.25 + i * .3)),
    ...reading(421, 2, { offset: 30 }),
  ];
  const { timeline } = LV.alignSegments(LM, canon, LV.wordsToSegments(words));
  const explain = timeline.find((e) => e.state === 'explain');
  assert.ok(explain, JSON.stringify(timeline.map((e) => e.state)));
  const mid = LV.positionAt(timeline, explain.start + 1);
  assert.equal(mid.state, 'explain');
  assert.equal(mid.placement.s, 407 + 7, 'the highlight stays on the last phrase read');
  assert.equal(LV.positionAt(timeline, 31).state, 'read');
});

test('a tapped start word locks the alignment there', () => {
  const words = reading(407, 3);
  const { timeline, tracker } = LV.alignSegments(LM, canon, LV.wordsToSegments(words), { startIndex: 407 });
  assert.equal(timeline[0].state, 'read');
  assert.equal(timeline[0].s, 407);
  assert.ok(tracker.locked);
});

test('Hebrew the daf cannot take is "unplaced" and counted in a row', () => {
  const GARBLE = 'ברכתנו ומקצתם לעיגול שפרקוד ננעמיה חלמוני'.split(' ');
  const words = [...reading(407, 2), ...GARBLE.map((t, i) => w(t, 10 + i * .3, 10.25 + i * .3)), ...GARBLE.map((t, i) => w(t, 20 + i * .3, 20.25 + i * .3))];
  const { timeline } = LV.alignSegments(LM, canon, LV.wordsToSegments(words));
  assert.equal(timeline.filter((e) => e.state === 'unplaced').length, 2, JSON.stringify(timeline.map((e) => e.state)));
  const at = LV.positionAt(timeline, 22);
  assert.equal(at.state, 'unplaced');
  assert.equal(at.unplacedRun, 2);
  assert.equal(at.placement.s, 407 + 7);
});

test('an empty transcript gives an empty timeline', () => {
  const { timeline } = LV.alignSegments(LM, canon, []);
  assert.deepEqual(timeline, []);
  assert.deepEqual(LV.positionAt(timeline, 5), { state: 'before', placement: null, index: -1, unplacedRun: 0 });
});
