// Proxies results/catalog.json (the home page's video listing) instead of
// letting the browser fetch it straight from raw.githubusercontent.com.
// That's unauthenticated and rate-limited per source IP -- readers behind a
// shared IP (a mobile carrier's carrier-grade NAT, a school/office network,
// a VPN) can collectively exceed it and all start getting a flat 429, with
// the home page silently falling back to "no shiurim found"/"not linked
// yet" (see index.html's loadVideoCatalog, which catches and swallows the
// failure). Confirmed live: a real reader on a mobile network got exactly
// this 429 from raw.githubusercontent.com directly.
//
// Fetching here instead, through the Contents API with the same
// authenticated token already used by list-synced-dapim.mjs/publish-
// alignment.mjs, gets a per-token quota instead of a per-IP one -- and
// s-maxage below lets Netlify's own CDN serve the cached response to every
// reader without even reaching this function again, let alone GitHub,
// until it expires.

const OWNER = 'mosesar9319';
const REPO = 'MDYsync';

export default async (request) => {
  const token = Netlify.env.get('GITHUB_DISPATCH_TOKEN');
  if (!token) {
    return Response.json({ error: 'Server catalog lookup is not configured yet.' }, { status: 503 });
  }

  try {
    const upstream = await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO}/contents/catalog.json?ref=results`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.raw+json' } }
    );
    if (!upstream.ok) {
      return Response.json({ error: `Could not load the catalog (GitHub returned ${upstream.status}).` }, { status: 502 });
    }
    const body = await upstream.text();
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        // Matches raw.githubusercontent.com's own 5-minute cache window
        // (see index.html's prior comment on why a batch of removed dead
        // listings still showed up for a while) -- s-maxage governs
        // Netlify's shared CDN cache, browser-facing max-age is kept short
        // so a reader who force-refreshes still sees a fresh copy sooner.
        'Cache-Control': 'public, max-age=60, s-maxage=300',
      },
    });
  } catch (error) {
    return Response.json({ error: `Could not reach GitHub: ${error.message}` }, { status: 502 });
  }
};

export const config = {
  path: '/api/get-catalog',
};
