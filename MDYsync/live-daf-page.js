'use strict';

// Live Follow on the printed daf: the same Vilna page image and per-word
// position data the player shows for a synced video, with the highlight
// following the reading.
//
// Nothing here is new machinery -- the page comes from the same /api/daf-page
// proxy and is rasterized by pdf.js the way the player does it, the word
// positions are the same published page maps (pages/<tractate>-<daf><amud>.json,
// via /api/get-results-file, and the same job to make one when a page has
// none yet), and the bars are drawn by the player's own geometry (see
// vilna-geometry.js: per-printed-line bars, snapped to the ink). What is
// Live Follow's own is only where the range to highlight comes from: the
// reading's position on the daf text (live.js), turned into page words by
// (paragraph ref, word index) -- the very pair a page map's boxes carry.
//
// A classic deferred script, run after live.js; it shares live.js's top-level
// bindings (live, $, setAnchor) the way notes.js shares app.js's.

(() => {
  const G = window.VilnaGeometry;
  const PDFJS_VERSION = '6.1.200';
  // As in the player (app.js): render a good deal above 1:1 so the page is
  // still sharp zoomed in, capped so the canvas stays a sensible size.
  const QUALITY_OVERSAMPLE = 1.6;
  const MAX_CANVAS_WIDTH_PX = 2600;
  const ZOOM_MIN = 0.5;
  const ZOOM_MAX = 3;
  const ZOOM_STEP = 0.2;
  const MAP_POLL_MS = 5000;
  const MAP_POLL_GIVE_UP_MS = 3 * 60 * 1000;
  const VIEW_STORAGE_KEY = 'liveDafView';

  const dp = {
    view: 'text', // 'text' | 'page'
    daf: null,
    wordPages: [], // canon index -> { tractate, daf, amud, key }
    key: null, // the page on the canvas
    wantedKey: null,
    pdfPage: null,
    map: null, // { wordBoxes (normalised, Gemara block only), ... } for `key`
    boxIndex: new Map(), // `${ref}#${wordIndex}` -> box, for `key`
    containerWidth: 0,
    zoom: 1,
    confirmed: null,
    provisional: null,
    anchor: null,
    redrawQueued: false,
    rerenderTimer: null,
    pollTimer: null,
    jobsStarted: new Set(),
    pdfCache: new Map(), // key -> pdf.js page (a daf is two pages; reading goes back and forth over the join)
    mapCache: new Map(), // key -> map | null
    inkCache: { key: '', bands: null },
    mapPollMs: MAP_POLL_MS,
  };
  window.LiveDafPage = {
    state: dp, setView, setDaf, setRange, setAnchor, setZoom, redrawNow: redraw, isActive: () => dp.view === 'page', rectsFor,
  };

  // ---- pdf.js, the player's way --------------------------------------------
  let pdfjsPromise = null;
  function loadPdfJs() {
    if (!pdfjsPromise) {
      pdfjsPromise = import(`https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.min.mjs`)
        .then((lib) => {
          lib.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs`;
          return lib;
        });
      pdfjsPromise.catch(() => { pdfjsPromise = null; });
    }
    return pdfjsPromise;
  }

  let renderQueue = Promise.resolve();
  // pdf.js rejects if one canvas is used by two render tasks at once.
  function renderCanvas(page, canvas, viewport) {
    const job = async () => {
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    };
    renderQueue = renderQueue.catch(() => {}).then(job);
    return renderQueue;
  }

  function renderScale(baseWidth, containerWidth, qualityMultiplier) {
    const scale = (containerWidth / baseWidth) * (window.devicePixelRatio || 1) * QUALITY_OVERSAMPLE * qualityMultiplier;
    return Math.min(scale, MAX_CANVAS_WIDTH_PX / baseWidth);
  }

  // ---- Which page a word is on ------------------------------------------------
  function pageOfWord(index) {
    if (dp.wordPages[index] !== undefined) return dp.wordPages[index];
    const word = dp.daf?.canon.words[index];
    const m = word && /^(.+?)\s+(\d+)([ab])[:.]\d+$/.exec(word.ref);
    const result = m ? { tractate: m[1], daf: Number(m[2]), amud: m[3], key: G.pageMapKey({ tractate: m[1], daf: Number(m[2]), amud: m[3] }) } : null;
    dp.wordPages[index] = result;
    return result;
  }

  // The boxes of the words s..e that are on page `key`, in reading order.
  function boxesFor(range, key) {
    if (!range || !dp.map) return [];
    const boxes = [];
    for (let i = range.s; i <= range.e; i += 1) {
      const word = dp.daf.canon.words[i];
      if (!word || pageOfWord(i)?.key !== key) continue;
      const box = dp.boxIndex.get(`${G.normalizeDafParagraphRef(word.ref)}#${word.wordIndex}`);
      if (box) boxes.push(box);
    }
    return boxes;
  }

  function inkBands() {
    const canvas = $('liveVilnaCanvas');
    if (!canvas || canvas.hidden || !canvas.width || !dp.map?.wordBoxes?.length) return null;
    const key = `${dp.key}:${canvas.width}x${canvas.height}`;
    if (dp.inkCache.key === key) return dp.inkCache.bands;
    const bands = G.measureInkBands(canvas, dp.map.wordBoxes);
    if (bands) dp.inkCache = { key, bands };
    return bands;
  }

  function rectsFor(range) {
    return G.groupBoxesIntoLineRects(boxesFor(range, dp.key), dp.map, inkBands());
  }

  // ---- Drawing ---------------------------------------------------------------------
  function drawOverlay(id, range, className) {
    const overlay = $(id);
    if (!overlay) return;
    overlay.textContent = '';
    if (range && dp.map && dp.key) G.appendLineRects(overlay, rectsFor(range), className);
  }

  function redraw() {
    dp.redrawQueued = false;
    drawOverlay('liveVilnaActive', dp.confirmed, 'vilna-active-rect');
    drawOverlay('liveVilnaProvisional', dp.provisional, 'vilna-provisional-rect');
    // The tapped starting word: one word, outlined.
    drawOverlay('liveVilnaAnchor', dp.anchor === null ? null : { s: dp.anchor, e: dp.anchor }, 'vilna-anchor-rect');
    window.dispatchEvent(new CustomEvent('livedafpage:drawn'));
  }

  // Several changes in one tick (a range cleared and the next one set) draw once.
  function scheduleRedraw() {
    if (dp.redrawQueued) return;
    dp.redrawQueued = true;
    requestAnimationFrame(() => { if (dp.redrawQueued) redraw(); });
  }

  function status(text) {
    const el = $('liveVilnaStatus');
    if (!el) return;
    el.textContent = text || '';
    el.hidden = !text;
  }

  function scrollToActive() {
    const scroller = $('liveDafPageScroll');
    const first = $('liveVilnaActive')?.firstElementChild;
    if (!scroller || !first || Date.now() - live.lastManualScrollAt < MANUAL_SCROLL_GRACE_MS) return;
    // The wrap is scaled by CSS: offsetTop is in unscaled px, the scroll area is not.
    const wrap = $('liveVilnaWrap');
    const top = (wrap.offsetTop + first.offsetTop) * dp.zoom - scroller.clientHeight / 3;
    scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }

  // ---- Loading a page ----------------------------------------------------------------
  async function ensurePage(parsed) {
    const key = G.pageMapKey(parsed);
    dp.wantedKey = key;
    if (dp.key === key && dp.pdfPage) return true;
    const canvas = $('liveVilnaCanvas');
    const stillWanted = () => dp.wantedKey === key;
    status(`Loading the printed page for ${parsed.tractate} ${parsed.daf}${parsed.amud}…`);
    try {
      let page = dp.pdfCache.get(key);
      if (!page) {
        const [lib, response] = await Promise.all([
          loadPdfJs(),
          fetch(`/api/daf-page?tractate=${encodeURIComponent(parsed.tractate)}&daf=${parsed.daf}&amud=${parsed.amud}`),
        ]);
        if (!stillWanted()) return false;
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error || `Page image request failed (${response.status}).`);
        }
        const pdf = await lib.getDocument({ data: await response.arrayBuffer() }).promise;
        page = await pdf.getPage(1);
        dp.pdfCache.set(key, page);
      }
      if (!stillWanted()) return false;
      // The canvas's actual containing block, as in the player: a width taken
      // from anything wider stretches the page out of its real proportions.
      const containerWidth = $('liveVilnaWrap').clientWidth || 640;
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: renderScale(base.width, containerWidth, 1) });
      canvas.style.width = `${containerWidth}px`;
      canvas.style.removeProperty('height');
      await renderCanvas(page, canvas, viewport);
      if (!stillWanted()) return false;
      dp.key = key;
      dp.pdfPage = page;
      dp.containerWidth = containerWidth;
      dp.map = null;
      dp.boxIndex = new Map();
      dp.inkCache = { key: '', bands: null };
      canvas.hidden = false;
      status('');
      redraw(); // clears the previous page's bars
      loadMap(parsed, stillWanted);
      return true;
    } catch (error) {
      if (!stillWanted()) return false;
      dp.key = null;
      dp.pdfPage = null;
      canvas.hidden = true;
      status(`Couldn’t load the printed page for ${parsed.tractate} ${parsed.daf}${parsed.amud}: ${error.message}`);
      return false;
    }
  }

  function adoptMap(key, data) {
    const wordBoxes = G.restrictWordBoxesToGemaraBlock(G.normalizePageWordBoxes(data.wordBoxes), data.textBlock);
    const map = { ...data, wordBoxes };
    dp.mapCache.set(key, map);
    return map;
  }

  function useMap(map) {
    dp.map = map;
    dp.boxIndex = new Map(map.wordBoxes.map((box) => [`${box.ref}#${box.wordIndex}`, box]));
    dp.inkCache = { key: '', bands: null };
    status('');
    redraw();
    scrollToActive();
  }

  function stopPoll() {
    clearInterval(dp.pollTimer);
    dp.pollTimer = null;
  }

  // The page's word positions, as the player gets them. A page nobody has had
  // read yet has none: the same job the player starts makes them, and it is
  // polled for the same few minutes. (The page image shows meanwhile.)
  async function loadMap(parsed, stillWanted) {
    stopPoll();
    const key = G.pageMapKey(parsed);
    if (dp.mapCache.get(key)) { useMap(dp.mapCache.get(key)); return; }
    const tryFetch = async () => {
      try {
        const response = await fetch(`/api/get-results-file?path=${encodeURIComponent(`pages/${key}.json`)}`);
        if (!stillWanted()) return true;
        if (!response.ok) return false;
        const data = await response.json();
        if (!stillWanted()) return true;
        useMap(adoptMap(key, data));
        return true;
      } catch {
        return false;
      }
    };
    if (await tryFetch() || !stillWanted()) return;
    status('The word positions for this page are being prepared — the highlight will appear on it in a minute or two. (The text view works meanwhile.)');
    if (!dp.jobsStarted.has(key)) {
      dp.jobsStarted.add(key);
      try {
        const response = await fetch('/api/trigger-page-ocr-job', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tractate: parsed.tractate, daf: parsed.daf, amud: parsed.amud }),
        });
        if (!response.ok) { status('There are no word positions for this page yet, so it can’t be highlighted here — the text view still works.'); return; }
      } catch {
        status('There are no word positions for this page yet, so it can’t be highlighted here — the text view still works.');
        return;
      }
    }
    const startedAt = Date.now();
    dp.pollTimer = setInterval(async () => {
      if (!stillWanted() || Date.now() - startedAt > MAP_POLL_GIVE_UP_MS) {
        stopPoll();
        if (stillWanted()) status('The word positions for this page are not ready yet. Try again in a few minutes — the text view still works.');
        return;
      }
      if (await tryFetch()) stopPoll();
    }, dp.mapPollMs);
  }

  // Wherever the reading is, that page; before anything is placed, the first
  // page of the daf.
  function wantedPage() {
    const range = dp.confirmed || dp.provisional;
    if (range) return pageOfWord(range.s);
    if (dp.anchor !== null) return pageOfWord(dp.anchor);
    return dp.daf?.canon.length ? pageOfWord(0) : null;
  }

  async function syncPage() {
    if (dp.view !== 'page' || !dp.daf) return;
    const parsed = wantedPage();
    if (!parsed) return;
    const changed = await ensurePage(parsed);
    if (changed) scheduleRedraw();
  }

  // ---- What live.js tells it ------------------------------------------------------------
  function setDaf(daf) {
    dp.daf = daf;
    dp.wordPages = [];
    dp.confirmed = null;
    dp.provisional = null;
    dp.anchor = null;
    dp.key = null;
    dp.wantedKey = null;
    dp.pdfPage = null;
    dp.map = null;
    dp.boxIndex = new Map();
    dp.pdfCache.clear();
    dp.mapCache.clear();
    stopPoll();
    for (const id of ['liveVilnaActive', 'liveVilnaProvisional', 'liveVilnaAnchor']) $(id)?.replaceChildren();
    $('liveVilnaCanvas').hidden = true;
    if (dp.view === 'page') syncPage();
  }

  function setRange(kind, range) {
    const prior = kind === 'confirmed' ? dp.confirmed : dp.provisional;
    const next = range ? { s: range.s, e: range.e } : null;
    if (!prior && !next) return;
    if (prior && next && prior.s === next.s && prior.e === next.e) return;
    if (kind === 'confirmed') dp.confirmed = next; else dp.provisional = next;
    if (dp.view !== 'page') return;
    const onPage = !next || pageOfWord(next.s)?.key === dp.key;
    if (onPage) { scheduleRedraw(); if (kind === 'confirmed' && next) requestAnimationFrame(scrollToActive); } else syncPage().then(() => scrollToActive());
  }

  function setAnchor(index) {
    if (dp.anchor === index) return;
    dp.anchor = index;
    if (dp.view !== 'page') return;
    if (index !== null && pageOfWord(index)?.key !== dp.key) syncPage(); else scheduleRedraw();
  }

  // ---- Views, zoom, fullscreen -----------------------------------------------------------
  function setView(view) {
    dp.view = view === 'page' ? 'page' : 'text';
    try { localStorage.setItem(VIEW_STORAGE_KEY, dp.view); } catch { /* private window: it just isn't remembered */ }
    $('liveDafScroll').hidden = dp.view !== 'text';
    $('liveDafPageView').hidden = dp.view !== 'page';
    document.querySelectorAll('#liveDafViewToggle button').forEach((b) => {
      const on = b.dataset.view === dp.view;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    document.body.dataset.dafView = dp.view;
    if (dp.view === 'page' && !dp.daf) status('Choose a daf to see its printed page.');
    if (dp.view === 'page') syncPage().then(() => { scheduleRedraw(); scrollToActive(); });
    window.dispatchEvent(new CustomEvent('livedafpage:view', { detail: { view: dp.view } }));
  }

  function setZoom(zoom) {
    dp.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom));
    // A CSS transform on the wrap, not a re-render: the canvas and the bars
    // scale together, so a tap still lands on the right word at any zoom.
    $('liveVilnaWrap').style.transform = `scale(${dp.zoom})`;
    $('liveVilnaZoomLabel').textContent = `${Math.round(dp.zoom * 100)}%`;
    // The bitmap is stretched at first (soft past its native size); a moment
    // later it is re-rasterized from the same vector page to match.
    clearTimeout(dp.rerenderTimer);
    dp.rerenderTimer = setTimeout(rerenderForZoom, 220);
  }

  async function rerenderForZoom() {
    const canvas = $('liveVilnaCanvas');
    if (!dp.pdfPage || canvas.hidden) return;
    const base = dp.pdfPage.getViewport({ scale: 1 });
    const viewport = dp.pdfPage.getViewport({ scale: renderScale(base.width, dp.containerWidth || canvas.clientWidth || 640, Math.max(1, dp.zoom)) });
    if (Math.round(viewport.width) === canvas.width) return;
    await renderCanvas(dp.pdfPage, canvas, viewport);
    dp.inkCache = { key: '', bands: null }; // a new raster is a new measurement
    redraw();
  }

  // A resize (a rotated phone, a different layout) changes the width the page
  // should be drawn at.
  function relayout() {
    const wrap = $('liveVilnaWrap');
    const canvas = $('liveVilnaCanvas');
    if (dp.view !== 'page' || !dp.pdfPage || canvas.hidden || !wrap) return;
    const width = Math.round(wrap.clientWidth || 0);
    if (!width || Math.abs(width - dp.containerWidth) < 4) return;
    dp.containerWidth = width;
    canvas.style.width = `${width}px`;
    canvas.style.removeProperty('height');
    rerenderForZoom().then(() => setZoom(dp.zoom));
  }

  function toggleFullscreen() {
    const card = $('liveDafCard');
    const current = document.fullscreenElement || document.webkitFullscreenElement;
    if (current) {
      Promise.resolve((document.exitFullscreen || document.webkitExitFullscreen).call(document)).catch(() => {});
      return;
    }
    const request = card.requestFullscreen || card.webkitRequestFullscreen;
    if (!request) { showToast('Fullscreen is not available in this browser.', 'error'); return; }
    Promise.resolve(request.call(card)).catch((error) => showToast(`Fullscreen not available: ${error.message}`, 'error'));
  }

  // ---- A tap on the page sets the place ----------------------------------------------------
  // The nearest printed word under the tap -> its word on the daf text -> the
  // same "start here / you are here" the text view's tap makes.
  function wordAt(fx, fy) {
    if (!dp.map || !dp.daf) return null;
    const canvas = dp.daf.canon;
    const PAD = 0.004;
    let best = null;
    let bestDistance = Infinity;
    for (let i = 0; i < canvas.length; i += 1) {
      const word = canvas.words[i];
      if (pageOfWord(i)?.key !== dp.key) continue;
      const box = dp.boxIndex.get(`${G.normalizeDafParagraphRef(word.ref)}#${word.wordIndex}`);
      if (!box) continue;
      const dx = Math.max(box.x - PAD - fx, 0, fx - (box.x + box.w + PAD));
      const dy = Math.max(box.y - PAD - fy, 0, fy - (box.y + box.h + PAD));
      if (dx || dy) continue;
      const distance = Math.hypot(fx - (box.x + box.w / 2), fy - (box.y + box.h / 2));
      if (distance < bestDistance) { bestDistance = distance; best = i; }
    }
    return best;
  }

  function onPageClick(event) {
    const canvas = $('liveVilnaCanvas');
    const rect = canvas.getBoundingClientRect(); // already includes the zoom transform
    if (!rect.width || !rect.height) return;
    const index = wordAt((event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height);
    if (index === null) return;
    navigator.vibrate?.(15);
    window.liveSetAnchor(index);
  }

  // ---- Wiring -------------------------------------------------------------------------------
  function init() {
    if (!$('liveDafPageView')) return;
    document.querySelectorAll('#liveDafViewToggle button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
    $('liveVilnaZoomIn').addEventListener('click', () => setZoom(dp.zoom + ZOOM_STEP));
    $('liveVilnaZoomOut').addEventListener('click', () => setZoom(dp.zoom - ZOOM_STEP));
    $('liveVilnaZoomReset').addEventListener('click', () => setZoom(1));
    $('liveVilnaFullscreen').addEventListener('click', toggleFullscreen);
    $('liveVilnaWrap').addEventListener('click', onPageClick);
    const scroller = $('liveDafPageScroll');
    // Genuine scrolling by the reader pauses the auto-scroll, as in the text view.
    for (const type of ['wheel', 'touchmove']) scroller.addEventListener(type, () => { live.lastManualScrollAt = Date.now(); }, { passive: true });
    // The "quiet" look while explaining/searching is the text view's `dimmed`
    // class; mirrored onto the page's bars.
    const text = $('liveDafText');
    const syncDim = () => $('liveDafPageView').classList.toggle('dimmed', text.classList.contains('dimmed'));
    new MutationObserver(syncDim).observe(text, { attributes: true, attributeFilter: ['class'] });
    syncDim();
    window.addEventListener('resize', () => { clearTimeout(dp.rerenderTimer); dp.rerenderTimer = setTimeout(relayout, 200); });
    document.addEventListener('fullscreenchange', () => setTimeout(relayout, 120));
    let saved = null;
    try { saved = localStorage.getItem(VIEW_STORAGE_KEY); } catch { /* ignore */ }
    setView(new URLSearchParams(location.search).get('view') === 'page' ? 'page' : (saved || 'text'));
  }

  init();
})();
