// Starts the server-side Vilna page OCR job for a specific daf/amud. The
// frontend only calls this when it has already checked that no cached
// page map exists yet (see resultUrl below) -- a page's word-position map
// is reusable across every viewer who asks for that daf, so there's no
// per-user job ID here, just a deterministic key from tractate/daf/amud.

const OWNER = 'mosesar9319';
const REPO = 'MDYsync';
const ALLOWED_ORIGINS = new Set([
  'https://mdysync.netlify.app',
  'https://main--mdysync.netlify.app',
  'https://dafsync.netlify.app',
  'https://main--dafsync.netlify.app',
  'http://localhost:8080',
]);

const MASECHTA_SLUGS = new Set([
  'Berakhot', 'Shabbat', 'Eruvin', 'Pesachim', 'Yoma', 'Sukkah', 'Beitzah', 'Rosh Hashanah',
  'Taanit', 'Megillah', 'Moed Katan', 'Chagigah', 'Yevamot', 'Ketubot', 'Nedarim', 'Nazir',
  'Sotah', 'Gittin', 'Kiddushin', 'Bava Kamma', 'Bava Metzia', 'Bava Batra', 'Sanhedrin',
  'Makkot', 'Shevuot', 'Avodah Zarah', 'Horayot', 'Zevachim', 'Menachot', 'Chullin', 'Bekhorot',
  'Arakhin', 'Temurah', 'Keritot', 'Meilah', 'Niddah',
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

  const { tractate, daf, amud } = body || {};
  if (typeof tractate !== 'string' || !MASECHTA_SLUGS.has(tractate)) {
    return Response.json({ error: 'A valid tractate is required.' }, { status: 400 });
  }
  if (!Number.isInteger(daf) || daf < 2 || daf > 200) {
    return Response.json({ error: 'A valid daf number is required.' }, { status: 400 });
  }
  if (amud !== 'a' && amud !== 'b') {
    return Response.json({ error: "Amud must be 'a' or 'b'." }, { status: 400 });
  }

  const token = Netlify.env.get('GITHUB_DISPATCH_TOKEN');
  if (!token) {
    return Response.json({ error: 'Server sync is not configured yet.' }, { status: 503 });
  }

  const pageKey = `${tractate.replace(/\s+/g, '-')}-${daf}${amud}`;

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
        event_type: 'run-page-ocr-job',
        client_payload: { tractate, daf, amud, pageKey },
      }),
    }
  );

  if (!dispatchResponse.ok) {
    const detail = await dispatchResponse.text();
    return Response.json(
      { error: 'Could not start the page OCR job.', detail },
      { status: 502 }
    );
  }

  return Response.json({
    pageKey,
    resultUrl: `https://raw.githubusercontent.com/${OWNER}/${REPO}/results/pages/${pageKey}.json`,
  }, {
    headers: { 'Access-Control-Allow-Origin': origin },
  });
};

export const config = {
  path: '/api/trigger-page-ocr-job',
};
