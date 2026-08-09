// Lists every daf/amud that's actually browsable in the Daf Browser
// (browse/index.html): has both page word-position data (results/pages/,
// per physical page, shared across every shiur variant/language) AND at
// least one completed alignment (results/by-ref/, per variant/language
// combo) -- the two things "tap a word and jump to that moment in the
// video" actually needs. A video link alone (results/catalog.json) isn't
// enough -- that only means a video was found on the channel, not that its
// alignment sync ever finished (see youtube-channel-sync.mjs's own
// comments on why catalog.json is a derived, best-effort file, not a
// synced-status source of truth).
//
// One recursive Git Trees API call lists both directories' filenames at
// once -- the same pattern already used by youtube-channel-sync.mjs and
// prune-dead-links-background.mjs for their own results-branch listings,
// reused here rather than one Contents API GET per directory.
//
// Response shape: { "<Tractate>": { "<daf><amud>": ["regularEn",
// "chazarahHe", ...] } } -- a daf/amud only appears once its page data
// exists and it has at least one synced combo; the combo-key names match
// catalog.json's own scheme (regularEn/chazarahEn/regularHe/chazarahHe) so
// the frontend doesn't need a second naming convention.

import { MASECHTA_HEBREW } from '../../shared/daf-header-vocabulary.mjs';
import { parsePageKey, parseByRefKey } from '../../shared/daf-key-parsing.mjs';

const OWNER = 'mosesar9319';
const REPO = 'MDYsync';
const TRACTATE_NAMES = Object.keys(MASECHTA_HEBREW);

function comboKeyFor(variant, language) {
  const variantPart = variant === 'chazarah' ? 'chazarah' : 'regular';
  const languagePart = language === 'he' ? 'He' : 'En';
  return `${variantPart}${languagePart}`;
}

export default async (request) => {
  const token = Netlify.env.get('GITHUB_DISPATCH_TOKEN');
  if (!token) {
    return Response.json({ error: 'Server lookup is not configured yet.' }, { status: 503 });
  }

  let tree;
  try {
    const response = await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO}/git/trees/results?recursive=1`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } }
    );
    if (!response.ok) throw new Error(`GitHub tree API returned ${response.status}`);
    tree = await response.json();
  } catch (error) {
    return Response.json({ error: `Could not list results: ${error.message}` }, { status: 502 });
  }

  const entries = tree.tree || [];
  const pageKeys = new Set(); // "<Tractate>|<daf><amud>" for every results/pages/ entry
  for (const item of entries) {
    if (item.type !== 'blob' || !item.path.startsWith('pages/') || !item.path.endsWith('.json')) continue;
    const parsed = parsePageKey(item.path.slice('pages/'.length), TRACTATE_NAMES);
    if (parsed) pageKeys.add(`${parsed.tractate}|${parsed.daf}${parsed.amud}`);
  }

  const synced = {};
  for (const item of entries) {
    if (item.type !== 'blob' || !item.path.startsWith('by-ref/') || !item.path.endsWith('.json')) continue;
    const parsed = parseByRefKey(item.path.slice('by-ref/'.length), TRACTATE_NAMES);
    if (!parsed) continue;
    // Alignment without the page's own word-position data still can't
    // support tap-to-seek -- only count combos where both exist.
    if (!pageKeys.has(`${parsed.tractate}|${parsed.daf}${parsed.amud}`)) continue;

    const tractateEntry = synced[parsed.tractate] || (synced[parsed.tractate] = {});
    const dafAmud = `${parsed.daf}${parsed.amud}`;
    const combos = tractateEntry[dafAmud] || (tractateEntry[dafAmud] = []);
    const comboKey = comboKeyFor(parsed.variant, parsed.language);
    if (!combos.includes(comboKey)) combos.push(comboKey);
  }

  return Response.json(synced);
};

export const config = {
  path: '/api/list-synced-dapim',
};
