'use strict';

// Live follow on the Interactive Daf page: follow a shiur being given right
// now (microphone, or a browser tab's sound), or a video (its transcript),
// on the daf picked in the page's own picker -- with the highlight on the
// page's own printed daf, text view, daf-on-video and video-on-daf.
//
// How it fits in. This script finds out WHERE on the daf the reading is, as
// a range of words; app.js draws it. While live follow is on,
// state.liveFollow is { active: true, activeIndex } and the page's segments
// are the daf's paragraphs: placing a range sets the active paragraph and
// narrows its w0/w1 to the words being read, which is all the page's
// existing "active segment" views need to follow it (see the few hooks in
// app.js, each inert unless state.liveFollow is set). Nothing about the
// printed page, its word positions, its zoom or its viewing modes is
// reimplemented here.
//
// Audio never passes through this site's server in the realtime modes: the
// browser opens ElevenLabs' realtime WebSocket itself with a single-use token
// (live-token.mjs; the API key never reaches a browser) and the transcript is
// matched against the daf with live-matcher.js, a port of the batch voice-sync
// pipeline's own deterministic matcher.
//
// Wrapped in a function: app.js and this script share one global scope.

(() => {
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
// Errors that a reconnect can't fix -- retrying would just loop.
const FATAL_ERROR_TYPES = new Set(['quota_exceeded', 'unaccepted_terms']);

const LM = window.LiveMatcher;
const LV = window.LiveVideo;

// Switches for trying the speech service's own settings on real audio, as
// URL parameters (/browse/?lang=he ...); recorded in the session log's first
// entry. Defaults are what real phone-microphone sessions favoured.
//   lang=he     Hebrew as the primary language, English as secondary.
//   filter=1    ElevenLabs' background-audio filter.
//   raw=0       Leave the browser's own voice processing (echo cancellation,
//               noise suppression, automatic gain) on. Off by default: it is
//               built for phone calls and can mangle speech a recognizer
//               would hear fine (realtime match ~85 with it off vs ~78 on).
//   keyterms=0  Send no bias list.
//   batch=0     No batch second opinion. By default each finished segment is
//               also sent to ElevenLabs' BATCH model (live-batch.mjs); when
//               the live model fails to place a phrase and the batch one can,
//               it rescues the position (batch scored ~92 vs ~78-85 for the
//               live model and rescued 5-7 segments a session).
const PAGE_PARAMS = new URLSearchParams(location.search);
const PAGE_OPTIONS = {
  lang: PAGE_PARAMS.get('lang'),
  filter: PAGE_PARAMS.get('filter') === '1',
  raw: PAGE_PARAMS.get('raw') !== '0',
  keyterms: PAGE_PARAMS.get('keyterms') !== '0',
  batch: PAGE_PARAMS.get('batch') !== '0',
  // ?stored=0 always transcribes a video link, even one with a saved sync (to compare the two).
  stored: PAGE_PARAMS.get('stored') !== '0',
};
// A segment shorter than this isn't worth a round trip; a longer one than this
// is capped to its last stretch (the API and function limits are far higher).
const BATCH_MIN_SECONDS = 1;
const BATCH_MAX_SECONDS = 40;
// ...and is sent in consecutive parts no longer than this: a 20-35 second chunk
// of mixed English and Hebrew came back empty or invented (the batch model
// loses the Hebrew inside long stretches of English, and takes 10-30s a call).
const BATCH_PART_SECONDS = 12;
// Audio quieter than this (RMS, 0..1) is the room or a side conversation, not
// the shiur; the batch model hallucinates fluent Hebrew out of it.
const BATCH_MIN_RMS = LM.QUIET_RMS;
// A segment the live model heard as a plain English sentence this long has no
// Hebrew to rescue. (Shorter ones are the live model mishearing Hebrew as
// English -- "And it's time, mate." was "אדרבה. תא שמע" -- so they still go.)
const BATCH_ENGLISH_SKIP_WORDS = 5;
// When all the slots are busy, Hebrew-bearing segments wait (a few of them, and
// not for long: a stale rescue is refused anyway) instead of being dropped.
const BATCH_QUEUE_MAX = 3;
const BATCH_QUEUE_MAX_AGE_MS = 20000;
// Searching this long with no position suggests tapping the word being read.
const SEARCH_TAP_HINT_SECONDS = 60;
// The batch audio starts a little before the previous commit: a commit arrives
// about a second after the speech it covers ends (silence threshold plus
// service latency), so the next utterance's first words may already be in the
// audio that was sent by then.
const BATCH_OVERLAP_SECONDS = 1.2;
const AUDIO_KEEP_SECONDS = 90;
const BATCH_MAX_IN_FLIGHT = 3;
const AUDIO_LOG_INTERVAL_MS = 10000;

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


// ---- Session state ------------------------------------------------------
const live = {
  on: false, // live follow mode (the panel is open, the page is following live, not a recording)
  saved: null, // what the page was showing before, restored when the mode is turned off
  pickerSnapshot: null,
  navLabelText: '',
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
  // The daf being followed (see loadLiveDaf) and the matcher's state over it.
  daf: null, // { key, label, refs, canon, segmentIndexByRef, ... }
  tracker: null,
  preview: null,
  runCounter: 0,
  confirmed: null, // { s, e } the words highlighted as the reading's place
  provisional: null, // { s, e } lighter highlight from a partial transcript
  partialTimer: null,
  latestPartial: '',
  lastPreview: null,
  // Where the reader pointed (a canon word index), until the next Start
  // consumes it; and the marker drawn for it, until the first phrase is
  // actually placed from it.
  anchorIndex: null,
  anchorMark: null,
  unplacedHebrew: 0, // consecutive commits with Hebrew in them that placed nothing
  // The audio that was sent (16kHz Int16, kept AUDIO_KEEP_SECONDS), so a
  // finished segment can be re-transcribed; and what the batch side needs to
  // know about the commits around it.
  audioChunks: [], // { start, data } with start an absolute sample index
  sentSamples: 0,
  lastCommitSample: 0,
  placementSeq: 0, // bumped whenever the highlight is placed or the reader taps
  commitSeq: 0,
  batchInFlight: 0,
  batchQueue: [], // segments waiting for a free batch slot
  searchingSince: null, // performance.now() when "Searching…" began, until a place is found
  followOptions: null, // what setFollowState was last given
  levelStats: null,
  levelTimer: null,
  followState: null, // what setFollowState last showed
  // In "Video transcript" mode, the session following the page's video:
  // { job, video, segments, timeline, timer, lastKey, listTokens }.
  videoFollow: null,
  videoPollMs: 3000,
  log: [],
  logStart: 0,
};
const LOG_MAX_ENTRIES = 400;

// ---- Panel ----------------------------------------------------------------
function setStatus(kind, text, detail) {
  const dot = $('lfStatusDot');
  const label = $('lfStatusText');
  const detailEl = $('lfStatusDetail');
  if (dot) dot.className = `lf-dot${kind ? ' ' + kind : ''}`;
  if (label) label.textContent = text;
  if (detailEl) detailEl.textContent = detail || '';
}
const statusText = () => $('lfStatusText')?.textContent || '';

function setMicLevel(level) {
  const fill = $('lfMeterFill');
  if (fill) fill.style.width = `${Math.min(100, Math.max(0, level * 100))}%`;
}

function setDebug(field, value) {
  const el = $(`lfDebug${field}`);
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

// ---- The daf -----------------------------------------------------------------
// The picker's daf and the amud after it (a shiur that runs past the end of
// the amud keeps being followed instead of going quiet at the page break),
// as the page's own paragraphs: fetchSefariaParagraphs is what the page loads
// a daf's text with, so the words here are indexed exactly as its word
// positions (page maps) and its highlights index them -- paragraph ref
// "Chullin 91a.3", word index within it.
async function loadLiveDaf(ref) {
  const parsed = parseDafRef(ref);
  if (!parsed) throw new Error('Choose a daf first.');
  const first = realDafRef(ref);
  // The amud before and the amud after the one chosen come with it: a shiur
  // may begin from the end of the previous daf (as a regular alignment's
  // context does), or run on into the next. The one before is left out where
  // there is none (the start of a tractate) or Sefaria has nothing for it.
  const wanted = [prevDafRef(first), first, nextDafRef(first)].filter(Boolean).map(realDafRef);
  const key = wanted.join('|');
  if (live.daf?.key === key) { showLiveSegments(); return live.daf; }
  const settled = await Promise.allSettled(wanted.map((wantedRef) => fetchSefariaParagraphs(wantedRef)));
  const chosen = wanted.indexOf(first);
  if (settled[chosen].status !== 'fulfilled') throw settled[chosen].reason;
  const refs = wanted.filter((_, i) => settled[i].status === 'fulfilled');
  const paragraphs = settled.flatMap((result) => (result.status === 'fulfilled' ? result.value.paragraphs : []));
  const canon = LM.buildCanon(paragraphs.map((p) => ({ ref: p.ref, he: p.he })));
  const keyterms = LM.buildRealtimeKeyterms(canon);
  // The batch model takes far more terms (the same 400 voice_align.py uses).
  const batchKeyterms = LM.buildKeytermList(canon, 400);
  const segmentIndexByRef = new Map(paragraphs.map((p, i) => [p.ref, i]));
  const canonIndex = new Map(canon.words.map((w, i) => [`${w.ref}#${w.wordIndex}`, i]));
  const firstCanonOfSegment = new Map();
  canon.words.forEach((w, i) => { if (!firstCanonOfSegment.has(w.segIndex)) firstCanonOfSegment.set(w.segIndex, i); });
  live.daf = {
    key, label: first, refs, paragraphs, canon, keyterms, batchKeyterms, segmentIndexByRef, canonIndex, firstCanonOfSegment,
    tokenCounts: paragraphs.map((p) => LM.segmentTokens(p.he).length),
    keytermTokens: LM.keytermTokens(keyterms), batchKeytermTokens: LM.keytermTokens(batchKeyterms),
  };
  live.confirmed = null;
  live.provisional = null;
  live.anchorMark = null;
  showLiveSegments();
  return live.daf;
}

// The daf's paragraphs become the page's segments, so every view that follows
// the active segment has the daf to follow. No recording is involved: the
// times are zero and w0/w1 start as the whole paragraph.
function showLiveSegments() {
  const daf = live.daf;
  state.segments = daf.paragraphs.map((p, i) => ({
    id: `live-${i + 1}`, ref: p.ref, start: 0, end: 0, he: p.he, en: p.en, w0: 0, w1: daf.tokenCounts[i] - 1,
  }));
  state.wordTimeline = [];
  state.dafRef = daf.label;
  $('lfDafName').textContent = daf.label;
  state.liveFollow.activeIndex = -1;
  state.activeIndex = -1;
  state.vilnaOverlayKey = '';
  $('dafTitle').textContent = daf.label;
  showPageFor(daf.label);
  renderDaf({ forceActiveSegment: true });
  drawProvisional();
  drawAnchor();
}

// Shows the printed page of an amud ("Chullin 91a"), keeping the picker on it.
function showPageFor(pageRef) {
  if (state.browseMode && state.browsePageRef !== pageRef) {
    state.browsePageRef = pageRef;
    $('dafTitle').textContent = pageRef;
    syncDafPickerFromRef(pageRef);
    renderVilnaPage();
  }
}

// ---- Highlighting (through the page's own active segment) -------------------------------
// The canon range s..e -> the paragraph it starts in, with w0/w1 narrowed to
// those words (clipped at the paragraph's end if the range runs on into the
// next). The page redraws everything it draws for the active segment.
function placeOnPage(range) {
  const daf = live.daf;
  const word = daf.canon.words[range.s];
  const last = daf.canon.words[range.e];
  const index = daf.segmentIndexByRef.get(word.ref);
  if (index === undefined) return;
  resetActiveRange();
  const segment = state.segments[index];
  segment.w0 = word.wordIndex;
  segment.w1 = last.ref === word.ref ? last.wordIndex : daf.tokenCounts[index] - 1;
  const parsed = parseDafRef(word.ref);
  if (parsed) showPageFor(`${parsed.tractate} ${parsed.daf}${parsed.amud}`);
  state.liveFollow.activeIndex = index;
  state.vilnaOverlayKey = ''; // the same paragraph with other words must redraw
  updateActiveSegment(true);
  scrollPageToActive();
}

// A paragraph that was the active one goes back to being whole.
function resetActiveRange() {
  const segment = state.segments[state.liveFollow?.activeIndex];
  if (segment) { segment.w0 = 0; segment.w1 = live.daf.tokenCounts[state.liveFollow.activeIndex] - 1; }
}

// Nothing highlighted as the place (a tapped word is shown instead, or nothing yet).
function clearPlacement() {
  if (!state.liveFollow || state.liveFollow.activeIndex === -1) return;
  resetActiveRange();
  state.liveFollow.activeIndex = -1;
  state.activeIndex = -1;
  state.vilnaOverlayKey = 'cleared-by-live-follow'; // anything but '', or the overlay thinks it is already empty
  renderDafWindow();
  updateActiveWords(0);
}

// The printed page never scrolled to the highlight in normal use (it follows
// a video only in Reading mode); here the reading moves on its own, so keep it
// in view -- unless the reader has just scrolled it somewhere themselves.
function scrollPageToActive() {
  if ($('vilnaPlaceholder')?.hidden) return;
  if (Date.now() - state.lastManualScrollAt < AUTO_SCROLL_RESUME_MS) return;
  const bar = $('vilnaActiveOverlay')?.firstElementChild;
  if (!bar) return;
  const rect = bar.getBoundingClientRect();
  const box = ($('dafScroll') || document.documentElement).getBoundingClientRect();
  const top = Math.max(box.top, 0);
  const bottom = Math.min(box.bottom, innerHeight);
  if (rect.top >= top + (bottom - top) * 0.12 && rect.bottom <= bottom - (bottom - top) * 0.2) return; // comfortably in view
  bar.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

// "Just heard" (a partial transcript, not yet confirmed) and "start here"
// (a tapped word) are Live follow's own marks, drawn over the printed page with
// the page's own geometry, in the page's own blue.
function boxesForRange(range) {
  const map = state.vilnaPageMap;
  if (!range || !map || !live.daf) return { map, boxes: [] };
  const order = new Map();
  for (let i = range.s; i <= range.e; i += 1) {
    const w = live.daf.canon.words[i];
    if (w) order.set(`${w.ref}#${w.wordIndex}`, i);
  }
  const boxes = map.wordBoxes
    .filter((b) => order.has(`${b.ref}#${b.wordIndex}`))
    .sort((a, b) => order.get(`${a.ref}#${a.wordIndex}`) - order.get(`${b.ref}#${b.wordIndex}`));
  return { map, boxes };
}

// What app.js asks for when it draws the active highlight (activeSegmentWordBoxes):
// the words being read, even where they run on from one paragraph into the next.
function activeWordBoxes() {
  if (!live.confirmed || !live.daf) return [];
  return boxesForRange(live.confirmed).boxes;
}

function drawMark(overlayId, range, className) {
  const overlay = $(overlayId);
  if (!overlay) return;
  overlay.textContent = '';
  const { map, boxes } = boxesForRange(range);
  if (!boxes.length) return;
  appendLineRects(overlay, groupBoxesIntoLineRects(boxes, map, vilnaInkBands(map)), className);
}
const drawProvisional = () => drawMark('vilnaLiveProvisionalOverlay', live.provisional, 'vilna-live-provisional-rect');
const drawAnchor = () => drawMark('vilnaLiveAnchorOverlay', live.anchorMark === null ? null : { s: live.anchorMark, e: live.anchorMark }, 'vilna-live-anchor-rect');
// The page's word positions arrive after the page itself, and a zoom redraws the bars.
window.addEventListener('dafsync:vilna-page', () => { if (live.on) { drawProvisional(); drawAnchor(); } updatePageBanner(); });

// The printed page can only be highlighted once its word positions exist. For a
// page with none yet (the on-demand job that makes them is running, or could not
// run) say so on the page, rather than leave a highlight that never comes; the
// text view follows regardless.
function updatePageBanner() {
  const banner = $('lfPageBanner');
  if (!banner) return;
  const info = state.vilnaPageMapStatus;
  const onPageView = document.querySelector('.daf-card')?.getAttribute('data-daf-view') === 'page';
  const waiting = info && (info.status === 'preparing' || info.status === 'unavailable');
  if (!live.on || !onPageView || !waiting || info.ref !== state.browsePageRef) {
    banner.hidden = true;
    return;
  }
  banner.classList.toggle('is-unavailable', info.status === 'unavailable');
  banner.textContent = info.status === 'preparing'
    ? `The printed page for ${info.ref} is still being prepared (usually a minute or two). It will be highlighted as soon as it is ready; the text view follows now.`
    : `The printed page for ${info.ref} has no word positions yet, so it can’t be highlighted. The text view follows along; reload the page to try again.`;
  banner.hidden = false;
}
// Switching between the text and the printed page changes whether it matters.
const dafCardForBanner = document.querySelector('.daf-card');
if (dafCardForBanner) new MutationObserver(updatePageBanner).observe(dafCardForBanner, { attributes: true, attributeFilter: ['data-daf-view'] });

function showConfirmed(match) {
  live.placementSeq += 1;
  setProvisional(null);
  clearAnchorMark();
  live.confirmed = { s: match.s, e: match.e };
  document.body.classList.remove('lf-quiet');
  placeOnPage(live.confirmed);
  const words = live.daf.canon.words.slice(match.s, match.e + 1);
  setDebug('Match', words.map((w) => w.text).join(' '));
  setDebug('Confidence', `phonetic ${match.phonScore.toFixed(1)} / character ${match.charScore.toFixed(1)} · words ${match.s}–${match.e} (${match.source})`);
}

function setProvisional(match) {
  live.provisional = match ? { s: match.s, e: match.e } : null;
  drawProvisional();
}

// ---- Pointing at the daf ----------------------------------------------------
// Working out where the reading is takes a few utterances (and is the
// weakest part of a cold start); the person following along can see the daf
// and hear the room. Tapping a word sets the position outright -- before
// Start, so the very first phrase places immediately, or at any point
// mid-session, to put right an alignment that has drifted. The automatic
// search stays as the fallback when nothing is tapped, and as the safety net
// when the reading moves on from a tapped word.
function anchorDetail(index) {
  const words = live.daf.canon.words.slice(index, index + 4).map((w) => w.text).join(' ');
  return `From “${words}…” — tap another word to correct`;
}

function clearAnchorMark() {
  live.anchorMark = null;
  drawAnchor();
}

function setAnchor(index) {
  if (!live.daf || !live.daf.canon.words[index]) return;
  live.placementSeq += 1;
  clearAnchorMark();
  live.anchorMark = index;
  live.confirmed = null;
  setProvisional(null);
  live.lastPreview = null;
  clearPlacement();
  document.body.classList.remove('lf-quiet');
  // The page the word is on, and the word in view.
  const parsed = parseDafRef(live.daf.canon.words[index].ref);
  if (parsed) showPageFor(`${parsed.tractate} ${parsed.daf}${parsed.amud}`);
  drawAnchor();
  setDebug('Match', live.daf.canon.words.slice(index, index + 5).map((w) => w.text).join(' '));
  setDebug('Confidence', 'Position set by you');
  if (live.videoFollow?.timeline) {
    realignVideoFrom(index);
  } else if (live.tracker) {
    // Mid-session: take it as the position now. The next phrase heard is
    // matched around it.
    live.tracker.anchor(index);
    live.preview.reset();
    live.unplacedHebrew = 0;
    live.anchorIndex = null;
    setFollowState('reading', { detail: anchorDetail(index) });
    setDebug('Pending', '—');
    updateSearchWindowDebug();
  } else {
    live.anchorIndex = index;
    // (While a video transcript is still being made the status is about
    // that; the word is simply used when it arrives.)
    if (!live.videoFollow) setStatus('', 'Ready', `${anchorDetail(index).replace(' — tap another word to correct', '')} — tap Start to listen.`);
  }
  logEvent('anchor', { index, word: live.daf.canon.words[index].text, midSession: Boolean(live.tracker || live.videoFollow) });
  scrollAnchorIntoView();
}

function scrollAnchorIntoView() {
  const mark = $('vilnaLiveAnchorOverlay')?.firstElementChild;
  if (!mark || $('vilnaPlaceholder')?.hidden) return;
  const rect = mark.getBoundingClientRect();
  if (rect.top < 0 || rect.bottom > innerHeight) mark.scrollIntoView({ block: 'center', behavior: 'smooth' });
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
//                explanation. Doesn't quiet the daf, and after a few in a row
//                says what to do about it (tap the word).
//   searching -- no position yet; nothing locked, nothing pointed at.
function setFollowState(followState, options = {}) {
  live.followState = followState;
  live.followOptions = options;
  document.body.classList.toggle('lf-quiet', followState === 'explaining' || followState === 'searching');
  if (followState !== 'searching') live.searchingSince = null;
  else if (live.searchingSince === null) live.searchingSince = performance.now();
  const searchingFor = live.searchingSince === null ? 0 : (performance.now() - live.searchingSince) / 1000;
  // Nothing placed for a while is something the reader can fix: they can see
  // the page and hear the room. Said after a few Hebrew commits that placed
  // nothing, or after a minute without a position however much English there was.
  const tapHint = live.unplacedHebrew >= 3
    ? ' Not finding your place — tap the word being read to set it.'
    : searchingFor >= SEARCH_TAP_HINT_SECONDS
      ? ' No position yet — if you can see where the reading is, tap that word to set it.'
      : '';
  if (followState === 'reading') {
    setStatus('reading', 'Following', options.detail || `Following ${live.daf.label}`);
  } else if (followState === 'explaining') {
    setStatus('explaining', 'Explaining', 'No Hebrew heard — holding the last phrase until the reading resumes');
  } else if (followState === 'listening') {
    setStatus('explaining', 'Listening…', (options.pending
      ? 'Found a possible new spot — waiting for the next phrase to confirm it.'
      : 'Heard Hebrew but couldn’t place it on the daf yet.') + tapHint);
  } else {
    setStatus('searching', 'Searching…', (options.pending
      ? 'Found a possible spot — waiting for the next phrase to confirm it.'
      : options.english
        ? `Hearing explanation in English — waiting for the Hebrew reading from ${live.daf.label}.`
        : `Listening for a phrase from ${live.daf.label}.`) + tapHint);
  }
}

// ---- Batch second opinion (on by default; ?batch=0 turns it off) ----------------------------------
// How a transcript would fare on the daf, from a given cursor: for each Hebrew
// run, where it matches locally and how well. Pure -- it moves nothing -- so
// the realtime and batch transcripts of the same segment can be compared like
// for like.
// Searched the way the tracker would: around the cursor when it is locked and
// then, failing that (the reading jumped back, or on past the local window),
// across the whole daf -- which is also all there is when it isn't locked yet.
// `far` marks a whole-daf match found with a lock in place.
function scoreText(text, cursor, locked, listTokens, leakMinRun) {
  const heard = LM.cleanTranscript(text, listTokens, leakMinRun);
  return LM.placeableRuns(heard).runs
    .map((run) => {
      const norms = run.map((w) => w.norm);
      const phons = run.map((w) => w.phon);
      let m = locked ? LM.matchPhraseDual(live.daf.canon, norms, phons, cursor) : null;
      let far = false;
      if (!m) {
        m = LM.matchGlobalWithMargin(live.daf.canon, norms, phons);
        far = Boolean(locked && m);
      }
      return m
        ? { words: run.length, s: m.s, e: m.e, phon: +m.phonScore.toFixed(1), char: +m.charScore.toFixed(1), ...(far ? { far: true } : {}) }
        : { words: run.length, miss: true };
    });
}

// The terms the batch model is told to expect. Once there is a position (or a
// last known one), the words just before and well ahead of it come first, then
// the whole-daf list; before that, the whole-daf list alone.
function batchKeytermsAt(cursor, positioned) {
  if (!PAGE_OPTIONS.keyterms) return [];
  return positioned
    ? LM.buildLocalKeyterms(live.daf.canon, cursor, live.daf.batchKeyterms)
    : live.daf.batchKeyterms;
}

async function fetchBatchTranscript(audio, { keyterms, hebrew }) {
  const response = await fetch('/api/live-batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      audioBase64: arrayBufferToBase64(audio.buffer),
      keyterms,
      // Told it is Hebrew only when the live model heard mostly Hebrew: left to
      // itself it called stretches Dutch and Yiddish, and told so about English
      // it writes the English out in Hebrew letters, which then match the daf.
      language: hebrew || PAGE_OPTIONS.lang === 'he' ? 'he' : undefined,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

// One finished segment, re-transcribed by the batch model a moment after the
// realtime model committed it. Always logs both side by side. If the realtime
// text placed nothing and the batch text does -- and nothing has moved the
// highlight since, so this can't drag it backwards over newer progress -- the
// batch placement is applied: a rescue a second or two late rather than a
// freeze.
//
// Which segments go at all, and when there is no free slot: see submitBatch.
async function runBatchSegment({ seq, part, parts, audio, rtText, cursorBefore, lockedBefore, rtPlaced, placementSeq, hebrew }) {
  live.batchInFlight += 1;
  const started = performance.now();
  const keyterms = batchKeytermsAt(cursorBefore, lockedBefore || cursorBefore > 0);
  let result = null;
  let error = null;
  try {
    result = await fetchBatchTranscript(audio, { keyterms, hebrew });
  } catch (e) {
    error = e.message;
  } finally {
    live.batchInFlight -= 1;
    drainBatchQueue();
  }
  const ms = Math.round(performance.now() - started);
  if (error) {
    logEvent('batch', { seq, ms, error });
    setDebug('Batch', `error: ${error}`);
    return;
  }
  // What was actually sent is what a recitation of the list would repeat.
  const batchTokens = PAGE_OPTIONS.keyterms ? LM.keytermTokens(keyterms) : [];
  const entry = {
    seq, ...(parts > 1 ? { part, parts } : {}), ...(hebrew ? { hint: 'he' } : {}), ms, seconds: +(audio.length / TARGET_SAMPLE_RATE).toFixed(1), text: result.text, lang: result.languageCode,
    realtime: scoreText(rtText, cursorBefore, lockedBefore, activeKeytermTokens()),
    batch: scoreText(result.text, cursorBefore, lockedBefore, batchTokens, LM.LEAK_MIN_RUN_BATCH),
  };
  let rescued = null;
  if (!rtPlaced && live.tracker && !live.manualStop && live.placementSeq === placementSeq && result.text) {
    const { runs } = LM.placeableRuns(LM.cleanTranscript(result.text, batchTokens, LM.LEAK_MIN_RUN_BATCH));
    let placed = null;
    for (const run of runs) {
      // The realtime commit of this same speech already counted its miss toward
      // losing the lock; the batch re-reading of it must not count it again.
      const step = live.tracker.step(run, live.runCounter, { missWeight: 0 });
      live.runCounter += 1;
      if (step.kind === 'local' || step.kind === 'confirmed' || step.kind === 'jump') placed = step.match;
    }
    if (placed) {
      live.preview.reset();
      showConfirmed({ ...placed, source: 'batch-rescue' });
      live.unplacedHebrew = 0;
      setFollowState('reading');
      rescued = { s: placed.s, e: placed.e };
    }
  }
  entry.rescued = rescued;
  logEvent('batch', entry);
  setDebug('Batch', `${result.text || '—'}${rescued ? '   ✓ placed it when the live model could not' : ''}`);
}

// RMS (0..1) of 16-bit audio.
function audioRms(samples) {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length) / 32768;
}

// Why a segment is not worth a batch call, or null. The slots are few and each
// call takes seconds, so they go to segments that could still place something.
function batchSkipReason(text, rms) {
  if (typeof rms === 'number' && rms < BATCH_MIN_RMS) return 'quiet';
  const hasHebrew = /[א-ת]/.test(text);
  const words = text.split(/\s+/).filter(Boolean).length;
  if (!hasHebrew && words >= BATCH_ENGLISH_SKIP_WORDS) return 'english';
  return null;
}

// A segment, cut into consecutive parts of at most BATCH_PART_SECONDS, goes to
// the batch model (or waits for a slot). Only the first part carries the live
// transcript for the side-by-side log.
function submitBatchSegment(job) {
  const perPart = BATCH_PART_SECONDS * TARGET_SAMPLE_RATE;
  const parts = Math.max(1, Math.ceil(job.audio.length / perPart));
  const size = Math.ceil(job.audio.length / parts);
  for (let part = 0; part < parts; part += 1) {
    submitBatchPart({
      ...job,
      part: part + 1,
      parts,
      audio: parts === 1 ? job.audio : job.audio.slice(part * size, (part + 1) * size),
      rtText: part === 0 ? job.rtText : '',
    });
  }
}

function submitBatchPart(job) {
  if (live.batchInFlight < BATCH_MAX_IN_FLIGHT) {
    runBatchSegment(job);
    return;
  }
  // Busy: wait for a slot if there is Hebrew in it, else it is not worth waiting for.
  if (!/[א-ת]/.test(job.rtText) && job.parts === 1) {
    logEvent('batch', { seq: job.seq, skipped: 'busy' });
    return;
  }
  live.batchQueue.push({ ...job, queuedAt: performance.now() });
  while (live.batchQueue.length > BATCH_QUEUE_MAX) {
    logEvent('batch', { seq: live.batchQueue.shift().seq, skipped: 'busy' });
  }
}

function drainBatchQueue() {
  while (live.batchQueue.length && live.batchInFlight < BATCH_MAX_IN_FLIGHT && !live.manualStop) {
    const job = live.batchQueue.shift();
    if (performance.now() - job.queuedAt > BATCH_QUEUE_MAX_AGE_MS) {
      logEvent('batch', { seq: job.seq, skipped: 'stale' });
      continue;
    }
    runBatchSegment(job);
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
    live.lastCommitSample = live.sentSamples;
    logEvent('commit', { text: '', silent: true, outcomes: [], state: statusText() });
    return;
  }
  setProvisional(null);
  live.preview.reset(); // the preview's own position hands back to the confirmed one
  // The service sometimes recites its keyterm list, or sticks on one word, when
  // the audio goes quiet; neither is speech (see cleanTranscript).
  const heard = LM.cleanTranscript(text, activeKeytermTokens());
  const cursorBefore = live.tracker.cursor;
  const lockedBefore = live.tracker.locked;
  // The audio this commit covers (a little of the one before it too, see
  // BATCH_OVERLAP_SECONDS): how loud it was says whether it was the shiur.
  const end = live.sentSamples;
  const start = Math.max(live.lastCommitSample - Math.round(BATCH_OVERLAP_SECONDS * TARGET_SAMPLE_RATE), end - BATCH_MAX_SECONDS * TARGET_SAMPLE_RATE, 0);
  live.lastCommitSample = end;
  const audio = segmentAudio(start, end);
  const rms = audio.length ? audioRms(audio) : undefined; // no audio recorded: level unknown
  const { allRuns, runs } = LM.placeableRuns(heard);
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
    // A failed match counts less toward losing the lock when the audio is quiet
    // or the words have little to do with the daf (a side conversation).
    const missWeight = LM.missWeightFor(live.daf.canon, run, rms);
    const result = live.tracker.step(run, live.runCounter, { missWeight });
    live.runCounter += 1;
    const m = result.match;
    outcomes.push({ words: run.length, kind: result.kind, ...(missWeight < 1 ? { missWeight } : {}), ...(m ? { s: m.s, e: m.e, phon: +m.phonScore.toFixed(1), char: +m.charScore.toFixed(1), margin: m.margin === undefined ? undefined : +m.margin.toFixed(1) } : {}) });
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
    setFollowState(live.tracker.locked ? 'explaining' : 'searching', { english: latinWords >= 2 });
  } else {
    live.unplacedHebrew += 1;
    setFollowState(live.tracker.locked ? 'listening' : 'searching', { pending: Boolean(pending) });
  }
  live.commitSeq += 1;
  const seq = live.commitSeq;
  if (PAGE_OPTIONS.batch && audio.length >= BATCH_MIN_SECONDS * TARGET_SAMPLE_RATE) {
    const skip = batchSkipReason(text, rms);
    if (skip) {
      logEvent('batch', { seq, skipped: skip });
    } else {
      const hebrew = /[א-ת]/.test(text) && !LM.englishDominant(text);
      submitBatchSegment({ seq, audio, rtText: text, cursorBefore, lockedBefore, rtPlaced: Boolean(placed), placementSeq: live.placementSeq, hebrew });
    }
  }
  logEvent('commit', { seq, text, ...(heard !== text ? { cleaned: heard } : {}), outcomes, state: statusText(), locked: live.tracker.locked, cursor: live.tracker.cursor });
}

// A partial transcript is still being revised, so it never moves the
// tracker -- the preview (see createPreview in live-matcher.js) only shows where the latest few
// words sit, in a lighter highlight, and follows the reading with a cursor of
// its own so it keeps pace through a long reading with no commit in sight.
function runProvisional() {
  live.partialTimer = null;
  if (!live.preview) return;
  const partial = LM.cleanTranscript(live.latestPartial, activeKeytermTokens());
  const runs = LM.splitHebrewRuns(partial);
  const last = runs[runs.length - 1];
  if (!last) return;
  // A few Hebrew words in the middle of English are a term, not the reading.
  if (LM.englishDominant(partial) && last.length < LM.ENGLISH_CONTEXT_MIN_RUN_WORDS) return;
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

// The bias list actually in use (none with ?keyterms=0), and the tokens
// cleanTranscript watches for a recitation of it.
function activeKeyterms() { return PAGE_OPTIONS.keyterms ? live.daf.keyterms : []; }
function activeKeytermTokens() { return PAGE_OPTIONS.keyterms ? live.daf.keytermTokens : []; }

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
  const ws = new WebSocket(buildWsUrl(token, activeKeyterms()));
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
        setDebug('Connection', `session ${msg.session_id || ''} started (${activeKeyterms().length} keyterms)`);
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

function recordSentAudio(int16Buffer) {
  const data = new Int16Array(int16Buffer);
  live.audioChunks.push({ start: live.sentSamples, data });
  live.sentSamples += data.length;
  const keepFrom = live.sentSamples - AUDIO_KEEP_SECONDS * TARGET_SAMPLE_RATE;
  while (live.audioChunks.length && live.audioChunks[0].start + live.audioChunks[0].data.length <= keepFrom) live.audioChunks.shift();
}

// The audio sent between two absolute sample positions, as one Int16Array
// (clamped to what is still kept).
function segmentAudio(fromSample, toSample) {
  const first = live.audioChunks[0];
  const from = Math.max(fromSample, first ? first.start : 0);
  const to = Math.min(toSample, live.sentSamples);
  if (to <= from) return new Int16Array(0);
  const out = new Int16Array(to - from);
  for (const chunk of live.audioChunks) {
    const lo = Math.max(from, chunk.start);
    const hi = Math.min(to, chunk.start + chunk.data.length);
    if (hi > lo) out.set(chunk.data.subarray(lo - chunk.start, hi - chunk.start), lo - from);
  }
  return out;
}

function sendAudioChunk(int16Buffer) {
  const ws = live.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (PAGE_OPTIONS.batch) recordSentAudio(int16Buffer);
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
  const stats = live.levelStats;
  if (stats) {
    for (let i = 0; i < float32AtNativeRate.length; i += 1) {
      const v = Math.abs(float32AtNativeRate[i]);
      stats.sumSq += v * v;
      if (v > stats.peak) stats.peak = v;
      if (v >= 0.99) stats.clipped += 1;
    }
    stats.n += float32AtNativeRate.length;
  }
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

// The sound to follow: this device's microphone, or -- "Tab audio" -- the
// sound of a browser tab, taken straight from the browser with none of the
// room echo a microphone hearing the speakers adds.
async function openInputStream(source) {
  if (source === 'tab') {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error('This browser can\u2019t share a tab\u2019s sound (phones can\u2019t) \u2014 use the microphone, or a video transcript, instead.');
    }
    const stream = await navigator.mediaDevices.getDisplayMedia({
      // Chrome only offers a tab's sound together with its picture. The
      // picture is wanted for nothing: one frame a second, and switched off.
      video: { frameRate: 1 },
      // Processing built for voice calls would mangle a recording; off.
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      preferCurrentTab: true,
      selfBrowserSurface: 'include',
      systemAudio: 'exclude',
    });
    stream.getVideoTracks().forEach((track) => { track.enabled = false; });
    if (!stream.getAudioTracks().length) {
      stream.getTracks().forEach((track) => track.stop());
      const error = new Error('No sound was shared. Choose the tab with the video and tick \u201cShare tab audio\u201d.');
      error.name = 'NoAudioShared';
      throw error;
    }
    stream.getAudioTracks()[0].addEventListener('ended', () => {
      if (live.manualStop || live.micStream !== stream) return;
      showToast('Tab sharing stopped.', 'error');
      stopLiveFollow();
    });
    return stream;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('This browser does not support microphone access (or the page was not loaded over HTTPS).');
  }
  const constraints = { channelCount: 1 };
  if (PAGE_OPTIONS.raw) Object.assign(constraints, { echoCancellation: false, noiseSuppression: false, autoGainControl: false });
  return navigator.mediaDevices.getUserMedia({ audio: constraints });
}

async function startMic(inputKind = 'microphone') {
  live.micStream = await openInputStream(inputKind);
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

  // What the browser actually gave us. "Loud and clear but not heard" can be
  // the recognizer, or the browser's voice processing, or a context that did
  // not run at 16kHz -- the log should say which of those apply.
  const settings = live.micStream.getAudioTracks?.()[0]?.getSettings?.() || {};
  logEvent('audio', {
    source: inputKind,
    contextRate: live.audioContext.sampleRate,
    contextState: live.audioContext.state,
    trackRate: settings.sampleRate ?? null,
    echoCancellation: settings.echoCancellation ?? null,
    noiseSuppression: settings.noiseSuppression ?? null,
    autoGainControl: settings.autoGainControl ?? null,
    channels: settings.channelCount ?? null,
  });
  live.levelStats = { n: 0, sumSq: 0, peak: 0, clipped: 0 };
  live.levelTimer = setInterval(() => {
    // The minute-without-a-position hint appears on its own, not on the next commit.
    if (live.followState === 'searching' && live.followOptions && !live.manualStop) setFollowState('searching', live.followOptions);
    const stats = live.levelStats;
    if (!stats || !stats.n) return;
    logEvent('level', {
      rms: +Math.sqrt(stats.sumSq / stats.n).toFixed(4),
      peak: +stats.peak.toFixed(3),
      clippedPct: +((stats.clipped / stats.n) * 100).toFixed(3),
    });
    live.levelStats = { n: 0, sumSq: 0, peak: 0, clipped: 0 };
  }, AUDIO_LOG_INTERVAL_MS);
}

function stopMic() {
  clearInterval(live.levelTimer);
  live.levelTimer = null;
  live.levelStats = null;
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


// ---- Video link / transcript mode ----------------------------------------------------
// The page already has a player for a video link (YouTube or a direct file).
// "Video transcript" follows THAT video: ElevenLabs transcribes the link once,
// server-side (live-video-job-background.mjs); the transcript, with its word
// times, is aligned to the daf ahead of time, and the highlight simply follows
// the player's clock -- no lag, and seeking works, at the cost of the wait for
// the transcript and of not being "live".
const PLAYHEAD_POLL_MS = 250;
// The highlight moves a little before the phrase's first word, not after it.
const PLAYHEAD_LEAD_SECONDS = 0.25;
const VIDEO_JOB_TIMEOUT_MS = 16 * 60 * 1000;
const VIDEO_START_RETRY_MS = 25000;
const VIDEO_JOB_PATH = '/.netlify/functions/live-video-job-background';

const selectedSource = () => document.querySelector('input[name="lfSource"]:checked')?.value || 'microphone';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const formatClock = (seconds) => {
  const t = Math.max(0, Math.floor(seconds));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};

function setVideoMessage(text, isError = false) {
  const el = $('lfVideoMessage');
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('error', Boolean(isError));
}

// What the chosen way of following does, and the link box for the one that needs a video.
const SOURCE_NOTES = {
  microphone: 'Hears the shiur in the room, or a video through the speakers. Works on any phone or laptop.',
  tab: 'Takes the sound straight from a browser tab, with no echo. Desktop Chrome / Edge only.',
  transcript: 'Transcribes a video link once (a minute or two), then follows the video’s own clock — seeking works.',
};
function updateSourceUi() {
  const source = selectedSource();
  const tabMissing = source === 'tab' && !navigator.mediaDevices?.getDisplayMedia;
  const note = $('lfSourceNote');
  if (note) note.textContent = tabMissing ? 'Not available in this browser — phones can’t share tab audio.' : SOURCE_NOTES[source];
  if ($('lfVideoRow')) $('lfVideoRow').hidden = source !== 'transcript';
}

// The video the page has loaded, if it is one a transcript can be made from
// (a link: not a file on this device).
function pageVideo() {
  const source = state.videoSource;
  if (!source?.url || !['youtube', 'direct'].includes(source.type)) return null;
  const parsed = LV.parseVideoLink(source.url);
  return parsed ? { kind: parsed.kind, id: parsed.id || null, url: parsed.url, getTime: () => getCurrentTime() } : null;
}

// Why a Google Drive file would not play: the server asks Drive for the start of
// the file and says what came back (see live-video-probe.mjs).
async function explainDriveFailure(url) {
  let result = null;
  try {
    const response = await fetch(`/api/live-video-probe?url=${encodeURIComponent(url)}`);
    if (response.ok) result = await response.json();
  } catch { /* falls through to the general message */ }
  const mb = result?.size ? `${Math.max(1, Math.round(result.size / 1048576))} MB` : null;
  switch (result?.outcome) {
    case 'file':
      return `Google Drive is serving this file${result.contentType ? ` (${result.contentType}${mb ? `, ${mb}` : ''})` : ''}, but this browser would not play it. It may be a format browsers cannot play (for example .wma, or an unusual codec) — an .mp3 or .m4a is safest.`;
    case 'too-big':
      return `Google Drive will not hand this file${mb ? ` (${mb})` : ''} straight to a player: it answers with a virus-scan page instead. Try a smaller copy, or a link to the file somewhere other than Drive.`;
    case 'private':
      return 'Google Drive is asking for a sign-in, so it is not open to “anyone with the link” as far as Drive is concerned. (A file in a work or school account, or one whose sharing was set on its folder only, can be limited even when it looks shared — try “Share → General access → Anyone with the link”.)';
    case 'quota':
      return 'Google Drive has paused downloads of this file for now (too many people have opened it recently). Try again later, or use a copy of the file.';
    case 'missing':
      return 'Google Drive cannot find that file. Check the link.';
    case 'unreachable':
      return 'Could not reach Google Drive just now. Try again in a moment.';
    default:
      return 'Google Drive would not play this file. It needs to be shared with “anyone with the link”, and Drive will not hand a very large file straight to a player — try a smaller file, or a link to it somewhere else.';
  }
}

// Puts a link in the page's own player. Not the page's loaders: those also
// save the link as this daf's video for everyone, which a live-follow link
// must never do.
async function loadLiveVideo() {
  const parsed = LV.parseVideoLink($('lfVideoInput').value);
  if (!parsed) {
    setVideoMessage('That isn’t a link I can use. Paste a YouTube link, a Google Drive link to an audio or video file (shared with “anyone with the link”), or a direct https link to a file (.mp3, .m4a, .mp4, .webm …).', true);
    return false;
  }
  if (live.videoFollow) stopLiveFollow();
  const button = $('lfVideoLoadButton');
  button.disabled = true;
  setVideoMessage('Loading the video…');
  try {
    cleanupObjectUrl();
    if (parsed.kind === 'youtube') {
      await ensureYouTubePlayer(parsed.id);
      state.videoSource = { type: 'youtube', videoId: parsed.id, url: parsed.url, label: 'YouTube', locked: false };
      $('lectureTitle').textContent = `YouTube video · ${parsed.id}`;
      setSourceBadge('YouTube');
    } else {
      switchPlayerType('html5');
      state.videoSource = { type: 'direct', url: parsed.url, label: parsed.source === 'drive' ? 'Google Drive' : 'Direct link', locked: false };
      htmlVideo.src = parsed.url;
      htmlVideo.load();
      // Say so if the file cannot be played here -- and, for Drive, ask Drive why.
      htmlVideo.addEventListener('error', async () => {
        if (parsed.source !== 'drive') return setVideoMessage('This browser could not play that file (check the link).', true);
        setVideoMessage('This file would not play. Asking Google Drive why…');
        setVideoMessage(await explainDriveFailure(parsed.url), true);
      }, { once: true });
      setPlaybackRate(Number($('speedSelect').value));
      $('lectureTitle').textContent = titleFromUrl(parsed.url);
      setSourceBadge(parsed.source === 'drive' ? 'Google Drive' : 'Direct link');
      $('largePlay').hidden = false;
      showVideoControls();
    }
    state.currentProjectId = null;
    seek(parsed.startSeconds || 0);
  } catch (error) {
    console.error('Could not load the video for live follow:', error);
    setVideoMessage(error.message || 'Could not load that video.', true);
    return false;
  } finally {
    button.disabled = false;
  }
  setVideoMessage('Video loaded. Tap Start to follow it from its transcript.');
  // A pasted link is most naturally followed from its own transcript.
  document.querySelector('input[name="lfSource"][value="transcript"]').checked = true;
  updateSourceUi();
  return true;
}

async function fetchVideoTranscript(video, job) {
  const params = new URLSearchParams({ url: video.url, daf: live.daf.label });
  if (PAGE_OPTIONS.keyterms) params.set('kt', '1');
  if (PAGE_OPTIONS.lang === 'he') params.set('lang', 'he');
  const readStatus = async () => {
    const response = await fetch(`/api/live-video-status?${params}`);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    return body;
  };
  const startJob = () => fetch(VIDEO_JOB_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: video.url,
      daf: live.daf.label,
      keyterms: PAGE_OPTIONS.keyterms ? live.daf.batchKeyterms : [],
      language: PAGE_OPTIONS.lang === 'he' ? 'he' : undefined,
    }),
  });
  const began = performance.now();
  let startedAt = null;
  let starts = 0;
  let status = await readStatus();
  for (;;) {
    if (job.cancelled) throw Object.assign(new Error('cancelled'), { cancelled: true });
    if (status.status === 'done') return status;
    const sinceStart = startedAt === null ? Infinity : performance.now() - startedAt;
    if (status.status === 'error' && sinceStart > 10000) {
      // A failure from before, or this attempt's own. Once only: the first
      // is retried (it may have been a hiccup), the second is reported.
      if (starts >= 1 && startedAt !== null) {
        throw new Error([status.error, status.detail].filter(Boolean).join(' '));
      }
    }
    if (status.status === 'absent' || (status.status === 'error' && starts === 0)) {
      if (sinceStart > VIDEO_START_RETRY_MS || startedAt === null) {
        if (starts >= 3) throw new Error('The transcript job would not start. Try again in a minute.');
        await startJob();
        starts += 1;
        startedAt = performance.now();
      }
    }
    const waited = Math.round((performance.now() - began) / 1000);
    if (performance.now() - began > VIDEO_JOB_TIMEOUT_MS) throw new Error('The transcript took too long. Try again, or use tab audio or the microphone.');
    setStatus('searching', 'Transcribing…', `Transcribing the video (${formatClock(waited)}) — usually a minute or two; a long shiur takes longer.`);
    await sleep(live.videoPollMs);
    if (job.cancelled) throw Object.assign(new Error('cancelled'), { cancelled: true });
    status = await readStatus();
  }
}


// A video the regular sync engine has already aligned has a saved sync
// (results/by-video/<id>.json, in four spellings: Hebrew / Chazarah prefixes; the
// voice-recognition engine's own are the fallback). Better than transcribing again:
// nothing to wait for or pay for, and it has had the engine's second pass.
const STORED_PREFIXES = [['', ''], ['Chazarah-Daf-', 'Chazarah'], ['Hebrew-', 'Hebrew'], ['Hebrew-Chazarah-Daf-', 'Hebrew Chazarah']];
// Used only when it is about THIS daf: enough of it must land on the words being followed.
const STORED_MIN_ENTRIES = 10;
const STORED_MIN_SHARE = 0.5;

async function fetchStoredAlignmentFile(key) {
  try {
    const response = await fetch(`/api/get-results-file?path=${encodeURIComponent(`by-video/${key}.json`)}`);
    if (!response.ok) return null;
    const data = await response.json();
    return Array.isArray(data?.wordTimeline) ? data : null;
  } catch {
    return null;
  }
}

// -> { key, label, timeline, mapped, total } or null.
async function findStoredTimeline(video) {
  if (!PAGE_OPTIONS.stored || video.kind !== 'youtube' || !video.id) return null;
  for (const voice of ['', 'Voice-']) {
    const found = await Promise.all(STORED_PREFIXES.map(async ([prefix, label]) => {
      // Another maggid's saved syncs are keyed behind their own prefix, after "Voice-".
      const key = `${voice}${maggidKeyPrefix(state.maggid)}${prefix}${video.id}`;
      return { key, label: `${voice ? 'voice ' : ''}${label}`.trim() || 'regular', data: await fetchStoredAlignmentFile(key) };
    }));
    for (const candidate of found) {
      if (!candidate.data) continue;
      const { timeline, mapped, total } = LV.timelineFromAlignment(candidate.data, live.daf.canonIndex);
      if (mapped >= STORED_MIN_ENTRIES && mapped / total >= STORED_MIN_SHARE) {
        return { key: candidate.key, label: candidate.label, timeline, mapped, total };
      }
      logEvent('stored-alignment-skipped', { key: candidate.key, mapped, total, covered: candidate.data.coveredRefs || null });
    }
  }
  return null;
}

async function startTranscriptFollow({ startIndex }) {
  const video = pageVideo();
  const job = { cancelled: false };
  live.videoFollow = { job, video, segments: [], timeline: null, timer: null, lastKey: null };
  const follow = live.videoFollow;
  const button = $('lfStartButton');
  button.disabled = false;
  button.textContent = 'Stop live follow';
  button.classList.add('stop');
  setStatus('searching', 'Checking…', 'Looking for a saved sync of this video.');
  const stored = await findStoredTimeline(video);
  if (live.videoFollow !== follow) return;
  if (stored) {
    follow.stored = stored;
    follow.timeline = stored.timeline;
    live.anchorIndex = null; // a saved sync is not re-placed from a tapped word
    logEvent('stored-alignment', {
      key: stored.key,
      mapped: stored.mapped,
      total: stored.total,
      // [start, firstWord, lastWord] -- enough to see where it goes without the whole sync.
      timeline: stored.timeline.map((e) => [Math.round(e.start), e.s, e.e]),
    });
    setDebug('Connection', `saved sync (${stored.label}) · ${stored.mapped}/${stored.total} entries on this daf`);
    follow.timer = setInterval(applyPlayhead, PLAYHEAD_POLL_MS);
    applyPlayhead();
    return;
  }
  setStatus('searching', 'Transcribing…', 'Sending the video to be transcribed — usually a minute or two.');
  setDebug('Connection', 'video transcript');
  const began = performance.now();
  let transcript;
  try {
    transcript = await fetchVideoTranscript(video, job);
  } catch (error) {
    if (error.cancelled || live.videoFollow !== follow) return;
    console.error('Could not get a transcript of the video:', error);
    stopLiveFollow();
    const message = `${error.message} — try Tab audio or the microphone instead.`;
    setStatus('error', 'Error', message);
    showToast(error.message, 'error');
    return;
  }
  if (live.videoFollow !== follow) return;
  const words = transcript.words.map(([text, start, end]) => ({ text, start, end }));
  follow.segments = LV.wordsToSegments(words);
  const listTokens = PAGE_OPTIONS.keyterms ? live.daf.batchKeytermTokens : [];
  follow.listTokens = listTokens;
  // A word tapped while the transcript was being made counts like one tapped before Start.
  const first = live.anchorIndex !== null ? live.anchorIndex : startIndex;
  live.anchorIndex = null;
  follow.timeline = LV.alignSegments(LM, live.daf.canon, follow.segments, { startIndex: first, listTokens, leakMinRun: LM.LEAK_MIN_RUN_BATCH }).timeline;
  const placed = follow.timeline.filter((e) => e.state === 'read').length;
  logEvent('transcript', {
    ms: Math.round(performance.now() - began),
    words: words.length,
    seconds: transcript.seconds,
    language: transcript.languageCode,
    segments: follow.segments.length,
    placed,
    explain: follow.timeline.filter((e) => e.state === 'explain').length,
    unplaced: follow.timeline.filter((e) => e.state === 'unplaced').length,
    // [start, state, firstWord, lastWord, phonetic] -- enough to see where the
    // alignment went wrong without the whole transcript.
    timeline: follow.timeline.map((e) => [Math.round(e.start), e.state[0], e.s ?? null, e.e ?? null, e.phon ?? null]),
  });
  setDebug('Connection', `video transcript · ${words.length} words, ${placed}/${follow.segments.length} phrases placed`);
  if (!words.length) {
    stopLiveFollow();
    setStatus('error', 'Error', 'No speech was found in that video.');
    showToast('No speech was found in that video.', 'error');
    return;
  }
  follow.timer = setInterval(applyPlayhead, PLAYHEAD_POLL_MS);
  applyPlayhead();
}

function stopTranscriptFollow() {
  const follow = live.videoFollow;
  if (!follow) return;
  follow.job.cancelled = true;
  clearInterval(follow.timer);
  live.videoFollow = null;
}

// The video's clock -> the daf. Cheap enough to run four times a second; the
// page is only touched when the answer changes.
function applyPlayhead() {
  const follow = live.videoFollow;
  if (!follow?.timeline) return;
  const t = follow.video.getTime();
  const pos = LV.positionAt(follow.timeline, t + PLAYHEAD_LEAD_SECONDS);
  const key = `${pos.state}|${pos.placement ? pos.placement.index : -1}|${pos.unplacedRun}`;
  if (key === follow.lastKey) {
    if (pos.state === 'read') setStatusClock(t);
    return;
  }
  follow.lastKey = key;
  if (pos.placement) {
    if (!live.confirmed || live.confirmed.s !== pos.placement.s || live.confirmed.e !== pos.placement.e) {
      showConfirmed({ s: pos.placement.s, e: pos.placement.e, phonScore: pos.placement.phon ?? 100, charScore: pos.placement.char ?? 100, source: 'video' });
    }
  } else if (live.confirmed) {
    live.confirmed = null;
    clearPlacement();
  }
  live.unplacedHebrew = pos.unplacedRun;
  if (pos.state === 'read') {
    setFollowState('reading', { detail: videoFollowDetail(t) });
  } else if (pos.state === 'explain') {
    setFollowState('explaining');
  } else if (pos.state === 'unplaced') {
    setFollowState('listening');
  } else {
    setStatus('searching', 'Waiting…', pos.placement
      ? 'Waiting for the reading to resume.'
      : 'Nothing has been read yet at this point in the video — press play, or move on in it.');
  }
}

// "Following the video · 1:23", and where it is following from when that is a saved sync.
function videoFollowDetail(t) {
  return `Following the video · ${formatClock(t)}${live.videoFollow?.stored ? ' · saved sync' : ''}`;
}

function setStatusClock(t) {
  const detail = $('lfStatusDetail');
  if (detail) detail.textContent = videoFollowDetail(t);
}

// A tap while following a video: the reading is at that word *now*. The
// phrases from the playhead on are placed again from there; the ones already
// behind it keep their places.
function realignVideoFrom(index) {
  const follow = live.videoFollow;
  const t = follow.video.getTime();
  if (follow.stored) {
    // A saved sync has no phrases to re-place: the tap marks where the reading is
    // from here, and the entries after it stay as they were.
    const tapped = { start: t, end: t, text: '(set by you)', state: 'read', s: index, e: index, phon: 100, char: 100 };
    follow.timeline = [...follow.timeline.filter((e) => e.start < t), tapped, ...follow.timeline.filter((e) => e.start > t)];
    follow.lastKey = null;
    applyPlayhead();
    return;
  }
  const at = Math.max(0, LV.indexAt(follow.timeline, t));
  const tail = LV.alignSegments(LM, live.daf.canon, follow.segments.slice(at), { startIndex: index, listTokens: follow.listTokens, leakMinRun: LM.LEAK_MIN_RUN_BATCH }).timeline;
  const tapped = { start: t, end: t, text: '(set by you)', state: 'read', s: index, e: index, phon: 100, char: 100 };
  const insertAt = tail.findIndex((e) => e.start > t);
  const merged = insertAt < 0 ? [...tail, tapped] : [...tail.slice(0, insertAt), tapped, ...tail.slice(insertAt)];
  follow.timeline = [...follow.timeline.slice(0, at), ...merged];
  follow.lastKey = null;
  applyPlayhead();
}

// ---- Start / stop ----------------------------------------------------------------------
const sessionRunning = () => Boolean(live.ws || live.micStream || live.reconnectTimer || live.videoFollow);

async function startLiveFollow() {
  if (!live.on) return;
  const ref = dafPickerRef();
  const button = $('lfStartButton');
  if (!ref) {
    showToast('Choose a daf first.', 'error');
    return;
  }
  const source = selectedSource();
  if (source === 'transcript' && !pageVideo()) {
    showToast('Paste a video link and tap Load video first.', 'error');
    setStatus('', 'Ready', 'Paste a video link and tap Load video, or choose another way to follow.');
    return;
  }
  button.disabled = true;
  // The daf first: an unknown daf should fail before asking for the mic, and
  // the keyterms sent when connecting are built from its text.
  setStatus('', 'Loading…', `Loading ${realDafRef(ref)}`);
  try {
    await loadLiveDaf(ref);
  } catch (error) {
    console.error('Could not load the daf for live follow:', error);
    setStatus('error', 'Error', `Could not load ${realDafRef(ref)}.`);
    showToast(`Could not load ${realDafRef(ref)}: ${error.message}`, 'error');
    button.disabled = false;
    return;
  }
  live.manualStop = false;
  live.reconnectAttempt = 0;
  live.previousText = '';
  live.tracker = LM.createTracker(live.daf.canon, { eagerRelocalize: true, now: () => performance.now() / 1000 });
  live.preview = LM.createPreview(live.daf.canon, live.tracker);
  live.runCounter = 0;
  live.searchingSince = null;
  live.batchQueue = [];
  live.unplacedHebrew = 0;
  live.lastPreview = null;
  live.audioChunks = [];
  live.sentSamples = 0;
  live.lastCommitSample = 0;
  live.commitSeq = 0;
  live.batchInFlight = 0;
  live.batchQueue = [];
  live.log = [];
  live.logStart = performance.now();
  setProvisional(null);
  live.confirmed = null;
  clearPlacement();
  document.body.classList.remove('lf-quiet');
  const tappedStart = live.anchorIndex;
  if (live.anchorIndex !== null) {
    // A word was tapped before Start: the session begins locked there. It is
    // used once -- the next Start without a fresh tap goes back to searching.
    live.tracker.anchor(live.anchorIndex);
    logEvent('anchor', { index: live.anchorIndex, word: live.daf.canon.words[live.anchorIndex].text, midSession: false });
    live.anchorIndex = null;
  } else {
    clearAnchorMark();
  }
  logEvent('start', { daf: live.daf.label, anchored: live.tracker.locked, source, ...(source === 'transcript' ? { video: pageVideo()?.url } : {}), options: PAGE_OPTIONS });
  if (source === 'transcript') {
    // No microphone and no socket: the video's own transcript, aligned ahead
    // of time. The tracker made above is not used; the alignment makes its own.
    live.tracker = null;
    live.preview = null;
    await startTranscriptFollow({ startIndex: tappedStart });
    return;
  }
  const sourceName = source === 'tab' ? 'tab audio' : 'microphone';
  setStatus('', 'Connecting…', source === 'tab' ? 'Choose the tab to share, and tick “Share tab audio”' : 'Requesting microphone access');
  try {
    await startMic(source);
  } catch (error) {
    console.error(`Could not open the ${sourceName} for live follow:`, error);
    const denied = error?.name === 'NotAllowedError' || error?.name === 'SecurityError';
    const message = denied ? (source === 'tab' ? 'Tab sharing was cancelled or denied.' : 'Microphone access was denied.') : error.message;
    setStatus('error', 'Error', message);
    showToast(message, 'error');
    stopMic();
    live.tracker = null;
    live.preview = null;
    button.disabled = false;
    return;
  }
  button.disabled = false;
  button.textContent = 'Stop live follow';
  button.classList.add('stop');
  setStatus('searching', 'Connecting…', 'Opening the transcription connection');
  updateSearchWindowDebug();
  await connectWebSocket();
}

// Leaves the daf and the last highlight on screen -- after stopping, where
// it had got to is exactly what a reader wants to still see.
function stopLiveFollow() {
  live.manualStop = true;
  stopTranscriptFollow();
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
  const button = $('lfStartButton');
  button.textContent = 'Start live follow';
  button.classList.remove('stop');
  button.disabled = false;
  setStatus('', 'Ready', 'Choose a daf, then tap Start. Tap a word on the daf at any time to set where the reading is.');
  setDebug('Partial', '—');
  setDebug('Connection', '—');
}

// ---- The mode itself ----------------------------------------------------------------------
// The page's own daf picker, but offering every daf: on this page it is
// limited to dapim with a synced recording, which would rule out following a
// shiur on any other.
function setFullPicker(full) {
  const select = $('dafTractateSelect');
  if (!select) return;
  const tractate = select.value;
  const daf = $('dafDafSelect').value;
  if (full) {
    if (live.pickerSnapshot === null) live.pickerSnapshot = select.innerHTML;
    select.innerHTML = syncState.tractateNames.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
    select.disabled = false;
  } else if (live.pickerSnapshot !== null) {
    select.innerHTML = live.pickerSnapshot;
    live.pickerSnapshot = null;
  }
  if ([...select.options].some((o) => o.value === tractate)) select.value = tractate;
  refreshDafPickerOptions();
  if ([...$('dafDafSelect').options].some((o) => o.value === daf)) $('dafDafSelect').value = daf;
  refreshDafPickerAmud();
}

async function enableLiveMode() {
  if (live.on) return;
  live.on = true;
  updatePageBanner();
  live.saved = {
    segments: state.segments,
    activeIndex: state.activeIndex,
    dafRef: state.dafRef,
    wordTimeline: state.wordTimeline,
    browsePageRef: state.browsePageRef,
    title: $('dafTitle')?.textContent || '',
  };
  state.liveFollow = { active: true, activeIndex: -1 };
  document.body.classList.add('lf-on');
  // The page says a tap plays that part of the shiur; here it says where the reading is.
  const navLabel = document.querySelector('.browse-nav-label');
  if (navLabel) { live.navLabelText = navLabel.textContent; navLabel.textContent = 'Tap any word on the page to set where the reading is.'; }
  $('lfBody').hidden = false;
  const toggle = $('lfToggle');
  toggle.textContent = 'Turn off';
  toggle.setAttribute('aria-pressed', 'true');
  const hadDaf = Boolean(dafPickerRef());
  setFullPicker(true);
  // A video already playing on this page is the one to follow.
  if (pageVideo()) document.querySelector('input[name="lfSource"][value="transcript"]').checked = true;
  updateSourceUi();
  setStatus('', 'Ready', 'Choose a daf, then tap Start. Tap a word on the daf at any time to set where the reading is.');
  const ref = dafPickerRef();
  if (!ref || !hadDaf) return;
  try {
    await loadLiveDaf(ref);
  } catch (error) {
    console.error('Could not load the daf for live follow:', error);
    setStatus('error', 'Error', `Could not load ${realDafRef(ref)}.`);
    showToast(`Could not load ${realDafRef(ref)}: ${error.message}`, 'error');
  }
}

function disableLiveMode() {
  if (!live.on) return;
  stopLiveFollow();
  live.on = false;
  updatePageBanner();
  const saved = live.saved;
  live.saved = null;
  state.liveFollow = null;
  document.body.classList.remove('lf-on', 'lf-quiet');
  const navLabel = document.querySelector('.browse-nav-label');
  if (navLabel && live.navLabelText) navLabel.textContent = live.navLabelText;
  $('lfBody').hidden = true;
  const toggle = $('lfToggle');
  toggle.textContent = 'Turn on';
  toggle.setAttribute('aria-pressed', 'false');
  setFullPicker(false);
  for (const id of ['vilnaLiveProvisionalOverlay', 'vilnaLiveAnchorOverlay']) $(id)?.replaceChildren();
  live.confirmed = null;
  live.provisional = null;
  live.anchorMark = null;
  if (saved) {
    state.segments = saved.segments;
    state.wordTimeline = saved.wordTimeline;
    state.dafRef = saved.dafRef;
    state.activeIndex = Math.max(0, Math.min(saved.activeIndex, saved.segments.length - 1));
    state.browsePageRef = saved.browsePageRef;
    $('dafTitle').textContent = saved.title;
  }
  state.vilnaOverlayKey = '';
  renderDaf({ forceActiveSegment: true });
}

// The picker (or the page's Previous / Next page buttons) moved while live
// follow is on. A page of the daf being followed is only displayed -- the
// shiur may well have moved on to it; any other daf becomes the one followed.
async function pickerChanged(ref) {
  const real = realDafRef(ref);
  if (live.daf?.refs.includes(real)) {
    showPageFor(real);
    $('dafTitle').textContent = real;
    return;
  }
  if (sessionRunning()) stopLiveFollow();
  setStatus('', 'Loading…', `Loading ${real}`);
  try {
    await loadLiveDaf(ref);
    setStatus('', 'Ready', 'Choose a daf, then tap Start. Tap a word on the daf at any time to set where the reading is.');
  } catch (error) {
    console.error('Could not load the daf for live follow:', error);
    setStatus('error', 'Error', `Could not load ${real}.`);
    showToast(`Could not load ${real}: ${error.message}`, 'error');
  }
}

// ---- Taps ----------------------------------------------------------------------------------
// A tap on the printed daf (the page's own handler would play a recording)
// says where the reading is. The word under the finger, not the phrase.
function tapWord(ref, wordIndex) {
  const daf = live.daf;
  if (!daf) return;
  let index = daf.canonIndex.get(`${ref}#${wordIndex}`);
  if (index === undefined) {
    // A printed word with no entry on the daf's text (bare punctuation): the next one in its paragraph.
    const segment = daf.segmentIndexByRef.get(ref);
    if (segment === undefined) return;
    index = daf.canon.words.findIndex((w) => w.segIndex === segment && w.wordIndex >= wordIndex);
    if (index < 0) return;
  }
  setAnchor(index);
}

// The text view only has paragraphs to tap: the place is the start of the one tapped.
function tapSegment(segmentIndex) {
  const index = live.daf?.firstCanonOfSegment.get(segmentIndex);
  if (index !== undefined) setAnchor(index);
}

function printedWordAt(boxes, fx, fy) {
  const PAD = 0.004;
  let best = null;
  let bestDistance = Infinity;
  for (const box of boxes) {
    const dx = Math.max(box.x - PAD - fx, 0, fx - (box.x + box.w + PAD));
    const dy = Math.max(box.y - PAD - fy, 0, fy - (box.y + box.h + PAD));
    if (dx || dy) continue;
    const distance = Math.hypot(fx - (box.x + box.w / 2), fy - (box.y + box.h / 2));
    if (distance < bestDistance) { bestDistance = distance; best = box; }
  }
  return best;
}

// Capture phase, so it runs before the page's phrase-box handlers (which are
// phrase-sized and would send the tap to the start of the paragraph).
$('vilnaPageWrap')?.addEventListener('click', (event) => {
  if (!live.on || state.vilnaSelectTextMode || state.vilnaMarkMode) return;
  if (event.target.closest?.('#vilnaSelectTextActionBar')) return;
  const canvas = $('vilnaPageCanvas');
  const map = state.vilnaPageMap;
  if (!map || canvas.hidden) return;
  event.stopPropagation();
  const rect = canvas.getBoundingClientRect(); // includes the page's zoom transform
  if (!rect.width || !rect.height) return;
  const box = printedWordAt(map.wordBoxes, (event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height);
  if (!box) return;
  hapticTap();
  tapWord(box.ref, box.wordIndex);
}, true);

// ---- Wiring ----------------------------------------------------------------------------------
$('lfToggle')?.addEventListener('click', () => { if (live.on) disableLiveMode(); else enableLiveMode(); });
$('lfStartButton')?.addEventListener('click', () => {
  if (sessionRunning()) stopLiveFollow();
  else startLiveFollow();
});
// The page's own daf picker sits at the top of the page: take the reader to it.
$('lfChooseDafButton')?.addEventListener('click', () => {
  const field = document.querySelector('.setup-field.ref-field');
  const select = $('dafDafSelect');
  if (!field) return;
  field.scrollIntoView({ behavior: 'smooth', block: 'center' });
  field.classList.remove('lf-picker-flash');
  void field.offsetWidth; // restart the animation if it is already showing
  field.classList.add('lf-picker-flash');
  select?.focus({ preventScroll: true });
});
$('lfVideoLoadButton')?.addEventListener('click', loadLiveVideo);
$('lfVideoInput')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') loadLiveVideo(); });
$('lfCopyLogButton')?.addEventListener('click', copySessionLog);
// Switching how to follow mid-session restarts in the new mode (the change is
// itself the tap that browsers want before opening a microphone or a share).
document.querySelectorAll('input[name="lfSource"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    updateSourceUi();
    if (sessionRunning()) {
      stopLiveFollow();
      startLiveFollow();
    }
  });
});
// A browser with no getDisplayMedia (every phone) can't offer tab audio.
if (!navigator.mediaDevices?.getDisplayMedia) {
  const tabRadio = document.querySelector('input[name="lfSource"][value="tab"]');
  if (tabRadio) tabRadio.disabled = true;
  $('lfSourceTabLabel')?.classList.add('lf-disabled');
}
updateSourceUi();
if (!PAGE_OPTIONS.batch && $('lfDebugBatchRow')) $('lfDebugBatchRow').hidden = true;

window.addEventListener('beforeunload', () => {
  if (live.ws || live.micStream) stopLiveFollow();
});

// ?live=1 opens the page already in live follow (once the page's daf picker is ready).
if (PAGE_PARAMS.get('live') === '1') {
  const waitForPicker = setInterval(() => {
    if (typeof syncState !== 'undefined' && syncState.tractateNames.length) { clearInterval(waitForPicker); enableLiveMode(); }
  }, 100);
  setTimeout(() => clearInterval(waitForPicker), 15000);
}

window.dafLiveFollow = {
  enable: enableLiveMode,
  disable: disableLiveMode,
  tapWord,
  tapSegment,
  pickerChanged,
  activeWordBoxes,
  // For the tests: the same functions the socket / player clock drive.
  __test: {
    live, handleCommitted, handlePartial, showConfirmed, setProvisional, setAnchor, startLiveFollow, stopLiveFollow, loadLiveDaf,
    recordSentAudio, segmentAudio, applyPlayhead, loadLiveVideo, scoreText, updateSourceUi, pageVideo, buildWsUrl,
    activeKeyterms, activeKeytermTokens, PAGE_OPTIONS, boxesForRange, setFollowState,
  },
};
})();
