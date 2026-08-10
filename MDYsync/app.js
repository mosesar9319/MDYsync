'use strict';

const state = {
  dafRef: '',
  segments: [],
  activeIndex: 0,
  objectUrl: null,
  seeking: false,
  toastTimer: null,
  playerType: 'html5',
  videoSource: null,
  youtubePlayer: null,
  youtubeApiPromise: null,
  youtubeReady: false,
  youtubeState: -1,
  youtubePollTimer: null,
  usingDefaultAlignment: true,
  editingIndex: 0,
  phraseEditMode: false,
  vilnaMarkMode: false,
  alignmentStatus: 'placeholder',
  currentProjectId: null,
  wordTimeline: [],
  lastManualScrollAt: 0,
  alignmentDuration: 0,
  vilnaPageKey: null,
  vilnaPageMap: null,
  vilnaPagePollTimer: null,
  vilnaOverlayKey: '',
  vilnaWordEls: null,
  vilnaPageLoadingKey: null,
  videoOverlayEnabled: false,
  videoOverlayMode: 'full',
  videoOverlayOpacity: 0.5,
  videoOverlayOpacityTarget: 'both',
  videoOverlayIdleMode: 'dim',
  videoOverlayZoom: 1,
  videoOverlayPanX: 0,
  videoOverlayPanY: 0,
  vilnaPageZoom: 1,
  vilnaPdfPage: null,
  vilnaPdfContainerWidth: 0,
  vilnaZoomRerenderTimer: null,
  // A dedicated, higher-resolution rasterization of the same PDF page, used
  // only as the video overlay's crop/zoom source -- see updateVideoOverlay
  // and renderVilnaOverlaySource. Keyed the same way vilnaPageKey is, plus
  // the overlay's own display width, so a stale one (still rendering, or
  // left over from a page/size the reader has since moved on from) is never
  // drawn onto the wrong page.
  vilnaOverlaySourceCanvas: null,
  vilnaOverlaySourceKey: '',
  vilnaOverlaySourceRenderingKey: '',
  voiceCorrectionBaseline: null,
  // Which synced-alignment methods actually have a published result for the
  // daf currently on screen (raw alignment data or null per method), and
  // which one is driving the daf text/highlighting right now -- see
  // switchSyncMethod()/updateSyncMethodSwitchUi(). Both null means neither
  // a caption-OCR nor a voice-recognition sync exists yet for this daf.
  availableSyncMethods: { ocr: null, voice: null },
  activeSyncMethod: null,
  // Camera-scan feature (see scan-daf-page.mjs) -- scanImageWidth/Height
  // are the actual pixel dimensions of the (possibly downscaled) captured
  // photo; scanCorners are the four page-corner points the reader drags
  // into place, each stored as [xFraction, yFraction] of that photo (0-1),
  // in [top-left, top-right, bottom-right, bottom-left] order.
  scanPhotoDataUrl: null,
  scanImageWidth: 0,
  scanImageHeight: 0,
  scanCorners: null,
  scanDraggingCorner: null,
  // Daf browser (browse/index.html) -- browseMode is detected below from
  // <body data-page="browse">, not set by a separate script, since app.js
  // is one big deferred script with no mid-file hook another script tag
  // could use to inject state between this declaration and the code further
  // down that reads it. Every other page (player, studio, watch) has no
  // such marker, so this stays false there and today's video-driven
  // behavior is untouched. browsePageRef (a picker-built ref, same shape as
  // dafPickerRef()'s output) drives which page currentVilnaPageKey()
  // resolves to when set, standing in for the "currently playing video's
  // segment" that page normally reads instead.
  browseMode: document.body.dataset.page === 'browse',
  browsePageRef: null,
  // Camera-scan-only mode (?view=scan, see loadTalmudIndex().then(...) near
  // the bottom of this file) -- unlike browseMode, this can't be detected
  // from a static HTML attribute at state-init time (the query string is
  // only known once the deferred script runs), so it starts false and gets
  // flipped where the ?view=scan check itself runs.
  scanOnlyMode: false,
  // Daf browser only -- fetched once from list-synced-dapim.mjs (see
  // loadTalmudIndex()), { "<Tractate>": { "<daf><amud>": ["regularEn",...] } }.
  // loadTalmudIndex() awaits that fetch before building either picker, so
  // this is never actually null by the time browsableAmudim/
  // browsableDafOptions get called from real picker code.
  syncedDapim: null,
};

const AUTO_SCROLL_RESUME_MS = 4000;

const $ = (id) => document.getElementById(id);
const htmlVideo = $('video');
const youtubeHost = $('youtubePlayerHost');
const scrubber = $('scrubber');
const inlineScrubber = $('inlineScrubber');
// Both scrubbers stay in sync so the in-frame one (the only one visible in
// fullscreen, and the only one reachable through a "full page" overlay) works
// identically to the one below the player.
const scrubberEls = [scrubber, inlineScrubber].filter(Boolean);
// Same idea as scrubberEls -- the primary control-bar volume slider/button
// and the compact in-frame copy (the only one reachable in fullscreen) stay
// in sync with each other.
const volumeSliderEls = [$('volumeSlider'), $('inlineVolumeSlider')].filter(Boolean);
const muteButtonEls = [$('muteButton'), $('inlineMuteButton')].filter(Boolean);
const fastForwardButtonEls = [$('fastForwardButton'), $('inlineFastForwardButton')].filter(Boolean);
const dafPage = $('dafPage');
const editor = $('editor');
const editorBody = $('editorBody');

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '0:00';
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${minutes}:${String(secs).padStart(2, '0')}`;
}

// Whole seconds (formatTime) reads fine for a scrubber/current-time display,
// but the alignment editor's nudge buttons move a segment by as little as
// 0.1s -- flooring that away would make the fine nudge look like it did
// nothing. Only used there.
function formatTimePrecise(seconds) {
  if (!Number.isFinite(seconds)) return '0:00.0';
  const total = Math.max(0, seconds);
  const minutes = Math.floor(total / 60);
  const secs = total - minutes * 60;
  return `${minutes}:${secs.toFixed(1).padStart(4, '0')}`;
}

function showToast(message, type = 'normal') {
  const toast = $('toast');
  // A toast fired while a <dialog> is open (e.g. a sync-dialog validation
  // error -- "Sync from YouTube" clicked with the video not among the
  // channel's recent uploads, say) would otherwise render invisibly behind
  // that dialog: an open <dialog> paints in the browser's top layer, which
  // sits above all regular content regardless of z-index, and .toast is
  // just a regular fixed-position element. Re-parenting it into the open
  // dialog puts it in that same top-layer stacking context so it's
  // actually visible; parking it back under <body> once nothing's open
  // keeps the normal (non-dialog) case working exactly as before.
  const openDialog = document.querySelector('dialog[open]');
  const targetParent = openDialog || document.body;
  if (toast.parentElement !== targetParent) targetParent.appendChild(toast);
  clearTimeout(state.toastTimer);
  toast.textContent = message;
  toast.classList.toggle('error', type === 'error');
  toast.classList.add('show');
  state.toastTimer = setTimeout(() => toast.classList.remove('show'), 3200);
}


function statusLabel(status) {
  const labels = {
    placeholder: 'Needs alignment',
    'in-progress': 'Alignment in progress',
    complete: 'Aligned draft'
  };
  return labels[status] || 'Needs alignment';
}

function updateAlignmentStatus(status = state.alignmentStatus) {
  state.alignmentStatus = status;
  const badge = $('alignmentStatus');
  if (!badge) return;
  badge.textContent = statusLabel(status);
  badge.className = `alignment-badge ${status === 'complete' ? 'complete' : status === 'in-progress' ? 'in-progress' : 'needs-work'}`;
}

function draftKey() {
  const sourceId = state.videoSource?.videoId || state.videoSource?.url || state.videoSource?.fileName || 'demo';
  return `dafsync:draft:${state.dafRef}:${sourceId}`;
}

function saveDraft(silent = false) {
  try {
    const payload = {
      schema: 'dafsync-draft-v1',
      projectId: state.currentProjectId,
      dafRef: state.dafRef,
      title: $('lectureTitle').textContent,
      videoSource: state.videoSource,
      alignmentStatus: state.alignmentStatus,
      editingIndex: state.editingIndex,
      duration: getDuration() || Number(scrubber.max) || 0,
      segments: state.segments,
      savedAt: new Date().toISOString()
    };
    localStorage.setItem(draftKey(), JSON.stringify(payload));
    if (!silent) showToast('Alignment draft saved in this browser.');
  } catch (error) {
    console.error(error);
    if (!silent) showToast('The browser could not save this draft.', 'error');
  }
}

// The raw text the engine actually heard for a segment's word range, pulled
// from state.wordTimeline (see loadAlignment()'s heardText mapping) rather
// than stored on the segment itself -- segments only carry the matched
// canonical text (he), never what was transcribed before matching. This is
// the "heard" half of the (heard, actual) pairs build_voice_confusions.py
// diffs to find real letter confusions.
function heardTextForSegment(segment) {
  if (!segment || segment.w0 == null || segment.w1 == null) return '';
  const parts = state.wordTimeline
    .filter((e) => e.ref === segment.ref && e.w1 >= segment.w0 && e.w0 <= segment.w1 && e.heardText)
    .map((e) => e.heardText);
  return [...new Set(parts)].join(' ').trim();
}

// Banks (what the voice engine originally guessed, what the admin actually
// corrected it to) as training data -- see save-voice-correction.mjs's own
// comment. Only fires from the explicit "Save draft" button click, not
// silent auto-saves elsewhere in this file, since each call commits a new
// file to the results branch -- an auto-save on every edit would spam it
// with near-duplicate commits.
async function bankVoiceCorrection() {
  const baseline = state.voiceCorrectionBaseline;
  if (!baseline || baseline.ref !== state.dafRef) return;
  // Paired by array position, not by ref -- a ref can now span several
  // phrase-chunk segments (see caption_ocr_align.py's _split_word_ranges),
  // so it no longer identifies a single segment. Splitting is deterministic
  // and the editor never adds/removes rows, so the baseline and current
  // arrays always stay the same length and order; position is what
  // actually identifies "the same phrase" here.
  const changed = baseline.segments.length !== state.segments.length || baseline.segments.some((orig, i) => {
    const now = state.segments[i];
    return !now || Math.abs(now.start - orig.start) > 0.05 || Math.abs(now.end - orig.end) > 0.05 || now.he !== orig.he;
  });
  if (!changed) return; // nothing actually corrected -- don't bank a no-op
  const withHeardText = (s) => ({ ref: s.ref, start: s.start, end: s.end, he: s.he, heardText: heardTextForSegment(s) });
  try {
    const response = await fetch('/api/save-voice-correction', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ref: state.dafRef,
        original: baseline.segments.map(withHeardText),
        corrected: state.segments.map((s) => ({ ref: s.ref, start: s.start, end: s.end, he: s.he })),
      }),
    });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'save failed');
    showToast('Correction banked to help improve future voice-recognition syncs.');
    // The banked baseline is now the corrected version -- a second save
    // this session should only bank what changes *from here*, not re-diff
    // against the original engine guess again.
    state.voiceCorrectionBaseline = {
      ref: state.dafRef,
      segments: state.segments.map((s) => ({ ref: s.ref, start: s.start, end: s.end, he: s.he, w0: s.w0, w1: s.w1 })),
    };
  } catch (error) {
    console.error('Could not bank the voice-recognition correction.', error);
  }
}

function restoreDraftForCurrentProject() {
  try {
    const raw = localStorage.getItem(draftKey());
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (!Array.isArray(data.segments) || !data.segments.length) return false;
    state.segments = data.segments;
    state.editingIndex = Math.min(Number(data.editingIndex) || 0, state.segments.length - 1);
    state.alignmentStatus = data.alignmentStatus || 'in-progress';
    state.usingDefaultAlignment = false;
    renderDaf();
    updateAlignmentStatus();
    showToast(`Restored the saved ${state.dafRef || 'daf'} alignment draft.`);
    return true;
  } catch (error) {
    console.error(error);
    return false;
  }
}

// Separate from the manual-marking draft above: this remembers a fully
// synced alignment (imported, or produced by a Drive/local sync job) and
// the video source, per daf reference, so reopening the same daf doesn't
// require re-importing the sync file or re-pasting the video link. Keyed
// by daf reference alone (normalized), not by video source, since a saved
// alignment should come back regardless of which exact video the reader
// re-opens the site with.
const SAVED_PROJECT_PREFIX = 'dafsync:saved:';

function savedProjectKey(ref) {
  return SAVED_PROJECT_PREFIX + String(ref || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function saveProjectForRef(ref, patch) {
  if (!ref) return;
  try {
    const key = savedProjectKey(ref);
    const existing = JSON.parse(localStorage.getItem(key) || 'null') || {};
    localStorage.setItem(key, JSON.stringify({ ...existing, ...patch, dafRef: ref, savedAt: Date.now() }));
  } catch (error) {
    console.error('Could not save this daf locally.', error);
  }
}

function loadProjectForRef(ref) {
  if (!ref) return null;
  try {
    const raw = localStorage.getItem(savedProjectKey(ref));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// A Drive/server sync publishes its result once per daf reference it
// covers, at a predictable path -- results/by-ref/<ref>.json on the
// `results` branch -- so any device can fetch an already-synced daf
// directly, without needing anything saved in this browser. This is
// checked before the local-only saved project below, since it's the
// shared source of truth across devices; local storage only still
// matters for a manually imported file, which never gets published
// anywhere.
function refKey(ref, { voice = false } = {}) {
  // GitHub's raw file serving is case-sensitive, and the server side
  // (trigger-ocr-job.mjs, the sync dialog's picker-built ref list) always
  // publishes under the canonical tractate capitalization, so the lookup
  // has to normalize to that same canonical form -- not just whatever
  // case the reader happened to type ("chullin 86a" must resolve to the
  // same key as "Chullin 86a").
  const parsed = parseDafRef(ref);
  if (!parsed) return String(ref || '').trim().replace(/\s+/g, '-');
  // 'Voice-' is the outermost prefix, ahead of language/variant -- see
  // trigger-voice-job.mjs/voice-job.yml, which publish under this same
  // scheme. Kept separate from the caption-OCR engine's own by-ref/<ref>.json
  // key entirely so the two never race to overwrite each other when synced
  // for the same daf; the player fetches both and lets the reader choose.
  const voicePrefix = voice ? VOICE_KEY_PREFIX : '';
  const languagePrefix = parsed.language === 'he' ? HEBREW_KEY_PREFIX : '';
  const variantPrefix = parsed.variant === 'chazarah' ? CHAZARAH_KEY_PREFIX : '';
  return `${voicePrefix}${languagePrefix}${variantPrefix}${parsed.tractate.replace(/\s+/g, '-')}-${parsed.daf}${parsed.amud}`;
}

async function fetchServerAlignment(ref, { voice = false } = {}) {
  try {
    const url = `https://raw.githubusercontent.com/mosesar9319/MDYsync/results/by-ref/${refKey(ref, { voice })}.json?t=${Date.now()}`;
    const response = await fetch(url);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

// A synced alignment's own videoSource is never a real playable link --
// just the generic local filename the OCR job used internally -- so a
// YouTube/direct link is published separately, keyed by reference, the
// same way. Checked in resolvePreferredVideoSource below alongside
// whatever this browser has saved locally, so a link pasted on one
// device is still found on another.
async function fetchServerVideoLink(ref) {
  try {
    const url = `https://raw.githubusercontent.com/mosesar9319/MDYsync/results/video-links/${refKey(ref)}.json?t=${Date.now()}`;
    const response = await fetch(url);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

// "Skip to reading": originally built by cross-referencing the channel's
// shorter Chazarah Daf (review) recording, but that compared two entirely
// different recordings' pacing for the same text against each other, which
// turned out to be unreliable in both directions (flagging real reading as
// skippable when the review happened to move faster through a passage than
// the full shiur, and missing real explanation when it moved slower) --
// confirmed against Chullin 95a's real synced data.
//
// This instead reads the full shiur's OWN word-level OCR data (wordTimeline
// -- already loaded with any real synced alignment) directly: each entry is
// a span of video time the OCR tracked the on-screen caption sitting on a
// given word range. Actual reading moves through new words continuously, so
// its entries are short relative to how many words they cover; when the
// rabbi lingers on a phrase to explain it, the caption (and so the tracked
// word range) stays put while time keeps passing, producing one entry with
// a hugely disproportionate duration for how few words it spans -- e.g. one
// real entry from Chullin 95a's data spans 116 seconds for just 5 words,
// against a typical entry nearby covering 8-9 words in under 20 seconds. A
// long-and-slow entry like that is what this flags as "explanation" to skip
// past, landing at wherever the next entry (real reading, or the next
// explanation-tracking entry -- either way, the next actual change in
// what's on screen) begins. Also covers the video's own opening stretch
// before any daf text has been read aloud at all yet (routinely several
// minutes of introductory remarks) -- wordTimeline has no entries there
// either, which used to leave the button unavailable for exactly that
// stretch; it now targets the first entry's own start instead.
const EXPLANATION_PACE_THRESHOLD = 6; // seconds/word -- real reading stays well under this
const EXPLANATION_MIN_DURATION = 12; // seconds -- ignore brief holds, not worth a skip

function isExplanationEntry(entry) {
  const duration = entry.end - entry.start;
  if (duration < EXPLANATION_MIN_DURATION) return false;
  const words = Math.max(1, entry.w1 - entry.w0 + 1);
  return duration / words >= EXPLANATION_PACE_THRESHOLD;
}

// The last wordTimeline entry whose start is at or before `time` -- same
// "most recently begun" rule as findSegmentAt, since entries are built in
// order and don't overlap.
function findWordTimelineIndexAt(time) {
  const timeline = state.wordTimeline;
  let index = -1;
  for (let i = 0; i < timeline.length; i++) {
    if (timeline[i].start <= time) index = i; else break;
  }
  return index;
}

// Where the fast-forward button would jump to from `time`, or null when
// there's nothing to skip (either genuinely mid-reading, or nothing
// word-level to go on at all).
function nextReadingTime(time) {
  const timeline = state.wordTimeline;
  if (!timeline.length) return null;
  if (time < timeline[0].start) return timeline[0].start; // before any daf text has been read yet
  const index = findWordTimelineIndexAt(time);
  const entry = timeline[index];
  const pastEntry = time >= entry.end; // a gap between two entries -- nothing actively being read right now either
  if (!pastEntry && !isExplanationEntry(entry)) return null; // genuinely mid-reading -- no-op
  const next = timeline[index + 1];
  return next ? next.start : null;
}

function updateFastForwardButtonUi(time = getCurrentTime()) {
  const target = nextReadingTime(time);
  for (const button of fastForwardButtonEls) {
    button.hidden = !state.wordTimeline.length;
    button.disabled = target === null;
    button.title = target === null
      ? 'Already reading, or nothing further ahead'
      : 'Skip ahead to the next part actually reading the daf';
  }
}

function skipToNextReading() {
  // The no-op rule (genuinely mid-reading right now) has to be enforced
  // here, not just by disabling the button -- this is the actual behavior
  // contract, and the button's disabled state is only a UI reflection of
  // it, not the other way around.
  const target = nextReadingTime(getCurrentTime());
  if (target === null) return;
  seek(target + 0.03, true);
}

function saveVideoLinkToServer(ref, videoSource) {
  if (!ref || !videoSource || !['youtube', 'direct'].includes(videoSource.type)) return;
  fetch('/api/save-video-link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref, videoSource }),
  }).catch((error) => console.error('Could not save the video link to the server.', error));
}

// A synced alignment can span several daf references in one video (e.g. a
// shiur that opens on the last few lines of one daf before the bulk moves
// to the next) -- pasting/connecting the real playable link once should
// make it findable from any of those refs, not just whichever one happened
// to be loaded at the time. Reads the distinct daf refs straight out of the
// loaded segments, the same source of truth the alignment publish itself
// covers.
function dafRefsCoveredByCurrentAlignment() {
  // Segment refs never carry the "(Chazarah Daf)"/"(Hebrew)" markers
  // themselves (the OCR engine's own refs are always the plain,
  // variant-/language-less tractate/daf/amud -- see real_ref() in
  // gui_app.py), so both have to be re-attached from the loaded alignment's
  // own dafRef to keep each of the four variant/language combinations under
  // its own namespace instead of colliding with the others.
  const loadedRef = parseDafRef(state.dafRef);
  const variant = loadedRef?.variant === 'chazarah' ? ' (Chazarah Daf)' : '';
  const language = loadedRef?.language === 'he' ? ' (Hebrew)' : '';
  const refs = new Set();
  for (const segment of state.segments) {
    const parsed = parseDafRef(segment.ref);
    if (parsed) refs.add(`${parsed.tractate} ${parsed.daf}${parsed.amud}${variant}${language}`);
  }
  if (!refs.size && state.dafRef) refs.add(state.dafRef);
  return [...refs];
}

// `refs`, when given, overrides the refs derived from state.segments -- used
// by loadDaf()'s own early video-link restore, which runs before the daf
// being navigated to has replaced the *previous* daf's segments, so reading
// "covered refs" from live state there would tag the link onto the wrong
// (stale) references.
function saveVideoLinkForCoveredRefs(videoSource, refs = null) {
  for (const ref of (refs && refs.length ? refs : dafRefsCoveredByCurrentAlignment())) {
    saveVideoLinkToServer(ref, videoSource);
  }
}

// The server copy wins whenever it exists: saveVideoLinkToServer() already
// pushes every local save there in lockstep, so it's the more authoritative
// (and, since youtube-channel-sync.mjs can replace it later, potentially
// fresher) of the two -- preferring the local cache unconditionally used to
// mean this device's own browser could keep showing an outdated cut of a
// shiur even after the server had already healed to the finished edit. The
// local copy is only a fallback for when the server has nothing yet (e.g. a
// save made while offline never reached it).
async function resolvePreferredVideoSource(ref, localSaved) {
  const serverSource = await fetchServerVideoLink(ref);
  if (serverSource) return serverSource;
  if (localSaved?.videoSource && ['youtube', 'direct'].includes(localSaved.videoSource.type)) {
    return localSaved.videoSource;
  }
  return null;
}

function flattenText(value) {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap(flattenText).filter(Boolean);
}

function stripHtml(text) {
  const doc = new DOMParser().parseFromString(text, 'text/html');
  return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
}

function normalizeHebrew(text) {
  return (text || '')
    .normalize('NFD')
    .replace(/[\u0591-\u05C7]/g, '')
    .replace(/[\u200e\u200f]/g, '')
    .replace(/[^\u05D0-\u05EA\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text || '';
  return div.innerHTML;
}

function getCurrentTime() {
  if (state.playerType === 'youtube' && state.youtubeReady) {
    return Number(state.youtubePlayer?.getCurrentTime?.()) || 0;
  }
  return Number(htmlVideo.currentTime) || 0;
}

function getDuration() {
  if (state.playerType === 'youtube' && state.youtubeReady) {
    return Number(state.youtubePlayer?.getDuration?.()) || 0;
  }
  return Number.isFinite(htmlVideo.duration) ? htmlVideo.duration : 0;
}

function isPaused() {
  if (state.playerType === 'youtube') {
    return state.youtubeState !== 1;
  }
  return htmlVideo.paused;
}

function setSourceBadge(label) {
  $('videoSourceBadge').textContent = label;
  $('videoSourceBadge').hidden = false;
  $('videoEmpty').hidden = true;
}

function switchPlayerType(type) {
  if (type === state.playerType) return;

  if (state.playerType === 'youtube' && state.youtubeReady) {
    state.youtubePlayer.pauseVideo();
  } else {
    htmlVideo.pause();
  }

  state.playerType = type;
  const isYouTube = type === 'youtube';
  htmlVideo.hidden = isYouTube;
  youtubeHost.hidden = !isYouTube;
  $('videoFrame').classList.toggle('youtube-active', isYouTube);

  if (isYouTube) startYouTubePoll(); else stopYouTubePoll();
  updatePlayUi();
}

function findSegmentAt(time) {
  if (!state.segments.length) return -1;
  // Segments can slightly overlap in end/start (real speech doesn't cut
  // cleanly at a segment boundary, so a stray word can get matched into the
  // previous or next segment's range). Picking the first range that
  // technically contains `time` would then always favor whichever segment
  // comes first in reading order, even after seeking past it into the
  // next one. What the reader actually means by "current segment" is
  // whichever one they most recently entered, so take the last segment
  // (in start-ascending order) whose start is at or before `time`.
  let index = 0;
  for (let i = 0; i < state.segments.length; i++) {
    if (state.segments[i].start <= time) index = i;
    else break;
  }
  return index;
}

// How many segments of context to show before/after the active one. The daf
// pane is meant for checking sync against the video side by side, not for
// reading the whole daf -- showing everything pushes the currently-spoken
// text far down the page and makes it hard to keep the video and the
// highlight in view together.
const DAF_WINDOW_BEFORE = 2;
const DAF_WINDOW_AFTER = 3;

function buildSegmentSpan(segment, index) {
  const span = document.createElement('span');
  const classes = ['daf-segment'];
  if (index === state.editingIndex) classes.push('mark-target-segment');
  if (index === state.activeIndex) classes.push('active');
  else if (index < state.activeIndex) classes.push('past');
  span.className = classes.join(' ');
  span.dataset.index = String(index);
  span.dataset.start = String(segment.start);
  span.tabIndex = 0;
  span.setAttribute('role', 'button');
  span.setAttribute('aria-label', `Jump to ${formatTime(segment.start)}: ${segment.he}`);
  span.innerHTML = `<sup class="segment-marker">${index + 1}</sup>${escapeHtml(segment.he)} `;
  span.addEventListener('click', () => seekToSegment(index));
  span.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      seekToSegment(index);
    }
  });
  return span;
}

function renderDafWindow() {
  dafPage.innerHTML = '';
  if (!state.segments.length) {
    const note = document.createElement('p');
    note.className = 'daf-empty-note';
    note.textContent = 'No daf loaded yet. Enter a reference above and press "Load daf."';
    dafPage.appendChild(note);
    return;
  }
  const lo = Math.max(0, state.activeIndex - DAF_WINDOW_BEFORE);
  const hi = Math.min(state.segments.length - 1, state.activeIndex + DAF_WINDOW_AFTER);
  if (lo > 0) {
    const more = document.createElement('p');
    more.className = 'daf-window-more';
    more.textContent = `··· ${lo} earlier segment${lo === 1 ? '' : 's'} ···`;
    dafPage.appendChild(more);
  }
  for (let index = lo; index <= hi; index++) {
    dafPage.appendChild(buildSegmentSpan(state.segments[index], index));
  }
  if (hi < state.segments.length - 1) {
    const remaining = state.segments.length - 1 - hi;
    const more = document.createElement('p');
    more.className = 'daf-window-more';
    more.textContent = `··· ${remaining} later segment${remaining === 1 ? '' : 's'} ···`;
    dafPage.appendChild(more);
  }
}

function renderDaf() {
  $('segmentCount').textContent = `${state.segments.length} synchronized segment${state.segments.length === 1 ? '' : 's'}`;
  updateMarkTargetUi();
  updateActiveSegment(true);
  renderEditor();
  renderVilnaPage();
}

// --- Vilna page-image view -------------------------------------------------
// Fetches a real Vilna-style daf page (via the daf-page proxy function, which
// forwards to shas.org's Daf PDF API) and rasterizes page 1 with pdf.js so it
// can be shown as a plain image. shas.org publishes no explicit reuse
// license for these pages, so this is a private-use source for now.

const PDFJS_VERSION = '6.1.200';
let pdfjsLibPromise = null;

function loadPdfJs() {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = import(`https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.min.mjs`)
      .then((lib) => {
        lib.GlobalWorkerOptions.workerSrc =
          `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs`;
        return lib;
      });
  }
  return pdfjsLibPromise;
}

const CANONICAL_TRACTATE_NAMES = [
  'Berakhot', 'Shabbat', 'Eruvin', 'Pesachim', 'Yoma', 'Sukkah', 'Beitzah', 'Rosh Hashanah',
  'Taanit', 'Megillah', 'Moed Katan', 'Chagigah', 'Yevamot', 'Ketubot', 'Nedarim', 'Nazir',
  'Sotah', 'Gittin', 'Kiddushin', 'Bava Kamma', 'Bava Metzia', 'Bava Batra', 'Sanhedrin',
  'Makkot', 'Shevuot', 'Avodah Zarah', 'Horayot', 'Zevachim', 'Menachot', 'Chullin', 'Bekhorot',
  'Arakhin', 'Temurah', 'Keritot', 'Meilah', 'Niddah'
];
const TRACTATE_NAME_BY_LOWERCASE = new Map(CANONICAL_TRACTATE_NAMES.map((name) => [name.toLowerCase(), name]));
// Namespaces a Chazarah Daf / Hebrew-shiur reading's alignment key so it
// never collides with the regular/English shiur's for the same daf -- must
// match exactly what trigger-ocr-job.mjs, save-video-link.mjs, and
// ocr-job.yml's publish step compute server-side. The two prefixes compose
// independently (a Hebrew Chazarah reading gets both), since the channel
// this site tracks publishes all four combinations as separate recordings.
const CHAZARAH_KEY_PREFIX = 'Chazarah-Daf-';
const HEBREW_KEY_PREFIX = 'Hebrew-';
// Namespaces the voice-recognition engine's own published alignment,
// separate from the caption-OCR engine's -- must match
// trigger-voice-job.mjs/voice-job.yml exactly. See refKey().
const VOICE_KEY_PREFIX = 'Voice-';

function parseDafRef(ref) {
  // Accepts both a bare daf ref ("Chullin 86a") and a segment ref, ignoring
  // an optional trailing segment number. Segment refs use two different
  // separators depending on where they came from: a synced alignment's
  // segments use a colon ("Chullin 86a:3", built server-side), while
  // loadDaf()'s own fresh-Sefaria-fetch fallback (used for any daf that
  // hasn't been through the sync pipeline yet) builds them with a dot
  // ("Chullin 88a.1", from `${sectionRef}.${index+1}`) -- both need to
  // parse here, or the Vilna page silently never loads for any such daf
  // (currentVilnaPageKey() reads state.segments[i].ref first and only
  // falls back to state.dafRef when that's empty, not when it's just
  // unparseable). The tractate name is normalized to its canonical
  // capitalization regardless of how it was typed/cased, since it flows
  // into case-sensitive lookups downstream (GitHub raw file paths, and
  // server-side tractate whitelists). Optional trailing " (Chazarah Daf)"
  // and " (Hebrew)" markers can appear in either order -- stripped in a
  // small loop rather than a fixed-order regex so "X (Hebrew) (Chazarah
  // Daf)" and "X (Chazarah Daf) (Hebrew)" both parse the same way. Neither
  // marker changes the Gemara text/page looked up (Sefaria and the Vilna
  // page/pagemap lookups always use tractate/daf/amud alone, never
  // .variant/.language), but each needs its own separate alignment/video,
  // which is what .variant/.language thread through refKey() for.
  let working = String(ref || '').trim();
  let variant = 'regular';
  let language = 'en';
  const chazarahSuffix = /\s*\(Chazarah Daf\)\s*$/i;
  const hebrewSuffix = /\s*\(Hebrew\)\s*$/i;
  for (let pass = 0; pass < 2; pass++) {
    if (chazarahSuffix.test(working)) { variant = 'chazarah'; working = working.replace(chazarahSuffix, ''); }
    if (hebrewSuffix.test(working)) { language = 'he'; working = working.replace(hebrewSuffix, ''); }
  }
  const match = /^(.+?)\s+(\d+)\s*([abAB])(?:[:.]\d+)?$/i.exec(working.trim());
  if (!match) return null;
  const typedTractate = match[1].trim();
  const tractate = TRACTATE_NAME_BY_LOWERCASE.get(typedTractate.toLowerCase()) || typedTractate;
  return {
    tractate,
    daf: Number(match[2]),
    amud: match[3].toLowerCase(),
    variant,
    language
  };
}

// Rebuilds a daf ref string with canonical tractate capitalization (e.g.
// "chullin 86a" -> "Chullin 86a"), used wherever a reader-typed ref is
// about to be saved/looked-up server-side, so it lands under the same
// key regardless of how it was typed. Falls back to the input unchanged
// if it doesn't parse as a daf ref at all. Preserves "(Chazarah Daf)"/
// "(Hebrew)" suffixes if the input had them, so re-canonicalizing an
// already-variant ref doesn't silently drop them.
function canonicalDafRef(ref) {
  const parsed = parseDafRef(ref);
  if (!parsed) return String(ref || '').trim();
  const variantSuffix = parsed.variant === 'chazarah' ? ' (Chazarah Daf)' : '';
  const languageSuffix = parsed.language === 'he' ? ' (Hebrew)' : '';
  return `${parsed.tractate} ${parsed.daf}${parsed.amud}${variantSuffix}${languageSuffix}`;
}

// Strips a "(Chazarah Daf)" marker back down to the real Sefaria ref --
// Sefaria and shas.org only know the underlying tractate/daf/amud, never
// the shiur variant, so anything sent to them (or to the OCR engine's own
// Sefaria fetch) needs this instead of the display/storage ref.
function realDafRef(ref) {
  const parsed = parseDafRef(ref);
  return parsed ? `${parsed.tractate} ${parsed.daf}${parsed.amud}` : String(ref || '').trim();
}

// Fetches a ref's full canonical text straight from Sefaria (proxied, with
// a direct-API fallback) and returns it as one entry per paragraph -- the
// same shape loadDaf()'s from-scratch fallback builds segments from, and
// what fillMissingDafText() below diffs a loaded alignment against. `ref`
// must already be Sefaria's own tractate/daf/amud form (see realDafRef),
// not a display ref carrying a "(Chazarah Daf)"/"(Hebrew)" marker.
async function fetchSefariaParagraphs(sefariaRef) {
  let response;
  try {
    response = await fetch(`/api/sefaria?ref=${encodeURIComponent(sefariaRef)}`);
    if (!response.ok) throw new Error('Proxy unavailable');
  } catch {
    response = await fetch(`https://www.sefaria.org/api/v3/texts/${encodeURIComponent(sefariaRef)}?version=source&version=translation&return_format=text_only`);
  }
  if (!response.ok) throw new Error(`Sefaria returned ${response.status}`);
  const data = await response.json();
  const versions = Array.isArray(data.versions) ? data.versions : [];
  const sourceVersion = versions.find((version) => String(version.language || '').toLowerCase().includes('hebrew')) || versions[0];
  const translationVersion = versions.find((version) => String(version.language || '').toLowerCase().includes('english')) || versions[1];
  const he = flattenText(sourceVersion?.text ?? data.he).map(stripHtml).filter(Boolean);
  const en = flattenText(translationVersion?.text ?? data.text).map(stripHtml).filter(Boolean);
  if (!he.length) throw new Error('No Hebrew text was returned for this reference.');
  return {
    heRef: data.heRef || sefariaRef,
    paragraphs: he.map((text, index) => ({
      ref: data.sectionRef ? `${data.sectionRef}.${index + 1}` : `${sefariaRef}.${index + 1}`,
      he: text,
      en: en[index] || ''
    }))
  };
}

// A published alignment (OCR or voice) only ever carries segments for
// canonical paragraphs a match actually covered at the time it was
// generated -- older published files predate build_outputs() filling that
// gap server-side (see caption_ocr_align.py's _fill_segment_gaps), and
// even a fresh one only fills gaps *between* matches, not a paragraph a
// relocalization jump skipped past entirely. Rather than requiring a slow
// re-run of the actual transcription just to get the rest of the daf's
// text on screen -- filling in missing text is a plain textual diff
// against Sefaria, nothing the engine needs to redo -- this reconciles
// state.segments against Sefaria's full paragraph list right after any
// server alignment loads, inserting an "estimated" placeholder row for
// any paragraph no segment covers at all, so the whole daf is always
// there to review/correct regardless of how old or partial the published
// file is. Returns true if it actually added anything.
async function fillMissingDafText(sefariaRef) {
  let paragraphs;
  try {
    ({ paragraphs } = await fetchSefariaParagraphs(sefariaRef));
  } catch (error) {
    console.error('Could not check for missing daf text.', error);
    return false;
  }
  const coveredRefs = new Set(state.segments.map((s) => s.ref));
  if (paragraphs.every((p) => coveredRefs.has(p.ref))) return false;

  // Anchor time for each paragraph already covered: the earliest segment
  // start touching it. Missing paragraphs interpolate/extrapolate a
  // placeholder time from their nearest covered neighbors, same approach
  // as _fill_segment_gaps server-side.
  const anchors = paragraphs.map((p) => {
    const covering = state.segments.filter((s) => s.ref === p.ref);
    return covering.length ? Math.min(...covering.map((s) => s.start)) : null;
  });

  const additions = [];
  for (let i = 0; i < paragraphs.length; i++) {
    if (anchors[i] != null) continue;
    let before = null, beforeIdx = -1;
    for (let j = i - 1; j >= 0; j--) { if (anchors[j] != null) { before = anchors[j]; beforeIdx = j; break; } }
    let after = null, afterIdx = -1;
    for (let j = i + 1; j < paragraphs.length; j++) { if (anchors[j] != null) { after = anchors[j]; afterIdx = j; break; } }
    let t;
    if (before != null && after != null) t = before + (after - before) * (i - beforeIdx) / (afterIdx - beforeIdx);
    else if (before != null) t = before + (i - beforeIdx);
    else if (after != null) t = Math.max(0, after - (afterIdx - i));
    else t = 0;
    const words = paragraphs[i].he.trim().split(/\s+/);
    additions.push({
      id: `${paragraphs[i].ref.replace(/\W+/g, '-').toLowerCase()}-fill`,
      ref: paragraphs[i].ref,
      start: Number(t.toFixed(2)),
      end: Number((t + 0.1).toFixed(2)),
      he: paragraphs[i].he,
      en: paragraphs[i].en,
      estimated: true,
      w0: 0,
      w1: words.length - 1
    });
  }
  if (!additions.length) return false;
  state.segments = [...state.segments, ...additions].sort((a, b) => a.start - b.start);
  // bankVoiceCorrection() diffs state.segments against voiceCorrectionBaseline
  // by array position (see its own comment) -- since this just changed the
  // segment count, the baseline (captured by loadAlignmentData before this
  // ran) needs to be re-snapshotted now, or the newly-added placeholder rows
  // alone would look like a "correction" the moment Save draft is clicked,
  // with nothing the admin actually did yet to bank.
  if (state.voiceCorrectionBaseline) {
    state.voiceCorrectionBaseline = {
      ref: state.dafRef,
      segments: state.segments.map((s) => ({ ref: s.ref, start: s.start, end: s.end, he: s.he }))
    };
  }
  return true;
}

function setVilnaPageStatus(message) {
  const status = $('vilnaPageStatus');
  const text = $('vilnaPageStatusText');
  if (text) text.textContent = message;
  if (status) status.hidden = false;
  $('vilnaPageCanvas').hidden = true;
}

// The daf shown can change mid-flight (a user seeking back and forth across
// an amud boundary while the previous page image/map fetch is still in the
// air) -- render/load calls below re-check this at every await point instead
// of trusting a value captured when they started, so a slow, now-stale
// response can never clobber a faster, newer one. Without this, the exact
// failure seen in practice: the canvas stayed on the old amud's image (which
// can have large blank stretches) while the *overlay* had already moved on
// to the new amud's word positions, landing highlights in blank space that
// belonged on a page that was no longer the one on screen.
function currentVilnaPageKey() {
  const activeRef = state.browsePageRef || state.segments[state.activeIndex]?.ref || state.dafRef;
  const parsed = parseDafRef(activeRef);
  if (!parsed) return { parsed: null, key: null };
  return { parsed, key: `${parsed.tractate}|${parsed.daf}|${parsed.amud}` };
}

// The source PDF (proxied as-is from shas.org) is real vector text -- ~50
// embedded Type1C fonts, no raster /Image XObject anywhere in it -- so it's
// crisp at any resolution; shas.org isn't the quality ceiling. QUALITY_OVERSAMPLE
// renders noticeably above 1:1 device pixels so the page still looks sharp
// zoomed in a bit, and rerenderVilnaPageForZoom below re-rasterizes from the
// same cached page at a resolution matching the current zoom level instead of
// just CSS-stretching a fixed-resolution bitmap (which is blurry the same way
// stretching any raster image is, vector source or not).
const QUALITY_OVERSAMPLE = 1.6;
const MAX_CANVAS_WIDTH_PX = 2600;

function vilnaPageRenderScale(baseViewportWidth, containerWidth, qualityMultiplier) {
  const scale = (containerWidth / baseViewportWidth) * (window.devicePixelRatio || 1) * QUALITY_OVERSAMPLE * qualityMultiplier;
  const maxScale = MAX_CANVAS_WIDTH_PX / baseViewportWidth;
  return Math.min(scale, maxScale);
}

async function renderVilnaPage() {
  const canvas = $('vilnaPageCanvas');
  const view = $('vilnaPlaceholder');
  // The daf card itself (not just the Vilna/text view-switch, checked via
  // view.hidden below) can be hidden now too -- while the alignment editor
  // is open, it takes this card's spot in the layout (see editModeButton).
  // A hidden ancestor reports 0 for every size measurement below, so
  // skip entirely rather than sizing the canvas off a bogus 0 width;
  // closeEditorButton re-calls this once the card is visible again.
  if (!canvas || !view || view.hidden || $('dafCard')?.hidden) return;

  // Follow the daf the video is actually on, not just whichever ref the
  // player started with -- a synced video can span more than one daf
  // (e.g. finishing 86a partway through and continuing into 86b), and
  // the Vilna page should turn with it.
  const { parsed, key } = currentVilnaPageKey();
  if (!parsed) {
    state.vilnaPageKey = null;
    setVilnaPageStatus('Load a daf reference to see the Vilna page image.');
    return;
  }
  if (state.vilnaPageKey === key || state.vilnaPageLoadingKey === key) return;
  state.vilnaPageLoadingKey = key;
  const stillWanted = () => currentVilnaPageKey().key === key;

  setVilnaPageStatus(`Loading the Vilna page for ${parsed.tractate} ${parsed.daf}${parsed.amud}…`);
  try {
    const [lib, response] = await Promise.all([
      loadPdfJs(),
      fetch(`/api/daf-page?tractate=${encodeURIComponent(parsed.tractate)}&daf=${parsed.daf}&amud=${parsed.amud}`)
    ]);
    if (!stillWanted()) return;
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `Page image request failed (${response.status}).`);
    }
    const bytes = await response.arrayBuffer();
    const pdf = await lib.getDocument({ data: bytes }).promise;
    if (!stillWanted()) return;
    const page = await pdf.getPage(1);
    if (!stillWanted()) return;

    // Measure the canvas's actual containing block (.vilna-page-wrap), not
    // #vilnaPlaceholder itself -- that has 20px of padding, so using its
    // clientWidth overstates the space really available by 40px. That
    // overstated width got clamped back down by the canvas's own
    // max-width:100% rule when displayed, but the explicit pixel height set
    // below was computed from the same overstated width and never got
    // reclamped along with it -- stretching the displayed image out of its
    // real aspect ratio, which is exactly what would shift a highlight box
    // meant for a Gemara word onto the Rashi column next to it. Leaving
    // the CSS height:auto rule in charge (by not setting an explicit
    // height at all) keeps the display proportional to whatever width it
    // actually renders at, however that gets constrained.
    const containerWidth = $('vilnaPageWrap').clientWidth || view.clientWidth || 640;
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = vilnaPageRenderScale(baseViewport.width, containerWidth, 1);
    const viewport = page.getViewport({ scale });

    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.style.width = `${containerWidth}px`;
    canvas.style.removeProperty('height');
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    if (!stillWanted()) return;

    state.vilnaPageKey = key;
    state.vilnaPdfPage = page;
    state.vilnaPdfContainerWidth = containerWidth;
    $('vilnaPageStatus').hidden = true;
    canvas.hidden = false;
    loadVilnaPageMap(parsed, stillWanted);
  } catch (error) {
    if (!stillWanted()) return;
    state.vilnaPageKey = null;
    setVilnaPageStatus(`Couldn't load the Vilna page for ${parsed.tractate} ${parsed.daf}${parsed.amud}: ${error.message}`);
  } finally {
    if (state.vilnaPageLoadingKey === key) state.vilnaPageLoadingKey = null;
  }
}

function pageMapKey(parsed) {
  return `${parsed.tractate.replace(/\s+/g, '-')}-${parsed.daf}${parsed.amud}`;
}

function stopVilnaPagePoll() {
  if (state.vilnaPagePollTimer) {
    clearInterval(state.vilnaPagePollTimer);
    state.vilnaPagePollTimer = null;
  }
}

// Word-position highlighting on the Vilna page is a separate, optional
// layer on top of the page image: the image itself (renderVilnaPage) is
// already useful without it, so a failure or delay here should never
// disturb what's already on screen -- it just means no highlight overlay
// yet.
async function loadVilnaPageMap(parsed, stillWanted = () => true) {
  stopVilnaPagePoll();
  state.vilnaPageMap = null;
  state.vilnaOverlayKey = '';
  state.vilnaWordEls = null;
  $('vilnaPageOverlay').innerHTML = '';
  const key = pageMapKey(parsed);
  const resultUrl = `https://raw.githubusercontent.com/mosesar9319/MDYsync/results/pages/${key}.json`;

  const tryFetch = async () => {
    try {
      const response = await fetch(`${resultUrl}?t=${Date.now()}`);
      if (!stillWanted()) return true; // a newer page has since taken over; stop polling, apply nothing
      if (!response.ok) return false;
      const data = await response.json();
      if (!stillWanted()) return true;
      state.vilnaPageMap = data;
      renderVilnaWordBoxes();
      updateVilnaOverlay(getCurrentTime());
      return true;
    } catch {
      return false;
    }
  };

  if (await tryFetch()) return;
  if (!stillWanted()) return;

  try {
    const parsedResponse = await fetch('/api/trigger-page-ocr-job', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tractate: parsed.tractate, daf: parsed.daf, amud: parsed.amud }),
    });
    if (!parsedResponse.ok) return;
  } catch {
    return;
  }

  const startedAt = Date.now();
  state.vilnaPagePollTimer = setInterval(async () => {
    if (Date.now() - startedAt > 3 * 60 * 1000) {
      stopVilnaPagePoll();
      return;
    }
    if (await tryFetch()) stopVilnaPagePoll();
  }, 5000);
}

const VILNA_ZOOM_MIN = 0.5;
const VILNA_ZOOM_MAX = 3;
const VILNA_ZOOM_STEP = 0.2;

// A plain CSS transform on the page's own wrap, not a re-render -- the
// canvas and the per-word click targets inside it scale together as one
// visual unit, so clicking a word to seek keeps working unchanged at any
// zoom level, and .daf-scroll's existing overflow:auto lets the reader pan
// around a zoomed-in page for free.
function applyVilnaPageZoom() {
  const wrap = $('vilnaPageWrap');
  if (wrap) wrap.style.transform = `scale(${state.vilnaPageZoom})`;
  const label = $('vilnaZoomLabel');
  if (label) label.textContent = `${Math.round(state.vilnaPageZoom * 100)}%`;
}

function setVilnaPageZoom(zoom) {
  state.vilnaPageZoom = Math.max(VILNA_ZOOM_MIN, Math.min(VILNA_ZOOM_MAX, zoom));
  applyVilnaPageZoom();
  // The CSS transform above gives instant visual feedback by stretching the
  // existing bitmap (blurry past its native resolution, same as stretching
  // any image); this re-rasterizes the same cached vector page at a
  // resolution matching the new zoom so it settles crisp a moment later.
  // Debounced so rapid clicks/wheel ticks don't each trigger a full
  // pdf.js render pass.
  clearTimeout(state.vilnaZoomRerenderTimer);
  state.vilnaZoomRerenderTimer = setTimeout(rerenderVilnaPageForZoom, 220);
}

async function rerenderVilnaPageForZoom() {
  const page = state.vilnaPdfPage;
  const canvas = $('vilnaPageCanvas');
  if (!page || !canvas || canvas.hidden) return;
  const key = state.vilnaPageKey;
  const containerWidth = state.vilnaPdfContainerWidth || canvas.clientWidth || 640;
  const baseViewport = page.getViewport({ scale: 1 });
  // Only the zoomed-in case needs a fresh, higher-resolution rasterization --
  // zooming back out is already covered by the baseline render's own
  // QUALITY_OVERSAMPLE headroom, so skip the redundant re-render.
  const qualityMultiplier = Math.max(1, state.vilnaPageZoom);
  const scale = vilnaPageRenderScale(baseViewport.width, containerWidth, qualityMultiplier);
  const viewport = page.getViewport({ scale });
  if (Math.round(viewport.width) === canvas.width) return; // already at this resolution (e.g. capped by MAX_CANVAS_WIDTH_PX)
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  // The per-word click targets are positioned in percentages of the wrap's
  // CSS layout box (unchanged here -- only the canvas's internal pixel
  // resolution is), so they stay aligned without needing to be rebuilt.
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
}

function toggleVilnaFullscreen() {
  const card = document.querySelector('.daf-card');
  if (!card) return;
  if (document.fullscreenElement === card) {
    document.exitFullscreen();
  } else {
    card.requestFullscreen?.().catch((error) => showToast(`Fullscreen not available: ${error.message}`, 'error'));
  }
}

// Renders one persistent, clickable div per word on the page -- not just
// the ones currently playing -- so a reader can click any word to jump the
// video there, not only the word already lit up. updateVilnaOverlay below
// then just toggles an "active" class on these same elements rather than
// creating/destroying DOM nodes on every playback tick.
function renderVilnaWordBoxes() {
  const overlay = $('vilnaPageOverlay');
  if (!overlay) return;
  overlay.innerHTML = '';
  state.vilnaWordEls = new Map();
  if (!state.vilnaPageMap) return;
  for (const box of state.vilnaPageMap.wordBoxes) {
    const el = document.createElement('div');
    el.className = 'vilna-word-box';
    el.style.left = `${box.x * 100}%`;
    el.style.top = `${box.y * 100}%`;
    el.style.width = `${box.w * 100}%`;
    el.style.height = `${box.h * 100}%`;
    el.addEventListener('click', () => {
      // The Daf browser has its own (initially hidden) video player on the
      // same page -- a tap reveals and plays into that in place, rather
      // than navigating away the way the scan-only page's tapScannedWord
      // still has to (it has no video-player DOM at all to play into).
      if (state.browseMode) playWordInline(box.ref, box.wordIndex);
      else if (state.vilnaMarkMode) markSegmentAtVilnaWord(box.ref, box.wordIndex);
      else seekToVilnaWord(box.ref, box.wordIndex);
    });
    overlay.appendChild(el);
    state.vilnaWordEls.set(`${box.ref}:${box.wordIndex}`, el);
  }
  updateVilnaMarkTarget();
}

// Builds the same ?ref=&variant=&language= deep link player/index.html's
// own loadTalmudIndex().then(...) block already resolves (see there), plus
// ?seekWord= so it lands at this exact word instead of the top of the daf.
// box.ref is always the plain, variant-/language-less ref (see
// renderVilnaWordBoxes above) -- the variant/language actually being
// browsed live only in the picker, via state.browsePageRef.
function navigateToPlayerAtWord(ref, wordIndex) {
  const parsed = parseDafRef(state.browsePageRef) || {};
  const params = new URLSearchParams({ ref, seekWord: String(wordIndex) });
  if (parsed.variant === 'chazarah') params.set('variant', 'chazarah');
  if (parsed.language === 'he') params.set('language', 'hebrew');
  location.href = `/player/?${params.toString()}`;
}

// The Daf browser's own in-page equivalent of navigateToPlayerAtWord above --
// same "load the tapped word's daf if it isn't already on screen" shape as
// tapScannedWord, but reveals and plays into browse/index.html's own
// .player-card (present in the DOM, just hidden until first needed -- see
// browse/index.html's own comment) instead of leaving the page. Loading a
// different ref here never disturbs which page image is shown: renderVilnaPage
// (via currentVilnaPageKey) always prefers state.browsePageRef over anything
// video/segment-derived, and loadDaf() never touches the view-switch itself.
async function playWordInline(ref, wordIndex) {
  playerCard.classList.add('revealed');
  playerCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
  // ref here is a word box's own per-paragraph ref (e.g. "Berakhot 2a:3" --
  // see page_ocr_align.py/caption_ocr_align.py's shared load_canonical()),
  // but state.dafRef is always the plain daf-level ref (loadDaf() strips
  // the paragraph suffix via canonicalDafRef() before storing it) -- comparing
  // them directly was always unequal, so every single tap re-triggered a
  // full reload (re-cueing the video from scratch, interrupting whatever
  // was already playing) even for a second word on the same, already-loaded
  // page. realDafRef(ref) normalizes to the same plain form state.dafRef
  // actually holds, so a repeat tap on the same daf now correctly skips
  // straight to seeking the already-stable, already-playing video instead
  // of re-racing the YouTube cue-then-seek gap on every tap.
  if (state.dafRef !== realDafRef(ref)) {
    try {
      await loadDaf(ref);
    } catch (error) {
      console.error(error);
      showToast(`Could not load ${ref}: ${error.message}`, 'error');
      return;
    }
  }
  // loadAlignmentData() (shared with the player/studio) deliberately shows
  // the alignment job's own internal title there ("Caption OCR alignment --
  // Chullin 100b, Chullin 101a, Chullin 101b") -- useful for an admin
  // reviewing a sync job, meaningless to a reader just watching. The
  // video's own real title (state.videoSource.label -- the actual channel
  // upload title, once loadDaf's restoreVideoSource has resolved) is what
  // belongs here instead; falls back to the plain daf ref if a video ever
  // has no real label of its own.
  // 'YouTube'/'Direct link' are loadYouTubeVideo/loadDirectVideoUrl's own
  // generic placeholder labels for a source with no real title of its own
  // -- not worth showing over the plain daf ref either.
  const genericLabels = ['YouTube', 'Direct link'];
  const realLabel = state.videoSource?.label && !genericLabels.includes(state.videoSource.label) ? state.videoSource.label : null;
  $('lectureTitle').textContent = realLabel || realDafRef(ref);
  seekToVilnaWord(ref, wordIndex);
  if (isPaused()) await togglePlay();
}

function seekToVilnaWord(ref, wordIndex) {
  const entry = state.wordTimeline.find(
    (e) => e.ref === ref && wordIndex >= e.w0 && wordIndex <= e.w1
  );
  if (entry) {
    state.lastManualScrollAt = 0;
    seek(entry.start + 0.03, true);
    updateActiveSegment(true);
    return;
  }
  // Most alignments only ever carry segment-level timing, not word-level --
  // wordTimeline stays empty for those. Without this fallback, clicking a
  // word on the Vilna page (either the standalone page view or the video
  // overlay) silently did nothing whenever that was the case, while the
  // plain text view kept working fine since .daf-segment's click (see
  // seekToSegment) never depended on word-level data in the first place.
  // A ref can now span several phrase-chunk segments (see
  // caption_ocr_align.py's _split_word_ranges), so prefer the one whose
  // own w0/w1 actually covers this word before falling back to just the
  // first segment with a matching ref.
  const segment = state.segments.find((s) => s.ref === ref && s.w0 !== null && wordIndex >= s.w0 && wordIndex <= s.w1)
    || state.segments.find((s) => s.ref === ref);
  if (!segment) return;
  state.lastManualScrollAt = 0;
  seek(segment.start + 0.03, true);
  updateActiveSegment(true);
}

// --- Camera-scan feature (see scan-daf-page.mjs) ---------------------------
// Point the camera at a physical printed page, recognize which daf it is
// from just its header, then tap any word on the photo to jump the video
// there -- reuses seekToVilnaWord() above, since a scanned word's
// (ref, wordIndex) means the same thing regardless of which view found it.

// Keeps the upload small (scan-daf-page.mjs caps the decoded photo at 8MB)
// and keeps OCR/homography work proportionate -- a raw phone photo can be
// several times this size for no benefit to a small header crop.
const SCAN_MAX_DIMENSION = 1600;
// Corners default to a generous inward inset, not the photo's own edges --
// most photos have some background/table visible around the book, so
// starting the drag handles a little inside a typical framing needs less
// adjustment than starting at the raw edges would. Only actually used now
// when automatic detection (below) can't find anything at all to seed from.
const SCAN_DEFAULT_INSET = 0.06;
const DEFAULT_SCAN_CORNERS = [
  [SCAN_DEFAULT_INSET, SCAN_DEFAULT_INSET],
  [1 - SCAN_DEFAULT_INSET, SCAN_DEFAULT_INSET],
  [1 - SCAN_DEFAULT_INSET, 1 - SCAN_DEFAULT_INSET],
  [SCAN_DEFAULT_INSET, 1 - SCAN_DEFAULT_INSET],
];

// --- Automatic page-corner detection --------------------------------------
// The reader shouldn't have to drag four corners into place for every scan
// -- most of the time the page's edges can be found automatically the
// instant the photo is taken, the same way real "scanner" apps work: find
// the page's quadrilateral in the frame, then feed those corners into the
// exact same homography-projection path the manual step already produces
// (scanCorners, confirmScan). The manual screen survives only as a fallback
// for a photo detection can't read confidently (see autoDetectAndProceed
// and CORNER_CONFIDENCE_THRESHOLD below) -- silently mis-projecting every
// word position on a bad guess would be worse than one extra tap.
//
// NOT YET VALIDATED AGAINST REAL PHONE PHOTOS: this sandbox's headless
// browser has no outbound network access at all (confirmed directly -- even
// a bare `fetch()` to the CDN below fails here), so neither the OpenCV.js
// load nor the detection pipeline's actual accuracy on a real photographed
// page could be exercised end to end during development. The geometry/
// confidence math below (orderQuadPoints, scoreQuadConfidence) is tested
// directly; the CV pipeline itself follows the standard, well-established
// technique real scanner apps use, but its real-world hit rate on an actual
// phone photo is unverified -- same caveat scan-daf-page.mjs already
// documents for the header-OCR step it feeds into.

const OPENCV_JS_VERSION = '4.9.0-release.1';
let openCvPromise = null;

// Lazily loads OpenCV.js (a large WASM build, ~10MB) only once the camera
// scan feature actually needs it -- mirrors loadPdfJs's lazy-CDN-script
// pattern above so nothing else in the app pays for it. Emscripten builds
// have varied across versions in how they signal "actually ready to use"
// (immediately usable, a thenable Module, or an onRuntimeInitialized
// callback) -- this handles all three rather than assuming one, since
// guessing wrong here would just make every scan quietly fall back to the
// manual corner step instead of failing loudly.
function loadOpenCv() {
  if (window.cv?.Mat) return Promise.resolve(window.cv);
  if (openCvPromise) return openCvPromise;
  openCvPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `https://cdn.jsdelivr.net/npm/@techstark/opencv-js@${OPENCV_JS_VERSION}/dist/opencv.js`;
    script.async = true;
    script.onerror = () => {
      openCvPromise = null;
      reject(new Error('Could not load the page-detection library.'));
    };
    script.onload = async () => {
      try {
        let cv = window.cv;
        if (!cv) throw new Error('Page-detection library did not attach itself.');
        if (typeof cv.then === 'function') cv = await cv;
        if (!cv.Mat) await new Promise((ready) => { cv['onRuntimeInitialized'] = ready; });
        window.cv = cv;
        resolve(cv);
      } catch (error) {
        openCvPromise = null;
        reject(error);
      }
    };
    document.head.appendChild(script);
  });
  return openCvPromise;
}

// Runs the standard "flatten a photographed document" pipeline (grayscale ->
// blur -> edge detection -> contour finding -> largest convex 4-sided
// shape) to find the page's corners without the reader marking them by
// hand. Returns 4 corner points in image-pixel space (unordered), or null
// if nothing plausible was found.
function detectPageCorners(cv, imageSource) {
  const src = cv.imread(imageSource);
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const edges = new cv.Mat();
  const dilated = new cv.Mat();
  const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    cv.Canny(blurred, edges, 50, 150);
    cv.dilate(edges, dilated, kernel);
    cv.findContours(dilated, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    let best = null;
    let bestArea = 0;
    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      const approx = new cv.Mat();
      try {
        const perimeter = cv.arcLength(contour, true);
        cv.approxPolyDP(contour, approx, 0.02 * perimeter, true);
        if (approx.rows === 4 && cv.isContourConvex(approx)) {
          const area = cv.contourArea(approx);
          if (area > bestArea) {
            bestArea = area;
            best = [];
            for (let r = 0; r < 4; r++) best.push([approx.data32S[r * 2], approx.data32S[r * 2 + 1]]);
          }
        }
      } finally {
        approx.delete();
        contour.delete();
      }
    }
    return best;
  } finally {
    src.delete();
    gray.delete();
    blurred.delete();
    edges.delete();
    dilated.delete();
    kernel.delete();
    contours.delete();
    hierarchy.delete();
  }
}

// Orders 4 arbitrary quad points into [top-left, top-right, bottom-right,
// bottom-left] -- the standard sum/diff trick (top-left has the smallest
// x+y, bottom-right the largest; top-right has the smallest y-x,
// bottom-left the largest). Matches the order scanCorners has always used
// (see the state comment above), so a detected quad slots in exactly where
// a manually-dragged one would.
function orderQuadPoints(points) {
  const bySum = [...points].sort((a, b) => (a[0] + a[1]) - (b[0] + b[1]));
  const byDiff = [...points].sort((a, b) => (a[1] - a[0]) - (b[1] - b[0]));
  return [bySum[0], byDiff[0], bySum[3], byDiff[3]]; // top-left, top-right, bottom-right, bottom-left
}

// A physical Vilna Shas page's own height/width proportion (not the photo's)
// -- used below to sanity-check a detected quad actually looks like a book
// page rather than some other rectangular thing in frame.
const PAGE_ASPECT_RATIO = 1.42;
const CORNER_CONFIDENCE_THRESHOLD = 0.55;

// Scores how likely a detected (and already-ordered) quadrilateral really is
// the photographed page, so a bad or uncertain detection can fall back to
// manual adjustment instead of silently mis-projecting every word position.
// Not a real probability -- just a monotonic 0-1 heuristic combining three
// signals: how rectangular it is (opposite sides roughly equal length), how
// closely its apparent proportions match a real page's, and how much of the
// frame it fills.
function scoreQuadConfidence(orderedPoints, imageWidth, imageHeight) {
  if (!orderedPoints || orderedPoints.length !== 4 || !imageWidth || !imageHeight) {
    return { score: 0, reason: 'no-quad-found' };
  }
  const [tl, tr, br, bl] = orderedPoints;

  const area = 0.5 * Math.abs(
    (tl[0] * tr[1] - tr[0] * tl[1]) + (tr[0] * br[1] - br[0] * tr[1]) +
    (br[0] * bl[1] - bl[0] * br[1]) + (bl[0] * tl[1] - tl[0] * bl[1])
  );
  const areaRatio = area / (imageWidth * imageHeight);
  if (areaRatio < 0.15) return { score: Math.max(0, 0.1 * (areaRatio / 0.15)), reason: 'too-small' };

  // A quad matching the photo's own four corners almost exactly means no
  // distinct edge was actually found (the same fallback scan-daf-page.mjs
  // uses server-side when no corners are supplied at all) --
  // indistinguishable from "detection didn't really happen."
  const edgeEps = 0.01;
  const bounds = [[0, 0], [imageWidth, 0], [imageWidth, imageHeight], [0, imageHeight]];
  const looksLikeFullFrame = orderedPoints.every(([x, y], i) => {
    const [bx, by] = bounds[i];
    return Math.abs(x - bx) < imageWidth * edgeEps && Math.abs(y - by) < imageHeight * edgeEps;
  });
  if (looksLikeFullFrame) return { score: 0.15, reason: 'matches-full-frame' };

  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const topW = dist(tl, tr), bottomW = dist(bl, br);
  const leftH = dist(tl, bl), rightH = dist(tr, br);
  const widthRatio = Math.min(topW, bottomW) / (Math.max(topW, bottomW) || 1);
  const heightRatio = Math.min(leftH, rightH) / (Math.max(leftH, rightH) || 1);
  const shapeScore = (widthRatio + heightRatio) / 2; // 1 = perfectly parallel opposite sides

  const avgW = (topW + bottomW) / 2, avgH = (leftH + rightH) / 2;
  const apparentRatio = avgH / (avgW || 1);
  const ratioDeviation = Math.abs(apparentRatio - PAGE_ASPECT_RATIO) / PAGE_ASPECT_RATIO;
  const aspectScore = Math.max(0, 1 - ratioDeviation / 0.6); // tolerates up to ~60% deviation (perspective foreshortening)

  const areaScore = Math.min(1, (areaRatio - 0.15) / 0.35); // ramps 0->1 from 15%->50% frame coverage

  const score = Math.max(0, Math.min(1, 0.4 * shapeScore + 0.3 * aspectScore + 0.3 * areaScore));
  return { score, reason: score >= CORNER_CONFIDENCE_THRESHOLD ? 'ok' : 'low-confidence' };
}

// Generous, but bounded -- a real end-to-end trial against this exact code
// path (a realistic synthetic photo run through the real OpenCV.js library)
// surfaced that the library's async init can, at least in some browser
// environments, simply never settle: neither resolve nor reject, well past
// the point a normal load or WASM compile would ever take (confirmed
// separately that both the network fetch and the raw WebAssembly.compile
// step for this exact ~7.5MB module are fast on their own -- the stall is
// somewhere in the library's own runtime bring-up). A bare `await` with no
// timeout would leave the reader stuck on "Finding the page…" forever in
// that case, which is worse than just falling back to the manual step --
// this bounds the wait so a stuck (or merely slow-on-a-weak-device) load
// always degrades gracefully instead.
const AUTO_DETECT_TIMEOUT_MS = 8000;

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

// Tries automatic detection first; only falls back to the manual
// drag-corners screen when detection fails outright, times out, or isn't
// confident enough to trust unattended. On success, skips straight past the
// align screen into confirmScan -- the whole point of this feature -- so a
// normal scan really is just "snap the photo."
async function autoDetectAndProceed() {
  showScanStatus('Finding the page…', 'busy');
  let orderedFractionCorners = null;
  let confidence = 0;
  try {
    const cv = await withTimeout(loadOpenCv(), AUTO_DETECT_TIMEOUT_MS, 'Timed out loading the page-detection library.');
    const img = await loadImageElement(state.scanPhotoDataUrl);
    const quad = detectPageCorners(cv, img);
    if (quad) {
      const ordered = orderQuadPoints(quad);
      confidence = scoreQuadConfidence(ordered, state.scanImageWidth, state.scanImageHeight).score;
      orderedFractionCorners = ordered.map(([x, y]) => [x / state.scanImageWidth, y / state.scanImageHeight]);
    }
  } catch (error) {
    // Best-effort enhancement -- any failure (library didn't load, timed
    // out, no network, WASM unsupported, nothing found) just falls back to
    // the manual step below rather than blocking the scan entirely.
    console.error('Automatic page detection failed:', error);
  }

  if (orderedFractionCorners && confidence >= CORNER_CONFIDENCE_THRESHOLD) {
    state.scanCorners = orderedFractionCorners;
    await confirmScan();
    return;
  }

  state.scanCorners = orderedFractionCorners || DEFAULT_SCAN_CORNERS;
  $('scanAlignHint').textContent = orderedFractionCorners
    ? "We took a guess at the page's edges — drag any corner that's off, then confirm."
    : "Couldn't find the page automatically — drag the four corners to match its real edges, then confirm.";
  $('scanStatus').hidden = true;
  $('scanAlign').hidden = false;
  renderScanCorners();
}

function resetScanUi() {
  $('scanIntro').hidden = false;
  $('scanAlign').hidden = true;
  $('scanResult').hidden = true;
  $('scanStatus').hidden = true;
  $('scanCameraInput').value = '';
  $('scanLibraryInput').value = '';
  state.scanPhotoDataUrl = null;
  state.scanCorners = null;
}

function showScanStatus(message, kind) {
  const el = $('scanStatus');
  el.textContent = message;
  el.className = `scan-status${kind ? ` ${kind}` : ''}`;
  el.hidden = false;
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not decode that image.'));
    img.src = src;
  });
}

function downscaleImageFile(file, maxDimension) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.onload = async () => {
      try {
        const img = await loadImageElement(reader.result);
        const scale = Math.min(1, maxDimension / Math.max(img.naturalWidth, img.naturalHeight));
        const width = Math.round(img.naturalWidth * scale);
        const height = Math.round(img.naturalHeight * scale);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve({ dataUrl: canvas.toDataURL('image/jpeg', 0.85), width, height });
      } catch (error) {
        reject(error);
      }
    };
    reader.readAsDataURL(file);
  });
}

async function handleScanFileSelected(file) {
  if (!file) return;
  try {
    const downscaled = await downscaleImageFile(file, SCAN_MAX_DIMENSION);
    state.scanPhotoDataUrl = downscaled.dataUrl;
    state.scanImageWidth = downscaled.width;
    state.scanImageHeight = downscaled.height;
    $('scanPhoto').src = state.scanPhotoDataUrl;
    $('scanIntro').hidden = true;
    $('scanResult').hidden = true;
    await autoDetectAndProceed();
  } catch (error) {
    console.error(error);
    showScanStatus(`Could not load that photo: ${error.message}`, 'error');
  }
}

function renderScanCorners() {
  if (!state.scanCorners) return;
  document.querySelectorAll('.scan-corner-handle').forEach((handle) => {
    const [x, y] = state.scanCorners[Number(handle.dataset.corner)];
    handle.style.left = `${x * 100}%`;
    handle.style.top = `${y * 100}%`;
  });
  const points = state.scanCorners.map(([x, y]) => `${x * 100},${y * 100}`).join(' ');
  $('scanCornerLines').innerHTML = `<polygon points="${points}"></polygon>`;
}

function handleScanCornerPointerDown(event) {
  state.scanDraggingCorner = Number(event.currentTarget.dataset.corner);
  event.currentTarget.setPointerCapture(event.pointerId);
}

function handleScanCornerPointerMove(event) {
  if (state.scanDraggingCorner === null) return;
  const rect = $('scanAlignWrap').getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  const y = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
  state.scanCorners[state.scanDraggingCorner] = [x, y];
  renderScanCorners();
}

function handleScanCornerPointerUp() {
  state.scanDraggingCorner = null;
}

async function confirmScan() {
  if (!state.scanPhotoDataUrl || !state.scanCorners) return;
  showScanStatus('Reading the page header…', 'busy');
  $('scanConfirmButton').disabled = true;
  try {
    const imageBase64 = state.scanPhotoDataUrl.split(',')[1];
    const corners = state.scanCorners.map(([x, y]) => [x * state.scanImageWidth, y * state.scanImageHeight]);
    const response = await fetch('/api/scan-daf-page', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageBase64,
        imageWidth: state.scanImageWidth,
        imageHeight: state.scanImageHeight,
        corners,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not scan this page.');
    showScanResult(result);
  } catch (error) {
    console.error(error);
    showScanStatus(error.message, 'error');
    // A failed scan needs a concrete next step -- reveal the corner
    // adjustment screen (already seeded with whatever corners were used,
    // auto-detected or not) rather than a dead end. This matters most for
    // the auto-detect path above, which normally skips this screen entirely
    // and would otherwise leave the reader stranded on just an error message
    // with no visible way to retry.
    $('scanAlignHint').textContent = "That didn't work — check the corners match the page's real edges, then try again.";
    $('scanAlign').hidden = false;
    renderScanCorners();
  } finally {
    $('scanConfirmButton').disabled = false;
  }
}

function showScanResult(result) {
  $('scanResultPhoto').src = state.scanPhotoDataUrl;
  $('scanAlign').hidden = true;
  $('scanResult').hidden = false;
  $('scanStatus').hidden = true;
  $('scanResultHint').textContent = `Recognized ${result.ref} — tap any word to jump the video there.`;

  const overlay = $('scanWordOverlay');
  overlay.innerHTML = '';
  for (const box of result.wordBoxes) {
    const el = document.createElement('div');
    el.className = 'scan-word-box';
    el.style.left = `${box.x * 100}%`;
    el.style.top = `${box.y * 100}%`;
    el.style.width = `${box.w * 100}%`;
    el.style.height = `${box.h * 100}%`;
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.addEventListener('click', () => tapScannedWord(result.ref, box.ref, box.wordIndex));
    overlay.appendChild(el);
  }
}

// A scanned word can belong to a different daf than whatever's currently
// loaded (the reader might scan a page before ever loading its video) --
// seekToVilnaWord only knows about the *currently loaded* daf's segments/
// wordTimeline, so load the scanned daf first if it isn't already on screen.
async function tapScannedWord(scannedRef, wordRef, wordIndex) {
  // Scan-only mode (?view=scan) has no video player on this page at all to
  // seek within -- deep-link to the real player instead, same as the Daf
  // browser's own word taps already do via navigateToPlayerAtWord.
  if (state.scanOnlyMode) {
    navigateToPlayerAtWord(wordRef, wordIndex);
    return;
  }
  if (state.dafRef !== scannedRef) {
    try {
      await loadDaf(scannedRef);
    } catch (error) {
      console.error(error);
      showToast(`Could not load ${scannedRef}: ${error.message}`, 'error');
      return;
    }
  }
  seekToVilnaWord(wordRef, wordIndex);
}

// The Vilna-page equivalent of the marking-bar's "Mark here & advance" (or
// the phrase-list editor's "Use current time") -- lets an admin correct
// alignment by clicking the actual word on the real page as the speaker
// says it, instead of stepping through a text list in order. Same
// ref/wordIndex-to-segment resolution as seekToVilnaWord (prefer the
// segment whose own w0/w1 covers this word, since one ref can span several
// phrase chunks; fall back to the first segment with a matching ref), and
// reuses setSegmentStart so this banks/autosaves exactly like every other
// correction path already does.
function markSegmentAtVilnaWord(ref, wordIndex) {
  const index = state.segments.findIndex((s) => s.ref === ref && s.w0 !== null && wordIndex >= s.w0 && wordIndex <= s.w1);
  const resolvedIndex = index !== -1 ? index : state.segments.findIndex((s) => s.ref === ref);
  if (resolvedIndex === -1) return;
  const time = getCurrentTime();
  setSegmentStart(resolvedIndex, time);
  state.editingIndex = Math.min(resolvedIndex + 1, state.segments.length - 1);
  updateMarkTargetUi();
  showToast(`Marked phrase ${resolvedIndex + 1} at ${formatTime(time)}.`);
}

// Highlights every word belonging to the current segment/phrase, not just
// the ones a word-level timeline happens to cover -- segment start/end
// timing is equally solid for both the OCR and voice sync engines, unlike
// wordTimeline, which voice sync only ever populates sparsely (whole
// matched phrases, not every word).
function updateVilnaOverlay() {
  if (!state.vilnaWordEls) return;
  if (!state.vilnaPageMap || $('vilnaPlaceholder').hidden) {
    if (state.vilnaOverlayKey) {
      for (const el of state.vilnaWordEls.values()) el.classList.remove('active');
      state.vilnaOverlayKey = '';
    }
    return;
  }
  const activeSegment = state.segments[state.activeIndex];

  // The YouTube poll re-runs this every 100ms; without this check the
  // active class was being toggled on every single tick even when the
  // highlighted phrase hadn't changed, restarting each box's CSS entrance
  // animation from opacity:0 before it ever finished fading in -- a
  // constant flicker that also read as much dimmer than the steady color
  // it's supposed to settle into. Keyed on activeIndex, not just the ref,
  // since sibling phrase chunks of the same long Sefaria paragraph (see
  // caption_ocr_align.py's _split_word_ranges) share one ref -- deduping on
  // ref alone would miss moving from one phrase to the next within it.
  const dedupKey = activeSegment ? `${state.activeIndex}:${activeSegment.ref}` : '';
  if (dedupKey === state.vilnaOverlayKey) return;
  state.vilnaOverlayKey = dedupKey;

  const activeRef = activeSegment?.ref || '';
  const hasRange = activeSegment && activeSegment.w0 !== null && activeSegment.w1 !== null;
  for (const box of state.vilnaPageMap.wordBoxes) {
    const el = state.vilnaWordEls.get(`${box.ref}:${box.wordIndex}`);
    if (!el) continue;
    const hit = activeRef !== '' && box.ref === activeRef
      && (!hasRange || (box.wordIndex >= activeSegment.w0 && box.wordIndex <= activeSegment.w1));
    el.classList.toggle('active', hit);
  }
}

// While vilnaMarkMode is on, outlines the word(s) belonging to the phrase
// that's about to be marked (state.editingIndex) -- a distinct highlight
// from updateVilnaOverlay's "currently playing" one above, the same
// distinction the phrase-list editor draws between .active and
// .mark-target-row. Called whenever editingIndex changes (updateMarkTargetUi)
// or mark mode itself is toggled, not on every playback tick, so it doesn't
// need updateVilnaOverlay's dedup-key guard.
function updateVilnaMarkTarget() {
  if (!state.vilnaWordEls) return;
  const target = state.vilnaMarkMode ? state.segments[state.editingIndex] : null;
  const hasRange = target && target.w0 !== null && target.w1 !== null;
  for (const box of state.vilnaPageMap?.wordBoxes || []) {
    const el = state.vilnaWordEls.get(`${box.ref}:${box.wordIndex}`);
    if (!el) continue;
    const hit = Boolean(target) && box.ref === target.ref
      && (!hasRange || (box.wordIndex >= target.w0 && box.wordIndex <= target.w1));
    el.classList.toggle('mark-target', hit);
  }
}

// Column-boundary fractions of the rendered (CropBox-consistent) page canvas,
// measured directly against real rendered pages -- see the "strip"/"full"
// crops below. Right-to-left the page is: Ein Mishpat (outer margin) | Rashi
// or its substitute | Gemara | Tosafot or its substitute | Mesorat HaShas and
// stacked marginalia (outer margin, sharing the Tosafot-side column width).
const GEMARA_X0_FRAC = 0.15;
const GEMARA_X1_FRAC = 0.855;
// Wider than the pure-Gemara band so "full page" mode also keeps Rashi and
// Tosafot in frame, while still cropping out the two outer margin columns.
const COMMENTARY_X0_FRAC = 0.05;
const COMMENTARY_X1_FRAC = 0.855;
// When nothing in wordTimeline covers the current instant, the rabbi isn't
// reading Gemara text that has a page position -- "dim" idle mode fades the
// overlay down to this floor instead of hiding it outright.
const IDLE_OPACITY_FLOOR = 0.1;
// videoOverlayZoom multiplies into the mode's base crop width -- 1 is the
// mode's default framing, >1 shows less of the page (more magnified), <1
// shows more. Clamped so the crop never needs to exceed the source image.
const OVERLAY_ZOOM_MIN = 0.6;
const OVERLAY_ZOOM_MAX = 3.5;
// The main page canvas (vilnaPageCanvas) is sized for the reading column it
// sits in -- fine on its own, but the overlay then crops a narrower band out
// of it and blows that crop up further (up to OVERLAY_ZOOM_MAX), so the same
// bitmap that looks crisp in the reader turns visibly soft once magnified
// this way. renderVilnaOverlaySource below rasterizes a second, dedicated
// copy of the same PDF page at a resolution chosen for that magnification,
// so the overlay is downsampling a denser source instead of upsampling a
// fixed one. Capped higher than the main page's MAX_CANVAS_WIDTH_PX since
// it's optional/background work, not something every daf-card render pays
// for.
const OVERLAY_SOURCE_MAX_WIDTH_PX = 3600;

function overlaySourceRenderScale(baseViewportWidth, wrapWidthPx) {
  const dpr = window.devicePixelRatio || 1;
  const bandFrac = COMMENTARY_X1_FRAC - COMMENTARY_X0_FRAC; // the widest crop band either mode uses
  const neededWidthPx = (wrapWidthPx * dpr * OVERLAY_ZOOM_MAX) / bandFrac;
  const scale = neededWidthPx / baseViewportWidth;
  const maxScale = OVERLAY_SOURCE_MAX_WIDTH_PX / baseViewportWidth;
  return Math.min(scale, maxScale);
}

// Kicks off (at most one at a time) a background re-rasterization of the
// current Vilna page sized for the video overlay's own display size, then
// swaps it in for later draws once ready. Never awaited by updateVideoOverlay
// itself -- that runs on every playback tick and a pdf.js render pass is far
// too slow to do inline there, so each tick just draws with whatever source
// is already cached (the plain page canvas until this resolves, the sharper
// one after) rather than blocking on it.
function maybeRefreshVilnaOverlaySource(wrap) {
  const page = state.vilnaPdfPage;
  if (!page || !state.vilnaPageKey) return;
  // Rounded to the nearest 20px so ordinary layout jitter (e.g. a scrollbar
  // appearing) doesn't constantly invalidate and re-render this.
  const wrapWidth = Math.round((wrap.clientWidth || 0) / 20) * 20;
  if (!wrapWidth) return;
  const key = `${state.vilnaPageKey}|${wrapWidth}`;
  if (state.vilnaOverlaySourceKey === key || state.vilnaOverlaySourceRenderingKey === key) return;
  state.vilnaOverlaySourceRenderingKey = key;
  renderVilnaOverlaySource(page, key, wrapWidth).finally(() => {
    if (state.vilnaOverlaySourceRenderingKey === key) state.vilnaOverlaySourceRenderingKey = null;
  });
}

async function renderVilnaOverlaySource(page, key, wrapWidth) {
  try {
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = overlaySourceRenderScale(baseViewport.width, wrapWidth);
    const viewport = page.getViewport({ scale });
    const canvas = state.vilnaOverlaySourceCanvas || document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    state.vilnaOverlaySourceCanvas = canvas;
    state.vilnaOverlaySourceKey = key;
    // Repaint immediately with the now-sharper source rather than waiting for
    // the next playback tick to happen to fire.
    if (state.videoOverlayEnabled) updateVideoOverlay(getCurrentTime());
  } catch {
    // Quality-only background enhancement -- leave the existing fallback
    // (the shared page canvas) in place rather than surfacing an error.
  }
}

// Draws a cropped/zoomed slice of a Vilna page rasterization as a
// semi-transparent layer over the video itself, panning to keep the
// currently-spoken line in view. Prefers the dedicated, higher-resolution
// source above once it's ready (see renderVilnaOverlaySource); falls back to
// the shared page canvas (the same bitmap the regular reader shows) until
// then, or if the daf has since moved on and that source is now stale.
function updateVideoOverlay(time) {
  const wrap = $('videoVilnaOverlay');
  if (!wrap) return;
  if (!state.videoOverlayEnabled || !state.vilnaPageMap) {
    wrap.hidden = true;
    return;
  }
  const mainCanvas = $('vilnaPageCanvas');
  if (!mainCanvas || mainCanvas.hidden || !mainCanvas.width) {
    wrap.hidden = true;
    return;
  }

  const activeSegment = state.segments[state.activeIndex];
  const hasRange = activeSegment && activeSegment.w0 !== null && activeSegment.w1 !== null;
  const activeBoxes = activeSegment
    ? state.vilnaPageMap.wordBoxes.filter((b) => b.ref === activeSegment.ref
        && (!hasRange || (b.wordIndex >= activeSegment.w0 && b.wordIndex <= activeSegment.w1)))
    : [];
  const isIdle = activeBoxes.length === 0;
  if (isIdle && state.videoOverlayIdleMode === 'hide') {
    wrap.hidden = true;
    return;
  }

  wrap.hidden = false;
  wrap.classList.toggle('mode-strip', state.videoOverlayMode === 'strip');
  const effectiveOpacity = isIdle
    ? Math.min(state.videoOverlayOpacity, IDLE_OPACITY_FLOOR)
    : state.videoOverlayOpacity;
  const fadeBackgroundOnly = state.videoOverlayOpacityTarget === 'background';
  // In background-only mode the fade is baked into the pixel alpha below, so
  // the wrapping element itself always stays fully opaque.
  wrap.style.opacity = fadeBackgroundOnly ? '1' : String(effectiveOpacity);

  const canvas = $('videoVilnaCanvas');
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = wrap.clientWidth || 1;
  const cssHeight = wrap.clientHeight || 1;
  const wantW = Math.round(cssWidth * dpr);
  const wantH = Math.round(cssHeight * dpr);
  if (canvas.width !== wantW || canvas.height !== wantH) {
    canvas.width = wantW;
    canvas.height = wantH;
  }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  maybeRefreshVilnaOverlaySource(wrap);
  const overlaySourceReady = state.vilnaOverlaySourceCanvas
    && state.vilnaOverlaySourceKey.startsWith(`${state.vilnaPageKey}|`);
  const source = overlaySourceReady ? state.vilnaOverlaySourceCanvas : mainCanvas;

  const activeY = activeBoxes.length
    ? activeBoxes.reduce((sum, b) => sum + b.y + b.h / 2, 0) / activeBoxes.length
    : 0.15;

  const pageW = source.width;
  const pageH = source.height;
  const x0 = state.videoOverlayMode === 'strip' ? GEMARA_X0_FRAC : COMMENTARY_X0_FRAC;
  const x1 = state.videoOverlayMode === 'strip' ? GEMARA_X1_FRAC : COMMENTARY_X1_FRAC;
  const zoom = Math.max(OVERLAY_ZOOM_MIN, Math.min(OVERLAY_ZOOM_MAX, state.videoOverlayZoom || 1));
  // Pan is a user-chosen nudge on top of the mode's default centering (X) or
  // the auto-follow-the-active-word centering (Y) -- it isn't clamped itself,
  // only the resulting crop rectangle is, so it stays meaningful across zoom
  // levels and doesn't need resetting when the active line moves.
  const sw = Math.min(pageW, ((x1 - x0) / zoom) * pageW);
  const centerX = ((x0 + x1) / 2 + state.videoOverlayPanX) * pageW;
  const sx = Math.max(0, Math.min(Math.max(0, pageW - sw), centerX - sw / 2));

  const scale = canvas.width / sw;
  const visibleSourceH = canvas.height / scale;
  const centerY = (activeY + state.videoOverlayPanY) * pageH;
  const sourceY = Math.max(0, Math.min(Math.max(0, pageH - visibleSourceH), centerY - visibleSourceH / 2));
  ctx.drawImage(source, sx, sourceY, sw, visibleSourceH, 0, 0, canvas.width, canvas.height);
  // Saved so a click on the canvas can be translated back into page-fraction
  // coordinates and matched against a word box (see the click handler below).
  state.videoOverlayTransform = { sx, sourceY, scale, pageW, pageH };

  if (fadeBackgroundOnly) applyBackgroundOnlyFade(ctx, canvas, effectiveOpacity);

  ctx.save();
  ctx.fillStyle = 'rgba(255, 212, 0, 0.55)';
  ctx.globalCompositeOperation = 'multiply';
  for (const box of activeBoxes) {
    const bx = (box.x * pageW - sx) * scale;
    const by = (box.y * pageH - sourceY) * scale;
    const bw = box.w * pageW * scale;
    const bh = box.h * pageH * scale;
    const padX = bw * 0.15;
    const padY = bh * 0.35;
    ctx.fillRect(bx - padX, by - padY, bw + padX * 2, bh + padY * 2);
  }
  ctx.restore();
}

// Fades only the light page background toward transparent while keeping dark
// text at full opacity, by converting each pixel's luminance into an alpha:
// white (luminance 1) gets `opacity`, black (luminance 0) stays fully opaque.
function applyBackgroundOnlyFade(ctx, canvas, opacity) {
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const luminance = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255;
    data[i + 3] = Math.round((opacity + (1 - opacity) * (1 - luminance)) * 255);
  }
  ctx.putImageData(imageData, 0, 0);
}

// The video overlay draws with plain canvas 2D calls (drawImage/fillRect),
// not one DOM element per word like the side-by-side Vilna page view -- the
// crop/zoom/pan changes every tick, so a click is translated back into
// page-fraction coordinates using the transform saved by the last draw,
// then matched against a word box the same way seekToVilnaWord does.
function handleVideoOverlayClick(event) {
  // A drag (pan) or pinch (zoom) still fires a native click on pointerup;
  // swallow it so repositioning the overlay doesn't also seek the video.
  if (overlayDragMoved) {
    overlayDragMoved = false;
    return;
  }
  const t = state.videoOverlayTransform;
  if (!t || !state.vilnaPageMap) return;
  const canvas = $('videoVilnaCanvas');
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;
  const canvasX = (event.clientX - rect.left) * (canvas.width / rect.width);
  const canvasY = (event.clientY - rect.top) * (canvas.height / rect.height);
  const pageX = canvasX / t.scale + t.sx;
  const pageY = canvasY / t.scale + t.sourceY;
  const xFrac = pageX / t.pageW;
  const yFrac = pageY / t.pageH;
  const box = state.vilnaPageMap.wordBoxes.find(
    (b) => xFrac >= b.x && xFrac <= b.x + b.w && yFrac >= b.y && yFrac <= b.y + b.h
  );
  if (box) seekToVilnaWord(box.ref, box.wordIndex);
}

// Drag-to-pan and pinch-to-zoom on the video overlay, so a user can choose
// how much of the page is magnified and which part of it sits over which
// part of the video, independent of the mode's default framing. Tracked with
// Pointer Events (not separate mouse/touch listeners) so one finger drags and
// two fingers pinch through the same pointer map -- a second pointerId
// arriving mid-drag just promotes it to a pinch.
const overlayPointers = new Map();
let overlayDragMoved = false;
let overlayDragStart = null; // { x, y, panX, panY }
let overlayPinchStart = null; // { dist, midX, midY, zoom, panX, panY }

function overlayPointToCanvasPx(clientX, clientY) {
  const canvas = $('videoVilnaCanvas');
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  return {
    x: (clientX - rect.left) * (canvas.width / rect.width),
    y: (clientY - rect.top) * (canvas.height / rect.height)
  };
}

function pointerMidpoint() {
  const pts = [...overlayPointers.values()];
  return { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
}

function pointerDistance() {
  const pts = [...overlayPointers.values()];
  return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
}

function syncOverlayZoomSlider() {
  const value = String(Math.round(state.videoOverlayZoom * 100));
  for (const id of ['overlayZoomSlider', 'overlayZoomSliderInVideo']) {
    const slider = $(id);
    if (slider) slider.value = value;
  }
}

function handleOverlayPointerDown(event) {
  const canvas = $('videoVilnaCanvas');
  canvas.setPointerCapture(event.pointerId);
  const pt = overlayPointToCanvasPx(event.clientX, event.clientY);
  if (!pt) return;
  overlayPointers.set(event.pointerId, pt);
  if (overlayPointers.size === 1) {
    overlayDragMoved = false;
    overlayDragStart = { x: pt.x, y: pt.y, panX: state.videoOverlayPanX, panY: state.videoOverlayPanY };
    overlayPinchStart = null;
  } else if (overlayPointers.size === 2) {
    overlayDragMoved = true; // a pinch is never a click, on either finger
    const mid = pointerMidpoint();
    overlayPinchStart = {
      dist: pointerDistance(),
      midX: mid.x,
      midY: mid.y,
      zoom: state.videoOverlayZoom,
      panX: state.videoOverlayPanX,
      panY: state.videoOverlayPanY
    };
  }
}

function handleOverlayPointerMove(event) {
  if (!overlayPointers.has(event.pointerId)) return;
  const pt = overlayPointToCanvasPx(event.clientX, event.clientY);
  if (!pt) return;
  overlayPointers.set(event.pointerId, pt);
  const t = state.videoOverlayTransform;
  if (!t) return;

  if (overlayPointers.size >= 2 && overlayPinchStart) {
    const dist = pointerDistance();
    const ratio = dist / (overlayPinchStart.dist || dist || 1);
    state.videoOverlayZoom = Math.max(OVERLAY_ZOOM_MIN, Math.min(OVERLAY_ZOOM_MAX, overlayPinchStart.zoom * ratio));
    const mid = pointerMidpoint();
    state.videoOverlayPanX = overlayPinchStart.panX - (mid.x - overlayPinchStart.midX) / t.scale / t.pageW;
    state.videoOverlayPanY = overlayPinchStart.panY - (mid.y - overlayPinchStart.midY) / t.scale / t.pageH;
    syncOverlayZoomSlider();
    updateVideoOverlay(getCurrentTime());
  } else if (overlayDragStart) {
    const dx = pt.x - overlayDragStart.x;
    const dy = pt.y - overlayDragStart.y;
    if (Math.hypot(dx, dy) > 6) overlayDragMoved = true;
    state.videoOverlayPanX = overlayDragStart.panX - dx / t.scale / t.pageW;
    state.videoOverlayPanY = overlayDragStart.panY - dy / t.scale / t.pageH;
    updateVideoOverlay(getCurrentTime());
  }
}

function handleOverlayPointerUp(event) {
  overlayPointers.delete(event.pointerId);
  if (overlayPointers.size < 2) overlayPinchStart = null;
  if (overlayPointers.size === 1) {
    // One finger remains after a pinch or after the primary drag pointer
    // lifted -- re-baseline so the remaining finger doesn't jump the pan.
    const [[, pt]] = overlayPointers;
    overlayDragStart = { x: pt.x, y: pt.y, panX: state.videoOverlayPanX, panY: state.videoOverlayPanY };
  } else if (overlayPointers.size === 0) {
    overlayDragStart = null;
  }
}

function handleOverlayWheel(event) {
  event.preventDefault();
  const factor = event.deltaY < 0 ? 1.08 : 1 / 1.08;
  state.videoOverlayZoom = Math.max(OVERLAY_ZOOM_MIN, Math.min(OVERLAY_ZOOM_MAX, state.videoOverlayZoom * factor));
  syncOverlayZoomSlider();
  updateVideoOverlay(getCurrentTime());
}

function toggleVideoFullscreen() {
  const frame = $('videoFrame');
  if (document.fullscreenElement === frame) {
    document.exitFullscreen();
  } else {
    frame.requestFullscreen?.().catch((error) => showToast(`Fullscreen not available: ${error.message}`, 'error'));
  }
}

// The daf text itself needs no per-tick work any more -- .daf-segment.active
// (set in buildSegmentSpan/renderDafWindow whenever the active segment
// changes) is the whole highlight. Only the two page-image overlays track
// playback position within a segment.
function updateActiveWords(time) {
  updateVilnaOverlay(time);
  updateVideoOverlay(time);
}

function updateActiveSegment(force = false, timeOverride = null) {
  const time = timeOverride ?? getCurrentTime();
  const index = findSegmentAt(time);
  if (!force && index === state.activeIndex) {
    updateActiveWords(time);
    // Unlike the rest of this function, the fast-forward button's
    // enabled/disabled state can change *within* the same segment (it's
    // driven by wordTimeline entries, which are finer-grained than segments
    // -- see nextReadingTime), not just when the active segment itself
    // changes, so this needs to keep running on every tick, not only here.
    updateFastForwardButtonUi(time);
    return;
  }
  state.activeIndex = index;
  updateFastForwardButtonUi(time);
  const active = state.segments[index];
  if (!active) return;

  renderDafWindow();
  updateActiveWords(time);
  renderVilnaPage();
  document.querySelectorAll('.editor-row').forEach((node, i) => node.classList.toggle('active', i === index));

  $('currentPhrase').textContent = active.he;
  $('currentTranslation').textContent = active.en || 'Translation not loaded.';
  const activeDaf = parseDafRef(active.ref);
  $('currentRef').textContent = activeDaf
    ? `${activeDaf.tractate} ${activeDaf.daf}${activeDaf.amud} · Segment ${index + 1}`
    : `${state.dafRef} · Segment ${index + 1}`;

  const recentlyScrolledManually = Date.now() - state.lastManualScrollAt < AUTO_SCROLL_RESUME_MS;
  if ($('autoScroll').checked && timeOverride === null && !recentlyScrolledManually) {
    const node = document.querySelector(`.daf-segment[data-index="${index}"]`);
    node?.scrollIntoView({ block: 'center', behavior: force ? 'auto' : 'smooth' });
  }
}

function applyDuration(duration, resetDefault = true) {
  if (!Number.isFinite(duration) || duration <= 0) return;
  scrubberEls.forEach((el) => { el.max = String(duration); });
  $('duration').textContent = formatTime(duration);
  if (resetDefault && state.alignmentDuration > 0 && Math.abs(duration - state.alignmentDuration) > 5) {
    showToast(
      `This video is ${formatTime(duration)} long, but the synced daf was built from a ${formatTime(state.alignmentDuration)} video — ` +
      `they don't match, so the highlighting will be off. Load the exact video that was analyzed.`,
      'error'
    );
  }
  if (resetDefault && state.usingDefaultAlignment) {
    const mappedEnd = state.segments.at(-1)?.end || 0;
    if (Math.abs(mappedEnd - duration) > 1) resetEvenSpacing(true);
  }
  updateTimeline();
}

function updateTimeline() {
  const current = getCurrentTime();
  const duration = getDuration() || Number(scrubber.max) || 0;
  if (duration > 0 && Number(scrubber.max) !== duration) scrubberEls.forEach((el) => { el.max = String(duration); });
  if (!state.seeking) scrubberEls.forEach((el) => { el.value = String(Math.min(current, duration || current)); });
  $('currentTime').textContent = formatTime(current);
  $('duration').textContent = formatTime(duration);
  if ($('inlineTimeLabel')) $('inlineTimeLabel').textContent = `${formatTime(current)} / ${formatTime(duration)}`;
  updateScrubberFill();
  updateActiveSegment();
}

function updateScrubberFill() {
  const max = Number(scrubber.max) || 1;
  for (const el of scrubberEls) {
    const percent = Math.min(100, Math.max(0, (Number(el.value) || 0) / max * 100));
    el.style.background = `linear-gradient(to right, var(--accent) 0%, var(--accent) ${percent}%, rgba(255,255,255,.14) ${percent}%, rgba(255,255,255,.14) 100%)`;
  }
}

function updatePlayUi() {
  const paused = isPaused();
  document.querySelectorAll('.play-icon').forEach((el) => { el.hidden = !paused; });
  document.querySelectorAll('.pause-icon').forEach((el) => { el.hidden = paused; });
  $('largePlay').hidden = !state.videoSource || !paused || getCurrentTime() > 0.15;
  $('playButton').setAttribute('aria-label', paused ? 'Play' : 'Pause');
  $('inlinePlayButton')?.setAttribute('aria-label', paused ? 'Play' : 'Pause');
}

async function togglePlay() {
  try {
    if (state.playerType === 'youtube') {
      if (!state.youtubeReady) throw new Error('The YouTube player is not ready yet.');
      if (isPaused()) state.youtubePlayer.playVideo(); else state.youtubePlayer.pauseVideo();
    } else if (htmlVideo.paused) {
      await htmlVideo.play();
    } else {
      htmlVideo.pause();
    }
  } catch (error) {
    showToast(error.message || 'The browser could not play this video.', 'error');
  }
}

// A YouTube seekTo() issued moments after cueVideoById/onReady can be
// silently ignored by the player -- it reports a valid duration (and
// youtubeReady goes true) before it's actually able to honor a seek, so the
// request looks like it worked while the video just keeps playing from
// wherever it naturally started. There's no "seek was actually accepted"
// event on the IFrame API to await instead, so the only way to catch this is
// to check back and retry. Without this, the scrubber/time labels (updated
// optimistically below, on the assumption the seek took) would permanently
// disagree with the real, unmoved video -- exactly what "Continue watching"
// resuming a saved position right after a video loads would trigger.
//
// `generation` guards against a stale retry chain fighting a newer, unrelated
// seek -- e.g. a resume-on-load retry still pending when the reader drags the
// scrubber themselves a moment later. Every fresh top-level call (attempt 0)
// claims a new generation; a retry only fires if nothing newer has started.
//
// 20 attempts (~8s) rather than the original 5 (~2s): a *freshly constructed*
// player cueing its very first video -- the Daf browser's inline video and
// the camera-scan page's deep link both hit exactly this case on every tap,
// not just the occasional "resume where I left off" -- can take meaningfully
// longer than 2 seconds to become seek-ready, especially on a slower
// connection. The old budget gave up silently well within that window,
// which is exactly what "tapping a word just plays from the beginning"
// looked like: not a missing retry, just not enough of it.
let seekGeneration = 0;
function seekYouTubePlayer(time, allowSeekAhead, attempt = 0, generation = ++seekGeneration) {
  const player = state.youtubePlayer;
  if (!player?.seekTo) return;
  player.seekTo(time, allowSeekAhead);
  if (attempt >= 20) return;
  setTimeout(() => {
    if (generation !== seekGeneration) return; // superseded by a newer seek request
    if (state.playerType !== 'youtube' || state.youtubePlayer !== player) return; // moved on since
    const actual = Number(player.getCurrentTime?.()) || 0;
    if (Math.abs(actual - time) > 2) seekYouTubePlayer(time, allowSeekAhead, attempt + 1, generation);
  }, 400);
}

// Unlike YouTube's IFrame API (no reliable "ready to seek" event -- see
// seekYouTubePlayer's own comment above), a plain <video> element does have
// one: readyState reaches HAVE_METADATA (1) once seeking is actually honored.
// Setting currentTime before that is silently ignored -- the same "looks
// like it worked, the video just plays from wherever it actually started"
// failure as the YouTube race, just for the direct-video-link path instead
// (loadDirectVideoUrl reassigns src/calls load() without waiting for
// anything, so a seek requested moments later -- e.g. the Daf browser's
// inline video, tapping a word right after the daf/video finish loading --
// routinely lands before metadata's in). `token` is the same kind of guard
// as seekYouTubePlayer's `generation`: if the src changes again (a newer
// video) before this fires, the stale listener must not seek the new video
// to the old target.
let htmlSeekToken = 0;
function seekHtmlVideo(time) {
  const token = ++htmlSeekToken;
  if (htmlVideo.readyState >= 1) {
    htmlVideo.currentTime = time;
    return;
  }
  const onLoadedMetadata = () => {
    htmlVideo.removeEventListener('loadedmetadata', onLoadedMetadata);
    if (token !== htmlSeekToken) return; // superseded by a newer seek/video since
    htmlVideo.currentTime = time;
  };
  htmlVideo.addEventListener('loadedmetadata', onLoadedMetadata);
}

function seek(time, allowSeekAhead = true) {
  const max = getDuration() || Number(scrubber.max) || 0;
  const clamped = Math.max(0, Math.min(time, max || time));

  if (state.playerType === 'youtube') {
    if (state.youtubeReady) seekYouTubePlayer(clamped, allowSeekAhead);
  } else {
    seekHtmlVideo(clamped);
  }

  scrubberEls.forEach((el) => { el.value = String(clamped); });
  $('currentTime').textContent = formatTime(clamped);
  if ($('inlineTimeLabel')) $('inlineTimeLabel').textContent = `${formatTime(clamped)} / ${formatTime(max)}`;
  updateScrubberFill();
  updateActiveSegment(true, clamped);
}

function seekToSegment(index) {
  selectEditingIndex(index);
  const segment = state.segments[index];
  if (!segment) return;
  state.lastManualScrollAt = 0;
  seek(segment.start + 0.03, true);
  updateActiveSegment(true);
}


function updateMarkTargetUi() {
  const total = state.segments.length;
  const index = Math.min(Math.max(state.editingIndex, 0), Math.max(total - 1, 0));
  state.editingIndex = index;
  const label = $('markTargetLabel');
  if (label) label.textContent = total ? `${index + 1} of ${total}` : 'No phrase';
  renderDafWindow();
  document.querySelectorAll('.editor-row').forEach((node, i) => node.classList.toggle('mark-target-row', i === index));
  updateVilnaMarkTarget();
}

function selectEditingIndex(index) {
  if (!state.segments.length) return;
  state.editingIndex = Math.min(Math.max(Number(index) || 0, 0), state.segments.length - 1);
  updateMarkTargetUi();
}

function markHereAndAdvance() {
  const segment = state.segments[state.editingIndex];
  if (!segment) return showToast('Load a daf before marking timestamps.', 'error');
  const time = Number(getCurrentTime().toFixed(2));
  const index = state.editingIndex;
  segment.start = time;
  if (index > 0) state.segments[index - 1].end = time;
  const nextStart = state.segments[index + 1]?.start;
  if (segment.end <= time) segment.end = nextStart > time ? nextStart : time + 3;
  state.usingDefaultAlignment = false;
  state.alignmentStatus = index === state.segments.length - 1 ? 'complete' : 'in-progress';
  updateAlignmentStatus();
  if (index < state.segments.length - 1) state.editingIndex += 1;
  renderDaf();
  saveDraft(true);
  showToast(`Marked phrase ${index + 1} at ${formatTime(time)}${index < state.segments.length - 1 ? ' and advanced.' : '.'}`);
}

// Banks a from-scratch manual phrase sync (no automated engine's guess to
// diff against -- see save-word-sync.mjs) as ground-truth training data:
// the exact (phrase text, real timestamp) pairs the admin hand-defined and
// tapped in. Skipped when voiceCorrectionBaseline is set, since
// bankVoiceCorrection() already banks that case as a correction diff
// instead -- the two shouldn't both fire for the same edit. Only called
// from the explicit "Save draft" click, same reasoning as
// bankVoiceCorrection: each call commits a file to the results branch.
async function bankManualPhraseSync() {
  if (state.voiceCorrectionBaseline) return;
  if (state.usingDefaultAlignment || !state.segments.length) return;
  try {
    const response = await fetch('/api/save-word-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ref: state.dafRef,
        videoSource: state.videoSource,
        segments: state.segments.map((s) => ({ ref: s.ref, start: s.start, end: s.end, he: s.he })),
      }),
    });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'save failed');
  } catch (error) {
    console.error('Could not bank the manual phrase sync.', error);
  }
}

function setPlaybackRate(rate) {
  if (state.playerType === 'youtube') {
    if (state.youtubeReady) state.youtubePlayer.setPlaybackRate(rate);
  } else {
    htmlVideo.playbackRate = rate;
  }
}

// Volume: 0-100 either way, matching the sliders -- YouTube's own API is
// already that scale, htmlVideo.volume just needs /100.
function isMuted() {
  if (state.playerType === 'youtube' && state.youtubeReady) return Boolean(state.youtubePlayer.isMuted?.());
  return Boolean(htmlVideo.muted);
}

function updateMuteIcons() {
  const muted = isMuted();
  for (const button of muteButtonEls) {
    const volumeIcon = button.querySelector('.volume-icon');
    const mutedIcon = button.querySelector('.muted-icon');
    if (volumeIcon) volumeIcon.hidden = muted;
    if (mutedIcon) mutedIcon.hidden = !muted;
    button.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
  }
}

function setMuted(muted) {
  if (state.playerType === 'youtube') {
    if (state.youtubeReady) { if (muted) state.youtubePlayer.mute(); else state.youtubePlayer.unMute(); }
  } else {
    htmlVideo.muted = muted;
  }
  updateMuteIcons();
}

function setVolume(volume) {
  const clamped = Math.max(0, Math.min(100, Math.round(volume)));
  if (state.playerType === 'youtube') {
    if (state.youtubeReady) state.youtubePlayer.setVolume(clamped);
  } else {
    htmlVideo.volume = clamped / 100;
  }
  for (const el of volumeSliderEls) el.value = String(clamped);
  // Dragging the level up while muted should audibly unmute -- otherwise
  // moving the slider looks like it did nothing.
  if (clamped > 0 && isMuted()) setMuted(false);
}

// Reflects whatever the active player's own actual volume/mute state is
// (YouTube typically starts at 100, but keeps whatever a reader last set
// within the page's own session; htmlVideo starts at 100/unmuted) into the
// UI -- called once a player actually has a real volume to report, since
// asking a YouTube player that isn't ready yet just throws.
function syncVolumeUi() {
  const volume = state.playerType === 'youtube'
    ? (state.youtubeReady ? Number(state.youtubePlayer.getVolume?.()) : null)
    : Math.round((htmlVideo.volume ?? 1) * 100);
  if (volume != null && Number.isFinite(volume)) {
    for (const el of volumeSliderEls) el.value = String(volume);
  }
  updateMuteIcons();
}

function resetEvenSpacing(silent = false) {
  if (!state.segments.length) return;
  const duration = getDuration() || Math.max(...state.segments.map((segment) => segment.end), 48);
  const length = duration / state.segments.length;
  state.segments = state.segments.map((segment, index) => ({
    ...segment,
    start: Number((index * length).toFixed(2)),
    end: Number(((index + 1) * length).toFixed(2))
  }));
  renderDaf();
  if (!silent) showToast('Segments reset to even spacing.');
}

// Setting a segment's start time this way (nudging, or "Use current time")
// only ever touches .start, never .end directly -- normalizeSegmentOrder
// already keeps the previous segment's .end chained to match, so a reader
// only ever has to reason about "where does this phrase begin," not two
// separately-editable, secretly-linked numbers for the same boundary (what
// the old start/end input pair actually was, just not obviously so).
function setSegmentStart(index, time) {
  const clamped = Math.max(0, Number(time.toFixed(2)));
  state.segments[index].start = clamped;
  state.segments[index].estimated = false;
  normalizeSegmentOrder(index, 'start');
  state.usingDefaultAlignment = false;
  state.alignmentStatus = index === state.segments.length - 1 ? 'complete' : 'in-progress';
  updateAlignmentStatus();
  renderDaf();
  saveDraft(true);
}

// Manual phrase-boundary editing: instead of trusting a backend engine's
// guess at where one phrase ends and the next begins, the admin carves the
// text up themselves by clicking the word a new phrase should start at --
// "full control of selecting individual words," just applied to defining a
// phrase's boundaries rather than syncing single words. Only splits within
// one segment's own text, so a segment's ref/w0/w1 (when known) always stay
// inside their original parent paragraph.
function splitSegmentAtWord(index, wordIndex) {
  const segment = state.segments[index];
  if (!segment) return;
  const words = segment.he.trim().split(/\s+/);
  if (wordIndex <= 0 || wordIndex >= words.length) return; // nothing to split there
  const nextStart = state.segments[index + 1]?.start;
  const placeholderStart = Math.max(segment.start, nextStart != null
    ? (segment.start + nextStart) / 2
    : segment.start + 1);
  const newSegment = {
    id: `${segment.id || 'segment'}-split-${Date.now()}`,
    ref: segment.ref,
    start: Number(placeholderStart.toFixed(2)),
    end: segment.end,
    he: words.slice(wordIndex).join(' '),
    en: '',
    estimated: true,
    w0: segment.w0 != null ? segment.w0 + wordIndex : null,
    w1: segment.w1 != null ? segment.w1 : null
  };
  segment.he = words.slice(0, wordIndex).join(' ');
  segment.end = newSegment.start;
  if (segment.w1 != null) segment.w1 = segment.w0 + wordIndex - 1;
  state.segments.splice(index + 1, 0, newSegment);
  if (state.editingIndex > index) state.editingIndex += 1;
  state.usingDefaultAlignment = false;
  renderDaf();
  saveDraft(true);
}

// The inverse: undoing an over-eager split. Only offered between segments
// that share a ref (the same parent paragraph) -- merging across a
// paragraph boundary wouldn't mean anything for w0/w1 or for later
// re-splitting.
function mergeSegmentWithNext(index) {
  const segment = state.segments[index];
  const next = state.segments[index + 1];
  if (!segment || !next || next.ref !== segment.ref) return;
  segment.he = `${segment.he.trim()} ${next.he.trim()}`.trim();
  segment.end = next.end;
  if (segment.w1 != null && next.w1 != null) segment.w1 = next.w1;
  state.segments.splice(index + 1, 1);
  if (state.editingIndex > index + 1) state.editingIndex -= 1;
  else if (state.editingIndex === index + 1) state.editingIndex = index;
  state.activeIndex = Math.min(state.activeIndex, state.segments.length - 1);
  state.usingDefaultAlignment = false;
  renderDaf();
  saveDraft(true);
}

function togglePhraseEditMode() {
  state.phraseEditMode = !state.phraseEditMode;
  $('phraseEditModeButton')?.classList.toggle('active', state.phraseEditMode);
  renderEditor();
}

// Turns Vilna-page word clicks from "seek there" into "mark this phrase's
// start at the current playback time" (see markSegmentAtVilnaWord) --
// correcting alignment by clicking the real word on the real page as the
// speaker says it, instead of stepping through the phrase list. Works
// alongside the marking-bar/phrase-list editor, not instead of them: they
// all drive the same state.editingIndex/state.segments, so a correction
// started one way can be finished the other. Only meaningful while looking
// at the page itself (word click targets don't exist in the plain-text
// view), so turning it on switches there; it doesn't switch back off when
// turned off, since an admin may still want the page visible afterward.
function toggleVilnaMarkMode() {
  if (!state.vilnaMarkMode && !state.vilnaPageMap) {
    showToast("This daf's Vilna page hasn't been synced yet -- open the Vilna page tab first.", 'error');
    return;
  }
  state.vilnaMarkMode = !state.vilnaMarkMode;
  $('vilnaMarkModeButton')?.classList.toggle('active', state.vilnaMarkMode);
  $('vilnaMarkModeButton')?.setAttribute('aria-pressed', String(state.vilnaMarkMode));
  $('vilnaPageWrap')?.classList.toggle('mark-mode', state.vilnaMarkMode);
  if (state.vilnaMarkMode) switchDafView('page');
  updateVilnaMarkTarget();
}

const NUDGE_STEPS = [-1, -0.1, 0.1, 1];

function renderEditor() {
  editorBody.innerHTML = '';
  state.segments.forEach((segment, index) => {
    const row = document.createElement('div');
    row.className = `editor-row${index === state.activeIndex ? ' active' : ''}${index === state.editingIndex ? ' mark-target-row' : ''}${segment.estimated ? ' estimated' : ''}`;
    const nudgeButtons = NUDGE_STEPS.map((delta) => `
      <button type="button" class="nudge-btn" data-index="${index}" data-delta="${delta}"
        aria-label="Nudge segment ${index + 1}'s start ${delta > 0 ? 'later' : 'earlier'} by ${Math.abs(delta)}s">
        ${delta > 0 ? '+' : '−'}${Math.abs(delta)}
      </button>`).join('');
    // "estimated" segments are ones voice_align.py (or an OCR pass with
    // patchy caption coverage) never actually matched -- they're only here,
    // with a guessed placeholder time, so the daf's full text is still
    // visible and correctable instead of silently missing. The badge is the
    // only thing telling a corrector "this one's a guess, not a real match."
    const badge = segment.estimated
      ? '<span class="editor-estimated-badge" title="Not matched automatically -- this time is only a rough placeholder.">needs review</span>'
      : '';
    // Phrase-edit mode: click any word other than the first to split the
    // phrase there -- the admin decides where phrases begin and end
    // themselves, instead of a fixed word-count/pause-detection splitter
    // deciding it for them.
    const phraseBody = state.phraseEditMode
      ? segment.he.trim().split(/\s+/).map((word, w) => `<span class="split-word${w === 0 ? ' split-word-first' : ''}" data-index="${index}" data-word="${w}" title="${w === 0 ? '' : 'Split the phrase here'}">${escapeHtml(word)}</span>`).join(' ')
      : escapeHtml(segment.he);
    const mergeButton = state.phraseEditMode && index < state.segments.length - 1 && state.segments[index + 1].ref === segment.ref
      ? `<button type="button" class="button secondary small merge-next" data-index="${index}" title="Merge this phrase with the next one">⤒ Merge with next</button>`
      : '';
    row.innerHTML = `
      <span class="editor-row-num">${index + 1}</span>
      <span class="editor-time">
        <span class="editor-time-display" aria-label="Segment ${index + 1} starts at">${formatTimePrecise(segment.start)}</span>
        ${nudgeButtons}
      </span>
      <span class="editor-phrase">${phraseBody}${badge}</span>
      ${mergeButton}
      <button class="button secondary small use-time" data-index="${index}">Use current time</button>`;
    row.addEventListener('click', (event) => {
      if (event.target.closest('button, .split-word')) return;
      selectEditingIndex(index);
    });
    editorBody.appendChild(row);
  });

  editorBody.querySelectorAll('.split-word:not(.split-word-first)').forEach((el) => {
    el.addEventListener('click', (event) => {
      const index = Number(event.currentTarget.dataset.index);
      const wordIndex = Number(event.currentTarget.dataset.word);
      splitSegmentAtWord(index, wordIndex);
    });
  });

  editorBody.querySelectorAll('.merge-next').forEach((button) => {
    button.addEventListener('click', (event) => {
      mergeSegmentWithNext(Number(event.currentTarget.dataset.index));
    });
  });

  editorBody.querySelectorAll('.nudge-btn').forEach((button) => {
    button.addEventListener('click', (event) => {
      const index = Number(event.currentTarget.dataset.index);
      const delta = Number(event.currentTarget.dataset.delta);
      setSegmentStart(index, state.segments[index].start + delta);
    });
  });

  editorBody.querySelectorAll('.use-time').forEach((button) => {
    button.addEventListener('click', (event) => {
      const index = Number(event.currentTarget.dataset.index);
      const time = getCurrentTime();
      setSegmentStart(index, time);
      state.editingIndex = Math.min(index + 1, state.segments.length - 1);
      showToast(`Segment ${index + 1} now begins at ${formatTime(time)}.`);
    });
  });
}

function normalizeSegmentOrder(index, field) {
  const segment = state.segments[index];
  if (segment.end <= segment.start) segment.end = segment.start + 0.1;
  if (field === 'start' && index > 0) state.segments[index - 1].end = segment.start;
  if (field === 'end' && index < state.segments.length - 1) state.segments[index + 1].start = segment.end;
}

async function loadDaf(refOverride = null, options = {}) {
  const ref = canonicalDafRef(String(refOverride || $('dafRef').value).trim());
  $('dafRef').value = ref;
  syncDafPickerFromRef(ref);
  // Deliberately not awaited: whether this daf offers a one-click sync is
  // independent of loading its text, and loadDaf returns early down several
  // paths below (already-synced, saved locally) that would otherwise each
  // need their own call.
  refreshQuickSync(ref);
  if (!ref) return showToast('Enter a Sefaria reference first.', 'error');

  // A daf already synced through the Drive/server job is published on
  // GitHub keyed by reference, so check that first -- it works on any
  // device, not just the one that ran the sync. Only fall back to this
  // browser's own saved copy (a manual import, or a locally-synced video
  // that never goes through the server) if the server doesn't have it.
  // Caption-OCR and voice-recognition syncs publish under separate keys
  // (see refKey()) specifically so both can exist for the same daf at
  // once -- fetched together here so the switch UI (updateSyncMethodSwitchUi)
  // knows immediately whether there's a choice to offer, not just whichever
  // one happens to load first.
  const [ocrAlignment, voiceAlignment] = await Promise.all([
    fetchServerAlignment(ref),
    fetchServerAlignment(ref, { voice: true }),
  ]);
  state.availableSyncMethods = { ocr: ocrAlignment, voice: voiceAlignment };
  state.activeSyncMethod = ocrAlignment ? 'ocr' : (voiceAlignment ? 'voice' : null);
  updateSyncMethodSwitchUi();
  // Caption-OCR preferred as the default view when both exist -- it's the
  // more established of the two engines; the reader can switch to voice
  // recognition from the toggle this just made visible.
  const serverAlignment = ocrAlignment || voiceAlignment;
  if (serverAlignment) {
    // The server's own videoSource is never actually playable -- it's
    // just the generic local filename the OCR job used internally
    // (e.g. "job-video.mp4"), not a real YouTube/direct link. Prefer a
    // real link already known for this daf, whether saved on this
    // browser or on another device, over letting that placeholder
    // silently overwrite it.
    const preferredVideoSource = await resolvePreferredVideoSource(ref, loadProjectForRef(ref));
    if (preferredVideoSource) serverAlignment.videoSource = preferredVideoSource;
    await loadAlignmentData(serverAlignment, { dafRefOverride: ref });
    // Published alignments (especially older ones, or a voice sync that
    // only ever locks onto part of the daf) can be missing whole
    // paragraphs of canonical text -- fill those in from Sefaria directly
    // rather than requiring a fresh sync job just to get the rest of the
    // daf on screen for review.
    if (await fillMissingDafText(realDafRef(ref))) renderDaf();
    if (!options.silent) showToast(`Loaded the synced alignment for ${ref} from the server.`);
    return;
  }
  const saved = loadProjectForRef(ref);
  if (saved && Array.isArray(saved.segments) && saved.segments.length) {
    await loadAlignmentData(saved, { dafRefOverride: ref });
    if (!options.silent) showToast(`Restored the saved sync for ${ref}.`);
    return;
  }
  // Restore a known video link before the text fetch below, not after --
  // it shouldn't depend on Sefaria's fetch succeeding. Checks this
  // browser's own saved link first, then the one published for this daf
  // reference on the server (from another device), if any.
  const preferredVideoSource = await resolvePreferredVideoSource(ref, saved);
  if (preferredVideoSource) {
    // Explicit [ref] here, not the default (state.segments-derived) covered
    // refs -- at this point in loadDaf(), state.segments/state.dafRef still
    // hold the *previous* daf's data (this one hasn't matched a synced
    // alignment or saved project), so deriving refs from live state would
    // tag the link onto the wrong daf.
    try { await restoreVideoSource(preferredVideoSource, [ref]); } catch (error) { console.error(error); }
  }

  const button = $('loadDafButton');
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Loading…';
  try {
    // Sefaria only knows tractate/daf/amud, never the "(Chazarah Daf)"/
    // "(Hebrew)" variant markers `ref` can carry -- sending those through
    // 404s the request outright, which used to break daf-text loading for
    // any chazarah/Hebrew ref that didn't already have a synced alignment
    // cached under by-ref/ (see realDafRef's own comment).
    const sefariaRef = realDafRef(ref);
    const { heRef, paragraphs } = await fetchSefariaParagraphs(sefariaRef);

    state.dafRef = ref;
    state.wordTimeline = [];
    const duration = getDuration() || Number(scrubber.max) || 48;
    const length = duration / paragraphs.length;
    state.segments = paragraphs.map((paragraph, index) => {
      const words = paragraph.he.trim().split(/\s+/);
      return {
        id: `${ref.replace(/\W+/g, '-').toLowerCase()}-${index + 1}`,
        ref: paragraph.ref,
        start: Number((index * length).toFixed(2)),
        end: Number(((index + 1) * length).toFixed(2)),
        he: paragraph.he,
        en: paragraph.en,
        // Whole-paragraph bounds to start -- splitSegmentAtWord narrows
        // these as the admin carves the paragraph into hand-picked phrases.
        w0: 0,
        w1: words.length - 1
      };
    });
    state.activeIndex = 0;
    state.editingIndex = 0;
    // Reaching this branch at all means there was no real synced alignment
    // to load (checked above, before the Sefaria fetch) -- these segments
    // are always the even-spacing placeholder, guessed from whatever
    // duration happens to be known yet (often just the scrubber's default
    // before a video has loaded). state.usingDefaultAlignment is what tells
    // applyDuration() it's safe to silently re-spread these once the real
    // video duration comes in; leaving it false here (as an unset caller
    // option previously did) meant that correction never ran for any daf
    // without a real alignment, letting the whole placeholder timeline sit
    // compressed into the first ~100 seconds of a much longer video -- the
    // highlight then raced through every segment in that opening stretch
    // and sat frozen on the last one for the rest of playback, dragging
    // auto-scroll along with it.
    state.usingDefaultAlignment = true;
    state.alignmentStatus = 'placeholder';
    updateAlignmentStatus();
    $('dafTitle').textContent = heRef || ref;
    renderDaf();
    seek(0);
    if (!options.silent) showToast(`Loaded ${paragraphs.length} text segments from Sefaria.`);
  } catch (error) {
    console.error(error);
    showToast(`Could not load the daf: ${error.message}`, 'error');
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function cleanupObjectUrl() {
  if (state.objectUrl) {
    URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = null;
  }
}

function handleVideoFile(file) {
  if (!file) return;
  cleanupObjectUrl();
  switchPlayerType('html5');
  state.objectUrl = URL.createObjectURL(file);
  state.videoSource = { type: 'local', fileName: file.name, label: 'Local file' };
  htmlVideo.src = state.objectUrl;
  htmlVideo.load();
  $('videoFileName').textContent = file.name;
  $('lectureTitle').textContent = file.name.replace(/\.[^.]+$/, '');
  setSourceBadge('Local file');
  $('largePlay').hidden = false;
  showToast('Video loaded locally. Nothing was uploaded.');
}

function extractYouTubeId(input) {
  const trimmed = String(input || '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) return trimmed;

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'youtu.be') return url.pathname.split('/').filter(Boolean)[0] || null;
  if (!['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com'].includes(host)) return null;

  if (url.pathname === '/watch') return url.searchParams.get('v');
  const parts = url.pathname.split('/').filter(Boolean);
  if (['embed', 'shorts', 'live', 'v'].includes(parts[0])) return parts[1] || null;
  return url.searchParams.get('v');
}

function validateYouTubeId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id);
}

function loadYouTubeApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (state.youtubeApiPromise) return state.youtubeApiPromise;

  state.youtubeApiPromise = new Promise((resolve, reject) => {
    const previousCallback = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof previousCallback === 'function') previousCallback();
      resolve(window.YT);
    };

    const existing = document.querySelector('script[src="https://www.youtube.com/iframe_api"]');
    if (!existing) {
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.async = true;
      script.onerror = () => reject(new Error('Could not load the YouTube player API.'));
      document.head.appendChild(script);
    }

    setTimeout(() => {
      if (!window.YT?.Player) reject(new Error('The YouTube player took too long to load.'));
    }, 15000);
  });

  return state.youtubeApiPromise;
}

function youtubeErrorMessage(code) {
  const messages = {
    2: 'This YouTube link is invalid.',
    5: 'This video cannot be played in the HTML5 YouTube player.',
    100: 'This YouTube video was not found or is private.',
    101: 'The owner does not allow this video to be embedded.',
    150: 'The owner does not allow this video to be embedded.'
  };
  return messages[code] || `YouTube player error ${code}.`;
}

async function ensureYouTubePlayer(videoId) {
  await loadYouTubeApi();
  switchPlayerType('youtube');

  if (!state.youtubePlayer) {
    await new Promise((resolve, reject) => {
      const playerVars = {
        playsinline: 1,
        rel: 0,
        controls: 1,
        enablejsapi: 1,
        // YouTube's own fullscreen button only fullscreens the iframe itself,
        // leaving the Vilna page overlay (a sibling element) behind -- our
        // own fullscreen button (below) fullscreens the whole video-frame
        // container instead, so it covers both.
        fs: 0
      };
      if (location.protocol === 'http:' || location.protocol === 'https:') playerVars.origin = location.origin;

      // videoId is deliberately left out of the constructor -- passing it
      // there makes the IFrame API start playback the instant the player is
      // ready regardless of the autoplay playerVar (a well-known API quirk),
      // which is exactly what turned "pick a daf reference that already has
      // a known video" into "and now it's playing, unasked". cueVideoById
      // in onReady loads the same video without starting it, matching the
      // already-has-a-player branch below.
      state.youtubePlayer = new window.YT.Player('youtubePlayer', {
        width: '100%',
        height: '100%',
        playerVars,
        events: {
          onReady: (event) => {
            state.youtubeReady = true;
            event.target.cueVideoById(videoId);
            state.youtubeState = 5;
            startYouTubePoll();
            syncVolumeUi();
            resolve();
          },
          onStateChange: (event) => {
            state.youtubeState = event.data;
            updatePlayUi();
            updateTimeline();
            const duration = getDuration();
            if (duration > 0) applyDuration(duration);
          },
          onError: (event) => {
            const message = youtubeErrorMessage(event.data);
            showToast(message, 'error');
            reject(new Error(message));
          }
        }
      });
    });
  } else {
    state.youtubePlayer.cueVideoById(videoId);
    state.youtubeState = 5;
  }

  setPlaybackRate(Number($('speedSelect').value));
  waitForYouTubeMetadata();
}

function waitForYouTubeMetadata() {
  let attempts = 0;
  const timer = setInterval(() => {
    attempts += 1;
    const duration = getDuration();
    if (duration > 0) {
      clearInterval(timer);
      applyDuration(duration);
    } else if (attempts >= 80) {
      clearInterval(timer);
    }
  }, 125);
}

function startYouTubePoll() {
  stopYouTubePoll();
  state.youtubePollTimer = setInterval(() => {
    if (state.playerType === 'youtube') updateTimeline();
  }, 100);
}

function stopYouTubePoll() {
  if (state.youtubePollTimer) clearInterval(state.youtubePollTimer);
  state.youtubePollTimer = null;
}

async function loadYouTubeVideo(url, videoId = extractYouTubeId(url), saveRefs = null, label = null, locked = false) {
  if (!validateYouTubeId(videoId)) throw new Error('A valid YouTube video link is required.');
  cleanupObjectUrl();
  await ensureYouTubePlayer(videoId);
  state.videoSource = {
    type: 'youtube',
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    label: label || 'YouTube',
    locked,
  };
  state.currentProjectId = null;
  $('videoUrl').value = state.videoSource.url;
  $('lectureTitle').textContent = label || `YouTube lecture · ${videoId}`;
  setSourceBadge('YouTube');
  setSourcePanel('linkSourcePanel');
  seek(0);
  saveProjectForRef(state.dafRef, { videoSource: state.videoSource });
  saveVideoLinkForCoveredRefs(state.videoSource, saveRefs);
  showToast('YouTube video connected to the synchronized timeline.');
}

function titleFromUrl(url) {
  try {
    const parsed = new URL(url);
    const raw = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).at(-1) || parsed.hostname);
    return raw.replace(/\.(mp4|webm|ogg|mov|m4v|mp3|m4a)$/i, '') || 'Linked lecture video';
  } catch {
    return 'Linked lecture video';
  }
}

function loadDirectVideoUrl(url, saveRefs = null, locked = false) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Enter a complete video URL beginning with https:// or http://.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only http and https video links are supported.');

  cleanupObjectUrl();
  switchPlayerType('html5');
  state.videoSource = { type: 'direct', url: parsed.href, label: 'Direct link', locked };
  htmlVideo.src = parsed.href;
  htmlVideo.load();
  $('lectureTitle').textContent = titleFromUrl(parsed.href);
  setSourceBadge('Direct link');
  setSourcePanel('linkSourcePanel');
  $('largePlay').hidden = false;
  saveProjectForRef(state.dafRef, { videoSource: state.videoSource });
  saveVideoLinkForCoveredRefs(state.videoSource, saveRefs);
  showToast('Direct video link loaded. Playback depends on the host and browser format support.');
}

async function loadVideoFromUrl() {
  const input = $('videoUrl').value.trim();
  if (!input) return showToast('Paste a YouTube or direct video link first.', 'error');
  const button = $('loadVideoUrlButton');
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Loading…';
  try {
    const locked = $('lockVideoCheckbox')?.checked === true;
    const youtubeId = extractYouTubeId(input);
    if (youtubeId) await loadYouTubeVideo(input, youtubeId, null, null, locked);
    else loadDirectVideoUrl(input, null, locked);
  } catch (error) {
    console.error(error);
    showToast(error.message || 'Could not load this video link.', 'error');
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function setSourcePanel(panelId) {
  document.querySelectorAll('.source-panel').forEach((panel) => { panel.hidden = panel.id !== panelId; });
  document.querySelectorAll('.source-tab').forEach((tab) => {
    const active = tab.dataset.sourcePanel === panelId;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
}

function exportAlignment() {
  const duration = getDuration() || Number(scrubber.max) || 0;
  const payload = {
    schema: 'dafsync-alignment-v2',
    title: $('lectureTitle').textContent,
    dafRef: state.dafRef,
    duration: Number(duration.toFixed(3)),
    videoSource: state.videoSource,
    projectId: state.currentProjectId,
    alignmentStatus: state.alignmentStatus,
    generatedAt: new Date().toISOString(),
    segments: state.segments
  };
  downloadJson(payload, `${slugify(state.dafRef)}-alignment.json`);
  showToast('Synchronization JSON exported with its video source.');
}

function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function slugify(text) {
  return (text || 'daf-sync').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function restoreVideoSource(source, saveRefs = null) {
  if (!source || !source.type) return;
  if (source.type === 'youtube' && source.videoId) {
    // A server-published video-link's label is the real YouTube title
    // (captured off the channel feed) -- worth showing verbatim instead of
    // the generic placeholder below. A locally-saved source's label is
    // just that same generic 'YouTube' sentinel (see loadYouTubeVideo), so
    // it's excluded rather than shown as if it meant something.
    const realLabel = source.label && source.label !== 'YouTube' ? source.label : null;
    await loadYouTubeVideo(source.url || source.videoId, source.videoId, saveRefs, realLabel, source.locked === true);
  } else if (source.type === 'direct' && source.url) {
    $('videoUrl').value = source.url;
    loadDirectVideoUrl(source.url, saveRefs, source.locked === true);
  } else if (source.type === 'local') {
    setSourcePanel('fileSourcePanel');
    showToast(`Choose the exact video file that was analyzed: ${source.fileName || source.url || 'lecture video'}.`);
  }
}

// dafRefOverride: the OCR engine's own output always carries the real,
// variant-less Sefaria ref (a "Chazarah Daf" reading's canonical text is
// identical to the regular shiur's -- see realDafRef), so callers that know
// which shiur variant they actually asked for pass it back in here rather
// than letting data.dafRef silently drop the "(Chazarah Daf)" marker.
async function loadAlignmentData(data, { restoreSource = true, dafRefOverride = null, seekToStart = true } = {}) {
  if (!Array.isArray(data.segments) || !data.segments.length) throw new Error('No segments found.');
  state.segments = data.segments.map((segment, index) => ({
    id: segment.id || `segment-${index + 1}`,
    ref: segment.ref || data.dafRef || 'Unknown',
    start: Number(segment.start) || 0,
    end: Number(segment.end) || (Number(segment.start) || 0) + 1,
    he: String(segment.he || segment.text || ''),
    en: String(segment.en || segment.translation || ''),
    estimated: Boolean(segment.estimated),
    // A ref (one Sefaria paragraph) can now span several shorter phrase
    // segments -- see caption_ocr_align.py's _split_word_ranges -- so w0/w1
    // (word-index bounds within that ref, null on older alignments that
    // predate the split) are what the overlays use to highlight just this
    // phrase's words instead of the whole paragraph's.
    w0: Number.isFinite(Number(segment.w0)) ? Number(segment.w0) : null,
    w1: Number.isFinite(Number(segment.w1)) ? Number(segment.w1) : null
  })).sort((a, b) => a.start - b.start);
  state.wordTimeline = Array.isArray(data.wordTimeline)
    ? data.wordTimeline
        .filter((entry) => entry && entry.ref != null && Number.isFinite(Number(entry.start)))
        .map((entry) => ({
          start: Number(entry.start),
          end: Number(entry.end) || Number(entry.start),
          ref: String(entry.ref),
          w0: Number(entry.w0) || 0,
          w1: Number(entry.w1) || 0,
          heardText: typeof entry.heardText === 'string' ? entry.heardText : ''
        }))
    : [];
  state.alignmentDuration = Number(data.duration) || 0;
  state.dafRef = dafRefOverride || data.dafRef || state.dafRef;
  // A voice-recognition-sourced alignment's segments are the engine's own
  // rough guess (see voice_align.py) -- retaining a copy of exactly what it
  // guessed, before any admin edits touch state.segments, is what lets
  // saveDraft() later bank (guess, correction) pairs as training data.
  // Anything else (an OCR sync, a manual import) has no such baseline to
  // diff against, so this stays null for those.
  state.voiceCorrectionBaseline = data.generator === 'voice_align.py'
    ? { ref: state.dafRef, segments: state.segments.map((s) => ({ ref: s.ref, start: s.start, end: s.end, he: s.he, w0: s.w0, w1: s.w1 })) }
    : null;
  state.currentProjectId = data.projectId || null;
  state.alignmentStatus = data.alignmentStatus || 'in-progress';
  state.editingIndex = Math.min(Number(data.editingIndex) || 0, state.segments.length - 1);
  state.usingDefaultAlignment = false;
  updateAlignmentStatus();
  $('dafRef').value = state.dafRef;
  syncDafPickerFromRef(state.dafRef);
  $('dafTitle').textContent = state.dafRef;
  $('lectureTitle').textContent = data.title || $('lectureTitle').textContent;
  if (Number(data.duration) > 0) applyDuration(Number(data.duration), false);
  renderDaf();
  saveProjectForRef(state.dafRef, {
    segments: state.segments,
    wordTimeline: state.wordTimeline,
    alignmentStatus: state.alignmentStatus,
    duration: state.alignmentDuration || undefined,
    title: data.title || $('lectureTitle').textContent,
    videoSource: data.videoSource || null
  });
  if (restoreSource && data.videoSource) await restoreVideoSource(data.videoSource);
  if (data.title) $('lectureTitle').textContent = data.title;
  // Switching between two sync methods for the same daf/video (see
  // switchSyncMethod()) should leave playback right where the reader was,
  // not yank them back to the start -- everything else about this function
  // still needs to run (segments, word timeline, daf text) since the two
  // methods' alignments differ.
  if (seekToStart) seek(0);
}

// Shows/hides the "Caption sync / Voice sync" toggle and reflects which one
// is active -- hidden entirely unless *both* methods actually have a
// published result for the daf on screen, matching how every other
// situational control on this page (fast-forward, overlay, etc.) only
// appears when it'd actually do something.
function updateSyncMethodSwitchUi() {
  const wrap = $('syncMethodSwitch');
  if (!wrap) return;
  const bothAvailable = Boolean(state.availableSyncMethods.ocr) && Boolean(state.availableSyncMethods.voice);
  wrap.hidden = !bothAvailable;
  if (!bothAvailable) return;
  for (const button of wrap.querySelectorAll('button[data-method]')) {
    button.classList.toggle('active', button.dataset.method === state.activeSyncMethod);
  }
}

// Reloads the daf-text/highlighting side of things from the *other*
// already-fetched alignment (see refreshSyncMethodAvailability -- both are
// fetched together, so this never needs a new network round-trip) without
// touching the video at all -- it's the same video either way, only which
// engine's guess at the timing is driving the sync changes. Keeps playback
// exactly where the reader was (seekToStart: false) rather than jumping
// back to the start, since the whole point is comparing the two methods at
// the same moment.
async function switchSyncMethod(method) {
  const data = state.availableSyncMethods[method];
  if (!data || method === state.activeSyncMethod) return;
  const resumeTime = getCurrentTime();
  await loadAlignmentData(data, { restoreSource: false, dafRefOverride: state.dafRef, seekToStart: false });
  state.activeSyncMethod = method;
  updateSyncMethodSwitchUi();
  // Same reasoning as loadDaf()'s server-alignment branch -- the method
  // just switched to can be just as incomplete as the one switched away
  // from, independently.
  if (await fillMissingDafText(realDafRef(state.dafRef))) renderDaf();
  seek(resumeTime);
  showToast(method === 'voice' ? 'Switched to the voice-recognition sync.' : 'Switched to the caption-OCR sync.');
}

// Checks whether the *other* method (whichever didn't just load/sync) also
// has a published result for this ref, so the switch UI can offer it --
// called after both loadDaf()'s own initial dual-fetch and after a sync job
// finishes via the dialog, which only knows about the one method it just
// ran.
async function refreshOtherSyncMethod(ref, knownMethod) {
  const otherMethod = knownMethod === 'ocr' ? 'voice' : 'ocr';
  state.availableSyncMethods[otherMethod] = await fetchServerAlignment(ref, { voice: otherMethod === 'voice' });
  updateSyncMethodSwitchUi();
}

async function importAlignment(file) {
  try {
    const data = JSON.parse(await file.text());
    await loadAlignmentData(data);
    showToast(`Imported ${state.segments.length} synchronized segments.`);
  } catch (error) {
    showToast(`Invalid alignment file: ${error.message}`, 'error');
  }
}

async function importTranscript(file) {
  try {
    const data = JSON.parse(await file.text());
    const transcriptSegments = Array.isArray(data) ? data : data.segments;
    if (!Array.isArray(transcriptSegments) || !transcriptSegments.length) throw new Error('Expected a segments array.');
    const normalizedTranscript = transcriptSegments.map((segment) => ({
      start: Number(segment.start) || 0,
      end: Number(segment.end) || Number(segment.start) + 1,
      text: String(segment.text || '')
    }));
    autoAlignTranscript(normalizedTranscript);
    showToast('Transcript imported and matched using Hebrew phrase overlap.');
  } catch (error) {
    showToast(`Invalid transcript file: ${error.message}`, 'error');
  }
}

function autoAlignTranscript(transcript) {
  let cursor = 0;
  const matches = [];
  for (const segment of state.segments) {
    const targetTokens = new Set(normalizeHebrew(segment.he).split(' ').filter(Boolean));
    let best = { score: 0, index: cursor };
    const limit = Math.min(transcript.length, cursor + 18);
    for (let index = cursor; index < limit; index += 1) {
      const words = normalizeHebrew(transcript[index].text).split(' ').filter(Boolean);
      const overlap = words.filter((word) => targetTokens.has(word)).length;
      const score = targetTokens.size ? overlap / targetTokens.size : 0;
      if (score > best.score) best = { score, index };
    }
    if (best.score >= 0.16) cursor = best.index;
    matches.push(transcript[cursor]);
  }
  state.segments = state.segments.map((segment, index) => {
    const match = matches[index];
    const next = matches[index + 1];
    return {
      ...segment,
      start: Number((match?.start ?? segment.start).toFixed(2)),
      end: Number((next?.start ?? match?.end ?? segment.end).toFixed(2))
    };
  });
  state.usingDefaultAlignment = false;
  state.alignmentStatus = 'in-progress';
  updateAlignmentStatus();
  renderDaf();
  saveDraft(true);
  seek(0);
}

function handleScrubPointer(event) {
  const rect = scrubber.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  const time = ratio * Number(scrubber.max || 0);
  const index = findSegmentAt(time);
  const segment = state.segments[index];
  const preview = $('scrubPreview');
  preview.hidden = false;
  preview.style.left = `${ratio * 100}%`;
  $('previewTime').textContent = formatTime(time);
  $('previewText').textContent = segment?.he || 'No mapped text';
}

htmlVideo.addEventListener('loadedmetadata', () => { applyDuration(htmlVideo.duration); syncVolumeUi(); });
htmlVideo.addEventListener('timeupdate', updateTimeline);
htmlVideo.addEventListener('play', updatePlayUi);
htmlVideo.addEventListener('pause', updatePlayUi);
htmlVideo.addEventListener('ended', updatePlayUi);
htmlVideo.addEventListener('click', togglePlay);
htmlVideo.addEventListener('error', () => {
  if (state.videoSource.type === 'direct') {
    showToast('This direct link could not be played. Use a direct MP4/WebM file URL or a YouTube link.', 'error');
  }
});

$('markerBackButton')?.addEventListener('click', () => selectEditingIndex(state.editingIndex - 1));
$('markerForwardButton')?.addEventListener('click', () => selectEditingIndex(state.editingIndex + 1));
$('markHereButton')?.addEventListener('click', markHereAndAdvance);
$('saveDraftButton')?.addEventListener('click', () => { saveDraft(false); bankVoiceCorrection(); bankManualPhraseSync(); });

$('playButton').addEventListener('click', togglePlay);
$('largePlay').addEventListener('click', togglePlay);
$('backButton').addEventListener('click', () => seek(getCurrentTime() - 10));
$('forwardButton').addEventListener('click', () => seek(getCurrentTime() + 10));
$('speedSelect').addEventListener('change', (event) => setPlaybackRate(Number(event.target.value)));
$('fullscreenButton')?.addEventListener('click', toggleVideoFullscreen);
document.addEventListener('fullscreenchange', () => updateVideoOverlay(getCurrentTime()));
$('videoVilnaCanvas')?.addEventListener('click', handleVideoOverlayClick);
$('videoVilnaCanvas')?.addEventListener('pointerdown', handleOverlayPointerDown);
$('videoVilnaCanvas')?.addEventListener('pointermove', handleOverlayPointerMove);
$('videoVilnaCanvas')?.addEventListener('pointerup', handleOverlayPointerUp);
$('videoVilnaCanvas')?.addEventListener('pointercancel', handleOverlayPointerUp);
$('videoVilnaCanvas')?.addEventListener('wheel', handleOverlayWheel, { passive: false });
// /player/ carries two copies of the overlay controls -- the canonical one
// in normal page flow, and a compact floating one inside .video-frame
// itself for when that's unreachable (fullscreen). Same idea as
// scrubberEls above: each "...InVideo"-suffixed id is that same control's
// second instance, kept in sync by running the one real handler for
// whichever one the reader actually touched and mirroring its value onto
// the other. On pages without the floating copy (studio/watch), the
// InVideo lookup is just null and drops out of the group.
function overlayControlGroup(id) {
  return [$(id), $(`${id}InVideo`)].filter(Boolean);
}
function syncGroupValue(group, event, prop = 'value') {
  for (const el of group) if (el !== event.target) el[prop] = event.target[prop];
}
const overlayToggleEls = overlayControlGroup('overlayToggle');
const overlayModeSelectEls = overlayControlGroup('overlayModeSelect');
const overlayOpacitySliderEls = overlayControlGroup('overlayOpacitySlider');
const overlayOpacityTargetSelectEls = overlayControlGroup('overlayOpacityTargetSelect');
const overlayIdleSelectEls = overlayControlGroup('overlayIdleSelect');
const overlayZoomSliderEls = overlayControlGroup('overlayZoomSlider');
const overlayResetPositionButtonEls = overlayControlGroup('overlayResetPositionButton');

for (const el of overlayToggleEls) el.addEventListener('change', (event) => {
  syncGroupValue(overlayToggleEls, event, 'checked');
  state.videoOverlayEnabled = event.target.checked;
  $('videoFrame')?.classList.toggle('overlay-on', state.videoOverlayEnabled);
  updateVideoOverlay(getCurrentTime());
  // The rest of the overlay's own display settings (style/opacity/zoom/etc)
  // live tucked away in a <details> dropdown so they don't clutter the
  // video by default -- open (and close) the canonical, always-in-page-flow
  // copy in step with the feature itself, since there's nothing to tune
  // once it's off. The floating in-video copy stays collapsed regardless
  // (reader opens it with the gear icon) -- it sits over the video itself,
  // so auto-expanding it every time the overlay turns on would be exactly
  // the kind of intrusive default it's meant to avoid.
  if ($('overlaySettings')) $('overlaySettings').open = state.videoOverlayEnabled;
});
for (const el of overlayModeSelectEls) el.addEventListener('change', (event) => {
  syncGroupValue(overlayModeSelectEls, event);
  state.videoOverlayMode = event.target.value;
  updateVideoOverlay(getCurrentTime());
});
for (const el of overlayOpacitySliderEls) el.addEventListener('input', (event) => {
  syncGroupValue(overlayOpacitySliderEls, event);
  state.videoOverlayOpacity = Number(event.target.value) / 100;
  updateVideoOverlay(getCurrentTime());
});
for (const el of overlayOpacityTargetSelectEls) el.addEventListener('change', (event) => {
  syncGroupValue(overlayOpacityTargetSelectEls, event);
  state.videoOverlayOpacityTarget = event.target.value;
  updateVideoOverlay(getCurrentTime());
});
for (const el of overlayIdleSelectEls) el.addEventListener('change', (event) => {
  syncGroupValue(overlayIdleSelectEls, event);
  state.videoOverlayIdleMode = event.target.value;
  updateVideoOverlay(getCurrentTime());
});
for (const el of overlayZoomSliderEls) el.addEventListener('input', (event) => {
  syncGroupValue(overlayZoomSliderEls, event);
  state.videoOverlayZoom = Number(event.target.value) / 100;
  updateVideoOverlay(getCurrentTime());
});
for (const el of overlayResetPositionButtonEls) el.addEventListener('click', () => {
  state.videoOverlayZoom = 1;
  state.videoOverlayPanX = 0;
  state.videoOverlayPanY = 0;
  syncOverlayZoomSlider();
  updateVideoOverlay(getCurrentTime());
});

// Lets a reader drag the floating in-video overlay-controls widget (grip
// handle only, so it doesn't fight with clicking the toggle/gear) anywhere
// within the video frame, since a fixed corner can just as easily land on
// top of whatever they're actually watching. Position is stored as a
// percentage of the frame, not px, so it stays put proportionally across
// window resizes and native fullscreen; persisted across reloads too.
(function initOverlayControlsDrag() {
  const widget = $('overlayControlsInVideo');
  const handle = $('overlayControlsDragHandle');
  const frame = $('videoFrame');
  if (!widget || !handle || !frame) return;
  const STORAGE_KEY = 'dafsync-overlay-widget-pos';

  function place(xPercent, yPercent) {
    widget.style.left = `${xPercent}%`;
    widget.style.top = `${yPercent}%`;
    widget.style.right = 'auto';
    widget.style.bottom = 'auto';
  }

  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) place(saved.x, saved.y);
  } catch { /* ignore a corrupted saved position */ }

  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;

  handle.addEventListener('pointerdown', (event) => {
    dragging = true;
    const frameRect = frame.getBoundingClientRect();
    const widgetRect = widget.getBoundingClientRect();
    startX = event.clientX;
    startY = event.clientY;
    startLeft = widgetRect.left - frameRect.left;
    startTop = widgetRect.top - frameRect.top;
    handle.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  handle.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const frameRect = frame.getBoundingClientRect();
    const widgetRect = widget.getBoundingClientRect();
    const maxLeft = Math.max(0, frameRect.width - widgetRect.width);
    const maxTop = Math.max(0, frameRect.height - widgetRect.height);
    const left = Math.min(Math.max(startLeft + (event.clientX - startX), 0), maxLeft);
    const top = Math.min(Math.max(startTop + (event.clientY - startY), 0), maxTop);
    place((left / frameRect.width) * 100, (top / frameRect.height) * 100);
  });
  function endDrag() {
    if (!dragging) return;
    dragging = false;
    const x = parseFloat(widget.style.left);
    const y = parseFloat(widget.style.top);
    if (Number.isFinite(x) && Number.isFinite(y)) localStorage.setItem(STORAGE_KEY, JSON.stringify({ x, y }));
  }
  handle.addEventListener('pointerup', () => { endDrag(); positionOverlaySettingsInVideo(); });
  handle.addEventListener('pointercancel', endDrag);
})();

// The in-video overlay-settings dropdown (unlike the canonical below-page
// copy, which just opens downward into the normal page flow) floats over a
// video frame it can be dragged anywhere within, so a fixed "always open
// upward" (its old default, back when the widget itself always started in
// the bottom-left corner) can just as easily run it off the top of the
// frame now that the default start position is top-left, or after a drag
// puts it somewhere else entirely. Opens whichever of up/down actually has
// more room, and clamps its own height to that room either way so it's
// never cut off by the frame's own edge.
function positionOverlaySettingsInVideo() {
  const details = $('overlaySettingsInVideo');
  const body = details?.querySelector('.overlay-settings-body');
  const summary = details?.querySelector('summary');
  const frame = $('videoFrame');
  if (!details?.open || !body || !summary || !frame) return;
  const frameRect = frame.getBoundingClientRect();
  const summaryRect = summary.getBoundingClientRect();
  const spaceBelow = frameRect.bottom - summaryRect.bottom - 6;
  const spaceAbove = summaryRect.top - frameRect.top - 6;
  const openDownward = spaceBelow >= spaceAbove;
  body.style.top = openDownward ? 'calc(100% + 6px)' : 'auto';
  body.style.bottom = openDownward ? 'auto' : 'calc(100% + 6px)';
  body.style.maxHeight = `${Math.max(120, openDownward ? spaceBelow : spaceAbove)}px`;
}
$('overlaySettingsInVideo')?.addEventListener('toggle', positionOverlaySettingsInVideo);
window.addEventListener('resize', positionOverlaySettingsInVideo);
document.addEventListener('fullscreenchange', positionOverlaySettingsInVideo);
document.addEventListener('webkitfullscreenchange', positionOverlaySettingsInVideo);

$('vilnaZoomInButton')?.addEventListener('click', () => setVilnaPageZoom(state.vilnaPageZoom + VILNA_ZOOM_STEP));
$('vilnaZoomOutButton')?.addEventListener('click', () => setVilnaPageZoom(state.vilnaPageZoom - VILNA_ZOOM_STEP));
$('vilnaZoomResetButton')?.addEventListener('click', () => setVilnaPageZoom(1));
$('vilnaFullscreenButton')?.addEventListener('click', toggleVilnaFullscreen);
// ctrlKey is how browsers deliver a trackpad/touchscreen pinch gesture as a
// wheel event -- only intercepted with that modifier so plain two-finger
// scrolling still scrolls .daf-scroll normally instead of always zooming.
$('vilnaPageWrap')?.addEventListener('wheel', (event) => {
  if (!event.ctrlKey) return;
  event.preventDefault();
  setVilnaPageZoom(state.vilnaPageZoom + (event.deltaY < 0 ? VILNA_ZOOM_STEP : -VILNA_ZOOM_STEP));
}, { passive: false });
$('videoInput').addEventListener('change', (event) => handleVideoFile(event.target.files?.[0]));
$('loadVideoUrlButton').addEventListener('click', loadVideoFromUrl);
$('videoUrl').addEventListener('keydown', (event) => { if (event.key === 'Enter') loadVideoFromUrl(); });
$('loadDafButton').addEventListener('click', () => loadDaf());
$('dafRef').addEventListener('keydown', (event) => { if (event.key === 'Enter') loadDaf(); });
$('alignmentInput').addEventListener('change', (event) => importAlignment(event.target.files?.[0]));
$('transcriptInput').addEventListener('change', (event) => importTranscript(event.target.files?.[0]));
$('exportButton').addEventListener('click', exportAlignment);
$('evenSpacingButton').addEventListener('click', () => resetEvenSpacing(false));
// Optional chaining: this button only exists on pages with the alignment
// editor's phrase-splitting UI (player/studio) -- not watch/index.html or
// browse/index.html, which otherwise share this same top-level script.
$('phraseEditModeButton')?.addEventListener('click', togglePhraseEditMode);
$('vilnaMarkModeButton')?.addEventListener('click', toggleVilnaMarkMode);
// The editor sits in the same grid column as the daf card (see the HTML
// comment above #editor) so correcting the sync stays parallel with the
// video instead of scrolling to a full-width section below it -- the two
// are mutually exclusive in that column, not stacked. Below 1120px that
// grid collapses to one column (no room for side-by-side on a phone), so
// the "editing" class instead pins the video to the top of the screen
// while editing (see player/index.html's inline <style>), keeping it in
// view as the phrase list scrolls beneath it -- parallel via sticky
// positioning rather than columns, on screens too narrow for columns.
//
// Below 1120px, the full player card (video, playback controls, the
// "Mark here & advance" bar, and the "now discussing" text) is taller
// than a phone screen on its own -- sticking the whole thing while
// editing would leave no room to see the editor at all. So on those
// narrow widths only, the marking bar and now-learning block move into
// the editor itself while editing (they scroll with the phrase list
// instead), leaving just the compact video + basic playback controls in
// the sticky card. The M key still marks the current phrase regardless of
// where these elements are rendered. Above 1120px the side-by-side column
// layout already has room for the full card next to the editor, so
// nothing moves there -- this only applies where a plain 2-column view
// isn't an option in the first place.
const markingBar = document.querySelector('.marking-bar');
const nowLearning = document.querySelector('.now-learning');
const playerCard = document.querySelector('.player-card');
const narrowLayoutQuery = window.matchMedia('(max-width: 1120px)');
$('editModeButton').addEventListener('click', () => {
  $('dafCard').hidden = true;
  editor.hidden = false;
  document.querySelector('.watch-layout')?.classList.add('editing');
  if (narrowLayoutQuery.matches) {
    const editorList = editor.querySelector('.editor-list');
    editor.insertBefore(markingBar, editorList);
    editor.insertBefore(nowLearning, editorList);
  }
});
$('closeEditorButton').addEventListener('click', () => {
  editor.hidden = true;
  $('dafCard').hidden = false;
  document.querySelector('.watch-layout')?.classList.remove('editing');
  playerCard.appendChild(markingBar);
  playerCard.appendChild(nowLearning);
  renderVilnaPage();
});

document.querySelectorAll('.source-tab').forEach((tab) => {
  tab.addEventListener('click', () => setSourcePanel(tab.dataset.sourcePanel));
});

// Auto-scroll should defer to the reader: a manual wheel/touch scroll inside the
// daf pane suspends the follow-the-video auto-scroll for a few seconds so it
// doesn't yank the view back down mid-gesture. It resumes on its own after
// the cooldown, or immediately once the reader clicks a phrase to seek.
const markManualScroll = () => { state.lastManualScrollAt = Date.now(); };
$('dafScroll').addEventListener('wheel', markManualScroll, { passive: true });
$('dafScroll').addEventListener('touchmove', markManualScroll, { passive: true });

function handleScrubInput(event) {
  state.seeking = true;
  const time = Number(event.target.value);
  scrubberEls.forEach((el) => { if (el !== event.target) el.value = event.target.value; });
  $('currentTime').textContent = formatTime(time);
  if ($('inlineTimeLabel')) {
    const duration = getDuration() || Number(scrubber.max) || 0;
    $('inlineTimeLabel').textContent = `${formatTime(time)} / ${formatTime(duration)}`;
  }
  updateScrubberFill();
  updateActiveSegment(true, time);
  if (state.playerType === 'youtube') {
    if (state.youtubeReady) state.youtubePlayer.seekTo(time, false);
  } else {
    htmlVideo.currentTime = time;
  }
}
function handleScrubChange(event) {
  const time = Number(event.target.value);
  if (state.playerType === 'youtube' && state.youtubeReady) seekYouTubePlayer(time, true);
  state.seeking = false;
  updateTimeline();
}
for (const el of scrubberEls) {
  el.addEventListener('input', handleScrubInput);
  el.addEventListener('change', handleScrubChange);
}
scrubber.addEventListener('pointermove', handleScrubPointer);
scrubber.addEventListener('pointerenter', handleScrubPointer);
scrubber.addEventListener('pointerleave', () => { $('scrubPreview').hidden = true; });
$('inlinePlayButton')?.addEventListener('click', togglePlay);
for (const el of volumeSliderEls) el.addEventListener('input', (event) => setVolume(Number(event.target.value)));
for (const button of muteButtonEls) button.addEventListener('click', () => setMuted(!isMuted()));
for (const button of fastForwardButtonEls) button.addEventListener('click', skipToNextReading);

function switchDafView(mode) {
  // Not every page that loads app.js has all three views -- watch/index.html
  // and browse/index.html only have Text/Vilna page, no Scan -- so each
  // target element is optional here, unlike dafPage (present everywhere).
  document.querySelectorAll('.view-switch button').forEach((item) => item.classList.toggle('active', item.dataset.view === mode));
  dafPage.hidden = mode !== 'text';
  const vilnaPlaceholder = $('vilnaPlaceholder');
  if (vilnaPlaceholder) vilnaPlaceholder.hidden = mode !== 'page';
  const scanPlaceholder = $('scanPlaceholder');
  if (scanPlaceholder) scanPlaceholder.hidden = mode !== 'scan';
  if (mode === 'page') renderVilnaPage();
  if (mode === 'scan') resetScanUi();
}

for (const button of document.querySelectorAll('.view-switch button')) {
  button.addEventListener('click', () => switchDafView(button.dataset.view));
}

for (const button of document.querySelectorAll('.sync-method-switch button[data-method]')) {
  button.addEventListener('click', () => switchSyncMethod(button.dataset.method));
}

$('scanCameraInput')?.addEventListener('change', (event) => handleScanFileSelected(event.target.files?.[0]));
$('scanLibraryInput')?.addEventListener('change', (event) => handleScanFileSelected(event.target.files?.[0]));
$('scanRetakeButton')?.addEventListener('click', resetScanUi);
$('scanAgainButton')?.addEventListener('click', resetScanUi);
$('scanConfirmButton')?.addEventListener('click', confirmScan);
for (const handle of document.querySelectorAll('.scan-corner-handle')) {
  handle.addEventListener('pointerdown', handleScanCornerPointerDown);
}
document.addEventListener('pointermove', handleScanCornerPointerMove);
document.addEventListener('pointerup', handleScanCornerPointerUp);

$('helpButton').addEventListener('click', () => $('helpDialog').showModal());
$('closeHelp').addEventListener('click', () => $('helpDialog').close());
$('helpDialog').addEventListener('click', (event) => {
  const rect = event.currentTarget.getBoundingClientRect();
  const outside = event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
  if (outside) event.currentTarget.close();
});

document.addEventListener('keydown', (event) => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
  if (event.code === 'Space') { event.preventDefault(); togglePlay(); }
  if (event.code === 'ArrowLeft') seek(getCurrentTime() - 5);
  if (event.code === 'ArrowRight') seek(getCurrentTime() + 5);
  if (event.key.toLowerCase() === 'm') { event.preventDefault(); markHereAndAdvance(); }
  if (event.key === '[') selectEditingIndex(state.editingIndex - 1);
  if (event.key === ']') selectEditingIndex(state.editingIndex + 1);
});

renderDaf();
updateAlignmentStatus();
updateScrubberFill();
updatePlayUi();

// ---------------------------------------------------------------------------
// Sync-from-video dialog: pick a tractate/daf/amud reading list, then process
// a caption-box video either locally (via the DafSync desktop app's
// companion server on 127.0.0.1) or on our server (Google Drive + GitHub
// Actions, via a Netlify Function relay that holds the trigger token).
// ---------------------------------------------------------------------------

const LOCAL_SERVER_BASE = 'http://127.0.0.1:8765';
const TRIGGER_ENDPOINT = '/api/trigger-ocr-job';
const TRIGGER_VOICE_ENDPOINT = '/api/trigger-voice-job';

const syncState = {
  talmudByName: {},
  tractateNames: [],
  readings: [],
  localVideoFile: null,
  pollTimer: null,
  appReady: false
};

function amudimForDaf(entry, daf) {
  const sides = [];
  for (const side of ['a', 'b']) {
    if (daf === entry.endDaf && side === 'b' && entry.endSide === 'a') continue;
    if (entry.skipAmudim.includes(`${daf}${side}`)) continue;
    sides.push(side);
  }
  return sides;
}

function dafOptionsFor(entry) {
  const options = [];
  for (let d = entry.startDaf; d <= entry.endDaf; d++) {
    if (amudimForDaf(entry, d).length) options.push(d);
  }
  return options;
}

// Daf-browser-only narrowing on top of the two generic functions above --
// kept separate rather than folded into amudimForDaf/dafOptionsFor
// themselves, since those are also used by the sync dialog's own
// tractate/daf/amud picker (present, admin-only, on every page including
// browse/index.html), which needs to keep offering *every* daf -- an
// admin syncs from there precisely because a daf isn't synced yet.
function browsableAmudim(entry, daf) {
  const sides = amudimForDaf(entry, daf);
  if (!state.browseMode || !state.syncedDapim) return sides;
  return sides.filter((side) => (state.syncedDapim[entry.name]?.[`${daf}${side}`] || []).length);
}

function browsableDafOptions(entry) {
  if (!state.browseMode || !state.syncedDapim) return dafOptionsFor(entry);
  const options = [];
  for (let d = entry.startDaf; d <= entry.endDaf; d++) {
    if (browsableAmudim(entry, d).length) options.push(d);
  }
  return options;
}

async function loadTalmudIndex() {
  if (!syncState.tractateNames.length) {
    const response = await fetch('/talmud_index.json');
    const data = await response.json();
    for (const t of data.tractates) syncState.talmudByName[t.name] = t;
    syncState.tractateNames = data.tractates.map((t) => t.name);
  }
  // The Daf browser only wants dapim that already have both a synced
  // alignment and page word-position data (see list-synced-dapim.mjs and
  // amudimForDaf's own check below) -- fetched once and cached on state,
  // gated to browseMode so every other page's picker (which is for picking
  // *any* daf, including ones still needing a sync) is unaffected.
  if (state.browseMode && !state.syncedDapim) {
    try {
      const response = await fetch('/api/list-synced-dapim');
      state.syncedDapim = response.ok ? await response.json() : {};
    } catch {
      state.syncedDapim = {};
    }
  }
  const optionsHtml = syncState.tractateNames
    .map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
  $('syncTractateSelect').innerHTML = optionsHtml;
  onSyncTractateChange();
  if ($('dafTractateSelect') && !$('dafTractateSelect').options.length) {
    // Unlike the sync dialog's own tractate picker above (which needs
    // every tractate -- an admin syncs *unsynced* dapim from there), a
    // tractate with nothing synced yet is skipped entirely here.
    const dafPickerTractateNames = state.browseMode && state.syncedDapim
      ? syncState.tractateNames.filter((name) => Object.keys(state.syncedDapim[name] || {}).length)
      : syncState.tractateNames;
    $('dafTractateSelect').innerHTML = dafPickerTractateNames
      .map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
    refreshDafPickerOptions();
  }
}

// Shared by both the sync dialog's tractate/daf/amud picker and the main
// "daf reference" picker -- same talmud_index.json data, same daf-existence
// and amud-availability rules, just different element IDs.
function populateAmudToggle(toggleId, sides) {
  const buttons = document.querySelectorAll(`#${toggleId} .amud-option`);
  buttons.forEach((button) => {
    const available = sides.includes(button.dataset.side);
    button.disabled = !available;
    button.classList.toggle('active', available && button.classList.contains('active'));
  });
  if (![...buttons].some((button) => button.classList.contains('active') && !button.disabled)) {
    buttons.forEach((button) => button.classList.toggle('active', button.dataset.side === sides[0]));
  }
}

function activeAmud(toggleId) {
  const active = document.querySelector(`#${toggleId} .amud-option.active`);
  return active ? active.dataset.side : 'a';
}

// "Regular" vs "Chazarah Daf" -- unlike the amud toggle, both options are
// always valid regardless of which daf is selected, so there's no
// availability/disabling logic to mirror here.
function activeShiurVariant(toggleId) {
  const active = document.querySelector(`#${toggleId} .shiur-variant-option.active`);
  return active ? active.dataset.variant : 'regular';
}

function setActiveShiurVariant(toggleId, variant) {
  document.querySelectorAll(`#${toggleId} .shiur-variant-option`).forEach((button) => {
    button.classList.toggle('active', button.dataset.variant === variant);
  });
}

// "English" vs "Hebrew" -- the channel this site tracks publishes both as
// separate recordings (different speaker pace, not a translation of one
// another), so like the shiur-variant toggle above, both options are always
// valid regardless of which daf is selected.
function activeLanguage(toggleId) {
  const active = document.querySelector(`#${toggleId} .language-option.active`);
  return active ? active.dataset.language : 'en';
}

function setActiveLanguage(toggleId, language) {
  document.querySelectorAll(`#${toggleId} .language-option`).forEach((button) => {
    button.classList.toggle('active', button.dataset.language === language);
  });
}

function onSyncTractateChange() {
  const entry = syncState.talmudByName[$('syncTractateSelect').value];
  const options = dafOptionsFor(entry);
  $('syncDafSelect').innerHTML = options.map((d) => `<option value="${d}">${d}</option>`).join('');
  onSyncDafChange();
}

function onSyncDafChange() {
  const entry = syncState.talmudByName[$('syncTractateSelect').value];
  const daf = Number($('syncDafSelect').value);
  const sides = daf ? (amudimForDaf(entry, daf).length ? amudimForDaf(entry, daf) : ['a']) : ['a'];
  populateAmudToggle('syncAmudToggle', sides);
}

function currentSyncAmud() {
  return activeAmud('syncAmudToggle');
}

// --- Main "daf reference" picker (tractate / daf / amud dropdowns) --------
// Replaces free-text ref typing. #dafRef stays in the DOM (hidden) as the
// plain-string source of truth every other loadDaf()/loadAlignmentData()
// code path already reads and writes -- the picker just keeps it in sync.

function refreshDafPickerOptions() {
  const entry = syncState.talmudByName[$('dafTractateSelect').value];
  if (!entry) return;
  const options = browsableDafOptions(entry);
  $('dafDafSelect').innerHTML = options.map((d) => `<option value="${d}">${d}</option>`).join('');
  refreshDafPickerAmud();
}

function refreshDafPickerAmud() {
  const entry = syncState.talmudByName[$('dafTractateSelect').value];
  const daf = Number($('dafDafSelect').value);
  const sides = daf ? (browsableAmudim(entry, daf).length ? browsableAmudim(entry, daf) : ['a']) : ['a'];
  populateAmudToggle('dafAmudToggle', sides);
  refreshDafPickerVariantLanguage();
}

// Same naming scheme as youtube-channel-sync.mjs's/list-synced-dapim.mjs's
// own comboKeyFor -- kept in sync by hand (no shared-module loader for
// this project's plain, non-.mjs frontend script).
function comboKeyFor(variant, language) {
  return `${variant === 'chazarah' ? 'chazarah' : 'regular'}${language === 'he' ? 'He' : 'En'}`;
}

// Daf browser only: narrows which shiur-variant/language combos are
// offered to whatever's actually synced for the selected daf+amud (see
// list-synced-dapim.mjs) -- unlike the amud toggle, these two were
// previously always both valid regardless of which daf was picked (see
// activeShiurVariant's own comment above), which no longer holds once the
// picker itself is limited to already-synced dapim.
function refreshDafPickerVariantLanguage() {
  if (!state.browseMode || !state.syncedDapim) return;
  const tractate = $('dafTractateSelect')?.value;
  const daf = $('dafDafSelect')?.value;
  const amud = activeAmud('dafAmudToggle');
  const combos = state.syncedDapim[tractate]?.[`${daf}${amud}`] || [];
  if (!combos.length) return;

  document.querySelectorAll('#dafShiurToggle .shiur-variant-option').forEach((button) => {
    button.disabled = !combos.some((c) => c.startsWith(button.dataset.variant === 'chazarah' ? 'chazarah' : 'regular'));
  });
  document.querySelectorAll('#dafLanguageToggle .language-option').forEach((button) => {
    button.disabled = !combos.some((c) => c.endsWith(button.dataset.language === 'he' ? 'He' : 'En'));
  });

  // If the currently active variant+language combination together isn't
  // actually synced for this daf/amud, fall back to whichever combo is --
  // the same "don't leave the picker on an invalid selection" rule
  // populateAmudToggle already follows for amud.
  if (!combos.includes(comboKeyFor(activeShiurVariant('dafShiurToggle'), activeLanguage('dafLanguageToggle')))) {
    const fallback = combos[0];
    setActiveShiurVariant('dafShiurToggle', fallback.startsWith('chazarah') ? 'chazarah' : 'regular');
    setActiveLanguage('dafLanguageToggle', fallback.endsWith('He') ? 'he' : 'en');
  }
}

function dafPickerRef() {
  const tractate = $('dafTractateSelect').value;
  const daf = $('dafDafSelect').value;
  if (!tractate || !daf) return '';
  const variantSuffix = activeShiurVariant('dafShiurToggle') === 'chazarah' ? ' (Chazarah Daf)' : '';
  const languageSuffix = activeLanguage('dafLanguageToggle') === 'he' ? ' (Hebrew)' : '';
  return `${tractate} ${daf}${activeAmud('dafAmudToggle')}${variantSuffix}${languageSuffix}`;
}

function onDafPickerChanged() {
  const ref = dafPickerRef();
  if (!ref) return;
  if (state.browseMode) {
    state.browsePageRef = ref;
    const titleEl = $('dafTitle');
    if (titleEl) titleEl.textContent = ref;
    renderVilnaPage();
    return;
  }
  loadDaf(ref);
}

// Steps the picker's own tractate/daf/amud selection by one amud in either
// direction (b -> the next daf's a, rolling into the next tractate at a
// startDaf/endDaf boundary) and applies it -- reuses the exact same
// talmud_index.json-driven helpers the picker's dropdowns already use
// (amudimForDaf/dafOptionsFor for which amudim/dapim actually exist,
// refreshDafPickerOptions/refreshDafPickerAmud to keep the dropdowns
// themselves in sync with the new tractate), so there's no separate
// "is this a real daf" logic to keep correct in two places.
// Only present (and so only ever called) on browse/index.html -- the
// browsable* wrappers below are used throughout rather than
// amudimForDaf/dafOptionsFor directly, so page-turning only ever lands on
// a daf/amud that's actually synced, skipping past a whole tractate with
// nothing synced yet rather than stopping on its first (unsynced) daf.
function tractateWithBrowsableDapim(startIndex, direction) {
  for (let i = startIndex; i >= 0 && i < syncState.tractateNames.length; i += direction) {
    const name = syncState.tractateNames[i];
    const entry = syncState.talmudByName[name];
    if (browsableDafOptions(entry).length) return { name, entry };
  }
  return null;
}

function stepBrowseDaf(direction) {
  const tractate = $('dafTractateSelect')?.value;
  const entry = syncState.talmudByName[tractate];
  if (!entry) return;
  const daf = Number($('dafDafSelect').value);
  const amud = activeAmud('dafAmudToggle');
  const sides = browsableAmudim(entry, daf);
  const sideIndex = sides.indexOf(amud);
  const dafOptions = browsableDafOptions(entry);
  const dafIndex = dafOptions.indexOf(daf);
  const tractateIndex = syncState.tractateNames.indexOf(tractate);

  let nextTractate = tractate;
  let nextDaf = daf;
  let nextSide;

  if (direction > 0) {
    if (sideIndex !== -1 && sideIndex + 1 < sides.length) {
      nextSide = sides[sideIndex + 1];
    } else if (dafIndex !== -1 && dafIndex + 1 < dafOptions.length) {
      nextDaf = dafOptions[dafIndex + 1];
      nextSide = browsableAmudim(entry, nextDaf)[0];
    } else {
      const found = tractateWithBrowsableDapim(tractateIndex + 1, 1);
      if (!found) return; // already at the last synced amud there is
      nextTractate = found.name;
      const nextOptions = browsableDafOptions(found.entry);
      nextDaf = nextOptions[0];
      nextSide = browsableAmudim(found.entry, nextDaf)[0];
    }
  } else {
    if (sideIndex > 0) {
      nextSide = sides[sideIndex - 1];
    } else if (dafIndex > 0) {
      nextDaf = dafOptions[dafIndex - 1];
      const prevSides = browsableAmudim(entry, nextDaf);
      nextSide = prevSides[prevSides.length - 1];
    } else {
      const found = tractateWithBrowsableDapim(tractateIndex - 1, -1);
      if (!found) return; // already at the first synced amud there is
      nextTractate = found.name;
      const prevOptions = browsableDafOptions(found.entry);
      nextDaf = prevOptions[prevOptions.length - 1];
      const prevSides = browsableAmudim(found.entry, nextDaf);
      nextSide = prevSides[prevSides.length - 1];
    }
  }

  $('dafTractateSelect').value = nextTractate;
  refreshDafPickerOptions();
  $('dafDafSelect').value = String(nextDaf);
  refreshDafPickerAmud();
  document.querySelectorAll('#dafAmudToggle .amud-option').forEach((button) => {
    if (!button.disabled) button.classList.toggle('active', button.dataset.side === nextSide);
  });
  // refreshDafPickerAmud() above already calls this, but at that point the
  // active amud is still whatever it was before this step (populateAmudToggle
  // only just preserved it, since it was still technically valid) -- the
  // reassignment to nextSide happens right above, after both
  // refreshDafPickerAmud() calls (the implicit one inside
  // refreshDafPickerOptions() and the explicit one), so this needs one more
  // call now that the real target amud is actually in place.
  refreshDafPickerVariantLanguage();
  onDafPickerChanged();
}

// Reflects an externally-set ref (loaded via import, restored project,
// server sync, etc.) back into the picker -- does NOT trigger a load itself
// (this runs *from* loadDaf()/loadAlignmentData(), so re-triggering would
// recurse).
function syncDafPickerFromRef(ref) {
  const tractateSelect = $('dafTractateSelect');
  if (!tractateSelect || !tractateSelect.options.length) return;
  const parsed = parseDafRef(ref);
  if (!parsed || !syncState.talmudByName[parsed.tractate]) return;
  tractateSelect.value = parsed.tractate;
  refreshDafPickerOptions();
  const dafSelect = $('dafDafSelect');
  if ([...dafSelect.options].some((o) => Number(o.value) === parsed.daf)) {
    dafSelect.value = String(parsed.daf);
  }
  refreshDafPickerAmud();
  const buttons = document.querySelectorAll('#dafAmudToggle .amud-option');
  buttons.forEach((b) => {
    if (!b.disabled) b.classList.toggle('active', b.dataset.side === parsed.amud);
  });
  setActiveShiurVariant('dafShiurToggle', parsed.variant);
  setActiveLanguage('dafLanguageToggle', parsed.language);
}

function addSyncReading() {
  const tractate = $('syncTractateSelect').value;
  const daf = $('syncDafSelect').value;
  if (!tractate || !daf) return;
  const variantSuffix = activeShiurVariant('syncShiurToggle') === 'chazarah' ? ' (Chazarah Daf)' : '';
  const languageSuffix = activeLanguage('syncLanguageToggle') === 'he' ? ' (Hebrew)' : '';
  const ref = `${tractate} ${daf}${currentSyncAmud()}${variantSuffix}${languageSuffix}`;
  syncState.readings.push({ ref, display: ref });
  renderSyncReadings();
}

// Switching to the "YouTube link" tab with a daf already open on screen
// means the reader almost always wants to sync *this* video against *this*
// daf -- prefill both rather than making them re-pick everything the page
// already knows. Only fires with an empty slate (readings list empty, url
// input empty) so it never clobbers something already chosen by hand, e.g.
// after switching tabs back and forth.
function prefillYoutubeSyncTab() {
  // Voice recognition is also YouTube-only for now (see syncVoicePanel),
  // so it shares the same current-page-video prefill as the plain YouTube
  // tab.
  for (const id of ['syncYoutubeUrlInput', 'syncVoiceUrlInput']) {
    const urlInput = $(id);
    if (urlInput && !urlInput.value.trim() && state.videoSource?.type === 'youtube' && state.videoSource.url) {
      urlInput.value = state.videoSource.url;
    }
  }
  if (syncState.readings.length || !state.dafRef) return;
  const parsed = parseDafRef(state.dafRef);
  if (!parsed) return;
  const variantSuffix = parsed.variant === 'chazarah' ? ' (Chazarah Daf)' : '';
  const languageSuffix = parsed.language === 'he' ? ' (Hebrew)' : '';
  // Both amudim of the current daf, not just whichever one happens to be on
  // screen -- a shiur almost always covers the whole daf, and the reader
  // can always remove the one it turns out not to.
  const entry = syncState.talmudByName[parsed.tractate];
  const sides = entry ? amudimForDaf(entry, parsed.daf) : ['a', 'b'];
  for (const side of sides) {
    const ref = `${parsed.tractate} ${parsed.daf}${side}${variantSuffix}${languageSuffix}`;
    if (!syncState.readings.some((r) => r.ref === ref)) syncState.readings.push({ ref, display: ref });
  }
  renderSyncReadings();
}

function removeSyncReading(index) {
  syncState.readings.splice(index, 1);
  renderSyncReadings();
}

function clearSyncReadings() {
  syncState.readings = [];
  renderSyncReadings();
}

function renderSyncReadings() {
  const list = $('syncReadingsList');
  if (!syncState.readings.length) {
    list.innerHTML = '<p class="field-note">No readings added yet.</p>';
  } else {
    list.innerHTML = syncState.readings.map((reading, index) => `
      <div class="sync-reading-row">
        <span>${index + 1}. <strong>${escapeHtml(reading.display)}</strong></span>
        <button type="button" class="sync-reading-remove" data-index="${index}" aria-label="Remove">✕</button>
      </div>`).join('');
    list.querySelectorAll('.sync-reading-remove').forEach((button) => {
      button.addEventListener('click', () => removeSyncReading(Number(button.dataset.index)));
    });
  }
  updateOpenAppLink();
}

function updateOpenAppLink() {
  const refs = syncState.readings.map((r) => r.ref);
  const url = refs.length
    ? `dafsync://open?refs=${encodeURIComponent(JSON.stringify(refs))}`
    : 'dafsync://open';
  $('syncOpenAppButton').href = url;
}

async function checkLocalAppStatus() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const response = await fetch(`${LOCAL_SERVER_BASE}/dafsync/status`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) throw new Error('not ready');
    syncState.appReady = true;
    $('syncAppStatus').querySelector('.status-dot').className = 'status-dot ready';
    $('syncAppStatusText').textContent = 'DafSync desktop app detected — ready to sync.';
    $('syncOpenAppButton').hidden = true;
  } catch {
    syncState.appReady = false;
    $('syncAppStatus').querySelector('.status-dot').className = 'status-dot muted';
    $('syncAppStatusText').textContent = 'DafSync desktop app not detected on this computer.';
    $('syncOpenAppButton').hidden = false;
  }
}

function setSyncProgress(fraction, logLines) {
  $('syncProgressWrap').hidden = false;
  const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
  $('syncProgressFill').style.width = `${pct}%`;
  $('syncProgressPct').textContent = `${pct}%`;
  if (logLines) {
    const log = $('syncLog');
    log.textContent = logLines.join('\n');
    log.scrollTop = log.scrollHeight;
  }
}

function stopSyncPolling() {
  if (syncState.pollTimer) {
    clearInterval(syncState.pollTimer);
    syncState.pollTimer = null;
  }
}

async function startLocalSync() {
  if (!syncState.readings.length) {
    showToast('Add at least one reading first.', 'error');
    return;
  }
  if (!syncState.localVideoFile) {
    showToast('Choose a video file first.', 'error');
    return;
  }
  await checkLocalAppStatus();
  if (!syncState.appReady) {
    showToast('Open the DafSync desktop app first, then try again.', 'error');
    return;
  }

  // The desktop app's own OCR engine fetches these from Sefaria directly,
  // same as the server-side job -- it needs the real ref, not the display
  // ref with the "(Chazarah Daf)" marker on it (see realDafRef).
  const formData = new FormData();
  formData.append('video', syncState.localVideoFile, syncState.localVideoFile.name);
  formData.append('refs', JSON.stringify(syncState.readings.map((r) => realDafRef(r.ref))));
  formData.append('variant', parseDafRef(syncState.readings[0].ref)?.variant || 'regular');
  formData.append('language', parseDafRef(syncState.readings[0].ref)?.language || 'en');

  setSyncProgress(0, ['Uploading to the desktop app on this computer…']);
  let jobId;
  try {
    const response = await fetch(`${LOCAL_SERVER_BASE}/dafsync/jobs`, { method: 'POST', body: formData });
    if (!response.ok) throw new Error((await response.json()).error || 'Could not start the job.');
    ({ jobId } = await response.json());
  } catch (error) {
    showToast(`Could not start local sync: ${error.message}`, 'error');
    return;
  }

  stopSyncPolling();
  syncState.pollTimer = setInterval(async () => {
    try {
      const response = await fetch(`${LOCAL_SERVER_BASE}/dafsync/jobs/${jobId}`);
      const job = await response.json();
      setSyncProgress(job.progress || 0, job.log);
      if (job.status === 'done') {
        stopSyncPolling();
        handleVideoFile(syncState.localVideoFile);
        await loadAlignmentData(job.result.alignment, { restoreSource: false, dafRefOverride: syncState.readings[0].ref });
        showToast('Synced! The video and daf are ready.');
        $('syncDialog').close();
      } else if (job.status === 'error') {
        stopSyncPolling();
        showToast(`Sync failed: ${job.error}`, 'error');
      }
    } catch {
      stopSyncPolling();
      showToast('Lost connection to the desktop app.', 'error');
    }
  }, 1200);
}

// Shared by every server-side sync entry point (the dialog's Drive and
// YouTube tabs, and the daf page's one-click quick sync) once each has its
// own trigger-ocr-job response in hand -- everything past that point (poll
// results/by-ref/<ref>.json for a fresh match, time out, load the result)
// is identical regardless of which one the video came from.
//
// dafRefOverride is passed in rather than read from syncState.readings,
// because quick sync never populates the dialog's reading list -- it has
// only the daf on screen and the covered refs the video link carries.
function pollServerSyncResult(jobId, resultUrl, successMessage, dafRefOverride, method = 'ocr') {
  const startedAt = Date.now();
  const MAX_WAIT_SECONDS = 55 * 60; // GitHub Actions job has its own 60-min cap
  // A single fetch() to raw.githubusercontent.com can fail at the network
  // level (a real "Failed to fetch" TypeError, not an HTTP error status) on
  // any one poll -- a Wi-Fi blip, a background-tab throttle, whatever --
  // with zero relation to whether the server-side job itself is fine. It
  // usually is: the GitHub Actions job runs independently of this browser
  // tab entirely. Giving up on the very first such hiccup used to end the
  // poll (and tell the reader sync "failed") while the job kept right on
  // running server-side regardless -- so tolerate a short run of
  // consecutive failures before actually giving up.
  const MAX_CONSECUTIVE_FAILURES = 5;
  let consecutiveFailures = 0;
  stopSyncPolling();
  syncState.pollTimer = setInterval(async () => {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    if (elapsed > MAX_WAIT_SECONDS) {
      stopSyncPolling();
      setSyncProgress(0.9, [
        `Still not done after ${elapsed}s — that's longer than expected.`,
        'The server job may have failed. Check the repository’s Actions tab, or try again.'
      ]);
      showToast('Server sync is taking much longer than expected — it may have failed.', 'error');
      return;
    }
    try {
      const response = await fetch(`${resultUrl}?t=${Date.now()}`);
      if (response.status === 404) {
        consecutiveFailures = 0;
        setSyncProgress(Math.min(0.9, elapsed / 300), [`Processing on the server… (${elapsed}s elapsed)`]);
        return;
      }
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      const alignment = await response.json();
      if (alignment?.jobId !== jobId) {
        // A file already existed at this ref path from an earlier sync (e.g.
        // this job's first-listed ref was already synced before) -- that's
        // not this job's result, keep waiting for it to be overwritten.
        consecutiveFailures = 0;
        setSyncProgress(Math.min(0.9, elapsed / 300), [`Processing on the server… (${elapsed}s elapsed)`]);
        return;
      }
      stopSyncPolling();
      setSyncProgress(1, [`Done after ${elapsed}s.`]);
      // loadAlignmentData already surfaces a specific "load this exact file" toast
      // (via restoreVideoSource) for the local-video case; don't clobber it with a
      // generic one — that specific guidance is what actually prevents mis-synced
      // playback from a mismatched video.
      const hadSpecificSource = alignment?.videoSource?.type === 'local';
      await loadAlignmentData(alignment, { dafRefOverride });
      state.availableSyncMethods[method] = alignment;
      state.activeSyncMethod = method;
      updateSyncMethodSwitchUi();
      // This dialog only ever knows about the one method it just ran --
      // check whether the *other* one also already has a published result
      // for this ref, so the switch UI can offer it immediately rather than
      // only appearing after the reader happens to reload the page.
      refreshOtherSyncMethod(dafRefOverride || state.dafRef, method);
      if (!hadSpecificSource) {
        showToast(successMessage);
      }
      $('syncDialog').close();
    } catch (error) {
      consecutiveFailures++;
      if (consecutiveFailures < MAX_CONSECUTIVE_FAILURES) {
        setSyncProgress(Math.min(0.9, elapsed / 300), [
          `Processing on the server… (${elapsed}s elapsed)`,
          `Checking for the result is having trouble (${error.message}), retrying…`
        ]);
        return;
      }
      stopSyncPolling();
      setSyncProgress(Math.min(0.9, elapsed / 300), [
        `Failed after ${elapsed}s: ${error.message}`,
        'The server-side job may still be running -- check the repository’s Actions tab, or try again.'
      ]);
      showToast(`Lost connection while checking on the sync: ${error.message}`, 'error');
    }
  }, 6000);
}

async function startDriveSync() {
  if (!syncState.readings.length) {
    showToast('Add at least one reading first.', 'error');
    return;
  }
  const driveUrl = $('syncDriveUrlInput').value.trim();
  if (!/^https:\/\/(drive|docs)\.google\.com\//.test(driveUrl)) {
    showToast('Paste a valid Google Drive link.', 'error');
    return;
  }

  // The OCR engine only ever fetches the real Sefaria ref (a "Chazarah Daf"
  // reading's canonical text is identical to the regular shiur's -- it's a
  // shorter recording of the same content, not different content, and the
  // same is true of a Hebrew-language recording), so refs sent server-side
  // always have both markers stripped; variant/language are sent alongside
  // purely to namespace where the result gets published.
  const variant = parseDafRef(syncState.readings[0].ref)?.variant || 'regular';
  const language = parseDafRef(syncState.readings[0].ref)?.language || 'en';
  setSyncProgress(0, ['Starting the server-side job…']);
  let jobId, resultUrl;
  try {
    const response = await fetch(TRIGGER_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ driveUrl, refs: syncState.readings.map((r) => realDafRef(r.ref)), variant, language })
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Could not start the job.');
    ({ jobId, resultUrl } = await response.json());
  } catch (error) {
    showToast(`Could not start server sync: ${error.message}`, 'error');
    return;
  }

  pollServerSyncResult(jobId, resultUrl, 'Synced from Google Drive! Choose or paste the video to watch it.',
    syncState.readings[0].ref);
}

async function startYoutubeSync() {
  if (!syncState.readings.length) {
    showToast('Add at least one reading first.', 'error');
    return;
  }
  const youtubeUrl = $('syncYoutubeUrlInput').value.trim();
  if (!/^https:\/\/(www\.)?(youtube\.com\/watch\?(.*&)?v=|youtu\.be\/)[\w-]{11}/.test(youtubeUrl)) {
    showToast('Paste a valid YouTube video link.', 'error');
    return;
  }

  const variant = parseDafRef(syncState.readings[0].ref)?.variant || 'regular';
  const language = parseDafRef(syncState.readings[0].ref)?.language || 'en';
  setSyncProgress(0, ['Starting the server-side job…']);
  let jobId, resultUrl;
  try {
    const response = await fetch(TRIGGER_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ youtubeUrl, refs: syncState.readings.map((r) => realDafRef(r.ref)), variant, language })
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Could not start the job.');
    ({ jobId, resultUrl } = await response.json());
  } catch (error) {
    showToast(`Could not start server sync: ${error.message}`, 'error');
    return;
  }

  pollServerSyncResult(jobId, resultUrl, 'Synced from YouTube! Choose or paste the video to watch it.',
    syncState.readings[0].ref);
}

// Same shape as startYoutubeSync(), just against trigger-voice-job.mjs --
// see voice_align.py's own docstring for what the engine actually does.
// Publishes to the identical results/by-ref/<ref>.json path/schema, so
// pollServerSyncResult needs no changes to handle either engine's result.
async function startVoiceSync() {
  if (!syncState.readings.length) {
    showToast('Add at least one reading first.', 'error');
    return;
  }
  const youtubeUrl = $('syncVoiceUrlInput').value.trim();
  if (!/^https:\/\/(www\.)?(youtube\.com\/watch\?(.*&)?v=|youtu\.be\/)[\w-]{11}/.test(youtubeUrl)) {
    showToast('Paste a valid YouTube video link.', 'error');
    return;
  }

  const variant = parseDafRef(syncState.readings[0].ref)?.variant || 'regular';
  const language = parseDafRef(syncState.readings[0].ref)?.language || 'en';
  setSyncProgress(0, ['Starting the server-side job…']);
  let jobId, resultUrl;
  try {
    const response = await fetch(TRIGGER_VOICE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ youtubeUrl, refs: syncState.readings.map((r) => realDafRef(r.ref)), variant, language })
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Could not start the job.');
    ({ jobId, resultUrl } = await response.json());
  } catch (error) {
    showToast(`Could not start server sync: ${error.message}`, 'error');
    return;
  }

  pollServerSyncResult(jobId, resultUrl, 'Synced with voice recognition -- review it in the editor before trusting it.',
    syncState.readings[0].ref, 'voice');
}

// ---------------------------------------------------------------------------
// Quick sync: one click, straight from the daf page
// ---------------------------------------------------------------------------

// The sync dialog exists to answer three questions -- which readings, which
// video, and which variant/language. For a daf whose video link was already
// published (by the hourly channel poll or the backfill job) all three are
// already known: the link carries the refs its video covers, and the
// variant/language come from the daf on screen. So there is nothing left to
// choose, and the dialog is pure friction.
//
// Only set when the published link carries coveredRefs. A link without them
// (an older publish, or one a reader pasted by hand) deliberately leaves the
// button hidden rather than guessing at the refs -- syncing against the wrong
// span of canonical text produces a confidently wrong alignment, which is
// worse than making someone open the dialog.
let quickSyncLink = null;

async function refreshQuickSync(ref) {
  const button = $('quickSyncButton');
  if (!button) return;
  quickSyncLink = null;
  button.hidden = true;
  if (!ref) return;
  const link = await fetchServerVideoLink(ref);
  if (!link || link.type !== 'youtube' || !Array.isArray(link.coveredRefs) || !link.coveredRefs.length) return;
  // Guard against a slow fetch landing after the reader has already moved on
  // to a different daf, which would otherwise offer to sync the wrong video.
  if (canonicalDafRef($('dafRef').value) !== ref) return;
  quickSyncLink = link;
  button.hidden = false;
  button.title = `${link.label || link.url}\nCovers: ${link.coveredRefs.join(', ')}`;
}

async function startQuickSync() {
  if (!quickSyncLink) return;
  const ref = canonicalDafRef($('dafRef').value);
  const parsed = parseDafRef(ref);
  const variant = parsed?.variant || 'regular';
  const language = parsed?.language || 'en';
  const button = $('quickSyncButton');

  button.disabled = true;
  button.textContent = 'Starting…';
  setSyncProgress(0, ['Starting the server-side job…']);
  let jobId, resultUrl;
  try {
    const response = await fetch(TRIGGER_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        youtubeUrl: quickSyncLink.url,
        refs: quickSyncLink.coveredRefs,
        variant,
        language,
      })
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Could not start the job.');
    ({ jobId, resultUrl } = await response.json());
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Sync this daf';
    showToast(`Could not start the sync: ${error.message}`, 'error');
    return;
  }

  button.textContent = 'Syncing…';
  // The progress bar lives inside the sync dialog, which isn't open here, so
  // say plainly how long this takes -- otherwise a job that's running fine
  // looks like a button that did nothing.
  showToast(`Syncing ${quickSyncLink.coveredRefs.join(', ')} on the server. `
    + 'This usually takes 10-40 minutes; you can keep using the site.');
  pollServerSyncResult(jobId, resultUrl,
    'Synced from YouTube! The daf and video are ready.', ref);
}

$('openSyncDialogButton')?.addEventListener('click', async () => {
  await loadTalmudIndex();
  renderSyncReadings();
  checkLocalAppStatus();
  $('syncDialog').showModal();
});

// Whether youtube-channel-sync.mjs (the hourly channel poll) should also
// dispatch a server-side OCR sync job automatically for a newly linked
// upload, instead of leaving it linked-but-unsynced until an admin notices
// and starts one by hand. Site-wide, not per-daf, so it's read from/written
// to results/settings.json rather than anything scoped to the daf on
// screen -- reflects the real saved value on load, not just this toggle's
// last-clicked state, since another admin (or another tab) may have
// changed it since.
if ($('autoSyncToggle')) {
  fetch(`https://raw.githubusercontent.com/mosesar9319/MDYsync/results/settings.json?t=${Date.now()}`)
    .then((response) => (response.ok ? response.json() : null))
    .then((settings) => { if (settings) $('autoSyncToggle').checked = Boolean(settings.autoSyncNewUploads); })
    .catch(() => {}); // leave it unchecked, matching the server's own default-off behavior
}
$('autoSyncToggle')?.addEventListener('change', async (event) => {
  const enabled = event.target.checked;
  try {
    const response = await fetch('/api/save-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoSyncNewUploads: enabled }),
      // Ticking the toggle and immediately navigating away (the reported bug)
      // would otherwise let the browser abort this request mid-flight when
      // the page unloads, silently dropping the save with no error shown --
      // keepalive lets it finish in the background past unload, same as
      // sendBeacon.
      keepalive: true,
    });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Could not save the setting.');
    showToast(enabled
      ? 'New channel uploads will now sync automatically on the server.'
      : 'Automatic server-side sync for new uploads is off.');
  } catch (error) {
    event.target.checked = !enabled;
    showToast(`Could not save this setting: ${error.message}`, 'error');
  }
});
$('closeSyncDialog')?.addEventListener('click', () => $('syncDialog').close());
$('syncDialog')?.addEventListener('close', () => {
  // Deliberately do NOT stop polling here: a server-side (or local-app) job
  // keeps running whether or not this dialog is open, so closing it must
  // not abandon watching for the result. It'll still load automatically
  // and toast when done; reopening the dialog re-shows live progress.
});
$('syncTractateSelect')?.addEventListener('change', onSyncTractateChange);
$('syncDafSelect')?.addEventListener('change', onSyncDafChange);
$('dafTractateSelect')?.addEventListener('change', () => {
  refreshDafPickerOptions();
  onDafPickerChanged();
});
$('dafDafSelect')?.addEventListener('change', () => {
  refreshDafPickerAmud();
  onDafPickerChanged();
});
document.querySelectorAll('#dafAmudToggle .amud-option').forEach((button) => {
  button.addEventListener('click', () => {
    if (button.disabled) return;
    document.querySelectorAll('#dafAmudToggle .amud-option').forEach((b) => b.classList.remove('active'));
    button.classList.add('active');
    refreshDafPickerVariantLanguage();
    onDafPickerChanged();
  });
});
document.querySelectorAll('#dafShiurToggle .shiur-variant-option').forEach((button) => {
  button.addEventListener('click', () => {
    if (button.disabled) return;
    setActiveShiurVariant('dafShiurToggle', button.dataset.variant);
    onDafPickerChanged();
  });
});
document.querySelectorAll('#dafLanguageToggle .language-option').forEach((button) => {
  button.addEventListener('click', () => {
    if (button.disabled) return;
    setActiveLanguage('dafLanguageToggle', button.dataset.language);
    onDafPickerChanged();
  });
});
// Only present on browse/index.html -- optional chaining makes this a no-op
// everywhere else, same pattern as the camera-scan listeners above.
$('browsePrevButton')?.addEventListener('click', () => stepBrowseDaf(-1));
$('browseNextButton')?.addEventListener('click', () => stepBrowseDaf(1));
$('browseHideVideoButton')?.addEventListener('click', () => {
  playerCard.classList.remove('revealed');
  if (state.playerType === 'youtube') { if (state.youtubeReady) state.youtubePlayer.pauseVideo(); }
  else htmlVideo.pause();
});
// A catalog link (?ref=Chullin+86a&variant=chazarah&language=hebrew) should
// land straight on that daf instead of the built-in demo -- but the picker
// it feeds (syncDafPickerFromRef) needs the tractate index loaded first, so
// this waits on the same loadTalmudIndex() call the picker itself depends on.
loadTalmudIndex().then(() => {
  const params = new URLSearchParams(location.search);
  // ?view=scan (from the shared nav's "Daf Scan" tab) jumps straight to
  // the Scan view -- independent of whether a ref was also given, since the
  // scan flow resolves its own daf once a photo is scanned. body.scan-only
  // (styles scoped to it in player/index.html's own <style>) hides the
  // video player and daf-reference picker entirely, so the camera-open
  // button is the whole page instead of competing for space next to an
  // empty player -- as close to "opens directly into the camera" as a
  // page load can get without a user gesture already on the file input.
  if (params.get('view') === 'scan') {
    switchDafView('scan');
    document.body.classList.add('scan-only');
    state.scanOnlyMode = true;
  }
  const ref = params.get('ref');
  // The Daf browser (browse/index.html) has no video to load -- either land
  // on whatever ref the query string names, or fall back to the picker's
  // own default selection (its <select>s already default to their first
  // option once loadTalmudIndex() populates them) so the page never opens
  // to a blank state.
  if (state.browseMode) {
    if (ref) syncDafPickerFromRef(ref);
    switchDafView('page'); // the whole point of this page is the page image, not plain text
    onDafPickerChanged();
    return;
  }
  if (!ref) return;
  const wantsChazarah = params.get('variant') === 'chazarah';
  const wantsHebrew = params.get('language') === 'hebrew' || params.get('language') === 'he';
  let fullRef = ref;
  if (wantsChazarah && !/chazarah/i.test(fullRef)) fullRef += ' (Chazarah Daf)';
  if (wantsHebrew && !/hebrew/i.test(fullRef)) fullRef += ' (Hebrew)';
  loadDaf(fullRef).then(() => {
    // ?seekWord=<n> (from the Daf browser's tap-a-word deep link) jumps
    // straight to that word's moment once the alignment's finished loading,
    // instead of just landing on the daf from the top -- seekToVilnaWord
    // wants the plain, variant-/language-less ref its own wordTimeline/
    // segments are keyed under (see realDafRef), not fullRef itself.
    const seekWord = params.get('seekWord');
    if (seekWord !== null && !Number.isNaN(Number(seekWord))) {
      seekToVilnaWord(realDafRef(fullRef), Number(seekWord));
    }
  });
});
document.querySelectorAll('#syncAmudToggle .amud-option').forEach((button) => {
  button.addEventListener('click', () => {
    if (button.disabled) return;
    document.querySelectorAll('#syncAmudToggle .amud-option').forEach((b) => b.classList.remove('active'));
    button.classList.add('active');
  });
});
document.querySelectorAll('#syncShiurToggle .shiur-variant-option').forEach((button) => {
  button.addEventListener('click', () => setActiveShiurVariant('syncShiurToggle', button.dataset.variant));
});
document.querySelectorAll('#syncLanguageToggle .language-option').forEach((button) => {
  button.addEventListener('click', () => setActiveLanguage('syncLanguageToggle', button.dataset.language));
});
$('syncAddReadingButton')?.addEventListener('click', addSyncReading);
$('syncClearReadingsButton')?.addEventListener('click', clearSyncReadings);
$('syncVideoInput')?.addEventListener('change', (event) => {
  const file = event.target.files?.[0];
  syncState.localVideoFile = file || null;
  $('syncVideoFileName').textContent = file ? file.name : 'Processed on this computer, never uploaded';
});
$('syncLocalStartButton')?.addEventListener('click', startLocalSync);
$('syncDriveStartButton')?.addEventListener('click', startDriveSync);
$('syncYoutubeStartButton')?.addEventListener('click', startYoutubeSync);
$('syncVoiceStartButton')?.addEventListener('click', startVoiceSync);
$('quickSyncButton')?.addEventListener('click', startQuickSync);
document.querySelectorAll('.sync-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.sync-tab').forEach((t) => {
      t.classList.toggle('active', t === tab);
      t.setAttribute('aria-selected', String(t === tab));
    });
    document.querySelectorAll('.sync-source-panel').forEach((panel) => {
      panel.hidden = panel.id !== tab.dataset.syncPanel;
    });
    if (tab.dataset.syncPanel === 'syncYoutubePanel' || tab.dataset.syncPanel === 'syncVoicePanel') prefillYoutubeSyncTab();
  });
});
