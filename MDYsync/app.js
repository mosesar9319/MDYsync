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
  vilnaZoomRerenderTimer: null
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
function refKey(ref) {
  // GitHub's raw file serving is case-sensitive, and the server side
  // (trigger-ocr-job.mjs, the sync dialog's picker-built ref list) always
  // publishes under the canonical tractate capitalization, so the lookup
  // has to normalize to that same canonical form -- not just whatever
  // case the reader happened to type ("chullin 86a" must resolve to the
  // same key as "Chullin 86a").
  const parsed = parseDafRef(ref);
  if (!parsed) return String(ref || '').trim().replace(/\s+/g, '-');
  const languagePrefix = parsed.language === 'he' ? HEBREW_KEY_PREFIX : '';
  const variantPrefix = parsed.variant === 'chazarah' ? CHAZARAH_KEY_PREFIX : '';
  return `${languagePrefix}${variantPrefix}${parsed.tractate.replace(/\s+/g, '-')}-${parsed.daf}${parsed.amud}`;
}

async function fetchServerAlignment(ref) {
  try {
    const url = `https://raw.githubusercontent.com/mosesar9319/MDYsync/results/by-ref/${refKey(ref)}.json?t=${Date.now()}`;
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

async function resolvePreferredVideoSource(ref, localSaved) {
  if (localSaved?.videoSource && ['youtube', 'direct'].includes(localSaved.videoSource.type)) {
    return localSaved.videoSource;
  }
  return fetchServerVideoLink(ref);
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
  const body = state.wordTimeline.length
    ? segment.he.trim().split(/\s+/).map((word, w) => `<span class="daf-word" data-w="${w}">${escapeHtml(word)}</span>`).join(' ')
    : escapeHtml(segment.he);
  span.innerHTML = `<sup class="segment-marker">${index + 1}</sup>${body} `;
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
  const activeRef = state.segments[state.activeIndex]?.ref || state.dafRef;
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
  if (!canvas || !view || view.hidden) return;

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
    el.addEventListener('click', () => seekToVilnaWord(box.ref, box.wordIndex));
    overlay.appendChild(el);
    state.vilnaWordEls.set(`${box.ref}:${box.wordIndex}`, el);
  }
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
  const segment = state.segments.find((s) => s.ref === ref);
  if (!segment) return;
  state.lastManualScrollAt = 0;
  seek(segment.start + 0.03, true);
  updateActiveSegment(true);
}

function updateVilnaOverlay(time) {
  if (!state.vilnaWordEls) return;
  if (!state.vilnaPageMap || $('vilnaPlaceholder').hidden || !state.wordTimeline.length) {
    if (state.vilnaOverlayKey) {
      for (const el of state.vilnaWordEls.values()) el.classList.remove('active');
      state.vilnaOverlayKey = '';
    }
    return;
  }
  const active = state.wordTimeline.filter((entry) => time >= entry.start && time < entry.end);
  const activeKeys = new Set();
  for (const entry of active) {
    for (let idx = entry.w0; idx <= entry.w1; idx++) {
      const k = `${entry.ref}:${idx}`;
      if (state.vilnaWordEls.has(k)) activeKeys.add(k);
    }
  }

  // The YouTube poll re-runs this every 100ms; without this check the
  // active class was being toggled on every single tick even when the
  // highlighted words hadn't changed, restarting each box's CSS entrance
  // animation from opacity:0 before it ever finished fading in -- a
  // constant flicker that also read as much dimmer than the steady color
  // it's supposed to settle into.
  const key = [...activeKeys].sort().join(',');
  if (key === state.vilnaOverlayKey) return;
  state.vilnaOverlayKey = key;

  for (const [k, el] of state.vilnaWordEls) {
    el.classList.toggle('active', activeKeys.has(k));
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

// Experimental: draws a cropped/zoomed slice of the already-rendered Vilna
// page canvas as a semi-transparent layer over the video itself, panning to
// keep the currently-spoken line in view. Reuses the main canvas as a
// drawImage source rather than re-rendering the page separately.
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

  const active = state.wordTimeline.filter((entry) => time >= entry.start && time < entry.end);
  const isIdle = active.length === 0;
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

  const activeBoxes = [];
  for (const entry of active) {
    for (let idx = entry.w0; idx <= entry.w1; idx++) {
      const box = state.vilnaPageMap.wordBoxes.find((b) => b.ref === entry.ref && b.wordIndex === idx);
      if (box) activeBoxes.push(box);
    }
  }
  const activeY = activeBoxes.length
    ? activeBoxes.reduce((sum, b) => sum + b.y + b.h / 2, 0) / activeBoxes.length
    : 0.15;

  const pageW = mainCanvas.width;
  const pageH = mainCanvas.height;
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
  ctx.drawImage(mainCanvas, sx, sourceY, sw, visibleSourceH, 0, 0, canvas.width, canvas.height);
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

function updateActiveWords(time) {
  updateVilnaOverlay(time);
  updateVideoOverlay(time);
  if (!state.wordTimeline.length) return;
  const active = state.wordTimeline.filter((entry) => time >= entry.start && time < entry.end);
  document.querySelectorAll('.daf-segment').forEach((node) => {
    const ref = state.segments[Number(node.dataset.index)]?.ref;
    const spans = node.querySelectorAll('.daf-word');
    const ranges = active.filter((entry) => entry.ref === ref);
    spans.forEach((wordNode, w) => {
      const hit = ranges.some((entry) => w >= entry.w0 && w <= entry.w1);
      wordNode.classList.toggle('word-active', hit);
    });
  });
}

function updateActiveSegment(force = false, timeOverride = null) {
  const time = timeOverride ?? getCurrentTime();
  const index = findSegmentAt(time);
  if (!force && index === state.activeIndex) {
    updateActiveWords(time);
    return;
  }
  state.activeIndex = index;
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
let seekGeneration = 0;
function seekYouTubePlayer(time, allowSeekAhead, attempt = 0, generation = ++seekGeneration) {
  const player = state.youtubePlayer;
  if (!player?.seekTo) return;
  player.seekTo(time, allowSeekAhead);
  if (attempt >= 4) return;
  setTimeout(() => {
    if (generation !== seekGeneration) return; // superseded by a newer seek request
    if (state.playerType !== 'youtube' || state.youtubePlayer !== player) return; // moved on since
    const actual = Number(player.getCurrentTime?.()) || 0;
    if (Math.abs(actual - time) > 2) seekYouTubePlayer(time, allowSeekAhead, attempt + 1, generation);
  }, 400);
}

function seek(time, allowSeekAhead = true) {
  const max = getDuration() || Number(scrubber.max) || 0;
  const clamped = Math.max(0, Math.min(time, max || time));

  if (state.playerType === 'youtube') {
    if (state.youtubeReady) seekYouTubePlayer(clamped, allowSeekAhead);
  } else {
    htmlVideo.currentTime = clamped;
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

function renderEditor() {
  editorBody.innerHTML = '';
  state.segments.forEach((segment, index) => {
    const row = document.createElement('tr');
    row.className = `editor-row${index === state.activeIndex ? ' active' : ''}${index === state.editingIndex ? ' mark-target-row' : ''}`;
    row.innerHTML = `
      <td>${index + 1}</td>
      <td><input type="number" min="0" step="0.1" value="${segment.start.toFixed(1)}" data-field="start" data-index="${index}" aria-label="Segment ${index + 1} start time"></td>
      <td><input type="number" min="0" step="0.1" value="${segment.end.toFixed(1)}" data-field="end" data-index="${index}" aria-label="Segment ${index + 1} end time"></td>
      <td class="editor-phrase">${escapeHtml(segment.he)}</td>
      <td><button class="button secondary small use-time" data-index="${index}">Use current time</button></td>`;
    row.addEventListener('click', (event) => {
      if (event.target.closest('input, button')) return;
      selectEditingIndex(index);
    });
    editorBody.appendChild(row);
  });

  editorBody.querySelectorAll('input[data-field]').forEach((input) => {
    input.addEventListener('change', (event) => {
      const target = event.currentTarget;
      const index = Number(target.dataset.index);
      const field = target.dataset.field;
      const value = Math.max(0, Number(target.value) || 0);
      state.segments[index][field] = value;
      normalizeSegmentOrder(index, field);
      state.usingDefaultAlignment = false;
      state.alignmentStatus = 'in-progress';
      updateAlignmentStatus();
      renderDaf();
      saveDraft(true);
    });
  });

  editorBody.querySelectorAll('.use-time').forEach((button) => {
    button.addEventListener('click', (event) => {
      const index = Number(event.currentTarget.dataset.index);
      const time = Number(getCurrentTime().toFixed(2));
      state.segments[index].start = time;
      if (index > 0) state.segments[index - 1].end = time;
      if (state.segments[index].end <= time) {
        const nextStart = state.segments[index + 1]?.start;
        state.segments[index].end = nextStart && nextStart > time ? nextStart : time + 3;
      }
      state.usingDefaultAlignment = false;
      state.editingIndex = Math.min(index + 1, state.segments.length - 1);
      state.alignmentStatus = index === state.segments.length - 1 ? 'complete' : 'in-progress';
      updateAlignmentStatus();
      renderDaf();
      saveDraft(true);
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
  const serverAlignment = await fetchServerAlignment(ref);
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

    state.dafRef = ref;
    state.wordTimeline = [];
    const duration = getDuration() || Number(scrubber.max) || 48;
    const length = duration / he.length;
    state.segments = he.map((text, index) => ({
      id: `${ref.replace(/\W+/g, '-').toLowerCase()}-${index + 1}`,
      ref: data.sectionRef ? `${data.sectionRef}.${index + 1}` : `${ref}.${index + 1}`,
      start: Number((index * length).toFixed(2)),
      end: Number(((index + 1) * length).toFixed(2)),
      he: text,
      en: en[index] || ''
    }));
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
    $('dafTitle').textContent = data.heRef || ref;
    renderDaf();
    seek(0);
    if (!options.silent) showToast(`Loaded ${he.length} text segments from Sefaria.`);
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

async function loadYouTubeVideo(url, videoId = extractYouTubeId(url), saveRefs = null, label = null) {
  if (!validateYouTubeId(videoId)) throw new Error('A valid YouTube video link is required.');
  cleanupObjectUrl();
  await ensureYouTubePlayer(videoId);
  state.videoSource = {
    type: 'youtube',
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    label: label || 'YouTube'
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

function loadDirectVideoUrl(url, saveRefs = null) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Enter a complete video URL beginning with https:// or http://.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only http and https video links are supported.');

  cleanupObjectUrl();
  switchPlayerType('html5');
  state.videoSource = { type: 'direct', url: parsed.href, label: 'Direct link' };
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
    const youtubeId = extractYouTubeId(input);
    if (youtubeId) await loadYouTubeVideo(input, youtubeId);
    else loadDirectVideoUrl(input);
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
    await loadYouTubeVideo(source.url || source.videoId, source.videoId, saveRefs, realLabel);
  } else if (source.type === 'direct' && source.url) {
    $('videoUrl').value = source.url;
    loadDirectVideoUrl(source.url, saveRefs);
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
async function loadAlignmentData(data, { restoreSource = true, dafRefOverride = null } = {}) {
  if (!Array.isArray(data.segments) || !data.segments.length) throw new Error('No segments found.');
  state.segments = data.segments.map((segment, index) => ({
    id: segment.id || `segment-${index + 1}`,
    ref: segment.ref || data.dafRef || 'Unknown',
    start: Number(segment.start) || 0,
    end: Number(segment.end) || (Number(segment.start) || 0) + 1,
    he: String(segment.he || segment.text || ''),
    en: String(segment.en || segment.translation || '')
  })).sort((a, b) => a.start - b.start);
  state.wordTimeline = Array.isArray(data.wordTimeline)
    ? data.wordTimeline
        .filter((entry) => entry && entry.ref != null && Number.isFinite(Number(entry.start)))
        .map((entry) => ({
          start: Number(entry.start),
          end: Number(entry.end) || Number(entry.start),
          ref: String(entry.ref),
          w0: Number(entry.w0) || 0,
          w1: Number(entry.w1) || 0
        }))
    : [];
  state.alignmentDuration = Number(data.duration) || 0;
  state.dafRef = dafRefOverride || data.dafRef || state.dafRef;
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
  seek(0);
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
$('saveDraftButton')?.addEventListener('click', () => saveDraft(false));

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
const overlaySettingsEls = overlayControlGroup('overlaySettings');

for (const el of overlayToggleEls) el.addEventListener('change', (event) => {
  syncGroupValue(overlayToggleEls, event, 'checked');
  state.videoOverlayEnabled = event.target.checked;
  $('videoFrame')?.classList.toggle('overlay-on', state.videoOverlayEnabled);
  updateVideoOverlay(getCurrentTime());
  // The rest of the overlay's own display settings (style/opacity/zoom/etc)
  // live tucked away in a <details> dropdown so they don't clutter the
  // video by default -- open (and close) both copies of it in step with
  // the feature itself, since there's nothing to tune once it's off.
  for (const settings of overlaySettingsEls) settings.open = state.videoOverlayEnabled;
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
$('editModeButton').addEventListener('click', () => { editor.hidden = false; editor.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
$('closeEditorButton').addEventListener('click', () => { editor.hidden = true; document.querySelector('.workspace').scrollIntoView({ behavior: 'smooth', block: 'start' }); });

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

for (const button of document.querySelectorAll('.view-switch button')) {
  button.addEventListener('click', () => {
    document.querySelectorAll('.view-switch button').forEach((item) => item.classList.toggle('active', item === button));
    const pageView = button.dataset.view === 'page';
    dafPage.hidden = pageView;
    $('vilnaPlaceholder').hidden = !pageView;
    if (pageView) renderVilnaPage();
  });
}

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

async function loadTalmudIndex() {
  if (!syncState.tractateNames.length) {
    const response = await fetch('/talmud_index.json');
    const data = await response.json();
    for (const t of data.tractates) syncState.talmudByName[t.name] = t;
    syncState.tractateNames = data.tractates.map((t) => t.name);
  }
  const optionsHtml = syncState.tractateNames
    .map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
  $('syncTractateSelect').innerHTML = optionsHtml;
  onSyncTractateChange();
  if ($('dafTractateSelect') && !$('dafTractateSelect').options.length) {
    $('dafTractateSelect').innerHTML = optionsHtml;
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
  const options = dafOptionsFor(entry);
  $('dafDafSelect').innerHTML = options.map((d) => `<option value="${d}">${d}</option>`).join('');
  refreshDafPickerAmud();
}

function refreshDafPickerAmud() {
  const entry = syncState.talmudByName[$('dafTractateSelect').value];
  const daf = Number($('dafDafSelect').value);
  const sides = daf ? (amudimForDaf(entry, daf).length ? amudimForDaf(entry, daf) : ['a']) : ['a'];
  populateAmudToggle('dafAmudToggle', sides);
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
  loadDaf(ref);
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
function pollServerSyncResult(jobId, resultUrl, successMessage, dafRefOverride) {
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
    onDafPickerChanged();
  });
});
document.querySelectorAll('#dafShiurToggle .shiur-variant-option').forEach((button) => {
  button.addEventListener('click', () => {
    setActiveShiurVariant('dafShiurToggle', button.dataset.variant);
    onDafPickerChanged();
  });
});
document.querySelectorAll('#dafLanguageToggle .language-option').forEach((button) => {
  button.addEventListener('click', () => {
    setActiveLanguage('dafLanguageToggle', button.dataset.language);
    onDafPickerChanged();
  });
});
// A catalog link (?ref=Chullin+86a&variant=chazarah&language=hebrew) should
// land straight on that daf instead of the built-in demo -- but the picker
// it feeds (syncDafPickerFromRef) needs the tractate index loaded first, so
// this waits on the same loadTalmudIndex() call the picker itself depends on.
loadTalmudIndex().then(() => {
  const params = new URLSearchParams(location.search);
  const ref = params.get('ref');
  if (!ref) return;
  const wantsChazarah = params.get('variant') === 'chazarah';
  const wantsHebrew = params.get('language') === 'hebrew' || params.get('language') === 'he';
  let fullRef = ref;
  if (wantsChazarah && !/chazarah/i.test(fullRef)) fullRef += ' (Chazarah Daf)';
  if (wantsHebrew && !/hebrew/i.test(fullRef)) fullRef += ' (Hebrew)';
  loadDaf(fullRef);
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
  });
});
