// vilna-geometry.js (the printed daf's highlight geometry, as Live Follow uses
// it) against app.js, where it came from. Run with `npm run test:functions`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extractDecl, dedent } from '../support/extract-decl.mjs';

const require = createRequire(import.meta.url);
const G = require('../../vilna-geometry.js');
const appSource = readFileSync(new URL('../../app.js', import.meta.url), 'utf8');
const copySource = readFileSync(new URL('../../vilna-geometry.js', import.meta.url), 'utf8');
const pageMap = JSON.parse(readFileSync(new URL('../fixtures/pagemap-chullin-91a.json', import.meta.url), 'utf8'));

test('every copied declaration is character-for-character the one in app.js', () => {
  const names = ['pageMapKey', 'normalizeDafParagraphRef', 'normalizePageWordBoxes', 'restrictWordBoxesToGemaraBlock', 'medianOf',
    'splitBoxesIntoRows', 'INK_PITCH_RATIO', 'INK_CENTER_BIAS', 'INK_BOX_RATIO', 'linePitchCache', 'pageLinePitch', 'measureInkBands',
    'matchInkBand', 'groupBoxesIntoLineRects', 'appendLineRects'];
  for (const name of names) {
    assert.equal(dedent(extractDecl(copySource, name), 2), dedent(extractDecl(appSource, name), 0), `${name} has drifted from app.js`);
  }
});

test('the extractor finds what it should (so the check above means something)', () => {
  assert.match(extractDecl(appSource, 'matchInkBand'), /^function matchInkBand\(bands, centre, pitch\) \{/);
  assert.match(extractDecl(appSource, 'matchInkBand'), /\n\}$/);
  assert.equal(extractDecl(appSource, 'INK_PITCH_RATIO'), 'const INK_PITCH_RATIO = 0.5601;');
  assert.throws(() => extractDecl(appSource, 'noSuchThing'));
});

test('the page map key and ref normalisation are the player\'s', () => {
  assert.equal(G.pageMapKey({ tractate: 'Bava Metzia', daf: 12, amud: 'b' }), 'Bava-Metzia-12b');
  assert.equal(G.normalizeDafParagraphRef('Chullin 91a:3'), 'Chullin 91a.3');
  assert.equal(G.normalizeDafParagraphRef('Chullin 98b (Chazarah Daf):1'), 'Chullin 98b.1');
  assert.equal(G.normalizeDafParagraphRef('Chullin 91a.3'), 'Chullin 91a.3');
});

test('on a real page map: boxes are normalised, kept to the Gemara block, and grouped into per-line bars', () => {
  const boxes = G.restrictWordBoxesToGemaraBlock(G.normalizePageWordBoxes(pageMap.wordBoxes), pageMap.textBlock);
  assert.ok(boxes.length > 400 && boxes.length <= pageMap.wordBoxes.length);
  assert.ok(boxes.every((b) => /^Chullin 91a\.\d+$/.test(b.ref)));
  const map = { ...pageMap, wordBoxes: boxes };
  const pitch = G.pageLinePitch(map);
  assert.ok(pitch > 0.004 && pitch < 0.03, `line pitch ${pitch}`);
  // The first paragraph, as a phrase being read: a bar per printed line.
  const phrase = boxes.filter((b) => b.ref === 'Chullin 91a.1').sort((a, b) => a.wordIndex - b.wordIndex);
  const rects = G.groupBoxesIntoLineRects(phrase, map, null);
  assert.ok(rects.length >= 2 && rects.length <= 4, `${rects.length} bars`);
  for (const r of rects) {
    assert.ok(r.width > 0 && r.height > 0 && r.left >= 0 && r.left + r.width <= 1 && r.top >= 0 && r.top + r.height <= 1);
    assert.ok(Math.abs(r.height - pitch * 0.5601) < 1e-9, 'bar height comes from the page\'s line pitch');
  }
  // One word is one bar, as wide as the word (plus its end caps).
  const [one] = G.groupBoxesIntoLineRects([phrase[0]], map, null);
  assert.ok(Math.abs(one.width - (phrase[0].w + 0.008)) < 1e-9);
});
