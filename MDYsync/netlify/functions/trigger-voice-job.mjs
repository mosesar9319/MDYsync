// Starts the server-side voice-recognition job for the website's "Voice
// recognition (beta)" sync tab. Mirrors trigger-ocr-job.mjs's pattern
// (only this piece holds the GitHub token that can trigger a workflow, kept
// in Netlify's own environment variables, never the browser) but YouTube-
// only for now, matching the sync dialog tab it serves -- no Google Drive
// path yet, since this is a beta feature, not the default sync method.

const OWNER = 'mosesar9319';
const REPO = 'MDYsync';
const ALLOWED_ORIGINS = new Set([
  'https://mdysync.netlify.app',
  'https://main--mdysync.netlify.app',
  'https://dafsync.netlify.app',
  'https://main--dafsync.netlify.app',
  'http://localhost:8080',
]);

// Same "authorized channel" restriction trigger-ocr-job.mjs applies to its
// own YouTube tab, and for the same reason (PRODUCTION_ARCHITECTURE.md's
// "authorized YouTube Data API workflow for a channel the user controls"
// carve-out) -- grabbing an arbitrary public YouTube URL server-side to
// download carries no rights signal the way a Drive link shared with this
// account does.
const YOUTUBE_CHANNEL_ID = 'UCKwQa5DB_VR98ac_r-Wyl-g'; // @MercazDafYomi

function extractYoutubeVideoId(url) {
  const match = /^https:\/\/(?:www\.)?(?:youtube\.com\/watch\?(?:.*&)?v=|youtu\.be\/)([\w-]{11})/.exec(url);
  return match ? match[1] : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// This public feed is genuinely flaky, not just occasionally slow -- see
// trigger-ocr-job.mjs's own copy of this function for the full story (confirmed
// directly: 200, then 404, then 500, then 404 again, no pattern). A single
// unguarded fetch, which is all this function used to do, meant that
// flakiness took down the whole sync request on a plain coin-flip -- reported
// directly against this exact video/channel. Three tries with a short
// backoff is cheap insurance against exactly that.
async function isRecentUploadOfChannel(videoId) {
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${YOUTUBE_CHANNEL_ID}`;
  let lastStatus;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await sleep(500 * attempt);
    const response = await fetch(feedUrl);
    if (response.ok) {
      const xml = await response.text();
      return xml.includes(`<yt:videoId>${videoId}</yt:videoId>`);
    }
    lastStatus = response.status;
  }
  throw new Error(`YouTube feed returned ${lastStatus} (after 3 attempts)`);
}

// Same fallback trigger-ocr-job.mjs's own isLinkedVideoForAnyRef uses, and for
// the same reason: a video already recorded in the shared video-links/
// catalog for one of the refs being synced carries the same "this is a real
// upload of the authorized channel" signal the feed does, just durably, so a
// flaky/unreachable feed doesn't have to fail the whole request when this
// independent signal is available instead.
async function isLinkedVideoForAnyRef(videoId, refs, prefix) {
  for (const ref of refs.slice(0, 8)) {
    const key = prefix + String(ref).trim().replace(/\s+/g, '-');
    try {
      const response = await fetch(
        `https://raw.githubusercontent.com/${OWNER}/${REPO}/results/video-links/${encodeURIComponent(key)}.json`
      );
      if (!response.ok) continue;
      const link = await response.json();
      if (link?.videoId === videoId) return true;
    } catch {
      // Unreachable/unparseable -- fall through to the next ref rather than
      // failing the whole request on one bad lookup.
    }
  }
  return false;
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

  const { youtubeUrl, refs, variant, language } = body || {};
  const youtubeVideoId = extractYoutubeVideoId(String(youtubeUrl || ''));
  if (!youtubeVideoId) {
    return Response.json({ error: 'Paste a valid YouTube video link.' }, { status: 400 });
  }
  let isChannelUpload;
  let feedError = null;
  try {
    isChannelUpload = await isRecentUploadOfChannel(youtubeVideoId);
  } catch (error) {
    // Don't fail outright yet -- the catalog check below is an independent
    // signal that doesn't depend on the feed being reachable at all.
    feedError = error;
    isChannelUpload = false;
  }
  if (!isChannelUpload && Array.isArray(refs) && refs.length) {
    const linkPrefix = (language === 'he' ? 'Hebrew-' : '') + (variant === 'chazarah' ? 'Chazarah-Daf-' : '');
    isChannelUpload = await isLinkedVideoForAnyRef(youtubeVideoId, refs, linkPrefix);
  }
  if (!isChannelUpload) {
    if (feedError) {
      return Response.json({ error: `Could not verify the video's channel: ${feedError.message}` }, { status: 502 });
    }
    return Response.json({
      error: 'Voice recognition sync only works for recent Mercaz Daf Yomi uploads.'
    }, { status: 403 });
  }
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

  const token = Netlify.env.get('GITHUB_DISPATCH_TOKEN');
  if (!token) {
    return Response.json({ error: 'Server sync is not configured yet.' }, { status: 503 });
  }

  const jobId = crypto.randomUUID().replace(/-/g, '');

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
        event_type: 'run-voice-job',
        client_payload: { youtubeUrl, refs, jobId, variant: variant || 'regular', language: language || 'en' },
      }),
    }
  );

  if (!dispatchResponse.ok) {
    const detail = await dispatchResponse.text();
    return Response.json(
      { error: 'Could not start the server job.', detail },
      { status: 502 }
    );
  }

  // A distinct 'Voice-' prefixed key, not the same by-ref/<ref>.json path
  // trigger-ocr-job.mjs's own resultUrl points at -- publishing to the same
  // path would let a caption-OCR sync and a voice-recognition sync started
  // on the same daf race to silently overwrite each other's result (see
  // voice-job.yml's publish step, which writes under this same prefix).
  // The player fetches both keys and lets the reader choose between them.
  const keyPrefix = 'Voice-' + (language === 'he' ? 'Hebrew-' : '') + (variant === 'chazarah' ? 'Chazarah-Daf-' : '');
  const refKey = keyPrefix + refs[0].trim().replace(/\s+/g, '-');

  return Response.json({
    jobId,
    resultUrl: `https://raw.githubusercontent.com/${OWNER}/${REPO}/results/by-ref/${refKey}.json`,
  }, {
    headers: { 'Access-Control-Allow-Origin': origin },
  });
};

export const config = {
  path: '/api/trigger-voice-job',
};
