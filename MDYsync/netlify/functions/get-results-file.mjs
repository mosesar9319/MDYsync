// Proxies a JSON file from the results branch (a synced alignment under
// by-ref/, a published video-links/ entry, a Vilna page word-position map
// under pages/, or the site-wide settings.json) instead of letting the
// browser fetch it straight from raw.githubusercontent.com. Same root
// cause as get-catalog.mjs: that endpoint is unauthenticated and rate-
// limited per source IP, and readers sharing an IP (a mobile carrier's
// NAT, a school/office network) can collectively exceed it -- confirmed
// live, on this exact class of fetch, for a real reader.
//
// This one matters more than the home-page catalog fetch: a 429 here reads
// identically to "this daf/page genuinely has nothing synced yet" to every
// caller (they all just check response.ok), which is actively harmful for
// the Vilna page fetch specifically -- loadVilnaPageMap (app.js) mistakes
// the failure for "never OCR'd" and kicks off a brand new OCR job plus a
// 3-minute poll loop, each poll attempt hitting the same rate limit again.
//
// Fetched here through the Contents API with the same authenticated token
// used elsewhere in this codebase (a per-token quota, not a per-IP one),
// with a short Cache-Control so Netlify's CDN absorbs repeat requests
// (e.g. the Vilna page poll loop above) without re-hitting GitHub each time.

const OWNER = 'mosesar9319';
const REPO = 'MDYsync';
// The only four shapes ever fetched this way -- anything else is rejected
// rather than proxying an arbitrary path through to GitHub.
const ALLOWED_PATH = /^(by-ref|video-links|pages)\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$|^settings\.json$/;

export default async (request) => {
  const url = new URL(request.url);
  const path = url.searchParams.get('path') || '';
  if (!ALLOWED_PATH.test(path)) {
    return Response.json({ error: 'Invalid path.' }, { status: 400 });
  }

  const token = Netlify.env.get('GITHUB_DISPATCH_TOKEN');
  if (!token) {
    return Response.json({ error: 'Server lookup is not configured yet.' }, { status: 503 });
  }

  try {
    const upstream = await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}?ref=results`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.raw+json' } }
    );
    // A missing file is a normal, expected outcome here (a daf/page that
    // hasn't been synced yet) -- passed straight through as 404 rather than
    // the 502 below, so callers' existing `if (!response.ok)` checks keep
    // meaning exactly what they already assume.
    if (upstream.status === 404) {
      return Response.json({ error: 'Not found.' }, { status: 404 });
    }
    if (!upstream.ok) {
      return Response.json({ error: `GitHub returned ${upstream.status}.` }, { status: 502 });
    }
    const body = await upstream.text();
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        // Short on purpose -- a poll loop (loadVilnaPageMap) or a reader
        // reloading right after an admin publishes a sync needs a fresh
        // answer soon, not the 5-minute window get-catalog.mjs uses for a
        // page that's fine to lag behind by a few minutes.
        'Cache-Control': 'public, max-age=15, s-maxage=30',
      },
    });
  } catch (error) {
    return Response.json({ error: `Could not reach GitHub: ${error.message}` }, { status: 502 });
  }
};

export const config = {
  path: '/api/get-results-file',
};
