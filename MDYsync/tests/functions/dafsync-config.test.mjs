// Tests for the shared CORS allowlist (shared/dafsync-config.mjs), run with
// `npm run test:functions` (node --test).
//
// This exists because of a real, silent outage: the allowlist used to be a
// flat Set holding only production and `main--`, so every /api/* call made
// from a Netlify deploy preview was answered with 403 "Origin not
// permitted." The live header scanner therefore failed 100% of the time when
// tested from a PR preview link, while looking to the user exactly like a
// scanner that was running but never recognizing anything.

import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedOrigin } from '../../shared/dafsync-config.mjs';

test('isAllowedOrigin accepts production, main and local dev', () => {
  assert.equal(isAllowedOrigin('https://dafsync.netlify.app'), true);
  assert.equal(isAllowedOrigin('https://main--dafsync.netlify.app'), true);
  assert.equal(isAllowedOrigin('http://localhost:8080'), true);
});

test('isAllowedOrigin accepts this project\'s deploy previews and branch deploys', () => {
  assert.equal(isAllowedOrigin('https://deploy-preview-144--dafsync.netlify.app'), true);
  assert.equal(isAllowedOrigin('https://claude-scan-live-matching-fix--dafsync.netlify.app'), true);
});

test('isAllowedOrigin rejects other Netlify sites, look-alikes and bare absence', () => {
  // A different project on netlify.app -- the pattern is anchored to this
  // project's own host suffix precisely so these stay out.
  assert.equal(isAllowedOrigin('https://deploy-preview-1--someoneelse.netlify.app'), false);
  assert.equal(isAllowedOrigin('https://dafsync.netlify.app.evil.com'), false);
  assert.equal(isAllowedOrigin('https://evil.com/https://dafsync.netlify.app'), false);
  // Single-dash subdomain of the apex is not a Netlify deploy URL shape.
  assert.equal(isAllowedOrigin('https://preview.dafsync.netlify.app'), false);
  // http:// previews don't exist; only the https form is allowed.
  assert.equal(isAllowedOrigin('http://deploy-preview-144--dafsync.netlify.app'), false);
  assert.equal(isAllowedOrigin(''), false);
  assert.equal(isAllowedOrigin(undefined), false);
  assert.equal(isAllowedOrigin(null), false);
});
