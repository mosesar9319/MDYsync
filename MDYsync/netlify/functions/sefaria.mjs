export default async (request) => {
  if (request.method !== 'GET') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  const url = new URL(request.url);
  const ref = url.searchParams.get('ref');
  if (!ref || ref.length > 160) {
    return Response.json({ error: 'A valid ref parameter is required.' }, { status: 400 });
  }

  const endpoint = new URL(`https://www.sefaria.org/api/v3/texts/${encodeURIComponent(ref)}`);
  endpoint.searchParams.append('version', 'source');
  endpoint.searchParams.append('version', 'translation');
  endpoint.searchParams.set('return_format', 'text_only');

  try {
    const response = await fetch(endpoint, {
      headers: { 'User-Agent': 'DafSync-Prototype/1.0' }
    });
    const body = await response.text();
    return new Response(body, {
      status: response.status,
      headers: {
        'Content-Type': response.headers.get('content-type') || 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=3600, s-maxage=86400',
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (error) {
    return Response.json({ error: 'Sefaria request failed.', detail: error.message }, { status: 502 });
  }
};

export const config = {
  path: '/api/sefaria'
};
