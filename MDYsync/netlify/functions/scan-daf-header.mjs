// The live, shutter-free Daf Scan endpoint: identifies which daf a small
// HEADER-ONLY crop shows, nothing else. This is deliberately NOT the full
// scan-daf-page.mjs pipeline -- no four-corner projection, no homography, no
// per-word canonical-page positions, no text-block detection. The client
// (scan-live.js) already crops the live camera feed down to just the
// on-screen header guide before ever calling this, the same
// object-fit:cover inverse-math app.js's computeCaptureSourceRect already
// does for the legacy capture flow (see that function's own comment) --
// this endpoint OCRs whatever crop it's handed and tries to match it against
// the same closed header vocabulary scan-daf-page.mjs uses, full stop.
//
// Called repeatedly, roughly every 800-1200ms, for as long as the reader has
// the live scanner open and hasn't been recognized yet -- so this needs to
// stay cheap and fast, not just correct. That's the main reason this is a
// separate endpoint rather than a "lite mode" flag on scan-daf-page.mjs: a
// request here skips homography solving, GitHub page-data fetches beyond the
// one vocabulary listing, and (most importantly for latency) never spins up
// a tesseract.js worker unless Vision isn't configured at all -- worker
// startup cost is fine to pay ONCE per full-page scan, not dozens of times a
// minute during live framing.
//
// AMUD: unlike scan-daf-page.mjs, this endpoint NEVER reports a
// position-based amud guess, even though matchHeader/resolveAmud compute
// one internally -- see the module comment on amud below for why.
//
// SECURITY: Google credentials (GOOGLE_VISION_API_KEY /
// GOOGLE_VISION_CREDENTIALS_JSON) are read server-side only, exactly like
// scan-daf-page.mjs, and are never echoed in a response, error message, or
// log line here.

import { Jimp } from 'jimp';
import { createWorker } from 'tesseract.js';
import { buildHeaderVocabulary, matchHeader, MASECHTA_HEBREW } from '../../shared/daf-header-vocabulary.mjs';
import { ocrHeaderGoogleVision, extractTesseractTokens } from '../../shared/vision-header-ocr.mjs';
import { listAvailablePages } from '../../shared/available-dapim.mjs';
import { ALLOWED_ORIGINS } from '../../shared/dafsync-config.mjs';

// A header-guide crop only -- the client sends just the cutout region, not a
// whole photo (contrast with scan-daf-page.mjs's MAX_IMAGE_BYTES, which has
// to allow a full page photo). Generous for a small, already-downscaled
// crop while still bounding worst-case request cost/abuse.
const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;

// Same upscale finding as scan-daf-page.mjs's own VISION_UPSCALE_FACTOR
// (Vision's DOCUMENT_TEXT_DETECTION misses small glyphs at native header-crop
// resolution) -- kept as its own constant here rather than imported, since
// this file's crop pipeline (client-side crop, no server-side homography) is
// different enough that tying the two together would be more confusing than
// two short, independently-documented constants.
const VISION_UPSCALE_FACTOR = 2.5;

// Google's own documented Hebrew OCR hint code is "iw", not the "he" this
// codebase has used everywhere else since page_ocr_align.py's original
// implementation (confirmed directly against Vision's language-support
// docs: https://cloud.google.com/vision/docs/languages). Fixing "he" -> "iw"
// in the existing, already-shipped scan-daf-page.mjs pipeline is out of
// scope here -- this is a NEW endpoint, so it gets the corrected code
// without touching that one.
//
// Configurable via env var rather than hardcoded, specifically so the
// language-hint-vs-auto-detect question can actually be tested against real
// devices/photos without a code change: set SCAN_HEADER_LANGUAGE_HINT to
// "auto" (or leave it unset with no default) to send no languageHints at all
// and let Vision auto-detect instead. resolveLanguageHints is the pure,
// directly-testable piece of that decision -- see __testing below.
const DEFAULT_LANGUAGE_HINT = 'iw';

function env(name) {
  if (typeof Netlify !== 'undefined' && Netlify.env) return Netlify.env.get(name) || '';
  return process.env[name] || '';
}

// Converts one winning OCR token's box (in the OCR'd, possibly-upscaled
// image's own pixel space) into a fraction (0-1) of the crop exactly as the
// client sent it -- scale is VISION_UPSCALE_FACTOR when this token came from
// an upscaled Vision request, 1 for tesseract (never upscaled). Fractions,
// not pixels, so the client can position a highlight over its own on-screen
// guide cutout with simple percentages, the same convention every other
// word-overlay on this site already uses (renderVilnaWordBoxes,
// renderScanMatch in app.js). Returns null for a token with no real geometry
// (e.g. a Vision response that never populated y/width/height) rather than a
// nonsensical zero-size box.
export function tokenToFractionalBox(token, scale, cropWidth, cropHeight) {
  if (!token || !cropWidth || !cropHeight) return null;
  const { x, y, width, height } = token;
  if (![x, y, width, height].every(Number.isFinite)) return null;
  return {
    left: (x - width / 2) / scale / cropWidth,
    top: (y - height / 2) / scale / cropHeight,
    width: width / scale / cropWidth,
    height: height / scale / cropHeight,
  };
}

export function resolveLanguageHints(configured) {
  // env() (this file's own helper) returns '' for an unset var, not
  // undefined -- treated the same as "not configured" here so the default
  // applies either way, matching every call site's actual input shape.
  const trimmed = String(configured ?? '').trim();
  const value = trimmed || DEFAULT_LANGUAGE_HINT;
  if (value.toLowerCase() === 'auto') return [];
  return [value];
}

// --- Diagnostic logging -- same table/shape as scan-daf-page.mjs's own
// logScanEvent (see supabase/migrations/20260913150000_scan_events_logging.sql),
// requested_engine/engine_used here is always whichever single engine this
// endpoint used ('tesseract' or 'google-vision') -- there is no 'both' mode
// in the live flow, only one engine ever runs per request.
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

  const { imageBase64 } = body || {};
  if (typeof imageBase64 !== 'string' || !imageBase64) {
    return Response.json({ error: 'imageBase64 is required.' }, { status: 400 });
  }
  // Estimated from the base64 string length rather than decoding first, so
  // an oversized upload is rejected before doing that work at all.
  if (imageBase64.length * 0.75 > MAX_IMAGE_BYTES) {
    return Response.json({ error: 'Image too large.' }, { status: 413 });
  }

  const token = Netlify.env.get('GITHUB_DISPATCH_TOKEN');
  if (!token) {
    return Response.json({ error: 'Server sync is not configured yet.' }, { status: 503 });
  }

  const visionApiKey = Netlify.env.get('GOOGLE_VISION_API_KEY');
  const visionCredentialsJson = Netlify.env.get('GOOGLE_VISION_CREDENTIALS_JSON');
  const hasVisionCredential = Boolean(visionApiKey || visionCredentialsJson);
  // Vision when configured (fast, no per-request worker startup) --
  // tesseract only as a last resort, since a fresh worker per call is a poor
  // fit for a request this endpoint expects to receive every ~1s while the
  // live scanner is open. Unlike scan-daf-page.mjs, the client never
  // requests a specific engine here -- there's no reader-facing engine
  // toggle in the live flow, only the one automatic choice.
  const engine = hasVisionCredential ? 'google-vision' : 'tesseract';

  let imageBuffer;
  try {
    imageBuffer = Buffer.from(imageBase64, 'base64');
  } catch {
    return Response.json({ error: 'Could not decode the image.' }, { status: 400 });
  }

  let ocrResult; // { text, tokens }
  // cropWidth/cropHeight/scale set inside the try block below but read again
  // afterward (to build matchedWords) -- declared out here so they survive
  // past it rather than being scoped to that block alone.
  let cropWidth = 0, cropHeight = 0;
  const scale = engine === 'google-vision' ? VISION_UPSCALE_FACTOR : 1;
  try {
    // Same greyscale+normalize preprocessing scan-daf-page.mjs's own crop
    // step uses, confirmed directly (A/B tested against a real photo and a
    // synthetically degraded one) to help both engines read the daf number
    // reliably -- see that file's own comment for the fixed-contrast boost
    // that was tried and reverted.
    const image = await Jimp.read(imageBuffer);
    // Captured before any scale() call below -- the dimensions of the crop
    // exactly as the client sent it, which is what matchedWords' fractions
    // (see below) need to be relative to, since that's the same rect the
    // client can map straight back onto its own on-screen guide cutout.
    cropWidth = image.bitmap.width;
    cropHeight = image.bitmap.height;
    if (engine === 'google-vision') image.scale(VISION_UPSCALE_FACTOR);
    image.greyscale();
    image.normalize();
    const preparedBuffer = await image.getBuffer('image/png');

    if (engine === 'google-vision') {
      const languageHints = resolveLanguageHints(env('SCAN_HEADER_LANGUAGE_HINT'));
      ocrResult = await ocrHeaderGoogleVision(preparedBuffer, {
        apiKey: visionApiKey, credentialsJson: visionCredentialsJson, languageHints,
      });
    } else {
      const worker = await createWorker('heb');
      try {
        const { data } = await worker.recognize(preparedBuffer);
        ocrResult = extractTesseractTokens(data);
      } finally {
        await worker.terminate();
      }
    }
  } catch (error) {
    await logScanEvent({
      requested_engine: engine, engine_used: engine, matched: false,
      error: `header unreadable: ${error.message || 'unknown error'}`.slice(0, 500),
    }).catch(() => {});
    return Response.json({ matched: false, error: 'Could not read the header.' }, { status: 502 });
  }

  const availableDapim = await listAvailablePages(token, Object.keys(MASECHTA_HEBREW));
  const vocabulary = buildHeaderVocabulary(availableDapim);
  let match = matchHeader(ocrResult.tokens, vocabulary);

  // Both halves of the header (tractate name AND daf number) have to be
  // individually legible, not just averaged into a passing overall score --
  // see matchHeader's own comment on hebrewScore/gematriaScore for the exact
  // failure this guards against (a confidently-read daf NUMBER with an
  // illegible tractate name, which is genuinely ambiguous: the same daf
  // number exists in nearly every tractate). This endpoint drives an
  // unattended auto-navigate with no reader confirmation step, so it holds
  // itself to a stricter bar here than scan-daf-page.mjs's own always-
  // reviewed-before-navigating flow does.
  const MIN_FIELD_SCORE = 40;
  if (match && (match.hebrewScore < MIN_FIELD_SCORE || match.gematriaScore < MIN_FIELD_SCORE)) match = null;

  if (!match) {
    await logScanEvent({
      requested_engine: engine, engine_used: engine, matched: false, error: 'no daf matched the header',
    }).catch(() => {});
    return Response.json({ matched: false }, { headers: { 'Access-Control-Allow-Origin': origin } });
  }

  // Deliberately 'a', always -- NOT match.amud. Two independent reasons:
  //  1. The task this endpoint was built for explicitly requires preserving
  //     the site's existing safe default-to-'a' behavior for this NEW flow
  //     until position-based amud inference has been proven reliable
  //     against real devices, which is real-world testing this endpoint's
  //     own author cannot do from here.
  //  2. matchHeader's resolveAmud signal was tuned and confirmed against
  //     scan-daf-page.mjs's own header crop, which is produced by a
  //     homography-projected, page-corner-aligned region -- structurally
  //     different from this endpoint's crop (a raw on-screen guide cutout,
  //     no perspective correction at all). Reusing that signal here without
  //     separately validating it against THIS crop shape would be claiming
  //     amud recognition this endpoint hasn't actually earned.
  // match.amud is still computed above (inside matchHeader) and simply
  // discarded here -- not blanked out inside matchHeader itself, since
  // scan-daf-page.mjs's own call still needs and uses it correctly.
  const amud = 'a';
  const ref = `${match.entry.tractate} ${match.entry.daf}${amud}`;

  // Up to two boxes -- the tractate-name word and the daf-number word that
  // actually won the match -- for the client to draw a green highlight over
  // on its own live overlay. Either can be missing (a token with no real
  // geometry) without the match itself being any less valid, so this is
  // always best-effort and never blocks the response.
  const matchedWords = [match.hebrewToken, match.gematriaToken]
    .map((t) => tokenToFractionalBox(t, scale, cropWidth, cropHeight))
    .filter(Boolean);

  await logScanEvent({
    requested_engine: engine, engine_used: engine, matched: true,
    tractate: match.entry.tractate, daf: match.entry.daf, amud, match_score: match.score,
  }).catch(() => {});

  return Response.json({
    matched: true,
    ref,
    tractate: match.entry.tractate,
    daf: match.entry.daf,
    amud,
    matchScore: Math.round(match.score),
    matchedWords,
  }, {
    headers: { 'Access-Control-Allow-Origin': origin },
  });
};

// Exported for tests/functions/scan-daf-header.test.mjs -- resolveLanguageHints
// and tokenToFractionalBox are the pieces of this handler worth pinning down
// with synthetic input alone; the rest needs live network access the same
// way scan-daf-page.mjs's own handler does.
export const __testing = {
  resolveLanguageHints,
  tokenToFractionalBox,
};

export const config = {
  path: '/api/scan-daf-header',
};
