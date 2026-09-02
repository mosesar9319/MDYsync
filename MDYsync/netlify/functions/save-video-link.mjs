// Publishes a playable video link (YouTube or direct URL) for a daf
// reference to the results branch, keyed by reference, so it's available
// on any device -- not just the browser that pasted it in. This is
// separate from the alignment publishing: a reader may paste a video
// link before ever syncing that daf, and a synced alignment's own
// videoSource is just the generic local filename the OCR job used
// internally, never a real link worth sharing across devices.

const OWNER = 'mosesar9319';
const REPO = 'MDYsync';
const ALLOWED_ORIGINS = new Set([
  'https://dafsync.netlify.app',
  'https://main--dafsync.netlify.app',
  'http://localhost:8080',
]);

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

  const { ref, videoSource } = body || {};
  if (typeof ref !== 'string' || !ref.trim() || ref.length > 80) {
    return Response.json({ error: 'A valid daf reference is required.' }, { status: 400 });
  }
  if (!videoSource || (videoSource.type !== 'youtube' && videoSource.type !== 'direct')) {
    return Response.json({ error: "videoSource.type must be 'youtube' or 'direct'." }, { status: 400 });
  }
  if (typeof videoSource.url !== 'string' || !/^https?:\/\//.test(videoSource.url) || videoSource.url.length > 2000) {
    return Response.json({ error: 'A valid http(s) video URL is required.' }, { status: 400 });
  }

  const token = Netlify.env.get('GITHUB_DISPATCH_TOKEN');
  if (!token) {
    return Response.json({ error: 'Server sync is not configured yet.' }, { status: 503 });
  }

  // A "(Chazarah Daf)" suffix marks the shorter chazara-only recording of
  // the same daf, and a "(Hebrew)" suffix marks the separate Hebrew-language
  // recording (see parseDafRef/refKey in app.js) -- either, both, or
  // neither can be present, in any order, so they're stripped in a loop
  // rather than a fixed-order regex. Each needs its own separate key from
  // the others, in the same Hebrew-/Chazarah-Daf-<Tractate>-<Daf><Amud>
  // format the frontend's own refKey() computes, or a link saved under one
  // would never be found looked up under another.
  let working = ref.trim();
  let chazarah = false;
  let hebrew = false;
  for (let pass = 0; pass < 2; pass++) {
    if (/\(Chazarah Daf\)\s*$/i.test(working)) { chazarah = true; working = working.replace(/\s*\(Chazarah Daf\)\s*$/i, ''); }
    if (/\(Hebrew\)\s*$/i.test(working)) { hebrew = true; working = working.replace(/\s*\(Hebrew\)\s*$/i, ''); }
  }
  const match = /^(.+?)\s+(\d+)\s*([abAB])(?:[:.]\d+)?$/i.exec(working.trim());
  const keyPrefix = (hebrew ? 'Hebrew-' : '') + (chazarah ? 'Chazarah-Daf-' : '');
  const refKey = match
    ? `${keyPrefix}${match[1].trim().replace(/\s+/g, '-')}-${match[2]}${match[3].toLowerCase()}`
    : ref.trim().replace(/\s+/g, '-');
  const safeVideoSource = {
    type: videoSource.type,
    url: videoSource.url,
    videoId: typeof videoSource.videoId === 'string' ? videoSource.videoId.slice(0, 32) : undefined,
    label: typeof videoSource.label === 'string' ? videoSource.label.slice(0, 100) : undefined,
    source: 'manual',
    // Off by default -- see youtube-channel-sync.mjs's own comment. Only
    // true when the reader explicitly ticks "Lock this video," so a plain
    // sync/paste (most saves) stays eligible for the hourly job to replace
    // with a genuinely newer channel upload of the same daf (e.g. the
    // finished edit replacing a rough cut), instead of losing that
    // eligibility forever just for having been saved through this endpoint.
    locked: videoSource.locked === true,
  };

  const dispatchResponse = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        event_type: 'save-video-link',
        client_payload: { refKey, videoSource: safeVideoSource },
      }),
    }
  );

  if (!dispatchResponse.ok) {
    const detail = await dispatchResponse.text();
    return Response.json(
      { error: 'Could not save the video link.', detail },
      { status: 502 }
    );
  }

  return Response.json({ refKey }, {
    headers: { 'Access-Control-Allow-Origin': origin },
  });
};

export const config = {
  path: '/api/save-video-link',
};
