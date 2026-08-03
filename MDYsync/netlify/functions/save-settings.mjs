// Persists small site-wide admin toggles to results/settings.json, the same
// "database on a branch" every other piece of site data already lives in.
// Currently just one setting: whether youtube-channel-sync.mjs should also
// dispatch a server-side OCR sync job automatically for a newly linked
// upload, instead of requiring an admin to notice it and start one by hand.

const OWNER = 'mosesar9319';
const REPO = 'MDYsync';
const ALLOWED_ORIGINS = new Set([
  'https://mdysync.netlify.app',
  'https://main--mdysync.netlify.app',
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
  if (typeof body?.autoSyncNewUploads !== 'boolean') {
    return Response.json({ error: 'autoSyncNewUploads must be a boolean.' }, { status: 400 });
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

  let sha;
  let settings = {};
  try {
    const getResponse = await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO}/contents/settings.json?ref=results`,
      { headers }
    );
    if (getResponse.ok) {
      const file = await getResponse.json();
      sha = file.sha;
      settings = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
    }
  } catch {
    // Doesn't exist yet, or couldn't be read -- start from an empty object
    // rather than failing the whole request over a file that's about to be
    // (re)written anyway.
  }
  settings.autoSyncNewUploads = body.autoSyncNewUploads;

  const putResponse = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/contents/settings.json`,
    {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: `Set autoSyncNewUploads to ${settings.autoSyncNewUploads}`,
        content: Buffer.from(JSON.stringify(settings, null, 2) + '\n', 'utf8').toString('base64'),
        branch: 'results',
        ...(sha ? { sha } : {}),
      }),
    }
  );
  if (!putResponse.ok) {
    const detail = await putResponse.text();
    return Response.json({ error: 'Could not save settings.', detail }, { status: 502 });
  }

  return Response.json({ ok: true, settings }, {
    headers: { 'Access-Control-Allow-Origin': origin },
  });
};

export const config = {
  path: '/api/save-settings',
};
