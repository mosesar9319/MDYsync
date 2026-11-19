// Persists small admin toggles to results/settings.json, the same "database
// on a branch" every other piece of site data already lives in. Two kinds
// so far:
//   - autoSyncNewUploads: site-wide, whether youtube-channel-sync.mjs should
//     also dispatch a server-side OCR sync job automatically for a newly
//     linked upload, instead of requiring an admin to notice it and start
//     one by hand.
//   - preferredSyncMethod: per-daf (keyed by ref), which of the two sync
//     engines (see updateSyncMethodSwitchUi() in app.js) a reader sees by
//     default for that daf when both a caption-OCR and a voice-recognition
//     alignment are published for it -- overriding loadDaf()'s own
//     caption-OCR-first default for the specific dapim an admin has
//     actually compared and judged voice recognition better for.
//   - shownTestRun: per test-shiur video (keyed by YouTube id), the numbered
//     run (test-runs/<videoId>/, "regular-6") every reader is shown. Without
//     one, the player shows the run with the most daf words matched; null
//     clears an admin's choice back to that.

import { ALLOWED_ORIGINS } from '../../shared/dafsync-config.mjs';

const OWNER = 'mosesar9319';
const REPO = 'MDYsync';

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
  const hasAutoSync = typeof body?.autoSyncNewUploads === 'boolean';
  const hasPreferredMethod = typeof body?.preferredSyncMethodRef === 'string';
  const hasShownTestRun = typeof body?.shownTestRunVideoId === 'string';
  if (!hasAutoSync && !hasPreferredMethod && !hasShownTestRun) {
    return Response.json(
      { error: 'Provide autoSyncNewUploads, preferredSyncMethodRef or shownTestRunVideoId.' }, { status: 400 }
    );
  }
  if (hasShownTestRun) {
    if (!/^[A-Za-z0-9_-]{11}$/.test(body.shownTestRunVideoId)) {
      return Response.json({ error: 'shownTestRunVideoId must be a YouTube video id.' }, { status: 400 });
    }
    const run = body.shownTestRun ?? null;
    if (run !== null && !(typeof run === 'string' && /^(regular|live)-\d{1,4}$/.test(run))) {
      return Response.json({ error: "shownTestRun must be a run id like 'regular-6', or null." }, { status: 400 });
    }
  }
  if (hasPreferredMethod) {
    const ref = body.preferredSyncMethodRef.trim();
    if (!ref || ref.length > 100) {
      return Response.json({ error: 'preferredSyncMethodRef must be 1-100 characters.' }, { status: 400 });
    }
    // null/undefined clears the override for this ref, reverting it to
    // loadDaf()'s ordinary caption-OCR-first default.
    if (body.preferredSyncMethod !== null && body.preferredSyncMethod !== undefined
        && body.preferredSyncMethod !== 'ocr' && body.preferredSyncMethod !== 'voice') {
      return Response.json({ error: "preferredSyncMethod must be 'ocr', 'voice', or null." }, { status: 400 });
    }
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
  let message;
  if (hasAutoSync) {
    settings.autoSyncNewUploads = body.autoSyncNewUploads;
    message = `Set autoSyncNewUploads to ${settings.autoSyncNewUploads}`;
  }
  if (hasPreferredMethod) {
    const ref = body.preferredSyncMethodRef.trim();
    const method = body.preferredSyncMethod ?? null;
    settings.preferredSyncMethod ||= {};
    if (method === null) {
      delete settings.preferredSyncMethod[ref];
      message = `Clear preferred sync method for ${ref}`;
    } else {
      settings.preferredSyncMethod[ref] = method;
      message = `Set preferred sync method for ${ref} to ${method}`;
    }
  }

  if (hasShownTestRun) {
    const videoId = body.shownTestRunVideoId;
    const run = body.shownTestRun ?? null;
    settings.shownTestRun ||= {};
    if (run === null) {
      delete settings.shownTestRun[videoId];
      message = `Show the best test run of ${videoId} to everyone`;
    } else {
      settings.shownTestRun[videoId] = run;
      message = `Show test run ${run} of ${videoId} to everyone`;
    }
  }

  const putResponse = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/contents/settings.json`,
    {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message,
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
