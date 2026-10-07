// Asks Google Drive what it really returns for a file, for Live Follow's video
// link box: when the page's player cannot play a Drive file, this says why
// (not shared, too big for Drive to hand to a player, downloads blocked for now,
// or Drive serving it fine and the browser not liking the format) instead of
// leaving a guess. GET /api/live-video-probe?url=<the Drive link>.
//
// Drive links only, and only the first couple of KB are fetched: nothing here is
// a general "fetch this address" tool, and nothing of the file is returned beyond
// its type and size.

import { isAllowedOrigin, acceptVideoUrl, classifyDriveResponse } from '../../shared/live-video-job.mjs';

const TIMEOUT_MS = 8000;

export async function probe({ request, fetchImpl = fetch }) {
  const origin = request.headers.get('Origin');
  if (origin && !isAllowedOrigin(origin)) return { code: 403, body: { error: 'Origin not permitted.' } };
  const video = acceptVideoUrl(new URL(request.url).searchParams.get('url'));
  if (!video || new URL(video.url).hostname !== 'drive.usercontent.google.com') {
    return { code: 400, body: { error: 'Only Google Drive file links can be checked.' } };
  }
  let response;
  try {
    response = await fetchImpl(video.url, {
      headers: { Range: 'bytes=0-2047', 'User-Agent': 'Mozilla/5.0 (compatible; DafSync link check)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return { code: 200, body: { outcome: 'unreachable', detail: error.message } };
  }
  const contentType = response.headers.get('content-type') || '';
  const isPage = /text\/html/i.test(contentType);
  // Only a web page's start is read (to tell the reasons apart); a file's bytes are dropped.
  const head = isPage ? (await response.text().catch(() => '')).slice(0, 6000) : '';
  if (!isPage) await response.body?.cancel().catch(() => {});
  const range = /\/(\d+)$/.exec(response.headers.get('content-range') || '');
  const size = range ? Number(range[1]) : Number(response.headers.get('content-length')) || null;
  return {
    code: 200,
    body: {
      outcome: classifyDriveResponse({ status: response.status, contentType, head }),
      status: response.status,
      contentType: contentType.split(';')[0] || null,
      size,
    },
  };
}

export default async (request) => {
  if (request.method !== 'GET') return Response.json({ error: 'Method not allowed' }, { status: 405 });
  const { code, body } = await probe({ request });
  return Response.json(body, { status: code, headers: { 'Cache-Control': 'no-store' } });
};

export const config = { path: '/api/live-video-probe' };
