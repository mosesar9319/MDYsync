// netlify/functions/list-synced-dapim.mjs: which shiurim of a daf are synced.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncedEntry } from '../../netlify/functions/list-synced-dapim.mjs';

test('a sync file names its daf and whose shiur it is', () => {
  assert.deepEqual(syncedEntry('Arakhin-4a.json'), { tractate: 'Arakhin', daf: 4, amud: 'a', combo: 'regularEn' });
  assert.deepEqual(syncedEntry('Hebrew-Chazarah-Daf-Arakhin-4b.json'), { tractate: 'Arakhin', daf: 4, amud: 'b', combo: 'chazarahHe' });
  assert.deepEqual(syncedEntry('Voice-Chullin-89a.json'), { tractate: 'Chullin', daf: 89, amud: 'a', combo: 'regularEn' });
  // Another maggid's sync carries his id, so Mercaz Daf Yomi's combos read as before.
  assert.deepEqual(syncedEntry('Voice-Bornstein-Arakhin-4a.json'), { tractate: 'Arakhin', daf: 4, amud: 'a', combo: 'bornstein:regularEn' });
  assert.deepEqual(syncedEntry('Bornstein-Bekhorot-58b.json'), { tractate: 'Bekhorot', daf: 58, amud: 'b', combo: 'bornstein:regularEn' });
  assert.equal(syncedEntry('Chazarah-Daf-Chullin-95b-(Chazarah-Daf).json'), null);
  assert.equal(syncedEntry('Nothing-4a.json'), null);
});
