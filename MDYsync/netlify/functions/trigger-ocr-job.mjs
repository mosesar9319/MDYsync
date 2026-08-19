// Starts the server-side caption-OCR job for the website's "Google Drive
// link" and "YouTube link" sync flows. This is the only piece allowed to
// hold the GitHub token that can trigger the ocr-job.yml workflow — the
// token lives in Netlify's own environment variables, never in the browser.

const OWNER = 'mosesar9319';
const REPO = 'MDYsync';
const ALLOWED_ORIGINS = new Set([
  'https://mdysync.netlify.app',
  'https://main--mdysync.netlify.app',
  'https://dafsync.netlify.app',
  'https://main--dafsync.netlify.app',
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Which of a job's refs the recording is actually ABOUT -- the one whose
// by-ref/<ref>.json this job will really write. Kept in step with
// publish_alignment.py's primary_daf() on the workflow side: a shiur covers
// both amudim of its own daf but only the trailing amud of the one before
// it, so the daf contributing the most refs wins, ties breaking toward the
// later daf. Falls back to refs[0] if nothing parses, matching that
// function's own "treat everything as primary" fallback.
const DAF_REF_PATTERN = /^(.+?)\s+(\d+)([ab])$/i;
function pickPrimaryRef(refs) {
  const counts = new Map();
  for (const ref of refs) {
    const match = DAF_REF_PATTERN.exec(String(ref).trim());
    if (match) counts.set(Number(match[2]), (counts.get(Number(match[2])) || 0) + 1);
  }
  if (!counts.size) return refs[0];
  const most = Math.max(...counts.values());
  const primaryDaf = Math.max(...[...counts].filter(([, n]) => n === most).map(([daf]) => daf));
  return refs.find((ref) => {
    const match = DAF_REF_PATTERN.exec(String(ref).trim());
    return match && Number(match[2]) === primaryDaf;
  }) || refs[0];
}

// The feed below only carries this channel's ~15 most recent uploads, which
// makes re-syncing an OLDER daf impossible -- and re-syncing an older daf is
// exactly what repairing a bad alignment requires. (Six dapim needed exactly
// that after alignments were found keyed to the wrong recording; every one of
// their videos had long since fallen out of the feed.)
//
// A video already recorded in our own video-links/ catalog for one of the
// refs being synced carries the same signal the feed does, just durably: it
// only got there from this same channel poll (which checked the feed at the
// time) or from an admin deliberately linking it. So this doesn't widen who
// can sync what -- an arbitrary YouTube URL still can't be synced unless it
// is already this daf's linked video -- it just stops the check from expiring
// on videos it already accepted once.
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

// This public feed is genuinely flaky, not just occasionally slow --
// confirmed directly by hitting it several times in a row (some through
// this same function, some as a bare fetch): 200, then 404, then 500, then
// 404 again, no pattern to which channel_id or how much time had passed.
// A single fetch with no retry meant that flakiness took down the whole
// sync request on a plain coin-flip -- reported directly: two real reader
// attempts to sync Chullin 110 in immediate succession, one succeeding
// and the very next failing right here. Three tries with a short backoff
// is cheap insurance against exactly that, since a real, hard channel
// mismatch (a video that truly isn't a recent upload) will keep returning
// a normal 200 with the video absent from the feed either way -- only a
// bad HTTP status is worth retrying.
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
        error: 'YouTube sync only works for Mercaz Daf Yomi uploads -- use a Google Drive link for anything else.'
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

  // The workflow publishes the result per daf reference the recording is
  // actually ABOUT (results/by-ref/<ref>.json), not a job-ID-keyed path, so
  // any device can look up an already-synced daf directly. A "Chazarah Daf"
  // reading (the shorter, gemara-only-review recording of the same daf)
  // and/or a Hebrew-language recording are namespaced under their own
  // prefix(es) so none of the four variant/language combinations collide --
  // must match the frontend's own refKey() exactly.
  //
  // Deliberately NOT refs[0]: a shiur opens by reviewing the tail of the
  // PREVIOUS daf, so refs[0] is usually that lead-in ref -- and lead-in
  // coverage no longer gets its own by-ref entry (see publish_alignment.py,
  // which keeps it in the by-video file instead so it can't displace that
  // daf's own shiur). Polling refs[0] would therefore wait on a path this
  // job never writes, leaving the sync dialog stuck on "Processing on the
  // server…" through a job that actually succeeded. Mirrors
  // publish_alignment.py's primary_daf(): the daf contributing the most refs
  // is the one the recording is about, ties breaking toward the later daf.
  const keyPrefix = (language === 'he' ? 'Hebrew-' : '') + (variant === 'chazarah' ? 'Chazarah-Daf-' : '');
  const primaryRef = pickPrimaryRef(refs);
  const refKey = keyPrefix + primaryRef.trim().replace(/\s+/g, '-');

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
