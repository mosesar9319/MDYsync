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
// AMUD DETECTION: a Vilna page's header never prints "a"/"b" literally --
// both amudim share one physical page -- but the header's LAYOUT still
// tells them apart (daf number left of the tractate/perek name = amud א,
// right of it = amud ב, a real printing convention). See resolveAmud in
// shared/daf-header-vocabulary.mjs. Falls back to amud א when that signal
// is missing or amud ב's page data hasn't been published yet -- switching
// manually (once loaded) is still the same toggle as anywhere else in the
// player, just no longer the ONLY way to land on the right side.
//
// UNVERIFIED AGAINST REAL PHOTOS: the header-OCR step was spike-tested
// against synthetic Hebrew text (clean and with simulated rotation/blur/
// lighting noise) during planning, not a real phone photo of a real
// printed page -- see the plan's own "spike first" verification note.
// Real paper texture, edition-specific header fonts, and actual camera
// distortion are all still open questions worth testing before relying on
// this in production.

import { createWorker } from 'tesseract.js';
import { Jimp, intToRGBA } from 'jimp';
import { solveHomography, applyHomography } from '../../shared/perspective-transform.mjs';
import { buildHeaderVocabulary, matchHeader, MASECHTA_HEBREW } from '../../shared/daf-header-vocabulary.mjs';
import { detectTextBlockQuad } from '../../shared/text-block-detect.mjs';
import { ocrHeaderGoogleVision, extractHeaderTokens, extractTesseractTokens } from '../../shared/vision-header-ocr.mjs';
import { listAvailablePages } from '../../shared/available-dapim.mjs';
import { OWNER, REPO, ALLOWED_ORIGINS } from '../../shared/dafsync-config.mjs';

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
//
// Adjustable, not fixed: the capture UI's own on-screen header guide (see
// SCAN_HEADER_BAND_FRACTION in app.js) is what the reader actually frames
// against, and it sends its value here as headerBandFraction on every
// request rather than this file guessing independently -- one number
// changed in one place (app.js) moves both the visual guide and the real
// crop together, so they can never drift out of sync the way two
// hand-maintained constants in two files eventually would. MIN/MAX below
// exist because that number now arrives over the wire: MAX keeps a future
// larger value from reintroducing the exact 0.09 bug this comment
// documents, MIN keeps a too-small value from cropping out the header
// itself.
const DEFAULT_HEADER_BAND_FRACTION = 0.05;
const MIN_HEADER_BAND_FRACTION = 0.02;
const MAX_HEADER_BAND_FRACTION = 0.08;
const CANONICAL_CORNERS = [[0, 0], [1, 0], [1, 1], [0, 1]];

function resolveHeaderBandFraction(requested) {
  if (!Number.isFinite(requested)) return DEFAULT_HEADER_BAND_FRACTION;
  return Math.min(MAX_HEADER_BAND_FRACTION, Math.max(MIN_HEADER_BAND_FRACTION, requested));
}

// A phone photo, base64-encoded, inflated ~33% by that encoding -- this
// caps the *decoded* size, generous for a downscaled capture (the frontend
// is expected to downscale before upload; see the capture UI) while still
// bounding worst-case request cost.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

// --- Diagnostic logging: which engine ran, what it matched -------------
// See supabase/migrations/20260913150000_scan_events_logging.sql -- a plain
// append-only log, one row per scan attempt, written with the service-role
// key (bypasses RLS; the table has no write policy for anon/authenticated
// at all). Same env()/pg() shape as chabura-summary.mjs's own Supabase-over-
// plain-HTTP calls, kept local here rather than factored into a shared
// module since this is the only other function that needs it so far.
function env(name) {
  if (typeof Netlify !== 'undefined' && Netlify.env) return Netlify.env.get(name) || '';
  return process.env[name] || '';
}

// Never awaited by a caller that lets it reject uncaught -- every call site
// below is `await logScanEvent(...).catch(() => {})`, so a logging failure
// (missing config, a transient Supabase error) can never turn a real scan
// result into a 500. Silently a no-op when Supabase isn't configured at all,
// same "feature is optional" shape as chabura-summary.mjs.
async function logScanEvent(fields) {
  const supabaseUrl = (env('SUPABASE_URL') || env('VITE_SUPABASE_URL')).replace(/\/+$/, '');
  const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) return;
  await fetch(`${supabaseUrl}/rest/v1/scan_events`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      'content-type': 'application/json',
      prefer: 'return=minimal',
    },
    body: JSON.stringify(fields),
  });
}

// google-vision only (see the engine-selection comment below for why
// tesseract doesn't need this): confirmed directly that Vision's
// DOCUMENT_TEXT_DETECTION misses the header's daf-number glyphs entirely at
// this crop's native resolution, and that a 2-3x upscale of the SAME crop
// before sending it fixes that completely. Picked the middle of that
// confirmed-working range rather than the low end, since a header crop is
// tiny to begin with (a few hundred pixels wide) and the marginal request-
// size/latency cost of 2.5x vs 2x is negligible next to actually getting a
// readable daf number.
const VISION_UPSCALE_FACTOR = 2.5;

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

  const { imageBase64, imageWidth, imageHeight, corners, engine: requestedEngine, headerBandFraction: requestedHeaderBandFraction } = body || {};
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

  const headerBandFraction = resolveHeaderBandFraction(requestedHeaderBandFraction);
  const headerBand = [[0, 0], [1, 0], [1, headerBandFraction], [0, headerBandFraction]];
  const headerRect = boundingBox(headerBand.map(([x, y]) => applyHomography(homography, x, y)));
  const rectangle = {
    left: Math.max(0, Math.round(headerRect.left)),
    top: Math.max(0, Math.round(headerRect.top)),
    width: Math.min(imageWidth, Math.round(headerRect.width)),
    height: Math.min(imageHeight, Math.round(headerRect.height)),
  };

  // google-vision when a key is configured, same default the batch page-OCR
  // job uses -- explicit engine in the request body overrides that. The
  // capture UI now sends one (a reader-facing engine toggle on the
  // scan-align screen, see app.js's confirmScan), so production traffic no
  // longer universally follows the env-var default the way it used to.
  //
  // The default itself is DELIBERATELY STILL tesseract, not flipped to
  // google-vision even where a credential is configured: the header-crop
  // upscale below (VISION_UPSCALE_FACTOR) fixes the specific, confirmed
  // blind spot that used to make Vision miss the daf-number glyphs
  // entirely (spike-tested against a real photo that was misidentified as
  // 86a -- absent from Vision's raw textAnnotations response at native
  // crop resolution, not a parsing issue on this end; reads correctly at
  // both 2x and 3x). That makes google-vision a genuinely safe EXPLICIT
  // choice now. It doesn't by itself establish that Vision is more
  // accurate than tesseract across real photos generally, which is a
  // separate, unproven claim the reader-facing toggle is what actually
  // lets get tested against real-world use -- tesseract stays the
  // conservative default until that evidence exists.
  const visionApiKey = Netlify.env.get('GOOGLE_VISION_API_KEY');
  const visionCredentialsJson = Netlify.env.get('GOOGLE_VISION_CREDENTIALS_JSON');
  const hasVisionCredential = Boolean(visionApiKey || visionCredentialsJson);
  const engine = requestedEngine === 'tesseract' || requestedEngine === 'google-vision' || requestedEngine === 'both'
    ? requestedEngine
    : (hasVisionCredential ? 'google-vision' : 'tesseract');
  if ((engine === 'google-vision' || engine === 'both') && !hasVisionCredential) {
    return Response.json({ error: `${engine} engine requested but neither GOOGLE_VISION_API_KEY nor GOOGLE_VISION_CREDENTIALS_JSON is set.` }, { status: 503 });
  }

  const imageBuffer = Buffer.from(imageBase64, 'base64');
  const visionCredentials = { apiKey: visionApiKey, credentialsJson: visionCredentialsJson };
  const availableDapim = await listAvailablePages(token, Object.keys(MASECHTA_HEBREW));
  const vocabulary = buildHeaderVocabulary(availableDapim);

  // Runs ONE engine's full read-the-header-and-identify-the-daf pipeline;
  // 'both' mode below calls this twice (once per real engine) rather than
  // this function ever knowing about comparison mode itself. Never throws --
  // a failure at either stage (can't read the header at all, or read it but
  // couldn't match it to any known daf) comes back as a field on the result
  // instead, so 'both' mode can report what EACH engine did even when one of
  // them fails outright, rather than the whole request failing because one
  // engine had a bad day.
  async function ocrAndMatchOneEngine(oneEngine) {
    let ocrResult; // { text, tokens }
    try {
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
      // Vision-only (see VISION_UPSCALE_FACTOR's own comment) -- tesseract
      // already reads this crop correctly at its native resolution, so
      // upscaling it too would just add work for no accuracy gain.
      if (oneEngine === 'google-vision') cropped.scale(VISION_UPSCALE_FACTOR);
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
      // tuned against Tesseract specifically; kept for Vision too so a
      // side-by-side comparison isn't also comparing two different
      // preprocessing pipelines.
      cropped.greyscale();
      cropped.normalize();
      const croppedBuffer = await cropped.getBuffer('image/png');

      if (oneEngine === 'google-vision') {
        // 'he' unchanged here -- see shared/vision-header-ocr.mjs's own
        // comment on ocrHeaderGoogleVision for why this stays 'he' even
        // though Google's docs specify 'iw' for Hebrew; that correction is
        // scoped to the new scan-daf-header.mjs endpoint only, not this
        // already-shipped pipeline.
        ocrResult = await ocrHeaderGoogleVision(croppedBuffer, { ...visionCredentials, languageHints: ['he'] });
      } else {
        const worker = await createWorker('heb');
        try {
          const { data } = await worker.recognize(croppedBuffer);
          ocrResult = extractTesseractTokens(data);
        } finally {
          await worker.terminate();
        }
      }
    } catch (error) {
      return { engine: oneEngine, ocrError: error.message || 'Could not read the page header.' };
    }
    return { engine: oneEngine, ocrText: ocrResult.text, match: matchHeader(ocrResult.tokens, vocabulary) };
  }

  let match; // the one match actually used to build wordBoxes below
  let comparison = null; // present only for engine === 'both'
  if (engine === 'both') {
    const [tesseractResult, visionResult] = await Promise.all([
      ocrAndMatchOneEngine('tesseract'),
      ocrAndMatchOneEngine('google-vision'),
    ]);
    // ocrText included on every branch (even a match) -- single-engine mode
    // already surfaces it on a failed match (see the 422 branch below);
    // 'both' mode used to drop it entirely, which meant a real report of
    // "both engines say no match" carried no way to tell "corners were off,
    // OCR read garbage" apart from "OCR read the header fine, matching
    // itself is still wrong" without asking the reporter to dig through
    // browser devtools for the raw request/response.
    const summarize = (result) => {
      if (result.ocrError) return { error: `Could not read the page header: ${result.ocrError}`, ocrText: null };
      if (!result.match) return { error: 'Could not identify the daf from this photo.', ocrText: result.ocrText };
      return {
        // Informational only here (this engine's own read, shown in the
        // comparison UI) -- amud b falling back to a's own page data when
        // b hasn't been published happens down where the real result gets
        // built below, not in this per-engine summary.
        ref: `${result.match.entry.tractate} ${result.match.entry.daf}${result.match.amud || 'a'}`,
        tractate: result.match.entry.tractate,
        daf: result.match.entry.daf,
        matchScore: Math.round(result.match.score),
        ocrText: result.ocrText,
      };
    };
    const agree = Boolean(
      tesseractResult.match && visionResult.match
      && tesseractResult.match.entry.tractate === visionResult.match.entry.tractate
      && tesseractResult.match.entry.daf === visionResult.match.entry.daf
    );
    comparison = { agree, tesseract: summarize(tesseractResult), googleVision: summarize(visionResult) };
    // Either engine's match is equally valid to build the real result from
    // once they agree (same tractate+daf) -- picks tesseract's arbitrarily.
    if (agree) match = tesseractResult.match;
  } else {
    const result = await ocrAndMatchOneEngine(engine);
    if (result.ocrError) {
      await logScanEvent({
        requested_engine: engine, engine_used: engine, matched: false,
        error: `header unreadable: ${result.ocrError}`.slice(0, 500),
      }).catch(() => {});
      return Response.json({ error: 'Could not read the page header.', detail: result.ocrError }, { status: 502 });
    }
    if (!result.match) {
      await logScanEvent({
        requested_engine: engine, engine_used: engine, matched: false, error: 'no daf matched the header',
      }).catch(() => {});
      return Response.json({ error: 'Could not identify the daf from this photo.', ocrText: result.ocrText }, { status: 422 });
    }
    match = result.match;
  }

  if (!match) {
    // Only reachable from 'both' mode with no agreement (or one/both
    // engines failing outright) -- comparison is always set in that case.
    // A real, if inconclusive, result: the reader sees exactly what each
    // engine found and can pick one to proceed with (re-submitting with
    // that specific engine forced, the normal single-engine path above) --
    // not a dead-end error.
    await logScanEvent({
      requested_engine: 'both', engine_used: 'both', matched: false, comparison_agree: false,
      error: 'engines disagreed or one/both failed to read the header',
    }).catch(() => {});
    return Response.json({ comparison }, { headers: { 'Access-Control-Allow-Origin': origin } });
  }

  // Both-mode only reaches past the `if (!match)` guard above when the two
  // engines agreed -- logged as 'both' rather than the arbitrary tesseract
  // pick summarize() above uses for entry/score, since both engines are
  // equally the reason this succeeded.
  const engineUsedLabel = engine === 'both' ? 'both' : engine;

  // Which amud the photo actually shows now comes from matchHeader's own
  // position-based detection (see resolveAmud in daf-header-vocabulary.mjs)
  // -- no longer the fixed "always amud a" guess the module docstring's
  // ORIGINAL known limitation described. a's own page data is still fetched
  // unconditionally regardless of which amud was detected (its absence is a
  // genuine "no data for this daf at all" error, unchanged from before); b's
  // is fetched best-effort alongside it, both so the reader can flip to it
  // client-side with no extra round trip AND so a detected amud b with no
  // published b data yet can fall back to a rather than reporting an amud
  // this response has no word positions for at all.
  const pageKeyBase = `${match.entry.tractate.replace(/\s+/g, '-')}-${match.entry.daf}`;
  const [pageResponseA, pageResponseB] = await Promise.all([
    fetch(`https://raw.githubusercontent.com/${OWNER}/${REPO}/results/pages/${pageKeyBase}a.json`),
    fetch(`https://raw.githubusercontent.com/${OWNER}/${REPO}/results/pages/${pageKeyBase}b.json`),
  ]);
  if (!pageResponseA.ok) {
    await logScanEvent({
      requested_engine: engine, engine_used: engineUsedLabel, matched: true,
      tractate: match.entry.tractate, daf: match.entry.daf, amud: match.amud || null,
      match_score: match.score, comparison_agree: engine === 'both' ? true : null,
      error: 'no word-position data published for this daf',
    }).catch(() => {});
    return Response.json(
      { error: `No word-position data for ${match.entry.tractate} ${match.entry.daf}.` },
      { status: 404 }
    );
  }
  const pageDataA = await pageResponseA.json();
  const pageDataB = pageResponseB.ok ? await pageResponseB.json() : null;
  // Falls back to 'a' when the header genuinely looked like amud b but that
  // side hasn't been published yet -- reporting an amud with no word
  // positions to show would be strictly worse than the previous always-a
  // behavior, not an improvement on it.
  const detectedAmud = match.amud === 'b' && pageDataB ? 'b' : 'a';

  // Text-block detection runs against the READER'S OWN PHOTO and the
  // corners they marked -- neither depends on which amud's canonical data
  // ends up being projected, so it only needs to run once and gets reused
  // for both a and b below, instead of redoing the same (non-trivial: a
  // fresh image decode plus the detection scan itself) work twice.
  //
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
  let detectedHomography = null;
  if (pageDataA.textBlock || pageDataB?.textBlock) {
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
      if (detected) detectedHomography = solveHomography(CANONICAL_CORNERS, detected.corners);
    } catch (error) {
      console.error('Text-block detection failed, falling back to page-relative word positions:', error);
    }
  }

  // Project each canonical word box through the homography above, then back
  // into photo-relative fractions (0-1) -- so the frontend can position
  // overlay elements with simple percentages, exactly the way it already
  // does for the Vilna-page view (renderVilnaWordBoxes in app.js).
  function projectWordBoxes(pageData) {
    let wordProjectionHomography = homography;
    let textBlockOrigin = { left: 0, top: 0, width: 1, height: 1 }; // identity: box.x/y already in this space
    if (pageData.textBlock && detectedHomography) {
      wordProjectionHomography = detectedHomography;
      const tb = pageData.textBlock;
      textBlockOrigin = { left: tb.left, top: tb.top, width: tb.right - tb.left, height: tb.bottom - tb.top };
    }
    return (pageData.wordBoxes || []).map((box) => {
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
  }

  const wordBoxes = projectWordBoxes(pageDataA);
  // Only present when this daf's amud-ב page has actually been published --
  // the client uses its mere presence to decide whether to show an amud
  // toggle at all (see updateScanAmudToggle in app.js), not a separate
  // availability flag.
  const wordBoxesB = pageDataB ? projectWordBoxes(pageDataB) : null;

  await logScanEvent({
    requested_engine: engine, engine_used: engineUsedLabel, matched: true,
    tractate: match.entry.tractate, daf: match.entry.daf, amud: detectedAmud,
    match_score: match.score, comparison_agree: engine === 'both' ? true : null,
  }).catch(() => {});

  return Response.json({
    ref: `${match.entry.tractate} ${match.entry.daf}${detectedAmud}`,
    tractate: match.entry.tractate,
    daf: match.entry.daf,
    // The header-position-detected amud (see resolveAmud), or 'a' when
    // detection was inconclusive or amud b's data isn't published yet --
    // the client uses this to decide which amud to show FIRST, not just
    // which fields are literally called wordBoxes/wordBoxesB below (those
    // stay tied to amud a/b specifically, unchanged, so the toggle can
    // still flip to whichever one wasn't shown first).
    amud: detectedAmud,
    matchScore: Math.round(match.score),
    wordBoxes,
    ...(wordBoxesB ? { wordBoxesB } : {}),
    // Only present for engine === 'both', and only reaches here when the
    // two engines agreed -- a disagreement/failure returns earlier, above,
    // with a comparison and no wordBoxes at all.
    ...(comparison ? { comparison } : {}),
  }, {
    headers: { 'Access-Control-Allow-Origin': origin },
  });
};

// Exported for tests/functions/scan-daf-page.test.mjs. Most of this handler
// needs live network access (GitHub, Google Vision, a real photo) and has no
// existing test coverage at all -- these three are the pure, synchronous
// pieces worth pinning down with synthetic fixture data mimicking Vision's
// and tesseract.js's own response shapes, same reasoning as link-preview.mjs's
// own __testing export.
export const __testing = {
  extractHeaderTokens,
  extractTesseractTokens,
  resolveHeaderBandFraction,
};

export const config = {
  path: '/api/scan-daf-page',
};
