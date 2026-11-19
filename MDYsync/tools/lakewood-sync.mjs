#!/usr/bin/env node
// Starts the voice sync of each of R' Sruly Bornstein's new shiurim, from
// Lakewood Daf Yomi's own feed -- run every hour by bornstein-feed.yml, after
// tools/lakewood-import.mjs has linked whatever the feed has.
//
// Which shiurim: those published on or after Eruchin 2 (SYNC_FROM_PUBLISHED in
// shared/lakewood-feed.mjs). The ones before it are on DafSync to listen to,
// without a sync. A shiur already synced (a by-ref/Voice-Bornstein-<amud>.json
// made from this very recording) is left alone.
//
// Credits: ElevenLabs bills each sync (about 1,400 credits for an hour of
// shiur). Before starting one, the account's balance is read; when what it
// would cost would leave less than RESERVE_CREDITS, nothing more is started and
// the waiting shiurim are tried again next hour -- so once the credits renew
// each month, they go through by themselves.
//
// A job started is noted in maggidim/bornstein-sync.json on the results branch
// (when, how many tries), so the next hour does not start it again while it is
// still running; one that has not published after RETRY_AFTER_HOURS is tried
// again, up to MAX_ATTEMPTS times.
//
//   node tools/lakewood-sync.mjs --results <results checkout> --items <import summary json> [--dry-run]
//
// Needs GH_TOKEN (to start the job) and ELEVENLABS_API_KEY (to read the
// balance) in the environment, and GITHUB_REPOSITORY ("owner/repo").

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SYNC_FROM_PUBLISHED } from '../shared/lakewood-feed.mjs';

export const RESERVE_CREDITS = 1000;
export const CREDITS_PER_MINUTE = 23; // measured: hints 20.8/min plus the re-listen clips
export const MAX_PER_RUN = 3;
export const RETRY_AFTER_HOURS = 3;
export const MAX_ATTEMPTS = 3;
const STATE_FILE = path.join('maggidim', 'bornstein-sync.json');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Whether this recording's voice sync is published for any of its amudim.
export function isSynced(resultsDir, item) {
  return (item.keys || []).some((key) => {
    const data = readJson(path.join(resultsDir, 'by-ref', `Voice-${key}.json`));
    return data?.videoId === item.id;
  });
}

export function estimateCredits(item) {
  const minutes = (Number(item.seconds) || 3600) / 60;
  return Math.ceil(minutes * CREDITS_PER_MINUTE);
}

// What to start now: { start: [items], waiting: [{ item, why }] }. balance is
// { left } or null when it could not be read (then nothing is started).
export function plan({ resultsDir, items, state, balance, now = Date.now(), syncFrom = SYNC_FROM_PUBLISHED }) {
  const from = Date.parse(syncFrom);
  const candidates = items
    .filter((item) => item.published && Date.parse(item.published) >= from)
    .sort((a, b) => Date.parse(a.published) - Date.parse(b.published)); // oldest first
  const start = [];
  const waiting = [];
  let left = balance ? Number(balance.left) : null;
  for (const item of candidates) {
    if (isSynced(resultsDir, item)) continue;
    const record = state.jobs?.[item.id];
    if (record?.lastStartedAt && now - Date.parse(record.lastStartedAt) < RETRY_AFTER_HOURS * 3600 * 1000) {
      waiting.push({ item, why: 'running' });
      continue;
    }
    if ((record?.attempts || 0) >= MAX_ATTEMPTS) {
      waiting.push({ item, why: 'gave up' });
      continue;
    }
    if (left == null) {
      waiting.push({ item, why: 'balance unknown' });
      continue;
    }
    const cost = estimateCredits(item);
    if (left - cost < RESERVE_CREDITS || start.length >= MAX_PER_RUN) {
      waiting.push({ item, why: start.length >= MAX_PER_RUN ? 'next hour' : 'credits' });
      continue;
    }
    left -= cost;
    start.push(item);
  }
  return { start, waiting };
}

export function dispatchPayload(item, jobId = crypto.randomUUID().replace(/-/g, '')) {
  return {
    event_type: 'run-voice-job',
    client_payload: {
      videoId: item.id,
      audioUrl: item.url,
      refs: item.refs,
      jobId,
      variant: 'regular',
      language: 'en',
      maggid: 'bornstein',
    },
  };
}

async function readBalance(apiKey) {
  if (!apiKey) return null;
  try {
    const response = await fetch('https://api.elevenlabs.io/v1/user/subscription', {
      headers: { 'xi-api-key': apiKey },
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const used = Number(data.character_count);
    const limit = Number(data.character_limit);
    return Number.isFinite(used) && Number.isFinite(limit) ? { used, limit, left: Math.max(0, limit - used) } : null;
  } catch {
    return null;
  }
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv) {
  const resultsDir = arg(argv, '--results');
  const itemsFile = arg(argv, '--items');
  if (!resultsDir || !itemsFile) throw new Error('--results and --items are required');
  const dryRun = argv.includes('--dry-run');
  const items = JSON.parse(fs.readFileSync(itemsFile, 'utf8')).items || [];
  const stateFile = path.join(resultsDir, STATE_FILE);
  const state = readJson(stateFile) || { jobs: {} };
  state.jobs ||= {};
  const balance = await readBalance(process.env.ELEVENLABS_API_KEY);
  console.log(balance
    ? `ElevenLabs: ${balance.left.toLocaleString('en-US')} of ${balance.limit.toLocaleString('en-US')} credits left.`
    : 'ElevenLabs: the balance could not be read, so no sync is started this hour.');
  const { start, waiting } = plan({ resultsDir, items, state, balance });
  for (const { item, why } of waiting) console.log(`Waiting: ${item.title} (${item.id}) -- ${why}.`);
  const repo = process.env.GITHUB_REPOSITORY;
  for (const item of start) {
    const payload = dispatchPayload(item);
    if (dryRun) {
      console.log(`Would start: ${item.title} (${item.id}), about ${estimateCredits(item)} credits.`);
      continue;
    }
    const response = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.GH_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      console.log(`Could not start ${item.title}: GitHub answered ${response.status}.`);
      continue;
    }
    const record = state.jobs[item.id] || { attempts: 0 };
    state.jobs[item.id] = {
      title: item.title,
      attempts: (record.attempts || 0) + 1,
      lastStartedAt: new Date().toISOString(),
      jobId: payload.client_payload.jobId,
    };
    console.log(`Started: ${item.title} (${item.id}), about ${estimateCredits(item)} credits.`);
  }
  if (!dryRun && start.length) {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `Started ${start.length} sync(s); ${waiting.length} waiting.${balance ? ` ${balance.left} credits left.` : ''}\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
