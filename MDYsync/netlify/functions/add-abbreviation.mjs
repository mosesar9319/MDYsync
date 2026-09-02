// Appends one Talmudic-abbreviation dictionary entry, discovered live in
// the manual trace tool (studio/trace.html), to a single growing file on
// the results branch -- the same "database on a branch" every other piece
// of site data already lives in. Kept separate from the curated starter
// list shipped at shared/abbreviations.json (which only changes via a real
// commit/review) so a trace-tool discovery takes effect immediately for
// every future page without needing a deploy; daf-tracer.mjs's caller
// merges both lists at load time.

const OWNER = 'mosesar9319';
const REPO = 'MDYsync';
const PATH = 'abbreviation-additions.json';
const ALLOWED_ORIGINS = new Set([
  'https://dafsync.netlify.app',
  'https://main--dafsync.netlify.app',
  'http://localhost:8080',
]);

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

  const { phrase, abbr } = body || {};
  if (!Array.isArray(phrase) || phrase.length < 2 || phrase.length > 6
      || !phrase.every((w) => typeof w === 'string' && w.length > 0 && w.length < 30)) {
    return Response.json({ error: 'phrase must be an array of 2-6 words.' }, { status: 400 });
  }
  if (abbr !== undefined && (typeof abbr !== 'string' || abbr.length > 20)) {
    return Response.json({ error: 'abbr must be a short string.' }, { status: 400 });
  }

  const token = Netlify.env.get('GITHUB_DISPATCH_TOKEN');
  if (!token) {
    return Response.json({ error: 'Server sync is not configured yet.' }, { status: 503 });
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  };
  const apiUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${PATH}`;

  let sha;
  let entries = [];
  try {
    const existing = await fetch(`${apiUrl}?ref=results`, { headers: { ...headers, Accept: 'application/vnd.github.raw+json' } });
    if (existing.ok) {
      const shaLookup = await fetch(`${apiUrl}?ref=results`, { headers });
      sha = (await shaLookup.json()).sha;
      entries = JSON.parse(await existing.text());
      if (!Array.isArray(entries)) entries = [];
    } else if (existing.status !== 404) {
      const detail = await existing.text();
      return Response.json({ error: 'Could not read the existing abbreviation list.', detail }, { status: 502 });
    }
  } catch (error) {
    return Response.json({ error: `Could not reach GitHub: ${error.message}` }, { status: 502 });
  }

  entries.push({ phrase, abbr: abbr || null, addedAt: new Date().toISOString() });

  try {
    const putResponse = await fetch(apiUrl, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: `Add abbreviation: ${phrase.join(' ')}`,
        content: toBase64Utf8(JSON.stringify(entries, null, 2) + '\n'),
        branch: 'results',
        ...(sha ? { sha } : {}),
      }),
    });
    if (!putResponse.ok) {
      const detail = await putResponse.text();
      return Response.json({ error: 'Could not save the abbreviation.', detail }, { status: 502 });
    }
  } catch (error) {
    return Response.json({ error: `Could not reach GitHub: ${error.message}` }, { status: 502 });
  }

  return Response.json({ ok: true, count: entries.length }, {
    headers: { 'Access-Control-Allow-Origin': origin },
  });
};

export const config = {
  path: '/api/add-abbreviation',
};
