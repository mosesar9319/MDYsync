// Google Vision auth + header-OCR response flattening, shared by every
// endpoint that reads a small header crop and needs Vision's or tesseract.js's
// text back as a flat {text, x} token list (see daf-header-vocabulary.mjs's
// matchHeader, which is what actually consumes that shape).
//
// Extracted out of scan-daf-page.mjs (the original, full-page scanner) so
// scan-daf-header.mjs (the new live, header-only scanner) can reuse the exact
// same JWT-bearer exchange and token-flattening logic instead of duplicating
// it -- two copies of a JWT-signing routine is exactly the kind of drift this
// file exists to prevent. scan-daf-page.mjs's own external behavior is
// unchanged by this extraction: it still calls these with the same arguments
// it always did (languageHints: ['he']), byte-for-byte the same request it
// sent before this file existed.
//
// SECURITY: nothing here ever logs a credential, private key, or API key --
// only ever their PRESENCE (a boolean) if a caller wants that. Both
// GOOGLE_VISION_API_KEY and GOOGLE_VISION_CREDENTIALS_JSON stay strictly
// server-side, read from Netlify env vars by each *-daf-*.mjs endpoint and
// passed in here as plain function arguments -- never returned, never part of
// any response body, never sent anywhere but Google's own token/Vision URLs.

import { createSign } from 'node:crypto';

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

// Same JWT-bearer exchange as page_ocr_align.py's own
// get_google_vision_access_token (there via the google-auth Python library;
// here by hand, since pulling in a whole OAuth client library for one token
// exchange isn't worth it in a Netlify function). A service account is the
// form some orgs' Cloud project policy requires instead of a plain API key
// ("API Keys are Disallowed ... use Application Default Credentials
// instead") -- this is that same ADC path, not a workaround for it.
export async function getGoogleVisionAccessToken(credentialsJson) {
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

// DOCUMENT_TEXT_DETECTION against a small header crop, plus the same choice
// between a plain API key and a service-account credential every other
// Vision caller in this repo makes (exactly one of the two is expected).
//
// languageHints is passed in by the CALLER, not hardcoded here: Google's
// documented Hebrew hint code is "iw", not the "he" this codebase has used
// since page_ocr_align.py's original implementation (confirmed directly
// against Google's own Vision language-support docs) -- but changing "he" to
// "iw" for the existing, already-shipped full-page pipeline is out of scope
// for the work that extracted this file, so scan-daf-page.mjs keeps passing
// ['he'] unchanged. Pass an empty array (or omit languageHints) to let Vision
// auto-detect instead of hinting at all.
export async function ocrHeaderGoogleVision(imageBuffer, { apiKey, credentialsJson, languageHints = [] } = {}) {
  const imageContext = languageHints.length ? { languageHints } : undefined;
  const payload = {
    requests: [{
      image: { content: imageBuffer.toString('base64') },
      features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
      ...(imageContext ? { imageContext } : {}),
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
    // Two different error shapes Vision can return: a per-image failure
    // comes back as responses[0].error (request itself was fine, this one
    // image couldn't be processed), but a malformed-request/auth/quota
    // failure comes back as a TOP-LEVEL data.error instead, with responses
    // entirely absent -- confirmed live against the deployed endpoint.
    throw new Error(result?.error?.message || data?.error?.message || `Vision request failed (${response.status})`);
  }
  return extractHeaderTokens(result.fullTextAnnotation);
}

// Flattens Vision's page > block > paragraph > word hierarchy into the flat
// {text, x, y, width, height} list matchHeader needs -- x/y are the word's
// own center in the source image's pixel space, width/height its box size
// (callers that upscale the crop before sending it get every value in that
// same upscaled space for every word, so comparing two words' geometry
// against each other within one response is unaffected by the scale factor
// even though neither is in the original photo's own coordinates). x alone
// is what matchHeader's own resolveAmud needs; the full box exists so a
// caller that wants to draw a highlight over a specific recognized word
// (see scan-daf-header.mjs's matchedWords) has somewhere to get it from
// without a second OCR pass. Returns the flat OCR'd text too.
export function extractHeaderTokens(fullTextAnnotation) {
  const text = fullTextAnnotation?.text || '';
  const tokens = [];
  for (const page of fullTextAnnotation?.pages || []) {
    for (const block of page.blocks || []) {
      for (const paragraph of block.paragraphs || []) {
        for (const word of paragraph.words || []) {
          const wordText = (word.symbols || []).map((s) => s.text).join('');
          const vertices = word.boundingBox?.vertices || [];
          const xs = vertices.map((v) => v.x || 0);
          const ys = vertices.map((v) => v.y || 0);
          if (!wordText || !xs.length) continue;
          const minX = Math.min(...xs), maxX = Math.max(...xs);
          const minY = Math.min(...ys), maxY = Math.max(...ys);
          tokens.push({
            text: wordText,
            x: (minX + maxX) / 2,
            y: (minY + maxY) / 2,
            width: maxX - minX,
            height: maxY - minY,
          });
        }
      }
    }
  }
  return { text, tokens };
}

// Same job as extractHeaderTokens above, for tesseract.js's own
// block > paragraph > line > word hierarchy (see node_modules/tesseract.js's
// own Page/Block/Paragraph/Line/Word types) -- there's no flat words list on
// its result the way Vision's response gets flattened above, so this walks
// the full nesting itself. bbox.x0/x1/y0/y1 are already in the cropped
// header image's own pixel space (tesseract runs directly on that buffer,
// no upscale step).
export function extractTesseractTokens(data) {
  const tokens = [];
  for (const block of data.blocks || []) {
    for (const paragraph of block.paragraphs || []) {
      for (const line of paragraph.lines || []) {
        for (const word of line.words || []) {
          if (!word.text || !word.bbox) continue;
          const { x0, x1, y0, y1 } = word.bbox;
          tokens.push({
            text: word.text,
            x: (x0 + x1) / 2,
            y: (y0 + y1) / 2,
            width: x1 - x0,
            height: y1 - y0,
          });
        }
      }
    }
  }
  return { text: data.text || '', tokens };
}

// --- Size-based filtering ------------------------------------------------
// Drops tokens that are noticeably SMALLER than the tallest token in the
// same crop -- catches small Rashi/Tosafot commentary text that leaked into
// a header crop (a real risk for a camera-framed live-scan capture: the
// reader's own alignment, or a slightly generous on-screen guide, unlike a
// precisely-cropped PDF render) before matchHeader ever sees it.
//
// Compares RAW OCR box heights directly. An earlier version of this
// function tried to normalize each height by the vertical span its own
// letters were expected to occupy (Hebrew ל rises above the letter band,
// ך ן ף ץ ק descend below it), on the theory that a short word like a daf
// number could otherwise read as "too small" purely for lacking those
// letters. That theory was built and calibrated against synthetic text
// rendered in generic system fonts (FreeSerif/Liberation), where an
// ascender or descender really does add ~35-45% extra box height. It does
// NOT hold for real printed Vilna Shas headers: measured directly from a
// real photo's own Vision OCR output, six header-line words at the exact
// same printed size -- with zero, one, or BOTH an ascender and a descender
// letter -- came back within 8% of each other in raw box height (109-120px:
// no-extent words at 119, an ascender-only word at 120, a descender-only
// word at 118, and the two words carrying BOTH -- "חולין" and "קלא",
// which happen to be exactly the tractate name and daf number this feature
// exists to identify -- at 117 and 112). The normalization model actively
// mis-scored those two: dividing their height by an assumed ~1.8x span,
// versus ~1.0-1.4x for the surrounding perek-name words that don't need
// both corrections, made them look smaller than the very words they were
// printed alongside at the same size, and the 0.6 relative-size cutoff
// dropped them outright -- reproduced live: a real Chullin 131a header
// scan returned matched:false, and the endpoint's raw OCR tokens showed
// both the tractate-name and daf-number tokens missing from the filtered
// list while five unrelated words (the perek/chapter name) survived.
//
// Real Rashi/Tosafot text differs from a header by a LARGE margin (a
// noticeably smaller point size, not a same-size ascender/descender
// wobble), so a plain raw-height comparison at the same 0.6 relative floor
// still does the job this filter exists for, without the false-drop risk
// the letter-shape model introduced.
//
// Two deliberate safety properties, because over-filtering here silently
// destroys a match while under-filtering merely leaves noise the matcher
// already tolerates:
//   - A token with no usable height is KEPT, not dropped, so an engine or
//     response that doesn't report reliable geometry behaves exactly as if
//     this filter never ran.
//   - If filtering would leave fewer than 2 tokens when at least 2 came in,
//     the ORIGINAL list is returned untouched. A header match fundamentally
//     needs two pieces (tractate name + daf number), so a result that can't
//     satisfy that is proof this filter over-reached on this particular
//     crop, and noise is the lesser failure.
export function filterTokensBySize(tokens, minRelativeSize = 0.6) {
  const heights = tokens
    .map((t) => t.height)
    .filter((h) => Number.isFinite(h) && h > 0);
  if (!heights.length) return tokens;
  const threshold = Math.max(...heights) * minRelativeSize;
  const kept = tokens.filter((t) => {
    const h = t.height;
    return !Number.isFinite(h) || h <= 0 || h >= threshold;
  });
  if (kept.length < 2 && tokens.length >= 2) return tokens;
  return kept;
}
