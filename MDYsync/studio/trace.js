import { getDocument, GlobalWorkerOptions } from '../vendor/pdf.min.mjs';
import { detectLines, detectLineExtent, detectWordsInLine, collapseAbbreviations } from '../shared/daf-tracer.mjs';

GlobalWorkerOptions.workerSrc = '../vendor/pdf.worker.min.mjs';

const MASECHTOT = [
  'Berakhot', 'Shabbat', 'Eruvin', 'Pesachim', 'Yoma', 'Sukkah', 'Beitzah', 'Rosh Hashanah',
  'Taanit', 'Megillah', 'Moed Katan', 'Chagigah', 'Yevamot', 'Ketubot', 'Nedarim', 'Nazir',
  'Sotah', 'Gittin', 'Kiddushin', 'Bava Kamma', 'Bava Metzia', 'Bava Batra', 'Sanhedrin',
  'Makkot', 'Shevuot', 'Avodah Zarah', 'Horayot', 'Zevachim', 'Menachot', 'Chullin', 'Bekhorot',
  'Arakhin', 'Temurah', 'Keritot', 'Meilah', 'Niddah',
];

const $ = (id) => document.getElementById(id);
const canvasWrap = $('canvasWrap');
const boxLayer = $('boxLayer');
const canvas = $('pageCanvas');
const ctx = canvas.getContext('2d');

const state = {
  imageData: null,
  pageKey: '', ref: '',
  crop: null,     // {x, y, w, h} in canvas px
  lines: [],      // [{top, bottom, left, right, words: [{left, right}], tokens: [...]}] -- top/bottom/left/right relative to crop
  canonSegments: [],
  canonTotalWords: 0,
  dictionary: { entries: [] },
};

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 3200);
}

function setStatus(message, isError) {
  const el = $('statusLine');
  el.textContent = message;
  el.classList.toggle('err', Boolean(isError));
}

// --- Setup: tractate picker -------------------------------------------------
const tractateSelect = $('pickTractate');
for (const name of MASECHTOT) {
  const opt = document.createElement('option');
  opt.value = name;
  opt.textContent = name;
  tractateSelect.appendChild(opt);
}
tractateSelect.value = 'Chullin';

// --- Dictionary --------------------------------------------------------------
async function loadDictionary() {
  const entries = [];
  try {
    const starter = await fetch('../shared/abbreviations.json').then((r) => (r.ok ? r.json() : { entries: [] }));
    entries.push(...(starter.entries || []));
  } catch { /* ship without the starter list rather than block the tool */ }
  try {
    const res = await fetch('/api/get-results-file?path=' + encodeURIComponent('abbreviation-additions.json'));
    if (res.ok) {
      const additions = await res.json();
      if (Array.isArray(additions)) {
        for (const a of additions) if (Array.isArray(a.phrase)) entries.push({ phrase: a.phrase, abbr: a.abbr });
      }
    }
  } catch { /* no additions yet is the normal case */ }
  return { entries };
}

// --- Sefaria text --------------------------------------------------------------
async function fetchCanonSegments(ref) {
  const res = await fetch('/api/sefaria?ref=' + encodeURIComponent(ref));
  if (!res.ok) throw new Error(`Could not fetch Sefaria text for ${ref}.`);
  const data = await res.json();
  const versions = data.versions || [];
  const he = versions.find((v) => v.language === 'he') || versions[0];
  if (!he || !he.text) throw new Error(`No Hebrew text available for ${ref}.`);
  const texts = Array.isArray(he.text) ? he.text : [he.text];
  return texts
    .map((seg, i) => {
      const clean = String(seg || '').replace(/<[^>]+>/g, '');
      const words = clean.split(/\s+/).filter(Boolean);
      return { ref: `${ref}.${i + 1}`, words };
    })
    .filter((s) => s.words.length);
}

// --- PDF load + render -------------------------------------------------------
async function loadPage(tractate, daf, amud) {
  const res = await fetch(`/api/daf-page?tractate=${encodeURIComponent(tractate)}&daf=${daf}&amud=${amud}`);
  if (!res.ok) throw new Error(`No page image available for ${tractate} ${daf}${amud}.`);
  const bytes = await res.arrayBuffer();
  const pdf = await getDocument({ data: bytes }).promise;
  const page = await pdf.getPage(1);
  const base = page.getViewport({ scale: 1 });
  // High enough resolution that a single printed line is tens of pixels
  // tall -- ink-density detection is noticeably less reliable on a coarser
  // render (confirmed directly: the same page's line/word yield roughly
  // doubled going from a ~1400px-wide render to this). The canvas card
  // scrolls, so a physically large canvas costs screen space, not accuracy.
  const scale = 2600 / base.width;
  const viewport = page.getViewport({ scale });
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  boxLayer.style.width = canvas.width + 'px';
  boxLayer.style.height = canvas.height + 'px';
  await page.render({ canvasContext: ctx, viewport }).promise;
  state.imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
}

// --- Crop box interaction -----------------------------------------------------
let cropEl = null;

function renderCropBox() {
  if (cropEl) cropEl.remove();
  if (!state.crop) return;
  cropEl = document.createElement('div');
  cropEl.className = 'crop-box';
  applyRect(cropEl, state.crop);
  const handle = document.createElement('div');
  handle.className = 'handle';
  cropEl.appendChild(handle);
  boxLayer.appendChild(cropEl);

  cropEl.addEventListener('mousedown', (e) => {
    if (e.target === handle) return;
    e.stopPropagation();
    const start = { x: e.clientX, y: e.clientY, crop: { ...state.crop } };
    const onMove = (ev) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      state.crop = clampCrop({ ...start.crop, x: start.crop.x + dx, y: start.crop.y + dy });
      applyRect(cropEl, state.crop);
    };
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
  handle.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    const start = { x: e.clientX, y: e.clientY, crop: { ...state.crop } };
    const onMove = (ev) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      state.crop = clampCrop({ ...start.crop, w: Math.max(40, start.crop.w + dx), h: Math.max(40, start.crop.h + dy) });
      applyRect(cropEl, state.crop);
    };
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function clampCrop(c) {
  const x = Math.max(0, Math.min(c.x, canvas.width - 20));
  const y = Math.max(0, Math.min(c.y, canvas.height - 20));
  const w = Math.max(40, Math.min(c.w, canvas.width - x));
  const h = Math.max(40, Math.min(c.h, canvas.height - y));
  return { x, y, w, h };
}

function applyRect(el, rect) {
  el.style.left = rect.x + 'px';
  el.style.top = rect.y + 'px';
  el.style.width = rect.w + 'px';
  el.style.height = rect.h + 'px';
}

boxLayer.addEventListener('mousedown', (e) => {
  if (e.target !== boxLayer) return;
  const layerRect = boxLayer.getBoundingClientRect();
  const start = { x: e.clientX - layerRect.left, y: e.clientY - layerRect.top };
  state.crop = { x: start.x, y: start.y, w: 1, h: 1 };
  renderCropBox();
  const onMove = (ev) => {
    const cx = ev.clientX - layerRect.left;
    const cy = ev.clientY - layerRect.top;
    state.crop = clampCrop({
      x: Math.min(start.x, cx), y: Math.min(start.y, cy),
      w: Math.abs(cx - start.x), h: Math.abs(cy - start.y),
    });
    applyRect(cropEl, state.crop);
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    $('detectButton').disabled = !(state.crop && state.crop.w > 30 && state.crop.h > 30);
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});

// --- Line detection + rendering ----------------------------------------------
function runDetection() {
  if (!state.crop || !state.imageData) return;
  const rawLines = detectLines(state.imageData, state.crop);
  state.lines = rawLines.map((line) => {
    const extent = detectLineExtent(state.imageData, state.crop, line) || { left: 0, right: state.crop.w - 1 };
    const words = detectWordsInLine(state.imageData, state.crop, line, extent);
    return { top: line.top, bottom: line.bottom, left: extent.left, right: extent.right, words };
  });
  recomputeAssignment();
  renderLines();
}

function recomputeAssignment() {
  const tokens = collapseAbbreviations(state.canonSegments, state.dictionary);
  let cursor = 0;
  for (const line of state.lines) {
    const n = line.words.length;
    line.tokens = tokens.slice(cursor, cursor + n);
    cursor += n;
  }
  state.remainingTokens = tokens.slice(cursor);
  state.totalTokensUsed = cursor;
  state.totalTokens = tokens.length;
  flagLines();
  updateStats();
}

function flagLines() {
  const ratios = state.lines
    .filter((l) => l.words.length && l.tokens.length)
    .map((l) => l.tokens.reduce((s, t) => s + t.text.replace(/\s+/g, '').length, 0) / l.words.length);
  const sorted = [...ratios].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  for (const line of state.lines) {
    if (!line.words.length) { line.flagged = false; continue; }
    const chars = line.tokens.reduce((s, t) => s + t.text.replace(/\s+/g, '').length, 0);
    const ratio = line.tokens.length ? chars / line.words.length : 0;
    const hasKnownAbbr = line.tokens.some((t) => t.abbr);
    line.flagged = !hasKnownAbbr && median > 0 && Math.abs(ratio - median) > median * 0.55;
    line.why = line.flagged ? 'word count looks off vs. its assigned text -- possibly an uncaught abbreviation' : '';
    line.hasKnownAbbr = hasKnownAbbr;
  }
}

function renderLines() {
  boxLayer.querySelectorAll('.line-box').forEach((el) => el.remove());
  state.lines.forEach((line, idx) => {
    const el = document.createElement('div');
    el.className = 'line-box' + (line.flagged ? ' flagged' : line.hasKnownAbbr ? ' ok' : '');
    el.style.left = (state.crop.x + line.left) + 'px';
    el.style.top = (state.crop.y + line.top) + 'px';
    el.style.width = (line.right - line.left) + 'px';
    el.style.height = (line.bottom - line.top) + 'px';
    el.title = line.tokens.map((t) => t.text).join(' ');

    let cum = 0;
    for (const w of line.words) {
      const divider = document.createElement('div');
      divider.className = 'word';
      divider.style.left = (w.left - line.left) + 'px';
      boxLayer.style.pointerEvents = boxLayer.style.pointerEvents; // no-op, keep lints quiet
      el.appendChild(divider);
      cum += 1;
    }

    const tools = document.createElement('div');
    tools.className = 'line-tools';
    const splitBtn = document.createElement('button');
    splitBtn.textContent = 'Split';
    splitBtn.onclick = (e) => { e.stopPropagation(); splitLine(idx); };
    const mergeBtn = document.createElement('button');
    mergeBtn.textContent = 'Merge ↓';
    mergeBtn.disabled = idx === state.lines.length - 1;
    mergeBtn.onclick = (e) => { e.stopPropagation(); mergeLineWithNext(idx); };
    const abbrBtn = document.createElement('button');
    abbrBtn.textContent = 'Mark abbrev.';
    abbrBtn.onclick = (e) => { e.stopPropagation(); openAbbrPopover(idx, e.clientX, e.clientY); };
    tools.append(splitBtn, mergeBtn, abbrBtn);
    el.appendChild(tools);

    addResizeHandles(el, idx);
    boxLayer.appendChild(el);
  });
  renderFlagList();
}

function addResizeHandles(el, idx) {
  const top = document.createElement('div'); top.className = 'line-resize top';
  const bottom = document.createElement('div'); bottom.className = 'line-resize bottom';
  const left = document.createElement('div'); left.className = 'side-resize left';
  const right = document.createElement('div'); right.className = 'side-resize right';
  el.append(top, bottom, left, right);

  function dragEdge(handleEl, apply) {
    handleEl.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      const startY = e.clientY, startX = e.clientX;
      const line = state.lines[idx];
      const orig = { ...line };
      const onMove = (ev) => { apply(line, orig, ev.clientX - startX, ev.clientY - startY); renderLines(); recomputeAssignment(); renderLines(); };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        reflowLineWords(idx);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }
  dragEdge(top, (line, orig, dx, dy) => { line.top = Math.max(0, Math.min(orig.bottom - 4, orig.top + dy)); });
  dragEdge(bottom, (line, orig, dx, dy) => { line.bottom = Math.max(orig.top + 4, orig.bottom + dy); });
  dragEdge(left, (line, orig, dx, dy) => { line.left = Math.max(0, Math.min(orig.right - 4, orig.left + dx)); });
  dragEdge(right, (line, orig, dx, dy) => { line.right = Math.max(orig.left + 4, orig.right + dx); });
}

function reflowLineWords(idx) {
  const line = state.lines[idx];
  const extent = { left: line.left, right: line.right };
  line.words = detectWordsInLine(state.imageData, state.crop, line, extent);
  recomputeAssignment();
  renderLines();
}

function splitLine(idx) {
  const line = state.lines[idx];
  const mid = Math.round((line.top + line.bottom) / 2);
  const top = { top: line.top, bottom: mid };
  const bottom = { top: mid + 1, bottom: line.bottom };
  const rebuilt = [top, bottom].map((l) => {
    const extent = detectLineExtent(state.imageData, state.crop, l) || { left: line.left, right: line.right };
    const words = detectWordsInLine(state.imageData, state.crop, l, extent);
    return { top: l.top, bottom: l.bottom, left: extent.left, right: extent.right, words };
  });
  state.lines.splice(idx, 1, ...rebuilt);
  recomputeAssignment();
  renderLines();
}

function mergeLineWithNext(idx) {
  const a = state.lines[idx];
  const b = state.lines[idx + 1];
  if (!b) return;
  const merged = { top: a.top, bottom: b.bottom };
  const extent = detectLineExtent(state.imageData, state.crop, merged) || { left: Math.min(a.left, b.left), right: Math.max(a.right, b.right) };
  const words = detectWordsInLine(state.imageData, state.crop, merged, extent);
  state.lines.splice(idx, 2, { top: merged.top, bottom: merged.bottom, left: extent.left, right: extent.right, words });
  recomputeAssignment();
  renderLines();
}

function renderFlagList() {
  const panel = $('flagsPanel');
  const list = $('flagList');
  list.innerHTML = '';
  const flagged = state.lines.map((l, i) => ({ l, i })).filter(({ l }) => l.flagged);
  panel.hidden = flagged.length === 0;
  for (const { l, i } of flagged) {
    const item = document.createElement('div');
    item.className = 'flag-item';
    item.innerHTML = `<div>Line ${i + 1} &middot; ${l.words.length} word box${l.words.length === 1 ? '' : 'es'}</div><div class="why">${l.why}</div>`;
    item.addEventListener('click', (e) => openAbbrPopover(i, e.clientX, e.clientY));
    list.appendChild(item);
  }
}

function updateStats() {
  $('statLines').textContent = String(state.lines.length);
  $('statWords').textContent = `${state.totalTokensUsed} / ${state.totalTokens}`;
  const pct = state.totalTokens ? Math.round((state.totalTokensUsed / state.totalTokens) * 100) : 0;
  $('statMatch').textContent = `${pct}%`;
  $('publishButton').disabled = state.lines.length === 0;
}

// --- Abbreviation marking ------------------------------------------------------
let popoverEl = null;

function openAbbrPopover(lineIdx, clientX, clientY) {
  closePopover();
  const line = state.lines[lineIdx];
  const usedBefore = state.lines.slice(0, lineIdx).reduce((s, l) => s + l.tokens.length, 0);
  const tokens = collapseAbbreviations(state.canonSegments, state.dictionary);
  const startIdx = usedBefore;
  const preview = tokens.slice(startIdx, startIdx + Math.max(line.words.length + 6, 6));
  if (!preview.length) { toast('No remaining canon words to assign here.'); return; }

  popoverEl = document.createElement('div');
  popoverEl.className = 'abbr-popover';
  popoverEl.style.left = Math.min(clientX, window.innerWidth - 340) + 'px';
  popoverEl.style.top = Math.min(clientY, window.innerHeight - 260) + 'px';

  const wordsEl = document.createElement('div');
  wordsEl.className = 'canon-words';
  let selCount = Math.min(2, preview.length);
  function renderWords() {
    wordsEl.innerHTML = '';
    preview.forEach((tok, i) => {
      const span = document.createElement('span');
      span.textContent = tok.text;
      if (i < selCount) span.classList.add('sel');
      span.addEventListener('click', () => { selCount = i + 1; renderWords(); });
      wordsEl.appendChild(span);
    });
  }
  renderWords();

  const label = document.createElement('div');
  label.style.cssText = 'font-size:12px;color:var(--muted);margin-bottom:8px;';
  label.textContent = `Line ${lineIdx + 1} has ${line.words.length} printed word box${line.words.length === 1 ? '' : 'es'}. Click the raw words that print as ONE of them:`;

  const abbrInput = document.createElement('input');
  abbrInput.placeholder = 'How it looks printed (optional), e.g. ת"ר';

  const row = document.createElement('div');
  row.className = 'row';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'button small ghost';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = closePopover;
  const saveBtn = document.createElement('button');
  saveBtn.className = 'button small primary';
  saveBtn.textContent = 'Save & apply';
  saveBtn.onclick = () => saveAbbreviation(preview.slice(0, selCount).flatMap((t) => t.text.split(' ')), abbrInput.value.trim());
  row.append(cancelBtn, saveBtn);

  const h4 = document.createElement('h4');
  h4.textContent = 'Mark an abbreviation';
  popoverEl.append(h4, label, wordsEl, abbrInput, row);
  document.body.appendChild(popoverEl);

  setTimeout(() => document.addEventListener('mousedown', outsideClose), 0);
}

function outsideClose(e) {
  if (popoverEl && !popoverEl.contains(e.target)) closePopover();
}
function closePopover() {
  if (popoverEl) popoverEl.remove();
  popoverEl = null;
  document.removeEventListener('mousedown', outsideClose);
}

async function saveAbbreviation(phraseWords, abbrLabel) {
  if (phraseWords.length < 2) { toast('Select at least 2 words to merge.'); return; }
  state.dictionary.entries.push({ phrase: phraseWords, abbr: abbrLabel || null });
  recomputeAssignment();
  renderLines();
  closePopover();
  toast('Applied. Saving to the shared dictionary...');
  try {
    const res = await fetch('/api/add-abbreviation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phrase: phraseWords, abbr: abbrLabel || undefined }),
    });
    if (!res.ok) throw new Error(await res.text());
    toast('Abbreviation saved -- future pages will pick it up automatically.');
  } catch (err) {
    toast('Applied here, but saving it for future pages failed.');
    console.error(err);
  }
}

// --- Publish ---------------------------------------------------------------
async function publishPage() {
  const wordBoxes = [];
  for (const line of state.lines) {
    for (const token of line.tokens) {
      const box = {
        x: (state.crop.x + line.left) / canvas.width,
        y: (state.crop.y + line.top) / canvas.height,
        w: (line.right - line.left) / canvas.width,
        h: (line.bottom - line.top) / canvas.height,
      };
      for (let idx = token.wordIndexStart; idx <= token.wordIndexEnd; idx += 1) {
        wordBoxes.push({ ref: token.ref, wordIndex: idx, ...box });
      }
    }
  }
  if (!wordBoxes.length) { toast('Nothing to publish yet.'); return; }

  const xs = wordBoxes.map((b) => b.x);
  const ys = wordBoxes.map((b) => b.y);
  const textBlock = {
    left: Math.min(...xs), top: Math.min(...ys),
    right: Math.max(...wordBoxes.map((b) => b.x + b.w)),
    bottom: Math.max(...wordBoxes.map((b) => b.y + b.h)),
  };

  if (!confirm(`Publish this hand-traced page map for ${state.pageKey}? This overwrites what every reader sees for this page.`)) return;

  $('publishButton').disabled = true;
  try {
    const res = await fetch('/api/publish-pagemap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pageKey: state.pageKey,
        pagemap: { pageWidth: canvas.width, pageHeight: canvas.height, textBlock, wordBoxes },
      }),
    });
    if (!res.ok) throw new Error(await res.text());
    toast(`Published ${state.pageKey}.`);
  } catch (err) {
    toast('Publish failed -- see console.');
    console.error(err);
  } finally {
    $('publishButton').disabled = false;
  }
}

// --- Wiring ------------------------------------------------------------------
$('loadButton').addEventListener('click', async () => {
  const tractate = tractateSelect.value;
  const daf = Number($('pickDaf').value);
  const amud = $('pickAmud').value;
  const ref = `${tractate} ${daf}${amud}`;
  state.pageKey = `${tractate.replace(/\s+/g, '-')}-${daf}${amud}`;
  state.ref = ref;
  state.crop = null;
  state.lines = [];
  $('detectButton').disabled = true;
  $('publishButton').disabled = true;
  boxLayer.innerHTML = '';
  setStatus('Loading page and text…');
  try {
    const [, canonSegments, dictionary] = await Promise.all([
      loadPage(tractate, daf, amud),
      fetchCanonSegments(ref),
      loadDictionary(),
    ]);
    state.canonSegments = canonSegments;
    state.canonTotalWords = canonSegments.reduce((s, seg) => s + seg.words.length, 0);
    state.dictionary = dictionary;
    $('emptyHint').hidden = true;
    canvasWrap.hidden = false;
    setStatus(`${ref} loaded — ${state.canonTotalWords} words of Gemara text. Drag a box around the column.`);
  } catch (err) {
    setStatus(err.message || String(err), true);
  }
});

$('detectButton').addEventListener('click', () => {
  try {
    runDetection();
    setStatus(`Traced ${state.lines.length} lines.`);
  } catch (err) {
    setStatus(err.message || String(err), true);
  }
});

$('publishButton').addEventListener('click', publishPage);
