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
  // See setCaptionsEnabled -- always starts false, matching
  // playerVars.cc_load_policy's own default for a freshly-constructed
  // player.
  captionsEnabled: false,
  usingDefaultAlignment: true,
  editingIndex: 0,
  phraseEditMode: false,
  vilnaMarkMode: false,
  // Admin diagnostic toggle -- see renderVilnaUnmatchedWords.
  showUnmatchedWords: false,
  // Snapshot of segments/editingIndex from when mark mode was turned on (or
  // the last explicit Save) -- what "Discard changes" (see
  // discardVilnaMarkChanges) reverts to. Serialized JSON, not a live
  // object, so later mutations to state.segments can never silently corrupt
  // the very thing meant to undo them.
  vilnaMarkCheckpoint: null,
  alignmentStatus: 'placeholder',
  currentProjectId: null,
  wordTimeline: [],
  lastManualScrollAt: 0,
  alignmentDuration: 0,
  vilnaPageKey: null,
  vilnaPageMap: null,
  vilnaPagePollTimer: null,
  vilnaOverlayKey: '',
  vilnaPageLoadingKey: null,
  // Phrase boundaries for the Daf browser's tap-to-play regions when no
  // video is loaded at all -- see ensureVilnaPageSegments's own comment.
  vilnaFallbackSegments: [],
  vilnaFallbackSegmentsKey: null,
  // Live word-highlight-during-playback for the scanned photo -- the same
  // idea as vilnaOverlayKey above (a dedup key so the highlight doesn't
  // rebuild on every playback tick), just for #scanWordOverlay's
  // .scan-word-box elements instead of the Vilna page's phrase regions
  // (see renderVilnaWordBoxes/activeVilnaWordElements, which read the
  // already-rendered #vilnaActiveOverlay directly rather than keeping a
  // parallel element map the way this one still does). scanWordBoxes is the
  // source list (updateScanOverlay needs to iterate it the same way
  // updateVilnaOverlay iterates state.vilnaPageMap.wordBoxes); scanWordEls
  // is populated alongside it in showScanResult.
  scanOverlayKey: '',
  scanWordBoxes: null,
  scanWordEls: null,
  // The exact ref (with whatever "(Chazarah Daf)"/"(Hebrew)" suffix is
  // currently chosen) the scan-result video picker last loaded -- the
  // single source of truth tapScannedWord compares state.dafRef against to
  // decide whether it needs to (re)load a video. Deliberately NOT just the
  // raw scanned daf ref (result.ref, always the plain unsuffixed form):
  // once the reader picks a non-default combo, state.dafRef itself carries
  // that suffix (loadDaf stores canonicalDafRef's output, which preserves
  // it), so comparing against the plain ref would treat every subsequent
  // word tap as "wrong video loaded" and silently revert to the default
  // combo on every tap.
  scanSelectedRef: null,
  videoOverlayEnabled: false,
  videoOverlayMode: 'full',
  videoOverlayOpacity: 0.5,
  videoOverlayOpacityTarget: 'both',
  videoOverlayIdleMode: 'dim',
  videoOverlayZoom: 1,
  videoOverlayPanX: 0,
  videoOverlayPanY: 0,
  // Player-page Reading Mode: the inverse of videoOverlayEnabled. The same
  // live #videoFrame is temporarily moved over the printed Vilna page, so
  // these values only describe that shell (follow/size/position), never a
  // second media player or a second playback clock.
  readingModeEnabled: false,
  readingVideoFollow: true,
  readingVideoWidth: null,
  readingVideoX: null,
  readingVideoY: null,
  readingModePreviousOverlayEnabled: false,
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
  // Admin-set per-ref overrides of which method is the default for readers
  // (results/settings.json's preferredSyncMethod, keyed by ref) -- see
  // loadDaf()'s dual-fetch and the "Set as default" admin-only control
  // wired in updateSyncMethodSwitchUi(). Empty object, not null, when
  // nothing's been set, so a plain [state.dafRef] lookup never throws.
  syncMethodSettings: {},
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
  // True once the reader has grabbed a corner handle themselves -- guards
  // applyLateDetectionIfStillUseful() below from overwriting a manual
  // correction with a slower automatic result that only shows up after they've
  // already started fixing it by hand.
  scanCornersManuallyEdited: false,
  // Pinch/pan zoom on the synced result photo (see wireScanResultZoom) --
  // a plain CSS transform on #scanResultZoom (translate in wrap-relative
  // px, then scale), reset to identity each time a fresh photo is shown.
  scanResultZoom: 1,
  scanResultPanX: 0,
  scanResultPanY: 0,
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
  // Set by loadDaf() when the NEXT daf's own recording reviews the tail of
  // the one just loaded as its lead-in -- see seekToVilnaWord's own comment
  // for why a boundary word tap should redirect there instead of seeking
  // within the current (earlier) video. Null whenever the next daf's video
  // is the same recording, doesn't exist yet, or doesn't reach back this far.
  forwardAlignment: null,
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
// Kept as (now single-element) arrays rather than rewritten to plain
// element references -- .player-controls/.scrubber-wrap used to carry a
// second "inline" copy of each of these (the only one reachable in native
// fullscreen, back when this bar sat below the video instead of docked
// inside .video-frame itself, see the HTML comment there), and every call
// site below already loops over the group rather than assuming exactly one
// element. Now that there's only ever one of each, .filter(Boolean) still
// does the right thing with zero behavior change.
const scrubberEls = [scrubber].filter(Boolean);
const volumeSliderEls = [$('volumeSlider')].filter(Boolean);
const muteButtonEls = [$('muteButton')].filter(Boolean);
const captionsButtonEls = [$('captionsButton')].filter(Boolean);
const vaaterButtonEls = [$('vaaterButton')].filter(Boolean);
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
  // Reported directly: a fixed 3.2s was fine for a short confirmation
  // ("Restored the saved sync for Chullin 120a.") but nowhere near enough
  // to actually read a longer error message (the video-load failure toast
  // now runs 200+ characters with the ad-blocker/network guidance in it)
  // before it vanished. Scaled to roughly reading speed instead of a flat
  // duration, floored at the old 3200ms so short toasts aren't slowed
  // down, capped at 12s so a very long message doesn't linger indefinitely.
  const duration = Math.min(12000, Math.max(3200, 1200 + message.length * 60));
  state.toastTimer = setTimeout(() => toast.classList.remove('show'), duration);
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

// Narrows a fetched alignment down to just one daf's own segments. Only
// needed now for fetchAlignmentForVideo below -- checking whether some
// OTHER video's own recording happens to reach the daf being read, where
// only the slice for that one ref is wanted, not that video's own
// neighbouring dapim. fetchServerAlignment deliberately stopped calling
// this (see its own comment) once publish_alignment.py made a by-ref
// file's full, unscoped content -- including its lead-in review of the
// previous daf -- both trustworthy and worth keeping for the normal read.
// Segment refs are always plain Sefaria form ("Chullin 104a:2"), never
// carrying a Chazarah/Hebrew variant marker themselves (that's tracked only
// by the file's own key/prefix -- see refKey) -- realDafRef(ref) is exactly
// that same plain form, so a straight string compare against each
// segment's own daf prefix is enough, no further parsing needed.
function scopeAlignmentToDaf(data, ref) {
  if (!data || !Array.isArray(data.segments)) return data;
  const target = realDafRef(ref);
  const belongsToTarget = (r) => typeof r === 'string' && r.split(/[:.]/)[0].trim() === target;
  return {
    ...data,
    segments: data.segments.filter((s) => belongsToTarget(s?.ref)),
    wordTimeline: Array.isArray(data.wordTimeline)
      ? data.wordTimeline.filter((entry) => belongsToTarget(entry?.ref))
      : data.wordTimeline,
  };
}

// A run of consecutive segments (already start-ascending) that all belong
// to the same daf -- the unit dropStrayContextMatches below reasons about,
// since "which daf is on screen" only ever changes at a run boundary.
function buildDafRuns(segments) {
  const runs = [];
  for (const segment of segments) {
    const daf = realDafRef(segment?.ref);
    const last = runs[runs.length - 1];
    if (last && last.daf === daf) last.segments.push(segment);
    else runs.push({ daf, segments: [segment] });
  }
  return runs;
}

// How much wall-clock video a run actually occupies. Deliberately measured
// to the furthest segment END, not to the last segment's start: a run that
// is one single long segment covers real playing time but has no
// start-to-start distance at all, and scoring it as zero would let a
// genuine stretch of reading lose out to noise around it.
function dafRunSpanSeconds(run) {
  const ends = run.segments.map((segment) => Number(segment?.end ?? segment?.start) || 0);
  return Math.max(0, Math.max(...ends) - Number(run.segments[0].start));
}

// Sort key for "which daf comes first", so runs can be compared for forward
// progress: amud b follows amud a on the same daf, and daf N+1 follows both.
// Null for anything that doesn't parse as a daf ref at all.
function dafOrderValue(dafRef) {
  const parsed = parseDafRef(dafRef);
  return parsed ? parsed.daf * 2 + (parsed.amud === 'b' ? 1 : 0) : null;
}

// How long a run has to last to be worth turning the page for. Also the
// tie-breaker that keeps the chosen path from picking up zero-length
// estimated runs it gains nothing from -- they score negative, so they're
// only ever included when they genuinely bridge two real runs.
const DAF_RUN_MIN_MEANINGFUL_SECONDS = 2;

// Picks the subset of runs that tells one forward-moving story, keeping as
// much real playing time as possible.
//
// A shiur only ever moves forward through the dapim -- a lead-in review of
// the previous daf, then its own daf's amud a, then amud b, perhaps
// overrunning into the next. It never goes back. So the runs a recording
// really consists of form a non-decreasing sequence by daf order, and any
// run that breaks that ordering is the OCR matcher's fuzzy text search
// re-matching a stray phrase somewhere it doesn't belong.
//
// Choosing the highest-scoring such sequence (a longest-increasing-
// subsequence walk weighted by each run's duration) is what makes this
// robust where a simpler rule was not. Measured directly against real
// published data, daf 107's own recording opens on a 33-second STRAY match
// to 107b before its genuine 106b lead-in even starts -- long enough that
// no duration threshold would catch it, and positioned so that treating
// "the span of this recording's own daf" as trustworthy threw the entire
// real lead-in away instead. Weighing it against the alternative is what
// gets it right: keeping that opening 107b would force dropping the 106b
// lead-in and all of 107a to stay forward-moving, which costs vastly more
// playing time than the stray is worth.
function keepForwardProgressingRuns(runs) {
  const values = runs.map((run) => dafOrderValue(run.daf));
  // Defensive: a ref that doesn't parse can't be ordered, so there's no
  // sound story to pick. Showing everything is the pre-existing behaviour.
  if (values.some((value) => value === null)) return runs;

  const scores = runs.map((run) => dafRunSpanSeconds(run) - DAF_RUN_MIN_MEANINGFUL_SECONDS);
  const best = scores.slice();
  const cameFrom = runs.map(() => -1);
  for (let i = 0; i < runs.length; i += 1) {
    for (let j = 0; j < i; j += 1) {
      if (values[j] <= values[i] && best[j] + scores[i] > best[i]) {
        best[i] = best[j] + scores[i];
        cameFrom[i] = j;
      }
    }
  }
  let end = 0;
  for (let i = 1; i < runs.length; i += 1) if (best[i] > best[end]) end = i;
  const chosen = [];
  for (let i = end; i !== -1; i = cameFrom[i]) chosen.push(runs[i]);
  return chosen.reverse();
}

// Removes cross-daf matches that a recording can't really have made, so the
// active segment -- and with it the Vilna page image, which follows it --
// stops snapping back and forth between dapim mid-shiur.
//
// Confirmed directly against real published data (by-video/vZVdYYiHHPY.json,
// daf 103's own recording): 48 of its 228 segments match the PREVIOUS daf
// while scattered right through the middle of its own 103a/103b content,
// long after the shiur moved on. Left in, they flip the daf on screen 27
// times over one shiur, which is exactly the "the daf page sometimes
// changes randomly back and forth" report this fixes. Across the six
// shiurim measured, this cuts 64 such flips down to 12 -- two per shiur,
// which is simply the real lead-in -> amud a -> amud b progression.
//
// The keeping rule is forward progress, not proximity to any one daf --
// see keepForwardProgressingRuns for why the obvious alternative fails on
// real data. Word-level timing is filtered to match, since it drives the
// highlight boxes and a stray left there would paint words onto a daf the
// shiur isn't on.
function dropStrayContextMatches(data) {
  if (!Array.isArray(data?.segments) || !data.segments.length) return data;
  const ordered = [...data.segments].sort((a, b) => Number(a.start) - Number(b.start));
  const runs = keepForwardProgressingRuns(buildDafRuns(ordered));
  if (!runs.length) return data;

  const segments = runs.flatMap((run) => run.segments);
  // A safety net, not an expected outcome: if this ever wanted to throw
  // away most of a recording, the shape of that recording is nothing like
  // the model above assumes, and showing it unfiltered (the pre-existing
  // behaviour) beats showing a fraction of it. Measured worst case on real
  // data is 22%.
  if (segments.length < data.segments.length / 2) return data;

  // Each kept run owns the stretch of video from where it starts until the
  // next one does, so a word entry belongs only if its daf matches the run
  // covering its moment -- exactly the daf the page will be showing then.
  const startsAt = runs.map((run) => Number(run.segments[0].start));
  const dafPlayingAt = (time) => {
    let index = 0;
    while (index + 1 < startsAt.length && startsAt[index + 1] <= time) index += 1;
    return runs[index].daf;
  };

  return {
    ...data,
    segments,
    wordTimeline: Array.isArray(data.wordTimeline)
      ? data.wordTimeline.filter((entry) => realDafRef(entry?.ref) === dafPlayingAt(Number(entry?.start)))
      : data.wordTimeline,
  };
}

// The alignment measured against ONE specific recording, whatever dapim it
// happens to cover. by-ref/<ref>.json only ever holds the alignment from the
// shiur that daf is actually *about* (see publish_alignment.py) -- which is
// the right default, but it's the wrong answer while a neighbouring daf's
// video is the one playing. A shiur opens by reviewing the tail of the
// previous daf, so the daf-104 recording legitimately covers the end of
// 103b; asking for that stretch here is what lets the highlight follow along
// through the lead-in, instead of sitting dead until the video reaches its
// own daf. Timestamps only mean anything against the recording they were
// measured from, so this is fetched BY that recording, never by ref alone.
async function fetchAlignmentForVideo(videoId, ref, { voice = false } = {}) {
  if (!videoId) return null;
  try {
    const parsed = parseDafRef(ref);
    const prefix = (voice ? VOICE_KEY_PREFIX : '')
      + (parsed?.language === 'he' ? HEBREW_KEY_PREFIX : '')
      + (parsed?.variant === 'chazarah' ? CHAZARAH_KEY_PREFIX : '');
    const url = `/api/get-results-file?path=${encodeURIComponent(`by-video/${prefix}${videoId}.json`)}`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = await response.json();
    const scoped = scopeAlignmentToDaf(data, ref);
    // Only useful if this recording actually reaches the daf being read --
    // an empty scope means it doesn't, and the caller should keep whatever
    // it already had.
    if (!scoped?.segments?.length) return null;
    // The earliest moment this recording actually reaches ITS OWN daf
    // (primaryRefs, stamped by publish_alignment.py) -- attached so
    // loadDaf's forward-redirect check (state.forwardAlignment) can tell
    // a genuine lead-in match for `ref` (chronologically BEFORE this
    // point) apart from a stray fuzzy-text mismatch elsewhere in the same
    // video. Confirmed directly on real data: daf 103's own recording
    // (vZVdYYiHHPY) genuinely opens on ~2 minutes of "Chullin 102b:11-13"
    // before reaching "Chullin 103a:1" -- but it ALSO carries a spurious
    // "Chullin 102b:1" match 44 minutes in, long after 103a/103b were
    // already underway, almost certainly a fuzzy-text false positive
    // rather than a second review. Null (no filtering) if this video's
    // own primaryRefs never parsed at all, since that only happens for an
    // alignment published before primaryRefs existed.
    const ownRefs = new Set(Array.isArray(data.primaryRefs) ? data.primaryRefs.map(realDafRef) : []);
    const ownStarts = (data.segments || [])
      .filter((s) => ownRefs.has(realDafRef(s?.ref)))
      .map((s) => Number(s.start))
      .filter((t) => Number.isFinite(t));
    scoped.ownContentStart = ownStarts.length ? Math.min(...ownStarts) : null;
    return scoped;
  } catch {
    return null;
  }
}

async function fetchServerAlignment(ref, { voice = false } = {}) {
  try {
    // Proxied through get-results-file.mjs, not fetched straight from
    // raw.githubusercontent.com -- see that function's own comment for why
    // (a real reader hit a 429 on exactly this class of fetch).
    const url = `/api/get-results-file?path=${encodeURIComponent(`by-ref/${refKey(ref, { voice })}.json`)}`;
    const response = await fetch(url);
    if (!response.ok) return null;
    // Deliberately NOT scoped to just this ref (past versions of this
    // function called scopeAlignmentToDaf here). by-ref/<ref>.json is
    // always the FULL alignment for the one recording this daf is
    // primarily about (see publish_alignment.py) -- including its lead-in
    // review of the tail of the previous daf, in the video's own real
    // chronological order. Stripping that down used to be necessary
    // because a by-ref file could carry a totally unrelated daf's
    // segments from a mismatched publish; now that publish_alignment.py
    // guarantees single-video-sourced content, scoping here only threw
    // away the lead-in itself -- confirmed directly: a reader starting
    // daf 103's video (which opens by reviewing the tail of 102b) saw
    // "Chullin 103a" on screen from the first second, because the 102b
    // segments that would have shown while that lead-in was actually
    // playing had already been filtered out before ever reaching
    // state.segments. updateActiveSegment/renderDafWindow/renderVilnaPage
    // already switch what's shown to match whichever segment is actually
    // playing (via state.segments[state.activeIndex]), so keeping the
    // full batch is what makes that follow-along work.
    //
    // Keeping the full batch does mean the matcher's stray cross-daf
    // matches come along with it, though -- filtered out here rather than
    // by narrowing back to one daf, so the real lead-in survives and the
    // strays don't (see dropStrayContextMatches). Applied on this reader
    // path only: the sync-completion dialogs load their job result
    // directly, and an admin reviewing a fresh sync should see exactly
    // what the engine produced, strays included.
    return dropStrayContextMatches(await response.json());
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
    // Proxied through get-results-file.mjs -- see fetchServerAlignment above.
    const url = `/api/get-results-file?path=${encodeURIComponent(`video-links/${refKey(ref)}.json`)}`;
    const response = await fetch(url);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

// "Vaater" ("further"/"next"): originally built by cross-referencing the
// channel's shorter Chazarah Daf (review) recording, but that compared two
// entirely different recordings' pacing for the same text against each
// other, which turned out to be unreliable in both directions (flagging
// real reading as skippable when the review happened to move faster
// through a passage than the full shiur, and missing real explanation when
// it moved slower) -- confirmed against Chullin 95a's real synced data.
//
// This instead reads the full shiur's OWN word-level OCR data (wordTimeline
// -- already loaded with any real synced alignment) directly and always
// steps forward, uniformly, regardless of whether the current moment is
// mid-reading, mid-explanation, or in a gap between entries -- deliberately
// simpler than an earlier version that tried to detect "is this entry
// actually the rabbi explaining, not reading" by its pace (duration/word-
// count) and only step forward in that case, leaving a genuine no-op
// otherwise. That distinction added real complexity for a behavior
// confirmed not to be what a reader actually wants: pressing Vaater while
// genuinely mid-reading should still nudge forward to the next word, not
// sit there doing nothing.
//
// It does NOT simply jump to whichever entry comes next, though -- two
// separate real-world failure modes, confirmed against two different real
// synced dapim, each needing its own check:
//
// 1. A shiur that opens with 11 minutes of unrelated riffing (reading
//    emails, announcements) before actually starting the daf needed THREE
//    presses to get there, because the fuzzy matcher had thrown a couple of
//    short, isolated false-positive hits into that stretch (a phrase in
//    unrelated speech that happened to phonetically resemble a snippet of
//    daf text) -- each too short to trip MAX_PLAUSIBLE_QUOTE_WORDS'
//    exclusion (see voice_align.py), but each still just noise, not a
//    second and third separate thing worth landing on one press at a time.
//    A stray hit like that stands alone -- nothing else picks up near it,
//    on either side -- while genuine reading is a run of entries close
//    together in TIME (see isIsolatedHit).
// 2. Chullin 122a's OCR-synced data needed three presses for the same
//    underlying reason but a different shape entirely: its first two
//    wordTimeline entries run 374s and 261s respectively, each for a
//    single tracked word, with NO gap at all between them or the entry
//    after -- an OCR caption box left sitting on the same line for minutes
//    while the rabbi keeps talking produces one real entry with a hugely
//    disproportionate duration for how few words it spans, not a gap
//    between entries the way an unmatched voice-sync stretch does. Gap-
//    based isolation can't see this at all (adjacent entries, zero gap);
//    only the entry's own PACE -- duration per word it covers -- gives it
//    away (see isExplanationPaced).
//
// A candidate flagged by either check is skipped over in the same press,
// and the entry after it is checked the same way, all the way up to
// wherever real reading actually begins.
const SUSTAINED_GAP_THRESHOLD = 30; // seconds
const EXPLANATION_PACE_THRESHOLD = 6; // seconds/word -- real reading stays well under this
const EXPLANATION_MIN_DURATION = 12; // seconds -- ignore brief holds, not worth a skip

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

// An entry counts as an isolated stray hit -- skippable noise, not a real
// landing spot -- only when it's far (beyond SUSTAINED_GAP_THRESHOLD) from
// BOTH neighbors, not just the one ahead of it. One-sided (checking only
// the gap to the next entry) looked right for finding where a real run of
// reading STARTS, but wrongly flagged the LAST word of a real, if short,
// run as isolated too -- that word is close to the entry before it (part
// of the same run), just followed by a legitimate gap into whatever comes
// after the run ends (a tangent, or simply the video moving on). A
// timeline's own last entry has no "next" to compare against at all and is
// always kept -- there's nothing further to skip to regardless, so
// treating it as skippable noise would just disable Vaater outright with
// one real word still sitting right there.
function isIsolatedHit(timeline, index) {
  const entry = timeline[index];
  const next = timeline[index + 1];
  if (!next) return false;
  const prev = timeline[index - 1];
  const closeToPrev = prev && (entry.start - prev.end) <= SUSTAINED_GAP_THRESHOLD;
  const closeToNext = (next.start - entry.end) <= SUSTAINED_GAP_THRESHOLD;
  return !closeToPrev && !closeToNext;
}

// An entry counts as explanation-paced -- the OCR caption (or voice match)
// held on this word range far longer than actually reading it would take --
// regardless of the gap to its neighbors, unlike isIsolatedHit above. A
// short hold is just a natural pause, not worth a skip; MIN_DURATION
// filters those out before the pace ratio even applies.
function isExplanationPaced(entry) {
  const duration = entry.end - entry.start;
  if (duration < EXPLANATION_MIN_DURATION) return false;
  const words = Math.max(1, entry.w1 - entry.w0 + 1);
  return duration / words >= EXPLANATION_PACE_THRESHOLD;
}

// Either check disqualifies a candidate on its own -- see the two failure
// modes documented above nextReadingTime.
function isSkippableEntry(timeline, index) {
  return isIsolatedHit(timeline, index) || isExplanationPaced(timeline[index]);
}

// Where the Vaater button would jump to from `time`, or null when there's
// nothing word-level to go on, or nothing further ahead to skip to.
function nextReadingTime(time) {
  const timeline = state.wordTimeline;
  if (!timeline.length) return null;
  // -1 when time is before the first entry (findWordTimelineIndexAt's own
  // "no entry started yet" value) -- candidateIndex below then starts at
  // 0, the first entry, exactly like starting from any other position.
  const index = time < timeline[0].start ? -1 : findWordTimelineIndexAt(time);
  for (let candidateIndex = index + 1; candidateIndex < timeline.length; candidateIndex++) {
    if (!isSkippableEntry(timeline, candidateIndex)) return timeline[candidateIndex].start;
  }
  return null;
}

function updateVaaterButtonUi(time = getCurrentTime()) {
  const target = nextReadingTime(time);
  for (const button of vaaterButtonEls) {
    button.hidden = !state.wordTimeline.length;
    button.disabled = target === null;
    button.title = target === null
      ? 'Nothing further ahead to skip to'
      : "Vaater -- skip ahead to the daf's next aligned word";
  }
}

function skipToNextReading() {
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

// publish_alignment.py stamps primaryRefs onto a published alignment with
// the daf(s) that recording is actually ABOUT (most covered refs wins, see
// that module's own primary_daf()) -- always as plain refs, since the
// variant/language markers never applied to the OCR/voice engine's own refs
// at all, only to the display/storage ref the alignment as a whole was
// fetched under. Reattaches this load's variant/language the same way
// dafRefsCoveredByCurrentAlignment() does, so the saved video-link key still
// lands in the right namespace.
function reattachVariantLanguage(refs, dafRef) {
  const loaded = parseDafRef(dafRef);
  const variant = loaded?.variant === 'chazarah' ? ' (Chazarah Daf)' : '';
  const language = loaded?.language === 'he' ? ' (Hebrew)' : '';
  return refs.map((ref) => {
    const parsed = parseDafRef(ref);
    return parsed ? `${parsed.tractate} ${parsed.daf}${parsed.amud}${variant}${language}` : ref;
  });
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
    // Reads the player's own live state via getPlayerState() rather than
    // trusting state.youtubeState (a mirror only updated by the
    // onStateChange event) -- reported directly: the play/pause button
    // could get stuck showing "play" even though the video was visibly
    // progressing, meaning onStateChange isn't reliably firing for every
    // real transition in every environment. getPlayerState() asks the
    // player what it's actually doing right now, so the icon can't go
    // stale even if a state-change event was missed. Falls back to the
    // mirrored value only if the player object itself isn't ready yet.
    return (state.youtubePlayer?.getPlayerState?.() ?? state.youtubeState) !== 1;
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
  // A direct-link <video> has no quality ladder to expose -- hide the
  // control immediately rather than waiting for a stale YouTube-only value
  // to linger on screen. Switching TO YouTube re-shows it itself, from
  // ensureYouTubePlayer's onStateChange/onPlaybackQualityChange handlers
  // (see refreshQualityOptions) once real levels are actually known.
  if (!isYouTube) {
    const control = $('qualityControl');
    if (control) control.hidden = true;
    // Captions are a YouTube-only concept (see setCaptionsEnabled) -- a
    // direct video link has no track for this button to control.
    for (const button of captionsButtonEls) button.hidden = true;
  } else {
    for (const button of captionsButtonEls) button.hidden = false;
  }
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
  // whichever one they most recently entered, so take the segment with the
  // LARGEST start that's still at or before `time` (ties -- identical start
  // values -- broken toward the later array index, same as reading order).
  //
  // This used to stop scanning at the first segment whose start was AFTER
  // `time`, on the assumption state.segments is always start-ascending. A
  // real published alignment can violate that: a bad interpolation anchor
  // confirmed directly on Chullin 112's video (_SGiQoBDjD4) stamped its
  // lead-in review of 111b's paragraphs 1-12 with start times running
  // BACKWARD -- 2408s down to 918s as the paragraph number increased --
  // before the array picked back up in correct order from 111b:13 on. Against
  // data like that, breaking early either froze the highlight on a stale
  // segment (the scan gave up at array index 0 the instant its start
  // exceeded `time`, before ever reaching the correctly-ordered segments
  // sitting later in the array) or, once `time` caught up to the
  // out-of-place cluster, snapped the highlight straight to it -- which is
  // exactly the reported "highlight jumps back ~12 lines" symptom: whatever
  // segment happened to occupy that array position could be well earlier on
  // the printed page than what's actually playing. Scanning the whole array
  // and keeping the true best match is correct regardless of ordering, and
  // costs nothing measurable for a list sized like a real daf's segments.
  let index = -1;
  let bestStart = -Infinity;
  for (let i = 0; i < state.segments.length; i++) {
    const start = state.segments[i].start;
    if (start <= time && start >= bestStart) {
      bestStart = start;
      index = i;
    }
  }
  return index === -1 ? 0 : index;
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
  span.dataset.ref = segment.ref || '';
  span.tabIndex = 0;
  span.setAttribute('role', 'button');
  span.setAttribute('aria-label', `Jump to ${formatTime(segment.start)}: ${segment.he}`);
  span.innerHTML = `<sup class="segment-marker">${index + 1}</sup>${escapeHtml(segment.he)} `;
  span.addEventListener('click', () => {
    hapticTap();
    seekToSegment(index);
  });
  span.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      hapticTap();
      seekToSegment(index);
    }
  });
  // The note button only exists on pages that ship notes.js's dialog markup
  // (browse/player/watch) -- studio has no #noteDialog, so this stays a
  // silent no-op there instead of needing its own page-mode check.
  if (segment.ref && document.getElementById('noteDialog')) {
    const noteButton = document.createElement('button');
    noteButton.type = 'button';
    noteButton.className = 'segment-note-button';
    noteButton.dataset.ref = segment.ref;
    noteButton.title = 'Notes for this line';
    noteButton.setAttribute('aria-label', 'Notes for this line');
    noteButton.textContent = '🗒';
    noteButton.addEventListener('click', (event) => {
      event.stopPropagation();
      window.DafNotes?.open(segment.ref, segment.he);
    });
    span.appendChild(noteButton);
  }
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
  // Deliberately NOT anchored to the end of the string. Some published
  // alignments carry the marker in the MIDDLE of a segment ref -- e.g.
  // "Chullin 98b (Chazarah Daf):1", where the paragraph number follows it
  // -- and an end-anchored strip left those refs unparseable, which then
  // silently disabled everything keyed off a parsed ref: no Vilna page
  // (currentVilnaPageKey bails on a null parse), no word highlighting and
  // no tap-to-seek (the ref never normalized to the dot form word boxes
  // use). 24 of the 150 published alignments are in exactly that shape.
  // Each marker appears at most once, so a single non-anchored strip each
  // handles both orders and both positions.
  const chazarahMarker = /\s*\(Chazarah Daf\)/i;
  const hebrewMarker = /\s*\(Hebrew\)/i;
  if (chazarahMarker.test(working)) { variant = 'chazarah'; working = working.replace(chazarahMarker, ''); }
  if (hebrewMarker.test(working)) { language = 'he'; working = working.replace(hebrewMarker, ''); }
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

// The ref one amud after the given one, in the same tractate/variant/
// language -- amud 'a' advances to 'b' on the same daf, 'b' advances to
// the next daf's 'a'. Used by loadDaf() to check whether the NEXT daf's
// own recording reviews the tail of THIS one as its lead-in (see
// seekToVilnaWord's forward-redirect) -- doesn't need to know a
// tractate's real last daf; asking about a ref past the end just gets an
// empty/404 response back like any other never-synced daf.
function nextDafRef(ref) {
  const parsed = parseDafRef(ref);
  if (!parsed) return null;
  const daf = parsed.amud === 'a' ? parsed.daf : parsed.daf + 1;
  const amud = parsed.amud === 'a' ? 'b' : 'a';
  const variantSuffix = parsed.variant === 'chazarah' ? ' (Chazarah Daf)' : '';
  const languageSuffix = parsed.language === 'he' ? ' (Hebrew)' : '';
  return `${parsed.tractate} ${daf}${amud}${variantSuffix}${languageSuffix}`;
}

// Same Sefaria calendar lookup index.html's own hero card uses to find
// today's Daf Yomi -- duplicated here (rather than shared) since the two
// pages have no module system to share it through. Used by the Daf browser
// to default to today's daf instead of the picker's arbitrary first option.
// Returns a ref string like "Chullin 86a" (amud "a", the conventional
// starting point for a daf someone hasn't specified a side for), or null if
// the lookup fails or today isn't a Talmud Daf Yomi day.
async function fetchTodaysDafRef() {
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const response = await fetch(`https://www.sefaria.org/api/calendars?timezone=${encodeURIComponent(timezone)}`);
    if (!response.ok) throw new Error(`Sefaria returned ${response.status}`);
    const data = await response.json();
    const item = (data.calendar_items || []).find((i) => i.category === 'Talmud' && i.title?.en === 'Daf Yomi');
    if (!item) return null;
    const match = /^(.+?)\s+(\d+)$/.exec(String(item.displayValue?.en || '').trim());
    return match ? `${match[1]} ${match[2]}a` : null;
  } catch (error) {
    console.error('Could not load today’s daf.', error);
    return null;
  }
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
let vilnaCanvasRenderQueue = Promise.resolve();

// PDF.js rejects if the same canvas is used by two render tasks at once.
// Reading Mode, fullscreen, and a pinch-zoom can all request a new raster
// size within the same moment, so serialize main-page paints. Each queued
// job reads the newest page/zoom dimensions before it is scheduled by its
// caller; a later job then naturally settles the canvas on the latest size.
function renderVilnaCanvas(page, canvas, viewport) {
  const job = async () => {
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  };
  vilnaCanvasRenderQueue = vilnaCanvasRenderQueue.catch(() => {}).then(job);
  return vilnaCanvasRenderQueue;
}

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
  if (state.vilnaPageKey === key) {
    // This page is already rendered -- but a render that started for a
    // DIFFERENT key may have hidden the canvas on its way in
    // (setVilnaPageStatus does that) and then bailed at its own
    // stillWanted() check without ever restoring it. That's what turned a
    // momentary daf excursion into a page that just went blank and stayed
    // blank: the excursion hid the canvas, the flip back landed here, and
    // this early return left it hidden. Restore instead of only returning.
    if (canvas.hidden) {
      $('vilnaPageStatus').hidden = true;
      canvas.hidden = false;
    }
    return;
  }
  if (state.vilnaPageLoadingKey === key) return;
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

    canvas.style.width = `${containerWidth}px`;
    canvas.style.removeProperty('height');
    await renderVilnaCanvas(page, canvas, viewport);
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

// Sefaria's text API returns paragraph refs with a period ("Chullin
// 81a.15"), while the page-OCR pipeline historically published the same
// refs with a colon ("Chullin 81a:15"). They identify the exact same text,
// but every word-highlight/seek lookup is intentionally an exact match. Put
// incoming page-map refs into Sefaria's canonical shape once at the boundary
// so the existing player, scanner, and Reading Mode all share one key.
function normalizeDafParagraphRef(ref) {
  return String(ref || '').trim()
    // A Vilna page/scan word box's ref is always the plain tractate/daf/
    // amud form, never carrying a "(Chazarah Daf)"/"(Hebrew)" marker (the
    // variant is tracked by the alignment's own key -- see refKey), so a
    // segment ref that does carry one could never string-equal the word
    // box it belongs to. Stripped here so both sides land in the same
    // shape, which is what the exact-string comparisons in
    // updateVilnaOverlay/updateScanOverlay/seekToVilnaWord all rely on.
    // No-op for the refs that were already plain.
    .replace(/\s*\((?:Chazarah Daf|Hebrew)\)/gi, '')
    .replace(/(\d+[ab])[:.](\d+)$/i, '$1.$2');
}

function normalizePageWordBoxes(wordBoxes) {
  return Array.isArray(wordBoxes)
    ? wordBoxes.map((box) => ({ ...box, ref: normalizeDafParagraphRef(box.ref) }))
    : [];
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
// renderVilnaWordBoxes groups this page's word boxes into clickable PHRASE
// regions using segment (alignment) boundaries -- but on the Daf browser, a
// page is routinely on screen with NO video loaded at all (onDafPickerChanged
// only sets state.browsePageRef and re-renders the page image; it never
// calls loadDaf, so state.segments stays whatever it was before, which is
// usually nothing for this page's own refs). Phrase boundaries only exist
// inside an alignment -- updateVilnaOverlay relies on the exact same
// state.segments for the same reason -- so when this page's own refs aren't
// already covered by whatever's loaded, fetch this page's by-ref alignment
// purely to learn where each phrase begins and ends. fetchServerAlignment is
// the same lightweight, video-free fetch loadDaf itself starts from; a real
// tap still goes through playWordInline -> loadDaf to actually load and
// play anything. Cached per page (vilnaFallbackSegmentsKey) so flipping back
// to an already-seen page doesn't refetch it.
async function ensureVilnaPageSegments(parsed, wordBoxes, stillWanted) {
  const refs = new Set(wordBoxes.map((box) => box.ref));
  const covered = new Set(state.segments.map((s) => s.ref));
  if (![...refs].some((ref) => !covered.has(ref))) return;
  const pageKey = pageMapKey(parsed);
  if (state.vilnaFallbackSegmentsKey === pageKey) return;
  const activeRef = state.browsePageRef || state.segments[state.activeIndex]?.ref || state.dafRef;
  // Tried in the same order loadDaf itself prefers (see its own dual-method
  // fetch) -- OCR-based text alignment first, voice recognition only if this
  // daf was never synced by the OCR engine at all.
  const fetched = activeRef
    ? (await fetchServerAlignment(activeRef)) || (await fetchServerAlignment(activeRef, { voice: true }))
    : null;
  if (!stillWanted()) return;
  state.vilnaFallbackSegmentsKey = pageKey;
  state.vilnaFallbackSegments = fetched?.segments || [];
}

async function loadVilnaPageMap(parsed, stillWanted = () => true) {
  stopVilnaPagePoll();
  state.vilnaPageMap = null;
  state.vilnaOverlayKey = '';
  state.vilnaFallbackSegments = [];
  state.vilnaFallbackSegmentsKey = null;
  $('vilnaPageOverlay').innerHTML = '';
  $('vilnaActiveOverlay').innerHTML = '';
  const key = pageMapKey(parsed);
  // Proxied through get-results-file.mjs, not fetched straight from
  // raw.githubusercontent.com -- see that function's own comment. Matters
  // especially here: a rate-limited fetch used to look identical to "never
  // OCR'd" and trigger a redundant re-sync job plus this same poll loop
  // hitting the same rate limit again.
  const resultUrl = `/api/get-results-file?path=${encodeURIComponent(`pages/${key}.json`)}`;

  const tryFetch = async () => {
    try {
      const response = await fetch(resultUrl);
      if (!stillWanted()) return true; // a newer page has since taken over; stop polling, apply nothing
      if (!response.ok) return false;
      const data = await response.json();
      if (!stillWanted()) return true;
      data.wordBoxes = normalizePageWordBoxes(data.wordBoxes);
      state.vilnaPageMap = data;
      await ensureVilnaPageSegments(parsed, data.wordBoxes, stillWanted);
      if (!stillWanted()) return true;
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
  // Zooming changes the active words' screen coordinates even while the
  // shiur is paused, outside the normal playback-update path.
  scheduleReadingVideoFollow(false, 180);
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
  // The per-word click targets are positioned in percentages of the wrap's
  // CSS layout box (unchanged here -- only the canvas's internal pixel
  // resolution is), so they stay aligned without needing to be rebuilt.
  await renderVilnaCanvas(page, canvas, viewport);
  // The highlight bars are snapped to ink measured off this canvas (see
  // measureInkBands), so a fresh raster means a fresh measurement. Clear
  // the repaint guard to force one -- and this also recovers the case
  // where the first paint happened before there were any pixels to read.
  state.vilnaOverlayKey = '';
  updateVilnaOverlay(getCurrentTime());
  updateVilnaMarkTarget();
}

function toggleVilnaFullscreen() {
  const card = document.querySelector('.daf-card');
  if (!card) return;
  // In Reading Mode the live player is a sibling of the daf card. Browser
  // fullscreen only paints the chosen element and its descendants, so
  // fullscreen the shared watch surface to keep both the daf and mini-player
  // visible without moving/reloading the YouTube iframe. Everywhere else the
  // daf card remains the correct, smaller fullscreen target.
  const watchSurface = card.closest('.watch-layout');
  const target = state.readingModeEnabled && watchSurface ? watchSurface : card;
  const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
  if (fullscreenElement) {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (exit) Promise.resolve(exit.call(document)).catch((error) => showToast(`Could not exit fullscreen: ${error.message}`, 'error'));
    return;
  }
  const request = target.requestFullscreen || target.webkitRequestFullscreen;
  if (!request) return showToast('Fullscreen is not available in this browser.', 'error');
  Promise.resolve(request.call(target)).catch((error) => showToast(`Fullscreen not available: ${error.message}`, 'error'));
}

// Word/segment taps across every daf view (Vilna page, scanned photo, video
// overlay, plain text) share this -- a short buzz confirming the tap
// registered. Android's Chrome/WebView support the Vibration API; iOS Safari
// has never implemented it (a hard platform limitation with no workaround
// from a web page), so this is a silent no-op there rather than something
// that needs feature-specific handling per call site.
function hapticTap() {
  navigator.vibrate?.(15);
}

// Renders one clickable region per PHRASE (segment) rather than per word --
// grouped into per-printed-line rects the same way updateVilnaOverlay
// already groups the CURRENTLY PLAYING phrase (see groupBoxesIntoLineRects),
// so a phrase's hit-region is exactly the shape of its own printed text
// instead of a stack of individually oversized (see the old .vilna-word-box
// CSS transform, now removed) word boxes whose padding routinely bled into
// the line above or below and stole taps meant for a neighboring word -- a
// real report of exactly that. There is deliberately no way left to select
// one word out of the phrase it belongs to: hovering or clicking always
// means the whole phrase, matching how the video was only ever going to
// seek to that phrase's own start regardless of which word inside it got
// tapped (segment-level timing, not word-level, is what every alignment
// actually has reliably -- voice sync in particular only ever populates
// wordTimeline sparsely).
//
// markSegmentAtVilnaWord/seekToVilnaWord/playWordInline all already resolve
// a (ref, wordIndex) pair back to *the segment that pair falls within*, not
// to that literal word -- so passing each phrase's own first word (w0)
// through those same, already-correct functions is enough on its own; none
// of their seek/mark logic needed to change for this.
// state.segments alone (whichever video is actually loaded, if any) is
// preferred; ensureVilnaPageSegments's video-free fallback only fills in
// refs state.segments doesn't already cover (e.g. the Daf browser showing a
// page with nothing loaded yet), so a real loaded video's own segments are
// never shadowed by the fallback's. Shared by renderVilnaWordBoxes (phrase
// click regions) and renderVilnaUnmatchedWords (admin coverage-gap
// diagnostic) -- both need the same "what do we actually know about this
// page's phrases" view.
function effectiveVilnaSegments() {
  const covered = new Set(state.segments.map((s) => s.ref));
  return state.segments.concat(
    (state.vilnaFallbackSegments || []).filter((s) => !covered.has(s.ref))
  );
}

function renderVilnaWordBoxes() {
  const overlay = $('vilnaPageOverlay');
  if (!overlay) return;
  overlay.innerHTML = '';
  if (!state.vilnaPageMap) return;

  const segments = effectiveVilnaSegments();

  // The same physical phrase can appear more than once (a ref's alignment
  // occasionally still carries this -- see markSegmentAtVilnaWord's own
  // comment on repeated occurrences), and rendering it twice would just
  // stack two exactly-overlapping, functionally-identical hit-regions. One
  // entry per distinct span, kept in first-seen (chronological) order.
  const spans = new Map(); // spanKey -> segment index
  segments.forEach((segment, index) => {
    const spanKey = `${segment.ref}:${segment.w0}:${segment.w1}`;
    if (!spans.has(spanKey)) spans.set(spanKey, index);
  });

  const bands = vilnaInkBands(state.vilnaPageMap);
  for (const index of spans.values()) {
    const segment = segments[index];
    const hasRange = segment.w0 !== null && segment.w1 !== null;
    const boxes = state.vilnaPageMap.wordBoxes
      .filter((box) => box.ref === segment.ref
        && (!hasRange || (box.wordIndex >= segment.w0 && box.wordIndex <= segment.w1)))
      .sort((a, b) => a.wordIndex - b.wordIndex);
    if (!boxes.length) continue;

    const els = groupBoxesIntoLineRects(boxes, state.vilnaPageMap, bands).map((rect) => {
      const el = document.createElement('div');
      el.className = 'vilna-phrase-box';
      el.style.left = `${rect.left * 100}%`;
      el.style.top = `${rect.top * 100}%`;
      el.style.width = `${rect.width * 100}%`;
      el.style.height = `${rect.height * 100}%`;
      overlay.appendChild(el);
      return el;
    });
    // A phrase spanning several printed lines is several separate rect
    // elements -- hovering any one of them highlights all of them together
    // (plain CSS :hover can't reach sibling elements on its own), and any
    // of them is an equally valid click target for the same phrase.
    const wordIndex = segment.w0 ?? 0;
    const onEnter = () => { for (const el of els) el.classList.add('phrase-hover'); };
    const onLeave = () => { for (const el of els) el.classList.remove('phrase-hover'); };
    const onClick = () => {
      hapticTap();
      // The Daf browser has its own video player on the same page -- a
      // click plays into that in place instead of navigating away (same
      // idea as the scan feature's tapScannedWord).
      if (state.browseMode) playWordInline(segment.ref, wordIndex);
      else if (state.vilnaMarkMode) markSegmentAtVilnaWord(segment.ref, wordIndex);
      else seekToVilnaWord(segment.ref, wordIndex);
    };
    for (const el of els) {
      el.addEventListener('pointerenter', onEnter);
      el.addEventListener('pointerleave', onLeave);
      el.addEventListener('click', onClick);
    }
  }
  updateVilnaMarkTarget();
  scheduleReadingVideoFollow(true, 0);
  renderVilnaUnmatchedWords();
}

// Admin diagnostic (state.showUnmatchedWords, toggled by
// #vilnaUnmatchedToggleButton): flags every printed word this page's
// alignment data gives no evidence for, so an admin reviewing a sync can
// spot real coverage gaps -- a paragraph that was never matched at all, or
// a few words at the edge of an otherwise-synced phrase that slipped
// through -- without having to read timestamps by hand.
//
// A ref is only judged if at least one of its segments actually carries a
// word-level w0/w1 boundary; most alignments only ever have segment-level
// timing (w0/w1 null on every segment for that ref), and flagging every
// word in THAT case would paint most of a normal daf red, burying the
// real gaps this exists to surface. A ref with no segments at all is a
// gap in full: every one of its words gets flagged.
function renderVilnaUnmatchedWords() {
  const overlay = $('vilnaUnmatchedOverlay');
  if (!overlay) return;
  overlay.innerHTML = '';
  if (!state.showUnmatchedWords || !state.vilnaPageMap) return;

  const segments = effectiveVilnaSegments();
  const segmentsByRef = new Map();
  for (const segment of segments) {
    if (!segmentsByRef.has(segment.ref)) segmentsByRef.set(segment.ref, []);
    segmentsByRef.get(segment.ref).push(segment);
  }

  for (const box of state.vilnaPageMap.wordBoxes) {
    const refSegments = segmentsByRef.get(box.ref) || [];
    const ranged = refSegments.filter((s) => s.w0 !== null && s.w1 !== null);
    // A ref with segments but none of them ranged has only phrase-level
    // timing -- nothing here to compare a specific word against, so it's
    // left alone rather than flagged (see the function's own comment).
    if (refSegments.length && !ranged.length) continue;
    const matched = ranged.some((s) => box.wordIndex >= s.w0 && box.wordIndex <= s.w1);
    if (matched) continue;
    const el = document.createElement('div');
    el.className = 'vilna-unmatched-box';
    el.style.left = `${box.x * 100}%`;
    el.style.top = `${box.y * 100}%`;
    el.style.width = `${box.w * 100}%`;
    el.style.height = `${box.h * 100}%`;
    overlay.appendChild(el);
  }
}

// loadAlignmentData() (shared with the player/studio) deliberately shows
// the alignment job's own internal title there ("Caption OCR alignment --
// Chullin 100b, Chullin 101a, Chullin 101b") -- useful for an admin
// reviewing a sync job, meaningless to a reader just watching. The video's
// own real title (state.videoSource.label -- the actual channel upload
// title, once loadDaf's restoreVideoSource has resolved) belongs here
// instead; falls back to the plain daf ref if a video ever has no real
// label of its own. 'YouTube'/'Direct link' are loadYouTubeVideo/
// loadDirectVideoUrl's own generic placeholder labels for a source with no
// real title of its own -- not worth showing over the plain daf ref either.
// Shared by every "load/reveal the inline player" entry point (the Daf
// browser's playWordInline, the scan feature's tapScannedWord/showScanResult).
function applyRealVideoTitle(ref) {
  const genericLabels = ['YouTube', 'Direct link'];
  const realLabel = state.videoSource?.label && !genericLabels.includes(state.videoSource.label) ? state.videoSource.label : null;
  $('lectureTitle').textContent = realLabel || realDafRef(ref);
}

// The Daf browser's own in-page equivalent of tapScannedWord below --
// same "load the tapped word's daf if it isn't already on screen" shape,
// but plays into browse/index.html's own .player-card, which now sits
// side by side with the daf (same layout as every other page that embeds
// this player) rather than leaving the page. Loading a different ref here
// never disturbs which page image is shown: renderVilnaPage (via
// currentVilnaPageKey) always prefers state.browsePageRef over anything
// video/segment-derived, and loadDaf() never touches the view-switch itself.
async function playWordInline(ref, wordIndex) {
  // Only meaningful once the layout collapses to a single column (see the
  // 1120px breakpoint in browse/index.html) -- side by side on a wider
  // screen the video is already in view, and this is a harmless no-op.
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
  // After seekToVilnaWord below, not before -- a forward redirect (see its
  // own comment) can swap state.videoSource out for the next daf's
  // recording, and this daf's own generic label would otherwise linger on
  // screen for a video that isn't playing that title's daf anymore.
  await seekToVilnaWord(ref, wordIndex);
  applyRealVideoTitle(ref);
  if (isPaused()) await togglePlay();
}

// Shared by seekToVilnaWord's own lookup and its forward-redirect check
// against state.forwardAlignment below -- word-level timing (wordTimeline)
// preferred, falling back to segment-level. Most alignments only ever
// carry segment-level timing, not word-level -- wordTimeline stays empty
// for those. Without the fallback, clicking a word on the Vilna page
// (either the standalone page view or the video overlay) silently did
// nothing whenever that was the case, while the plain text view kept
// working fine since .daf-segment's click (see seekToSegment) never
// depended on word-level data in the first place. A ref can now span
// several phrase-chunk segments (see caption_ocr_align.py's
// _split_word_ranges), so prefer the one whose own w0/w1 actually covers
// this word before falling back to just the first segment with a
// matching ref. Returns null, not undefined, when nothing matches, so a
// caller can tell "no match" apart from a genuine 0.
function findWordTime(wordTimeline, segments, ref, wordIndex) {
  const entry = wordTimeline.find((e) => e.ref === ref && wordIndex >= e.w0 && wordIndex <= e.w1);
  if (entry) return entry.start;
  const segment = segments.find((s) => s.ref === ref && s.w0 !== null && wordIndex >= s.w0 && wordIndex <= s.w1)
    || segments.find((s) => s.ref === ref);
  return segment ? segment.start : null;
}

async function seekToVilnaWord(ref, wordIndex) {
  // A tap on a word that's ALSO the next daf's own lead-in review should
  // land in that (later) recording, not this one -- see loadDaf's own
  // comment on state.forwardAlignment for the real report this fixes.
  // Checked first, against the forward alignment's own (narrow) coverage:
  // it only ever holds the exact words that recording actually reviews,
  // so finding nothing here and falling through to this daf's own video
  // below is the common, correct case, not a failure.
  if (state.forwardAlignment?.ref === ref
      && findWordTime(state.forwardAlignment.wordTimeline, state.forwardAlignment.segments, ref, wordIndex) !== null) {
    try {
      await loadDaf(state.forwardAlignment.ref, { silent: true });
    } catch (error) {
      console.error(error);
      // Falls through to this daf's own timing below rather than giving
      // up entirely -- a failed forward-load still leaves a usable seek.
    }
  }
  const time = findWordTime(state.wordTimeline, state.segments, ref, wordIndex);
  if (time === null) return;
  state.lastManualScrollAt = 0;
  seek(time + 0.03, true);
  updateActiveSegment(true);
}

// --- Camera-scan feature (see scan-daf-page.mjs) ---------------------------
// Point the camera at a physical printed page, recognize which daf it is
// from just its header, then tap any word on the photo to jump the video
// there -- reuses seekToVilnaWord() above, since a scanned word's
// (ref, wordIndex) means the same thing regardless of which view found it.

// Was 1600 -- raised after a direct A/B test (a realistic degraded photo:
// blur + uneven lighting + JPEG recompression, run through the real OCR/
// match pipeline) showed the header text simply wasn't legible enough at
// 1600 on that photo, while the identical photo at 2400 OCR'd and matched
// correctly. Header OCR only has the header's own printed text to work
// with -- unlike the word-tap overlay, which can tolerate some blur since
// a reader is aiming for a whole word, not a single character -- so losing
// a letter of a 2-3 character gematria number is enough to misidentify the
// page (see matchHeader's minMargin). Still well clear of scan-daf-page.mjs's
// 8MB cap: a real degraded test photo at 2400 came out under 450KB as JPEG.
const SCAN_MAX_DIMENSION = 2400;
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
// The actual OpenCV.js pipeline (loading the library, running the edge/
// contour detection) lives in scan-detect-worker.js, run in a Web Worker
// rather than here on the main thread -- a real end-to-end trial against an
// earlier main-thread version found the library's own runtime bring-up can
// monopolize its thread for a long time before settling, in at least some
// browser environments. Off the main thread that only delays this one
// background task (still bounded by AUTO_DETECT_TIMEOUT_MS below); on the
// main thread it would have frozen the whole page's UI while it happened,
// which a JS-level timeout can't rescue (a stuck synchronous block can't be
// interrupted by a pending setTimeout). This function's job is just getting
// the photo's pixels to the worker and its answer back.
//
// NOT YET VALIDATED AGAINST REAL PHONE PHOTOS: this sandbox's headless
// browser has no outbound network access at all (confirmed directly -- even
// a bare `fetch()` to the CDN the worker loads from fails here), so neither
// the OpenCV.js load nor the detection pipeline's actual accuracy on a real
// photographed page could be exercised end to end during development. The
// geometry/confidence math below (orderQuadPoints, scoreQuadConfidence) is
// tested directly; the CV pipeline itself follows the standard,
// well-established technique real scanner apps use, but its real-world hit
// rate on an actual phone photo is unverified -- same caveat
// scan-daf-page.mjs already documents for the header-OCR step it feeds into.

let scanDetectWorker = null;
let scanDetectRequestId = 0;
const scanDetectPendingRequests = new Map();

// Bumped once per autoDetectAndProceed() call -- lets a detection promise
// that resolves LATE (after its own timeout already fired, see
// applyLateDetectionIfStillUseful below) recognize it's answering a photo
// the reader has since moved on from (retook the photo, or a second scan
// entirely) and skip applying its stale result.
let scanAttemptToken = 0;

function ensureScanDetectWorker() {
  if (scanDetectWorker) return scanDetectWorker;
  scanDetectWorker = new Worker('/scan-detect-worker.js');
  scanDetectWorker.onmessage = (event) => {
    const { id, quad, error, phase, cvAlreadyWarm, cvLoadMs } = event.data;
    const pending = scanDetectPendingRequests.get(id);
    if (!pending) return; // already timed out / no longer wanted
    // A progress update (see scan-detect-worker.js's own phase posts), not
    // the final answer -- record it and keep waiting. This is what lets a
    // timeout later report WHERE the budget actually went (library never
    // finished loading vs. loaded fine but the scan itself was slow)
    // instead of just "timed out" with no further signal.
    if (phase) {
      pending.phase = phase;
      pending.cvAlreadyWarm = cvAlreadyWarm;
      pending.cvLoadMs = cvLoadMs;
      return;
    }
    scanDetectPendingRequests.delete(id);
    if (error) pending.reject(new Error(error));
    else pending.resolve(quad);
  };
  scanDetectWorker.onerror = (event) => {
    // A worker-level failure (e.g. the worker script itself 404s) can't be
    // attributed to one in-flight request -- fail all of them, and drop the
    // worker so the next scan attempt spins up a fresh one rather than
    // reusing one that's already in a bad state.
    for (const pending of scanDetectPendingRequests.values()) {
      pending.reject(new Error(event.message || 'Page-detection worker failed.'));
    }
    scanDetectPendingRequests.clear();
    scanDetectWorker = null;
  };
  return scanDetectWorker;
}

// Corner/edge detection doesn't need OCR-quality resolution -- unlike the
// header crop (which reads small printed characters), finding a page-shaped
// quad only needs enough pixels to see its edges. A real trial still hit
// the auto-detect timeout even after prewarming the library and widening
// the budget to 20s, which the phase diagnostics below should clarify, but
// this shrinks the OTHER lever regardless of which one it turns out to be:
// scan-detect-worker.js now runs Canny/contour detection up to 3 times per
// attempt (see cannyThresholdStrategies), and that compute cost scales with
// pixel count -- detecting on a much smaller copy of the photo cuts it
// substantially, for free, whether or not the library's own load time is
// also a factor.
const DETECT_MAX_DIMENSION = 900;

// Decodes the photo into raw RGBA pixels (the worker has no DOM/canvas/Image
// element of its own to decode with) and hands them to the detection
// worker, transferring the pixel buffer rather than copying it. Returns the
// detected quad in ORIGINAL image-pixel space (unordered), or null if
// nothing plausible was found -- detection itself runs on a downscaled copy
// (see DETECT_MAX_DIMENSION above), so points are rescaled back up before
// returning, transparent to every caller.
let lastScanDetectRequestId = null;
async function detectPageCornersInWorker(photoDataUrl, width, height) {
  const img = await loadImageElement(photoDataUrl);
  const scale = Math.min(1, DETECT_MAX_DIMENSION / Math.max(width, height));
  const detectWidth = Math.round(width * scale);
  const detectHeight = Math.round(height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = detectWidth;
  canvas.height = detectHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, detectWidth, detectHeight);
  const { data } = ctx.getImageData(0, 0, detectWidth, detectHeight);

  const worker = ensureScanDetectWorker();
  const id = ++scanDetectRequestId;
  lastScanDetectRequestId = id;
  const quad = await new Promise((resolve, reject) => {
    scanDetectPendingRequests.set(id, { resolve, reject, phase: 'queued' });
    worker.postMessage({ id, width: detectWidth, height: detectHeight, buffer: data.buffer }, [data.buffer]);
  });
  return quad ? quad.map(([x, y]) => [x / scale, y / scale]) : null;
}

// Reads back whatever progress the LAST detection request reported before a
// timeout fires (see ensureScanDetectWorker's phase handling) -- lets the
// timeout message tell the difference between "the library never finished
// loading" (a network/WASM-compile bottleneck, where prewarming/budget
// tuning are the only levers) and "it loaded fine but scanning this photo
// itself was slow" (a compute bottleneck, where DETECT_MAX_DIMENSION/the
// number of Canny strategies tried are the levers instead) -- real signal
// for the next report instead of another blind guess between those two.
function describeDetectionTimeout() {
  const pending = scanDetectPendingRequests.get(lastScanDetectRequestId);
  if (!pending || pending.phase === 'queued') {
    return 'Timed out detecting the page automatically (the detector never finished loading).';
  }
  if (pending.phase === 'cv-ready') {
    const loadNote = pending.cvAlreadyWarm ? 'was already warmed up' : `took ${pending.cvLoadMs}ms to load`;
    return `Timed out detecting the page automatically (the detector ${loadNote} but scanning this photo took too long).`;
  }
  return 'Timed out detecting the page automatically.';
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
// Was 0.55 -- a real trial still needed the manual fallback after widening
// scan-detect-worker.js's edge detection (see there), and without real
// telemetry from that trial there's no way to tell whether the failure was
// "no quad found at all" (which a looser edge threshold addresses) or "a
// quad was found but scored under the old threshold" (which only this
// helps). Nudged down as a second, independent hedge against the latter,
// still comfortably above the 0.15 "looks like a mis-detection" scores
// above -- a real page's quad in a normal photo should still clear this
// easily; this only changes the margin for a borderline, hard-to-classify
// case like the one reported.
const CORNER_CONFIDENCE_THRESHOLD = 0.45;

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

// Moving detection into a worker (above) stops a stuck library load from
// freezing the page, but the *promise* waiting on that worker's answer can
// still hang just as long -- a real trial found this library's own runtime
// bring-up can simply never settle in some environments. Generous, but
// bounded: a stuck (or merely slow-on-a-weak-device) detection always
// degrades gracefully to the manual step instead of leaving the reader on
// "Finding the page…" forever.
// Was 8000 -- a real trial reported auto-detect still always falling back
// to manual alignment even after two rounds of Canny/confidence tuning
// (see scan-detect-worker.js and CORNER_CONFIDENCE_THRESHOLD above), which
// pointed at a different, previously-untested bottleneck: opencv.js is a
// multi-megabyte WASM download+compile, and 8 seconds may simply not be
// enough time for BOTH that cold load AND the actual detection on a real
// mobile connection -- in which case every threshold tweak was irrelevant,
// since detection never got far enough to run at all (see prewarmScanDetection
// below, which now also starts that download well before it's needed).
// Widened generously since a real, successful detection itself only takes a
// fraction of a second once the library's loaded; the budget mostly needs to
// cover a slow network's worst case, not the compute.
//
// A second real trial (with the phase diagnostics this comment used to only
// hope for) confirmed the library-load branch specifically: the detector
// never even reached 'cv-ready' inside this budget. Investigated directly
// (not guessed) whether that's a self-hosting/compression problem -- it
// isn't: jsdelivr already serves this file brotli-compressed (~2.9MB, not
// the ~10MB raw size), so there's no obvious network win left to chase by
// vendoring it. What's actually unverifiable from here is whether a slow
// device/connection would have finished at 25s, 40s, or never -- picking a
// bigger number would be the same blind tuning that already failed twice.
// So the budget here stays put, and detectPageCornersInWorker's own promise
// is deliberately NOT abandoned when this timeout fires -- see
// autoDetectAndProceed's use of applyLateDetectionIfStillUseful below, which
// keeps listening after the reader's already moved to the manual screen and
// applies the result if it lands late, instead of the already-spent
// download+compute going to waste on every slow-load case.
const AUTO_DETECT_TIMEOUT_MS = 20000;

// Fired as soon as the reader opens the Scan view (switchDafView('scan')),
// well before they've actually taken or picked a photo -- gives the
// multi-megabyte opencv.js WASM download+compile (see the worker's own
// ensureCv()) a head start during the natural dwell time of framing a shot,
// instead of that cold-load cost eating into AUTO_DETECT_TIMEOUT_MS's
// budget at the moment detection is actually needed. Harmless to call
// repeatedly -- the worker's own ensureCv() is idempotent (caches its
// promise/result), and this only ever fires the request once per page load.
let scanDetectWarmupStarted = false;
function prewarmScanDetection() {
  if (scanDetectWarmupStarted) return;
  scanDetectWarmupStarted = true;
  try {
    ensureScanDetectWorker().postMessage({ warmup: true });
  } catch (error) {
    console.error('Could not prewarm the page-detection worker:', error);
  }
}

// message may be a plain string or a function -- the function form is
// evaluated only if/when the timeout actually fires, so it can report
// whatever's true AT THAT MOMENT (see describeDetectionTimeout) rather than
// a message fixed before the race even started.
function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(typeof message === 'function' ? message() : message)), ms)),
  ]);
}

// Tries automatic detection first; only falls back to the manual
// drag-corners screen when detection fails outright, times out, or isn't
// confident enough to trust unattended. On success, skips straight past the
// align screen into confirmScan -- the whole point of this feature -- so a
// normal scan really is just "snap the photo."
async function autoDetectAndProceed() {
  showScanStatus('Finding the page…', 'busy');
  state.scanCornersManuallyEdited = false;
  const attemptToken = ++scanAttemptToken;
  let orderedFractionCorners = null;
  let confidence = 0;
  let failureDetail = null; // set only on a caught error -- see buildAutoDetectHint
  const detectionPromise = detectPageCornersInWorker(state.scanPhotoDataUrl, state.scanImageWidth, state.scanImageHeight);
  try {
    const quad = await withTimeout(detectionPromise, AUTO_DETECT_TIMEOUT_MS, describeDetectionTimeout);
    if (quad) {
      const ordered = orderQuadPoints(quad);
      confidence = scoreQuadConfidence(ordered, state.scanImageWidth, state.scanImageHeight).score;
      orderedFractionCorners = ordered.map(([x, y]) => [x / state.scanImageWidth, y / state.scanImageHeight]);
    }
  } catch (error) {
    // Best-effort enhancement -- any failure (library didn't load, timed
    // out, no network, WASM unsupported, nothing found) just falls back to
    // the manual step below rather than blocking the scan entirely. A
    // timeout specifically (as opposed to a hard error like a 404) means the
    // underlying detectionPromise is still running, not dead -- worth
    // keeping an ear out for in case it finishes late (see below) rather
    // than just discarding it along with the race.
    console.error('Automatic page detection failed:', error);
    failureDetail = error.message;
    applyLateDetectionIfStillUseful(detectionPromise, attemptToken);
  }

  if (orderedFractionCorners && confidence >= CORNER_CONFIDENCE_THRESHOLD) {
    state.scanCorners = orderedFractionCorners;
    await confirmScan();
    return;
  }

  state.scanCorners = orderedFractionCorners || DEFAULT_SCAN_CORNERS;
  $('scanAlignHint').textContent = buildAutoDetectHint(orderedFractionCorners, confidence, failureDetail);
  $('scanStatus').hidden = true;
  $('scanAlign').hidden = false;
  renderScanCorners();
}

// A timed-out detection isn't a dead one -- Promise.race in withTimeout just
// stops WAITING on detectionPromise, it doesn't cancel the worker's own
// opencv.js load+scan, which keeps running regardless. Most of the time
// that's wasted effort once the reader's already looking at (or has already
// finished) the manual screen, but it's still real work already paid for in
// download bytes and battery -- if it lands while they're still there and
// haven't started dragging a corner themselves, showing it beats throwing it
// away and asking them to redo by hand what the detector was about to hand
// them anyway.
function applyLateDetectionIfStillUseful(detectionPromise, attemptToken) {
  detectionPromise.then((quad) => {
    if (!quad) return; // detector finished but found nothing -- nothing to offer
    if (attemptToken !== scanAttemptToken) return; // a newer photo/attempt has since started
    if (state.scanCornersManuallyEdited) return; // don't clobber a correction they've already made
    if ($('scanAlign').hidden) return; // they've moved on (confirmed, or left the scan flow) already
    const ordered = orderQuadPoints(quad);
    const confidence = scoreQuadConfidence(ordered, state.scanImageWidth, state.scanImageHeight).score;
    state.scanCorners = ordered.map(([x, y]) => [x / state.scanImageWidth, y / state.scanImageHeight]);
    $('scanAlignHint').textContent = confidence >= CORNER_CONFIDENCE_THRESHOLD
      ? `Found the page after all (${Math.round(confidence * 100)}% confidence) — drag any corner that's off, then confirm.`
      : "Found a possible match after all, though we're not fully confident — check the corners, then confirm.";
    renderScanCorners();
  }).catch(() => {}); // the original failure is already reflected in the hint shown at the timeout
}

// Surfaces WHY auto-detect fell back to manual alignment, not just THAT it
// did -- without this, every fallback looked identical from the outside
// (silently swallowed into a console.error only the developer console could
// see), so a report of "still needed manual alignment" carried no way to
// tell a genuine detection miss apart from, say, the library timing out
// before it ever got to look at the photo. The exact wording here is what a
// reader would see and could quote back, turning the next report into real
// data instead of another guess.
function buildAutoDetectHint(orderedFractionCorners, confidence, failureDetail) {
  if (orderedFractionCorners) {
    return `We took a guess at the page's edges (${Math.round(confidence * 100)}% confidence) — drag any corner that's off, then confirm.`;
  }
  if (failureDetail) {
    return `Couldn't find the page automatically (${failureDetail}) — drag the four corners to match its real edges, then confirm.`;
  }
  return "Couldn't find the page automatically (no page-shaped edges found) — drag the four corners to match its real edges, then confirm.";
}

function resetScanUi() {
  stopScanCamera();
  $('scanIntro').hidden = false;
  $('scanAlign').hidden = true;
  $('scanResult').hidden = true;
  $('scanStatus').hidden = true;
  $('scanCameraInput').value = '';
  $('scanLibraryInput').value = '';
  state.scanPhotoDataUrl = null;
  state.scanCorners = null;
  state.scanCornersManuallyEdited = false;
  state.scanWordBoxes = null;
  state.scanWordEls = null;
  state.scanOverlayKey = '';
  state.scanSelectedRef = null;
  const picker = $('scanVideoPicker');
  if (picker) picker.hidden = true;
  resetScanResultZoom();
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

// --- Guided-capture camera view -------------------------------------------
// The idea behind this whole block: instead of taking a photo blind (via the
// plain scanCameraInput file picker below, which hands off to the OS's own
// camera app) and THEN figuring out the page's corners after the fact (either
// by OpenCV guesswork or by dragging four handles), show a live camera feed
// with a page-shaped cutout the reader fits the physical page into BEFORE
// tapping the shutter. captureScanPhotoFromCamera() then crops the captured
// photo to exactly that cutout region, so the crop IS the alignment step --
// the resulting corners are just the full frame of the (already-cropped)
// photo, no detection needed.
//
// "Choose from library" lives inside this same view now (a button next to
// the shutter) rather than as its own separate entry point, and gets the
// identical cutout-crop treatment: picking a photo swaps the view from
// "live" mode into "photo" mode (scanCameraPhotoWrap) -- the chosen photo,
// pinch/drag-positioned behind the same cutout, cropped by a checkmark
// button instead of the shutter. Since the reader can't physically move a
// photo that's already been taken the way they can move a printed page in
// front of a live camera, positioning it themselves is the closest
// equivalent -- see computeCropSourceRect below.
let scanCameraStream = null;

// Nothing here can be exercised against a real camera in this sandbox (no
// camera hardware, and getUserMedia is unavailable in a headless browser
// with no device) -- verified instead with a synthetic MediaStream-shaped
// stub and, separately, the pure coordinate math in
// computeCaptureSourceRect below against hand-computed expected crops.
async function openScanCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    $('scanCameraInput').click(); // no live-camera support -- fall back to the plain file picker
    return;
  }
  try {
    scanCameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1920 } },
      audio: false,
    });
  } catch (error) {
    console.error('Could not open the camera:', error);
    $('scanCameraInput').click(); // denied/unavailable -- same fallback
    return;
  }
  const video = $('scanCameraVideo');
  video.srcObject = scanCameraStream;
  $('scanCameraView').hidden = false;
}

// Stops the live stream without closing the whole camera view -- used when
// switching into "photo" mode (see showScanCameraPhotoCrop), where the live
// feed isn't needed anymore but the view itself stays open.
function stopScanCameraStream() {
  scanCameraStream?.getTracks().forEach((track) => track.stop());
  scanCameraStream = null;
  const video = $('scanCameraVideo');
  if (video) video.srcObject = null;
}

function stopScanCamera() {
  stopScanCameraStream();
  // The Daf Scan camera view only exists on player/index.html -- switchDafView
  // calls this unconditionally on every page that shares app.js (browse,
  // watch, studio have no Daf Scan tab at all), so this whole guided-capture
  // teardown needs to no-op cleanly rather than assume the markup is there.
  const view = $('scanCameraView');
  if (!view) return;
  view.hidden = true;
  hideScanCameraPhotoCrop(); // leave it reset to "live" mode for next time
}

// Maps the on-screen cutout rectangle back into the video's own native pixel
// space, so the captured frame can be cropped to exactly what the reader saw
// framed. videoEl is styled with object-fit: cover (see styles.css), which
// scales the video uniformly to fully cover its CSS box and crops whichever
// axis overflows -- this is that same transform's inverse. A pure function
// of its two arguments' rects/dimensions (no globals), so it's fully
// unit-testable by mocking getBoundingClientRect() and videoWidth/videoHeight
// without a real camera.
function computeCaptureSourceRect(videoEl, cutoutEl) {
  const videoRect = videoEl.getBoundingClientRect();
  const cutoutRect = cutoutEl.getBoundingClientRect();
  const vw = videoEl.videoWidth, vh = videoEl.videoHeight;
  if (!vw || !vh || !videoRect.width || !videoRect.height) return null;

  const coverScale = Math.max(videoRect.width / vw, videoRect.height / vh);
  const displayedVideoWidth = vw * coverScale;
  const displayedVideoHeight = vh * coverScale;
  const croppedX = (displayedVideoWidth - videoRect.width) / 2;
  const croppedY = (displayedVideoHeight - videoRect.height) / 2;

  const relLeft = (cutoutRect.left - videoRect.left) + croppedX;
  const relTop = (cutoutRect.top - videoRect.top) + croppedY;

  const sx = relLeft / coverScale;
  const sy = relTop / coverScale;
  const sWidth = cutoutRect.width / coverScale;
  const sHeight = cutoutRect.height / coverScale;

  // The cutout is designed to always sit inside the video's covered area --
  // clamp defensively against any rounding/layout edge case rather than
  // trusting that geometrically.
  const clampedX = Math.max(0, Math.min(sx, vw));
  const clampedY = Math.max(0, Math.min(sy, vh));
  return {
    sx: clampedX,
    sy: clampedY,
    sWidth: Math.max(1, Math.min(sWidth, vw - clampedX)),
    sHeight: Math.max(1, Math.min(sHeight, vh - clampedY)),
  };
}

// The reader already aligned the page to the cutout's edges before tapping
// the shutter (or, for a library photo, before tapping the checkmark) -- the
// crop below IS that alignment, so the corners are simply the resulting
// photo's own full frame, no OpenCV detection involved either way.
const FULL_FRAME_SCAN_CORNERS = [[0, 0], [1, 0], [1, 1], [0, 1]];

function captureScanPhotoFromCamera() {
  const video = $('scanCameraVideo');
  const source = computeCaptureSourceRect(video, $('scanCameraCutout'));
  if (!source) throw new Error('The camera is not ready yet.');
  const scale = Math.min(1, SCAN_MAX_DIMENSION / Math.max(source.sWidth, source.sHeight));
  const width = Math.round(source.sWidth * scale);
  const height = Math.round(source.sHeight * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(video, source.sx, source.sy, source.sWidth, source.sHeight, 0, 0, width, height);
  return { dataUrl: canvas.toDataURL('image/jpeg', 0.85), width, height };
}

async function proceedWithScanCorners(dataUrl, width, height) {
  state.scanPhotoDataUrl = dataUrl;
  state.scanImageWidth = width;
  state.scanImageHeight = height;
  state.scanCorners = FULL_FRAME_SCAN_CORNERS.map((point) => [...point]); // fresh copy -- confirmScan's own fallback screen lets the reader drag these
  state.scanCornersManuallyEdited = false;
  $('scanPhoto').src = dataUrl;
  $('scanIntro').hidden = true;
  $('scanResult').hidden = true;
  await confirmScan();
}

async function handleScanCameraCapture() {
  try {
    const { dataUrl, width, height } = captureScanPhotoFromCamera();
    stopScanCamera();
    await proceedWithScanCorners(dataUrl, width, height);
  } catch (error) {
    console.error(error);
    showScanStatus(`Could not capture that photo: ${error.message}`, 'error');
  }
}

// --- Library photo: same cutout, pinch/drag instead of physically framing --
// A separate, small pinch/pan/zoom controller from the scan-result photo's
// (wireScanResultZoom et al) rather than sharing one -- same underlying math,
// but kept independent so a change here can't regress that already-shipped
// screen, and vice versa.
// Was a flat 1 -- a real report caught the actual bug this caused directly:
// the img is laid out at width:100% of its wrap (see .scan-camera-photo),
// so "zoom 1" means "as wide as the screen," which for a portrait daf photo
// is routinely TALLER than the cutout. With no way to zoom below that, the
// reader could shrink the photo no further than the screenshot they sent
// showed -- page cut off top and bottom, no amount of pinching-out helped,
// because 1 was already the floor. computeMinCropZoom() replaces that fixed
// floor with whatever zoom actually fits the WHOLE photo inside the cutout
// on both axes (same idea as CSS object-fit: contain) -- recomputed fresh
// per photo in showScanCameraPhotoCrop, since it depends on that photo's own
// dimensions, not a constant that could ever be right for every photo.
let scanCropZoomMin = 1;
const SCAN_CROP_ZOOM_MAX = 4;
let scanCropZoom = 1, scanCropPanX = 0, scanCropPanY = 0;
const scanCropPointers = new Map();
let scanCropDragStart = null; // { x, y, panX, panY }
let scanCropPinchStart = null; // { dist, midX, midY, zoom, panX, panY }

function computeMinCropZoom() {
  const img = $('scanCameraPhotoZoom');
  const wrap = $('scanCameraPhotoWrap');
  const cutout = $('scanCameraCutout');
  if (!img?.naturalWidth || !img.naturalHeight) return 1;
  const wrapRect = wrap.getBoundingClientRect();
  const cutoutRect = cutout.getBoundingClientRect();
  if (!wrapRect.width || !cutoutRect.width || !cutoutRect.height) return 1;
  const displayedWidth = wrapRect.width; // the img is styled width:100% of the wrap at zoom 1
  const displayedHeight = displayedWidth * (img.naturalHeight / img.naturalWidth);
  // Whichever axis needs to shrink MORE to fit is the one that actually
  // constrains "does the whole photo fit" -- using the smaller of the two
  // guarantees BOTH axes end up at or under the cutout's size, not just one.
  return Math.min(cutoutRect.width / displayedWidth, cutoutRect.height / displayedHeight);
}

function applyScanCropTransform() {
  const layer = $('scanCameraPhotoZoom');
  if (layer) layer.style.transform = `translate(${scanCropPanX}px, ${scanCropPanY}px) scale(${scanCropZoom})`;
}

// Starts at scanCropZoomMin (the whole photo visible, fit inside the
// cutout) rather than always centered/zoomed-to-1 -- a reader who took a
// well-framed photo shouldn't have to manually zoom out on every single
// scan just to see the page they already have in frame.
function resetScanCropTransform() {
  scanCropZoomMin = computeMinCropZoom();
  scanCropZoom = scanCropZoomMin;
  scanCropPanX = 0;
  scanCropPanY = 0;
  applyScanCropTransform();
}

function scanCropPointerMidpoint() {
  const [a, b] = [...scanCropPointers.values()];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function scanCropPointerDistance() {
  const [a, b] = [...scanCropPointers.values()];
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clampScanCropPanAtMinZoom() {
  if (scanCropZoom > scanCropZoomMin) return;
  scanCropPanX = 0;
  scanCropPanY = 0;
}

function handleScanCropPointerDown(event) {
  $('scanCameraPhotoWrap').setPointerCapture(event.pointerId);
  scanCropPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (scanCropPointers.size === 1) {
    scanCropDragStart = { x: event.clientX, y: event.clientY, panX: scanCropPanX, panY: scanCropPanY };
    scanCropPinchStart = null;
  } else if (scanCropPointers.size === 2) {
    const mid = scanCropPointerMidpoint();
    scanCropPinchStart = {
      dist: scanCropPointerDistance(),
      midX: mid.x,
      midY: mid.y,
      zoom: scanCropZoom,
      panX: scanCropPanX,
      panY: scanCropPanY,
    };
  }
  $('scanCameraPhotoZoom')?.classList.add('dragging');
}

function handleScanCropPointerMove(event) {
  if (!scanCropPointers.has(event.pointerId)) return;
  scanCropPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (scanCropPointers.size >= 2 && scanCropPinchStart) {
    const dist = scanCropPointerDistance();
    const ratio = dist / (scanCropPinchStart.dist || dist || 1);
    scanCropZoom = Math.max(scanCropZoomMin, Math.min(SCAN_CROP_ZOOM_MAX, scanCropPinchStart.zoom * ratio));
    const mid = scanCropPointerMidpoint();
    scanCropPanX = scanCropPinchStart.panX + (mid.x - scanCropPinchStart.midX);
    scanCropPanY = scanCropPinchStart.panY + (mid.y - scanCropPinchStart.midY);
    clampScanCropPanAtMinZoom();
    applyScanCropTransform();
  } else if (scanCropDragStart) {
    const pt = scanCropPointers.get(event.pointerId);
    scanCropPanX = scanCropDragStart.panX + (pt.x - scanCropDragStart.x);
    scanCropPanY = scanCropDragStart.panY + (pt.y - scanCropDragStart.y);
    applyScanCropTransform();
  }
}

function handleScanCropPointerUp(event) {
  scanCropPointers.delete(event.pointerId);
  if (scanCropPointers.size < 2) scanCropPinchStart = null;
  if (scanCropPointers.size === 1) {
    const [remaining] = scanCropPointers.values();
    scanCropDragStart = { x: remaining.x, y: remaining.y, panX: scanCropPanX, panY: scanCropPanY };
  } else if (scanCropPointers.size === 0) {
    scanCropDragStart = null;
    $('scanCameraPhotoZoom')?.classList.remove('dragging');
  }
}

async function showScanCameraPhotoCrop(dataUrl) {
  stopScanCameraStream(); // no need to keep the live feed running while cropping a chosen photo
  $('scanCameraVideo').hidden = true;
  $('scanCameraPhotoWrap').hidden = false;
  $('scanCameraShutterButton').hidden = true;
  $('scanCameraConfirmCropButton').hidden = false;
  $('scanCameraLibraryButton').hidden = true;
  $('scanCameraHint').textContent = "Pinch or drag the photo to fit the page inside the frame, then tap the checkmark.";
  $('scanCameraTips').hidden = true; // framing tips (hold flat, avoid shadows) don't apply to an already-taken photo
  $('scanCameraView').hidden = false; // must happen before decode() below -- computeMinCropZoom needs real layout, which a hidden view doesn't have

  const img = $('scanCameraPhotoZoom');
  img.src = dataUrl;
  try {
    await img.decode();
  } catch (error) {
    console.error('Could not decode the chosen photo:', error);
  }
  // Only now does the img have real naturalWidth/Height to fit against --
  // resetScanCropTransform's computeMinCropZoom falls back to zoom 1 if
  // decode() failed above, same as it always did before this existed.
  resetScanCropTransform();
}

function hideScanCameraPhotoCrop() {
  $('scanCameraVideo').hidden = false;
  $('scanCameraPhotoWrap').hidden = true;
  $('scanCameraShutterButton').hidden = false;
  $('scanCameraConfirmCropButton').hidden = true;
  $('scanCameraLibraryButton').hidden = false;
  $('scanCameraHint').textContent = 'Fit the page inside the frame, then tap to capture.';
  $('scanCameraTips').hidden = false;
}

async function handleLibraryPhotoSelected(file) {
  if (!file) return;
  try {
    const downscaled = await downscaleImageFile(file, SCAN_MAX_DIMENSION);
    await showScanCameraPhotoCrop(downscaled.dataUrl);
  } catch (error) {
    console.error(error);
    showScanStatus(`Could not load that photo: ${error.message}`, 'error');
  }
}

// Same object-fit:cover-inverse idea as computeCaptureSourceRect, but for a
// photo positioned by a CSS translate/scale transform (see
// applyScanCropTransform) instead of the camera's fixed object-fit: cover --
// the img is laid out at width:100% of its wrap (height:auto, so
// displayedWidth == wrap's width) before that transform is applied on top,
// with transform-origin: 0 0, so a screen point maps back to the image's own
// natural pixel space by first undoing the pan/scale, then undoing the
// width:100% display scale. Pure function of its arguments (only reads
// getBoundingClientRect()/naturalWidth/naturalHeight), so it's testable with
// plain stand-in objects and explicit pan/zoom values, no real image needed.
function computeCropSourceRect(imgEl, wrapEl, cutoutEl, panX, panY, zoom) {
  const wrapRect = wrapEl.getBoundingClientRect();
  const cutoutRect = cutoutEl.getBoundingClientRect();
  const nw = imgEl.naturalWidth, nh = imgEl.naturalHeight;
  if (!nw || !nh || !wrapRect.width) return null;

  const displayedWidth = wrapRect.width; // the img is styled width:100% of the wrap
  const nativeScale = nw / displayedWidth; // == nh / (displayedWidth * nh/nw)

  const cutoutLeftInWrap = cutoutRect.left - wrapRect.left;
  const cutoutTopInWrap = cutoutRect.top - wrapRect.top;

  const localLeft = (cutoutLeftInWrap - panX) / zoom;
  const localTop = (cutoutTopInWrap - panY) / zoom;
  const localWidth = cutoutRect.width / zoom;
  const localHeight = cutoutRect.height / zoom;

  const sx = localLeft * nativeScale;
  const sy = localTop * nativeScale;
  const sWidth = localWidth * nativeScale;
  const sHeight = localHeight * nativeScale;

  // Unlike the live camera (object-fit: cover geometrically guarantees the
  // cutout is always fully covered), a reader can zoom/pan a library photo
  // so the cutout only partly overlaps it -- clamp to the photo's own
  // bounds rather than trusting that geometrically.
  const clampedX = Math.max(0, Math.min(sx, nw));
  const clampedY = Math.max(0, Math.min(sy, nh));
  return {
    sx: clampedX,
    sy: clampedY,
    sWidth: Math.max(1, Math.min(sWidth, nw - clampedX)),
    sHeight: Math.max(1, Math.min(sHeight, nh - clampedY)),
  };
}

async function handleScanCameraConfirmCrop() {
  try {
    const img = $('scanCameraPhotoZoom');
    const source = computeCropSourceRect(img, $('scanCameraPhotoWrap'), $('scanCameraCutout'), scanCropPanX, scanCropPanY, scanCropZoom);
    if (!source) throw new Error('The photo is not ready yet.');
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(source.sWidth);
    canvas.height = Math.round(source.sHeight);
    canvas.getContext('2d').drawImage(img, source.sx, source.sy, source.sWidth, source.sHeight, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    stopScanCamera();
    await proceedWithScanCorners(dataUrl, canvas.width, canvas.height);
  } catch (error) {
    console.error(error);
    showScanStatus(`Could not crop that photo: ${error.message}`, 'error');
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
  state.scanCornersManuallyEdited = true;
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
        // Reuses the same generic active-option lookup the Regular/Chazarah
        // and English/Hebrew toggles already use (see activeShiurVariant) --
        // #scanEngineToggle is just another .shiur-variant-option group,
        // keyed by data-variant="tesseract"/"google-vision" instead of a
        // shiur variant. See scan-daf-page.mjs's own engine-selection
        // comment for what each option actually does server-side.
        engine: activeShiurVariant('scanEngineToggle'),
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not scan this page.');
    await showScanResult(result);
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

async function showScanResult(result) {
  $('scanResultPhoto').src = state.scanPhotoDataUrl;
  $('scanAlign').hidden = true;
  $('scanResult').hidden = false;
  $('scanStatus').hidden = true;
  $('scanResultHint').textContent = `Recognized ${result.ref} — tap any word to jump the video there. Pinch or scroll to zoom in.`;
  resetScanResultZoom();

  // A page was just identified -- this is the first point the video player
  // has anything useful to show, so reveal it now (see the ?view=scan
  // handler's scan-pending class) and load the matched daf's video right
  // away, instead of waiting for the reader's first word tap.
  document.body.classList.remove('scan-pending');
  state.scanSelectedRef = result.ref;
  if (state.dafRef !== result.ref) {
    try {
      await loadDaf(result.ref);
      applyRealVideoTitle(result.ref);
    } catch (error) {
      console.error(error);
      showToast(`Could not load ${result.ref}: ${error.message}`, 'error');
    }
  }

  const overlay = $('scanWordOverlay');
  overlay.innerHTML = '';
  // scanWordBoxes/scanWordEls drive updateScanOverlay's live "highlight the
  // word being spoken right now" pass, the same way vilnaPageMap.wordBoxes/
  // vilnaWordEls drive updateVilnaOverlay for the Vilna page view.
  const normalizedWordBoxes = normalizePageWordBoxes(result.wordBoxes);
  state.scanWordBoxes = normalizedWordBoxes;
  state.scanWordEls = new Map();
  state.scanOverlayKey = '';
  for (const box of normalizedWordBoxes) {
    const el = document.createElement('div');
    el.className = 'scan-word-box';
    el.style.left = `${box.x * 100}%`;
    el.style.top = `${box.y * 100}%`;
    el.style.width = `${box.w * 100}%`;
    el.style.height = `${box.h * 100}%`;
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.addEventListener('click', () => {
      hapticTap();
      tapScannedWord(box.ref, box.wordIndex);
    });
    overlay.appendChild(el);
    state.scanWordEls.set(`${box.ref}:${box.wordIndex}`, el);
  }
  updateScanOverlay(getCurrentTime());

  await refreshScanVideoPicker(result.tractate, result.daf);
}

// Vilna pagination doesn't record which amud a scanned header belongs to
// (see scan-daf-page.mjs's own "KNOWN v1 LIMITATION" comment) -- the scan
// flow only ever resolves amud 'a', so that's the only dafAmud key worth
// looking up here.
function scanDafAmudKey(daf) {
  return `${daf}a`;
}

// Shows/hides and populates the "which video" picker on the scan-result
// screen once a daf's actually been identified -- mirrors the Daf browser's
// own refreshDafPickerVariantLanguage (see there), reusing the exact same
// activeShiurVariant/setActiveShiurVariant/activeLanguage/setActiveLanguage
// helpers and list-synced-dapim.mjs data, just against a reader-facing
// picker instead of the admin-only setup-strip one (which is hidden for a
// normal reader -- see body.player-page:not(.is-admin) .setup-strip in
// player/index.html).
async function refreshScanVideoPicker(tractate, daf) {
  const picker = $('scanVideoPicker');
  if (!picker) return;
  const syncedDapim = await ensureSyncedDapimLoaded();
  const combos = syncedDapim[tractate]?.[scanDafAmudKey(daf)] || [];
  // Nothing to choose between -- only one (or zero, though a successful
  // match implies at least one) combo synced for this daf, so the picker
  // would just offer a single always-disabled option. Not worth showing.
  if (combos.length < 2) {
    picker.hidden = true;
    return;
  }
  picker.hidden = false;

  document.querySelectorAll('#scanShiurToggle .shiur-variant-option').forEach((button) => {
    button.disabled = !combos.some((c) => c.startsWith(button.dataset.variant === 'chazarah' ? 'chazarah' : 'regular'));
  });
  document.querySelectorAll('#scanLanguageToggle .language-option').forEach((button) => {
    button.disabled = !combos.some((c) => c.endsWith(button.dataset.language === 'he' ? 'He' : 'En'));
  });
  if (!combos.includes(comboKeyFor(activeShiurVariant('scanShiurToggle'), activeLanguage('scanLanguageToggle')))) {
    const fallback = combos[0];
    setActiveShiurVariant('scanShiurToggle', fallback.startsWith('chazarah') ? 'chazarah' : 'regular');
    setActiveLanguage('scanLanguageToggle', fallback.endsWith('He') ? 'he' : 'en');
  }
}

// Loads whichever combo the scan-result video picker's toggles now select --
// wired to both toggles' buttons (see the DOM listeners near switchDafView).
async function switchScanVideo() {
  const parsed = parseDafRef(state.scanSelectedRef);
  if (!parsed) return;
  const variantSuffix = activeShiurVariant('scanShiurToggle') === 'chazarah' ? ' (Chazarah Daf)' : '';
  const languageSuffix = activeLanguage('scanLanguageToggle') === 'he' ? ' (Hebrew)' : '';
  const ref = `${parsed.tractate} ${parsed.daf}${parsed.amud}${variantSuffix}${languageSuffix}`;
  if (ref === state.scanSelectedRef) return;
  state.scanSelectedRef = ref;
  try {
    await loadDaf(ref);
    applyRealVideoTitle(ref);
  } catch (error) {
    console.error(error);
    showToast(`Could not load ${ref}: ${error.message}`, 'error');
  }
}

// Live "highlight the word being spoken right now" on the scanned photo --
// the scan feature's equivalent of updateVilnaOverlay (see there for the
// full rationale, including why this is keyed on the whole segment/phrase
// rather than just wordTimeline, and why the dedup key exists). Reads from
// scanWordBoxes/scanWordEls (populated in showScanResult) instead of
// vilnaPageMap.wordBoxes/vilnaWordEls, since a scanned photo isn't
// necessarily showing the same daf as state.vilnaPageMap would resolve to
// (Vilna-page and Scan are independent view-switch tabs on the same daf).
function updateScanOverlay(time) {
  if (!state.scanWordEls || !state.scanWordEls.size) return;
  const activeSegment = state.segments[state.activeIndex];
  const dedupKey = activeSegment ? `${activeSegment.ref}:${activeSegment.w0}:${activeSegment.w1}` : '';
  if (dedupKey === state.scanOverlayKey) return;
  state.scanOverlayKey = dedupKey;

  const activeRef = activeSegment?.ref || '';
  const hasRange = activeSegment && activeSegment.w0 !== null && activeSegment.w1 !== null;
  for (const box of state.scanWordBoxes) {
    const el = state.scanWordEls.get(`${box.ref}:${box.wordIndex}`);
    if (!el) continue;
    const hit = activeRef !== '' && box.ref === activeRef
      && (!hasRange || (box.wordIndex >= activeSegment.w0 && box.wordIndex <= activeSegment.w1));
    el.classList.toggle('active', hit);
  }
}

// Pinch-to-zoom on the synced result photo. A CSS transform on
// #scanResultZoom (the img + its word-tap overlay, moved together as one
// unit) inside #scanResultWrap, which stays the fixed-size, overflow:hidden
// viewport -- same "pointer map + pinch/drag baseline" shape as the video
// overlay's handleOverlayPointerDown/Move/Up (see there), simplified since a
// plain CSS translate/scale needs no canvas-pixel/page-fraction conversion.
const SCAN_RESULT_ZOOM_MIN = 1;
const SCAN_RESULT_ZOOM_MAX = 4;
const scanResultPointers = new Map();
let scanResultDragMoved = false;
let scanResultDragStart = null; // { x, y, panX, panY }
let scanResultPinchStart = null; // { dist, midX, midY, zoom, panX, panY }

function applyScanResultZoom() {
  const layer = $('scanResultZoom');
  if (layer) layer.style.transform = `translate(${state.scanResultPanX}px, ${state.scanResultPanY}px) scale(${state.scanResultZoom})`;
}

function resetScanResultZoom() {
  state.scanResultZoom = 1;
  state.scanResultPanX = 0;
  state.scanResultPanY = 0;
  applyScanResultZoom();
}

function scanResultPointerMidpoint() {
  const [a, b] = [...scanResultPointers.values()];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function scanResultPointerDistance() {
  const [a, b] = [...scanResultPointers.values()];
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function handleScanResultPointerDown(event) {
  $('scanResultWrap').setPointerCapture(event.pointerId);
  scanResultPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (scanResultPointers.size === 1) {
    scanResultDragMoved = false;
    scanResultDragStart = { x: event.clientX, y: event.clientY, panX: state.scanResultPanX, panY: state.scanResultPanY };
    scanResultPinchStart = null;
  } else if (scanResultPointers.size === 2) {
    scanResultDragMoved = true; // a pinch is never a click, on either finger
    const mid = scanResultPointerMidpoint();
    scanResultPinchStart = {
      dist: scanResultPointerDistance(),
      midX: mid.x,
      midY: mid.y,
      zoom: state.scanResultZoom,
      panX: state.scanResultPanX,
      panY: state.scanResultPanY,
    };
  }
  $('scanResultZoom').classList.add('dragging');
}

function handleScanResultPointerMove(event) {
  if (!scanResultPointers.has(event.pointerId)) return;
  scanResultPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (scanResultPointers.size >= 2 && scanResultPinchStart) {
    const dist = scanResultPointerDistance();
    const ratio = dist / (scanResultPinchStart.dist || dist || 1);
    state.scanResultZoom = Math.max(SCAN_RESULT_ZOOM_MIN, Math.min(SCAN_RESULT_ZOOM_MAX, scanResultPinchStart.zoom * ratio));
    const mid = scanResultPointerMidpoint();
    state.scanResultPanX = scanResultPinchStart.panX + (mid.x - scanResultPinchStart.midX);
    state.scanResultPanY = scanResultPinchStart.panY + (mid.y - scanResultPinchStart.midY);
    clampScanResultPanAtMinZoom();
    applyScanResultZoom();
  } else if (scanResultDragStart && state.scanResultZoom > SCAN_RESULT_ZOOM_MIN) {
    const pt = scanResultPointers.get(event.pointerId);
    const dx = pt.x - scanResultDragStart.x;
    const dy = pt.y - scanResultDragStart.y;
    if (Math.hypot(dx, dy) > 6) scanResultDragMoved = true;
    state.scanResultPanX = scanResultDragStart.panX + dx;
    state.scanResultPanY = scanResultDragStart.panY + dy;
    applyScanResultZoom();
  }
}

// Snaps pan back to centered once fully zoomed back out, so pinching back
// to 1x always returns to the original, un-panned view instead of leaving
// the photo stuck off to one side.
function clampScanResultPanAtMinZoom() {
  if (state.scanResultZoom > SCAN_RESULT_ZOOM_MIN) return;
  state.scanResultPanX = 0;
  state.scanResultPanY = 0;
}

function handleScanResultPointerUp(event) {
  scanResultPointers.delete(event.pointerId);
  if (scanResultPointers.size < 2) scanResultPinchStart = null;
  if (scanResultPointers.size === 1) {
    // Re-baseline from the remaining finger's current position so the pan
    // doesn't jump when the second finger lifts mid-pinch.
    const [remaining] = scanResultPointers.values();
    scanResultDragStart = { x: remaining.x, y: remaining.y, panX: state.scanResultPanX, panY: state.scanResultPanY };
  } else if (scanResultPointers.size === 0) {
    scanResultDragStart = null;
    $('scanResultZoom').classList.remove('dragging');
  }
}

function handleScanResultWheel(event) {
  if (!event.ctrlKey) return; // trackpad pinch on desktop; leave normal page scroll alone
  event.preventDefault();
  const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
  state.scanResultZoom = Math.max(SCAN_RESULT_ZOOM_MIN, Math.min(SCAN_RESULT_ZOOM_MAX, state.scanResultZoom * factor));
  clampScanResultPanAtMinZoom();
  applyScanResultZoom();
}

// A pinch/drag that ends on a word box shouldn't also register as a tap on
// it -- capture-phase so this runs before the word box's own bubbling click
// listener (see showScanResult).
function suppressScanResultClickAfterDrag(event) {
  if (scanResultDragMoved) {
    event.stopPropagation();
    scanResultDragMoved = false;
  }
}

// A scanned word can belong to a different daf than whatever's currently
// loaded (the reader might scan a page before ever loading its video) --
// seekToVilnaWord only knows about the *currently loaded* daf's segments/
// wordTimeline, so load the scanned daf first if it isn't already on screen.
// Reads state.scanSelectedRef (set in showScanResult, updated by the
// video-variant picker's switchScanVideo) rather than taking a ref
// parameter -- it's already a plain daf-level ref ("Chullin 101a", or that
// plus a "(Chazarah Daf)"/"(Hebrew)" suffix once the reader's picked a
// non-default combo), the same shape state.dafRef holds, so (unlike
// playWordInline's per-paragraph wordRef) no realDafRef() normalizing is
// needed to compare them -- and reading it fresh from state here, instead
// of a value captured in each word box's own click-handler closure at
// showScanResult time, means every word tap respects whichever combo is
// CURRENTLY selected, not just whatever was selected when the photo was
// first scanned.
async function tapScannedWord(wordRef, wordIndex) {
  const scannedRef = state.scanSelectedRef;
  if (state.dafRef !== scannedRef) {
    try {
      await loadDaf(scannedRef);
    } catch (error) {
      console.error(error);
      showToast(`Could not load ${scannedRef}: ${error.message}`, 'error');
      return;
    }
  }
  // After seekToVilnaWord below, not before -- see playWordInline's own
  // comment on why (a forward redirect can swap the video mid-tap).
  await seekToVilnaWord(wordRef, wordIndex);
  applyRealVideoTitle(scannedRef);
  if (isPaused()) await togglePlay();
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
  const time = getCurrentTime();
  // A paragraph the rebbe revisits or repeats later in the shiur can
  // produce several segments sharing one ref with the same (or overlapping)
  // w0/w1 word range but wildly different start times -- confirmed in real
  // synced data: one ref in Chullin 100a has 26 such segments spanning a
  // 200+ second range. Two earlier approaches both got this wrong: a blind
  // first-array-match (state.segments is sorted by start time) always
  // resolved to whichever occurrence happens to sort earliest; preferring
  // state.editingIndex's own segment instead was worse -- any click on a
  // word whose ref happened to recur elsewhere could hijack whatever
  // segment editingIndex currently pointed at (even the daf's very first
  // phrase), overwriting its start with the current, unrelated playback
  // time and corrupting the whole chronological ordering from that point
  // on. Among every segment that actually matches this ref (and, when
  // known, this word's range), the one whose own start time sits closest to
  // right now is overwhelmingly likely to be the real occurrence -- an
  // admin marks phrases while listening along in real time, so playback
  // position is the one signal that's actually about *this* moment, not
  // wherever an unrelated index happens to be pointing.
  const exact = state.segments
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.ref === ref && s.w0 !== null && wordIndex >= s.w0 && wordIndex <= s.w1);
  const anyRef = exact.length ? exact : state.segments.map((s, i) => ({ s, i })).filter(({ s }) => s.ref === ref);
  if (!anyRef.length) return;
  anyRef.sort((a, b) => Math.abs(a.s.start - time) - Math.abs(b.s.start - time));
  const resolvedIndex = anyRef[0].i;
  setSegmentStart(resolvedIndex, time);
  state.editingIndex = Math.min(resolvedIndex + 1, state.segments.length - 1);
  updateMarkTargetUi();
  showToast(`Marked phrase ${resolvedIndex + 1} at ${formatTime(time)}.`);
}

// Groups already ref-filtered, wordIndex-sorted word boxes into one
// merged rectangle per printed LINE they cover, instead of one rectangle
// per word -- shared by the mark-target outline and the "currently
// playing" highlight below, both of which need a single clean bar per
// line rather than many overlapping (deliberately oversized, for easier
// tapping -- see .vilna-word-box's own transform) individual word boxes.
// A jump in y bigger than roughly half a line's own height means a line
// break, not just normal word-to-word spacing on the same line. How TALL
// each bar ends up is a separate question the word boxes can't answer --
// see INK_PITCH_RATIO below.
function medianOf(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function splitBoxesIntoRows(boxes) {
  const rows = [];
  let current = [];
  let prevBox = null;
  for (const box of boxes) {
    if (prevBox && Math.abs(box.y - prevBox.y) > prevBox.h * 0.6) {
      rows.push(current);
      current = [];
    }
    current.push(box);
    prevBox = box;
  }
  if (current.length) rows.push(current);
  return rows;
}

// Vision's word boxes are NOT a usable measure of how tall the printed
// letters actually are. Measured directly against the rendered page
// (counting dark pixels per scanline) across two independent dapim, the
// real ink band is a rock-steady 14px of a 2068px-tall page on every
// line, while the boxes reporting it range from 19 to 32px -- 1.6x to
// 2.3x too tall, and lopsided, carrying noticeably more slack above the
// letters than below. Sizing a highlight from box.h therefore always
// overshoots into the blank space between lines (measured at 4-11px
// above the letters and 0-7px below), which is precisely what a bar
// drawn that way looks like: a fat block rather than a highlight.
//
// The page's own line pitch is the stable typographic quantity to use
// instead -- measured at exactly 25px on both sampled dapim, since the
// Vilna template sets the whole daf's body text at a single fixed size.
// Deriving the bar height from the pitch reproduces the real ink band to
// within a fraction of a pixel, uniformly on every line.
const INK_PITCH_RATIO = 0.5601;
// Vision's boxes sit slightly high over the letters, so a box's centre is
// not the ink's centre; this is the measured median correction, in
// page-height fractions.
const INK_CENTER_BIAS = 0.00078;
// Fallback for a page with too few rows to measure a pitch from: the
// measured median ink-to-box height ratio. Less exact than the pitch,
// since the individual box heights are noisy, but never wildly wrong.
const INK_BOX_RATIO = 0.53;

// Median distance between the tops of consecutive printed lines across
// the WHOLE page -- a per-page constant, so it's computed once and cached
// (in a WeakMap, to avoid mutating the fetched page map) rather than
// recomputed on every highlight repaint.
const linePitchCache = new WeakMap();
function pageLinePitch(pageMap) {
  if (!pageMap) return 0;
  const cached = linePitchCache.get(pageMap);
  if (cached !== undefined) return cached;
  const rows = splitBoxesIntoRows(
    [...(pageMap.wordBoxes || [])].sort((a, b) => (a.y - b.y) || (b.x - a.x)),
  ).filter((row) => row.length >= 3);
  const tops = rows.map((row) => Math.min(...row.map((b) => b.y))).sort((a, b) => a - b);
  const gaps = [];
  for (let i = 0; i + 1 < tops.length; i += 1) {
    const gap = tops[i + 1] - tops[i];
    // Discards both a line accidentally split in two (too small a gap)
    // and a line the OCR missed entirely, which would otherwise read as
    // one double-height gap. Taking the median of what's left is what
    // makes this robust to either.
    if (gap > 0.004 && gap < 0.03) gaps.push(gap);
  }
  const pitch = gaps.length >= 3 ? medianOf(gaps) : 0;
  linePitchCache.set(pageMap, pitch);
  return pitch;
}

// Everything above derives the bar from the word boxes, which puts it
// within a couple of pixels of the letters but no closer -- measured
// against the real ink, the box-derived centre is off by a median of
// under 1px but strays up to 5px on individual lines, which is plainly
// visible as a bar riding high or low on its line.
//
// The daf itself is rendered by pdf.js onto a canvas we own, so the
// letters can simply be measured rather than predicted: scanning the
// Gemara column for rows of dark pixels gives each printed line's exact
// top and bottom. Snapping to that is exact by construction, and it needs
// no per-page constants at all. It is one pass over the column per raster,
// cached below, not per repaint.
function measureInkBands(canvas, wordBoxes) {
  const sortedVals = (vals) => [...vals].sort((a, b) => a - b);
  const at = (arr, p) => arr[Math.max(0, Math.min(arr.length - 1, Math.floor(arr.length * p)))];
  // Percentiles rather than min/max: a few marginal reference marks sit
  // well outside the Gemara column, and including them would widen the
  // scan across the commentary columns, whose lines are set to a
  // different rhythm entirely.
  const x0 = Math.max(0, Math.floor(at(sortedVals(wordBoxes.map((b) => b.x)), 0.05) * canvas.width));
  const x1 = Math.min(canvas.width, Math.ceil(at(sortedVals(wordBoxes.map((b) => b.x + b.w)), 0.95) * canvas.width));
  const y0 = Math.max(0, Math.floor(at(sortedVals(wordBoxes.map((b) => b.y)), 0.02) * canvas.height));
  const y1 = Math.min(canvas.height, Math.ceil(at(sortedVals(wordBoxes.map((b) => b.y + b.h)), 0.98) * canvas.height));
  const width = x1 - x0;
  const height = y1 - y0;
  if (width < 8 || height < 8) return null;

  // Squeeze the column down to a narrow strip first, at full height. Only
  // the vertical resolution carries meaning here -- each row becomes a
  // single "how much ink is on this line" number either way -- so the
  // horizontal axis can be collapsed by the scaling blit rather than by
  // reading every pixel. getImageData is what costs: pulling the column
  // at full width measured 400ms on the largest raster this app allows
  // (MAX_CANVAS_WIDTH_PX), against ~50ms for blit-plus-strip-read. Still
  // not free, but it happens once per raster, not once per repaint.
  // Verified to give the same 57 lines on the same daf rasterised at 75,
  // 150 and 300 dpi, agreeing on every line edge to within a pixel, so
  // the squeeze costs nothing in precision.
  const SCAN_COLUMNS = 160;
  let data;
  let strip;
  try {
    strip = document.createElement('canvas');
    strip.width = Math.min(SCAN_COLUMNS, width);
    strip.height = height;
    const stripContext = strip.getContext('2d', { willReadFrequently: true });
    stripContext.drawImage(canvas, x0, y0, width, height, 0, 0, strip.width, strip.height);
    data = stripContext.getImageData(0, 0, strip.width, strip.height).data;
  } catch (error) {
    return null; // e.g. a tainted canvas -- the box-derived estimate still stands
  }

  // Total darkness per row rather than a count of dark pixels: after the
  // horizontal squeeze each sample is an average of the pixels behind it,
  // so a row of text reads as many middling-grey samples rather than a
  // few black ones.
  const inkPerRow = new Float64Array(height);
  const stripWidth = strip.width;
  for (let row = 0; row < height; row += 1) {
    let ink = 0;
    for (let i = row * stripWidth * 4, col = 0; col < stripWidth; col += 1, i += 4) {
      ink += 255 - (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
    }
    inkPerRow[row] = ink;
  }
  let peak = 0;
  for (const ink of inkPerRow) if (ink > peak) peak = ink;
  if (!peak) return null; // nothing rendered yet

  const threshold = peak * 0.15;
  const minBandPx = Math.max(3, Math.round(canvas.height * 0.002));
  const bands = [];
  let start = -1;
  for (let row = 0; row <= height; row += 1) {
    const inked = row < height && inkPerRow[row] >= threshold;
    if (inked && start < 0) start = row;
    else if (!inked && start >= 0) {
      if (row - start >= minBandPx) {
        bands.push({ top: (y0 + start) / canvas.height, bottom: (y0 + row) / canvas.height });
      }
      start = -1;
    }
  }
  return bands.length ? bands : null;
}

// Keyed by page and raster size, so a zoom or a page turn re-measures on
// its own. A null result is never cached: the overlay can be painted
// before pdf.js has finished the first raster, and that must not lock in
// the fallback for the rest of the page's life.
let inkBandCache = { key: '', bands: null };
function vilnaInkBands(pageMap) {
  const canvas = $('vilnaPageCanvas');
  if (!canvas || canvas.hidden || !canvas.width || !pageMap?.wordBoxes?.length) return null;
  const key = `${pageMap.tractate} ${pageMap.daf}${pageMap.amud}:${canvas.width}x${canvas.height}`;
  if (inkBandCache.key === key) return inkBandCache.bands;
  const bands = measureInkBands(canvas, pageMap.wordBoxes);
  if (bands) inkBandCache = { key, bands };
  return bands;
}

function matchInkBand(bands, centre, pitch) {
  if (!bands?.length) return null;
  let best = null;
  let bestDistance = Infinity;
  for (const band of bands) {
    const distance = Math.abs((band.top + band.bottom) / 2 - centre);
    if (distance < bestDistance) { bestDistance = distance; best = band; }
  }
  // Only accept a band that lines up with where the words say they are.
  // A miss of more than half a line means the map and the raster disagree
  // about this page, and the estimate is the safer of the two answers.
  return bestDistance <= (pitch || 0.012) * 0.5 ? best : null;
}

function groupBoxesIntoLineRects(boxes, pageMap, inkBands) {
  if (!boxes.length) return [];
  const rows = splitBoxesIntoRows(boxes);
  const pitch = pageLinePitch(pageMap);
  // Horizontal padding only, to give the rounded end caps a little room
  // so they don't clip the first and last letter. There is deliberately
  // no vertical padding: the whole point is that the bar starts and ends
  // where the letters do.
  const PAD_X = 0.004;

  return rows.map((row) => {
    const left = Math.min(...row.map((b) => b.x)) - PAD_X;
    const right = Math.max(...row.map((b) => b.x + b.w)) + PAD_X;
    const centre = medianOf(row.map((b) => b.y + b.h / 2)) + INK_CENTER_BIAS;
    const band = matchInkBand(inkBands, centre, pitch);
    if (band) {
      return { left, top: band.top, width: right - left, height: band.bottom - band.top };
    }
    const height = pitch
      ? pitch * INK_PITCH_RATIO
      : medianOf(row.map((b) => b.h)) * INK_BOX_RATIO;
    return { left, top: centre - height / 2, width: right - left, height };
  });
}

function appendLineRects(overlay, rects, className) {
  for (const rect of rects) {
    const el = document.createElement('div');
    el.className = className;
    el.style.left = `${rect.left * 100}%`;
    el.style.top = `${rect.top * 100}%`;
    el.style.width = `${rect.width * 100}%`;
    el.style.height = `${rect.height * 100}%`;
    overlay.appendChild(el);
  }
}

// Highlights exactly the word range the caption box itself is highlighting
// right now (state.segments[activeIndex].w0/w1) -- not a whole sentence,
// even when that segment is one of several consecutive slices a longer
// paragraph got split into (see caption_ocr_align.py's _split_word_ranges)
// for finer mid-phrase timing. Segment start/end timing is equally solid
// for both the OCR and voice sync engines, unlike wordTimeline, which
// voice sync only ever populates sparsely (whole matched phrases, not
// every word). Draws one merged rectangle per printed line into a
// dedicated overlay (see groupBoxesIntoLineRects) rather than toggling an
// 'active' class on each individual (deliberately oversized, for easier
// tapping) word box, which used to render a multi-word phrase as a jagged
// block of overlapping rectangles instead of one clean bar.
function updateVilnaOverlay() {
  const overlay = $('vilnaActiveOverlay');
  if (!overlay) return;
  if (!state.vilnaPageMap || $('vilnaPlaceholder').hidden) {
    if (state.vilnaOverlayKey) {
      overlay.innerHTML = '';
      state.vilnaOverlayKey = '';
    }
    return;
  }
  const activeSegment = state.segments[state.activeIndex];

  // The YouTube poll re-runs this every 100ms; without this check the
  // overlay was being rebuilt on every single tick even when the
  // highlighted phrase hadn't changed, restarting the CSS entrance
  // animation from opacity:0 before it ever finished fading in -- a
  // constant flicker that also read as much dimmer than the steady color
  // it's supposed to settle into. Keyed on the segment's own ref/w0/w1
  // rather than raw activeIndex, so two different indices that happen to
  // cover the identical word range don't count as a change worth
  // re-rendering for.
  const dedupKey = activeSegment ? `${activeSegment.ref}:${activeSegment.w0}:${activeSegment.w1}` : '';
  if (dedupKey === state.vilnaOverlayKey) return;
  state.vilnaOverlayKey = dedupKey;

  overlay.innerHTML = '';
  if (!activeSegment) return;
  const hasRange = activeSegment.w0 !== null && activeSegment.w1 !== null;
  const boxes = state.vilnaPageMap.wordBoxes
    .filter((box) => box.ref === activeSegment.ref
      && (!hasRange || (box.wordIndex >= activeSegment.w0 && box.wordIndex <= activeSegment.w1)))
    .sort((a, b) => a.wordIndex - b.wordIndex);
  appendLineRects(overlay, groupBoxesIntoLineRects(boxes, state.vilnaPageMap, vilnaInkBands(state.vilnaPageMap)), 'vilna-active-rect');
}

// While vilnaMarkMode is on, outlines the word(s) belonging to the phrase
// that's about to be marked (state.editingIndex) -- a distinct highlight
// from updateVilnaOverlay's "currently playing" one above, the same
// distinction the phrase-list editor draws between .active and
// .mark-target-row. Called whenever editingIndex changes (updateMarkTargetUi)
// or mark mode itself is toggled, not on every playback tick, so it doesn't
// need updateVilnaOverlay's dedup-key guard.
function updateVilnaMarkTarget() {
  const overlay = $('vilnaMarkTargetOverlay');
  if (!overlay) return;
  overlay.innerHTML = '';
  // No target box at all is a clearer state than a wrong one when the
  // segment being corrected has no known word-level boundaries yet (w0/w1
  // null -- the normal starting state before any mark-mode correction has
  // been made for it, not a rare edge case) -- the phrase itself is still
  // visible via mark-target-segment/mark-target-row in the text panel and
  // editor table.
  const target = state.vilnaMarkMode ? state.segments[state.editingIndex] : null;
  const hasRange = target && target.w0 !== null && target.w1 !== null;
  if (!target || !hasRange) return;
  const boxes = (state.vilnaPageMap?.wordBoxes || [])
    .filter((box) => box.ref === target.ref && box.wordIndex >= target.w0 && box.wordIndex <= target.w1)
    .sort((a, b) => a.wordIndex - b.wordIndex);
  appendLineRects(overlay, groupBoxesIntoLineRects(boxes, state.vilnaPageMap, vilnaInkBands(state.vilnaPageMap)), 'vilna-mark-target-rect');
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

  // Same merged-per-line-bar, blue (#8ecdf5) highlight the main daf page's
  // .vilna-active-rect uses (see updateVilnaOverlay/groupBoxesIntoLineRects),
  // not this canvas's own older per-word-box style: reported directly, this
  // in-video overlay was still drawing one oversized, padded (padX=15%/
  // padY=35% of the box) rect per WORD, in the old solid yellow -- exactly
  // the "jagged block of overlapping rectangles instead of one clean bar"
  // the main page's own overlay was already rebuilt to fix (see that
  // function's comment). vilnaInkBands reads $('vilnaPageCanvas')'s own
  // raster for precise per-line height and returns null if that canvas
  // isn't currently visible (e.g. a mobile reader using only the video
  // overlay, with the side-by-side Vilna page scrolled out of view) --
  // groupBoxesIntoLineRects already degrades gracefully to an estimated
  // height in that case, same as it does for the main page.
  ctx.save();
  ctx.fillStyle = '#8ecdf5';
  ctx.globalCompositeOperation = 'multiply';
  const lineRects = groupBoxesIntoLineRects(activeBoxes, state.vilnaPageMap, vilnaInkBands(state.vilnaPageMap));
  for (const rect of lineRects) {
    const rx = (rect.left * pageW - sx) * scale;
    const ry = (rect.top * pageH - sourceY) * scale;
    const rw = rect.width * pageW * scale;
    const rh = rect.height * pageH * scale;
    ctx.beginPath();
    ctx.roundRect(rx, ry, rw, rh, Math.min(rw, rh) / 2);
    ctx.fill();
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
  if (box) {
    hapticTap();
    seekToVilnaWord(box.ref, box.wordIndex);
  }
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

// --- Reading Mode: video on the printed daf -------------------------------
// This is deliberately the inverse of the canvas-based "daf on video"
// overlay above. The existing #videoFrame permanently lives inside this
// wrapper; Reading Mode only changes the wrapper's layout. Never detaching or
// reparenting the YouTube iframe is what keeps playback, buffering, captions,
// quality selection, and the synchronization clock completely continuous.
const READING_VIDEO_PREFS_KEY = 'dafsync-reading-video-v1';
const READING_VIDEO_MIN_WIDTH = 190;
const READING_VIDEO_MAX_WIDTH = 560;
let readingVideoDrag = null;
let readingVideoResize = null;
const readingVideoPinchPointers = new Map();
let readingVideoPinch = null;
let readingVideoTap = null;
let readingVideoNativeGesture = null;
let readingVideoGestureSaveTimer = null;
let readingFollowTimer = null;
let readingFollowScrollUntil = 0;
let readingPageLayoutTimer = null;
let readingModeTipTimer = null;

function clampReadingValue(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function loadReadingVideoPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(READING_VIDEO_PREFS_KEY) || 'null');
    if (!saved || typeof saved !== 'object') return;
    if (Number.isFinite(saved.width)) state.readingVideoWidth = saved.width;
    if (Number.isFinite(saved.x)) state.readingVideoX = clampReadingValue(saved.x, 0, 1);
    if (Number.isFinite(saved.y)) state.readingVideoY = clampReadingValue(saved.y, 0, 1);
    if (typeof saved.follow === 'boolean') state.readingVideoFollow = saved.follow;
  } catch {
    // A malformed preference should never keep the player from opening.
  }
}

function saveReadingVideoPreferences() {
  try {
    localStorage.setItem(READING_VIDEO_PREFS_KEY, JSON.stringify({
      width: state.readingVideoWidth,
      x: state.readingVideoX,
      y: state.readingVideoY,
      follow: state.readingVideoFollow,
    }));
  } catch {
    // Private browsing/storage denial is harmless; the live controls work.
  }
}

// Drag/resize clamping used to keep the mini-player within #dafScroll's own
// visible viewport -- a real report asked for it to be movable across the
// WHOLE reading surface instead, not boxed into just the scrollable text
// column. Clamped to the containing .watch-layout's own rect now (the full
// reading-mode surface: in reading mode .daf-card alone drives its height,
// close to the full viewport height, and its width spans up to 1320px --
// still not literally the whole browser window, since it's absolutely
// positioned within .watch-layout rather than viewport-fixed, but a real
// expansion from the old scroll-column-only box). scrollRect/containerRect
// are still returned and still computed off #dafScroll/the container
// exactly as before -- positionReadingVideoBelowActiveWords's own "stay
// near the highlighted words" placement reads scrollRect directly and
// still needs the real scrollable text area, not this widened clamp.
function readingVideoBounds() {
  const float = $('readingVideoFloat');
  const scroll = $('dafScroll');
  const container = float?.offsetParent || document.querySelector('.watch-layout');
  if (!float || !scroll || !container) return null;
  const containerRect = container.getBoundingClientRect();
  const scrollRect = scroll.getBoundingClientRect();
  if (!scrollRect.width || !scrollRect.height) return null;
  const inset = 10;
  return {
    left: inset,
    top: inset,
    right: containerRect.width - inset,
    bottom: containerRect.height - inset,
    width: Math.max(0, containerRect.width - inset * 2),
    height: Math.max(0, containerRect.height - inset * 2),
    containerRect,
    scrollRect,
  };
}

function readingVideoPosition() {
  const float = $('readingVideoFloat');
  const container = float?.offsetParent || document.querySelector('.watch-layout');
  if (!float || !container) return { left: 0, top: 0 };
  const floatRect = float.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  return { left: floatRect.left - containerRect.left, top: floatRect.top - containerRect.top };
}

function placeReadingVideo(left, top) {
  const float = $('readingVideoFloat');
  const bounds = readingVideoBounds();
  if (!float || !bounds) return;
  const width = float.offsetWidth;
  const height = float.offsetHeight;
  const maxLeft = Math.max(bounds.left, bounds.right - width);
  const maxTop = Math.max(bounds.top, bounds.bottom - height);
  float.style.left = `${clampReadingValue(left, bounds.left, maxLeft)}px`;
  float.style.top = `${clampReadingValue(top, bounds.top, maxTop)}px`;
}

function captureReadingVideoPosition() {
  const float = $('readingVideoFloat');
  const bounds = readingVideoBounds();
  if (!float || !bounds) return;
  const { left, top } = readingVideoPosition();
  const rangeX = Math.max(1, bounds.width - float.offsetWidth);
  const rangeY = Math.max(1, bounds.height - float.offsetHeight);
  state.readingVideoX = clampReadingValue((left - bounds.left) / rangeX, 0, 1);
  state.readingVideoY = clampReadingValue((top - bounds.top) / rangeY, 0, 1);
  saveReadingVideoPreferences();
}

function maxReadingVideoWidth() {
  const bounds = readingVideoBounds();
  if (!bounds) return READING_VIDEO_MAX_WIDTH;
  const maxByHeight = Math.max(0, bounds.height * (16 / 9));
  return Math.max(1, Math.min(READING_VIDEO_MAX_WIDTH, bounds.width, maxByHeight));
}

function setReadingVideoWidth(width, { persist = true, reposition = true } = {}) {
  const float = $('readingVideoFloat');
  if (!float) return null;
  const maxWidth = maxReadingVideoWidth();
  const minWidth = Math.min(READING_VIDEO_MIN_WIDTH, maxWidth);
  const nextWidth = Math.round(clampReadingValue(Number(width) || minWidth, minWidth, maxWidth));
  state.readingVideoWidth = nextWidth;
  float.style.width = `${nextWidth}px`;
  if (reposition) {
    requestAnimationFrame(() => {
      const pos = readingVideoPosition();
      placeReadingVideo(pos.left, pos.top);
      if (state.readingVideoFollow && !readingVideoDrag && !readingVideoResize && !readingVideoPinch && !readingVideoNativeGesture) scheduleReadingVideoFollow(true, 0);
    });
  }
  if (persist) saveReadingVideoPreferences();
  return nextWidth;
}

function restoreReadingVideoPlacement() {
  const float = $('readingVideoFloat');
  const bounds = readingVideoBounds();
  if (!float || !bounds) return;
  const defaultWidth = window.innerWidth <= 760 ? 260 : 360;
  setReadingVideoWidth(state.readingVideoWidth || defaultWidth, { persist: false });
  requestAnimationFrame(() => {
    const latestBounds = readingVideoBounds();
    if (!latestBounds) return;
    const rangeX = Math.max(0, latestBounds.width - float.offsetWidth);
    const rangeY = Math.max(0, latestBounds.height - float.offsetHeight);
    const x = state.readingVideoX == null ? 0.04 : state.readingVideoX;
    const y = state.readingVideoY == null ? 0.82 : state.readingVideoY;
    placeReadingVideo(latestBounds.left + rangeX * x, latestBounds.top + rangeY * y);
    if (state.readingVideoFollow) scheduleReadingVideoFollow(true, 0);
  });
}

function updateReadingVideoFollowUi() {
  const button = $('readingVideoFollowButton');
  const label = $('readingVideoFollowLabel');
  if (button) {
    button.classList.toggle('active', state.readingVideoFollow);
    button.setAttribute('aria-pressed', String(state.readingVideoFollow));
    button.title = state.readingVideoFollow
      ? 'Following the highlighted words — click to keep the video in place'
      : 'Keep the video near the highlighted words';
  }
  if (label) label.textContent = state.readingVideoFollow ? 'Following' : 'Follow daf';
}

function setReadingVideoFollow(enabled, { announce = false, persist = true } = {}) {
  state.readingVideoFollow = Boolean(enabled);
  updateReadingVideoFollowUi();
  if (!state.readingVideoFollow) clearTimeout(readingFollowTimer);
  else if (state.readingModeEnabled) scheduleReadingVideoFollow(true, 0);
  if (persist) saveReadingVideoPreferences();
  if (announce) {
    showToast(state.readingVideoFollow
      ? 'The mini-player will follow the highlighted words.'
      : 'Follow paused. The mini-player will stay where you put it.');
  }
}

// updateVilnaOverlay (called just before this on every playback tick, via
// updateActiveWords) already renders exactly the currently-active phrase's
// own line-rects into #vilnaActiveOverlay -- reading them straight from
// there is simpler and more precise than the word-box lookup this used to
// do (a per-word element map that no longer exists; renderVilnaWordBoxes
// builds per-PHRASE regions now, see its own comment), and can never drift
// out of sync with what updateVilnaOverlay just drew.
function activeVilnaWordElements() {
  const overlay = $('vilnaActiveOverlay');
  return overlay ? Array.from(overlay.children) : [];
}

function unionRects(rects) {
  if (!rects.length) return null;
  return {
    left: Math.min(...rects.map((rect) => rect.left)),
    top: Math.min(...rects.map((rect) => rect.top)),
    right: Math.max(...rects.map((rect) => rect.right)),
    bottom: Math.max(...rects.map((rect) => rect.bottom)),
  };
}

// Page OCR occasionally assigns one or two words from a paragraph to a
// distant marginal note. Using the full min/max rectangle for follow mode
// would then make a normal highlighted phrase appear hundreds of pixels tall
// and send the player toward that outlier. Anchor to the representative
// lower-middle line cluster instead: low enough to sit beneath a multi-line
// phrase, while still following where most of its highlighted words actually
// are.
function activeVilnaReadingAnchor() {
  const rects = activeVilnaWordElements()
    .map((el) => el.getBoundingClientRect())
    .filter((rect) => rect.width && rect.height);
  if (!rects.length) return null;
  const byCenter = [...rects].sort((a, b) => (a.top + a.bottom) - (b.top + b.bottom));
  const anchorIndex = Math.floor((byCenter.length - 1) * 0.65);
  const anchorCenter = (byCenter[anchorIndex].top + byCenter[anchorIndex].bottom) / 2;
  const heights = rects.map((rect) => rect.height).sort((a, b) => a - b);
  const medianHeight = heights[Math.floor(heights.length / 2)] || 8;
  const tolerance = Math.max(18, medianHeight * 2.5);
  const cluster = rects.filter((rect) => Math.abs((rect.top + rect.bottom) / 2 - anchorCenter) <= tolerance);
  return unionRects(cluster.length ? cluster : rects);
}

function positionReadingVideoBelowActiveWords(force = false) {
  if (!state.readingModeEnabled || !state.readingVideoFollow || readingVideoDrag || readingVideoResize || readingVideoPinch || readingVideoNativeGesture) return;
  const float = $('readingVideoFloat');
  const bounds = readingVideoBounds();
  const anchor = activeVilnaReadingAnchor();
  if (!float || !bounds || !anchor) return;

  const floatRect = float.getBoundingClientRect();
  const gap = 12;
  const currentGap = floatRect.top - anchor.bottom;
  const comfortablyFollowing = currentGap >= gap - 2
    && currentGap <= 68
    && floatRect.bottom <= bounds.scrollRect.bottom - 8
    && anchor.top >= bounds.scrollRect.top + 8;
  if (comfortablyFollowing && !force) return;

  // A calm follow: only scroll once the highlighted words and the video no
  // longer fit together. Put the words in the upper fifth, leaving a stable
  // reading area plus enough room for the mini-player immediately beneath.
  const needsScroll = anchor.top < bounds.scrollRect.top + 18
    || anchor.bottom > bounds.scrollRect.bottom - 18
    || anchor.bottom + gap + floatRect.height > bounds.scrollRect.bottom - 8;
  if (needsScroll && Date.now() >= readingFollowScrollUntil) {
    const targetAnchorTop = bounds.scrollRect.top + Math.min(120, Math.max(34, bounds.scrollRect.height * 0.18));
    const delta = anchor.top - targetAnchorTop;
    if (Math.abs(delta) > 2) {
      readingFollowScrollUntil = Date.now() + (force ? 80 : 340);
      $('dafScroll').scrollBy({ top: delta, behavior: force ? 'auto' : 'smooth' });
      clearTimeout(readingFollowTimer);
      readingFollowTimer = setTimeout(() => positionReadingVideoBelowActiveWords(true), force ? 30 : 360);
      return;
    }
  }

  const freshBounds = readingVideoBounds();
  const freshAnchor = activeVilnaReadingAnchor();
  if (!freshBounds || !freshAnchor) return;
  const current = readingVideoPosition();
  let targetScreenTop = freshAnchor.bottom + gap;
  if (targetScreenTop + float.offsetHeight > freshBounds.scrollRect.bottom - 8) {
    targetScreenTop = freshAnchor.top - float.offsetHeight - gap;
  }
  placeReadingVideo(current.left, targetScreenTop - freshBounds.containerRect.top);
}

function scheduleReadingVideoFollow(force = false, delay = 70) {
  if (!state.readingModeEnabled || !state.readingVideoFollow) return;
  if (!force) {
    const cooldownRemaining = AUTO_SCROLL_RESUME_MS - (Date.now() - state.lastManualScrollAt);
    if (cooldownRemaining > 0) {
      clearTimeout(readingFollowTimer);
      readingFollowTimer = setTimeout(() => scheduleReadingVideoFollow(false, 0), cooldownRemaining + 30);
      return;
    }
    if (Date.now() < readingFollowScrollUntil) return;
  }
  clearTimeout(readingFollowTimer);
  readingFollowTimer = setTimeout(() => positionReadingVideoBelowActiveWords(force), delay);
}

// Expanding the daf from a narrow side column to Reading Mode's full-width
// surface changes the ideal PDF raster size. Reuse the already-loaded vector
// PDF page, update its CSS footprint immediately, and let the existing crisp
// zoom renderer repaint it at the new resolution in the background.
function scheduleVilnaPageLayoutRefresh(delay = 80) {
  clearTimeout(readingPageLayoutTimer);
  readingPageLayoutTimer = setTimeout(() => {
    const wrap = $('vilnaPageWrap');
    const canvas = $('vilnaPageCanvas');
    if (!wrap || !canvas || canvas.hidden) {
      renderVilnaPage();
      return;
    }
    const width = Math.round(wrap.clientWidth || 0);
    if (!width) return;
    state.vilnaPdfContainerWidth = width;
    canvas.style.width = `${width}px`;
    canvas.style.removeProperty('height');
    rerenderVilnaPageForZoom().finally(() => {
      applyVilnaPageZoom();
      if (state.readingModeEnabled) scheduleReadingVideoFollow(true, 0);
    });
  }, delay);
}

function applyVideoOverlayEnabled(enabled) {
  state.videoOverlayEnabled = Boolean(enabled);
  for (const id of ['overlayToggle', 'overlayToggleInVideo']) {
    const toggle = $(id);
    if (toggle) toggle.checked = state.videoOverlayEnabled;
  }
  $('videoFrame')?.classList.toggle('overlay-on', state.videoOverlayEnabled);
  if ($('overlaySettings')) $('overlaySettings').open = state.videoOverlayEnabled;
  updateVideoOverlay(getCurrentTime());
}

function updateReadingModeUi() {
  const button = $('readingModeButton');
  const label = $('readingModeButtonLabel');
  const fullscreenButton = $('vilnaFullscreenButton');
  if (button) {
    button.classList.toggle('active', state.readingModeEnabled);
    button.setAttribute('aria-pressed', String(state.readingModeEnabled));
    button.title = state.readingModeEnabled ? 'Return to split view' : 'Place the shiur video over the printed daf';
  }
  if (label) label.textContent = state.readingModeEnabled ? 'Exit mode' : 'Video on daf';
  if (fullscreenButton) {
    const title = state.readingModeEnabled ? 'Fullscreen daf and video' : 'Fullscreen daf';
    fullscreenButton.title = title;
    fullscreenButton.setAttribute('aria-label', title);
  }
}

function showReadingModeTip() {
  const tip = $('readingModeTip');
  if (!tip) return;
  clearTimeout(readingModeTipTimer);
  tip.classList.add('show');
  readingModeTipTimer = setTimeout(() => tip.classList.remove('show'), 5200);
}

function setReadingMode(enabled) {
  const float = $('readingVideoFloat');
  if (!float) return;
  const nextEnabled = Boolean(enabled);
  if (nextEnabled === state.readingModeEnabled) return;

  if (nextEnabled) {
    // Reading Mode is a Vilna-page experience even when reached after the
    // dedicated camera route or an admin-only view change.
    if ($('vilnaPlaceholder')?.hidden) switchDafView('page');
    state.readingModePreviousOverlayEnabled = state.videoOverlayEnabled;
    applyVideoOverlayEnabled(false); // the inverse modes are mutually exclusive
    state.readingModeEnabled = true;
    document.body.classList.add('reading-mode-active');
    updateReadingModeUi();
    updateReadingVideoFollowUi();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      restoreReadingVideoPlacement();
      scheduleVilnaPageLayoutRefresh(0);
      showReadingModeTip();
    }));
    return;
  }

  state.readingModeEnabled = false;
  clearTimeout(readingFollowTimer);
  clearTimeout(readingModeTipTimer);
  $('readingModeTip')?.classList.remove('show');
  float.classList.remove('is-dragging', 'is-resizing');
  readingVideoPinchPointers.clear();
  readingVideoPinch = null;
  readingVideoTap = null;
  readingVideoNativeGesture = null;
  clearTimeout(readingVideoGestureSaveTimer);
  document.body.classList.remove('reading-mode-active');
  applyVideoOverlayEnabled(state.readingModePreviousOverlayEnabled);
  updateReadingModeUi();
  scheduleVilnaPageLayoutRefresh(0);
}

(function initReadingMode() {
  const toggle = $('readingModeButton');
  const follow = $('readingVideoFollowButton');
  const float = $('readingVideoFloat');
  const resizeHandle = $('readingVideoResizeHandle');
  const pinchSurface = $('readingVideoPinchSurface');
  if (!toggle || !float || !resizeHandle || !pinchSurface) return;

  loadReadingVideoPreferences();
  updateReadingVideoFollowUi();

  toggle.addEventListener('click', () => setReadingMode(!state.readingModeEnabled));
  follow?.addEventListener('click', () => setReadingVideoFollow(!state.readingVideoFollow, { announce: true }));

  // The YouTube iframe is cross-origin, so touch events inside it cannot
  // bubble into this page. A transparent surface therefore covers the video
  // picture (never the custom controls beneath it). One pointer drags, two
  // pointers resize, and a quick tap retains play/pause behavior. It is
  // always enabled instead of relying on an unreliable coarse-pointer media
  // query, which some touch-capable browsers report incorrectly.
  //
  // This surface is a SIBLING of #videoFrame, not a descendant of it (see
  // the markup) -- so #videoFrame's own mousemove/mouseenter/touchstart
  // listeners that show the custom controls (showVideoControls, defined
  // further down) never fire for pointer activity here, even though this
  // surface covers nearly the entire mini-player. Left alone, the controls
  // auto-hide after CONTROLS_AUTO_HIDE_MS and then have no way to reappear
  // outside the thin strip at the very bottom this surface deliberately
  // excludes. showVideoControls() is called explicitly from this surface's
  // own pointerdown/pointermove below (and from the resize handle's own
  // pointerdown) to keep the same show/hide behavior the main player
  // already has, rather than the mini-player silently losing it.
  function pinchPair() {
    return [...readingVideoPinchPointers.values()].slice(0, 2);
  }
  function pinchDistance(a, b) {
    return Math.hypot(b.x - a.x, b.y - a.y);
  }
  function pinchMidpoint(a, b) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }
  function readingVideoResizeBaseline(clientX, clientY) {
    const rect = float.getBoundingClientRect();
    const x = Number.isFinite(clientX) && clientX > 0 ? clientX : rect.left + rect.width / 2;
    const y = Number.isFinite(clientY) && clientY > 0 ? clientY : rect.top + rect.height / 2;
    return {
      width: float.offsetWidth,
      height: float.offsetHeight,
      clientX: x,
      clientY: y,
      anchorX: x - rect.left,
      anchorY: y - rect.top,
    };
  }
  function resizeReadingVideoFromBaseline(baseline, targetWidth, clientX = baseline.clientX, clientY = baseline.clientY) {
    const nextWidth = setReadingVideoWidth(targetWidth, { persist: false, reposition: false });
    const bounds = readingVideoBounds();
    if (!nextWidth || !bounds) return nextWidth;
    const scaleX = nextWidth / baseline.width;
    const scaleY = float.offsetHeight / baseline.height;
    placeReadingVideo(
      clientX - baseline.anchorX * scaleX - bounds.containerRect.left,
      clientY - baseline.anchorY * scaleY - bounds.containerRect.top,
    );
    return nextWidth;
  }
  function finishReadingVideoGestureResize() {
    clearTimeout(readingVideoGestureSaveTimer);
    readingVideoPinch = null;
    readingVideoNativeGesture = null;
    float.classList.remove('is-resizing');
    captureReadingVideoPosition();
    saveReadingVideoPreferences();
    if (state.readingVideoFollow) scheduleReadingVideoFollow(true, 0);
  }
  function beginReadingVideoPinch() {
    const [a, b] = pinchPair();
    if (!a || !b) return;
    const mid = pinchMidpoint(a, b);
    readingVideoPinch = {
      ...readingVideoResizeBaseline(mid.x, mid.y),
      distance: Math.max(1, pinchDistance(a, b)),
    };
    readingVideoDrag = null;
    readingVideoTap = null;
    float.classList.remove('is-dragging');
    float.classList.add('is-resizing');
  }
  pinchSurface.addEventListener('pointerdown', (event) => {
    if (!state.readingModeEnabled || (event.pointerType === 'mouse' && event.button !== 0)) return;
    showVideoControls();
    clearTimeout(readingVideoGestureSaveTimer);
    readingVideoNativeGesture = null;
    const point = { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY };
    readingVideoPinchPointers.set(event.pointerId, point);
    if (readingVideoPinchPointers.size === 1) {
      const pos = readingVideoPosition();
      readingVideoDrag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, left: pos.left, top: pos.top, moved: false };
      readingVideoTap = { pointerId: event.pointerId, startedAt: performance.now() };
    } else if (readingVideoPinchPointers.size === 2) {
      beginReadingVideoPinch();
    }
    pinchSurface.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });
  pinchSurface.addEventListener('pointermove', (event) => {
    // Fires on plain hover too (no button pressed), not just an active
    // drag -- matching the main player's mousemove-driven show/hide (see
    // this surface's own comment above for why it can't just rely on
    // #videoFrame's own listener). Deliberately before the early return
    // below so idle hovering still keeps the controls up.
    showVideoControls();
    const point = readingVideoPinchPointers.get(event.pointerId);
    if (!point) return;
    point.x = event.clientX;
    point.y = event.clientY;
    if (!readingVideoPinch && readingVideoPinchPointers.size >= 2) beginReadingVideoPinch();
    if (readingVideoPinch) {
      const [a, b] = pinchPair();
      if (!a || !b) return;
      const mid = pinchMidpoint(a, b);
      const ratio = pinchDistance(a, b) / readingVideoPinch.distance;
      resizeReadingVideoFromBaseline(readingVideoPinch, readingVideoPinch.width * ratio, mid.x, mid.y);
      event.preventDefault();
      return;
    }

    if (!readingVideoDrag || readingVideoDrag.pointerId !== event.pointerId) return;
    const dx = event.clientX - readingVideoDrag.startX;
    const dy = event.clientY - readingVideoDrag.startY;
    if (!readingVideoDrag.moved && Math.hypot(dx, dy) > 5) {
      readingVideoDrag.moved = true;
      readingVideoTap = null;
      setReadingVideoFollow(false, { announce: false });
      float.classList.add('is-dragging');
    }
    if (readingVideoDrag.moved) placeReadingVideo(readingVideoDrag.left + dx, readingVideoDrag.top + dy);
    event.preventDefault();
  });
  function finishReadingVideoPinchPointer(event, cancelled = false) {
    const point = readingVideoPinchPointers.get(event.pointerId);
    if (!point) return;
    const wasPinching = Boolean(readingVideoPinch);
    readingVideoPinchPointers.delete(event.pointerId);

    if (wasPinching && readingVideoPinchPointers.size < 2) {
      readingVideoPinchPointers.clear();
      readingVideoDrag = null;
      readingVideoTap = null;
      finishReadingVideoGestureResize();
      return;
    }

    const drag = readingVideoDrag?.pointerId === event.pointerId ? readingVideoDrag : null;
    readingVideoDrag = null;
    float.classList.remove('is-dragging');
    if (drag?.moved) captureReadingVideoPosition();
    const tap = readingVideoTap;
    if (!cancelled && !drag?.moved && tap?.pointerId === event.pointerId && readingVideoPinchPointers.size === 0) {
      const travel = Math.hypot(point.x - point.startX, point.y - point.startY);
      if (travel < 10 && performance.now() - tap.startedAt < 450) togglePlay();
    }
    if (readingVideoPinchPointers.size === 0) readingVideoTap = null;
  }
  pinchSurface.addEventListener('pointerup', (event) => finishReadingVideoPinchPointer(event));
  pinchSurface.addEventListener('pointercancel', (event) => finishReadingVideoPinchPointer(event, true));

  // Chrome-style trackpad pinch arrives as Ctrl+wheel rather than two touch
  // pointers. Resize around the cursor so it feels like the same gesture.
  pinchSurface.addEventListener('wheel', (event) => {
    if (!state.readingModeEnabled || !event.ctrlKey) return;
    event.preventDefault();
    const baseline = readingVideoResizeBaseline(event.clientX, event.clientY);
    readingVideoNativeGesture = baseline;
    const factor = clampReadingValue(Math.exp(-event.deltaY * 0.01), 0.78, 1.28);
    resizeReadingVideoFromBaseline(baseline, baseline.width * factor, baseline.clientX, baseline.clientY);
    float.classList.add('is-resizing');
    clearTimeout(readingVideoGestureSaveTimer);
    readingVideoGestureSaveTimer = setTimeout(finishReadingVideoGestureResize, 180);
  }, { passive: false });

  // Safari exposes trackpad pinch through gesture events. Touchscreen Safari
  // still uses the pointer path above; the pointer check prevents duplicate
  // handling when both event families are present.
  pinchSurface.addEventListener('gesturestart', (event) => {
    if (!state.readingModeEnabled || readingVideoPinchPointers.size) return;
    event.preventDefault();
    clearTimeout(readingVideoGestureSaveTimer);
    readingVideoNativeGesture = readingVideoResizeBaseline(event.clientX, event.clientY);
    float.classList.add('is-resizing');
  });
  pinchSurface.addEventListener('gesturechange', (event) => {
    if (!readingVideoNativeGesture) return;
    event.preventDefault();
    resizeReadingVideoFromBaseline(
      readingVideoNativeGesture,
      readingVideoNativeGesture.width * (Number(event.scale) || 1),
      readingVideoNativeGesture.clientX,
      readingVideoNativeGesture.clientY,
    );
  });
  pinchSurface.addEventListener('gestureend', (event) => {
    if (!readingVideoNativeGesture) return;
    event.preventDefault();
    finishReadingVideoGestureResize();
  });

  pinchSurface.addEventListener('keydown', (event) => {
    const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (!state.readingModeEnabled) return;
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      togglePlay();
      return;
    }
    if (['-', '+', '='].includes(event.key)) {
      event.preventDefault();
      setReadingVideoWidth((state.readingVideoWidth || float.offsetWidth) + (event.key === '-' ? -30 : 30));
      return;
    }
    if (!moves[event.key]) return;
    event.preventDefault();
    setReadingVideoFollow(false, { announce: false });
    const pos = readingVideoPosition();
    const amount = event.shiftKey ? 30 : 10;
    placeReadingVideo(pos.left + moves[event.key][0] * amount, pos.top + moves[event.key][1] * amount);
    captureReadingVideoPosition();
  });

  resizeHandle.addEventListener('pointerdown', (event) => {
    if (!state.readingModeEnabled) return;
    // Same reasoning as the pinch surface's own pointerdown/pointermove --
    // this handle is also a sibling of #videoFrame, so grabbing it would
    // otherwise never keep the controls visible on its own.
    showVideoControls();
    readingVideoResize = { pointerId: event.pointerId, startX: event.clientX, width: float.offsetWidth };
    resizeHandle.setPointerCapture(event.pointerId);
    float.classList.add('is-resizing');
    event.preventDefault();
  });
  resizeHandle.addEventListener('pointermove', (event) => {
    if (!readingVideoResize || readingVideoResize.pointerId !== event.pointerId) return;
    setReadingVideoWidth(readingVideoResize.width + (event.clientX - readingVideoResize.startX), { persist: false });
  });
  function finishReadingVideoResize(event) {
    if (!readingVideoResize || (event && readingVideoResize.pointerId !== event.pointerId)) return;
    readingVideoResize = null;
    float.classList.remove('is-resizing');
    captureReadingVideoPosition();
    saveReadingVideoPreferences();
    if (state.readingVideoFollow) scheduleReadingVideoFollow(true, 0);
  }
  resizeHandle.addEventListener('pointerup', finishReadingVideoResize);
  resizeHandle.addEventListener('pointercancel', finishReadingVideoResize);
  resizeHandle.addEventListener('keydown', (event) => {
    if (!state.readingModeEnabled || !['ArrowLeft', 'ArrowRight', '-', '+', '='].includes(event.key)) return;
    event.preventDefault();
    const largerKey = event.key === 'ArrowRight' || event.key === '+' || event.key === '=';
    setReadingVideoWidth((state.readingVideoWidth || float.offsetWidth) + (largerKey ? 30 : -30));
  });

  window.addEventListener('resize', () => {
    if (!state.readingModeEnabled) return;
    setReadingVideoWidth(state.readingVideoWidth || float.offsetWidth, { persist: false });
    const pos = readingVideoPosition();
    placeReadingVideo(pos.left, pos.top);
    scheduleVilnaPageLayoutRefresh(120);
  });
  function handleReadingModeFullscreenChange() {
    if (!state.readingModeEnabled) return;
    requestAnimationFrame(() => {
      setReadingVideoWidth(state.readingVideoWidth || float.offsetWidth, { persist: false });
      restoreReadingVideoPlacement();
      scheduleVilnaPageLayoutRefresh(0);
    });
  }
  document.addEventListener('fullscreenchange', handleReadingModeFullscreenChange);
  document.addEventListener('webkitfullscreenchange', handleReadingModeFullscreenChange);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.readingModeEnabled && !document.fullscreenElement && !document.querySelector('dialog[open]')) {
      setReadingMode(false);
    }
  });
  $('dafScroll')?.addEventListener('scroll', () => {
    if (state.readingModeEnabled && state.readingVideoFollow && Date.now() >= readingFollowScrollUntil) {
      scheduleReadingVideoFollow(false, 100);
    }
  }, { passive: true });
})();

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
  updateScanOverlay(time);
  updateVideoOverlay(time);
  // In Reading Mode this is intentionally gentle: the scheduler only moves
  // once the current words and mini-player no longer fit comfortably
  // together, and respects the same manual-scroll cooldown as the text view.
  scheduleReadingVideoFollow(false);
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
    updateVaaterButtonUi(time);
    return;
  }
  // A natural playback tick (force=false, no timeOverride -- i.e. called
  // from updateTimeline's own poll, not from seek()) must never move the
  // highlight BACKWARD. getCurrentTime() can report a slightly earlier
  // time than the previous poll on a real, ordinary stall/quality-switch
  // blip -- a few hundred milliseconds is enough, since Talmudic text
  // often repeats near-identical phrasing a few lines apart, for that to
  // read as the highlight visibly jumping back to an earlier, similar-
  // looking word before snapping forward again on the very next tick.
  // Every deliberate move (seek(), a fresh daf load, tap-a-word) already
  // calls this with force=true specifically so it isn't caught here.
  if (!force && index < state.activeIndex) {
    updateActiveWords(time);
    updateVaaterButtonUi(time);
    return;
  }
  state.activeIndex = index;
  updateVaaterButtonUi(time);
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
  // The prominent "Following: <daf>" heading above the daf card should
  // track whichever daf is actually playing right now, not just sit on
  // the ref the reader navigated to -- otherwise a video that opens on a
  // lead-in review of the previous daf (see loadDaf's own comment on
  // state.forwardAlignment) shows the WRONG daf here for the entire
  // stretch that lead-in plays, which is exactly what a real report
  // called out: the heading read "Chullin 103a" from the first second,
  // even while the video was still reviewing 102b. Left alone in browse
  // mode, where this same heading instead tracks state.browsePageRef (see
  // onDafPickerChanged/renderVilnaWordBoxes) -- that one has to stay
  // pinned to whichever page image is on screen, not whatever video
  // happens to be playing behind it.
  if (!state.browseMode && activeDaf) {
    $('dafTitle').textContent = `${activeDaf.tractate} ${activeDaf.daf}${activeDaf.amud}`;
  }

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
  updateScrubberFill();
  updateActiveSegment();
  // Self-corrects the play/pause icon on every poll tick (this runs every
  // 100ms during YouTube playback -- see startYouTubePoll), independent of
  // whichever discrete event last fired -- a defense-in-depth backstop for
  // the same missed-onStateChange-event risk isPaused() above already
  // reads around directly, so the icon can never drift for more than one
  // tick even in an environment where events are unreliable.
  updatePlayUi();
}

// How much of the video has actually downloaded, 0-1 -- matches YouTube's
// own lighter-gray "buffered ahead of playback" fill, distinct from
// updateScrubberFill's existing accent-colored "played so far" fill below.
// YouTube: getVideoLoadedFraction() is a single 0-1 number already covering
// however much has buffered from the start (its own player never shows
// buffered *behind* the current position either, so this matches that).
// Direct video: HTMLMediaElement.buffered is a TimeRanges set (a browser can
// buffer in several disjoint chunks, e.g. after a seek into an unbuffered
// spot) -- the chunk that actually covers (or, if playback hasn't reached it
// yet, starts at/before) the current time is the one relevant to "how far
// ahead can the reader scrub without waiting," same as what YouTube shows.
function getLoadedFraction() {
  if (state.playerType === 'youtube') {
    return state.youtubeReady ? (Number(state.youtubePlayer.getVideoLoadedFraction?.()) || 0) : 0;
  }
  const duration = htmlVideo.duration;
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  const buffered = htmlVideo.buffered;
  const current = htmlVideo.currentTime;
  for (let i = 0; i < buffered.length; i++) {
    if (buffered.start(i) <= current && current <= buffered.end(i)) return buffered.end(i) / duration;
  }
  return 0;
}

function updateScrubberFill() {
  const max = Number(scrubber.max) || 1;
  const loadedPercent = Math.min(100, Math.max(0, getLoadedFraction() * 100));
  for (const el of scrubberEls) {
    const playedPercent = Math.min(100, Math.max(0, (Number(el.value) || 0) / max * 100));
    // Buffered can never trail behind played (a player doesn't un-buffer
    // what it's already shown) -- clamps against rounding/staleness between
    // this and the poll/timeupdate tick that last refreshed loadedPercent.
    const bufferedPercent = Math.max(playedPercent, loadedPercent);
    el.style.background = `linear-gradient(to right, var(--accent) 0%, var(--accent) ${playedPercent}%, rgba(255,255,255,.4) ${playedPercent}%, rgba(255,255,255,.4) ${bufferedPercent}%, rgba(255,255,255,.14) ${bufferedPercent}%, rgba(255,255,255,.14) 100%)`;
  }
}

function updatePlayUi() {
  const paused = isPaused();
  // toggleAttribute, not `.hidden = `: reported directly (and confirmed
  // live in a real browser) that the play/pause icon never actually
  // switched, no matter what isPaused() returned. Root cause -- SVGElement
  // doesn't reliably reflect the `hidden` IDL property back to the actual
  // `hidden` content attribute the way HTMLElement does, so setting
  // `.play-icon`/`.pause-icon`'s own `.hidden` property here silently did
  // nothing to the real DOM attribute the [hidden]{display:none!important}
  // CSS rule keys off -- whichever icon started hidden in the static
  // markup (pause-icon) just stayed hidden forever, regardless of playback
  // state. toggleAttribute operates on the actual attribute directly (it's
  // defined on Element, not HTMLElement-specific reflection), so it works
  // correctly on an <svg> the same as any other element.
  document.querySelectorAll('.play-icon').forEach((el) => { el.toggleAttribute('hidden', !paused); });
  document.querySelectorAll('.pause-icon').forEach((el) => { el.toggleAttribute('hidden', paused); });
  $('largePlay').hidden = !state.videoSource || !paused || getCurrentTime() > 0.15;
  $('playButton').setAttribute('aria-label', paused ? 'Play' : 'Pause');
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

// Video-quality selection, YouTube only -- a direct-link <video> has no
// server-side rendition ladder to pick from, so #qualityControl just stays
// hidden for that source. YouTube's own getAvailableQualityLevels() often
// returns an empty list until playback actually starts buffering (see the
// onStateChange/onPlaybackQualityChange calls in ensureYouTubePlayer), so
// this is re-run at each of those points rather than assumed available the
// moment the player's merely ready.
//
// NOT VERIFIABLE FROM HERE: YouTube's setPlaybackQuality is a request, not a
// guarantee -- their own adaptive-bitrate logic can still override it
// depending on buffer/network conditions, a known, documented limitation of
// this API rather than a bug in this wiring. This UI offers the same choice
// YouTube's own (now-hidden) native quality menu did, no more and no less.
function refreshQualityOptions() {
  const control = $('qualityControl');
  const select = $('qualitySelect');
  if (!control || !select) return;
  if (state.playerType !== 'youtube' || !state.youtubeReady || !state.youtubePlayer.getAvailableQualityLevels) {
    control.hidden = true;
    return;
  }
  const levels = state.youtubePlayer.getAvailableQualityLevels();
  if (!levels || !levels.length) {
    control.hidden = true;
    return;
  }
  const labels = {
    highres: 'Highest', hd2160: '2160p', hd1440: '1440p', hd1080: '1080p',
    hd720: '720p', large: '480p', medium: '360p', small: '240p', tiny: '144p', auto: 'Auto'
  };
  const current = state.youtubePlayer.getPlaybackQuality?.();
  select.innerHTML = levels.map((level) =>
    `<option value="${level}"${level === current ? ' selected' : ''}>${labels[level] || level}</option>`
  ).join('');
  control.hidden = false;
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
    // toggleAttribute, not `.hidden = ` -- same SVGElement reflection gap
    // fixed in updatePlayUi above; these icons are <svg> too.
    if (volumeIcon) volumeIcon.toggleAttribute('hidden', muted);
    if (mutedIcon) mutedIcon.toggleAttribute('hidden', !muted);
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

// Captions are a YouTube-only concept here (a direct video link has no
// equivalent track to toggle), and default OFF via playerVars.cc_load_policy
// -- this is the only path that ever turns them on. loadModule + an empty
// track selector is the documented way to enable YouTube's own default
// caption track without having to guess which language code this
// particular video actually has captions in (a hardcoded 'en' would just
// silently fail to show anything on a Hebrew-language shiur); unloadModule
// is the corresponding way to fully turn them back off. Best-effort: the
// IFrame API's captions module is thinly documented and this couldn't be
// verified against a live video in this environment.
function setCaptionsEnabled(enabled) {
  state.captionsEnabled = enabled;
  if (state.playerType === 'youtube' && state.youtubeReady) {
    try {
      if (enabled) {
        state.youtubePlayer.loadModule('captions');
        state.youtubePlayer.setOption('captions', 'track', {});
      } else {
        state.youtubePlayer.unloadModule('captions');
      }
    } catch (error) {
      console.error('Could not toggle captions.', error);
    }
  }
  for (const button of captionsButtonEls) {
    button.setAttribute('aria-pressed', String(enabled));
    button.setAttribute('title', enabled ? 'Turn off YouTube captions' : 'Turn on YouTube captions');
  }
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
  const saveButton = $('vilnaMarkSaveButton');
  const discardButton = $('vilnaMarkDiscardButton');
  if (saveButton) saveButton.hidden = !state.vilnaMarkMode;
  if (discardButton) discardButton.hidden = !state.vilnaMarkMode;
  if (state.vilnaMarkMode) {
    switchDafView('page');
    checkpointVilnaMarkChanges();
  } else {
    state.vilnaMarkCheckpoint = null;
  }
  updateVilnaMarkTarget();
}

// Snapshot state.segments/editingIndex so discardVilnaMarkChanges() below
// has something to revert to -- taken when mark mode turns on, and again
// every time the admin explicitly saves, so "Discard changes" only ever
// undoes marks made since the last save, not the whole mark-mode session.
function checkpointVilnaMarkChanges() {
  state.vilnaMarkCheckpoint = JSON.stringify({ segments: state.segments, editingIndex: state.editingIndex });
}

function saveVilnaMarkChanges() {
  saveDraft(false);
  bankVoiceCorrection();
  bankManualPhraseSync();
  checkpointVilnaMarkChanges();
}

function discardVilnaMarkChanges() {
  if (!state.vilnaMarkCheckpoint) return;
  if (!confirm('Discard the word-mark corrections made since the last save?')) return;
  const restored = JSON.parse(state.vilnaMarkCheckpoint);
  state.segments = restored.segments;
  state.editingIndex = restored.editingIndex;
  renderDaf(); // also re-runs updateActiveSegment/renderEditor/renderVilnaPage
  updateVilnaMarkTarget();
  updateAlignmentStatus();
  showToast('Discarded changes since the last save.');
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
  // Cleared unconditionally so a stale forward-redirect from whatever daf
  // was loaded before this one can never survive into this one -- only
  // the server-alignment branch below (the only one where the redirect
  // makes sense) has a chance to set it back.
  state.forwardAlignment = null;
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
  const [ocrAlignment, voiceAlignment, syncSettings] = await Promise.all([
    fetchServerAlignment(ref),
    fetchServerAlignment(ref, { voice: true }),
    // Proxied through get-results-file.mjs, same as the autoSyncToggle
    // fetch further down -- see save-settings.mjs for why this lives
    // per-ref inside the same site-wide settings.json rather than its own
    // file.
    fetch('/api/get-results-file?path=settings.json')
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null),
  ]);
  state.availableSyncMethods = { ocr: ocrAlignment, voice: voiceAlignment };
  state.syncMethodSettings = syncSettings?.preferredSyncMethod || {};
  const preferredMethod = state.syncMethodSettings[ref];
  state.activeSyncMethod =
    (preferredMethod === 'voice' && voiceAlignment) ? 'voice'
    : (preferredMethod === 'ocr' && ocrAlignment) ? 'ocr'
    : (ocrAlignment ? 'ocr' : (voiceAlignment ? 'voice' : null));
  updateSyncMethodSwitchUi(ref);
  // Caption-OCR preferred as the default view when both exist and no admin
  // override says otherwise (see preferredMethod above, and the
  // "Set as default" admin-only control that writes it) -- absent an
  // override, caption-OCR is the more established of the two engines; the
  // reader can always switch to voice recognition from the toggle this
  // just made visible.
  const serverAlignment = ocrAlignment || voiceAlignment;
  if (serverAlignment) {
    // The server's own videoSource is never actually playable -- it's
    // just the generic local filename the OCR job used internally
    // (e.g. "job-video.mp4"), not a real YouTube/direct link. Prefer a
    // real link already known for this daf, whether saved on this
    // browser or on another device, over letting that placeholder
    // silently overwrite it.
    // Checked concurrently with the video-source lookup below, not after
    // it -- this only decides whether the NEXT daf's own recording is a
    // *candidate* for the forward-redirect (see seekToVilnaWord); whether
    // it's actually a different recording than this daf's own gets
    // decided once preferredVideoSource is in hand too.
    const nextRef = nextDafRef(ref);
    const [preferredVideoSource, nextLink] = await Promise.all([
      resolvePreferredVideoSource(ref, loadProjectForRef(ref)),
      nextRef ? fetchServerVideoLink(nextRef) : Promise.resolve(null),
    ]);
    // An alignment's timestamps are only meaningful against the one recording
    // they were measured from, so if the video about to play isn't that
    // recording, its timestamps are simply wrong here -- every highlight
    // lands somewhere arbitrary rather than merely out of order. That
    // mismatch is exactly what a reader following a shiur through the tail
    // of the previous daf hits: the daf-104 recording covers the end of
    // 103b, but 103b's own by-ref alignment belongs to the daf-103
    // recording. Prefer the alignment measured against whatever is actually
    // playing, and fall back to the by-ref one when that recording never
    // reaches this daf (see fetchAlignmentForVideo).
    let alignmentToLoad = serverAlignment;
    if (preferredVideoSource?.videoId && serverAlignment.videoId
        && preferredVideoSource.videoId !== serverAlignment.videoId) {
      const forThisVideo = await fetchAlignmentForVideo(
        preferredVideoSource.videoId, ref, { voice: state.activeSyncMethod === 'voice' });
      if (forThisVideo) alignmentToLoad = forThisVideo;
    }
    if (preferredVideoSource) alignmentToLoad.videoSource = preferredVideoSource;
    // Does the NEXT daf's own recording review the tail of THIS one as its
    // lead-in? Confirmed directly: daf 103's video opens on a recap of the
    // end of 102b using timestamps that only make sense against daf 103's
    // own recording, yet a tap on those same words from 102b's OWN page
    // used to seek within daf 102's (different, earlier) video instead --
    // that page never knew daf 103's recording existed at all. Skipped
    // when the next ref shares this daf's own video already (nothing to
    // redirect to) or doesn't have one of its own yet -- see
    // seekToVilnaWord for where this actually gets used.
    if (nextLink?.videoId && nextLink.videoId !== preferredVideoSource?.videoId) {
      const forward = await fetchAlignmentForVideo(
        nextLink.videoId, ref, { voice: state.activeSyncMethod === 'voice' });
      if (forward) {
        // Restricted to before forward.ownContentStart (see
        // fetchAlignmentForVideo's own comment) -- without this, a stray
        // fuzzy-text match to this ref elsewhere in the next video (well
        // past its own lead-in, already deep into its own daf) would be
        // just as eligible to redirect a tap to as the real lead-in is,
        // sending the reader to an arbitrary, unrelated moment instead of
        // a genuine continuation.
        const before = forward.ownContentStart;
        const wordTimeline = before == null ? forward.wordTimeline : forward.wordTimeline.filter((e) => e.start < before);
        const segments = before == null ? forward.segments : forward.segments.filter((s) => s.start < before);
        if (wordTimeline.length || segments.length) {
          state.forwardAlignment = { ref: nextRef, wordTimeline, segments };
        }
      }
    }
    await loadAlignmentData(alignmentToLoad, { dafRefOverride: ref });
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
    // restoreVideoSource handles and reports its own failures now (see its
    // own comment) -- every caller gets that for free, this one included.
    await restoreVideoSource(preferredVideoSource, [ref]);
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
  state.youtubeApiPromise = loadYouTubeApiWithRetry();
  return state.youtubeApiPromise;
}

// Reported directly: this script fails to load roughly half the time, not
// just an occasional blip -- same "genuinely flaky, worth retrying" story
// already confirmed and fixed for the YouTube channel-feed fetch in
// trigger-ocr-job.mjs/trigger-voice-job.mjs. Only retries a definite
// script.onerror (network/DNS/blocked failure) -- never the 15s "took too
// long" timeout in attemptLoadYouTubeApi, since that path means a request
// might still be in flight, and starting a second script tag while the
// first could still complete risks the YouTube API's own global
// onYouTubeIframeAPIReady callback firing twice for two overlapping loads.
const YOUTUBE_API_LOAD_ATTEMPTS = 3;
async function loadYouTubeApiWithRetry() {
  let lastError;
  let realAttempts = 0;
  for (let attempt = 1; attempt <= YOUTUBE_API_LOAD_ATTEMPTS; attempt++) {
    try {
      return await attemptLoadYouTubeApi();
    } catch (error) {
      lastError = error;
      realAttempts = attempt;
      if (error.retryable === false || attempt === YOUTUBE_API_LOAD_ATTEMPTS) break;
      await new Promise((resolve) => setTimeout(resolve, 600 * attempt));
    }
  }
  // Don't leave a permanently-rejected promise cached -- state.youtubeApiPromise
  // being truthy short-circuits every future loadYouTubeApi() call straight to
  // it (see above), so without this, one exhausted retry run would silently
  // doom every later attempt for the rest of the page session (reloading a
  // different daf, clicking play again, anything) to instantly re-fail
  // without even trying.
  state.youtubeApiPromise = null;
  // Reported directly: a reader who reaches this point (every real attempt
  // failed with script.onerror, not just one slow 15s timeout) still sees
  // the exact same failure after a full page reload too -- so "reload the
  // page" is actively wrong advice here, not just unhelpful. The same
  // request failing identically every time, immune to a fresh page load,
  // means something durable is blocking youtube.com specifically (an ad-
  // blocker/privacy extension, or network-level content filtering), not a
  // transient blip retrying could ever paper over -- so say that instead.
  if (lastError.retryable !== false && realAttempts >= YOUTUBE_API_LOAD_ATTEMPTS) {
    lastError = new Error(
      `${lastError.message} Your browser or network may be blocking youtube.com -- `
      + 'try disabling an ad-blocker/privacy extension for this site, or a different network.'
    );
  }
  throw lastError;
}

function attemptLoadYouTubeApi() {
  return new Promise((resolve, reject) => {
    const previousCallback = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof previousCallback === 'function') previousCallback();
      resolve(window.YT);
    };

    // A script tag left over from an earlier onerror'd attempt won't retry
    // on its own -- the browser needs a fresh element to actually try
    // fetching it again.
    document.querySelector('script[src="https://www.youtube.com/iframe_api"]')?.remove();
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    script.onerror = () => reject(new Error('Could not load the YouTube player API.'));
    document.head.appendChild(script);

    setTimeout(() => {
      if (window.YT?.Player) return;
      const error = new Error('The YouTube player took too long to load.');
      error.retryable = false;
      reject(error);
    }, 15000);
  });
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
        // YouTube's own control bar (scrubber, play, volume, quality gear,
        // fullscreen, captions) is replaced entirely by this app's own
        // .player-controls bar, now docked directly onto the video frame --
        // see the HTML comment on .video-frame in each page that embeds this
        // player. Every one of those YouTube-native controls has a rebuilt
        // equivalent here driven through this same IFrame API (seek/play via
        // seekYouTubePlayer &c., setVolume/setMuted, setPlaybackRate,
        // setPlaybackQuality via refreshQualityOptions, and our own
        // fullscreenButton), so nothing YouTube's bar offered is actually
        // lost by turning it off.
        controls: 0,
        enablejsapi: 1,
        // YouTube's own fullscreen button only fullscreens the iframe itself,
        // leaving the Vilna page overlay (a sibling element) behind -- our
        // own fullscreen button (below) fullscreens the whole video-frame
        // container instead, so it covers both.
        fs: 0,
        // Captions default OFF -- #captionsButton (see applyCaptionsEnabled)
        // is the only way to turn them on, matching how a reader already
        // has this daf's own text/translation on screen and doesn't need
        // YouTube's own (frequently auto-generated, un-vetted) captions
        // burned on by default.
        cc_load_policy: 0
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
            setCaptionsEnabled(false);
            showVideoControls();
            resolve();
          },
          onStateChange: (event) => {
            state.youtubeState = event.data;
            updatePlayUi();
            updateTimeline();
            const duration = getDuration();
            if (duration > 0) applyDuration(duration);
            // getAvailableQualityLevels() often reports nothing until the
            // player has actually started buffering a video -- state 3
            // (buffering) or 1 (playing) is the first reliable point real
            // levels show up, not onReady (see refreshQualityOptions).
            if (event.data === 3 || event.data === 1) refreshQualityOptions();
          },
          onPlaybackQualityChange: () => refreshQualityOptions(),
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
    // Every new video defaults back to captions off, same as a fresh
    // player's cc_load_policy -- otherwise a reader who turned captions on
    // for one shiur would silently keep seeing them on the next, with no
    // indication why (this player instance is reused across daf loads,
    // unlike the fresh-construction branch above).
    setCaptionsEnabled(false);
    showVideoControls();
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
  showVideoControls();
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

// Shared by exportAlignment (downloads a file) and publishAlignment (pushes
// straight to the results branch) -- both need the same snapshot of the
// current work, just delivered differently. wordTimeline is included (export
// alone never carried it before) since it's what word highlighting/tap-to-
// seek actually key off (see loadAlignmentData) -- publishing without it
// would silently ship a daf with no word-level sync at all.
function buildAlignmentPayload() {
  const duration = getDuration() || Number(scrubber.max) || 0;
  return {
    schema: 'dafsync-alignment-v2',
    title: $('lectureTitle').textContent,
    dafRef: state.dafRef,
    duration: Number(duration.toFixed(3)),
    videoSource: state.videoSource,
    projectId: state.currentProjectId,
    alignmentStatus: state.alignmentStatus,
    generatedAt: new Date().toISOString(),
    segments: state.segments,
    wordTimeline: state.wordTimeline
  };
}

function exportAlignment() {
  downloadJson(buildAlignmentPayload(), `${slugify(state.dafRef)}-alignment.json`);
  showToast('Synchronization JSON exported with its video source.');
}

// Pushes the current alignment straight to the results branch via
// publish-alignment.mjs -- previously only reachable through the desktop
// app's own "Sync" button, requiring an export-then-reimport round trip to
// get web-made corrections (e.g. from Mark words) actually live for other
// readers. That endpoint has no notion of the voice-recognition engine's
// separate key space (see refKey's Voice- prefix, used only by
// trigger-voice-job.mjs/voice-job.yml) -- it always writes under the
// caption-OCR keys, so publishing a voice-sourced alignment through it would
// silently mislabel/overwrite the wrong thing.
async function publishAlignment() {
  if (!state.segments.length) {
    showToast('Nothing to publish yet.', 'error');
    return;
  }
  if (state.activeSyncMethod === 'voice') {
    showToast('Publishing isn’t available for voice-recognition alignments yet -- export and use the desktop app instead.', 'error');
    return;
  }
  // A single video/sync can cover more than one daf (see refKey()'s own
  // comment) -- publish under every one its segments actually reference, the
  // same way the desktop app's publish already does, so any of them resolves
  // it.
  const refSet = new Set();
  for (const segment of state.segments) {
    const parsed = parseDafRef(segment.ref);
    if (parsed) refSet.add(`${parsed.tractate} ${parsed.daf}${parsed.amud}`);
  }
  if (!refSet.size) {
    showToast('Could not tell which daf(s) this alignment covers.', 'error');
    return;
  }
  const refs = [...refSet];
  const parsedDafRef = parseDafRef(state.dafRef);
  const variant = parsedDafRef?.variant === 'chazarah' ? 'chazarah' : 'regular';
  const language = parsedDafRef?.language === 'he' ? 'he' : 'en';
  if (!confirm(`Publish this alignment live for ${refs.join(', ')}? This replaces whatever's currently synced there for every reader.`)) return;

  const button = $('publishAlignmentButton');
  const original = button?.textContent;
  if (button) { button.disabled = true; button.textContent = 'Publishing…'; }
  try {
    const response = await fetch('/api/publish-alignment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refs, variant, language, alignment: buildAlignmentPayload() }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Server returned ${response.status}`);
    showToast(`Published live for ${refs.join(', ')}.`);
  } catch (error) {
    console.error(error);
    showToast(`Could not publish: ${error.message}`, 'error');
  } finally {
    if (button) { button.disabled = false; button.textContent = original || 'Publish live'; }
  }
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
  try {
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
  } catch (error) {
    // Confirmed directly: most callers here (loadDaf's server-alignment
    // restore, switchSyncMethod, every "apply a finished sync job" path)
    // had NO try/catch of their own around this call -- a genuine YouTube
    // API load failure (see loadYouTubeApiWithRetry) used to propagate all
    // the way up as an unhandled rejection, aborting the REST of
    // loadAlignmentData/loadDaf along with it (the daf text and segments
    // never rendered either, even though nothing about them actually
    // failed) and surfacing only the generic global error banner instead of
    // a specific, actionable message. Caught here, once, so every caller
    // gets "the video didn't load, but the rest of the daf still will" for
    // free instead of needing its own duplicate handling.
    console.error(error);
    showToast(`Could not load this daf's video (${error.message || 'unknown error'}). `
      + 'The daf text is still available below.', 'error');
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
    // caption_ocr_align.py/voice_align.py publish segment refs with a colon
    // ("Chullin 86a:2"), but normalizePageWordBoxes puts every Vilna-page/
    // scan word box's own ref through normalizeDafParagraphRef, which
    // converts that same suffix to a dot ("Chullin 86a.2") to match
    // Sefaria's own convention. Left un-normalized here, every word-box
    // ref (dot) silently never equaled any segment/wordTimeline ref (colon)
    // in the exact-string comparisons updateVilnaOverlay/updateScanOverlay/
    // seekToVilnaWord all do -- breaking word highlighting and tap-to-seek
    // for every synced daf on the Vilna page and scan photo alike (a fresh,
    // never-synced daf's segments come from Sefaria directly instead, via
    // loadDaf()'s own fallback below, already dot-formatted -- this is a
    // no-op there).
    ref: normalizeDafParagraphRef(segment.ref) || data.dafRef || 'Unknown',
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
          ref: normalizeDafParagraphRef(entry.ref),
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
  if (Number(data.duration) > 0) applyDuration(Number(data.duration), false);
  renderDaf();
  saveProjectForRef(state.dafRef, {
    segments: state.segments,
    wordTimeline: state.wordTimeline,
    alignmentStatus: state.alignmentStatus,
    duration: state.alignmentDuration || undefined,
    // Deliberately NOT data.title -- see the applyRealVideoTitle call below
    // for why that internal job title must never reach the reader; saving
    // it here would just put it back on screen on the next local restore.
    title: $('lectureTitle').textContent,
    videoSource: data.videoSource || null
  });
  if (restoreSource && data.videoSource) {
    // Scope the video-link save to just the daf(s) this recording is
    // actually about (data.primaryRefs, see publish_alignment.py) instead
    // of every ref this alignment happens to cover -- without this, the
    // fallback below (dafRefsCoveredByCurrentAlignment(), driven by
    // state.segments, which at this point holds the WHOLE published batch
    // including lead-in context) would save this same link onto the
    // previous daf's own ref too, silently overwriting its real link with
    // this recording's. That's exactly how video-links/Chullin-100b.json
    // and video-links/Chullin-103b.json ended up pointing at the NEXT
    // daf's video after a sync there -- confirmed directly against
    // published data. Falls back to the old segment-derived behavior for
    // alignments published before primaryRefs existed.
    const primaryRefs = Array.isArray(data.primaryRefs) && data.primaryRefs.length
      ? reattachVariantLanguage(data.primaryRefs, state.dafRef)
      : null;
    await restoreVideoSource(data.videoSource, primaryRefs);
  }
  // The video's heading gets the video's own real YouTube title, never
  // data.title -- that's the alignment job's internal label ("Caption OCR
  // alignment -- Chullin 102b, Chullin 103a, Chullin 103b"), useful to an
  // admin reviewing a sync and meaningless to a reader. It used to be
  // assigned here, AFTER restoreVideoSource had already put the real
  // channel title up, so it clobbered the right answer with the wrong one
  // on every load -- which is why the video heading read as OCR jargon
  // starting with the lead-in daf's number rather than the actual title.
  //
  // Passed state.dafRef (the daf the reader navigated to, fixed for this
  // load) and not the playing segment's ref, so this heading stays put:
  // only the daf card's own heading tracks where the alignment is holding
  // (see updateActiveSegment).
  applyRealVideoTitle(state.dafRef);
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
function updateSyncMethodSwitchUi(refOverride = null) {
  const wrap = $('syncMethodSwitch');
  const defaultWrap = $('syncMethodDefaultWrap');
  const defaultToggle = $('syncMethodDefaultToggle');
  const bothAvailable = Boolean(state.availableSyncMethods.ocr) && Boolean(state.availableSyncMethods.voice);
  if (wrap) wrap.hidden = !bothAvailable;
  if (defaultWrap) defaultWrap.hidden = !bothAvailable;
  if (!bothAvailable) return;
  if (wrap) {
    for (const button of wrap.querySelectorAll('button[data-method]')) {
      button.classList.toggle('active', button.dataset.method === state.activeSyncMethod);
    }
  }
  // Checked exactly when the currently-active method is ALSO the saved
  // default for this ref -- not just "is voice active", since an admin
  // previewing voice sync via the switch above without having saved it as
  // the default shouldn't make this look already set. refOverride lets
  // loadDaf()'s own initial call pass the ref it's actually loading --
  // state.dafRef there still holds the *previous* daf's ref at this point
  // (see its own comment a bit further down), so defaulting to it here
  // would check the box against the wrong daf's saved preference for one
  // render until something else happened to call this again.
  if (defaultToggle) {
    defaultToggle.checked = state.syncMethodSettings[refOverride || state.dafRef] === state.activeSyncMethod;
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
  // Explicit ref, not the state.dafRef default -- same reasoning as
  // loadDaf()'s own call: this can run before state.dafRef has caught up
  // to the ref it was just called with, depending on the caller.
  updateSyncMethodSwitchUi(ref);
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
// 'progress' (native, fires as bytes actually download) rather than relying
// on 'timeupdate' alone -- timeupdate only fires during playback, so the
// buffered fill would otherwise sit frozen at 0 while a reader has a video
// paused and loading for the first time.
htmlVideo.addEventListener('progress', updateScrubberFill);
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
$('qualitySelect')?.addEventListener('change', (event) => state.youtubePlayer?.setPlaybackQuality?.(event.target.value));
$('fullscreenButton')?.addEventListener('click', toggleVideoFullscreen);
document.addEventListener('fullscreenchange', () => updateVideoOverlay(getCurrentTime()));
$('videoVilnaCanvas')?.addEventListener('click', handleVideoOverlayClick);
$('videoVilnaCanvas')?.addEventListener('pointerdown', handleOverlayPointerDown);
$('videoVilnaCanvas')?.addEventListener('pointermove', handleOverlayPointerMove);
$('videoVilnaCanvas')?.addEventListener('pointerup', handleOverlayPointerUp);
$('videoVilnaCanvas')?.addEventListener('pointercancel', handleOverlayPointerUp);
$('videoVilnaCanvas')?.addEventListener('wheel', handleOverlayWheel, { passive: false });
// /player/ carries two copies of the overlay (Vilna-page-on-video) display
// settings -- the canonical one in normal page flow, and a compact floating
// one inside .video-frame itself, draggable, for adjusting them without
// leaving fullscreen. Each "...InVideo"-suffixed id is that same control's
// second instance, kept in sync by running the one real handler for
// whichever one the reader actually touched and mirroring its value onto
// the other. On pages without the floating copy (studio/watch), the
// InVideo lookup is just null and drops out of the group. (Playback
// controls -- scrubber, play, volume, speed, quality, fullscreen -- don't
// need this: they now live directly inside .video-frame on every page, so
// there's only ever the one copy of each.)
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
  applyVideoOverlayEnabled(event.target.checked);
  // The rest of the overlay's own display settings (style/opacity/zoom/etc)
  // live tucked away in a <details> dropdown so they don't clutter the
  // video by default -- open (and close) the canonical, always-in-page-flow
  // copy in step with the feature itself, since there's nothing to tune
  // once it's off. The floating in-video copy stays collapsed regardless
  // (reader opens it with the gear icon) -- it sits over the video itself,
  // so auto-expanding it every time the overlay turns on would be exactly
  // the kind of intrusive default it's meant to avoid.
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

// Native two-finger pinch zoom for the standalone Vilna daf.  A single
// finger remains ordinary scrolling/panning; only a genuine two-touch
// gesture is intercepted.  Keep the point between the reader's fingers in
// the same place while scaling so the page zooms toward what they are
// looking at instead of pulling toward its top-left transform origin.
let vilnaPinchGesture = null;

function vilnaTouchDistance(touches) {
  const dx = touches[1].clientX - touches[0].clientX;
  const dy = touches[1].clientY - touches[0].clientY;
  return Math.hypot(dx, dy);
}

function vilnaTouchMidpoint(touches, rect) {
  return {
    x: (touches[0].clientX + touches[1].clientX) / 2 - rect.left,
    y: (touches[0].clientY + touches[1].clientY) / 2 - rect.top,
  };
}

const vilnaScroll = $('dafScroll');
vilnaScroll?.addEventListener('touchstart', (event) => {
  if (event.touches.length !== 2 || $('vilnaPlaceholder')?.hidden) return;
  const rect = vilnaScroll.getBoundingClientRect();
  const midpoint = vilnaTouchMidpoint(event.touches, rect);
  const startZoom = state.vilnaPageZoom;
  vilnaPinchGesture = {
    distance: Math.max(1, vilnaTouchDistance(event.touches)),
    zoom: startZoom,
    contentX: (vilnaScroll.scrollLeft + midpoint.x) / startZoom,
    contentY: (vilnaScroll.scrollTop + midpoint.y) / startZoom,
  };
  event.preventDefault();
}, { passive: false });

vilnaScroll?.addEventListener('touchmove', (event) => {
  if (!vilnaPinchGesture || event.touches.length !== 2) return;
  event.preventDefault();
  const rect = vilnaScroll.getBoundingClientRect();
  const midpoint = vilnaTouchMidpoint(event.touches, rect);
  const ratio = vilnaTouchDistance(event.touches) / vilnaPinchGesture.distance;
  const nextZoom = Math.max(VILNA_ZOOM_MIN, Math.min(VILNA_ZOOM_MAX, vilnaPinchGesture.zoom * ratio));
  setVilnaPageZoom(nextZoom);
  vilnaScroll.scrollLeft = vilnaPinchGesture.contentX * nextZoom - midpoint.x;
  vilnaScroll.scrollTop = vilnaPinchGesture.contentY * nextZoom - midpoint.y;
}, { passive: false });

function finishVilnaPinch(event) {
  if (event.touches.length < 2) vilnaPinchGesture = null;
}
vilnaScroll?.addEventListener('touchend', finishVilnaPinch, { passive: true });
vilnaScroll?.addEventListener('touchcancel', finishVilnaPinch, { passive: true });
$('videoInput').addEventListener('change', (event) => handleVideoFile(event.target.files?.[0]));
$('loadVideoUrlButton').addEventListener('click', loadVideoFromUrl);
$('videoUrl').addEventListener('keydown', (event) => { if (event.key === 'Enter') loadVideoFromUrl(); });
$('loadDafButton').addEventListener('click', () => loadDaf());
$('dafRef').addEventListener('keydown', (event) => { if (event.key === 'Enter') loadDaf(); });
$('alignmentInput').addEventListener('change', (event) => importAlignment(event.target.files?.[0]));
$('transcriptInput').addEventListener('change', (event) => importTranscript(event.target.files?.[0]));
$('exportButton').addEventListener('click', exportAlignment);
$('publishAlignmentButton')?.addEventListener('click', publishAlignment);
$('evenSpacingButton').addEventListener('click', () => resetEvenSpacing(false));
// Optional chaining: this button only exists on pages with the alignment
// editor's phrase-splitting UI (player/studio) -- not watch/index.html or
// browse/index.html, which otherwise share this same top-level script.
$('phraseEditModeButton')?.addEventListener('click', togglePhraseEditMode);
$('vilnaMarkModeButton')?.addEventListener('click', toggleVilnaMarkMode);
$('vilnaUnmatchedToggleButton')?.addEventListener('click', () => {
  state.showUnmatchedWords = !state.showUnmatchedWords;
  const button = $('vilnaUnmatchedToggleButton');
  button?.classList.toggle('active', state.showUnmatchedWords);
  button?.setAttribute('aria-pressed', String(state.showUnmatchedWords));
  renderVilnaUnmatchedWords();
});
$('vilnaMarkSaveButton')?.addEventListener('click', saveVilnaMarkChanges);
$('vilnaMarkDiscardButton')?.addEventListener('click', discardVilnaMarkChanges);
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

// Auto-hides the custom control bar (scrubber + play/volume/settings row)
// after a few seconds of inactivity, rather than leaving it permanently
// docked over the bottom of the video. Shown again briefly when the video
// first cues, and after that only while the reader's pointer is actually
// over the video frame -- touch has no hover, so a tap does the same job
// there. Never hides mid-drag on the scrubber (state.seeking), while the
// speed/quality gear is open (#videoSettings), or while Reading Mode's own
// floating mini-player is being dragged/resized (#readingVideoFloat's
// is-dragging/is-resizing) -- all four mean the reader's attention is on
// the controls (or the player itself), not idly away from the video.
const CONTROLS_AUTO_HIDE_MS = 2800;
let controlsHideTimer = null;

function showVideoControls() {
  const frame = $('videoFrame');
  if (!frame) return;
  frame.classList.remove('controls-hidden');
  if (controlsHideTimer) clearTimeout(controlsHideTimer);
  controlsHideTimer = setTimeout(() => {
    const readingFloat = $('readingVideoFloat');
    if ($('videoSettings')?.open || state.seeking
        || readingFloat?.classList.contains('is-dragging')
        || readingFloat?.classList.contains('is-resizing')) return;
    frame.classList.add('controls-hidden');
  }, CONTROLS_AUTO_HIDE_MS);
}

(() => {
  const frame = $('videoFrame');
  if (!frame) return;
  frame.addEventListener('mousemove', showVideoControls);
  frame.addEventListener('mouseenter', showVideoControls);
  frame.addEventListener('touchstart', showVideoControls, { passive: true });
})();

function handleScrubInput(event) {
  state.seeking = true;
  const time = Number(event.target.value);
  scrubberEls.forEach((el) => { if (el !== event.target) el.value = event.target.value; });
  $('currentTime').textContent = formatTime(time);
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
for (const el of volumeSliderEls) el.addEventListener('input', (event) => setVolume(Number(event.target.value)));
for (const button of muteButtonEls) button.addEventListener('click', () => setMuted(!isMuted()));
for (const button of captionsButtonEls) button.addEventListener('click', () => setCaptionsEnabled(!state.captionsEnabled));
for (const button of vaaterButtonEls) button.addEventListener('click', skipToNextReading);

function switchDafView(mode) {
  // Not every page that loads app.js has all three views -- watch/index.html
  // and browse/index.html only have Text/Vilna page, no Scan -- so each
  // target element is optional here, unlike dafPage (present everywhere).
  document.querySelectorAll('.view-switch button').forEach((item) => item.classList.toggle('active', item.dataset.view === mode));
  document.querySelector('.daf-card')?.setAttribute('data-daf-view', mode);
  dafPage.hidden = mode !== 'text';
  const vilnaPlaceholder = $('vilnaPlaceholder');
  if (vilnaPlaceholder) vilnaPlaceholder.hidden = mode !== 'page';
  const scanPlaceholder = $('scanPlaceholder');
  if (scanPlaceholder) scanPlaceholder.hidden = mode !== 'scan';
  if (mode === 'page') renderVilnaPage();
  // Only reset to the fresh "open the camera" screen the first time the
  // reader lands on Scan with nothing captured yet -- once a photo's been
  // scanned (matched or still mid-align), switching away to Text/Vilna page
  // and back (see the Sefaria/scanned-photo toggle) must not throw that
  // work away.
  if (mode === 'scan') {
    if (!state.scanPhotoDataUrl) resetScanUi();
    if (scanPlaceholder) prewarmScanDetection();
  } else {
    stopScanCamera(); // don't leave the camera light on if the reader navigates away mid-frame
  }
}

for (const button of document.querySelectorAll('.view-switch button')) {
  button.addEventListener('click', () => switchDafView(button.dataset.view));
}

for (const button of document.querySelectorAll('.sync-method-switch button[data-method]')) {
  button.addEventListener('click', () => switchSyncMethod(button.dataset.method));
}

$('scanCameraOpenButton')?.addEventListener('click', openScanCamera);
$('scanCameraCancelButton')?.addEventListener('click', () => {
  stopScanCamera();
  $('scanIntro').hidden = false;
});
$('scanCameraShutterButton')?.addEventListener('click', handleScanCameraCapture);
$('scanCameraConfirmCropButton')?.addEventListener('click', handleScanCameraConfirmCrop);
$('scanCameraLibraryButton')?.addEventListener('click', () => $('scanLibraryInput').click());
$('scanCameraInput')?.addEventListener('change', (event) => handleScanFileSelected(event.target.files?.[0]));
$('scanLibraryInput')?.addEventListener('change', (event) => handleLibraryPhotoSelected(event.target.files?.[0]));
$('scanCameraPhotoWrap')?.addEventListener('pointerdown', handleScanCropPointerDown);
$('scanCameraPhotoWrap')?.addEventListener('pointermove', handleScanCropPointerMove);
$('scanCameraPhotoWrap')?.addEventListener('pointerup', handleScanCropPointerUp);
$('scanCameraPhotoWrap')?.addEventListener('pointercancel', handleScanCropPointerUp);
$('scanRetakeButton')?.addEventListener('click', resetScanUi);
$('scanAgainButton')?.addEventListener('click', resetScanUi);
$('scanConfirmButton')?.addEventListener('click', confirmScan);
for (const handle of document.querySelectorAll('.scan-corner-handle')) {
  handle.addEventListener('pointerdown', handleScanCornerPointerDown);
}
document.addEventListener('pointermove', handleScanCornerPointerMove);
document.addEventListener('pointerup', handleScanCornerPointerUp);
$('scanResultWrap')?.addEventListener('pointerdown', handleScanResultPointerDown);
$('scanResultWrap')?.addEventListener('pointermove', handleScanResultPointerMove);
$('scanResultWrap')?.addEventListener('pointerup', handleScanResultPointerUp);
$('scanResultWrap')?.addEventListener('pointercancel', handleScanResultPointerUp);
$('scanResultWrap')?.addEventListener('wheel', handleScanResultWheel, { passive: false });
$('scanResultWrap')?.addEventListener('click', suppressScanResultClickAfterDrag, { capture: true });
document.querySelectorAll('#scanShiurToggle .shiur-variant-option').forEach((button) => {
  button.addEventListener('click', () => {
    if (button.disabled) return;
    setActiveShiurVariant('scanShiurToggle', button.dataset.variant);
    switchScanVideo();
  });
});
document.querySelectorAll('#scanLanguageToggle .language-option').forEach((button) => {
  button.addEventListener('click', () => {
    if (button.disabled) return;
    setActiveLanguage('scanLanguageToggle', button.dataset.language);
    switchScanVideo();
  });
});
// Standard (tesseract) vs Google Vision -- just sets which option is
// .active; confirmScan reads it (via activeShiurVariant) at scan time, no
// immediate side effect the way the two toggles above have (switchScanVideo
// re-renders an already-scanned result; this only matters for the NEXT
// scan).
document.querySelectorAll('#scanEngineToggle .shiur-variant-option').forEach((button) => {
  button.addEventListener('click', () => {
    setActiveShiurVariant('scanEngineToggle', button.dataset.variant);
  });
});

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

// Fetches list-synced-dapim.mjs's { "<Tractate>": { "<daf><amud>":
// ["regularEn",...] } } map once and caches it on state -- shared by the
// Daf browser's own picker (loadTalmudIndex, gated to browseMode) and the
// scan feature's video-variant picker (showScanResult), which needs the
// exact same "which combos are actually synced for this daf" answer but on
// pages where browseMode is false. state.syncedDapim starts null and
// becomes {} even on failure, so that alone is the "already tried" memo --
// callers never need their own separate loaded-flag.
async function ensureSyncedDapimLoaded() {
  if (state.syncedDapim) return state.syncedDapim;
  try {
    const response = await fetch('/api/list-synced-dapim');
    state.syncedDapim = response.ok ? await response.json() : {};
  } catch {
    state.syncedDapim = {};
  }
  return state.syncedDapim;
}

// The site only has synced content for one tractate right now -- every
// tractate picker (the reader-facing daf reference picker, the admin sync
// dialog, the studio catalog grid) is locked to just this one instead of
// offering all 36 tractates in talmud_index.json, most of which have
// nothing synced and aren't even being worked on yet. Add to this list
// once a second tractate is actually ready to publish.
const SITE_ACTIVE_TRACTATES = ['Chullin'];

async function loadTalmudIndex() {
  if (!syncState.tractateNames.length) {
    const response = await fetch('/talmud_index.json');
    const data = await response.json();
    for (const t of data.tractates) syncState.talmudByName[t.name] = t;
    syncState.tractateNames = data.tractates.map((t) => t.name);
  }
  // The Daf browser only wants dapim that already have both a synced
  // alignment and page word-position data (see list-synced-dapim.mjs and
  // amudimForDaf's own check below) -- fetched here (browseMode) and lazily
  // by the scan feature's own video-variant picker (see
  // ensureSyncedDapimLoaded/showScanResult), gated so every other page's
  // picker (which is for picking *any* daf, including ones still needing a
  // sync) is unaffected.
  if (state.browseMode) await ensureSyncedDapimLoaded();
  const activeTractateNames = syncState.tractateNames.filter((name) => SITE_ACTIVE_TRACTATES.includes(name));
  const optionsHtml = activeTractateNames
    .map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
  $('syncTractateSelect').innerHTML = optionsHtml;
  $('syncTractateSelect').disabled = activeTractateNames.length <= 1;
  onSyncTractateChange();
  if ($('dafTractateSelect') && !$('dafTractateSelect').options.length) {
    // Unlike the sync dialog's own tractate picker above (which needs
    // every active tractate -- an admin syncs *unsynced* dapim from
    // there), a tractate with nothing synced yet is skipped entirely here.
    const dafPickerTractateNames = state.browseMode && state.syncedDapim
      ? activeTractateNames.filter((name) => Object.keys(state.syncedDapim[name] || {}).length)
      : activeTractateNames;
    $('dafTractateSelect').innerHTML = dafPickerTractateNames
      .map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
    $('dafTractateSelect').disabled = dafPickerTractateNames.length <= 1;
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
    // The Daf browser used to leave it at that -- a real report confirmed
    // the video panel just stayed empty here, unlike every other page that
    // embeds this same player DOM, where picking a daf always loads its
    // video too. state.syncedDapim (already loaded for this picker's own
    // enable/disable logic -- see refreshDafPickerVariantLanguage) is
    // reused to check whether the CURRENT variant/language selection
    // actually has a synced video before loading anything, rather than
    // guessing from a failed fetch; a daf with no synced recording at all
    // correctly stays page-only. Skipped when this exact ref is already
    // loaded (stepping between two amudim one recording covers, or picking
    // the daf that's already playing) so it never restarts playback the
    // reader is mid-listening to.
    const tractate = $('dafTractateSelect')?.value;
    const daf = $('dafDafSelect')?.value;
    const amud = activeAmud('dafAmudToggle');
    const combos = state.syncedDapim?.[tractate]?.[`${daf}${amud}`] || [];
    const wantsCombo = comboKeyFor(activeShiurVariant('dafShiurToggle'), activeLanguage('dafLanguageToggle'));
    if (combos.includes(wantsCombo) && state.dafRef !== ref) loadDaf(ref);
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
// trigger-ocr-job.mjs/trigger-voice-job.mjs/trigger-page-ocr-job.mjs each
// return a resultUrl pointing straight at raw.githubusercontent.com --
// rewritten here to go through get-results-file.mjs instead before this
// function polls it every 6 seconds for up to 55 minutes. Unlike a one-shot
// fetch, that volume of unauthenticated per-IP-rate-limited requests from a
// single active sync would very plausibly exhaust the rate limit on its
// own, let alone stacked with everyone else's.
const RAW_RESULTS_PREFIX = 'https://raw.githubusercontent.com/mosesar9319/MDYsync/results/';
function proxiedResultsUrl(rawUrl) {
  return rawUrl.startsWith(RAW_RESULTS_PREFIX)
    ? `/api/get-results-file?path=${encodeURIComponent(rawUrl.slice(RAW_RESULTS_PREFIX.length))}`
    : rawUrl;
}

// voice_align.py embeds a matchStats breakdown (bySource word/run counts,
// plus every run nothing could place) straight into the published
// alignment when the LLM-rescue-capable voice engine ran it -- see that
// file's _build_match_stats/main(). Rendered into the sync dialog's own
// #syncLog area (already a scrollable monospace box, used during polling
// for progress lines) rather than a toast, since a toast auto-dismisses
// before an admin could actually read a rundown this size.
function formatVoiceMatchStats(stats, elapsed) {
  const pct = stats.totalWords ? Math.round((stats.matchedWords / stats.totalWords) * 100) : 0;
  const lines = [`Done after ${elapsed}s.`];
  // passes/llmCalls only show up once refine_matches has actually run --
  // older published alignments (from before that shipped) won't have them.
  if (stats.passes) {
    lines.push(`(${stats.passes} matching pass${stats.passes === 1 ? '' : 'es'}, `
      + `${stats.llmCalls || 0} LLM call${stats.llmCalls === 1 ? '' : 's'})`);
  }
  lines.push('', `Matched ${stats.matchedWords} of ${stats.totalWords} transcribed words (${pct}%):`);
  for (const source of Object.values(stats.bySource || {})) {
    lines.push(`  • ${source.label}: ${source.words} words (${source.runs} phrase${source.runs === 1 ? '' : 's'})`);
  }
  if (stats.unmatched?.length) {
    lines.push('');
    lines.push(`Not matched — left for manual review: ${stats.unmatchedWords} words `
      + `(${stats.unmatched.length} phrase${stats.unmatched.length === 1 ? '' : 's'}):`);
    const shown = stats.unmatched.slice(0, 20);
    for (const u of shown) {
      // offeredToLlm (absent on older published alignments) distinguishes
      // "the model actually looked at this and declined" from "never got
      // a real shot" -- see voice_align.py's own offered_indices for why
      // that split exists and what it's meant to answer.
      const seenNote = u.offeredToLlm === true ? ' [seen by AI, declined]'
        : u.offeredToLlm === false ? ' [never offered to AI]' : '';
      lines.push(`  ${formatTime(u.start)}–${formatTime(u.end)}  "${u.text}"${seenNote}`);
    }
    if (stats.unmatched.length > shown.length) {
      lines.push(`  …and ${stats.unmatched.length - shown.length} more.`);
    }
  } else {
    lines.push('', 'Every transcribed phrase was matched.');
  }
  // Long runs voice_align.py judged too long to plausibly be a verbatim
  // daf-text quotation (see MAX_PLAUSIBLE_QUOTE_WORDS there) -- shown
  // separately, not mixed into the "needs correction" list above, since
  // these are the rabbi's own free explanation, not a real sync gap.
  // Absent entirely on older published alignments (from before this
  // existed), same as passes/llmCalls above.
  if (stats.excluded?.length) {
    lines.push('', `Excluded as likely free explanation, not daf text: ${stats.excludedWords} words `
      + `(${stats.excluded.length} phrase${stats.excluded.length === 1 ? '' : 's'}).`);
  }
  return lines;
}

function pollServerSyncResult(jobId, resultUrl, successMessage, dafRefOverride, method = 'ocr') {
  resultUrl = proxiedResultsUrl(resultUrl);
  const startedAt = Date.now();
  const MAX_WAIT_SECONDS = 55 * 60; // GitHub Actions job has its own 60-min cap
  // A single fetch() to the results proxy can fail at the network level (a
  // real "Failed to fetch" TypeError, not an HTTP error status) on any one
  // poll -- a Wi-Fi blip, a background-tab throttle, whatever -- with zero
  // relation to whether the server-side job itself is fine. It usually is:
  // the GitHub Actions job runs independently of this browser tab entirely.
  // Giving up on the very first such hiccup used to end the poll (and tell
  // the reader sync "failed") while the job kept right on running server-
  // side regardless -- so tolerate a short run of consecutive failures
  // before actually giving up.
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
      const response = await fetch(resultUrl);
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
      // A voice-recognition job's rundown (see formatVoiceMatchStats) is
      // worth actually reading, so it stays in #syncLog and the dialog is
      // left open (the admin dismisses it themselves via the existing ×
      // button) instead of auto-closing the instant the job's done.
      const matchStats = method === 'voice' ? alignment?.matchStats : null;
      setSyncProgress(1, matchStats ? formatVoiceMatchStats(matchStats, elapsed) : [`Done after ${elapsed}s.`]);
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
      if (!matchStats) {
        $('syncDialog').close();
      }
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
  // Proxied through get-results-file.mjs -- see fetchServerAlignment above.
  fetch('/api/get-results-file?path=settings.json')
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

// Persists (or clears) an admin override of which sync method readers see
// by default for the daf on screen -- see loadDaf()'s dual-fetch and
// updateSyncMethodSwitchUi() for how this is read back. Always saves the
// CURRENTLY ACTIVE method (whatever the Caption sync/Voice sync toggle is
// on right now), so an admin previews with that toggle first, then checks
// this once satisfied, rather than the two controls needing to agree on
// which method to save independently.
$('syncMethodDefaultToggle')?.addEventListener('change', async (event) => {
  const checked = event.target.checked;
  const ref = state.dafRef;
  const method = checked ? state.activeSyncMethod : null;
  try {
    const response = await fetch('/api/save-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preferredSyncMethodRef: ref, preferredSyncMethod: method }),
      keepalive: true,
    });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Could not save the setting.');
    if (method === null) delete state.syncMethodSettings[ref];
    else state.syncMethodSettings[ref] = method;
    showToast(checked
      ? `Readers will now default to the ${method === 'voice' ? 'voice-recognition' : 'caption-OCR'} sync for this daf.`
      : 'Reverted to the automatic default (caption-OCR sync, when available).');
  } catch (error) {
    event.target.checked = !checked;
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
// A catalog link (?ref=Chullin+86a&variant=chazarah&language=hebrew) should
// land straight on that daf instead of the built-in demo -- but the picker
// it feeds (syncDafPickerFromRef) needs the tractate index loaded first, so
// this waits on the same loadTalmudIndex() call the picker itself depends on.
loadTalmudIndex().then(() => {
  const params = new URLSearchParams(location.search);
  // The player is a video + printed-daf experience. Start in the Vilna
  // view before loading the requested lesson so renderDaf() can fetch and
  // paint the page immediately, without briefly showing the old text view.
  // Daf Scan remains reachable from its dedicated navigation entry, but it
  // is no longer offered as a mode switch inside the regular player.
  if (!state.browseMode && params.get('view') !== 'scan') switchDafView('page');
  // ?view=scan (from the shared nav's "Daf Scan" tab) jumps straight to
  // the Scan view -- independent of whether a ref was also given, since the
  // scan flow resolves its own daf once a photo is scanned. Tapping a
  // recognized word then loads/seeks the video right here on the normal
  // player-page layout (see tapScannedWord), the same as any other daf.
  if (params.get('view') === 'scan') {
    switchDafView('scan');
    // Arriving here fresh (no ref already given to load) has no video to
    // show yet -- keep the player panel hidden, full-width scan card only,
    // until a photo is actually scanned and matched (see showScanResult),
    // rather than showing an empty player next to it from the first paint.
    if (!params.get('ref')) document.body.classList.add('scan-pending');
  }
  const ref = params.get('ref');
  // The Daf browser (browse/index.html) has no video to load -- land on
  // whatever ref the query string names, or default to today's Daf Yomi
  // (falling back to the picker's own first-option default if that lookup
  // fails) so the page never opens to a blank/arbitrary state.
  if (state.browseMode) {
    if (ref) {
      syncDafPickerFromRef(ref);
      switchDafView('page'); // the whole point of this page is the page image, not plain text
      onDafPickerChanged();
    } else {
      switchDafView('page');
      fetchTodaysDafRef().then((todaysRef) => {
        if (todaysRef) syncDafPickerFromRef(todaysRef);
        onDafPickerChanged();
      });
    }
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
