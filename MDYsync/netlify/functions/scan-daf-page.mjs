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

import { createSign } from 'node:crypto';
import { createWorker } from 'tesseract.js';
import { Jimp, intToRGBA } from 'jimp';
import { solveHomography, applyHomography } from '../../shared/perspective-transform.mjs';
import { buildHeaderVocabulary, matchHeader, MASECHTA_HEBREW } from '../../shared/daf-header-vocabulary.mjs';
import { parsePageKey } from '../../shared/daf-key-parsing.mjs';
import { detectTextBlockQuad } from '../../shared/text-block-detect.mjs';

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

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

// Same JWT-bearer exchange as page_ocr_align.py's own
// get_google_vision_access_token (there via the google-auth Python
// library; here by hand, since pulling in a whole OAuth client library for
// one token exchange isn't worth it in a Netlify function). A service
// account is the form some orgs' Cloud project policy requires instead of
// a plain API key ("API Keys are Disallowed ... use Application Default
// Credentials instead") -- this is that same ADC path, not a workaround
// for it.
async function getGoogleVisionAccessToken(credentialsJson) {
  const info = JSON.parse(credentialsJson);
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({
    iss: info.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: info.token_uri,
    iat: now,
    exp: now + 3600,
  }));
  const signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(info.private_key, 'base64url');
  const assertion = `${header}.${claims}.${signature}`;

  const response = await fetch(info.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || `Token exchange failed (${response.status})`);
  }
  return data.access_token;
}

// Same request shape as page_ocr_align.py's ocr_band_words_google_vision
// (Python side, run by the batch pre-generation job) -- DOCUMENT_TEXT_
// DETECTION with a Hebrew language hint, and the same choice between a
// plain API key and a service-account credential (exactly one of the two
// is expected). That function reads a whole page; this reads a tiny
// single-line header crop, but it's the same API and the same tuning
// question (accuracy on real, noisy camera photos of this typeface) that
// motivated switching the page pipeline off Tesseract, so it's worth
// spiking here as a straight engine swap before committing to it -- see
// matchHeader's own comments for the specific real misreads (a
// hallucinated niqqud, a dropped letter producing an exact tie with a
// different real daf) that this is meant to address.
async function ocrHeaderGoogleVision(imageBuffer, { apiKey, credentialsJson }) {
  const payload = {
    requests: [{
      image: { content: imageBuffer.toString('base64') },
      features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
      imageContext: { languageHints: ['he'] },
    }],
  };
  const headers = { 'Content-Type': 'application/json' };
  const url = credentialsJson
    ? 'https://vision.googleapis.com/v1/images:annotate'
    : `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`;
  if (credentialsJson) headers.Authorization = `Bearer ${await getGoogleVisionAccessToken(credentialsJson)}`;

  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
  const data = await response.json();
  const result = data?.responses?.[0];
  if (!response.ok || result?.error) {
    throw new Error(result?.error?.message || `Vision request failed (${response.status})`);
  }
  return result.fullTextAnnotation?.text || '';
}

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

  const { imageBase64, imageWidth, imageHeight, corners, engine: requestedEngine } = body || {};
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

  // google-vision when a key is configured, same default the batch page-OCR
  // job uses -- explicit engine in the request body overrides that, for the
  // A/B test harness comparing both against the same real photos; the real
  // capture UI never sends one, so production always follows the env-var
  // default.
  //
  // NOT YET SAFE TO DEFAULT TO google-vision: spike-tested against one real
  // photo (the one this file's own module comment describes being
  // misidentified as 86a) and found a genuine, reproducible blind spot --
  // Vision's DOCUMENT_TEXT_DETECTION never detects the header's daf-number
  // glyphs at this crop's native resolution, confirmed directly against its
  // raw response (absent from textAnnotations entirely, not a parsing
  // issue on this end), even though it's the largest, clearest text in the
  // crop. A 2-3x upscale of the header crop before sending it to Vision
  // fixes this completely (confirmed: reads the daf number and every other
  // header token correctly at both scales) -- but that upscale isn't
  // implemented here yet, so switching the default without it would
  // regress exactly the photo that motivated this file's original design.
  // Separately, and just as relevant: on that same photo, the CURRENT
  // tesseract path already matches correctly (score 83) -- the failure
  // this module's docstring describes was already fixed by earlier work
  // (narrowing HEADER_BAND, the punctuated-gematria-token filter), so
  // whatever's still going wrong for real users is a different photo/
  // condition than the one on file here, not reproduced by it.
  const visionApiKey = Netlify.env.get('GOOGLE_VISION_API_KEY');
  const visionCredentialsJson = Netlify.env.get('GOOGLE_VISION_CREDENTIALS_JSON');
  const hasVisionCredential = Boolean(visionApiKey || visionCredentialsJson);
  const engine = requestedEngine === 'tesseract' || requestedEngine === 'google-vision'
    ? requestedEngine
    : (hasVisionCredential ? 'google-vision' : 'tesseract');
  if (engine === 'google-vision' && !hasVisionCredential) {
    return Response.json({ error: 'google-vision engine requested but neither GOOGLE_VISION_API_KEY nor GOOGLE_VISION_CREDENTIALS_JSON is set.' }, { status: 503 });
  }

  let ocrText;
  try {
    const imageBuffer = Buffer.from(imageBase64, 'base64');
    // Crop the header region ourselves rather than passing tesseract.js's
    // own `rectangle` recognize() option -- confirmed by direct testing
    // that it silently reads the wrong region once the source image is
    // larger than a tiny test crop (worked on a ~700px-wide test image,
    // returned only a garbled fragment on a realistic ~900px+ full-page
    // photo). Actually cropping first and feeding tesseract just that
    // buffer works correctly at any source size. Cropping first (rather
    // than sending Vision the whole photo) also matters for that engine:
    // it keeps this call as cheap and fast as the header actually needs,
    // and re-uses the exact same HEADER_BAND/homography region math either
    // engine reads, so a same-photo comparison between them isn't also
    // comparing two different crops.
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
    // adjustment regardless of source quality). This preprocessing was
    // tuned against Tesseract specifically; kept for Vision too so the
    // spike compares engines, not preprocessing.
    cropped.greyscale();
    cropped.normalize();
    const croppedBuffer = await cropped.getBuffer('image/png');

    if (engine === 'google-vision') {
      ocrText = await ocrHeaderGoogleVision(croppedBuffer, { apiKey: visionApiKey, credentialsJson: visionCredentialsJson });
    } else {
      const worker = await createWorker('heb');
      try {
        const { data } = await worker.recognize(croppedBuffer);
        ocrText = data.text;
      } finally {
        await worker.terminate();
      }
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

  // Word positions were originally projected straight through the marked
  // PAGE corners' own homography -- correct only if the reader's physical
  // book has the exact same margin proportions as shas.org's reference PDF
  // (what pageData.wordBoxes' x/y/w/h are fractions of). Different print
  // runs/publishers trim pages and set margins differently even when the
  // underlying typeset content is identical, and that mismatch compounds
  // into several line-heights of drift by the lower part of a page (a real,
  // confirmed failure -- see shared/text-block-detect.mjs's own module
  // comment for the full story and the direct simulation that quantified
  // it). pageData.textBlock (schema v2+) is the Gemara column's own bounds
  // on the REFERENCE page; detecting the SAME column's bounds on THIS
  // photo and projecting through a homography built from THAT instead
  // removes the assumption entirely, since neither side needs the other's
  // margins to match. Falls back to the original page-homography
  // projection (unchanged behavior) for an older (v1) page map, or if
  // detection itself isn't confident enough on this specific photo --
  // never worse than what shipped before, only better when it can be.
  let wordProjectionHomography = homography;
  let textBlockOrigin = { left: 0, top: 0, width: 1, height: 1 }; // identity: box.x/y already in this space
  if (pageData.textBlock) {
    try {
      // imageBuffer above is scoped to the header-OCR try block -- decoded
      // again here rather than threading it out, a cheap base64 decode
      // against the same bytes.
      const textBlockImage = await Jimp.read(Buffer.from(imageBase64, 'base64'));
      const detected = detectTextBlockQuad(
        (x, y) => intToRGBA(textBlockImage.getPixelColor(x, y)),
        homography,
        imageWidth,
        imageHeight
      );
      if (detected) {
        wordProjectionHomography = solveHomography(CANONICAL_CORNERS, detected.corners);
        const tb = pageData.textBlock;
        textBlockOrigin = { left: tb.left, top: tb.top, width: tb.right - tb.left, height: tb.bottom - tb.top };
      }
    } catch (error) {
      console.error('Text-block detection failed, falling back to page-relative word positions:', error);
    }
  }

  // Project each canonical word box through the homography above, then back
  // into photo-relative fractions (0-1) -- so the frontend can position
  // overlay elements with simple percentages, exactly the way it already
  // does for the Vilna-page view (renderVilnaWordBoxes in app.js).
  const wordBoxes = (pageData.wordBoxes || []).map((box) => {
    const relX = (box.x - textBlockOrigin.left) / textBlockOrigin.width;
    const relY = (box.y - textBlockOrigin.top) / textBlockOrigin.height;
    const relW = box.w / textBlockOrigin.width;
    const relH = box.h / textBlockOrigin.height;
    const corners2 = [
      [relX, relY], [relX + relW, relY],
      [relX + relW, relY + relH], [relX, relY + relH],
    ].map(([x, y]) => applyHomography(wordProjectionHomography, x, y));
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
