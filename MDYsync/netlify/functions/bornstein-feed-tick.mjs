// Starts .github/workflows/bornstein-feed.yml once an hour: R' Bornstein's new
// shiurim from Lakewood Daf Yomi's feed, and the voice sync of each.
//
// That workflow has a GitHub schedule of its own, but GitHub did not run it once
// in its first hours (November 2026; GitHub may delay or drop scheduled runs,
// most of all on a new workflow). The site's own hourly functions run on time,
// so this asks GitHub to run it as a repository dispatch, with the same token
// youtube-channel-sync.mjs uses. Both can fire in one hour: the workflow's
// concurrency group runs them one after the other, and the second finds
// nothing new.

const OWNER = 'mosesar9319';
const REPO = 'MDYsync';
export const EVENT_TYPE = 'bornstein-feed';

export default async () => {
  const token = Netlify.env.get('GITHUB_DISPATCH_TOKEN');
  if (!token) {
    return Response.json({ error: 'GITHUB_DISPATCH_TOKEN is not set.' }, { status: 503 });
  }
  const response = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ event_type: EVENT_TYPE }),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    console.error(`GitHub answered ${response.status} to the Bornstein feed dispatch: ${detail}`);
    return Response.json({ error: `GitHub answered ${response.status}` }, { status: 502 });
  }
  return Response.json({ dispatched: EVENT_TYPE });
};

export const config = {
  schedule: '23 * * * *',
};
