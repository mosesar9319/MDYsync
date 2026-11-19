#!/usr/bin/env node
// Brings R' Sruly Bornstein's shiurim onto DafSync from Lakewood Daf Yomi's own
// podcast feed (shared/lakewood-feed.mjs) -- never from YouTube.
//
// Into a checkout of the `results` branch it writes, for every daf shiur in the
// feed, one video-links/Bornstein-<Tractate>-<daf><amud>.json per amud:
//
//   { "type": "lakewood", "videoId": "L0213511665", "url": "<the feed's mp3>",
//     "label": "Eruchin 2", "seconds": 3487, "published": "...",
//     "coveredRefs": ["Arakhin 2a", "Arakhin 2b"], "source": "lakewood-feed",
//     "maggid": "bornstein" }
//
// and maggidim/bornstein.json, the list of everything the feed holds. A link
// the feed no longer lists (it keeps about the last 250) is left as it is.
//
// It also moves any of his shiurim still linked by a YouTube id (Bechoros 2 and
// 58, linked by hand before the feed was used) to the feed's copy of the same
// recording: the link, the syncs published for it (by-ref/ and by-video/), its
// numbered test runs (test-runs/<id>/) and an admin's chosen run
// (settings.json shownTestRun) all move to the Lakewood id.
//
//   node tools/lakewood-import.mjs --results /path/to/results-checkout [--feed feed.xml]
//
// Prints a JSON summary: { linked, kept, migrated: {oldId: newId}, items: [...] }.
// Dependency-free.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTalmudLookup, amudimForDaf, refKeyFor, plainRef } from '../shared/mdy-channel.mjs';
import { parseBornsteinTitle } from '../shared/maggidim.mjs';
import { FEED_URL, feedItems, isLakewoodId, lakewoodEpisodeId } from '../shared/lakewood-feed.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAGGID = 'bornstein';
const KEY_PREFIX = 'Bornstein-';

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
function writeJson(file, value, pretty = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, pretty ? 2 : 0)}\n`);
}

// The feed's daf shiurim, newest first, as DafSync knows them.
export function feedShiurim(items, lookup) {
  const out = [];
  for (const item of items) {
    const parsed = parseBornsteinTitle(item.title, lookup);
    const id = lakewoodEpisodeId(item.url);
    if (!parsed || !id) continue;
    const entry = lookup.byName.get(parsed.tractate.toLowerCase());
    const amudim = amudimForDaf(entry, parsed.daf);
    out.push({
      id,
      title: item.title,
      url: item.url,
      seconds: item.seconds ?? null,
      published: item.published ? new Date(item.published).toISOString() : null,
      tractate: parsed.tractate,
      daf: parsed.daf,
      refs: amudim.map((amud) => plainRef({ tractate: parsed.tractate, daf: parsed.daf, amud })),
      keys: amudim.map((amud) => refKeyFor({ tractate: parsed.tractate, daf: parsed.daf, amud, variant: 'regular', language: 'en', maggid: MAGGID })),
    });
  }
  return out;
}

function linkFor(shiur, extra = {}) {
  return {
    type: 'lakewood',
    videoId: shiur.id,
    url: shiur.url,
    label: shiur.title,
    ...(shiur.seconds ? { seconds: shiur.seconds } : {}),
    ...(shiur.published ? { published: shiur.published } : {}),
    coveredRefs: shiur.refs,
    source: 'lakewood-feed',
    maggid: MAGGID,
    ...extra,
  };
}

// His links still keyed by a YouTube id, moved to the feed's copy of the same
// daf. Returns { oldId: newId }.
export function migrateYouTubeLinks({ resultsDir, shiurim, lookup, log = () => {} }) {
  const linksDir = path.join(resultsDir, 'video-links');
  if (!fs.existsSync(linksDir)) return {};
  const byDaf = new Map();
  for (const s of shiurim) if (!byDaf.has(`${s.tractate}|${s.daf}`)) byDaf.set(`${s.tractate}|${s.daf}`, s);
  const moves = new Map(); // oldId -> shiur
  const files = fs.readdirSync(linksDir).filter((f) => f.startsWith(KEY_PREFIX) && f.endsWith('.json'));
  for (const file of files) {
    const link = readJson(path.join(linksDir, file));
    if (!link?.videoId || isLakewoodId(link.videoId) || link.type === 'lakewood') continue;
    const match = /^Bornstein-(.+)-(\d+)([ab])\.json$/.exec(file);
    if (!match) continue;
    const tractate = match[1].replace(/-/g, ' ');
    // The daf the recording is of: its own title, else the file's daf.
    const parsed = parseBornsteinTitle(link.label || '', lookup);
    const shiur = (parsed && byDaf.get(`${parsed.tractate}|${parsed.daf}`)) || byDaf.get(`${tractate}|${Number(match[2])}`);
    if (!shiur) {
      log(`No feed copy for ${file} (${link.videoId}); left as it is.`);
      continue;
    }
    moves.set(link.videoId, shiur);
    // The shiur's own amudim keep what an admin set on them. An amud of the
    // daf before or after that was linked to it (a test shiur reads into its
    // neighbours) becomes an ordinary link, which that daf's own shiur in the
    // feed then takes over.
    const ownDaf = Number(match[2]) === shiur.daf;
    const extra = ownDaf ? {
      ...(link.testShiur ? { testShiur: true } : {}),
      ...(link.locked ? { locked: true } : {}),
      ...(Array.isArray(link.coveredRefs) && link.coveredRefs.length ? { coveredRefs: link.coveredRefs } : {}),
    } : {};
    writeJson(path.join(linksDir, file), linkFor(shiur, extra));
  }
  const migrated = {};
  for (const [oldId, shiur] of moves) {
    migrated[oldId] = shiur.id;
    const rekey = (data) => {
      if (!data || typeof data !== 'object') return data;
      if (data.videoId === oldId) data.videoId = shiur.id;
      if (typeof data.videoUrl === 'string' && data.videoUrl.includes(oldId)) data.videoUrl = shiur.url;
      if (data.videoSource && typeof data.videoSource === 'object' && data.videoSource.videoId === oldId) {
        data.videoSource = { type: 'lakewood', videoId: shiur.id, url: shiur.url };
      }
      return data;
    };
    // Syncs: by-ref files that belong to this recording, and its by-video files.
    for (const dir of ['by-ref', 'by-video']) {
      const full = path.join(resultsDir, dir);
      if (!fs.existsSync(full)) continue;
      for (const file of fs.readdirSync(full)) {
        if (!file.endsWith('.json') || !file.includes(KEY_PREFIX)) continue;
        const data = readJson(path.join(full, file));
        if (!data) continue;
        const isThisVideoFile = dir === 'by-video' && file.endsWith(`${KEY_PREFIX}${oldId}.json`);
        if (data.videoId !== oldId && !isThisVideoFile) continue;
        rekey(data);
        const target = isThisVideoFile ? file.replace(`${KEY_PREFIX}${oldId}.json`, `${KEY_PREFIX}${shiur.id}.json`) : file;
        writeJson(path.join(full, target), data);
        if (target !== file) fs.rmSync(path.join(full, file));
      }
    }
    // Numbered test runs.
    const oldRuns = path.join(resultsDir, 'test-runs', oldId);
    const newRuns = path.join(resultsDir, 'test-runs', shiur.id);
    if (fs.existsSync(oldRuns) && !fs.existsSync(newRuns)) {
      fs.mkdirSync(newRuns, { recursive: true });
      for (const file of fs.readdirSync(oldRuns)) {
        const data = readJson(path.join(oldRuns, file));
        if (data) writeJson(path.join(newRuns, file), rekey(data), file === 'index.json');
        else fs.copyFileSync(path.join(oldRuns, file), path.join(newRuns, file));
      }
      fs.rmSync(oldRuns, { recursive: true, force: true });
    }
    // An admin's chosen run for it.
    const settingsFile = path.join(resultsDir, 'settings.json');
    const settings = readJson(settingsFile);
    if (settings?.shownTestRun?.[oldId]) {
      settings.shownTestRun[shiur.id] = settings.shownTestRun[oldId];
      delete settings.shownTestRun[oldId];
      writeJson(settingsFile, settings, true);
    }
    log(`Moved ${shiur.title} from YouTube id ${oldId} to the feed's ${shiur.id}.`);
  }
  return migrated;
}

export function importFeed({ resultsDir, items, lookup, log = () => {} }) {
  const shiurim = feedShiurim(items, lookup);
  const migrated = migrateYouTubeLinks({ resultsDir, shiurim, lookup, log });
  const linksDir = path.join(resultsDir, 'video-links');
  fs.mkdirSync(linksDir, { recursive: true });
  const claimed = new Set();
  let linked = 0;
  let kept = 0;
  for (const shiur of shiurim) {
    shiur.keys.forEach((key) => {
      if (claimed.has(key)) { kept += 1; return; } // the newest of the daf's recordings wins
      claimed.add(key);
      const file = path.join(linksDir, `${key}.json`);
      const existing = readJson(file);
      // Another kind of link, or one an admin locked: left alone.
      if (existing && (existing.source !== 'lakewood-feed' || existing.locked)) { kept += 1; return; }
      const link = linkFor(shiur);
      if (existing && JSON.stringify(existing) === JSON.stringify(link)) return;
      writeJson(file, link);
      linked += 1;
    });
  }
  const listFile = path.join(resultsDir, 'maggidim', `${MAGGID}.json`);
  const previous = readJson(listFile);
  const known = new Map((previous?.videos || []).map((v) => [v.videoId, v]));
  for (const s of shiurim) {
    known.set(s.id, { videoId: s.id, title: s.title, published: s.published, tractate: s.tractate, daf: s.daf, url: s.url, seconds: s.seconds });
  }
  const videos = [...known.values()].filter((v) => isLakewoodId(v.videoId))
    .sort((a, b) => String(b.published || '').localeCompare(String(a.published || '')));
  writeJson(listFile, { maggid: MAGGID, source: FEED_URL, videos }, true);
  log(`R' Bornstein: ${shiurim.length} daf shiurim in the feed; wrote ${linked} link file(s), kept ${kept}.`);
  return { linked, kept, migrated, items: shiurim };
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv) {
  const resultsDir = arg(argv, '--results');
  if (!resultsDir) throw new Error('--results <checkout of the results branch> is required');
  const lookup = buildTalmudLookup(JSON.parse(fs.readFileSync(path.join(HERE, '..', 'talmud_index.json'), 'utf8')));
  let xml;
  if (arg(argv, '--feed')) {
    xml = fs.readFileSync(arg(argv, '--feed'), 'utf8');
  } else {
    const response = await fetch(FEED_URL, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Lakewood Daf Yomi's feed answered ${response.status}`);
    xml = await response.text();
  }
  const summary = importFeed({ resultsDir, items: feedItems(xml), lookup, log: (line) => console.error(line) });
  console.log(JSON.stringify(summary));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
