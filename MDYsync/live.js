'use strict';

// Live Follow (experimental) -- /live/'s own script, deliberately separate
// from app.js. app.js's entire state object exists to drive a recorded
// video's playback (scrubber, YouTube/HTML5 player, segment timestamps);
// none of that applies here. Live Follow has no video and no recording --
// it streams this device's own microphone straight to ElevenLabs' realtime
// speech-to-text over a browser-opened WebSocket (see live-token.mjs's own
// comment for why the API key itself never reaches this file), and matches
// what comes back against the daf's text with live-matcher.js -- a port of
// the batch voice-sync pipeline's own deterministic matcher -- highlighting
// the phrase being read.
//
// The daf is shown as Sefaria's text, not the Vilna page image: the page
// image's word boxes and highlight overlay live inside app.js's player and
// would have to be extracted first. That's a follow-up once this proves
// it can actually track a live shiur.

const ELEVENLABS_WS_BASE = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';
// ElevenLabs recommends 16kHz mono for realtime STT as the right bandwidth/
// quality tradeoff; pcm_16000 (the audio_format below) is 16-bit signed
// little-endian PCM at that rate, which is what everything in this file's
// audio pipeline is built to produce.
const TARGET_SAMPLE_RATE = 16000;
const CHUNK_SAMPLES = 1600; // 100ms at 16kHz -- small enough to feel live, large enough not to spam the socket
const MAX_RECONNECT_DELAY_MS = 10000;
const PREVIOUS_TEXT_CHARS = 300; // how much committed context survives a reconnect
const PROVISIONAL_THROTTLE_MS = 50;
// How long ElevenLabs waits in silence before committing an utterance (its
// default is 1.5s). The daf highlight is only confirmed on a commit, and a
// maggid shiur reading continuously barely pauses -- measured against the
// real API with a long reading, the default left the highlight a median 9s
// behind the voice; 0.5s brought that to about 2s.
const VAD_SILENCE_SECS = 0.5;
const MANUAL_SCROLL_GRACE_MS = 5000;
// Errors that a reconnect can't fix -- retrying would just loop.
const FATAL_ERROR_TYPES = new Set(['quota_exceeded', 'unaccepted_terms']);

const LM = window.LiveMatcher;

// Opt-in switches for trying the speech service's own settings on real audio,
// since most of what still goes wrong in a real session (garbled readings that
// match nowhere) is the transcription, not the matching. Compare the session
// logs (the phonetic scores and the number of unplaced commits) with and
// without. Both are recorded in the log's first entry.
//   /live/?lang=he     Hebrew as the primary language, English as secondary.
//                      Default is auto-detect, which keeps English explanation
//                      in Latin letters (so it can be told from the reading)
//                      but may hear Hebrew/Aramaic reading less well.
//   /live/?filter=1    ElevenLabs' background-audio filter.
const PAGE_OPTIONS = {
  lang: new URLSearchParams(location.search).get('lang'),
  filter: new URLSearchParams(location.search).get('filter') === '1',
};

function $(id) { return document.getElementById(id); }

let toastTimer = null;
function showToast(message, type = 'info') {
  const toast = $('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.toggle('error', type === 'error');
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), Math.min(12000, Math.max(3200, 1200 + message.length * 60)));
}

// ---- Audio pipeline ---------------------------------------------------
// AudioWorkletProcessor that does nothing but batch raw Float32 frames and
// hand them to the main thread every ~2048 samples (~46ms at 44.1kHz) --
// small enough for low latency, large enough that postMessage isn't called
// on every single 128-sample render quantum. Loaded from a Blob URL so the
// whole pipeline stays in this one file rather than needing a second
// script the page has to fetch and keep in sync.
const MIC_WORKLET_SOURCE = `
class LiveMicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._chunks = [];
    this._bufferedLength = 0;
    this._flushAt = 2048;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) {
      this._chunks.push(channel.slice());
      this._bufferedLength += channel.length;
      if (this._bufferedLength >= this._flushAt) {
        const merged = new Float32Array(this._bufferedLength);
        let offset = 0;
        for (const chunk of this._chunks) { merged.set(chunk, offset); offset += chunk.length; }
        this.port.postMessage(merged);
        this._chunks = [];
        this._bufferedLength = 0;
      }
    }
    return true;
  }
}
registerProcessor('live-mic-processor', LiveMicProcessor);
`;

// Plain linear interpolation, not a proper windowed-sinc resampler --
// cheap, dependency-free, and fuzzy phonetic matching downstream doesn't
// need audiophile-grade output. Each call resamples independently (no
// carried-over fractional phase across chunk boundaries), which can leave a
// sub-millisecond seam every ~46ms; inaudible-to-ASR in practice, not worth
// the extra bookkeeping for this experiment.
function resampleLinear(float32, fromRate, toRate) {
  if (fromRate === toRate) return float32;
  const ratio = fromRate / toRate;
  const newLength = Math.max(1, Math.round(float32.length / ratio));
  const result = new Float32Array(newLength);
  for (let i = 0; i < newLength; i += 1) {
    const srcIndex = i * ratio;
    const i0 = Math.floor(srcIndex);
    const i1 = Math.min(i0 + 1, float32.length - 1);
    const frac = srcIndex - i0;
    result[i] = float32[i0] * (1 - frac) + float32[i1] * frac;
  }
  return result;
}

function floatTo16BitPCM(float32) {
  const buffer = new ArrayBuffer(float32.length * 2);
  const view = new DataView(buffer);
  for (let i = 0, offset = 0; i < float32.length; i += 1, offset += 2) {
    const clamped = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return buffer;
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000; // String.fromCharCode.apply chokes on very large arg lists
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function rms(float32) {
  if (!float32.length) return 0;
  let sum = 0;
  for (let i = 0; i < float32.length; i += 1) sum += float32[i] * float32[i];
  return Math.sqrt(sum / float32.length);
}

// ---- Live Follow session ----------------------------------------------
const live = {
  micStream: null,
  audioContext: null,
  workletNode: null,
  ws: null,
  resampleTail: new Float32Array(0), // leftover resampled-but-not-yet-sent samples
  manualStop: false,
  reconnectAttempt: 0,
  reconnectTimer: null,
  firstChunkSentThisConnection: false,
  previousText: '', // rolling committed-transcript tail, carried across reconnects
  // The daf being followed (see loadDaf) and the matcher's state over it.
  daf: null, // { key, label, canon, keyterms }
  tracker: null,
  preview: null,
  runCounter: 0,
  spans: [], // canon word index -> its <span> in #liveDafText
  confirmed: null, // { s, e } currently highlighted as confirmed
  provisional: null, // { s, e } currently highlighted from a partial transcript
  partialTimer: null,
  latestPartial: '',
  lastManualScrollAt: 0,
  // Where the reader pointed (a canon word index), until the next Start
  // consumes it; and the <span> carrying its marker, until the first phrase
  // is actually placed from it.
  anchorIndex: null,
  anchorSpan: null,
  unplacedHebrew: 0, // consecutive commits with Hebrew in them that placed nothing
  followState: null, // what setFollowState last showed
  log: [],
  logStart: 0,
};
const LOG_MAX_ENTRIES = 400;

function setStatus(kind, text, detail) {
  const dot = $('liveStatusDot');
  const label = $('liveStatusText');
  const detailEl = $('liveStatusDetail');
  if (dot) dot.className = `status-dot${kind ? ' ' + kind : ''}`;
  if (label) label.textContent = text;
  if (detailEl) detailEl.textContent = detail || '';
}

function setMicLevel(level) {
  const fill = $('liveMicMeterFill');
  if (fill) fill.style.width = `${Math.min(100, Math.max(0, level * 100))}%`;
}

function setDebug(field, value) {
  const el = $(`liveDebug${field}`);
  if (el) el.textContent = value === undefined || value === null || value === '' ? '—' : value;
}

function appendPreviousText(text) {
  if (!text) return;
  live.previousText = (live.previousText + ' ' + text).trim().slice(-PREVIOUS_TEXT_CHARS);
}

// A rolling record of what the session heard and decided, copyable from the
// debug panel. Whether the status flips or the highlight lags on a real
// shiur can't be reproduced from here -- the transcript and what the matcher
// did with each utterance can.
function logEvent(kind, data) {
  live.log.push({ t: +((performance.now() - live.logStart) / 1000).toFixed(2), kind, ...data });
  if (live.log.length > LOG_MAX_ENTRIES) live.log.shift();
}

async function copySessionLog() {
  const text = JSON.stringify({ daf: live.daf?.label || null, entries: live.log }, null, 1);
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const box = document.createElement('textarea');
    box.value = text;
    box.style.cssText = 'position:fixed;opacity:0;';
    document.body.append(box);
    box.select();
    const ok = document.execCommand?.('copy');
    box.remove();
    if (!ok) return showToast('Could not copy the log on this browser.', 'error');
  }
  showToast(`Session log copied (${live.log.length} entries).`);
}

// ---- The daf ------------------------------------------------------------
// "Chullin 91a", "chullin 91", "Bava Metzia 12b". English tractate names
// only (Sefaria's own), matching what every other page here accepts.
function parseDafInput(input) {
  const match = /^\s*([A-Za-z][A-Za-z' -]*?)\s*(\d{1,3})\s*([abAB])?\s*$/.exec(input || '');
  if (!match) return null;
  const tractate = match[1].trim().split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  const daf = Number(match[2]);
  const amud = (match[3] || 'a').toLowerCase();
  // The requested amud plus the one after it: a shiur that runs past the end
  // of the amud keeps being followed instead of going quiet at the page break.
  const refs = amud === 'a'
    ? [`${tractate} ${daf}a`, `${tractate} ${daf}b`]
    : [`${tractate} ${daf}b`, `${tractate} ${daf + 1}a`];
  return { label: `${tractate} ${daf}${amud}`, key: refs.join('|'), refs };
}

function flattenText(value) {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap(flattenText).filter(Boolean);
}

// Same request and response handling as app.js's fetchSefariaParagraphs:
// this site's own proxy first, Sefaria directly if the proxy is down.
async function fetchAmudSegments(ref) {
  let response;
  try {
    response = await fetch(`/api/sefaria?ref=${encodeURIComponent(ref)}`);
    if (!response.ok) throw new Error('Proxy unavailable');
  } catch {
    response = await fetch(`https://www.sefaria.org/api/v3/texts/${encodeURIComponent(ref)}?version=source&return_format=text_only`);
  }
  if (!response.ok) throw new Error(`Sefaria returned ${response.status} for ${ref}`);
  const data = await response.json();
  const versions = Array.isArray(data.versions) ? data.versions : [];
  const source = versions.find((v) => String(v.language || '').toLowerCase().includes('hebrew')) || versions[0];
  const he = flattenText(source?.text ?? data.he);
  if (!he.length) throw new Error(`No Hebrew text came back for ${ref}.`);
  return he.map((text, i) => ({ ref: `${ref}:${i + 1}`, he: text }));
}

async function loadDaf(parsed) {
  if (live.daf?.key === parsed.key) return live.daf;
  const [first, second] = await Promise.allSettled(parsed.refs.map(fetchAmudSegments));
  if (first.status === 'rejected') throw first.reason;
  // The following amud is a bonus -- the end of a tractate has none.
  const segments = first.value.concat(second.status === 'fulfilled' ? second.value : []);
  const canon = LM.buildCanon(segments);
  const keyterms = LM.buildRealtimeKeyterms(canon);
  live.daf = { key: parsed.key, label: parsed.label, refs: parsed.refs, segments, canon, keyterms, keytermTokens: LM.keytermTokens(keyterms) };
  renderDaf(live.daf);
  return live.daf;
}

async function showDaf() {
  const parsed = parseDafInput($('liveRefInput').value);
  if (!parsed) {
    showToast('Enter a daf like "Chullin 91a" (English tractate name).', 'error');
    return false;
  }
  const button = $('liveShowDafButton');
  button.disabled = true;
  setStatus('', 'Loading…', `Loading ${parsed.label}`);
  try {
    await loadDaf(parsed);
  } catch (error) {
    console.error('Could not load the daf for Live Follow:', error);
    setStatus('error', 'Error', `Could not load ${parsed.label}.`);
    showToast(`Could not load ${parsed.label}: ${error.message}`, 'error');
    return false;
  } finally {
    button.disabled = Boolean(live.tracker);
  }
  setStatus('', 'Ready', 'Tap the word where the reading starts, or just tap Start.');
  return true;
}

function renderDaf(daf) {
  const container = $('liveDafText');
  container.textContent = '';
  container.classList.remove('dimmed');
  live.spans = [];
  live.confirmed = null;
  live.provisional = null;
  live.anchorIndex = null;
  live.anchorSpan = null;
  let canonIndex = 0;
  for (const segment of daf.segments) {
    const p = document.createElement('p');
    p.dataset.ref = segment.ref;
    LM.segmentTokens(segment.he).forEach((token, i) => {
      if (i) p.append(' ');
      const span = document.createElement('span');
      span.textContent = token;
      // Exactly buildCanon's rule, so span N is always canon word N.
      if (LM.normalizeWord(token)) {
        span.className = 'w';
        span.dataset.i = String(canonIndex);
        live.spans[canonIndex] = span;
        canonIndex += 1;
      }
      p.append(span);
    });
    container.append(p);
  }
  $('liveDafEmpty').hidden = true;
  $('liveDafHeading').textContent = daf.refs[1] && daf.segments.some((s) => s.ref.startsWith(`${daf.refs[1]}:`))
    ? `${daf.refs[0]} – ${daf.refs[1]}`
    : daf.refs[0];
}

// ---- Highlighting ---------------------------------------------------------
function paintRange(range, className, on) {
  if (!range) return;
  for (let i = range.s; i <= range.e; i += 1) live.spans[i]?.classList.toggle(className, on);
}

function scrollToWord(index) {
  const span = live.spans[index];
  const scroller = $('liveDafScroll');
  if (!span || !scroller) return;
  if (Date.now() - live.lastManualScrollAt < MANUAL_SCROLL_GRACE_MS) return;
  // offsetTop is relative to #liveDafScroll (position: relative), so this
  // scrolls only the daf box, never the page around it.
  const top = span.offsetTop - scroller.clientHeight / 3;
  scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

function showConfirmed(match) {
  setProvisional(null);
  clearAnchorMark();
  paintRange(live.confirmed, 'hl', false);
  live.confirmed = { s: match.s, e: match.e };
  paintRange(live.confirmed, 'hl', true);
  $('liveDafText').classList.remove('dimmed');
  scrollToWord(match.s);
  const words = live.daf.canon.words.slice(match.s, match.e + 1);
  const phrase = words.map((w) => w.text).join(' ');
  const phraseEl = $('livePhraseText');
  phraseEl.textContent = phrase;
  phraseEl.classList.remove('empty');
  const confidence = `Sound match ${Math.round(match.phonScore)} · Letters ${Math.round(match.charScore)}`;
  $('liveConfidenceText').textContent = `${confidence} · ${words[0].ref}`;
  // Hebrew alone in the right-to-left row; the Latin details get their own
  // left-to-right row, or the bidi algorithm scrambles them together.
  setDebug('Match', phrase);
  setDebug('Confidence', `phonetic ${match.phonScore.toFixed(1)} / character ${match.charScore.toFixed(1)} · words ${match.s}–${match.e} (${match.source})`);
}

function setProvisional(match) {
  paintRange(live.provisional, 'hl-provisional', false);
  live.provisional = match ? { s: match.s, e: match.e } : null;
  paintRange(live.provisional, 'hl-provisional', true);
  if (match) scrollToWord(match.s);
}

// ---- Pointing at the daf ----------------------------------------------------
// Working out where the reading is takes a few utterances (and is the
// weakest part of a cold start); the person following along can see the daf
// and hear the room. Tapping a word sets the position outright -- before
// Start, so the very first phrase places immediately, or at any point
// mid-session, to put right an alignment that has drifted. The automatic
// search stays as the fallback when nothing is tapped, and as the safety net
// when the reading moves on from a tapped word.
function anchorDetail(span) {
  const words = live.daf.canon.words.slice(Number(span.dataset.i), Number(span.dataset.i) + 4).map((w) => w.text).join(' ');
  return `From “${words}…” — tap another word to correct`;
}

function clearAnchorMark() {
  live.anchorSpan?.classList.remove('anchor');
  live.anchorSpan = null;
}

function setAnchor(index) {
  const span = live.spans[index];
  if (!span || !live.daf) return;
  clearAnchorMark();
  live.anchorSpan = span;
  span.classList.add('anchor');
  paintRange(live.confirmed, 'hl', false);
  live.confirmed = null;
  setProvisional(null);
  live.lastPreview = null;
  const hint = $('livePhraseText');
  hint.textContent = live.daf.canon.words.slice(index, index + 5).map((w) => w.text).join(' ');
  hint.classList.add('empty');
  $('liveConfidenceText').textContent = 'Position set by you';
  $('liveDafText').classList.remove('dimmed');
  if (live.tracker) {
    // Mid-session: take it as the position now. The next phrase heard is
    // matched around it.
    live.tracker.anchor(index);
    live.preview.reset();
    live.unplacedHebrew = 0;
    live.anchorIndex = null;
    setFollowState('reading', { detail: anchorDetail(span) });
    setDebug('Pending', '—');
    updateSearchWindowDebug();
  } else {
    live.anchorIndex = index;
    setStatus('', 'Ready', `${anchorDetail(span).replace(' — tap another word to correct', '')} — tap Start to listen.`);
  }
  logEvent('anchor', { index, word: live.daf.canon.words[index].text, midSession: Boolean(live.tracker) });
}

function updateSearchWindowDebug() {
  const n = live.daf?.canon.length || 0;
  if (!live.tracker || !n) return setDebug('Window', '—');
  if (!live.tracker.locked) return setDebug('Window', `whole daf (all ${n} words) — not locked yet`);
  const c = live.tracker.cursor;
  setDebug('Window', `words ${Math.max(0, c - LM.BACK_WINDOW)}–${Math.min(n, c + LM.FWD_WINDOW)} of ${n} (cursor ${c})`);
}

// What the status says, and why:
//   reading   -- the latest utterance (or partial) was placed on the daf.
//   explaining -- the latest utterance had NO Hebrew in it: English (or
//                 another language) is being spoken. The only state that can
//                 actually be told from the speech itself.
//   listening -- Hebrew was heard but not placed. Not "explaining": it may be
//                the reading with the position slightly off, a reading that
//                skipped ahead and is waiting on confirmation, or Hebrew
//                explanation. Doesn't dim the daf, and after a few in a row
//                says what to do about it (tap the word).
//   searching -- no position yet; nothing locked, nothing pointed at.
// (Before this split, every unplaced utterance said "Explaining" -- including
// Hebrew reading the matcher simply hadn't caught up with.)
function setFollowState(state, options = {}) {
  live.followState = state;
  $('liveDafText').classList.toggle('dimmed', state === 'explaining' || state === 'searching');
  const tapHint = live.unplacedHebrew >= 3 ? ' Not finding your place — tap the word being read to set it.' : '';
  if (state === 'reading') {
    setStatus('reading', 'Following', options.detail || `Following ${live.daf.label}`);
  } else if (state === 'explaining') {
    setStatus('explaining', 'Explaining', 'No Hebrew heard — holding the last phrase until the reading resumes');
  } else if (state === 'listening') {
    setStatus('explaining', 'Listening…', (options.pending
      ? 'Found a possible new spot — waiting for the next phrase to confirm it.'
      : 'Heard Hebrew but couldn’t place it on the daf yet.') + tapHint);
  } else {
    setStatus('searching', 'Searching…', (options.pending
      ? 'Found a possible spot — waiting for the next phrase to confirm it.'
      : `Listening for a phrase from ${live.daf.label}.`) + tapHint);
  }
}

function handleCommitted(text) {
  clearTimeout(live.partialTimer);
  live.partialTimer = null;
  setDebug('Partial', '—');
  setDebug('Committed', text);
  appendPreviousText(text);
  if (!live.tracker) return;
  if (!text.trim()) {
    // The service committed nothing: silence. Not "Explaining" -- nobody was
    // heard -- so the status, and the highlight, stay as they were. (A real
    // session's log showed three of these, each flipping the status.)
    logEvent('commit', { text: '', silent: true, outcomes: [], state: $('liveStatusText').textContent });
    return;
  }
  setProvisional(null);
  live.preview.reset(); // the preview's own position hands back to the confirmed one
  // The service sometimes recites its keyterm list, or sticks on one word, when
  // the audio goes quiet; neither is speech (see cleanTranscript).
  const heard = LM.cleanTranscript(text, live.daf.keytermTokens);
  const allRuns = LM.splitHebrewRuns(heard).flatMap((run) => LM.chunkRun(run));
  const runs = allRuns.filter((run) => run.length >= LM.PLACEABLE_RUN_MIN_WORDS);
  // A lone Hebrew word with nothing else around it is a fragment of the
  // reading the voice detector split off, or one term inside English: not
  // enough to say anything about the state either way. (With a few English
  // words alongside it, it IS the English that tells us.)
  const latinWords = heard.split(/\s+/).filter((token) => /[A-Za-z]/.test(token)).length;
  const bareFragment = !runs.length && allRuns.length > 0 && latinWords < 2;
  let placed = null;
  let pending = null;
  const outcomes = [];
  for (const run of runs) {
    const result = live.tracker.step(run, live.runCounter);
    live.runCounter += 1;
    const m = result.match;
    outcomes.push({ words: run.length, kind: result.kind, ...(m ? { s: m.s, e: m.e, phon: +m.phonScore.toFixed(1), char: +m.charScore.toFixed(1), margin: m.margin === undefined ? undefined : +m.margin.toFixed(1) } : {}) });
    if (result.kind === 'local' || result.kind === 'confirmed' || result.kind === 'jump') { placed = result.match; pending = null; }
    else if (result.kind === 'pending') pending = result.match;
  }
  if (placed) showConfirmed(placed);
  setDebug('Pending', pending ? `[${pending.s}–${pending.e}] phonetic ${pending.phonScore.toFixed(1)} — needs one more agreeing phrase` : '—');
  updateSearchWindowDebug();
  if (placed) {
    live.unplacedHebrew = 0;
    setFollowState('reading');
  } else if (bareFragment) {
    // leave the status and the highlight exactly as they were
  } else if (!runs.length) {
    setFollowState(live.tracker.locked ? 'explaining' : 'searching');
  } else {
    live.unplacedHebrew += 1;
    setFollowState(live.tracker.locked ? 'listening' : 'searching', { pending: Boolean(pending) });
  }
  logEvent('commit', { text, ...(heard !== text ? { cleaned: heard } : {}), outcomes, state: $('liveStatusText').textContent, locked: live.tracker.locked, cursor: live.tracker.cursor });
}

// A partial transcript is still being revised, so it never moves the
// tracker -- the preview (see createPreview in live-matcher.js) only shows where the latest few
// words sit, in a lighter highlight, and follows the reading with a cursor of
// its own so it keeps pace through a long reading with no commit in sight.
function runProvisional() {
  live.partialTimer = null;
  if (!live.preview) return;
  const runs = LM.splitHebrewRuns(LM.cleanTranscript(live.latestPartial, live.daf.keytermTokens));
  const last = runs[runs.length - 1];
  if (!last) return;
  const tail = last.slice(-LM.PROVISIONAL_TAIL_WORDS);
  const match = live.preview.update(tail, performance.now() / 1000);
  if (!match) {
    // Hebrew is being spoken, so "Explaining" is wrong whether or not the
    // preview has caught up with where on the daf it is.
    if (live.followState === 'explaining' && tail.length >= LM.PLACEABLE_RUN_MIN_WORDS) setFollowState('listening');
    return;
  }
  // Widened a few words forward (see PREVIEW_LEAD_SECONDS in live-matcher.js)
  // to cover what is being said now, not just what has been transcribed.
  const lastWord = live.daf.canon.length - 1;
  setProvisional({ s: match.s, e: Math.min(lastWord, match.e + match.lead) });
  // Reading has visibly resumed near the confirmed spot -- don't keep saying
  // "Explaining" until the utterance commits (seen against the real API:
  // several seconds of "Explaining" under a highlight moving word by word).
  // The preview only reports a place after the same evidence the tracker
  // needs (one decisive phrase, or two agreeing partials) or while it is
  // already following one -- so this is "Following" even before the tracker
  // itself has locked on a commit (measured: it used to say "Searching…" for
  // the whole of a first, unbroken reading while the highlight moved).
  setFollowState('reading');
  if (!live.lastPreview || live.lastPreview.s !== match.s) logEvent('preview', { s: match.s, e: match.e, lead: match.lead, phon: +match.phonScore.toFixed(1) });
  live.lastPreview = { s: match.s, e: match.e };
}

function handlePartial(text) {
  setDebug('Partial', text);
  live.latestPartial = text;
  if (!live.partialTimer) live.partialTimer = setTimeout(runProvisional, PROVISIONAL_THROTTLE_MS);
}

// ---- ElevenLabs connection --------------------------------------------
async function fetchLiveToken() {
  const response = await fetch('/api/live-token', { method: 'POST' });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.token) throw new Error(body.error || 'Could not get a Live Follow token.');
  return body.token;
}

function buildWsUrl(token, keyterms) {
  const params = new URLSearchParams();
  params.set('model_id', 'scribe_v2_realtime');
  params.set('audio_format', 'pcm_16000');
  // 'vad' (server-side voice-activity detection) rather than 'manual' -- the
  // server decides when a committed_transcript boundary happens (e.g. the
  // maggid shiur pausing between phrases), so the client never has to send
  // its own commit signal. See input_audio_chunk's own 'commit' field below,
  // which this file always sends as false for exactly that reason.
  params.set('commit_strategy', 'vad');
  params.set('vad_silence_threshold_secs', String(VAD_SILENCE_SECS));
  // No language_code, on purpose -- the same choice voice_align.py's
  // transcribe_elevenlabs makes for batch syncs: forcing one language makes
  // the model render the other one in the wrong script, while auto-detection
  // keeps English explanation in Latin letters, which is exactly what lets
  // splitHebrewRuns tell explanation from reading.
  if (PAGE_OPTIONS.lang === 'he') {
    params.set('language_code', 'he');
    params.append('secondary_languages', 'en');
  }
  if (PAGE_OPTIONS.filter) params.set('filter_background_audio', 'true');
  // Repeated keys (keyterms=a&keyterms=b): confirmed against the real API --
  // session_started echoes all 50 back in its config.keyterms.
  for (const term of keyterms) params.append('keyterms', term);
  params.set('token', token);
  return `${ELEVENLABS_WS_BASE}?${params.toString()}`;
}

function clearReconnectTimer() {
  if (live.reconnectTimer) {
    clearTimeout(live.reconnectTimer);
    live.reconnectTimer = null;
  }
}

async function connectWebSocket() {
  clearReconnectTimer();
  let token;
  try {
    token = await fetchLiveToken();
  } catch (error) {
    setStatus('error', 'Error', error.message);
    showToast(error.message, 'error');
    scheduleReconnect();
    return;
  }
  if (live.manualStop) return; // Stop was clicked while the token request was in flight

  live.firstChunkSentThisConnection = true; // next chunk sent is this connection's first
  const ws = new WebSocket(buildWsUrl(token, live.daf.keyterms));
  live.ws = ws;

  ws.addEventListener('open', () => {
    setDebug('Connection', 'Connected, waiting for session_started…');
  });

  ws.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    switch (msg.message_type) {
      case 'session_started':
        live.reconnectAttempt = 0;
        setDebug('Connection', `session ${msg.session_id || ''} started (${live.daf.keyterms.length} keyterms)`);
        if (live.anchorSpan) setFollowState('reading', { detail: anchorDetail(live.anchorSpan) });
        else if (live.tracker.locked) setFollowState('listening');
        else setFollowState('searching');
        break;
      case 'partial_transcript':
        handlePartial(msg.text || '');
        break;
      case 'committed_transcript':
        handleCommitted(msg.text || '');
        break;
      default:
        if (String(msg.message_type || '').includes('error') || msg.error || FATAL_ERROR_TYPES.has(msg.message_type)) {
          console.error('[live] ElevenLabs error:', msg);
          showToast(msg.error || `Live Follow error: ${msg.message_type}`, 'error');
          if (FATAL_ERROR_TYPES.has(msg.message_type)) {
            stopLiveFollow();
            setStatus('error', 'Stopped', msg.error || msg.message_type);
          }
        }
        break;
    }
  });

  ws.addEventListener('close', (event) => {
    if (live.ws !== ws) return; // a newer connection already replaced this one
    live.ws = null;
    if (live.manualStop) return;
    setStatus('searching', 'Reconnecting…', `Lost the connection (code ${event.code}) — retrying`);
    scheduleReconnect();
  });

  ws.addEventListener('error', () => {
    // onclose always follows onerror for a WebSocket -- the close handler
    // above is where reconnect actually gets scheduled.
    console.error('[live] WebSocket error on the ElevenLabs connection.');
  });
}

function scheduleReconnect() {
  if (live.manualStop) return;
  clearReconnectTimer();
  const delay = Math.min(MAX_RECONNECT_DELAY_MS, 1000 * 2 ** live.reconnectAttempt);
  live.reconnectAttempt += 1;
  live.reconnectTimer = setTimeout(connectWebSocket, delay);
}

function sendAudioChunk(int16Buffer) {
  const ws = live.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const message = {
    message_type: 'input_audio_chunk',
    audio_base_64: arrayBufferToBase64(int16Buffer),
    commit: false, // commit_strategy=vad: the server decides, never the client
    sample_rate: TARGET_SAMPLE_RATE,
  };
  if (live.firstChunkSentThisConnection) {
    message.previous_text = live.previousText;
    live.firstChunkSentThisConnection = false;
  }
  ws.send(JSON.stringify(message));
}

function handleRawMicFrames(float32AtNativeRate) {
  setMicLevel(Math.min(1, rms(float32AtNativeRate) * 6));
  const resampled = resampleLinear(float32AtNativeRate, live.audioContext.sampleRate, TARGET_SAMPLE_RATE);
  let combined = resampled;
  if (live.resampleTail.length) {
    combined = new Float32Array(live.resampleTail.length + resampled.length);
    combined.set(live.resampleTail, 0);
    combined.set(resampled, live.resampleTail.length);
  }
  let offset = 0;
  while (combined.length - offset >= CHUNK_SAMPLES) {
    sendAudioChunk(floatTo16BitPCM(combined.subarray(offset, offset + CHUNK_SAMPLES)));
    offset += CHUNK_SAMPLES;
  }
  live.resampleTail = combined.slice(offset);
}

async function startMic() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('This browser does not support microphone access (or the page was not loaded over HTTPS).');
  }
  live.micStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
  // Not relying on { sampleRate: 16000 } in the AudioContext constructor
  // actually producing 16kHz -- some browsers (notably older Safari) are
  // known to ignore that option and keep the hardware rate. Reading back
  // audioContext.sampleRate after construction and resampling in
  // handleRawMicFrames regardless is what actually guarantees pcm_16000,
  // whatever the browser decided to give us.
  live.audioContext = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
  const blobUrl = URL.createObjectURL(new Blob([MIC_WORKLET_SOURCE], { type: 'application/javascript' }));
  try {
    await live.audioContext.audioWorklet.addModule(blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
  const source = live.audioContext.createMediaStreamSource(live.micStream);
  live.workletNode = new AudioWorkletNode(live.audioContext, 'live-mic-processor');
  live.workletNode.port.onmessage = (event) => handleRawMicFrames(event.data);
  source.connect(live.workletNode);
  // Deliberately not connected onward to audioContext.destination -- this
  // pipeline only ever reads the mic, it never needs to play it back.
}

function stopMic() {
  if (live.workletNode) live.workletNode.port.onmessage = null;
  live.workletNode?.disconnect();
  live.workletNode = null;
  live.audioContext?.close().catch(() => {});
  live.audioContext = null;
  live.micStream?.getTracks().forEach((track) => track.stop());
  live.micStream = null;
  live.resampleTail = new Float32Array(0);
  setMicLevel(0);
}

async function startLiveFollow() {
  const parsed = parseDafInput($('liveRefInput').value);
  if (!parsed) {
    showToast('Enter a daf like "Chullin 91a" (English tractate name).', 'error');
    return;
  }
  const button = $('liveStartButton');
  button.disabled = true;
  // The daf first: an unknown daf should fail before asking for the mic,
  // and the keyterms sent when connecting are built from its text. (Already
  // shown by "Show daf"? loadDaf reuses it, along with any word tapped.)
  setStatus('', 'Loading…', `Loading ${parsed.label}`);
  try {
    await loadDaf(parsed);
  } catch (error) {
    console.error('Could not load the daf for Live Follow:', error);
    setStatus('error', 'Error', `Could not load ${parsed.label}.`);
    showToast(`Could not load ${parsed.label}: ${error.message}`, 'error');
    button.disabled = false;
    return;
  }
  live.manualStop = false;
  live.reconnectAttempt = 0;
  live.previousText = '';
  live.tracker = LM.createTracker(live.daf.canon, { eagerRelocalize: true });
  live.preview = LM.createPreview(live.daf.canon, live.tracker);
  live.runCounter = 0;
  live.unplacedHebrew = 0;
  live.lastPreview = null;
  live.log = [];
  live.logStart = performance.now();
  paintRange(live.confirmed, 'hl', false);
  setProvisional(null);
  live.confirmed = null;
  if (live.anchorIndex !== null) {
    // A word was tapped before Start: the session begins locked there. It is
    // used once -- the next Start without a fresh tap goes back to searching.
    live.tracker.anchor(live.anchorIndex);
    logEvent('anchor', { index: live.anchorIndex, word: live.daf.canon.words[live.anchorIndex].text, midSession: false });
    live.anchorIndex = null;
  } else {
    clearAnchorMark();
  }
  logEvent('start', { daf: live.daf.label, anchored: live.tracker.locked, lang: PAGE_OPTIONS.lang || 'auto', filter: PAGE_OPTIONS.filter });
  $('liveRefInput').disabled = true;
  $('liveShowDafButton').disabled = true;
  setStatus('', 'Connecting…', 'Requesting microphone access');
  try {
    await startMic();
  } catch (error) {
    console.error('Could not open the microphone for Live Follow:', error);
    const deniedLikely = error?.name === 'NotAllowedError' || error?.name === 'SecurityError';
    setStatus('error', 'Error', deniedLikely ? 'Microphone access was denied.' : error.message);
    showToast(deniedLikely ? 'Microphone access was denied.' : error.message, 'error');
    stopMic();
    live.tracker = null;
    live.preview = null;
    $('liveRefInput').disabled = false;
    $('liveShowDafButton').disabled = false;
    button.disabled = false;
    return;
  }
  button.disabled = false;
  button.textContent = 'Stop Live Follow';
  button.classList.add('stop');
  setStatus('searching', 'Connecting…', 'Opening the transcription connection');
  updateSearchWindowDebug();
  await connectWebSocket();
}

// Leaves the daf and the last highlight on screen -- after stopping, where
// it had got to is exactly what a reader wants to still see.
function stopLiveFollow() {
  live.manualStop = true;
  clearReconnectTimer();
  clearTimeout(live.partialTimer);
  live.partialTimer = null;
  live.ws?.close();
  live.ws = null;
  stopMic();
  setProvisional(null);
  clearAnchorMark();
  live.tracker = null;
  live.preview = null;
  $('liveRefInput').disabled = false;
  $('liveShowDafButton').disabled = false;
  const button = $('liveStartButton');
  button.textContent = 'Start Live Follow';
  button.classList.remove('stop');
  setStatus('', 'Idle', 'Choose a daf and tap Start.');
  setDebug('Partial', '—');
  setDebug('Connection', '—');
}

$('liveStartButton')?.addEventListener('click', () => {
  if (live.ws || live.micStream || live.reconnectTimer) stopLiveFollow();
  else startLiveFollow();
});

$('liveRefInput')?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !live.tracker) showDaf();
});
$('liveShowDafButton')?.addEventListener('click', showDaf);
$('liveCopyLogButton')?.addEventListener('click', copySessionLog);

// A tap on a word sets the position. Skipped when the tap is the end of a text
// selection drag, so selecting doesn't also move the highlight.
$('liveDafText')?.addEventListener('click', (event) => {
  const span = event.target.closest?.('.w');
  if (!span || String(window.getSelection?.() || '')) return;
  setAnchor(Number(span.dataset.i));
});

// Only genuine user scrolling pauses auto-scroll (wheel/touch/keys), never
// the smooth programmatic scroll scrollToWord itself starts.
for (const type of ['wheel', 'touchmove', 'keydown']) {
  $('liveDafScroll')?.addEventListener(type, () => { live.lastManualScrollAt = Date.now(); }, { passive: true });
}

window.addEventListener('beforeunload', () => {
  if (live.ws || live.micStream) stopLiveFollow();
});
