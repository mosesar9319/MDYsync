// Small, shared constants every Netlify function that talks to DafSync's own
// GitHub repo (for the results branch's published page data) or needs the
// site's own CORS allowlist reaches for. Extracted so scan-daf-page.mjs and
// scan-daf-header.mjs can't drift apart on either -- a new deploy origin
// added to one and forgotten in the other is exactly the kind of bug two
// hand-maintained copies eventually produce.

export const OWNER = 'mosesar9319';
export const REPO = 'MDYsync';

export const ALLOWED_ORIGINS = new Set([
  'https://dafsync.netlify.app',
  'https://main--dafsync.netlify.app',
  'http://localhost:8080',
]);
