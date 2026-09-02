// Lets the manual trace tool (studio/trace.html) publish a human-verified
// page word-position map straight to the results branch, the same
// destination the automated OCR job (trigger-page-ocr-job.mjs + ocr-job.yml)
// writes to -- this is just a second, human-corrected path to the same
// `pages/<key>.json` file, following the exact pattern publish-alignment.mjs
// already established for segment alignments.

const OWNER = 'mosesar9319';
const REPO = 'MDYsync';
const MAX_PAGEMAP_BYTES = 2 * 1024 * 1024; // generous headroom over any real page's word boxes

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

  const { pageKey, pagemap } = body || {};
  if (typeof pageKey !== 'string' || !/^[A-Za-z-]+-\d+[ab]$/.test(pageKey)) {
    return Response.json({ error: "A valid pageKey ('Tractate-Name-86a') is required." }, { status: 400 });
  }
  if (!pagemap || typeof pagemap !== 'object'
      || !Array.isArray(pagemap.wordBoxes) || !pagemap.wordBoxes.length
      || typeof pagemap.pageWidth !== 'number' || typeof pagemap.pageHeight !== 'number') {
    return Response.json({ error: 'pagemap must include pageWidth, pageHeight, and a non-empty wordBoxes array.' }, { status: 400 });
  }
  for (const box of pagemap.wordBoxes) {
    if (typeof box.ref !== 'string' || !box.ref || typeof box.wordIndex !== 'number'
        || typeof box.x !== 'number' || typeof box.y !== 'number'
        || typeof box.w !== 'number' || typeof box.h !== 'number') {
      return Response.json({ error: 'Every word box needs ref, wordIndex, x, y, w, h.' }, { status: 400 });
    }
  }

  const payload = {
    schema: 'dafsync-pagemap-v2',
    source: 'manual-trace',
    pageWidth: pagemap.pageWidth,
    pageHeight: pagemap.pageHeight,
    textBlock: pagemap.textBlock || null,
    wordBoxes: pagemap.wordBoxes,
  };
  const serialized = JSON.stringify(payload);
  if (serialized.length > MAX_PAGEMAP_BYTES) {
    return Response.json({ error: 'Page map payload is too large.' }, { status: 413 });
  }

  const token = Netlify.env.get('GITHUB_DISPATCH_TOKEN');
  if (!token) {
    return Response.json({ error: 'Server publish is not configured yet.' }, { status: 503 });
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  };
  const path = `pages/${pageKey}.json`;
  const apiUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`;

  let sha;
  try {
    const existing = await fetch(`${apiUrl}?ref=results`, { headers });
    if (existing.ok) {
      sha = (await existing.json()).sha;
    } else if (existing.status !== 404) {
      const detail = await existing.text();
      return Response.json({ error: `Could not check the existing page map for ${pageKey}.`, detail }, { status: 502 });
    }
  } catch (error) {
    return Response.json({ error: `Could not reach GitHub: ${error.message}` }, { status: 502 });
  }

  try {
    const putResponse = await fetch(apiUrl, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: `Publish hand-traced page map for ${pageKey}`,
        content: toBase64Utf8(serialized),
        branch: 'results',
        ...(sha ? { sha } : {}),
      }),
    });
    if (!putResponse.ok) {
      const detail = await putResponse.text();
      return Response.json({ error: `Could not publish the page map for ${pageKey}.`, detail }, { status: 502 });
    }
  } catch (error) {
    return Response.json({ error: `Could not reach GitHub: ${error.message}` }, { status: 502 });
  }

  return Response.json({
    pageKey,
    resultUrl: `https://raw.githubusercontent.com/${OWNER}/${REPO}/results/pages/${pageKey}.json`,
  }, {
    headers: { 'Access-Control-Allow-Origin': origin },
  });
};

export const config = {
  path: '/api/publish-pagemap',
};
