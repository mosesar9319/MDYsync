#!/usr/bin/env node
// The address of MDY's own mp3 for a voice-sync job, or nothing.
//
// voice-job.yml used to download every shiur's audio from YouTube, which more
// and more often refuses downloads from a server ("Sign in to confirm you're not
// a bot"). For a Mercaz Daf Yomi shiur the same recording sits on MDY's own file
// server (see mdy-files.js), as a plain mp3. This prints that file's address for
// the job's payload; the workflow downloads it and checks it is the same length
// as the YouTube video before using it.
//
//   node tools/mdy-audio.mjs --refs '["Bekhorot 58a","Bekhorot 58b"]' \
//     --variant regular --language en [--maggid bornstein] [--title "..."]
//
// The recording's daf comes from its YouTube title when one is given ("... Daf 58
// by R' Eli Stefansky"); otherwise from the readings, the daf most of them are on
// (a shiur's readings run from the end of the daf before to the start of the next).
// Prints nothing, and exits 0, for another maggid's shiur or anything it cannot
// place. Dependency-free.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const MdyFiles = require('../mdy-files.js');

const REF = /^\s*([A-Za-z][A-Za-z' ]*?)\s+(\d{1,3})([ab])\b/;

// The daf most of the readings are on; the first such daf on a tie.
export function dafOfReadings(refs) {
  const counts = new Map();
  let tractate = null;
  for (const ref of Array.isArray(refs) ? refs : []) {
    const match = REF.exec(String(ref || ''));
    if (!match) continue;
    tractate = tractate || match[1];
    if (match[1] !== tractate) continue;
    const daf = Number(match[2]);
    counts.set(daf, (counts.get(daf) || 0) + 1);
  }
  let best = null;
  for (const [daf, count] of counts) {
    if (best === null || count > counts.get(best)) best = daf;
  }
  return best === null ? null : { tractate, daf: best };
}

export function mdyAudioUrl({ refs, variant = 'regular', language = 'en', maggid = '', title = '' }) {
  const found = dafOfReadings(refs);
  if (!found) return null;
  return MdyFiles.fileUrl(
    { tractate: found.tractate, daf: found.daf, variant, language, maggid: maggid || null },
    { title, quality: 'audio' },
  );
}

function argValue(args, name) {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  let refs = [];
  try { refs = JSON.parse(argValue(args, 'refs') || '[]'); } catch { refs = []; }
  const url = mdyAudioUrl({
    refs,
    variant: argValue(args, 'variant') || 'regular',
    language: argValue(args, 'language') || 'en',
    maggid: argValue(args, 'maggid') || '',
    title: argValue(args, 'title') || '',
  });
  if (url) process.stdout.write(`${url}\n`);
}
