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
// AMUD: same combined position+punctuation signal scan-daf-page.mjs uses
// (daf number left of the tractate/perek name = amud א, right = amud ב;
// trailing period/comma on the daf number = amud א, colon = amud ב -- see
// resolveAmud in daf-header-vocabulary.mjs), falling back to 'a' the same
// way that file does whenever both signals are missing or agree-by-default
// (only one was legible). Unlike that file, THIS endpoint treats an actual
// disagreement between the two signals as more serious than plain missing
// signal -- it drops the whole match for that round rather than default to
// 'a', specifically so a conflicting frame can never satisfy the live
// scanner's multi-frame consensus and auto-navigate to a guessed amud (see
// the MIN_FIELD_SCORE block below). NOTE this endpoint's crop is a raw,
// unwarped on-screen guide cutout, not the homography-projected, page-
// corner-aligned region resolveAmud's position comparison was originally
// tuned and confirmed against -- see the amud assignment below for the
// caveat that follows from that.
//
// SECURITY: Google credentials (GOOGLE_VISION_API_KEY /
// GOOGLE_VISION_CREDENTIALS_JSON) are read server-side only, exactly like
// scan-daf-page.mjs, and are never echoed in a response, error message, or
// log line here.

import { Jimp } from 'jimp';
import { createWorker } from 'tesseract.js';
import { buildHeaderVocabulary, matchHeader, MASECHTA_HEBREW } from '../../shared/daf-header-vocabulary.mjs';
import { ocrHeaderGoogleVision, extractTesseractTokens, filterTokensBySize } from '../../shared/vision-header-ocr.mjs';
import { listAvailablePages } from '../../shared/available-dapim.mjs';
import { isAllowedOrigin } from '../../shared/dafsync-config.mjs';

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

// "he", matching scan-daf-page.mjs and page_ocr_align.py -- NOT "iw".
//
// This shipped as "iw" first, on the strength of Google's own language-
// support docs listing "iw" as the Hebrew code. That was a documentation
// reading, never an empirical one, and it was wrong in practice: with
// everything else held identical (same credentials, same 2.5x upscale +
// greyscale + normalize preprocessing, same vocabulary, same matchHeader),
// the legacy endpoint sending "he" matched a rendered Hebrew header at
// score 100 while this endpoint sending "iw" returned no match on the very
// same content, at every resolution from 280x56 up to 1200x240.
//
// So: stay on the value that is actually observed to work against the live
// API. Still env-var configurable (set SCAN_HEADER_LANGUAGE_HINT to "auto"
// for no hint at all and let Vision auto-detect, or to any other code to
// A/B it) so revisiting this needs a config change, not a deploy --
// resolveLanguageHints is the pure, directly-testable piece of that
// decision, see __testing below.
const DEFAULT_LANGUAGE_HINT = 'he';

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
  if (!isAllowedOrigin(origin)) {
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

  // Drops small Rashi/Tosafot-sized text that leaked into the crop before
  // matchHeader ever sees it. Compares each token's ESTIMATED FONT SIZE,
  // not its raw box height -- see filterTokensBySize in
  // shared/vision-header-ocr.mjs for why raw heights are unusable for
  // Hebrew (a measured 0.56x height ratio between two words at the SAME
  // font size, purely from ascender/descender letters) and for the
  // fall-back-to-unfiltered guard that keeps it from ever over-reaching.
  // Complementary to matchHeader's own punctuation-based noise filtering
  // (gematriaCandidates): this catches small text regardless of trailing
  // punctuation, that doesn't.
  const filteredTokens = filterTokensBySize(ocrResult.tokens);
  const availableDapim = await listAvailablePages(token, Object.keys(MASECHTA_HEBREW));
  const vocabulary = buildHeaderVocabulary(availableDapim);
  let match = matchHeader(filteredTokens, vocabulary);

  // TEMPORARY diagnostic echo -- NEVER reaches production. Gated on both
  // an explicit opt-in flag in the request body AND the request not coming
  // from the production origin, so this can't activate even if someone
  // guesses the flag name against the live site. No credential values are
  // ever included -- only this request's own OCR read of the image it was
  // just given. Exists purely to see Vision's actual raw token output for
  // one specific real-photo failure under live investigation; strip this
  // block out before this PR is considered done.
  if (body?.debugEcho === true && origin !== 'https://dafsync.netlify.app') {
    return Response.json({
      debug: true,
      ocrText: ocrResult.text,
      rawTokens: ocrResult.tokens,
      filteredTokens,
      matchResult: match ? {
        ref: `${match.entry.tractate} ${match.entry.daf}`,
        score: match.score, hebrewScore: match.hebrewScore, gematriaScore: match.gematriaScore,
        amud: match.amud, amudConflict: match.amudConflict,
      } : null,
    }, { headers: { 'Access-Control-Allow-Origin': origin } });
  }

  // Both halves of the header (tractate name AND daf number) have to be
  // individually legible, not just averaged into a passing overall score --
  // see matchHeader's own comment on hebrewScore/gematriaScore for the exact
  // failure this guards against (a confidently-read daf NUMBER with an
  // illegible tractate name, which is genuinely ambiguous: the same daf
  // number exists in nearly every tractate). This endpoint drives an
  // unattended auto-navigate with no reader confirmation step, so it holds
  // itself to a stricter bar here than scan-daf-page.mjs's own always-
  // reviewed-before-navigating flow does -- but 40 (out of matchHeader's own
  // 0-100 fuzzy-match scale) turned out too strict against real, noisy
  // phone-camera OCR reads during real-device testing, routinely rejecting
  // genuinely correct matches. 25 still reliably catches the specific
  // failure case this exists for (a confirmed, reproduced "only the daf
  // number was legible" read scores exactly 20 here -- see this file's own
  // test), just with more headroom for a real but imperfect read of the
  // tractate name.
  const MIN_FIELD_SCORE = 25;
  if (match && (match.hebrewScore < MIN_FIELD_SCORE || match.gematriaScore < MIN_FIELD_SCORE)) match = null;

  // resolveAmud (daf-header-vocabulary.mjs) now checks TWO independent amud
  // signals -- header layout position and the daf number's own trailing
  // punctuation -- and flags amudConflict when both were legible but
  // disagreed. This endpoint drives an unattended auto-navigate with no
  // reader confirmation step (see the MIN_FIELD_SCORE comment above for the
  // same reasoning applied to text matching), so a conflicting amud read
  // gets treated the same as no match at all here: it's dropped BEFORE the
  // response goes out, not defaulted to 'a' the way plain missing-signal
  // amud is below. That guarantees a conflicted round can never become part
  // of the live scanner's multi-frame consensus and lock in on a guessed
  // amud -- the very next frame (almost always a cleaner read) just gets a
  // fresh chance instead.
  if (match && match.amudConflict) match = null;

  if (!match) {
    await logScanEvent({
      requested_engine: engine, engine_used: engine, matched: false, error: 'no daf matched the header',
    }).catch(() => {});
    return Response.json({ matched: false }, { headers: { 'Access-Control-Allow-Origin': origin } });
  }

  // Same combined position+punctuation signal scan-daf-page.mjs uses (see
  // this file's own module comment, and resolveAmud in
  // daf-header-vocabulary.mjs) -- only ever trusts an explicit 'b' reading;
  // anything else falls back to 'a', the same fail-closed shape that file's
  // own detectedAmud uses. A genuine signal CONFLICT never reaches this
  // line at all -- it was already turned into `match = null` above, before
  // this point, specifically so it can't silently become a confident 'a'
  // here. What's left is only "no signal either way" (a real, weaker case
  // than a conflict), which still safely defaults to 'a'. Unlike
  // scan-daf-page.mjs, this crop is a raw, unwarped on-screen guide cutout
  // rather than a homography-projected, page-corner-aligned region --
  // resolveAmud's position comparison was tuned and confirmed against the
  // LATTER shape specifically, so how well it holds up on THIS crop shape
  // is exactly what real-device testing still needs to confirm (see this
  // feature's own known-limitations note).
  const amud = match.amud === 'b' ? 'b' : 'a';
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
