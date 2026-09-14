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

// --- Glyph-extent normalization ----------------------------------------------
// A word's OCR bounding-box height is NOT a usable proxy for its font size on
// its own, because Hebrew letters occupy very different vertical bands:
//
//   ל          rises well ABOVE the normal letter height (the only ascender)
//   ך ן ף ץ ק  descend well BELOW the baseline
//   everything else sits within the plain letter band
//
// So "חולין" (which has BOTH ל and ן) produces a box roughly 1.8x as tall as
// "פט" (which has neither) at the exact same printed font size. Measured
// directly, rendering each letter in two different serif faces:
//
//   ל  +0.41 above      ך +0.44/+0.33   ן +0.44/+0.34
//   ק  +0.47/+0.33      ף +0.44/+0.33   ץ +0.45/+0.33   (FreeSerif/Liberation)
//
// and end to end on real rendered header text:
//
//   חולין  118px raw -> 0.56x the height of ... no: 1.00 (reference)
//   פט.     66px raw -> 0.56x  <-- same font size, yet barely half as tall
//   קל.    120px raw -> 1.02x  <-- same font size again
//
// That 0.56 is the whole bug this normalization exists to fix: a naive
// "drop anything under 60% of the tallest token" rule throws away the DAF
// NUMBER of a perfectly good header, because short-glyph gematria like פט
// legitimately measures ~56% of a tractate name carrying an ascender and a
// descender. Dividing each box height by the vertical span its own letters
// are EXPECTED to occupy recovers the underlying font size instead:
// the three tokens above normalize to 65.6 / 66.0 / 66.7 -- within 2%.
const HEBREW_ASCENDERS = new Set(['ל']);
const HEBREW_DESCENDERS = new Set(['ך', 'ן', 'ף', 'ץ', 'ק']);
// Measured at +0.33..+0.47 across two faces; 0.4 is the middle of that range.
// ע descends in some faces (+0.34) but not others, so it is deliberately NOT
// listed -- an over-correction on a face where it doesn't descend would
// shrink that token's estimated size and risk dropping a real word, which is
// strictly worse than simply not correcting for it.
const GLYPH_EXTENT = 0.4;

// The vertical span, in "plain letter height" units, that `text`'s own
// letters are expected to occupy. 1.0 for ordinary text, up to ~1.8 for a
// word carrying both an ascender and a descender.
export function expectedGlyphSpan(text) {
  let span = 1;
  const chars = [...String(text || '')];
  if (chars.some((c) => HEBREW_ASCENDERS.has(c))) span += GLYPH_EXTENT;
  if (chars.some((c) => HEBREW_DESCENDERS.has(c))) span += GLYPH_EXTENT;
  return span;
}

// One token's estimated FONT SIZE (not box height): its measured box height
// divided by the span its letters were expected to occupy. Comparable
// across words regardless of which letters they happen to contain.
export function estimateGlyphUnit(token) {
  if (!token || !Number.isFinite(token.height) || token.height <= 0) return null;
  return token.height / expectedGlyphSpan(token.text);
}

// Drops tokens whose estimated font size marks them as smaller commentary
// text (Rashi/Tosafot, printed noticeably smaller than a Vilna page's own
// header) that leaked into a header crop -- a real risk for a camera-framed
// crop (the reader's own alignment, or a slightly generous on-screen guide)
// in a way a precisely-cropped PDF render never has.
//
// Compares ESTIMATED FONT SIZES (see estimateGlyphUnit), never raw box
// heights -- see the long comment above for why raw heights are unusable
// here -- relative to the largest one in the SAME crop, so the comparison
// scales automatically with whatever resolution/upscale this particular
// photo went through rather than depending on any absolute pixel threshold.
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
  const units = tokens.map(estimateGlyphUnit).filter((u) => u !== null);
  if (!units.length) return tokens;
  const threshold = Math.max(...units) * minRelativeSize;
  const kept = tokens.filter((t) => {
    const unit = estimateGlyphUnit(t);
    return unit === null || unit >= threshold;
  });
  if (kept.length < 2 && tokens.length >= 2) return tokens;
  return kept;
}
