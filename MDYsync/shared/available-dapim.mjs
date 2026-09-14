// Which (tractate, daf) pairs actually have precomputed word-position data
// published on the `results` branch (see results/pages/*.json, built by
// build-page-cache.yml) -- the header-matching vocabulary (see
// daf-header-vocabulary.mjs's buildHeaderVocabulary) is deliberately built
// from exactly this list, not a hardcoded per-tractate daf-count table, so a
// header scan can never "successfully" identify a daf that has no page data
// for it to project word positions against.
//
// Extracted out of scan-daf-page.mjs so scan-daf-header.mjs can build the
// exact same vocabulary without a second copy of this GitHub-contents call.

import { parsePageKey } from './daf-key-parsing.mjs';
import { OWNER, REPO } from './dafsync-config.mjs';

export async function listAvailablePages(token, masechtaKeys) {
  const response = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/contents/pages?ref=results`,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } }
  );
  if (!response.ok) return [];
  const entries = await response.json();
  if (!Array.isArray(entries)) return [];
  return entries.map((entry) => parsePageKey(entry.name, masechtaKeys)).filter(Boolean);
}
