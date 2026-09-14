'use strict';

// Live, shutter-free Daf Scan: point the camera at a printed header, align it
// inside an on-screen guide, and get auto-navigated to /browse/?ref=... once
// the header is read with enough confidence across several consecutive
// frames -- no shutter tap, no four-corner marking, no photo review screen.
// The photographed frame itself is never shown back or used as a reading
// surface; the ONLY thing this feature produces is a navigation.
//
// Talks to scan-daf-header.mjs -- a deliberately lightweight endpoint,
// nothing like the full scan-daf-page.mjs pipeline this shares its OCR/
// vocabulary code with (see that file's own module comment). The legacy
// guided-capture, tap-to-confirm flow (openScanCamera et al, below in
// app.js) is untouched and stays reachable as an explicit "Use photo scan
// instead" link from this view -- for a reader this doesn't work well for
// yet, or once this needs a fallback for any other reason.
//
// Classic deferred script sharing app.js's top-level bindings ($, state,
// computeCaptureSourceRect, resetScanUi, stopScanCamera), same convention as
// notes.js/highlights.js/daf-context-menu.js/shas-search.js -- see those
// files' own header comments. Exposes window.ScanLive = { start, stop } as
// switchDafView's own entry/exit points, the same shape window.ShasSearch/
// window.DafNotesSearch already use for their own cross-file entry points.

// --- Tunables ----------------------------------------------------------------
// A request fires no more often than this after the previous one finishes --
// randomized within the range on each cycle rather than a fixed interval, so
// this never lines up into a metronomic pattern that'd be easy to mistake for
// a fixed polling rate worth "optimizing away" client-side.
const SCAN_LIVE_MIN_REQUEST_INTERVAL_MS = 800;
const SCAN_LIVE_MAX_REQUEST_INTERVAL_MS = 1200;
// How often the loop re-checks whether it's time to capture -- well under
// the request interval itself, so the actual fire time stays close to
// whatever was randomly chosen above rather than snapping to a coarser grid.
const SCAN_LIVE_TICK_MS = 200;
// A single request is given this long to finish before being abandoned as a
// normal failed round (see the "Vision timeout" edge case) -- long enough
// for a slow mobile network, short enough that one bad request can't jam the
// "only one in flight" gate for long.
const SCAN_LIVE_REQUEST_TIMEOUT_MS = 12000;

// Stability: never navigate on a single read. 2 consecutive matches lock
// immediately; otherwise a match reaching 2-of-the-last-3 rounds also locks
// (see evaluateConsensus) -- both are "2 real agreeing reads", just with
// different tolerance for one noisy round in between.
const SCAN_LIVE_HISTORY_WINDOW = 3;
const SCAN_LIVE_CONSENSUS_COUNT = 2;

// After enough consecutive network/server failures in a row, say so --
// purely informational (the loop keeps retrying regardless; this only
// changes what the status line says).
const SCAN_LIVE_ERRORS_BEFORE_NOTICE = 5;

// Cheap, dependency-free quality gates, computed against a small downsampled
// sample of the guide cutout ONLY (never the full video frame) so this stays
// fast enough to run every tick. All thresholds are on a 0-255 luminance
// scale. Deliberately loose: these exist to skip an obviously-useless frame
// (camera moving, totally dark, pointed at a blank wall) before spending a
// network request on it, not to second-guess a request that's already worth
// sending -- accuracy is Vision/tesseract's job on the server, not this
// client-side gate's.
const QUALITY_SAMPLE_WIDTH = 48;
const QUALITY_SAMPLE_HEIGHT = 20;
const QUALITY_MIN_BRIGHTNESS = 25;
const QUALITY_MAX_BRIGHTNESS = 240;
const QUALITY_MIN_CONTRAST_STDDEV = 8;
const QUALITY_MIN_EDGE_VARIANCE = 3;
const QUALITY_MAX_MOTION_DIFF = 20;

// The actual header crop sent to the server -- small and compressed on
// purpose (see the module comment's performance/abuse-protection notes):
// this is a tiny text region, not a photo, and it travels over the network
// roughly once a second for as long as the view is open.
const SCAN_LIVE_UPLOAD_MAX_DIMENSION = 480;
const SCAN_LIVE_UPLOAD_JPEG_QUALITY = 0.8;

// How long the locked/checkmark state stays on screen before navigating --
// purely so the success state is actually perceivable, not instant-cut.
const SCAN_LIVE_LOCK_DWELL_MS = 650;

const SCAN_LIVE_ENDPOINT = '/api/scan-daf-header';

// --- Pure helpers (no DOM/video access -- unit-testable directly) -----------

// entry is {tractate, daf} (or null for "no match this round") -- amud is
// deliberately NOT part of the key: this endpoint always reports 'a' (see
// scan-daf-header.mjs's own comment on why), so including it would just be
// baking in a constant, not a real distinguishing signal.
// The exact same canonical route every other DafSync entry point builds
// (see shas-search.js/daf-context-menu.js/chabura-home.js's own
// `/browse/?ref=${encodeURIComponent(...)}`) -- a separate, tiny, pure
// function purely so it has a single testable spot to confirm this flow
// never drifts onto a second URL format, and never carries raw OCR text or
// image data (only ever the clean, matched ref string the server itself
// returned) into the URL.
function buildScanLiveHref(ref) {
  return `/browse/?ref=${encodeURIComponent(ref)}`;
}

function dafKeyOf(entry) {
  if (!entry) return null;
  return `${entry.tractate}::${entry.daf}`;
}

// Appends `key` (a dafKeyOf(...) result, or null for a non-matching round)
// to `history`, capped at SCAN_LIVE_HISTORY_WINDOW entries, oldest dropped
// first. Pure -- returns a new array, never mutates the one passed in.
function pushScanHistory(history, key) {
  const next = [...history, key];
  return next.length > SCAN_LIVE_HISTORY_WINDOW ? next.slice(next.length - SCAN_LIVE_HISTORY_WINDOW) : next;
}

// 2 consecutive equal (non-null) entries at the END of history, OR any
// non-null key appearing at least SCAN_LIVE_CONSENSUS_COUNT times anywhere
// in the (at most 3-entry) window -- see the module's own tunables comment.
// A conflicting result needs no separate "reset" step: the rolling,
// capped-length window itself is what makes an old, now-contradicted result
// eventually age out and stop counting toward consensus.
function evaluateConsensus(history) {
  const n = history.length;
  if (n >= 2 && history[n - 1] && history[n - 1] === history[n - 2]) return history[n - 1];
  const counts = new Map();
  for (const key of history) {
    if (!key) continue;
    const count = (counts.get(key) || 0) + 1;
    counts.set(key, count);
    if (count >= SCAN_LIVE_CONSENSUS_COUNT) return key;
  }
  return null;
}

// Pixel-level luminance stats (mean + population stddev) of an
// {data, width, height} sample (an ImageData-shaped object -- data is
// RGBA bytes). Used for both the brightness gate and the contrast gate.
function computeLuminanceStats(sample) {
  const { data } = sample;
  const count = data.length / 4;
  if (!count) return { mean: 0, stddev: 0 };
  let sum = 0;
  const luminances = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    // Standard perceptual luminance weights -- consistent with every other
    // greyscale conversion in this codebase's own OCR preprocessing.
    const lum = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
    luminances[i] = lum;
    sum += lum;
  }
  const mean = sum / count;
  let variance = 0;
  for (let i = 0; i < count; i++) variance += (luminances[i] - mean) ** 2;
  variance /= count;
  return { mean, stddev: Math.sqrt(variance) };
}

// A cheap sharpness/blur proxy: mean absolute difference between each pixel
// and its right-hand neighbor, computed on the same luminance values
// computeLuminanceStats already derives (recomputed here rather than shared,
// since this only needs one pass and keeping the two functions independent
// keeps each one simple to verify against synthetic input on its own). A
// genuinely blurred image has little pixel-to-pixel variation; real text
// edges (even small, even through a phone camera) don't.
function computeEdgeVariance(sample) {
  const { data, width, height } = sample;
  if (width < 2 || !height) return 0;
  let sum = 0;
  let count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width - 1; x++) {
      const o1 = (y * width + x) * 4;
      const o2 = (y * width + x + 1) * 4;
      const l1 = 0.299 * data[o1] + 0.587 * data[o1 + 1] + 0.114 * data[o1 + 2];
      const l2 = 0.299 * data[o2] + 0.587 * data[o2 + 1] + 0.114 * data[o2 + 2];
      sum += Math.abs(l1 - l2);
      count++;
    }
  }
  return count ? sum / count : 0;
}

// Mean absolute luminance difference between two same-sized samples -- a
// large value means the camera (or the page) moved between them, the same
// idea a video codec's own motion estimation uses, just far cheaper. null
// when there's no previous sample yet (first frame) -- callers treat that as
// "no motion signal available", never as "definitely moving" or "definitely
// still".
function computeMotionDiff(sampleA, sampleB) {
  if (!sampleA || !sampleB || sampleA.data.length !== sampleB.data.length) return null;
  const { data: a } = sampleA;
  const { data: b } = sampleB;
  const count = a.length / 4;
  if (!count) return 0;
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    const la = 0.299 * a[o] + 0.587 * a[o + 1] + 0.114 * a[o + 2];
    const lb = 0.299 * b[o] + 0.587 * b[o + 1] + 0.114 * b[o + 2];
    sum += Math.abs(la - lb);
  }
  return sum / count;
}

// The actual gate decision, given already-computed numbers -- kept separate
// from the pixel math above specifically so this (the part with real
// judgment calls in it) can be unit-tested with plain numbers, no canvas or
// video needed at all.
function evaluateFrameQuality({ mean, stddev, edgeVariance, motionDiff }) {
  if (mean < QUALITY_MIN_BRIGHTNESS) return { ok: false, reason: 'dark' };
  if (mean > QUALITY_MAX_BRIGHTNESS) return { ok: false, reason: 'bright' };
  if (stddev < QUALITY_MIN_CONTRAST_STDDEV) return { ok: false, reason: 'flat' };
  if (edgeVariance < QUALITY_MIN_EDGE_VARIANCE) return { ok: false, reason: 'blurry' };
  if (motionDiff !== null && motionDiff > QUALITY_MAX_MOTION_DIFF) return { ok: false, reason: 'moving' };
  return { ok: true, reason: null };
}

// --- DOM-dependent capture helpers -------------------------------------------

// Draws the on-screen guide cutout's own region (mapped through the same
// object-fit:cover inverse math the legacy capture flow already uses -- see
// computeCaptureSourceRect in app.js) into a small reused canvas, downsized
// to QUALITY_SAMPLE_WIDTH/HEIGHT. Returns an ImageData-shaped object, or null
// if the video isn't ready yet / the cutout has no rendered size (e.g. the
// view was just hidden).
function sampleGuideRegion(videoEl, cutoutEl, canvas) {
  const source = computeCaptureSourceRect(videoEl, cutoutEl);
  if (!source) return null;
  canvas.width = QUALITY_SAMPLE_WIDTH;
  canvas.height = QUALITY_SAMPLE_HEIGHT;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(videoEl, source.sx, source.sy, source.sWidth, source.sHeight, 0, 0, QUALITY_SAMPLE_WIDTH, QUALITY_SAMPLE_HEIGHT);
  return ctx.getImageData(0, 0, QUALITY_SAMPLE_WIDTH, QUALITY_SAMPLE_HEIGHT);
}

// Same source-rect math, full resolution (capped to
// SCAN_LIVE_UPLOAD_MAX_DIMENSION) -- this is the actual crop sent to the
// server. Returns { dataUrl } or null.
function captureGuideRegion(videoEl, cutoutEl, canvas) {
  const source = computeCaptureSourceRect(videoEl, cutoutEl);
  if (!source) return null;
  const scale = Math.min(1, SCAN_LIVE_UPLOAD_MAX_DIMENSION / Math.max(source.sWidth, source.sHeight));
  const width = Math.max(1, Math.round(source.sWidth * scale));
  const height = Math.max(1, Math.round(source.sHeight * scale));
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(videoEl, source.sx, source.sy, source.sWidth, source.sHeight, 0, 0, width, height);
  return { dataUrl: canvas.toDataURL('image/jpeg', SCAN_LIVE_UPLOAD_JPEG_QUALITY) };
}

// --- Live session ------------------------------------------------------------
// `session` objects are created fresh by start() and referenced only via
// closures from that point on (the tick timer, the in-flight fetch's own
// .then/.catch) -- never by re-reading the module-level `activeSession`
// variable, which a later start()/stop() call can reassign or null out from
// under an in-flight async callback. Every callback checks session.stopped
// (set once, by stop(), on the exact session it belongs to) before touching
// the DOM or navigating, so a stale response from a torn-down session can
// never resurrect it or clobber a newer one.
let activeSession = null;

function newSession() {
  return {
    stopped: false,
    stream: null,
    tickTimer: null,
    requestInFlight: false,
    requestSeq: 0,
    nextRequestAt: 0,
    nextRequestDelay: SCAN_LIVE_MIN_REQUEST_INTERVAL_MS,
    history: [],
    locked: false,
    consecutiveErrors: 0,
    prevQualitySample: null,
    qualityCanvas: document.createElement('canvas'),
    captureCanvas: document.createElement('canvas'),
  };
}

// Page-level, NOT session-level: registered once by the first startLiveScan()
// call and only ever removed by the real, user/switchDafView-driven
// stopLiveScan() -- never by an internal pause. A session-scoped listener
// would remove ITSELF the moment the tab is backgrounded (since pausing
// calls the same per-session teardown a real stop uses), which would mean
// nothing is left listening for the matching "tab became visible again"
// transition of that very same event and the scanner would stay frozen on
// return. Kept as plain module-level state (not on the session object) so a
// pause-then-resume cycle reuses the same two listeners instead of adding a
// new pair every time.
let pageVisibilityHandler = null;
let pageHideHandler = null;

function removePageListeners() {
  if (pageVisibilityHandler) { document.removeEventListener('visibilitychange', pageVisibilityHandler); pageVisibilityHandler = null; }
  if (pageHideHandler) { window.removeEventListener('pagehide', pageHideHandler); pageHideHandler = null; }
}

function randomRequestDelay() {
  return SCAN_LIVE_MIN_REQUEST_INTERVAL_MS + Math.random() * (SCAN_LIVE_MAX_REQUEST_INTERVAL_MS - SCAN_LIVE_MIN_REQUEST_INTERVAL_MS);
}

function setScanLiveState(phase) {
  const view = $('scanLive');
  if (view) view.dataset.state = phase;
}

function setScanLiveStatus(message) {
  const el = $('scanLiveStatus');
  if (el) el.textContent = message;
}

function clearScanLiveWordOverlay() {
  const overlay = $('scanLiveWordOverlay');
  if (overlay) overlay.innerHTML = '';
}

// boxes: array of {left, top, width, height} fractions (0-1) of the crop
// sent -- which is exactly the same rect #scanLiveCutout itself covers, so
// these map directly onto it as plain percentages (same convention
// renderVilnaWordBoxes/renderScanMatch already use in app.js).
function renderScanLiveWordOverlay(boxes) {
  const overlay = $('scanLiveWordOverlay');
  if (!overlay) return;
  overlay.innerHTML = '';
  for (const box of boxes || []) {
    const el = document.createElement('div');
    el.className = 'scan-live-word-box';
    el.style.left = `${box.left * 100}%`;
    el.style.top = `${box.top * 100}%`;
    el.style.width = `${box.width * 100}%`;
    el.style.height = `${box.height * 100}%`;
    overlay.appendChild(el);
  }
}

async function fetchScanDafHeader(dataUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SCAN_LIVE_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(SCAN_LIVE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBase64: dataUrl.split(',')[1] }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Server returned ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function runScanLiveTick(session) {
  if (session.stopped || session.requestInFlight) return;
  const now = performance.now();
  if (now < session.nextRequestAt) return;

  const video = $('scanLiveVideo');
  const cutout = $('scanLiveCutout');
  if (!video || !cutout || video.readyState < 2) return;

  const sample = sampleGuideRegion(video, cutout, session.qualityCanvas);
  if (!sample) return;
  const { mean, stddev } = computeLuminanceStats(sample);
  const edgeVariance = computeEdgeVariance(sample);
  const motionDiff = computeMotionDiff(session.prevQualitySample, sample);
  session.prevQualitySample = sample;

  const quality = evaluateFrameQuality({ mean, stddev, edgeVariance, motionDiff });
  if (!quality.ok) {
    if (!session.locked) setScanLiveState('aligning');
    return;
  }

  const captured = captureGuideRegion(video, cutout, session.captureCanvas);
  if (!captured) return;

  session.requestInFlight = true;
  session.requestSeq += 1;
  const mySeq = session.requestSeq;
  if (!session.locked) setScanLiveState('reading');

  let result;
  try {
    result = await fetchScanDafHeader(captured.dataUrl);
    session.consecutiveErrors = 0;
  } catch (error) {
    console.error('Live scan request failed:', error);
    session.consecutiveErrors += 1;
    result = null;
  }

  session.requestInFlight = false;
  session.nextRequestDelay = randomRequestDelay();
  session.nextRequestAt = performance.now() + session.nextRequestDelay;

  // Stale-response guard: this session was torn down, or a newer request
  // already superseded this one, while the fetch above was in flight.
  if (session.stopped || mySeq !== session.requestSeq) return;

  if (!result) {
    if (session.consecutiveErrors >= SCAN_LIVE_ERRORS_BEFORE_NOTICE) {
      setScanLiveStatus("Having trouble connecting — we'll keep trying.");
    }
    return;
  }

  const matchedEntry = result.matched ? { tractate: result.tractate, daf: result.daf } : null;
  session.history = pushScanHistory(session.history, dafKeyOf(matchedEntry));

  if (matchedEntry) {
    renderScanLiveWordOverlay(result.matchedWords);
    if (!session.locked) {
      setScanLiveState('almost');
      setScanLiveStatus(`Reading ${matchedEntry.tractate} ${matchedEntry.daf}…`);
    }
  } else if (!session.locked) {
    setScanLiveState('reading');
    setScanLiveStatus('Point your camera at the header, above the Gemara text.');
    clearScanLiveWordOverlay();
  }

  const consensusKey = evaluateConsensus(session.history);
  if (consensusKey && matchedEntry && dafKeyOf(matchedEntry) === consensusKey && !session.locked) {
    lockScanLiveOn(session, result);
  }
}

function lockScanLiveOn(session, result) {
  session.locked = true;
  setScanLiveState('locked');
  setScanLiveStatus(`${result.tractate} ${result.daf} identified`);
  const checkmark = $('scanLiveCheckmark');
  if (checkmark) checkmark.hidden = false;
  if (navigator.vibrate) {
    try { navigator.vibrate(120); } catch { /* unsupported/blocked -- not essential */ }
  }
  setTimeout(() => {
    if (session.stopped) return; // torn down during the dwell -- never navigate
    const ref = result.ref;
    // Camera/timers/listeners only -- deliberately NOT resetScanLiveVisuals()
    // or hiding #scanLive (what the outer stopLiveScan() also does): the
    // whole point of the dwell above was to let the locked/checkmark state
    // be seen, and navigation is about to tear down this document anyway,
    // so there's nothing left to leak by skipping that reset here.
    stopLiveScanSession(session);
    removePageListeners();
    activeSession = null;
    if (ref) location.href = buildScanLiveHref(ref);
  }, SCAN_LIVE_LOCK_DWELL_MS);
}

// Stops the camera/loop for one session -- used both for a real, final stop
// AND for an internal pause (backgrounding; see the visibility handler
// below), which is exactly why this does NOT touch the page-level
// visibility/pagehide listeners. Only stopLiveScan() (the outer, real exit
// point) removes those.
function stopLiveScanSession(session) {
  if (!session || session.stopped) return;
  session.stopped = true;
  if (session.tickTimer) clearInterval(session.tickTimer);
  session.stream?.getTracks().forEach((track) => track.stop());
  session.stream = null;
  const video = $('scanLiveVideo');
  if (video) video.srcObject = null;
}

function resetScanLiveVisuals() {
  setScanLiveState('aligning');
  setScanLiveStatus('Point your camera at the header, above the Gemara text.');
  clearScanLiveWordOverlay();
  const checkmark = $('scanLiveCheckmark');
  if (checkmark) checkmark.hidden = true;
}

// Permission denied, no camera hardware, an insecure context (no
// getUserMedia at all), or any other getUserMedia rejection all land here --
// there's no live-scan fallback within this same view for any of them (only
// a different CAMERA API could fix it), so this always means "show the
// legacy photo-based flow instead", with a message that's specific where it
// can be.
function showScanLiveCameraError(message) {
  setScanLiveStatus(message);
  const fallback = $('scanLiveFallbackButton');
  fallback?.classList.add('scan-live-fallback-emphasized');
}

async function startLiveScan() {
  const view = $('scanLive');
  if (!view) return; // this page doesn't have the live-scan markup at all
  stopScanCamera(); // in case the legacy guided-capture camera was left open
  if (activeSession) stopLiveScanSession(activeSession);

  view.hidden = false;
  $('scanIntro').hidden = true;
  $('scanCameraView').hidden = true;
  $('scanAlign').hidden = true;
  $('scanResult').hidden = true;
  $('scanStatus').hidden = true;
  resetScanLiveVisuals();

  const session = newSession();
  activeSession = session;

  if (!navigator.mediaDevices?.getUserMedia) {
    // Covers both "no getUserMedia support" and an insecure context (most
    // browsers only expose getUserMedia on https:/localhost at all) -- from
    // the caller's side these are indistinguishable and both need the same
    // response: there is no live camera path here, use the photo flow.
    showScanLiveCameraError('Live camera scanning is not available on this browser. You can still scan with a photo.');
    return;
  }

  try {
    session.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 1280 } },
      audio: false,
    });
  } catch (error) {
    console.error('Could not open the camera for live scanning:', error);
    const deniedLikely = error?.name === 'NotAllowedError' || error?.name === 'SecurityError';
    showScanLiveCameraError(
      deniedLikely
        ? 'Camera access was denied. You can still scan with a photo instead.'
        : 'Could not open the camera. You can still scan with a photo instead.'
    );
    return;
  }

  if (session.stopped) { session.stream.getTracks().forEach((t) => t.stop()); return; } // stopped while awaiting permission

  const video = $('scanLiveVideo');
  video.srcObject = session.stream;

  // Registered once (guarded below) and left in place across any number of
  // internal pause/resume cycles -- see the module-level comment on these
  // two variables for why this can't be session-scoped.
  if (!pageVisibilityHandler) {
    pageVisibilityHandler = () => {
      if (!activeSession) return;
      if (document.hidden) {
        // Pause while backgrounded (saves battery, and mobile browsers often
        // kill the camera track on their own here anyway) -- the session
        // itself is stopped, but activeSession still points at it and the
        // view stays visible/showing its last state, so "became visible
        // again" below knows a resume is expected.
        stopLiveScanSession(activeSession);
      } else if ($('scanLive') && !$('scanLive').hidden) {
        // Resume fresh -- the paused session's camera/timer are already
        // gone, so this is a real restart, not a reuse.
        startLiveScan();
      }
    };
    document.addEventListener('visibilitychange', pageVisibilityHandler);
  }
  if (!pageHideHandler) {
    pageHideHandler = () => stopLiveScan();
    window.addEventListener('pagehide', pageHideHandler);
  }

  session.nextRequestAt = performance.now() + session.nextRequestDelay;
  session.tickTimer = setInterval(() => { runScanLiveTick(session); }, SCAN_LIVE_TICK_MS);
}

function stopLiveScan() {
  if (activeSession) stopLiveScanSession(activeSession);
  activeSession = null;
  removePageListeners();
  const view = $('scanLive');
  if (view) view.hidden = true;
  resetScanLiveVisuals();
}

// --- Wiring -------------------------------------------------------------------

$('scanLiveCancelButton')?.addEventListener('click', () => {
  stopLiveScan();
  $('scanIntro').hidden = false;
});

$('scanLiveFallbackButton')?.addEventListener('click', () => {
  stopLiveScan();
  state.scanUseLegacyFlow = true;
  resetScanUi();
});

// switchDafView's own entry/exit points (see app.js) -- same shape as
// window.ShasSearch.openWith/window.DafNotesSearch.openWith.
window.ScanLive = { start: startLiveScan, stop: stopLiveScan };

// Exposed for tests only (see tests/player/scan-live.spec.mjs) -- every pure
// function above is already a plain top-level global by virtue of this being
// a classic script, callable directly from page.evaluate(); this namespace
// exists only to give tests one stable, explicitly-public surface to call
// instead of reaching into implementation-detail function names directly.
window.ScanLive.__testing = {
  dafKeyOf, pushScanHistory, evaluateConsensus, buildScanLiveHref,
  computeLuminanceStats, computeEdgeVariance, computeMotionDiff, evaluateFrameQuality,
};
