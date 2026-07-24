// Starts the server-side caption-OCR job for the website's "Google Drive
// link" sync flow. This is the only piece allowed to hold the GitHub token
// that can trigger the ocr-job.yml workflow — the token lives in Netlify's
// own environment variables, never in the browser.

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

  const { driveUrl, refs } = body || {};
  if (typeof driveUrl !== 'string' || !/^https:\/\/(drive|docs)\.google\.com\//.test(driveUrl)) {
    return Response.json({ error: 'A valid Google Drive link is required.' }, { status: 400 });
  }
  if (!Array.isArray(refs) || !refs.length || refs.length > 40
      || !refs.every((r) => typeof r === 'string' && r.length > 0 && r.length < 60)) {
    return Response.json({ error: 'A non-empty list of readings is required.' }, { status: 400 });
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
        client_payload: { driveUrl, refs, jobId },
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

  return Response.json({
    jobId,
    resultUrl: `https://raw.githubusercontent.com/${OWNER}/${REPO}/results/results/${jobId}.json`,
  }, {
    headers: { 'Access-Control-Allow-Origin': origin },
  });
};

export const config = {
  path: '/api/trigger-ocr-job',
};
