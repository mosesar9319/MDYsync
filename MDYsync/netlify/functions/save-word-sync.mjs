// Banks a from-scratch manual phrase sync as training data -- see
// app.js's bankManualPhraseSync() for when this fires. Unlike
// save-voice-correction.mjs (which banks an engine's original guess next
// to the admin's fix), there's no automated guess here at all: the admin
// hand-defined the phrase boundaries themselves (see splitSegmentAtWord in
// app.js) and tapped in the real timing, so what's banked is just the
// finished (phrase text, real timestamp) pairs -- ground truth rather than
// a correction diff, but the same eventual use: refining voice_align.py's
// matcher as real examples accumulate.
//
// One file per save (not overwritten), same reasoning as
// save-voice-correction.mjs: the same daf could reasonably be resynced
// more than once, and each pass is its own useful example.

const OWNER = 'mosesar9319';
const REPO = 'MDYsync';
const ALLOWED_ORIGINS = new Set([
  'https://mdysync.netlify.app',
  'https://main--mdysync.netlify.app',
  'https://dafsync.netlify.app',
  'https://main--dafsync.netlify.app',
  'http://localhost:8080',
]);

// A full amud split into short hand-picked phrases can run to several
// hundred rows -- generous headroom past save-voice-correction.mjs's cap
// (which only ever deals with one phrase-diff at a time), still well short
// of anything pathological.
const MAX_SEGMENTS = 2000;

function isValidSegmentArray(value) {
  return Array.isArray(value) && value.length > 0 && value.length <= MAX_SEGMENTS
    && value.every((s) => s && typeof s.ref === 'string'
      && Number.isFinite(s.start) && Number.isFinite(s.end) && typeof s.he === 'string');
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

  const { ref, videoSource, segments } = body || {};
  if (typeof ref !== 'string' || !ref.trim() || ref.length > 80) {
    return Response.json({ error: 'A valid daf reference is required.' }, { status: 400 });
  }
  if (!isValidSegmentArray(segments)) {
    return Response.json({ error: 'segments must be a non-empty array of {ref, start, end, he}.' }, { status: 400 });
  }

  const token = Netlify.env.get('GITHUB_DISPATCH_TOKEN');
  if (!token) {
    return Response.json({ error: 'Server sync is not configured yet.' }, { status: 503 });
  }

  const refKey = ref.trim().replace(/\s+/g, '-');
  const path = `word-sync/${refKey}-${Date.now()}.json`;
  const payload = {
    schema: 'dafsync-manual-sync-v1',
    ref: ref.trim(),
    videoSource: videoSource || null,
    segments: segments.map((s) => ({ ref: s.ref, start: s.start, end: s.end, he: s.he })),
    savedAt: new Date().toISOString(),
  };

  const putResponse = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: `Bank a manual phrase sync for ${ref.trim()}`,
        content: Buffer.from(JSON.stringify(payload, null, 2) + '\n', 'utf8').toString('base64'),
        branch: 'results',
      }),
    }
  );
  if (!putResponse.ok) {
    const detail = await putResponse.text();
    return Response.json({ error: 'Could not save the manual sync.', detail }, { status: 502 });
  }

  return Response.json({ ok: true, path }, {
    headers: { 'Access-Control-Allow-Origin': origin },
  });
};

export const config = {
  path: '/api/save-word-sync',
};
