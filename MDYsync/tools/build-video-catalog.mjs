#!/usr/bin/env node
// Aggregates every results/video-links/<refKey>.json file into one
// results/catalog.json, so the public front end can list every linked
// video (which daf, which variant/language, which YouTube video) with a
// single fetch instead of one request per daf -- there are hundreds of
// video-links files, and browsers doing that many requests on page load
// isn't a real option.
//
// The a/b amud split is a syncing concern (each amud gets its own OCR
// alignment) -- the channel itself uploads one video per daf, covering
// both amudim, so the front end should list it once, not twice. Amud a
// and b of the same daf are almost always the same video (see
// readingsForVideo()'s PRIMARY ranking in shared/mdy-channel.mjs), so
// each daf's row is just its own amud-a link when one exists, falling
// back to amud b otherwise -- deliberately never compared against *other*
// dafim's links: a handful of stray videoIds from early manual testing
// are reused across unrelated, far-apart dafim in the real data, and
// grouping by videoId tractate-wide would silently merge those into one
// bogus multi-daf row instead of leaving each daf's own choice alone.
//
// Usage: node build-video-catalog.mjs --results <dir>
//
// Re-run this whenever video-links/ changes (after a backfill, or once new
// tractates start getting linked) to keep catalog.json in sync.

import fs from 'fs';
import path from 'path';
import { MAGGIDIM } from '../shared/maggidim.mjs';

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--results') args.results = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!args.results) throw new Error('--results <dir> is required');
  return args;
}

// Inverse of app.js's refKey(): "Hebrew-Chazarah-Daf-Chullin-89a" ->
// { tractate: "Chullin", daf: 89, amud: "a", variant: "chazarah", language: "he", maggid: null }.
// Another maggid's videos carry that maggid's keyPrefix first
// ("Bernstein-Bekhorot-2b" -> maggid: 'bernstein'; see shared/maggidim.mjs).
// Must stay in lockstep with app.js/refKey() and index.html's own
// parseRefKey() -- all three encode/decode the same filename scheme.
function parseRefKey(key) {
  let rest = key;
  let language = 'en';
  let variant = 'regular';
  let maggid = null;
  for (const m of MAGGIDIM) {
    if (m.keyPrefix && rest.startsWith(m.keyPrefix)) { maggid = m.id; rest = rest.slice(m.keyPrefix.length); break; }
  }
  if (rest.startsWith('Hebrew-')) { language = 'he'; rest = rest.slice('Hebrew-'.length); }
  if (rest.startsWith('Chazarah-Daf-')) { variant = 'chazarah'; rest = rest.slice('Chazarah-Daf-'.length); }
  const match = /^(.+)-(\d+)([ab])$/.exec(rest);
  if (!match) return null;
  return { tractate: match[1].replace(/-/g, ' '), daf: Number(match[2]), amud: match[3], variant, language, maggid };
}

const args = parseArgs(process.argv);
const videoLinksDir = path.join(args.results, 'video-links');
const files = fs.readdirSync(videoLinksDir).filter((f) => f.endsWith('.json'));

const COMBO_KEY = { regular_en: 'regularEn', chazarah_en: 'chazarahEn', regular_he: 'regularHe', chazarah_he: 'chazarahHe' };

// maggid id (null = the default, Mercaz Daf Yomi) -> tractate -> daf -> comboKey -> { a: {videoId,label}, b: {videoId,label} }
const byMaggid = new Map();
let skipped = 0;
for (const file of files) {
  const key = file.slice(0, -'.json'.length);
  const parsed = parseRefKey(key);
  if (!parsed) { skipped++; continue; }
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(path.join(videoLinksDir, file), 'utf8'));
  } catch {
    skipped++;
    continue;
  }
  if (!payload.videoId) { skipped++; continue; }

  if (!byMaggid.has(parsed.maggid)) byMaggid.set(parsed.maggid, new Map());
  const byTractate = byMaggid.get(parsed.maggid);
  if (!byTractate.has(parsed.tractate)) byTractate.set(parsed.tractate, new Map());
  const dafMap = byTractate.get(parsed.tractate);
  if (!dafMap.has(parsed.daf)) dafMap.set(parsed.daf, {});
  const comboKey = COMBO_KEY[`${parsed.variant}_${parsed.language}`];
  const combos = dafMap.get(parsed.daf);
  if (!combos[comboKey]) combos[comboKey] = {};
  combos[comboKey][parsed.amud] = {
    videoId: payload.videoId,
    label: payload.label || null,
    // A video the maintainers are using to tune the voice models: the player
    // offers its numbered test runs (see test-runs/ on the results branch).
    ...(payload.testShiur ? { testShiur: true } : {}),
  };
}

function rowsFor(byTractate) {
  const tractates = {};
  for (const [tractate, dafMap] of byTractate) {
    const rows = [];
    for (const [daf, combos] of dafMap) {
      const row = { daf };
      for (const [comboKey, byAmud] of Object.entries(combos)) {
        const picked = byAmud.a || byAmud.b;
        row[comboKey] = {
          videoId: picked.videoId, label: picked.label, amud: byAmud.a ? 'a' : 'b',
          ...(picked.testShiur ? { testShiur: true } : {}),
        };
      }
      rows.push(row);
    }
    tractates[tractate] = rows.sort((a, b) => a.daf - b.daf);
  }
  return tractates;
}

const tractates = rowsFor(byMaggid.get(null) || new Map());
// Every other maggid's rows, beside the default maggid's: the home page lists
// them side by side. Absent when there are none, so the file is byte-identical
// to before for a site with only the one channel.
const maggidim = {};
for (const m of MAGGIDIM) {
  if (!m.keyPrefix || !byMaggid.has(m.id)) continue;
  maggidim[m.id] = { tractates: rowsFor(byMaggid.get(m.id)) };
}

const catalog = {
  generatedAt: new Date().toISOString(),
  tractates,
  ...(Object.keys(maggidim).length ? { maggidim } : {}),
};
const outPath = path.join(args.results, 'catalog.json');
fs.writeFileSync(outPath, `${JSON.stringify(catalog, null, 2)}\n`);

const countRows = (t) => Object.values(t).reduce((sum, rows) => sum + rows.length, 0);
console.log(`Wrote ${outPath}: ${Object.keys(tractates).length} tractate(s), ${countRows(tractates)} daf row(s) (one per daf, not per amud), `
  + `${Object.values(maggidim).reduce((n, m) => n + countRows(m.tractates), 0)} row(s) from other maggidim, ${skipped} file(s) skipped.`);
