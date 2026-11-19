// tools/test-shiur/register.mjs: marking a video as a test shiur in a checkout of
// the results branch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerTestShiur, parseRefs } from '../../tools/test-shiur/register.mjs';

const VIDEO = 'TWCiP96dKXU';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'test-shiur-'));
const read = (dir, key) => JSON.parse(fs.readFileSync(path.join(dir, 'video-links', `${key}.json`), 'utf8'));

test('a link per daf, under the maggid\'s key, marked as a locked test shiur', () => {
  const dir = tmp();
  const { written, kept } = registerTestShiur({
    resultsDir: dir, videoId: VIDEO, refs: 'Bekhorot 58a, Bekhorot 58b', maggid: 'bornstein', label: 'Bechoros 58',
  });
  assert.deepEqual(written, ['Bornstein-Bekhorot-58a', 'Bornstein-Bekhorot-58b']);
  assert.deepEqual(kept, []);
  assert.deepEqual(read(dir, 'Bornstein-Bekhorot-58b'), {
    type: 'youtube',
    url: `https://www.youtube.com/watch?v=${VIDEO}`,
    videoId: VIDEO,
    label: 'Bechoros 58',
    coveredRefs: ['Bekhorot 58a', 'Bekhorot 58b'],
    source: 'manual',
    maggid: 'bornstein',
    testShiur: true,
    locked: true,
  });
});

test('an existing link to the same video is kept and marked; one to another video is left alone', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'video-links'));
  fs.writeFileSync(path.join(dir, 'video-links', 'Bornstein-Bekhorot-58a.json'),
    JSON.stringify({ type: 'youtube', videoId: VIDEO, label: 'Bechoros 58', source: 'channel-auto' }));
  fs.writeFileSync(path.join(dir, 'video-links', 'Bornstein-Bekhorot-58b.json'),
    JSON.stringify({ type: 'youtube', videoId: 'AAAAAAAAAAA', label: 'another upload' }));
  const { written, kept } = registerTestShiur({ resultsDir: dir, videoId: VIDEO, refs: 'Bekhorot 58a,Bekhorot 58b', maggid: 'bornstein' });
  assert.deepEqual(written, ['Bornstein-Bekhorot-58a']);
  assert.deepEqual(kept, [{ key: 'Bornstein-Bekhorot-58b', videoId: 'AAAAAAAAAAA' }]);
  const link = read(dir, 'Bornstein-Bekhorot-58a');
  assert.equal(link.source, 'channel-auto');
  assert.equal(link.testShiur, true);
  assert.equal(link.locked, true);
  assert.equal(read(dir, 'Bornstein-Bekhorot-58b').videoId, 'AAAAAAAAAAA');
});

test('Mercaz Daf Yomi keys have no prefix; bad input is refused', () => {
  const dir = tmp();
  assert.deepEqual(registerTestShiur({ resultsDir: dir, videoId: VIDEO, refs: 'Bava Kamma 2a' }).written, ['Bava-Kamma-2a']);
  assert.deepEqual(parseRefs('Bava Kamma 2a')[0], { ref: 'Bava Kamma 2a', tractate: 'Bava Kamma', daf: 2, amud: 'a' });
  assert.throws(() => registerTestShiur({ resultsDir: dir, videoId: VIDEO, refs: 'Bekhorot 58' }), /Not a daf reference/);
  assert.throws(() => registerTestShiur({ resultsDir: dir, videoId: 'nope', refs: 'Bekhorot 58a' }), /Not a video id/);
  assert.throws(() => registerTestShiur({ resultsDir: dir, videoId: VIDEO, refs: 'Bekhorot 58a', maggid: 'nobody' }), /Unknown maggid/);
});
