// Direct tests for scan-daf-page.mjs's pure helper functions, run with
// `npm run test:functions` (node --test). The handler itself needs live
// network access (GitHub, Google Vision, a real photo) and has no existing
// test coverage -- these are the synchronous pieces worth pinning down with
// synthetic fixture data mimicking Vision's and tesseract.js's own response
// shapes, same reasoning as link-preview.mjs's own __testing export.

import test from 'node:test';
import assert from 'node:assert/strict';
import { __testing } from '../../netlify/functions/scan-daf-page.mjs';

const { extractHeaderTokens, extractTesseractTokens, resolveHeaderBandFraction } = __testing;

// --- extractHeaderTokens (Google Vision) ------------------------------------

test('extractHeaderTokens flattens page>block>paragraph>word into {text,x}', () => {
  const fullTextAnnotation = {
    text: 'חולין פט.',
    pages: [{
      blocks: [{
        paragraphs: [{
          words: [
            {
              symbols: [{ text: 'ח' }, { text: 'ו' }, { text: 'ל' }, { text: 'י' }, { text: 'ן' }],
              boundingBox: { vertices: [{ x: 300 }, { x: 400 }, { x: 400 }, { x: 300 }] },
            },
            {
              symbols: [{ text: 'פ' }, { text: 'ט' }, { text: '.' }],
              boundingBox: { vertices: [{ x: 50 }, { x: 100 }, { x: 100 }, { x: 50 }] },
            },
          ],
        }],
      }],
    }],
  };
  const { text, tokens } = extractHeaderTokens(fullTextAnnotation);
  assert.equal(text, 'חולין פט.');
  assert.equal(tokens.length, 2);
  assert.equal(tokens[0].text, 'חולין');
  assert.equal(tokens[0].x, 350); // (300+400)/2
  assert.equal(tokens[1].text, 'פט.');
  assert.equal(tokens[1].x, 75); // (50+100)/2
});

test('extractHeaderTokens tolerates a missing/empty annotation', () => {
  assert.deepEqual(extractHeaderTokens(undefined), { text: '', tokens: [] });
  assert.deepEqual(extractHeaderTokens({}), { text: '', tokens: [] });
});

test('extractHeaderTokens skips a word with no symbols or no bounding box', () => {
  const fullTextAnnotation = {
    text: 'x',
    pages: [{ blocks: [{ paragraphs: [{ words: [
      { symbols: [], boundingBox: { vertices: [{ x: 1 }] } },
      { symbols: [{ text: 'א' }], boundingBox: null },
      { symbols: [{ text: 'ב' }], boundingBox: { vertices: [{ x: 10 }, { x: 20 }] } },
    ] }] }] }],
  };
  const { tokens } = extractHeaderTokens(fullTextAnnotation);
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].text, 'ב');
  assert.equal(tokens[0].x, 15);
});

// --- extractTesseractTokens --------------------------------------------------

test('extractTesseractTokens flattens block>paragraph>line>word into {text,x}', () => {
  const data = {
    text: 'חולין פט.',
    blocks: [{
      paragraphs: [{
        lines: [{
          words: [
            { text: 'חולין', bbox: { x0: 300, x1: 400, y0: 0, y1: 10 } },
            { text: 'פט.', bbox: { x0: 50, x1: 100, y0: 0, y1: 10 } },
          ],
        }],
      }],
    }],
  };
  const { text, tokens } = extractTesseractTokens(data);
  assert.equal(text, 'חולין פט.');
  assert.equal(tokens.length, 2);
  assert.equal(tokens[0].x, 350);
  assert.equal(tokens[1].x, 75);
});

test('extractTesseractTokens tolerates missing blocks/text', () => {
  assert.deepEqual(extractTesseractTokens({}), { text: '', tokens: [] });
});

// --- resolveHeaderBandFraction ------------------------------------------------

test('resolveHeaderBandFraction clamps to the 0.02-0.08 safe range', () => {
  assert.equal(resolveHeaderBandFraction(0.05), 0.05);
  assert.equal(resolveHeaderBandFraction(0.5), 0.08);
  assert.equal(resolveHeaderBandFraction(0.001), 0.02);
  assert.equal(resolveHeaderBandFraction(-1), 0.02);
});

test('resolveHeaderBandFraction defaults to 0.05 for non-finite input', () => {
  assert.equal(resolveHeaderBandFraction(undefined), 0.05);
  assert.equal(resolveHeaderBandFraction(NaN), 0.05);
  assert.equal(resolveHeaderBandFraction('0.05'), 0.05); // a string, not a number -- not finite by Number.isFinite
});
