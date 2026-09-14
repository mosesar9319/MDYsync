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

// Every Netlify deploy preview and branch deploy of THIS project is served
// from its own subdomain of the project's netlify.app host --
// `deploy-preview-<n>--dafsync.netlify.app` for a PR, `<branch>--dafsync
// .netlify.app` for a branch deploy. The static set above only ever listed
// production and `main--`, so every /api/* call from a deploy preview was
// rejected with 403 "Origin not permitted" -- which is exactly how the live
// header scanner came to look like it was "scanning but never matching"
// when tested from a PR preview link: the client's fetch threw on every
// single request, and nothing in the UI said why.
//
// Deliberately anchored (^...$) to one literal host suffix rather than a
// loose `.includes('netlify.app')` -- only a subdomain of this project's
// own netlify.app host matches, so this widens the allowlist to our own
// previews without opening it to any other Netlify site.
const NETLIFY_SUBDOMAIN_ORIGIN = /^https:\/\/[a-z0-9-]+--dafsync\.netlify\.app$/;

export function isAllowedOrigin(origin) {
  if (!origin) return false;
  return ALLOWED_ORIGINS.has(origin) || NETLIFY_SUBDOMAIN_ORIGIN.test(origin);
}
