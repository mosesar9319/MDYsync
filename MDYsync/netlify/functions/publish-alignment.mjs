// Lets the DafSync desktop app publish a finished alignment (produced by
// its own standalone "Sync" button, entirely locally) straight to the
// results branch, so it's available to every device the moment the sync
// finishes -- without the manual export/"Import sync" round trip. This is
// the only piece allowed to hold the GitHub token that can write to the
// repo -- the token lives in Netlify's own environment variables, never in
// the distributed desktop app (any secret baked into a distributed binary
// should be assumed extractable, so the app never gets one).
//
// Unlike the other functions here, this is called by a plain Python HTTP
// request from the desktop app, not by browser JS -- there is no Origin
// header to check (a non-browser client can omit or fake one anyway, so
// that check would be theater, not protection). The real boundary is input
// validation below, the same posture already accepted for the Drive-sync
// flow (trigger-ocr-job.mjs), which lets anyone who finds the site publish
// *some* alignment for *some* real daf ref -- this adds no new class of
// risk, just a second path to the same place.

const OWNER = 'mosesar9319';
const REPO = 'MDYsync';
const MAX_ALIGNMENT_BYTES = 8 * 1024 * 1024; // generous headroom over any real lecture's word timeline

function toBase64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export default async (request) => {
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const { refs, variant, language, alignment } = body || {};
  if (!Array.isArray(refs) || !refs.length || refs.length > 40
      || !refs.every((r) => typeof r === 'string' && r.length > 0 && r.length < 60)) {
    return Response.json({ error: 'A non-empty list of readings is required.' }, { status: 400 });
  }
  if (variant !== undefined && variant !== 'regular' && variant !== 'chazarah') {
    return Response.json({ error: "variant must be 'regular' or 'chazarah'." }, { status: 400 });
  }
  if (language !== undefined && language !== 'en' && language !== 'he') {
    return Response.json({ error: "language must be 'en' or 'he'." }, { status: 400 });
  }
  if (!alignment || typeof alignment !== 'object' || !Array.isArray(alignment.segments) || !alignment.segments.length) {
    return Response.json({ error: 'alignment must be an object with a non-empty segments array.' }, { status: 400 });
  }

  const serialized = JSON.stringify(alignment);
  if (serialized.length > MAX_ALIGNMENT_BYTES) {
    return Response.json({ error: 'Alignment payload is too large.' }, { status: 413 });
  }

  const token = Netlify.env.get('GITHUB_DISPATCH_TOKEN');
  if (!token) {
    return Response.json({ error: 'Server publish is not configured yet.' }, { status: 503 });
  }

  // Same namespacing as trigger-ocr-job.mjs/ocr-job.yml and the frontend's
  // own refKey() -- a "Chazarah Daf" reading (the shorter, gemara-only
  // recording of the same daf) and/or a Hebrew-language recording publish
  // under their own prefix(es), composed in this order, so none of the four
  // variant/language combinations collide with each other for the same ref.
  const keyPrefix = (language === 'he' ? 'Hebrew-' : '') + (variant === 'chazarah' ? 'Chazarah-Daf-' : '');
  const refKey = keyPrefix + refs[0].trim().replace(/\s+/g, '-');
  const path = `by-ref/${refKey}.json`;
  const apiUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  };

  // The Contents API needs the existing file's blob sha to update it (vs.
  // create); read it first, tolerating a 404 for a ref published for the
  // first time.
  let sha;
  try {
    const existing = await fetch(`${apiUrl}?ref=results`, { headers });
    if (existing.ok) {
      sha = (await existing.json()).sha;
    } else if (existing.status !== 404) {
      const detail = await existing.text();
      return Response.json({ error: 'Could not check the existing file.', detail }, { status: 502 });
    }
  } catch (error) {
    return Response.json({ error: `Could not reach GitHub: ${error.message}` }, { status: 502 });
  }

  try {
    const putResponse = await fetch(apiUrl, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: `Publish desktop-synced alignment for ${refs[0]}`,
        content: toBase64Utf8(serialized),
        branch: 'results',
        ...(sha ? { sha } : {}),
      }),
    });
    if (!putResponse.ok) {
      const detail = await putResponse.text();
      return Response.json({ error: 'Could not publish the alignment.', detail }, { status: 502 });
    }
  } catch (error) {
    return Response.json({ error: `Could not reach GitHub: ${error.message}` }, { status: 502 });
  }

  return Response.json({
    refKey,
    resultUrl: `https://raw.githubusercontent.com/${OWNER}/${REPO}/results/${path}`,
  });
};

export const config = {
  path: '/api/publish-alignment',
};
