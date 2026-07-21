'use strict';

const DEFAULT_SEGMENTS = [
  { id: 'b2a-1', ref: 'Berakhot 2a.1', start: 0, end: 7.7, he: 'מאימתי קורין את שמע בערבין', en: 'From when may one recite the Shema in the evening?' },
  { id: 'b2a-2', ref: 'Berakhot 2a.1', start: 7.7, end: 15.5, he: 'משעה שהכהנים נכנסים לאכול בתרומתן', en: 'From the time the priests enter to eat their teruma.' },
  { id: 'b2a-3', ref: 'Berakhot 2a.1', start: 15.5, end: 23.4, he: 'עד סוף האשמורה הראשונה', en: 'Until the end of the first watch.' },
  { id: 'b2a-4', ref: 'Berakhot 2a.1', start: 23.4, end: 31.4, he: 'דברי רבי אליעזר', en: 'These are the words of Rabbi Eliezer.' },
  { id: 'b2a-5', ref: 'Berakhot 2a.1', start: 31.4, end: 39.5, he: 'וחכמים אומרים עד חצות', en: 'The Rabbis say: until midnight.' },
  { id: 'b2a-6', ref: 'Berakhot 2a.1', start: 39.5, end: 48, he: 'רבן גמליאל אומר עד שיעלה עמוד השחר', en: 'Rabban Gamliel says: until dawn rises.' }
];

const DEMO_SOURCE = {
  type: 'demo',
  url: 'assets/demo-shiur.mp4',
  label: 'Demo file',
  title: 'Daf Yomi — synchronized demo'
};

const PILOT_PROJECT = {
  id: 'chullin-81-jjea3jd6xpu',
  dafRef: 'Chullin 81',
  videoId: 'JjEa3Jd6XPU',
  videoUrl: 'https://www.youtube.com/watch?v=JjEa3Jd6XPU',
  title: 'Chullin 81 — Daf Yomi pilot shiur'
};

const state = {
  dafRef: 'Berakhot 2a',
  segments: structuredClone(DEFAULT_SEGMENTS),
  activeIndex: 0,
  objectUrl: null,
  seeking: false,
  toastTimer: null,
  playerType: 'html5',
  videoSource: { ...DEMO_SOURCE },
  youtubePlayer: null,
  youtubeApiPromise: null,
  youtubeReady: false,
  youtubeState: -1,
  youtubePollTimer: null,
  usingDefaultAlignment: true,
  editingIndex: 0,
  alignmentStatus: 'placeholder',
  currentProjectId: null,
  wordTimeline: []
};

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
    showToast('Restored the saved Chullin 81 alignment draft.');
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
  let index = state.segments.findIndex((segment) => time >= segment.start && time < segment.end);
  if (index === -1 && time >= state.segments[state.segments.length - 1].end) index = state.segments.length - 1;
  if (index === -1) index = 0;
  return index;
}

function renderDaf() {
  dafPage.innerHTML = '';
  state.segments.forEach((segment, index) => {
    const span = document.createElement('span');
    span.className = `daf-segment${index === state.editingIndex ? ' mark-target-segment' : ''}`;
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
    dafPage.appendChild(span);
  });
  $('segmentCount').textContent = `${state.segments.length} synchronized segment${state.segments.length === 1 ? '' : 's'}`;
  updateMarkTargetUi();
  updateActiveSegment(true);
  renderEditor();
}

function updateActiveWords(time) {
  if (!state.wordTimeline.length) return;
  const active = state.wordTimeline.filter((entry) => time >= entry.start && time < entry.end);
  document.querySelectorAll('.daf-segment').forEach((node, i) => {
    const ref = state.segments[i]?.ref;
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
  updateActiveWords(time);
  const index = findSegmentAt(time);
  if (!force && index === state.activeIndex) return;
  state.activeIndex = index;
  const active = state.segments[index];
  if (!active) return;

  document.querySelectorAll('.daf-segment').forEach((node, i) => {
    node.classList.toggle('active', i === index);
    node.classList.toggle('past', i < index);
  });
  document.querySelectorAll('.editor-row').forEach((node, i) => node.classList.toggle('active', i === index));

  $('currentPhrase').textContent = active.he;
  $('currentTranslation').textContent = active.en || 'Translation not loaded.';
  $('currentRef').textContent = `${state.dafRef} · Segment ${index + 1}`;

  if ($('autoScroll').checked && timeOverride === null) {
    const node = document.querySelector(`.daf-segment[data-index="${index}"]`);
    node?.scrollIntoView({ block: 'center', behavior: force ? 'auto' : 'smooth' });
  }
}

function applyDuration(duration, resetDefault = true) {
  if (!Number.isFinite(duration) || duration <= 0) return;
  scrubber.max = String(duration);
  $('duration').textContent = formatTime(duration);
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
  $('largePlay').hidden = !paused || getCurrentTime() > 0.15;
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
  seek(segment.start + 0.03, true);
  updateActiveSegment(true);
}


function updateMarkTargetUi() {
  const total = state.segments.length;
  const index = Math.min(Math.max(state.editingIndex, 0), Math.max(total - 1, 0));
  state.editingIndex = index;
  const label = $('markTargetLabel');
  if (label) label.textContent = total ? `${index + 1} of ${total}` : 'No phrase';
  document.querySelectorAll('.daf-segment').forEach((node, i) => node.classList.toggle('mark-target-segment', i === index));
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
    if (state.videoSource.type === 'demo') $('lectureTitle').textContent = `${ref} — synchronized lecture`;
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

function useDemoVideo() {
  cleanupObjectUrl();
  switchPlayerType('html5');
  state.videoSource = { ...DEMO_SOURCE };
  state.currentProjectId = null;
  state.alignmentStatus = 'placeholder';
  updateAlignmentStatus();
  htmlVideo.src = DEMO_SOURCE.url;
  htmlVideo.load();
  $('lectureTitle').textContent = DEMO_SOURCE.title;
  $('videoFileName').textContent = 'Nothing is uploaded';
  setSourceBadge(DEMO_SOURCE.label);
  setSourcePanel('demoSourcePanel');
  showToast('Demo video loaded.');
}


async function loadPilotProject() {
  const buttons = [$('loadPilotButton'), $('loadPilotInlineButton')].filter(Boolean);
  buttons.forEach((button) => { button.disabled = true; button.textContent = 'Loading pilot…'; });
  state.currentProjectId = PILOT_PROJECT.id;
  state.alignmentStatus = 'placeholder';
  updateAlignmentStatus();
  $('videoUrl').value = PILOT_PROJECT.videoUrl;
  $('dafRef').value = PILOT_PROJECT.dafRef;
  $('lectureTitle').textContent = PILOT_PROJECT.title;
  setSourcePanel('linkSourcePanel');

  const results = await Promise.allSettled([
    loadYouTubeVideo(PILOT_PROJECT.videoUrl, PILOT_PROJECT.videoId),
    loadDaf(PILOT_PROJECT.dafRef, { placeholderAlignment: true, silent: true })
  ]);

  if (results[1].status === 'rejected') {
    showToast('The video loaded, but the daf text could not be retrieved. Press “Load daf” when online.', 'error');
  }
  if (results[0].status === 'rejected') {
    showToast('The daf loaded, but YouTube could not be embedded here. Try the hosted Netlify version.', 'error');
  }

  $('lectureTitle').textContent = PILOT_PROJECT.title;
  const restored = results[1].status === 'fulfilled' && restoreDraftForCurrentProject();
  if (!restored && results.some((result) => result.status === 'fulfilled')) {
    updateAlignmentStatus('placeholder');
    showToast('Chullin 81 pilot opened. Start the video and press M at each new Gemara segment.');
  }
  buttons.forEach((button, index) => {
    button.disabled = false;
    button.textContent = index === 0 ? 'Reload Chullin 81 pilot' : 'Open pilot';
  });
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
  if (videoId !== PILOT_PROJECT.videoId) state.currentProjectId = null;
  $('videoUrl').value = state.videoSource.url;
  $('lectureTitle').textContent = videoId === PILOT_PROJECT.videoId ? PILOT_PROJECT.title : `YouTube lecture · ${videoId}`;
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
  } else if (source.type === 'demo') {
    useDemoVideo();
  } else if (source.type === 'local') {
    setSourcePanel('fileSourcePanel');
    showToast(`Choose the local file again: ${source.fileName || 'lecture video'}.`);
  }
}

async function importAlignment(file) {
  try {
    const data = JSON.parse(await file.text());
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
    state.dafRef = data.dafRef || state.dafRef;
    state.currentProjectId = data.projectId || null;
    state.alignmentStatus = data.alignmentStatus || 'in-progress';
    state.editingIndex = Math.min(Number(data.editingIndex) || 0, state.segments.length - 1);
    state.usingDefaultAlignment = false;
    updateAlignmentStatus();
    $('dafRef').value = state.dafRef;
    $('lectureTitle').textContent = data.title || $('lectureTitle').textContent;
    if (Number(data.duration) > 0) applyDuration(Number(data.duration), false);
    renderDaf();
    if (data.videoSource) await restoreVideoSource(data.videoSource);
    if (data.title) $('lectureTitle').textContent = data.title;
    seek(0);
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

$('loadPilotButton')?.addEventListener('click', loadPilotProject);
$('loadPilotInlineButton')?.addEventListener('click', loadPilotProject);
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
$('useDemoButton').addEventListener('click', useDemoVideo);
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
