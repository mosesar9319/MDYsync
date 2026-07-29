import { getUser } from '@netlify/identity';
import type { Config, Context } from '@netlify/edge-functions';

function hasAdminRole(user: Awaited<ReturnType<typeof getUser>>): boolean {
  return Boolean(user?.app_metadata?.roles?.includes('admin'));
}

export default async (_request: Request, context: Context) => {
  const user = await getUser();

  if (!hasAdminRole(user)) {
    return Response.redirect(new URL('/?editor=login', context.url), 302);
  }

  return context.next();
};

export const config: Config = {
  path: ['/studio', '/studio/*'],
};
