#!/usr/bin/env node
// Runs the LIVE engine (Live Follow's phrase matcher, live-matcher.js, driven the
// way the page's "Video transcript" mode drives it -- live-video.js) over a whole
// recording offline, and writes the result as a dafsync-alignment-v2 document the
// player loads like any other. That is what lets a test shiur show a "Live #N"
// alignment next to the regular engine's "Regular #N" ones: both are the same
// kind of file, so the player needs no second way of reading them.
//
// The transcript is the word-timed one Live Follow gets from ElevenLabs' batch
// model (see netlify/functions/live-video-job-background.mjs): [[text, start,
// end], ...]. Fetch it with --fetch-transcript (asks the site's own transcript
// job, which already holds the ElevenLabs key) or hand over a file with --words.
//
//   node live-engine.mjs --video-id Zsy7oDUP6Pw --refs "Bekhorot 2a,Bekhorot 2b,Bekhorot 3a" \
//        --words words.json --out alignment.json
//   node live-engine.mjs --video-id Zsy7oDUP6Pw --fetch-transcript --out-words words.json
//   (--elevenlabs asks ElevenLabs directly, with ELEVENLABS_API_KEY, instead of the site)
//
// Saving the result as the next numbered run is test_runs.py's job
// (tools/caption-sync/test_runs.py publish --engine live ...), so both engines
// share one numbering.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.join(HERE, '..', '..');
const LM = require(path.join(SITE, 'live-matcher.js'));
const LV = require(path.join(SITE, 'live-video.js'));

// app.js's flattenText / stripHtml, which decide how a daf's text is cut into
// paragraphs and words -- the player indexes words (w0/w1) by exactly these.
const flattenText = (value) => {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap(flattenText).filter(Boolean);
};
const stripHtml = (text) => String(text)
  .replace(/<[^>]*>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&thinsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
  .replace(/\s+/g, ' ').trim();

export async function fetchSefariaParagraphs(ref, fetchImpl = fetch) {
  const response = await fetchImpl(`https://www.sefaria.org/api/v3/texts/${encodeURIComponent(ref)}?version=source&version=translation&return_format=text_only`);
  if (!response.ok) throw new Error(`Sefaria returned ${response.status} for ${ref}`);
  const data = await response.json();
  const versions = Array.isArray(data.versions) ? data.versions : [];
  const source = versions.find((v) => String(v.language || '').toLowerCase().includes('hebrew')) || versions[0];
  const he = flattenText(source?.text ?? data.he).map(stripHtml).filter(Boolean);
  if (!he.length) throw new Error(`No Hebrew text for ${ref}`);
  return he.map((text, index) => ({ ref: data.sectionRef ? `${data.sectionRef}.${index + 1}` : `${ref}.${index + 1}`, he: text }));
}

// words: [[text, start, end], ...] -> the engine's own phrase timeline.
export function alignTranscript({ words, paragraphs, startRef = null }) {
  const canon = LM.buildCanon(paragraphs.map((p) => ({ ref: p.ref, he: p.he })));
  const batchKeyterms = LM.buildKeytermList(canon, 400);
  const listTokens = LM.keytermTokens(batchKeyterms);
  const segments = LV.wordsToSegments(words.map(([text, start, end]) => ({ text, start, end })));
  let startIndex = null;
  if (startRef) {
    const first = canon.words.findIndex((w) => w.ref.startsWith(`${startRef}.`));
    if (first >= 0) startIndex = first;
  }
  const { timeline } = LV.alignSegments(LM, canon, segments, { startIndex, listTokens, leakMinRun: LM.LEAK_MIN_RUN_BATCH });
  return { canon, timeline, phrases: segments.length };
}

// A canon word range s..e -> [{ ref: "Bekhorot 2a:3", w0, w1 }] one per paragraph it crosses.
function rangesByParagraph(canon, s, e) {
  const out = [];
  for (let i = s; i <= e; i += 1) {
    const w = canon.words[i];
    const ref = w.ref.replace(/\.(\d+)$/, ':$1');
    const last = out[out.length - 1];
    if (last && last.ref === ref && w.wordIndex === last.w1 + 1) last.w1 = w.wordIndex;
    else if (last && last.ref === ref && w.wordIndex <= last.w1) continue;
    else out.push({ ref, w0: w.wordIndex, w1: w.wordIndex });
  }
  return out;
}

// The timeline as an alignment document. Every paragraph of the daf gets a
// segment (the player shows the whole daf): the stretches the engine placed
// at the times it placed them, the rest `estimated` between their neighbours.
export function buildAlignment({ timeline, canon, paragraphs, videoId, videoUrl, refs, duration, generatedAt = new Date().toISOString() }) {
  const wordTimeline = [];
  const segments = [];
  const paragraphByRef = new Map(paragraphs.map((p) => [p.ref.replace(/\.(\d+)$/, ':$1'), p]));
  const tokensOf = (p) => LM.segmentTokens(p.he);
  for (const entry of timeline) {
    if (entry.state !== 'read') continue;
    for (const range of rangesByParagraph(canon, entry.s, entry.e)) {
      wordTimeline.push({ start: entry.start, end: entry.end, ref: range.ref, w0: range.w0, w1: range.w1, heardText: entry.text || '' });
      const paragraph = paragraphByRef.get(range.ref);
      segments.push({
        ref: range.ref, start: entry.start, end: entry.end,
        he: paragraph ? tokensOf(paragraph).slice(range.w0, range.w1 + 1).join(' ') : '',
        w0: range.w0, w1: range.w1, estimated: false,
      });
    }
  }
  wordTimeline.sort((a, b) => a.start - b.start);

  // Paragraphs nothing was placed in, between the paragraphs on either side.
  const placedRefs = new Set(segments.map((s) => s.ref));
  const order = [...paragraphByRef.keys()];
  const firstStartOf = (ref) => Math.min(...segments.filter((s) => s.ref === ref).map((s) => s.start));
  const lastEndOf = (ref) => Math.max(...segments.filter((s) => s.ref === ref).map((s) => s.end));
  order.forEach((ref, i) => {
    if (placedRefs.has(ref)) return;
    let before = null;
    for (let j = i - 1; j >= 0; j -= 1) if (placedRefs.has(order[j])) { before = lastEndOf(order[j]); break; }
    let after = null;
    for (let j = i + 1; j < order.length; j += 1) if (placedRefs.has(order[j])) { after = firstStartOf(order[j]); break; }
    const start = before ?? 0;
    const end = Math.max(start + 0.1, after ?? start + 0.1);
    const paragraph = paragraphByRef.get(ref);
    segments.push({ ref, start, end, he: paragraph.he, w0: 0, w1: tokensOf(paragraph).length - 1, estimated: true });
  });
  segments.sort((a, b) => a.start - b.start || order.indexOf(a.ref) - order.indexOf(b.ref));

  const counts = { read: 0, explain: 0, unplaced: 0, hold: 0 };
  let matchedWords = 0;
  for (const entry of timeline) {
    counts[entry.state] = (counts[entry.state] || 0) + 1;
    if (entry.state === 'read') matchedWords += entry.e - entry.s + 1;
  }
  const dafRefs = [...new Set(refs)];
  return {
    schema: 'dafsync-alignment-v2',
    title: `Live engine alignment — ${dafRefs.join(', ')}`,
    dafRef: dafRefs[0],
    duration: duration ?? (timeline.length ? timeline[timeline.length - 1].end : 0),
    alignmentStatus: 'in-progress',
    generator: 'live-video.js',
    videoSource: { type: 'youtube', url: videoUrl, videoId },
    segments,
    wordTimeline,
    matchStats: {
      totalRuns: timeline.length,
      placedRuns: counts.read,
      explainRuns: counts.explain,
      unplacedRuns: counts.unplaced,
      matchedWords,
      totalWords: canon.length,
    },
    videoId,
    videoUrl,
    coveredRefs: dafRefs,
    primaryRefs: dafRefs,
    generatedAt,
  };
}

// The same word-timed transcript, asked of ElevenLabs directly with the key from
// the environment (what a GitHub Actions run has) -- the site's transcript job
// above is the way in when it does not. Mirrors shared/live-video-job.mjs's
// buildTranscribeFields/compactWords, which can't be imported here: that module
// pulls in Netlify's blob store.
async function transcribeWithElevenLabs(videoId, { apiKey = process.env.ELEVENLABS_API_KEY, fetchImpl = fetch } = {}) {
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY is not set');
  const form = new FormData();
  form.set('model_id', 'scribe_v2');
  form.set('source_url', `https://www.youtube.com/watch?v=${videoId}`);
  form.set('timestamps_granularity', 'word');
  form.set('tag_audio_events', 'false');
  const response = await fetchImpl('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST', headers: { 'xi-api-key': apiKey }, body: form, signal: AbortSignal.timeout(14 * 60 * 1000),
  });
  if (!response.ok) throw new Error(`ElevenLabs returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const result = await response.json();
  const words = (Array.isArray(result.words) ? result.words : [])
    .filter((w) => w && w.type === 'word' && typeof w.text === 'string' && w.text.trim() && Number.isFinite(w.start))
    .map((w) => [w.text.trim(), +w.start.toFixed(2), +(Number.isFinite(w.end) ? w.end : w.start).toFixed(2)]);
  return { words, seconds: words.length ? words[words.length - 1][2] : 0, languageCode: result.language_code ?? null };
}

async function fetchTranscript(videoId, { base = 'https://dafsync.netlify.app', origin = 'https://dafsync.netlify.app', timeoutMs = 20 * 60 * 1000 } = {}) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const statusUrl = `${base}/api/live-video-status?url=${encodeURIComponent(url)}`;
  const read = async () => (await fetch(statusUrl, { headers: { Origin: origin } })).json();
  let status = await read();
  if (status.status === 'absent') {
    await fetch(`${base}/.netlify/functions/live-video-job-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ url }),
    });
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    status = await read();
    if (status.status === 'done') return status;
    if (status.status === 'error') throw new Error(`Transcript job failed: ${status.error}`);
    await new Promise((resolve) => setTimeout(resolve, 15000));
  }
  throw new Error('Timed out waiting for the transcript.');
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--fetch-transcript') args.fetchTranscript = true;
    else if (a === '--elevenlabs') args.elevenlabs = true;
    else if (a.startsWith('--')) args[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
    else throw new Error(`Unexpected argument ${a}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.videoId) throw new Error('--video-id is required');
  let words;
  let duration;
  if (args.fetchTranscript) {
    const status = args.elevenlabs ? await transcribeWithElevenLabs(args.videoId) : await fetchTranscript(args.videoId);
    words = status.words;
    duration = status.seconds;
    if (args.outWords) fs.writeFileSync(args.outWords, JSON.stringify(status));
    console.log(`Transcript: ${words.length} words, ${status.seconds}s`);
    if (!args.out) return;
  } else {
    const loaded = JSON.parse(fs.readFileSync(args.words, 'utf8'));
    words = Array.isArray(loaded) ? loaded : loaded.words;
    duration = loaded.seconds;
  }
  if (!args.refs) throw new Error('--refs is required (comma separated, e.g. "Bekhorot 2a,Bekhorot 2b")');
  const refs = args.refs.split(',').map((r) => r.trim()).filter(Boolean);
  const paragraphs = (await Promise.all(refs.map((r) => fetchSefariaParagraphs(r)))).flat();
  const { canon, timeline } = alignTranscript({ words, paragraphs, startRef: args.startRef || refs[0] });
  const videoUrl = `https://www.youtube.com/watch?v=${args.videoId}`;
  const alignment = buildAlignment({ timeline, canon, paragraphs, videoId: args.videoId, videoUrl, refs, duration });
  fs.writeFileSync(args.out, JSON.stringify(alignment, null, 2));
  const s = alignment.matchStats;
  console.log(`Live engine: ${s.totalRuns} phrases, ${s.placedRuns} placed (${s.matchedWords}/${s.totalWords} daf words) -> ${args.out}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}
