// Banks a manual correction to a voice-recognition-sourced alignment as
// training data -- the whole point of "manually correct it and have that
// improve future accuracy" from the voice engine's own design (see
// voice_align.py's docstring). Not a model-weight fine-tuning pipeline (no
// GPU compute available for that yet) -- this just persists (what the
// engine originally guessed, what the admin actually corrected it to) pairs
// on the results branch, the same "database on a branch" every other piece
// of site data already lives in, for later use refining the matcher's own
// thresholds/phonetic-confusion table (see
// tools/caption-sync/build_voice_confusions.py) as real corrected examples
// accumulate.
//
// One file per correction (not overwritten) rather than one per daf, since
// the same daf could reasonably be corrected more than once and every
// correction is its own useful training example, not just the latest.

const OWNER = 'mosesar9319';
const REPO = 'MDYsync';
const ALLOWED_ORIGINS = new Set([
  'https://dafsync.netlify.app',
  'https://main--dafsync.netlify.app',
  'http://localhost:8080',
]);

const MAX_SEGMENTS = 500;

function isValidSegmentArray(value) {
  return Array.isArray(value) && value.length > 0 && value.length <= MAX_SEGMENTS
    && value.every((s) => s && typeof s.ref === 'string'
      && Number.isFinite(s.start) && Number.isFinite(s.end) && typeof s.he === 'string'
      && (s.heardText === undefined || typeof s.heardText === 'string'));
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

  const { ref, original, corrected } = body || {};
  if (typeof ref !== 'string' || !ref.trim() || ref.length > 80) {
    return Response.json({ error: 'A valid daf reference is required.' }, { status: 400 });
  }
  if (!isValidSegmentArray(original) || !isValidSegmentArray(corrected)) {
    return Response.json({ error: 'original and corrected must both be non-empty segment arrays.' }, { status: 400 });
  }

  const token = Netlify.env.get('GITHUB_DISPATCH_TOKEN');
  if (!token) {
    return Response.json({ error: 'Server sync is not configured yet.' }, { status: 503 });
  }

  const refKey = ref.trim().replace(/\s+/g, '-');
  const path = `voice-corrections/${refKey}-${Date.now()}.json`;
  const payload = {
    schema: 'dafsync-voice-correction-v1',
    ref: ref.trim(),
    // Trimmed to just what a future confusion-table/threshold pass would
    // actually use -- not the full alignment (video source, duration,
    // etc.), which is already published separately under by-ref/ and would
    // just be duplicated dead weight here. original[i].heardText (when
    // present) is what the engine actually recognized for that guess,
    // before it was matched to canonical text -- see app.js's
    // heardTextForSegment() -- the real evidence build_voice_confusions.py
    // diffs against corrected[i].he to find which letters this engine
    // actually confuses.
    original: original.map((s) => ({ ref: s.ref, start: s.start, end: s.end, he: s.he, heardText: s.heardText || '' })),
    corrected: corrected.map((s) => ({ ref: s.ref, start: s.start, end: s.end, he: s.he })),
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
        message: `Bank a voice-recognition correction for ${ref.trim()}`,
        content: Buffer.from(JSON.stringify(payload, null, 2) + '\n', 'utf8').toString('base64'),
        branch: 'results',
      }),
    }
  );
  if (!putResponse.ok) {
    const detail = await putResponse.text();
    return Response.json({ error: 'Could not save the correction.', detail }, { status: 502 });
  }

  return Response.json({ ok: true, path }, {
    headers: { 'Access-Control-Allow-Origin': origin },
  });
};

export const config = {
  path: '/api/save-voice-correction',
};
