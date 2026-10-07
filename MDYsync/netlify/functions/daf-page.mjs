// Proxies a single Vilna-style daf page (as a PDF) from shas.org's public
// Daf PDF API. This exists purely for CORS: shas.org sends no
// Access-Control-Allow-Origin header, so the browser can't fetch it
// directly, and it also blocks non-browser-looking requests (missing
// User-Agent/Accept), so this sets those the same way a browser would.
//
// shas.org's page images/pdfs currently have no published license granting
// reuse -- treat this as a private-use source, not a redistributable one,
// until a properly licensed replacement is in place.

const MASECHTA_SLUGS = {
  'Berakhot': 'berachos', 'Shabbat': 'shabbos', 'Eruvin': 'eruvin', 'Pesachim': 'pesachim',
  'Yoma': 'yoma', 'Sukkah': 'sukkah', 'Beitzah': 'beitzah', 'Rosh Hashanah': 'rosh-hashanah',
  'Taanit': 'taanis', 'Megillah': 'megillah', 'Moed Katan': 'moed-katan', 'Chagigah': 'chagigah',
  'Yevamot': 'yevamos', 'Ketubot': 'kesubos', 'Nedarim': 'nedarim', 'Nazir': 'nazir',
  'Sotah': 'sotah', 'Gittin': 'gittin', 'Kiddushin': 'kiddushin', 'Bava Kamma': 'bava-kamma',
  'Bava Metzia': 'bava-metzia', 'Bava Batra': 'bava-basra', 'Sanhedrin': 'sanhedrin',
  'Makkot': 'makkos', 'Shevuot': 'shevuos', 'Avodah Zarah': 'avodah-zarah', 'Horayot': 'horayos',
  'Zevachim': 'zevachim', 'Menachot': 'menachos', 'Chullin': 'chullin', 'Bekhorot': 'bechoros',
  'Arakhin': 'arachin', 'Temurah': 'temurah', 'Keritot': 'kereisos', 'Meilah': 'meilah',
  'Niddah': 'niddah',
};

const SHAS_HOSTS = ['www.shas.org', 'shas.org'];

export default async (request) => {
  if (request.method !== 'GET') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  const url = new URL(request.url);
  const tractate = url.searchParams.get('tractate') || '';
  const daf = Number(url.searchParams.get('daf'));
  const amud = (url.searchParams.get('amud') || '').toLowerCase();

  const slug = MASECHTA_SLUGS[tractate];
  if (!slug) {
    return Response.json({ error: `Unknown tractate '${tractate}'.` }, { status: 400 });
  }
  if (!Number.isInteger(daf) || daf < 2 || daf > 200) {
    return Response.json({ error: 'A valid daf number is required.' }, { status: 400 });
  }
  if (amud !== 'a' && amud !== 'b') {
    return Response.json({ error: "Amud must be 'a' or 'b'." }, { status: 400 });
  }

  // www.shas.org first, then shas.org: each connection is fully verified, but a
  // certificate that covers only one of the two names (shas.org's has done this)
  // would otherwise take every page down with it.
  const attempts = [];
  for (const host of SHAS_HOSTS) {
    const endpoint = new URL(`https://${host}/daf-pdf/api/`);
    endpoint.searchParams.set('masechta', slug);
    endpoint.searchParams.set('daf', String(daf));
    endpoint.searchParams.set('amud', amud);
    try {
      const upstream = await fetch(endpoint, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Accept: 'application/pdf,*/*',
        },
      });
      // An answer from the site, even a "no", is its answer: the other name would say the same.
      if (!upstream.ok) {
        return Response.json(
          { error: `No page image available for ${tractate} ${daf}${amud}.` },
          { status: upstream.status === 404 || upstream.status === 400 ? 404 : 502 }
        );
      }
      const body = await upstream.arrayBuffer();
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Cache-Control': 'public, max-age=86400, s-maxage=604800',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch (error) {
      // undici's "fetch failed" hides the real reason in error.cause (a DNS
      // failure, a refused or timed-out connection, a certificate problem...).
      attempts.push({ host, code: error.cause?.code || null, message: error.cause?.message || error.message });
    }
  }
  console.error('daf-page: could not fetch from shas.org:', JSON.stringify(attempts));
  return Response.json({
    error: 'Page image request failed.',
    detail: 'fetch failed',
    cause: attempts[0]?.code || attempts[0]?.message || null,
    attempts,
  }, { status: 502 });
};

export const config = {
  path: '/api/daf-page',
};

export const __testing = { SHAS_HOSTS };
