// The Interactive Daf page (browse/) as a sefer: the printed daf turns like a
// page of a Gemara, a dial spins through the dapim of the masechta, and the
// page opens from a leather cover when it is reached from the menu.
//
// The daf itself is untouched. A turn is drawn OVER the real page: a picture
// of the amud being left lifts away, the next amud (drawn ahead of time) lies
// underneath, and once the real page has drawn that amud the pictures go and
// everything on the page works as before (tapping a word, holding for the
// menu, highlights, notes, zoom, Select text, Live follow).
//
// Gestures it must never take from the page:
// - A tap stays a word tap; holding still opens the menu (a turn starts only
//   past the same 10px the long-press already treats as a move).
// - Only a clearly sideways swipe turns; up and down scrolls; two fingers
//   pinch-zoom as before.
// - Zoomed in, a sideways drag pans the page; it turns only when the page is
//   already at its edge in that direction.
// - Select text and Mark words switch swiping off.
//
// Direction, as in a Hebrew book: a swipe to the right (the left arrow, "‹")
// is the next amud; to the left (the right arrow, "›") the one before.
(() => {
  const $ = (id) => document.getElementById(id);
  const card = $('dafCard');
  const scroll = $('dafScroll');
  const placeholder = $('vilnaPlaceholder');
  const wrap = $('vilnaPageWrap');
  const canvas = $('vilnaPageCanvas');
  if (!card || !scroll || !placeholder || !wrap || !canvas) return;
  if (typeof state === 'undefined' || !state.browseMode) return;

  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  const motionOff = () => Boolean(reducedMotion?.matches);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  // --- Where the page is -----------------------------------------------------
  function here() {
    const tractate = $('dafTractateSelect')?.value;
    const daf = Number($('dafDafSelect')?.value);
    const amud = typeof activeAmud === 'function' ? activeAmud('dafAmudToggle') : 'a';
    if (!tractate || !daf) return null;
    return { tractate, daf, amud };
  }
  const keyOf = (p) => `${p.tractate}|${p.daf}|${p.amud}`;
  function neighbor(direction) {
    const p = here();
    if (!p || typeof neighborAmud !== 'function') return null;
    try { return neighborAmud(p.tractate, p.daf, p.amud, direction); } catch { return null; }
  }
  const pageShowing = () => card.dataset.dafView === 'page' && !placeholder.hidden && !card.hidden
    && !canvas.hidden && canvas.offsetWidth > 0;
  const pageReady = (key) => state.vilnaPageKey === key && !canvas.hidden && state.vilnaPageLoadingKey !== key;
  const swipingAllowed = () => pageShowing() && !state.vilnaSelectTextMode && !state.vilnaMarkMode && !coverShowing();

  // --- Sound -------------------------------------------------------------------
  // Synthesised paper, kept quiet: a soft rustle that swells and settles, a
  // little different every time, and a faint touch as the page lands.
  const SOUND_KEY = 'dafsync-book-sound';
  let soundOn = true;
  try { soundOn = localStorage.getItem(SOUND_KEY) !== 'off'; } catch { /* private mode */ }
  let audioContext = null;
  let master = null;
  function audio() {
    if (!soundOn) return null;
    try {
      if (!audioContext) {
        const Context = window.AudioContext || window.webkitAudioContext;
        if (!Context) return null;
        audioContext = new Context();
        master = audioContext.createGain();
        master.gain.value = 1;
        master.connect(audioContext.destination);
      }
      if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
      return audioContext;
    } catch { return null; }
  }
  // Paper: noise whose loudness flutters slowly (the sheet sliding) with the
  // odd tiny crackle (its fibres), not the steady hiss of plain noise.
  function paperBuffer(ctx, seconds, crackle) {
    const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let brown = 0;
    let flutter = 0.6;
    let target = 0.6;
    for (let i = 0; i < length; i += 1) {
      if (i % 180 === 0) target = 0.3 + Math.random() * 0.7;
      flutter += (target - flutter) * 0.01;
      const white = Math.random() * 2 - 1;
      brown = (brown + 0.04 * white) / 1.04;
      let sample = white * 0.45 + brown * 3;
      if (Math.random() < crackle) sample *= 3;
      data[i] = sample * flutter;
    }
    return buffer;
  }
  function rustle({ at = 0, seconds, peak, gain, highpass = 380, lowpass = 4200, crackle = 0.002 }) {
    const ctx = audio();
    if (!ctx) return;
    const t = ctx.currentTime + at;
    const source = ctx.createBufferSource();
    source.buffer = paperBuffer(ctx, seconds + 0.05, crackle);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = highpass;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = lowpass;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(gain, t + seconds * peak);
    env.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
    source.connect(hp); hp.connect(lp); lp.connect(env); env.connect(master);
    source.start(t);
    source.stop(t + seconds + 0.05);
  }
  function land(at, gain) {
    const ctx = audio();
    if (!ctx) return;
    const t = ctx.currentTime + at;
    const source = ctx.createBufferSource();
    source.buffer = paperBuffer(ctx, 0.12, 0);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 260;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(gain, t + 0.012);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
    source.connect(lp); lp.connect(env); env.connect(master);
    source.start(t);
    source.stop(t + 0.14);
  }
  const sounds = {
    turn(ms = 520) {
      const s = ms / 1000;
      rustle({ seconds: s * 0.95, peak: 0.35, gain: 0.16 });
      land(s * 0.9, 0.09);
    },
    riffle() { rustle({ seconds: 0.09, peak: 0.3, gain: 0.08, highpass: 900, lowpass: 5000 }); },
    tick() {
      rustle({ seconds: 0.018, peak: 0.15, gain: 0.12, highpass: 2600, lowpass: 7000, crackle: 0 });
      try { navigator.vibrate?.(3); } catch { /* none */ }
    },
    cover() {
      rustle({ seconds: 0.75, peak: 0.45, gain: 0.11, highpass: 250, lowpass: 2400 });
      land(0.72, 0.12);
    },
  };
  function setSound(on) {
    soundOn = on;
    try { localStorage.setItem(SOUND_KEY, on ? 'on' : 'off'); } catch { /* private mode */ }
    const button = $('dafBookSoundButton');
    if (button) {
      button.setAttribute('aria-pressed', String(on));
      button.title = on ? 'Page sound on (tap to mute)' : 'Page sound off (tap to turn on)';
      button.setAttribute('aria-label', on ? 'Mute the page sound' : 'Turn the page sound on');
      button.classList.toggle('is-muted', !on);
    }
  }

  // --- Pictures of amudim ---------------------------------------------------
  // The amudim either side of the page are drawn ahead of time, smaller than
  // the page itself (a picture only has to look right for half a second), and
  // kept as JPEGs rather than canvases so a few of them cost little memory.
  // The PDF comes from the same address the page uses, which the browser
  // caches, so turning onto a drawn amud also loads it at once.
  const PICTURE_MAX_PX = 1600;
  const pictures = new Map(); // key -> Promise<{ url, img } | null>
  function pictureWidthPx() {
    const css = canvas.offsetWidth || wrap.clientWidth || 600;
    return Math.round(Math.min(PICTURE_MAX_PX, css * (window.devicePixelRatio || 1) * 1.25));
  }
  function drawPicture(key) {
    if (pictures.has(key)) return pictures.get(key);
    const [tractate, daf, amud] = key.split('|');
    const job = (async () => {
      const [lib, response] = await Promise.all([
        loadPdfJs(),
        fetch(`/api/daf-page?tractate=${encodeURIComponent(tractate)}&daf=${daf}&amud=${amud}`),
      ]);
      if (!response.ok) return null;
      const pdf = await lib.getDocument({ data: await response.arrayBuffer() }).promise;
      const page = await pdf.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: pictureWidthPx() / base.width });
      const paper = document.createElement('canvas');
      paper.width = Math.round(viewport.width);
      paper.height = Math.round(viewport.height);
      await page.render({ canvasContext: paper.getContext('2d'), viewport }).promise;
      try { pdf.destroy?.(); } catch { /* already gone */ }
      const blob = await new Promise((resolve) => paper.toBlob(resolve, 'image/jpeg', 0.9));
      if (!blob) return null;
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.src = url;
      try { await img.decode(); } catch { /* shown when it can be */ }
      return { url, img };
    })().catch(() => null);
    pictures.set(key, job);
    // Keep the nearest few; the oldest go.
    while (pictures.size > 6) {
      const [oldKey, oldJob] = pictures.entries().next().value;
      pictures.delete(oldKey);
      oldJob.then((picture) => { if (picture) URL.revokeObjectURL(picture.url); });
    }
    return job;
  }
  const settledPictures = new Map(); // key -> { url, img } once drawn
  function pictureNow(key) {
    const done = settledPictures.get(key);
    if (!done) return null;
    const img = done.img.cloneNode();
    img.alt = '';
    img.draggable = false;
    return img;
  }
  async function prepare(key) {
    const picture = await drawPicture(key);
    if (picture && pictures.has(key)) settledPictures.set(key, picture);
    for (const old of [...settledPictures.keys()]) if (!pictures.has(old)) settledPictures.delete(old);
    return picture;
  }
  let prepareTimer = null;
  function prepareNeighbours() {
    clearTimeout(prepareTimer);
    // After the page itself has drawn: never compete with it.
    prepareTimer = setTimeout(() => {
      if (!pageShowing()) return;
      for (const direction of [1, -1]) {
        const next = neighbor(direction);
        if (next) prepare(keyOf(next));
      }
    }, 400);
  }
  // The picture of the page on screen now, for the leaf that lifts away.
  function snapshot() {
    const width = Math.min(canvas.width, PICTURE_MAX_PX);
    if (!width || !canvas.height) return null;
    const copy = document.createElement('canvas');
    copy.width = width;
    copy.height = Math.round((canvas.height * width) / canvas.width);
    try { copy.getContext('2d').drawImage(canvas, 0, 0, copy.width, copy.height); } catch { return null; }
    return copy;
  }

  // --- The turning leaf -------------------------------------------------------
  // .daf-book-stage sits exactly over the page canvas, inside the page's own
  // zoom transform, above the word overlays, and clips at the page's edges:
  // past the spine (the right edge, as in a Hebrew book) the leaf is gone.
  function makeStage() {
    const stage = document.createElement('div');
    stage.className = 'daf-book-stage';
    stage.setAttribute('aria-hidden', 'true');
    Object.assign(stage.style, {
      left: `${canvas.offsetLeft}px`,
      top: `${canvas.offsetTop}px`,
      width: `${canvas.offsetWidth}px`,
      height: `${canvas.offsetHeight}px`,
    });
    stage.innerHTML = '<div class="dbs-under"></div><div class="dbs-shade"></div>'
      + '<div class="dbs-leaf"><div class="dbs-face"></div><div class="dbs-light"></div></div>';
    wrap.appendChild(stage);
    return {
      stage,
      under: stage.querySelector('.dbs-under'),
      shade: stage.querySelector('.dbs-shade'),
      leaf: stage.querySelector('.dbs-leaf'),
      face: stage.querySelector('.dbs-face'),
      light: stage.querySelector('.dbs-light'),
    };
  }
  function show(el, picture) {
    el.replaceChildren();
    el.classList.toggle('is-paper', !picture);
    if (picture) el.appendChild(picture);
  }
  // p runs 0 -> 1 over the whole turn whichever way it goes.
  function pose(parts, direction, p) {
    const angle = direction > 0 ? p * 180 : (1 - p) * 180;
    const lift = Math.sin((Math.min(angle, 90) / 90) * (Math.PI / 2));
    parts.leaf.style.transform = `rotateY(${angle.toFixed(2)}deg)`;
    parts.leaf.style.visibility = angle >= 89.5 ? 'hidden' : 'visible';
    parts.light.style.opacity = (0.08 + 0.55 * lift).toFixed(3);
    // The page underneath is in the leaf's shadow while the leaf is low.
    const covered = direction > 0 ? 1 - p : p;
    parts.shade.style.opacity = (Math.max(0, covered) * (0.25 + 0.5 * lift)).toFixed(3);
  }
  function animate(from, to, ms, onFrame) {
    return new Promise((resolve) => {
      if (ms <= 0) { onFrame(to); resolve(); return; }
      const start = performance.now();
      const step = (now) => {
        const t = clamp((now - start) / ms, 0, 1);
        onFrame(from + (to - from) * easeOut(t));
        if (t < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
  }

  let current = null; // the turn on screen: { parts, direction, target, ... }
  let busy = false;

  function begin(direction, target) {
    finishStage();
    const parts = makeStage();
    const targetKey = keyOf(target);
    // The page being left: the canvas, unless it is still on the amud before
    // (a turn straight after another), then that amud's picture.
    const leaving = here();
    const leavingPicture = leaving && !pageReady(keyOf(leaving)) ? pictureNow(keyOf(leaving)) : null;
    if (direction > 0) {
      show(parts.face, leavingPicture || (leaving && pageReady(keyOf(leaving)) ? snapshot() : null));
      show(parts.under, pictureNow(targetKey));
    } else {
      show(parts.face, pictureNow(targetKey));
      parts.under.remove();
    }
    pose(parts, direction, 0);
    const turn = { parts, direction, target, targetKey };
    current = turn;
    // Not drawn yet: paper now, the amud the moment it is ready.
    const slot = direction > 0 ? parts.under : parts.face;
    if (slot.classList.contains('is-paper')) {
      prepare(targetKey).then(() => {
        if (current === turn && slot.isConnected && slot.classList.contains('is-paper')) show(slot, pictureNow(targetKey));
      });
    }
    return turn;
  }
  // Leave the pictures until the real page has drawn the new amud, then go.
  async function reveal(turn) {
    const deadline = performance.now() + 12000;
    while (current === turn && !pageReady(turn.targetKey) && performance.now() < deadline) await wait(60);
    if (current !== turn) return;
    turn.parts.stage.classList.add('is-leaving');
    await wait(140);
    if (current === turn) finishStage();
  }
  function finishStage() {
    if (!current) return;
    current.parts.stage.remove();
    current = null;
  }
  function go(target) {
    if (typeof goToBrowseAmud === 'function') goToBrowseAmud(target.tractate, target.daf, target.amud);
  }

  // A whole turn, from the arrows. Every press counts: a press during a turn
  // cuts it short and turns the next page from where the last one went.
  let turnToken = 0;
  const canTurn = (direction) => !motionOff() && pageShowing() && !coverShowing()
    && gesture?.mode !== 'turn' && Boolean(neighbor(direction));
  async function turn(direction) {
    if (!canTurn(direction)) return false;
    const target = neighbor(direction);
    const token = ++turnToken;
    busy = true;
    const t = begin(direction, target);
    const ms = 560;
    sounds.turn(ms);
    go(target);
    await animate(0, 1, ms, (p) => { if (current === t) pose(t.parts, direction, easeInOut(p)); });
    if (token === turnToken) busy = false;
    reveal(t);
    return true;
  }

  // --- Swiping ---------------------------------------------------------------
  const TURN_SLOP = 10;
  let gesture = null;
  let suppressClickUntil = 0;

  function canPan(direction) {
    // direction > 0: a swipe to the right, which pans toward the page's left.
    const max = scroll.scrollWidth - scroll.clientWidth;
    if (max <= 1) return false;
    return direction > 0 ? scroll.scrollLeft > 1 : scroll.scrollLeft < max - 1;
  }
  function startGesture(x, y, pointerType) {
    if (busy || !swipingAllowed()) return;
    gesture = { x0: x, y0: y, t0: performance.now(), mode: null, p: 0, pointerType };
  }
  function moveGesture(x, y, event) {
    const g = gesture;
    if (!g) return;
    const dx = x - g.x0;
    const dy = y - g.y0;
    if (!g.mode) {
      if (Math.abs(dx) < TURN_SLOP && Math.abs(dy) < TURN_SLOP) return;
      if (Math.abs(dx) < Math.abs(dy) * 1.3) { g.mode = 'scroll'; return; }
      const direction = dx > 0 ? 1 : -1;
      const target = canPan(direction) ? null : neighbor(direction);
      if (!target || motionOff()) { g.mode = 'none'; return; }
      g.mode = 'turn';
      g.direction = direction;
      g.token = ++turnToken;
      g.turn = begin(direction, target);
      g.width = canvas.getBoundingClientRect().width || 1;
      busy = true;
    }
    if (g.mode !== 'turn') return;
    if (event?.cancelable) event.preventDefault();
    // The leaf's free edge stays under the finger: lifting the page a
    // fraction f of its width is an angle of acos(1 - f) (forward); coming
    // back over from the spine, acos(f).
    const along = g.direction > 0 ? dx : -dx;
    g.f = clamp(along / (g.width * 0.9), 0, 1);
    g.p = g.direction > 0 ? Math.acos(1 - g.f) / Math.PI : 1 - Math.acos(g.f) / Math.PI;
    pose(g.turn.parts, g.direction, g.p);
  }
  async function endGesture(cancelled) {
    const g = gesture;
    gesture = null;
    if (!g || g.mode !== 'turn') return;
    suppressClickUntil = performance.now() + 450;
    const quick = performance.now() - g.t0 < 320 && (g.f || 0) > 0.05;
    const done = !cancelled && ((g.f || 0) > 0.3 || quick);
    const ms = Math.round(160 + 460 * (done ? 1 - g.p : g.p));
    if (done) {
      sounds.turn(ms + 80);
      go(g.turn.target);
    }
    await animate(g.p, done ? 1 : 0, ms, (p) => pose(g.turn.parts, g.direction, p));
    if (g.token === turnToken) busy = false;
    if (done) reveal(g.turn);
    else if (current === g.turn) finishStage();
  }

  // Touch: the page keeps vertical scrolling and its own two-finger pinch;
  // sideways is ours unless the zoomed page can pan that way.
  wrap.addEventListener('touchstart', (event) => {
    if (event.touches.length !== 1) { if (gesture) endGesture(true); return; }
    const touch = event.touches[0];
    startGesture(touch.clientX, touch.clientY, 'touch');
  }, { passive: true });
  wrap.addEventListener('touchmove', (event) => {
    if (!gesture) return;
    if (event.touches.length !== 1) { endGesture(true); return; }
    const touch = event.touches[0];
    moveGesture(touch.clientX, touch.clientY, event);
  }, { passive: false });
  wrap.addEventListener('touchend', () => endGesture(false));
  wrap.addEventListener('touchcancel', () => endGesture(true));
  // A mouse drags the page the same way.
  wrap.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    startGesture(event.clientX, event.clientY, 'mouse');
  });
  window.addEventListener('pointermove', (event) => {
    if (gesture?.pointerType !== 'mouse') return;
    moveGesture(event.clientX, event.clientY, event);
  });
  window.addEventListener('pointerup', (event) => {
    if (gesture?.pointerType === 'mouse' && event.pointerType === 'mouse') endGesture(false);
  });
  // A drag that turned the page was not a click on the word it began on.
  wrap.addEventListener('click', (event) => {
    if (performance.now() < suppressClickUntil) {
      event.stopPropagation();
      event.preventDefault();
    }
  }, true);
  // The page claims sideways touches only while it can't pan sideways.
  function refreshTouchAction() {
    const panX = scroll.scrollWidth - scroll.clientWidth > 1;
    if (scroll.classList.contains('daf-book-can-pan') !== panX) scroll.classList.toggle('daf-book-can-pan', panX);
  }
  if (window.ResizeObserver) {
    const resize = new ResizeObserver(refreshTouchAction);
    resize.observe(scroll);
    resize.observe(wrap);
  }
  // Zoom changes the page's transform, not its box.
  new MutationObserver(refreshTouchAction).observe(wrap, { attributes: true, attributeFilter: ['style'] });
  card.classList.add('daf-book');
  refreshTouchAction();

  // --- The dial ---------------------------------------------------------------
  // A drum of daf numbers (Hebrew above, the number below), higher dapim to
  // the left as in a Hebrew book. Spin it and let go: the pages riffle to that
  // daf's amud a. It covers the dapim of the masechta on the page.
  const TICK = 46;
  const dial = document.createElement('div');
  dial.className = 'daf-book-dial';
  dial.id = 'dafBookDial';
  dial.hidden = true;
  dial.innerHTML = `
    <div class="daf-book-drum" id="dafBookDrum" role="slider" tabindex="0" aria-label="Daf">
      <div class="dbd-knurl"></div>
      <div class="dbd-ticks"></div>
      <div class="dbd-window"></div>
    </div>
    <button type="button" class="daf-book-sound" id="dafBookSoundButton" aria-pressed="true">
      <svg class="dbs-on" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/><path d="M19 6a8.5 8.5 0 0 1 0 12"/></svg>
      <svg class="dbs-off" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M17 9l5 6"/><path d="M22 9l-5 6"/></svg>
    </button>`;
  const heading = card.querySelector('.daf-heading');
  if (heading) heading.after(dial);
  else card.prepend(dial);
  const drum = dial.querySelector('.daf-book-drum');
  const ticksEl = dial.querySelector('.dbd-ticks');
  const knurl = dial.querySelector('.dbd-knurl');
  $('dafBookSoundButton').addEventListener('click', () => {
    setSound(!soundOn);
    if (soundOn) sounds.tick();
  });
  setSound(soundOn);

  function hebrewNumber(n) {
    const ones = ['', 'א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט'];
    const tens = ['', 'י', 'כ', 'ל', 'מ', 'נ', 'ס', 'ע', 'פ', 'צ'];
    let rest = n;
    let out = '';
    while (rest >= 100) { const h = Math.min(4, Math.floor(rest / 100)); out += ['', 'ק', 'ר', 'ש', 'ת'][h]; rest -= h * 100; }
    if (rest === 15) return `${out}טו`;
    if (rest === 16) return `${out}טז`;
    return out + tens[Math.floor(rest / 10)] + ones[rest % 10];
  }

  let dialTractate = null;
  let dialDapim = [];   // the masechta's dapim, in order
  let dialTicks = [];   // one element per daf
  let dialValue = 0;    // index into dialDapim, fractional while spinning
  let dialHeld = null;  // the drag/glide in progress
  let dialLastTick = null;
  function dialEntry(tractate) {
    try { return syncState.talmudByName?.[tractate] || null; } catch { return null; }
  }
  function buildDial(tractate) {
    const entry = dialEntry(tractate);
    if (!entry || typeof dafOptionsFor !== 'function') return false;
    dialTractate = tractate;
    dialDapim = dafOptionsFor(entry);
    ticksEl.replaceChildren();
    dialTicks = dialDapim.map((daf) => {
      const tick = document.createElement('div');
      tick.className = 'dbd-tick';
      tick.innerHTML = `<span class="dbd-mark"></span><span class="dbd-he" dir="rtl">${hebrewNumber(daf)}</span><span class="dbd-num">${daf}</span>`;
      ticksEl.appendChild(tick);
      return tick;
    });
    drum.setAttribute('aria-valuemin', String(dialDapim[0]));
    drum.setAttribute('aria-valuemax', String(dialDapim[dialDapim.length - 1]));
    return true;
  }
  let dialPainted = false;
  function paintDial() {
    const width = drum.clientWidth;
    dialPainted = width > 0;
    if (!width) return;
    const center = width / 2;
    dialTicks.forEach((tick, i) => {
      const x = center - (i - dialValue) * TICK;
      const rel = (x - center) / center;
      if (Math.abs(rel) >= 1.05) { tick.style.display = 'none'; return; }
      tick.style.display = '';
      const near = Math.abs(i - dialValue) < 0.5;
      tick.classList.toggle('is-current', near);
      tick.style.transform = `translateX(${(x - TICK / 2).toFixed(1)}px) scaleX(${(1 - 0.45 * rel * rel).toFixed(3)})`;
      tick.style.opacity = (1 - 0.8 * Math.pow(Math.min(1, Math.abs(rel)), 1.4)).toFixed(3);
    });
    knurl.style.backgroundPosition = `${(dialValue * TICK).toFixed(1)}px 0`;
    const shown = dialDapim[clamp(Math.round(dialValue), 0, dialDapim.length - 1)];
    drum.setAttribute('aria-valuenow', String(shown));
    drum.setAttribute('aria-valuetext', `${dialTractate} ${shown}`);
  }
  function syncDial() {
    const p = here();
    if (!p) return;
    if (p.tractate !== dialTractate && !buildDial(p.tractate)) return;
    dial.hidden = false;
    if (dialHeld) return;
    const index = dialDapim.indexOf(p.daf);
    if (index === -1 || (index === dialValue && dialPainted)) return;
    dialValue = index;
    dialLastTick = index;
    paintDial();
  }
  function setDialValue(value) {
    dialValue = clamp(value, 0, dialDapim.length - 1);
    const near = Math.round(dialValue);
    if (near !== dialLastTick) { dialLastTick = near; sounds.tick(); }
    paintDial();
  }
  drum.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !dialDapim.length) return;
    event.preventDefault();
    try { drum.setPointerCapture(event.pointerId); } catch { /* not capturable */ }
    audio();
    cancelAnimationFrame(dialHeld?.glide);
    dialHeld = { x: event.clientX, value: dialValue, start: dialValue, samples: [{ t: performance.now(), x: event.clientX }] };
    drum.classList.add('is-held');
  });
  drum.addEventListener('pointermove', (event) => {
    if (!dialHeld || dialHeld.glide) return;
    setDialValue(dialHeld.value + (event.clientX - dialHeld.x) / TICK);
    dialHeld.samples.push({ t: performance.now(), x: event.clientX });
    if (dialHeld.samples.length > 6) dialHeld.samples.shift();
  });
  const letGo = () => {
    const held = dialHeld;
    if (!held || held.glide) return;
    drum.classList.remove('is-held');
    // A flick keeps it spinning, slowing, before it settles on a daf.
    const recent = held.samples.filter((s) => performance.now() - s.t < 90);
    let velocity = 0; // dapim per ms
    if (recent.length >= 2) {
      const a = recent[0];
      const b = recent[recent.length - 1];
      if (b.t > a.t) velocity = (b.x - a.x) / (b.t - a.t) / TICK;
    }
    let last = performance.now();
    const glide = (now) => {
      const dt = Math.min(40, now - last);
      last = now;
      velocity *= Math.pow(0.992, dt);
      setDialValue(dialValue + velocity * dt);
      const atEnd = dialValue <= 0 || dialValue >= dialDapim.length - 1;
      if (Math.abs(velocity) > 0.0012 && !atEnd) { held.glide = requestAnimationFrame(glide); return; }
      settleDial();
    };
    if (Math.abs(velocity) > 0.004 && !motionOff()) held.glide = requestAnimationFrame(glide);
    else settleDial();
  };
  drum.addEventListener('pointerup', letGo);
  drum.addEventListener('pointercancel', letGo);
  async function settleDial() {
    const target = Math.round(dialValue);
    await animate(dialValue, target, 160, (v) => { dialValue = v; paintDial(); });
    dialHeld = null;
    flyTo(dialDapim[target]);
  }
  // Keys: left is a higher daf, as the drum reads; the turn waits for a pause.
  let keyTimer = null;
  drum.addEventListener('keydown', (event) => {
    const steps = { ArrowLeft: 1, ArrowRight: -1, ArrowUp: 1, ArrowDown: -1, PageUp: 10, PageDown: -10 };
    let next = null;
    if (event.key in steps) next = Math.round(dialValue) + steps[event.key];
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = dialDapim.length - 1;
    else if (event.key === 'Enter') { clearTimeout(keyTimer); flyTo(dialDapim[Math.round(dialValue)]); return; }
    if (next === null) return;
    event.preventDefault();
    dialHeld = dialHeld || { keys: true };
    setDialValue(next);
    clearTimeout(keyTimer);
    keyTimer = setTimeout(() => { dialHeld = null; flyTo(dialDapim[Math.round(dialValue)]); }, 650);
  });
  window.addEventListener('resize', () => { dialPainted = false; paintDial(); });

  // Riffle to a daf: a few quick leaves, then its amud a.
  async function flyTo(daf) {
    const p = here();
    if (!p || daf === undefined) return;
    if (daf === p.daf) { syncDial(); return; }
    const target = { tractate: p.tractate, daf, amud: (typeof amudimForDaf === 'function' && amudimForDaf(dialEntry(p.tractate), daf)[0]) || 'a' };
    if (coverShowing()) openCover({ quick: true });
    if (busy || motionOff() || !pageShowing()) { go(target); return; }
    const token = ++turnToken;
    busy = true;
    const direction = daf > p.daf ? 1 : -1;
    const targetKey = keyOf(target);
    const picture = prepare(targetKey);
    const flips = clamp(Math.abs(dialDapim.indexOf(daf) - dialDapim.indexOf(p.daf)), 2, 7);
    const first = snapshot();
    finishStage();
    const parts = makeStage();
    const t = { parts, direction, target, targetKey };
    current = t;
    go(target);
    for (let i = 0; i < flips && current === t; i += 1) {
      const last = i === flips - 1;
      if (direction > 0) {
        show(parts.face, i === 0 ? first : null);
        show(parts.under, last ? pictureNow(targetKey) : null);
      } else {
        show(parts.face, last ? pictureNow(targetKey) : null);
        show(parts.under, i === 0 ? first : null);
      }
      sounds.riffle();
      await animate(0, 1, last ? 260 : 110, (q) => pose(parts, direction, q));
    }
    if (current === t) land(0, 0.08);
    if (token === turnToken) busy = false;
    await Promise.race([picture, wait(50)]);
    reveal(t);
  }

  // --- The cover --------------------------------------------------------------
  // On a plain visit (the menu's Interactive Daf), the daf waits behind the
  // masechta's cover; a link to a particular daf goes straight to the page.
  const params = new URLSearchParams(location.search);
  const fromMenu = !params.has('ref') && !params.get('view') && !params.has('scan')
    && window.__DAFSYNC_TEST_CONTROL__?.bookCover !== false;
  let cover = null;
  function coverShowing() { return Boolean(cover); }
  let hebrewNames = {};
  import('/shared/masechtos.mjs')
    .then((module) => {
      hebrewNames = Object.fromEntries((module.MASECHTOS || []).map((m) => [m.name, m.hebrew]));
      paintCoverName();
    })
    .catch(() => {});
  function paintCoverName() {
    const name = cover?.querySelector('.dbc-masechta');
    if (!name) return;
    const tractate = here()?.tractate;
    name.textContent = hebrewNames[tractate] || '';
    cover.setAttribute('aria-label', `Open the Gemara${tractate ? `, Maseches ${tractate}` : ''}`);
  }
  function buildCover() {
    placeholder.classList.add('daf-book-closed');
    cover = document.createElement('button');
    cover.type = 'button';
    cover.className = 'daf-book-cover';
    cover.innerHTML = `
      <span class="dbc-board">
        <span class="dbc-spine"></span>
        <span class="dbc-frame"></span>
        <span class="dbc-corner dbc-tl"></span><span class="dbc-corner dbc-tr"></span>
        <span class="dbc-corner dbc-bl"></span><span class="dbc-corner dbc-br"></span>
        <span class="dbc-title" dir="rtl">
          <span class="dbc-gold dbc-talmud">תלמוד בבלי</span>
          <span class="dbc-rule"></span>
          <span class="dbc-medallion"><span class="dbc-mark"></span></span>
          <span class="dbc-gold dbc-maseches">מסכת</span>
          <span class="dbc-gold dbc-masechta"></span>
          <span class="dbc-rule"></span>
          <span class="dbc-gold dbc-perush">עם פירוש רש״י ותוספות</span>
          <span class="dbc-gold dbc-brand" dir="ltr">DAFSYNC</span>
        </span>
      </span>
      <span class="dbc-hint">Tap to open</span>`;
    placeholder.prepend(cover);
    paintCoverName();
    cover.addEventListener('click', () => openCover());
    // A swipe on the cover opens it too.
    let start = null;
    cover.addEventListener('touchstart', (event) => { start = event.touches[0] ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null; }, { passive: true });
    cover.addEventListener('touchmove', (event) => {
      if (!start || !event.touches[0]) return;
      const dx = event.touches[0].clientX - start.x;
      const dy = event.touches[0].clientY - start.y;
      if (dx > 30 && Math.abs(dx) > Math.abs(dy) * 1.3) { start = null; openCover(); }
    }, { passive: true });
  }
  async function openCover({ quick = false } = {}) {
    const closing = cover;
    if (!closing || closing.classList.contains('is-opening')) return;
    closing.classList.add('is-opening');
    if (!quick) sounds.cover();
    const board = closing.querySelector('.dbc-board');
    if (quick || motionOff()) {
      closing.classList.add('is-fading');
      await wait(quick ? 0 : 220);
    } else {
      await animate(0, 1, 900, (p) => {
        const angle = easeInOut(p) * 180;
        board.style.transform = `rotateY(${angle.toFixed(2)}deg)`;
        board.style.visibility = angle >= 89.5 ? 'hidden' : 'visible';
      });
    }
    closing.remove();
    if (cover === closing) cover = null;
    placeholder.classList.remove('daf-book-closed');
    prepareNeighbours();
  }
  if (fromMenu) buildCover();

  // --- Keeping up with the page ------------------------------------------------
  let lastKey = null;
  const watchPage = () => {
    const p = here();
    const key = p ? keyOf(p) : null;
    if (key && key !== lastKey && pageReady(key)) { lastKey = key; prepareNeighbours(); }
    if (p && (p.tractate !== dialTractate || !dialHeld)) syncDial();
    if (cover && p) paintCoverName();
  };
  window.addEventListener('dafsync:vilna-page', watchPage);
  for (const id of ['dafTractateSelect', 'dafDafSelect']) $(id)?.addEventListener('change', () => setTimeout(watchPage, 0));
  // The index and the first page arrive after this file runs, and a page can
  // finish drawing without an event; a light check keeps up with both.
  setInterval(watchPage, 500);

  window.dafBook = {
    turn(direction) {
      if (coverShowing()) { openCover({ quick: true }); return false; }
      if (!canTurn(direction)) return false;
      turn(direction);
      return true;
    },
    openCover,
    setSound,
    get soundOn() { return soundOn; },
  };
})();
