// Backup for the WebSub push. Every five minutes, on the production
// deploy only (Netlify does not run scheduled functions on previews),
// read the channel's Live-tab RSS and confirm each recent id with
// videos.list. Also renews the hub lease three times a day.
//
// search.list is not called. OCR is not started.

import { pollLive, webSubCallbackFromEnv } from '../../shared/live-publish.mjs';

export default async () => {
  const envGet = (name) => Netlify.env.get(name) || '';
  try {
    const result = await pollLive({
      fetchImpl: fetch,
      token: envGet('GITHUB_DISPATCH_TOKEN'),
      apiKey: envGet('YOUTUBE_API_KEY'),
      verifyToken: envGet('YOUTUBE_WEBSUB_TOKEN'),
      callback: webSubCallbackFromEnv(envGet),
      now: new Date(),
    });
    return Response.json(result);
  } catch (error) {
    console.error(error);
    return Response.json({ error: error.message }, { status: 502 });
  }
};

export const config = {
  schedule: '*/5 * * * *',
};
