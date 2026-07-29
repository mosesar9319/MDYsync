#!/usr/bin/env node
// Aggregates every results/video-links/<refKey>.json file into one
// results/catalog.json, so the public front end can list every linked
// video (which daf, which variant/language, which YouTube video) with a
// single fetch instead of one request per daf -- there are hundreds of
// video-links files, and browsers doing that many requests on page load
// isn't a real option.
//
// Usage: node build-video-catalog.mjs --results <dir>
//
// Re-run this whenever video-links/ changes (after a backfill, or once new
// tractates start getting linked) to keep catalog.json in sync.

import fs from 'fs';
import path from 'path';

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
// { tractate: "Chullin", daf: 89, amud: "a", variant: "chazarah", language: "he" }.
// Must stay in lockstep with app.js/refKey() and index.html's own
// parseRefKey() -- all three encode/decode the same filename scheme.
function parseRefKey(key) {
  let rest = key;
  let language = 'en';
  let variant = 'regular';
  if (rest.startsWith('Hebrew-')) { language = 'he'; rest = rest.slice('Hebrew-'.length); }
  if (rest.startsWith('Chazarah-Daf-')) { variant = 'chazarah'; rest = rest.slice('Chazarah-Daf-'.length); }
  const match = /^(.+)-(\d+)([ab])$/.exec(rest);
  if (!match) return null;
  return { tractate: match[1].replace(/-/g, ' '), daf: Number(match[2]), amud: match[3], variant, language };
}

const args = parseArgs(process.argv);
const videoLinksDir = path.join(args.results, 'video-links');
const files = fs.readdirSync(videoLinksDir).filter((f) => f.endsWith('.json'));

const byTractate = new Map(); // tractate -> Map("daf|amud" -> row)
const COMBO_KEY = { regular_en: 'regularEn', chazarah_en: 'chazarahEn', regular_he: 'regularHe', chazarah_he: 'chazarahHe' };

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

  if (!byTractate.has(parsed.tractate)) byTractate.set(parsed.tractate, new Map());
  const dafMap = byTractate.get(parsed.tractate);
  const rowKey = `${parsed.daf}|${parsed.amud}`;
  if (!dafMap.has(rowKey)) dafMap.set(rowKey, { daf: parsed.daf, amud: parsed.amud });
  const row = dafMap.get(rowKey);
  const comboKey = COMBO_KEY[`${parsed.variant}_${parsed.language}`];
  row[comboKey] = { videoId: payload.videoId, label: payload.label || null };
}

const tractates = {};
for (const [tractate, dafMap] of byTractate) {
  tractates[tractate] = [...dafMap.values()].sort((a, b) => a.daf - b.daf || a.amud.localeCompare(b.amud));
}

const catalog = { generatedAt: new Date().toISOString(), tractates };
const outPath = path.join(args.results, 'catalog.json');
fs.writeFileSync(outPath, `${JSON.stringify(catalog, null, 2)}\n`);

const totalRows = Object.values(tractates).reduce((sum, rows) => sum + rows.length, 0);
console.log(`Wrote ${outPath}: ${Object.keys(tractates).length} tractate(s), ${totalRows} daf/amud row(s), ${skipped} file(s) skipped.`);
