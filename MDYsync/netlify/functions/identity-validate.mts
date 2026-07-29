import type { Handler } from '@netlify/functions';

const handler: Handler = async (event) => {
  let email = '';
  try {
    const body = JSON.parse(event.body || '{}');
    email = String(body?.user?.email || '').trim().toLowerCase();
  } catch {
    return { statusCode: 400, body: 'Invalid signup request.' };
  }

  const allowedEmail = String(Netlify.env.get('STUDIO_ADMIN_EMAIL') || '').trim().toLowerCase();
  if (!allowedEmail || email !== allowedEmail) {
    return { statusCode: 403, body: 'Editor registration is not available for this account.' };
  }

  return { statusCode: 200 };
};

export { handler };
