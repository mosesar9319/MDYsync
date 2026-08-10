// Identifies which daf a photographed printed page shows, and returns
// word-tap targets for it -- the server side of "point the camera at a
// physical page, tap a word, jump the video there" (see app.js's camera
// capture UI and seekToVilnaWord, which already does the tap-to-seek half).
//
// Deliberately does NOT run OCR on the photographed page's body text. Two
// things it leans on instead:
//
//  1. Vilna Shas pagination is a standard nearly every printed edition
//     reproduces, specifically so daf/amud citations stay universal across
//     publishers -- so the word positions already computed from the
//     canonical PDF render (page_ocr_align.py, published to
//     results/pages/<key>.json) should closely match a real physical
//     page's layout too, even from a different print run.
//  2. Identifying *which* daf a photo shows only needs its small header
//     (Masechta name + daf number), not the whole page -- see
//     shared/daf-header-vocabulary.mjs for why that's matched as closed-
//     vocabulary text (OCR + fuzzy match) rather than image matching
//     against saved reference headers.
//
// The caller is expected to have already let the reader align the photo's
// four page corners (a manual-adjustment step, not automatic edge
// detection -- see the module comment on shared/perspective-transform.mjs
// for why automatic corner detection was deliberately deferred past v1).
// Those corners are what this projects the canonical word boxes through.
//
// KNOWN v1 LIMITATION: a Vilna page's header prints only the daf number,
// never "a" or "b" -- both amudim share one physical page, so the header
// alone can't tell which one is open. This always resolves to amud a;
// switching to b (once loaded) is the same manual step as anywhere else
// in the player.
//
// UNVERIFIED AGAINST REAL PHOTOS: the header-OCR step was spike-tested
// against synthetic Hebrew text (clean and with simulated rotation/blur/
// lighting noise) during planning, not a real phone photo of a real
// printed page -- see the plan's own "spike first" verification note.
// Real paper texture, edition-specific header fonts, and actual camera
// distortion are all still open questions worth testing before relying on
// this in production.

import { createWorker } from 'tesseract.js';
import { Jimp } from 'jimp';
import { solveHomography, applyHomography } from '../../shared/perspective-transform.mjs';
import { buildHeaderVocabulary, matchHeader, MASECHTA_HEBREW } from '../../shared/daf-header-vocabulary.mjs';
import { parsePageKey } from '../../shared/daf-key-parsing.mjs';

const OWNER = 'mosesar9319';
const REPO = 'MDYsync';
const ALLOWED_ORIGINS = new Set([
  'https://mdysync.netlify.app',
  'https://main--mdysync.netlify.app',
  'http://localhost:8080',
]);

// Was 0.09 (9% of page height) -- confirmed directly (rendering the real
// canonical PDF for a real daf, OCRing progressively taller crops) that this
// reached 3-4 lines into body text below the actual header line, which sits
// in roughly the top 4.5%. That mattered more than it looks like it should:
// matchHeader takes the *best-scoring token anywhere in the OCR'd text* for
// the daf-number comparison, and a daf's gematria is only 1-3 Hebrew
// letters -- long enough body text will essentially always contain some
// random substring that reads as an exact or near-exact accidental match
// for a *different* daf's gematria, deterministically outscoring the real
// (slightly OCR-noisy) header line and misidentifying the page. This is
// exactly what happened live: a real scan of Chullin 101a (gematria "קא")
// was misidentified as Chullin 86a. Reproducing the same daf with the old
// 0.09 crop (rendering the real canonical page, no camera noise at all)
// landed on a *different* wrong daf, 96a -- the literal substring "צו"
// (96's gematria) happened to appear verbatim in that wider crop's body-text
// OCR noise. Different wrong answer, same mechanism: the bug isn't one
// unlucky misread, it's that any sufficiently long OCR'd blob will
// eventually contain an accidental exact match for *some* short gematria
// string. 0.05 keeps a real margin above the measured ~4.5% the header line
// itself needs (real camera photos won't crop as precisely as a clean PDF
// render) while staying well clear of body text.
const HEADER_BAND = [[0, 0], [1, 0], [1, 0.05], [0, 0.05]];
const CANONICAL_CORNERS = [[0, 0], [1, 0], [1, 1], [0, 1]];

// A phone photo, base64-encoded, inflated ~33% by that encoding -- this
// caps the *decoded* size, generous for a downscaled capture (the frontend
// is expected to downscale before upload; see the capture UI) while still
// bounding worst-case request cost.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function boundingBox(points) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return {
    left: Math.min(...xs),
    top: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

async function listAvailablePages(token) {
  const response = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/contents/pages?ref=results`,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } }
  );
  if (!response.ok) return [];
  const entries = await response.json();
  if (!Array.isArray(entries)) return [];
  return entries.map((entry) => parsePageKey(entry.name, Object.keys(MASECHTA_HEBREW))).filter(Boolean);
}

export default async (request) => {
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  const origin = request.headers.get('Origin') || '';
  if (!ALLOWED_ORIGINS.has(origin)) {
    return Response.json({ error: 'Origin not permitted.' }, { status: 403 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const { imageBase64, imageWidth, imageHeight, corners } = body || {};
  if (typeof imageBase64 !== 'string' || !imageBase64) {
    return Response.json({ error: 'imageBase64 is required.' }, { status: 400 });
  }
  if (!Number.isFinite(imageWidth) || !Number.isFinite(imageHeight) || imageWidth <= 0 || imageHeight <= 0) {
    return Response.json({ error: 'imageWidth and imageHeight are required.' }, { status: 400 });
  }
  // Roughly estimate decoded size from the base64 string length rather than
  // decoding first, so an oversized upload is rejected before doing that
  // work at all.
  if (imageBase64.length * 0.75 > MAX_IMAGE_BYTES) {
    return Response.json({ error: 'Image too large.' }, { status: 413 });
  }
  // Falls back to "the whole photo is the page" if the caller didn't
  // provide corners -- a real capture flow always should (see the capture
  // UI's manual corner-adjustment step), this just keeps the endpoint from
  // hard-failing on a malformed request.
  const cornerPoints = Array.isArray(corners) && corners.length === 4
    ? corners
    : [[0, 0], [imageWidth, 0], [imageWidth, imageHeight], [0, imageHeight]];

  const token = Netlify.env.get('GITHUB_DISPATCH_TOKEN');
  if (!token) {
    return Response.json({ error: 'Server sync is not configured yet.' }, { status: 503 });
  }

  let homography;
  try {
    homography = solveHomography(CANONICAL_CORNERS, cornerPoints);
  } catch (error) {
    return Response.json({ error: 'Could not align the marked page corners.', detail: error.message }, { status: 400 });
  }

  const headerRect = boundingBox(HEADER_BAND.map(([x, y]) => applyHomography(homography, x, y)));
  const rectangle = {
    left: Math.max(0, Math.round(headerRect.left)),
    top: Math.max(0, Math.round(headerRect.top)),
    width: Math.min(imageWidth, Math.round(headerRect.width)),
    height: Math.min(imageHeight, Math.round(headerRect.height)),
  };

  let ocrText;
  try {
    const imageBuffer = Buffer.from(imageBase64, 'base64');
    // Crop the header region ourselves rather than passing tesseract.js's
    // own `rectangle` recognize() option -- confirmed by direct testing
    // that it silently reads the wrong region once the source image is
    // larger than a tiny test crop (worked on a ~700px-wide test image,
    // returned only a garbled fragment on a realistic ~900px+ full-page
    // photo). Actually cropping first and feeding tesseract just that
    // buffer works correctly at any source size.
    const cropped = await Jimp.read(imageBuffer);
    cropped.crop({ x: rectangle.left, y: rectangle.top, w: rectangle.width, h: rectangle.height });
    // greyscale + normalize -- confirmed directly by A/B testing against
    // BOTH a real photo (clean, well-lit) and a realistic synthetically
    // degraded one (blur, uneven lighting, JPEG recompression): this
    // combination correctly read the daf number on both. An earlier version
    // of this also added a fixed contrast(0.5) boost, tuned only against
    // the degraded photo -- confirmed directly that it actively destroyed
    // the daf number on the real, already-well-exposed photo (a fixed boost
    // clips a photo that didn't need it; normalize()'s own adaptive
    // levels-stretch doesn't have that failure mode, since it scales to
    // each image's actual histogram instead of applying the same fixed
    // adjustment regardless of source quality).
    cropped.greyscale();
    cropped.normalize();
    const croppedBuffer = await cropped.getBuffer('image/png');

    const worker = await createWorker('heb');
    try {
      const { data } = await worker.recognize(croppedBuffer);
      ocrText = data.text;
    } finally {
      await worker.terminate();
    }
  } catch (error) {
    return Response.json({ error: 'Could not read the page header.', detail: error.message }, { status: 502 });
  }

  const availableDapim = await listAvailablePages(token);
  const vocabulary = buildHeaderVocabulary(availableDapim);
  const match = matchHeader(ocrText, vocabulary);
  if (!match) {
    return Response.json({ error: 'Could not identify the daf from this photo.', ocrText }, { status: 422 });
  }

  const pageKey = `${match.entry.tractate.replace(/\s+/g, '-')}-${match.entry.daf}a`;
  const pageResponse = await fetch(`https://raw.githubusercontent.com/${OWNER}/${REPO}/results/pages/${pageKey}.json`);
  if (!pageResponse.ok) {
    return Response.json(
      { error: `No word-position data for ${match.entry.tractate} ${match.entry.daf}.` },
      { status: 404 }
    );
  }
  const pageData = await pageResponse.json();

  // Project each canonical word box through the same homography, then back
  // into photo-relative fractions (0-1) -- so the frontend can position
  // overlay elements with simple percentages, exactly the way it already
  // does for the Vilna-page view (renderVilnaWordBoxes in app.js).
  const wordBoxes = (pageData.wordBoxes || []).map((box) => {
    const corners2 = [
      [box.x, box.y], [box.x + box.w, box.y],
      [box.x + box.w, box.y + box.h], [box.x, box.y + box.h],
    ].map(([x, y]) => applyHomography(homography, x, y));
    const projected = boundingBox(corners2);
    return {
      ref: box.ref,
      wordIndex: box.wordIndex,
      x: projected.left / imageWidth,
      y: projected.top / imageHeight,
      w: projected.width / imageWidth,
      h: projected.height / imageHeight,
    };
  });

  return Response.json({
    ref: `${match.entry.tractate} ${match.entry.daf}a`,
    tractate: match.entry.tractate,
    daf: match.entry.daf,
    matchScore: Math.round(match.score),
    wordBoxes,
  }, {
    headers: { 'Access-Control-Allow-Origin': origin },
  });
};

export const config = {
  path: '/api/scan-daf-page',
};
