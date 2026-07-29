// Starts the server-side caption-OCR job for the website's "Google Drive
// link" and "YouTube link" sync flows. This is the only piece allowed to
// hold the GitHub token that can trigger the ocr-job.yml workflow — the
// token lives in Netlify's own environment variables, never in the browser.

const OWNER = 'mosesar9319';
const REPO = 'MDYsync';
const ALLOWED_ORIGINS = new Set([
  'https://mdysync.netlify.app',
  'https://main--mdysync.netlify.app',
  'http://localhost:8080',
]);

// A Drive link only ever gets used here because someone deliberately shared
// it as "Anyone with the link" -- that sharing action is itself an implicit
// signal the person triggering the sync has rights to that video. Grabbing
// an arbitrary public YouTube URL server-side to download and OCR carries no
// such signal, so per PRODUCTION_ARCHITECTURE.md's "an authorized YouTube
// Data API workflow for a channel the user controls" carve-out, YouTube
// sync is restricted to recent uploads of this one channel -- the same one
// youtube-channel-sync.mjs already trusts for auto-linking video URLs.
const YOUTUBE_CHANNEL_ID = 'UCKwQa5DB_VR98ac_r-Wyl-g'; // @MercazDafYomi

function extractYoutubeVideoId(url) {
  const match = /^https:\/\/(?:www\.)?(?:youtube\.com\/watch\?(?:.*&)?v=|youtu\.be\/)([\w-]{11})/.exec(url);
  return match ? match[1] : null;
}

async function isRecentUploadOfChannel(videoId) {
  const response = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${YOUTUBE_CHANNEL_ID}`);
  if (!response.ok) throw new Error(`YouTube feed returned ${response.status}`);
  const xml = await response.text();
  return xml.includes(`<yt:videoId>${videoId}</yt:videoId>`);
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

  const { driveUrl, youtubeUrl, refs, variant, language } = body || {};
  if (driveUrl !== undefined && youtubeUrl !== undefined) {
    return Response.json({ error: 'Provide either a Drive link or a YouTube link, not both.' }, { status: 400 });
  }
  let youtubeVideoId = null;
  if (youtubeUrl !== undefined) {
    youtubeVideoId = extractYoutubeVideoId(String(youtubeUrl || ''));
    if (!youtubeVideoId) {
      return Response.json({ error: 'Paste a valid YouTube video link.' }, { status: 400 });
    }
    let isChannelUpload;
    try {
      isChannelUpload = await isRecentUploadOfChannel(youtubeVideoId);
    } catch (error) {
      return Response.json({ error: `Could not verify the video's channel: ${error.message}` }, { status: 502 });
    }
    if (!isChannelUpload) {
      return Response.json({
        error: 'YouTube sync only works for recent Mercaz Daf Yomi uploads -- use a Google Drive link for anything else.'
      }, { status: 403 });
    }
  } else if (typeof driveUrl !== 'string' || !/^https:\/\/(drive|docs)\.google\.com\//.test(driveUrl)) {
    return Response.json({ error: 'A valid Google Drive link is required.' }, { status: 400 });
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
        event_type: 'run-ocr-job',
        client_payload: {
          driveUrl: driveUrl || null,
          youtubeUrl: youtubeUrl || null,
          refs, jobId, variant: variant || 'regular', language: language || 'en',
        },
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

  // The workflow publishes one copy of the result per daf reference it
  // covers (results/by-ref/<ref>.json), not a job-ID-keyed path, so that
  // any device can look up an already-synced daf directly. refs[0] is
  // the primary reading, matching how the alignment JSON itself sets
  // its own top-level dafRef. A "Chazarah Daf" reading (the shorter,
  // gemara-only-review recording of the same daf) and/or a Hebrew-language
  // recording are namespaced under their own prefix(es) so none of the four
  // variant/language combinations collide -- must match the frontend's own
  // refKey() exactly.
  const keyPrefix = (language === 'he' ? 'Hebrew-' : '') + (variant === 'chazarah' ? 'Chazarah-Daf-' : '');
  const refKey = keyPrefix + refs[0].trim().replace(/\s+/g, '-');

  return Response.json({
    jobId,
    resultUrl: `https://raw.githubusercontent.com/${OWNER}/${REPO}/results/by-ref/${refKey}.json`,
  }, {
    headers: { 'Access-Control-Allow-Origin': origin },
  });
};

export const config = {
  path: '/api/trigger-ocr-job',
};
