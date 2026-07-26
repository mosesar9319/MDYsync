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
  vilnaPagePollTimer: null
};

const AUTO_SCROLL_RESUME_MS = 4000;

const $ = (id) => document.getElementById(id);
const htmlVideo = $('video');
const youtubeHost = $('youtubePlayerHost');
const scrubber = $('scrubber');
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

function parseDafRef(ref) {
  // Accepts both a bare daf ref ("Chullin 86a") and a segment ref
  // ("Chullin 86a:3", as found on state.segments[i].ref) by ignoring an
  // optional trailing ":<segment number>".
  const match = /^(.+?)\s+(\d+)\s*([abAB])(?::\d+)?$/.exec(String(ref || '').trim());
  if (!match) return null;
  return { tractate: match[1].trim(), daf: Number(match[2]), amud: match[3].toLowerCase() };
}

function setVilnaPageStatus(message) {
  const status = $('vilnaPageStatus');
  const text = $('vilnaPageStatusText');
  if (text) text.textContent = message;
  if (status) status.hidden = false;
  $('vilnaPageCanvas').hidden = true;
}

async function renderVilnaPage() {
  const canvas = $('vilnaPageCanvas');
  const view = $('vilnaPlaceholder');
  if (!canvas || !view || view.hidden) return;

  // Follow the daf the video is actually on, not just whichever ref the
  // player started with -- a synced video can span more than one daf
  // (e.g. finishing 86a partway through and continuing into 86b), and
  // the Vilna page should turn with it.
  const activeRef = state.segments[state.activeIndex]?.ref || state.dafRef;
  const parsed = parseDafRef(activeRef);
  if (!parsed) {
    state.vilnaPageKey = null;
    setVilnaPageStatus('Load a daf reference to see the Vilna page image.');
    return;
  }
  const key = `${parsed.tractate}|${parsed.daf}|${parsed.amud}`;
  if (state.vilnaPageKey === key) return;

  setVilnaPageStatus(`Loading the Vilna page for ${parsed.tractate} ${parsed.daf}${parsed.amud}…`);
  try {
    const [lib, response] = await Promise.all([
      loadPdfJs(),
      fetch(`/api/daf-page?tractate=${encodeURIComponent(parsed.tractate)}&daf=${parsed.daf}&amud=${parsed.amud}`)
    ]);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `Page image request failed (${response.status}).`);
    }
    const bytes = await response.arrayBuffer();
    const pdf = await lib.getDocument({ data: bytes }).promise;
    const page = await pdf.getPage(1);

    const containerWidth = view.clientWidth || 640;
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = (containerWidth / baseViewport.width) * (window.devicePixelRatio || 1);
    const viewport = page.getViewport({ scale });

    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.style.width = `${containerWidth}px`;
    canvas.style.height = `${(containerWidth * viewport.height) / viewport.width}px`;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

    state.vilnaPageKey = key;
    $('vilnaPageStatus').hidden = true;
    canvas.hidden = false;
    loadVilnaPageMap(parsed);
  } catch (error) {
    state.vilnaPageKey = null;
    setVilnaPageStatus(`Couldn't load the Vilna page for ${parsed.tractate} ${parsed.daf}${parsed.amud}: ${error.message}`);
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
async function loadVilnaPageMap(parsed) {
  stopVilnaPagePoll();
  state.vilnaPageMap = null;
  $('vilnaPageOverlay').innerHTML = '';
  const key = pageMapKey(parsed);
  const resultUrl = `https://raw.githubusercontent.com/mosesar9319/MDYsync/results/pages/${key}.json`;

  const tryFetch = async () => {
    try {
      const response = await fetch(`${resultUrl}?t=${Date.now()}`);
      if (!response.ok) return false;
      state.vilnaPageMap = await response.json();
      updateVilnaOverlay(getCurrentTime());
      return true;
    } catch {
      return false;
    }
  };

  if (await tryFetch()) return;

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

function updateVilnaOverlay(time) {
  const overlay = $('vilnaPageOverlay');
  if (!overlay) return;
  if (!state.vilnaPageMap || $('vilnaPlaceholder').hidden || !state.wordTimeline.length) {
    overlay.innerHTML = '';
    return;
  }
  const active = state.wordTimeline.filter((entry) => time >= entry.start && time < entry.end);
  if (!active.length) {
    overlay.innerHTML = '';
    return;
  }
  const boxes = state.vilnaPageMap.wordBoxes.filter((box) =>
    active.some((entry) => entry.ref === box.ref && box.wordIndex >= entry.w0 && box.wordIndex <= entry.w1)
  );
  overlay.innerHTML = '';
  for (const box of boxes) {
    const el = document.createElement('div');
    el.className = 'vilna-word-highlight';
    el.style.left = `${box.x * 100}%`;
    el.style.top = `${box.y * 100}%`;
    el.style.width = `${box.w * 100}%`;
    el.style.height = `${box.h * 100}%`;
    overlay.appendChild(el);
  }
}

function updateActiveWords(time) {
  updateVilnaOverlay(time);
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
  scrubber.max = String(duration);
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
  if (duration > 0 && Number(scrubber.max) !== duration) scrubber.max = String(duration);
  if (!state.seeking) scrubber.value = String(Math.min(current, duration || current));
  $('currentTime').textContent = formatTime(current);
  $('duration').textContent = formatTime(duration);
  updateScrubberFill();
  updateActiveSegment();
}

function updateScrubberFill() {
  const max = Number(scrubber.max) || 1;
  const value = Number(scrubber.value) || 0;
  const percent = Math.min(100, Math.max(0, value / max * 100));
  scrubber.style.background = `linear-gradient(to right, var(--accent) 0%, var(--accent) ${percent}%, rgba(255,255,255,.14) ${percent}%, rgba(255,255,255,.14) 100%)`;
}

function updatePlayUi() {
  const paused = isPaused();
  document.querySelector('.play-icon').hidden = !paused;
  document.querySelector('.pause-icon').hidden = paused;
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

function seek(time, allowSeekAhead = true) {
  const max = getDuration() || Number(scrubber.max) || 0;
  const clamped = Math.max(0, Math.min(time, max || time));

  if (state.playerType === 'youtube') {
    if (state.youtubeReady) state.youtubePlayer.seekTo(clamped, allowSeekAhead);
  } else {
    htmlVideo.currentTime = clamped;
  }

  scrubber.value = String(clamped);
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
  const ref = String(refOverride || $('dafRef').value).trim();
  $('dafRef').value = ref;
  if (!ref) return showToast('Enter a Sefaria reference first.', 'error');
  const button = $('loadDafButton');
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Loading…';
  try {
    let response;
    try {
      response = await fetch(`/api/sefaria?ref=${encodeURIComponent(ref)}`);
      if (!response.ok) throw new Error('Proxy unavailable');
    } catch {
      response = await fetch(`https://www.sefaria.org/api/v3/texts/${encodeURIComponent(ref)}?version=source&version=translation&return_format=text_only`);
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
    state.usingDefaultAlignment = Boolean(options.placeholderAlignment);
    state.alignmentStatus = options.placeholderAlignment ? 'placeholder' : 'in-progress';
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
        enablejsapi: 1
      };
      if (location.protocol === 'http:' || location.protocol === 'https:') playerVars.origin = location.origin;

      state.youtubePlayer = new window.YT.Player('youtubePlayer', {
        width: '100%',
        height: '100%',
        videoId,
        playerVars,
        events: {
          onReady: (event) => {
            state.youtubeReady = true;
            state.youtubeState = event.target.getPlayerState();
            startYouTubePoll();
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

async function loadYouTubeVideo(url, videoId = extractYouTubeId(url)) {
  if (!validateYouTubeId(videoId)) throw new Error('A valid YouTube video link is required.');
  cleanupObjectUrl();
  await ensureYouTubePlayer(videoId);
  state.videoSource = {
    type: 'youtube',
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    label: 'YouTube'
  };
  state.currentProjectId = null;
  $('videoUrl').value = state.videoSource.url;
  $('lectureTitle').textContent = `YouTube lecture · ${videoId}`;
  setSourceBadge('YouTube');
  setSourcePanel('linkSourcePanel');
  seek(0);
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

function loadDirectVideoUrl(url) {
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

async function restoreVideoSource(source) {
  if (!source || !source.type) return;
  if (source.type === 'youtube' && source.videoId) {
    await loadYouTubeVideo(source.url || source.videoId, source.videoId);
  } else if (source.type === 'direct' && source.url) {
    $('videoUrl').value = source.url;
    loadDirectVideoUrl(source.url);
  } else if (source.type === 'local') {
    setSourcePanel('fileSourcePanel');
    showToast(`Choose the exact video file that was analyzed: ${source.fileName || source.url || 'lecture video'}.`);
  }
}

async function loadAlignmentData(data, { restoreSource = true } = {}) {
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
  state.dafRef = data.dafRef || state.dafRef;
  state.currentProjectId = data.projectId || null;
  state.alignmentStatus = data.alignmentStatus || 'in-progress';
  state.editingIndex = Math.min(Number(data.editingIndex) || 0, state.segments.length - 1);
  state.usingDefaultAlignment = false;
  updateAlignmentStatus();
  $('dafRef').value = state.dafRef;
  $('dafTitle').textContent = state.dafRef;
  $('lectureTitle').textContent = data.title || $('lectureTitle').textContent;
  if (Number(data.duration) > 0) applyDuration(Number(data.duration), false);
  renderDaf();
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

htmlVideo.addEventListener('loadedmetadata', () => applyDuration(htmlVideo.duration));
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

scrubber.addEventListener('input', (event) => {
  state.seeking = true;
  const time = Number(event.target.value);
  $('currentTime').textContent = formatTime(time);
  updateScrubberFill();
  updateActiveSegment(true, time);
  if (state.playerType === 'youtube') {
    if (state.youtubeReady) state.youtubePlayer.seekTo(time, false);
  } else {
    htmlVideo.currentTime = time;
  }
});
scrubber.addEventListener('change', (event) => {
  const time = Number(event.target.value);
  if (state.playerType === 'youtube' && state.youtubeReady) state.youtubePlayer.seekTo(time, true);
  state.seeking = false;
  updateTimeline();
});
scrubber.addEventListener('pointermove', handleScrubPointer);
scrubber.addEventListener('pointerenter', handleScrubPointer);
scrubber.addEventListener('pointerleave', () => { $('scrubPreview').hidden = true; });

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
  if (syncState.tractateNames.length) return;
  const response = await fetch('talmud_index.json');
  const data = await response.json();
  for (const t of data.tractates) syncState.talmudByName[t.name] = t;
  syncState.tractateNames = data.tractates.map((t) => t.name);
  const select = $('syncTractateSelect');
  select.innerHTML = syncState.tractateNames
    .map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
  onSyncTractateChange();
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
  const buttons = document.querySelectorAll('#syncAmudToggle .amud-option');
  buttons.forEach((button) => {
    const available = sides.includes(button.dataset.side);
    button.disabled = !available;
    button.classList.toggle('active', available && button.classList.contains('active'));
  });
  if (![...buttons].some((button) => button.classList.contains('active') && !button.disabled)) {
    buttons.forEach((button) => button.classList.toggle('active', button.dataset.side === sides[0]));
  }
}

function currentSyncAmud() {
  const active = document.querySelector('#syncAmudToggle .amud-option.active');
  return active ? active.dataset.side : 'a';
}

function addSyncReading() {
  const tractate = $('syncTractateSelect').value;
  const daf = $('syncDafSelect').value;
  if (!tractate || !daf) return;
  const ref = `${tractate} ${daf}${currentSyncAmud()}`;
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

  const formData = new FormData();
  formData.append('video', syncState.localVideoFile, syncState.localVideoFile.name);
  formData.append('refs', JSON.stringify(syncState.readings.map((r) => r.ref)));

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
        await loadAlignmentData(job.result.alignment, { restoreSource: false });
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

  setSyncProgress(0, ['Starting the server-side job…']);
  let jobId, resultUrl;
  try {
    const response = await fetch(TRIGGER_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ driveUrl, refs: syncState.readings.map((r) => r.ref) })
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Could not start the job.');
    ({ jobId, resultUrl } = await response.json());
  } catch (error) {
    showToast(`Could not start server sync: ${error.message}`, 'error');
    return;
  }

  const startedAt = Date.now();
  const MAX_WAIT_SECONDS = 20 * 60; // GitHub Actions job has its own 30-min cap
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
        setSyncProgress(Math.min(0.9, elapsed / 300), [`Processing on the server… (${elapsed}s elapsed)`]);
        return;
      }
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      const alignment = await response.json();
      stopSyncPolling();
      setSyncProgress(1, [`Done after ${elapsed}s.`]);
      // loadAlignmentData already surfaces a specific "load this exact file" toast
      // (via restoreVideoSource) for the local-video case; don't clobber it with a
      // generic one — that specific guidance is what actually prevents mis-synced
      // playback from a mismatched video.
      const hadSpecificSource = alignment?.videoSource?.type === 'local';
      await loadAlignmentData(alignment);
      if (!hadSpecificSource) {
        showToast('Synced from Google Drive! Choose or paste the video to watch it.');
      }
      $('syncDialog').close();
    } catch (error) {
      stopSyncPolling();
      setSyncProgress(Math.min(0.9, elapsed / 300), [
        `Failed after ${elapsed}s: ${error.message}`,
        'Check that the Drive link is shared as "Anyone with the link," then try again.'
      ]);
      showToast(`Server sync failed: ${error.message}`, 'error');
    }
  }, 6000);
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
document.querySelectorAll('#syncAmudToggle .amud-option').forEach((button) => {
  button.addEventListener('click', () => {
    if (button.disabled) return;
    document.querySelectorAll('#syncAmudToggle .amud-option').forEach((b) => b.classList.remove('active'));
    button.classList.add('active');
  });
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
