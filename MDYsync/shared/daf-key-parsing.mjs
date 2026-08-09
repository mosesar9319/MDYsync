// Parses the two filename schemes this project publishes results under on
// the `results` branch, back into { tractate, daf, amud[, variant,
// language] } -- shared so scan-daf-page.mjs and list-synced-dapim.mjs
// (both of which need to enumerate a whole directory rather than fetch one
// known key) don't each carry their own copy.
//
// Tractate names can themselves contain a hyphen once slugified (e.g.
// "Bava-Kamma", "Rosh-Hashanah"), so neither parser can just split on the
// first hyphen -- both match against a known tractate list instead.

// results/pages/<key>.json: "<Tractate-slug>-<daf><amud>.json" (see
// pageMapKey in app.js and trigger-page-ocr-job.mjs's own pageKey). This
// data is per physical page, independent of shiur variant/language.
export function parsePageKey(filename, tractateNames) {
  const base = filename.replace(/\.json$/, '');
  for (const tractate of tractateNames) {
    const prefix = `${tractate.replace(/\s+/g, '-')}-`;
    if (base.startsWith(prefix)) {
      const match = base.slice(prefix.length).match(/^(\d+)([ab])$/);
      if (match) return { tractate, daf: Number(match[1]), amud: match[2] };
    }
  }
  return null;
}

// results/by-ref/<key>.json: an optional "Voice-" prefix (which engine
// produced it -- irrelevant to "is this synced at all," so it's just
// stripped, not tracked), then an optional "Hebrew-" prefix, then an
// optional "Chazarah-Daf-" prefix, then "<Tractate-slug>-<daf><amud>.json"
// -- see refKey() in app.js, which builds this exact same prefix order.
export function parseByRefKey(filename, tractateNames) {
  let base = filename.replace(/\.json$/, '').replace(/^Voice-/, '');
  let language = 'en';
  if (base.startsWith('Hebrew-')) {
    language = 'he';
    base = base.slice('Hebrew-'.length);
  }
  let variant = 'regular';
  if (base.startsWith('Chazarah-Daf-')) {
    variant = 'chazarah';
    base = base.slice('Chazarah-Daf-'.length);
  }
  for (const tractate of tractateNames) {
    const prefix = `${tractate.replace(/\s+/g, '-')}-`;
    if (base.startsWith(prefix)) {
      const match = base.slice(prefix.length).match(/^(\d+)([ab])$/);
      if (match) return { tractate, daf: Number(match[1]), amud: match[2], variant, language };
    }
  }
  return null;
}
