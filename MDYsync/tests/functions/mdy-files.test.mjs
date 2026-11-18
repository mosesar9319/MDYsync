// mdy-files.js: which of MDY's own files plays a shiur, and when the player
// should not trust it. No browser, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { MASECHTOS } from '../../shared/masechtos.mjs';
import { mdyAudioUrl, dafOfReadings } from '../../tools/mdy-audio.mjs';

const require = createRequire(import.meta.url);
const M = require('../../mdy-files.js');

const ref = (tractate, daf, extra = {}) => ({ tractate, daf, amud: 'a', variant: 'regular', language: 'en', maggid: null, ...extra });

test('every masechta is spelled the way dafsync.com spells it, which is how MDY does', () => {
  assert.deepEqual(M.MASECHTA_SLUGS, Object.fromEntries(MASECHTOS.map((m) => [m.name, m.slug])));
});

test('the address of each kind of shiur, in each quality', () => {
  const title = "Daf Yomi Chullin Daf 86 by R' Eli Stefansky";
  assert.equal(M.fileUrl(ref('Chullin', 86), { title, quality: '720' }), 'https://cdn.mdydaf.com/shiur/english/chullin/720/86.mp4');
  assert.equal(M.fileUrl(ref('Chullin', 86), { title, quality: '360' }), 'https://cdn.mdydaf.com/shiur/english/chullin/360/86.mp4');
  assert.equal(M.fileUrl(ref('Chullin', 86), { title, quality: '1080' }), 'https://cdn.mdydaf.com/shiur/english/chullin/1080/86.mp4');
  assert.equal(M.fileUrl(ref('Chullin', 86), { title, quality: 'audio' }), 'https://cdn.mdydaf.com/shiur/english/chullin/mp3/86.mp3');
  // The Chazarah Daf is MDY's "Nothing But The Daf".
  assert.equal(M.fileUrl(ref('Bekhorot', 60, { variant: 'chazarah', language: 'he' }), { quality: '360' }),
    'https://cdn.mdydaf.com/nbtd/hebrew/bechoros/360/60.mp4');
  // An unknown quality is 720p.
  assert.equal(M.fileUrl(ref('Bekhorot', 60), { quality: '4k' }), 'https://cdn.mdydaf.com/shiur/english/bechoros/720/60.mp4');
  assert.equal(M.posterUrl(ref('Bekhorot', 60)), 'https://cdn.mdydaf.com/shiur/english/bechoros/thumb/60.png');
  assert.equal(M.qualityOfUrl('https://cdn.mdydaf.com/shiur/english/chullin/mp3/86.mp3'), 'audio');
  assert.equal(M.qualityOfUrl('https://cdn.mdydaf.com/shiur/english/chullin/360/86.mp4'), '360');
  assert.equal(M.qualityOfUrl('https://example.com/360/86.mp4'), null);
});

test('the recording’s own daf comes from its title (an amud b link can be the next daf’s shiur)', () => {
  assert.equal(M.dafFromTitle("Daf Yomi Chullin Daf 94 by R' Eli Stefansky"), 94);
  assert.equal(M.dafFromTitle('CHAZARAH - Chullin Daf 101 | "Nothing but the Daf" with R\' Eli Stefansky'), 101);
  // "דף יומי" comes first; the daf is the other "דף".
  assert.equal(M.dafFromTitle('מרכז דף יומי - חולין דף קיג. - ר\' אלי סטפנסקי שליט"א'), 113);
  assert.equal(M.dafFromTitle('מרכז דף יומי -  בכורות דף י. - ר\' אלי סטפנסקי שליט"א (לא ערוך)'), 10);
  assert.equal(M.dafFromTitle('חזרה - בכורות דף טו | "רק הדף" עם ר\' אלי סטפנסקי'), 15);
  assert.equal(M.dafFromTitle('חזרה - בכורות דף טז | "רק הדף"'), 16);
  assert.equal(M.dafFromTitle('YouTube'), null);
  assert.equal(M.fileUrl(ref('Chullin', 93, { amud: 'b' }), { title: "Daf Yomi Chullin Daf 94 by R' Eli Stefansky", quality: '360' }),
    'https://cdn.mdydaf.com/shiur/english/chullin/360/94.mp4');
  // No daf in the title: the ref's own.
  assert.equal(M.fileUrl(ref('Chullin', 95), { title: 'YouTube', quality: '360' }), 'https://cdn.mdydaf.com/shiur/english/chullin/360/95.mp4');
  assert.equal(M.hebrewNumber('קמב'), 142);
  assert.equal(M.hebrewNumber('abc'), null);
});

test('not MDY’s: another maggid, a livestream, an unknown masechta', () => {
  assert.equal(M.fileUrl(ref('Bekhorot', 2, { maggid: 'bornstein' }), {}), null);
  assert.equal(M.fileUrl(ref('Bekhorot', 2), { title: 'Bechoros 2 - Lakewood Daf Yomi' }), null);
  assert.equal(M.fileUrl(ref('Chullin', 86), { liveBroadcast: true }), null);
  assert.equal(M.fileUrl(ref('Tamid', 26), {}), null);
  assert.equal(M.fileUrl(null, {}), null);
  // The default maggid by id is MDY.
  assert.ok(M.fileUrl(ref('Chullin', 86, { maggid: 'stefansky' }), {}));
});

test('same recording: within three seconds, and unknown counts as the same', () => {
  assert.equal(M.sameRecording(3352.938, 3352.93), true);
  assert.equal(M.sameRecording(3352.938, 3355.5), true);
  assert.equal(M.sameRecording(3304.2, 4521.35), false);
  assert.equal(M.sameRecording(NaN, 3000), true);
  assert.equal(M.sameRecording(3000, 0), true);
});

test('the quality a reader starts on, and where they play from', () => {
  assert.equal(M.defaultQuality({}), '720');
  assert.equal(M.defaultQuality({ narrowScreen: true }), '360');
  assert.equal(M.defaultQuality({ saveData: true }), '360');
  assert.equal(M.defaultQuality({ slowConnection: true }), '360');
  assert.equal(M.defaultQuality({ narrowScreen: true, saved: '1080' }), '1080');
  assert.equal(M.defaultQuality({ saved: 'nonsense' }), '720');
  assert.equal(M.normalizeSource('youtube'), 'youtube');
  assert.equal(M.normalizeSource(undefined), 'mdy');
  assert.equal(M.normalizeSource('vimeo'), 'mdy');
});

test('the voice job\u2019s audio: the daf most of the readings are on, or the title\u2019s', () => {
  assert.deepEqual(dafOfReadings(['Bekhorot 57b', 'Bekhorot 58a', 'Bekhorot 58b', 'Bekhorot 59a']), { tractate: 'Bekhorot', daf: 58 });
  assert.deepEqual(dafOfReadings(['Chullin 86a']), { tractate: 'Chullin', daf: 86 });
  assert.equal(dafOfReadings([]), null);
  assert.equal(dafOfReadings(['nonsense']), null);
  assert.equal(mdyAudioUrl({ refs: ['Bekhorot 57b', 'Bekhorot 58a', 'Bekhorot 58b', 'Bekhorot 59a'] }),
    'https://cdn.mdydaf.com/shiur/english/bechoros/mp3/58.mp3');
  assert.equal(mdyAudioUrl({ refs: ['Chullin 93b'], variant: 'chazarah', language: 'he', title: "Daf Yomi Chullin Daf 94 by R' Eli Stefansky" }),
    'https://cdn.mdydaf.com/nbtd/hebrew/chullin/mp3/94.mp3');
  // Another maggid's shiur is not on MDY's server.
  assert.equal(mdyAudioUrl({ refs: ['Bekhorot 2a', 'Bekhorot 2b'], maggid: 'bornstein' }), null);
});
