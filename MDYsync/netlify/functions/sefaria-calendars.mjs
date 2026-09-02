// Proxies Sefaria's daily-calendar endpoint (currently used only for
// fetchTodaysDafRef's "Today's Daf" lookup in app.js). Mirrors sefaria.mjs's
// pattern -- same headers, same error shape -- but a separate function/route
// because that file is tied to the /api/v3/texts/<ref> shape and can't also
// serve this one.
//
// Added to close a real gap (PHASE1_CLOUD_CHABURA_AUDIT.md finding F-4):
// fetchTodaysDafRef previously called www.sefaria.org directly from the
// browser, the only Sefaria read in the codebase that skipped the proxy.
export default async (request) => {
  if (request.method !== 'GET') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  const url = new URL(request.url);
  const timezone = url.searchParams.get('timezone') || 'UTC';

  const endpoint = new URL('https://www.sefaria.org/api/calendars');
  endpoint.searchParams.set('timezone', timezone);

  try {
    const response = await fetch(endpoint, {
      headers: { 'User-Agent': 'DafSync-Prototype/1.0' }
    });
    const body = await response.text();
    return new Response(body, {
      status: response.status,
      headers: {
        'Content-Type': response.headers.get('content-type') || 'application/json; charset=utf-8',
        // Shorter-lived than sefaria.mjs's text cache: the calendar entry
        // changes once a day, not never.
        'Cache-Control': 'public, max-age=1800, s-maxage=3600',
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (error) {
    return Response.json({ error: 'Sefaria request failed.', detail: error.message }, { status: 502 });
  }
};

export const config = {
  path: '/api/sefaria-calendars'
};
