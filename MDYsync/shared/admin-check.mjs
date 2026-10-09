// Whether a request comes from a signed-in DafSync admin, checked on the server.
//
// The site's admin gating (`body.is-admin`, auth.js) lives in the browser, so it
// stops nothing by itself: a script can call any Netlify Function directly. A
// function that spends money or writes to the shared results store must check
// for itself. The page sends the signed-in user's Supabase session token as
// `Authorization: Bearer <token>`; Supabase is asked who that is and whether their
// own `profiles` row says is_admin. Anything short of a clear yes is a no
// (a missing, expired or forged token, an unreachable Supabase, a profile that is
// not an admin's).
//
// The URL and the publishable key are the same two values auth.js ships to every
// browser; neither is a secret.

export const SUPABASE_URL = 'https://cyexvsymuivvvhvpeber.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_EMHmjaU6PAGdmhiyA2b6dg_HNUgyW1J';

const BEARER = /^Bearer\s+([\w-]+\.[\w-]+\.[\w-]+)$/;

export async function isAdminRequest(request, fetchImpl = fetch) {
  const match = BEARER.exec(request.headers.get('Authorization') || '');
  if (!match) return false;
  const headers = { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${match[1]}` };
  try {
    const userResponse = await fetchImpl(`${SUPABASE_URL}/auth/v1/user`, { headers });
    if (!userResponse.ok) return false;
    const user = await userResponse.json();
    if (!user || typeof user.id !== 'string' || !user.id) return false;
    const profileResponse = await fetchImpl(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=is_admin`,
      { headers }
    );
    if (!profileResponse.ok) return false;
    const rows = await profileResponse.json();
    return Array.isArray(rows) && rows.length === 1 && rows[0]?.is_admin === true;
  } catch {
    return false;
  }
}
