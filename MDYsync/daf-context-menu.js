'use strict';

// Right-click (and long-press) menu on the daf itself, on BOTH views:
//
//   * the printed Vilna page, where there is no real text to right-click --
//     the page is a rasterized image, so the word under the pointer is found
//     by hit-testing the same normalized wordBoxes every other overlay on
//     that page already uses (no DOM word targets needed, so this works
//     whether or not Select-text mode happens to be on, and a right-click
//     inside an active selection there acts on that whole selection --
//     however many refs it spans -- rather than just the word under the
//     pointer, see vilnaTargetAt);
//   * the plain text view, where the words ARE real DOM text, so the word is
//     found from the caret position under the pointer instead, and an
//     existing native selection wins over it when there is one (still
//     limited to one segment span in this view -- see textTargetAt).
//
// Both resolve to the same shape -- ref/start/end (a segment ref plus
// inclusive word indices in that ref's own paragraph, for whichever
// consumer only needs the FIRST word/run) alongside `runs`, the full
// [{ ref, start, end }, ...] list in reading order (almost always one
// entry, more when a Vilna-page selection crossed into another paragraph).
// This is exactly what word-range notes and highlights already anchor to,
// so every action below is a thin wrapper over machinery that already
// exists (openForSelection, the notes search dialog,
// resolveWordRangeRunsText, the reports table).
//
// Classic deferred script sharing app.js/notes.js top-level bindings, same
// as notes.js/highlights.js/account-features.js.

const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_TOLERANCE = 10;

let menuEl = null;
let menuTarget = null;
// Deadline (not a plain flag) for swallowing the click the browser
// synthesizes at the end of a long press, so it doesn't also seek the video
// underneath. It has to expire on its own: plenty of browsers suppress that
// click themselves once a long press has happened, and a flag left armed for
// a click that never comes would silently eat the reader's next real tap
// instead -- minutes later, somewhere else entirely.
let suppressClickUntil = 0;
const SUPPRESS_CLICK_WINDOW_MS = 700;
// `${ref}:${start}-${end}` -> resolved Hebrew text. resolveWordRangeText
// re-fetches Sefaria on every call (see fetchSefariaParagraphs -- no cache of
// its own), and Copy/Search/Look up on one menu would otherwise each pay for
// their own round trip.
const wordTextCache = new Map();

// --- Menu shell ------------------------------------------------------------

function ensureMenuEl() {
  if (menuEl) return menuEl;
  menuEl = document.createElement('div');
  menuEl.className = 'daf-context-menu';
  menuEl.setAttribute('role', 'menu');
  menuEl.hidden = true;
  document.body.appendChild(menuEl);
  return menuEl;
}

function closeDafMenu() {
  if (!menuEl || menuEl.hidden) return;
  menuEl.hidden = true;
  menuEl.innerHTML = '';
  menuTarget = null;
}

function renderMenuItems(items) {
  const el = ensureMenuEl();
  el.innerHTML = items.map((item, index) => {
    if (item.separator) return '<div class="daf-context-sep"></div>';
    const hint = item.hint ? `<span class="daf-context-hint">${escapeHtml(item.hint)}</span>` : '';
    return `<button type="button" class="daf-context-item" role="menuitem" data-index="${index}"${item.disabled ? ' disabled' : ''}>${escapeHtml(item.label)}${hint}</button>`;
  }).join('');
  el.querySelectorAll('.daf-context-item').forEach((button) => {
    button.addEventListener('click', () => {
      const item = items[Number(button.dataset.index)];
      closeDafMenu();
      item?.onClick?.();
    });
  });
}

function positionMenu(x, y) {
  const el = ensureMenuEl();
  // Measured after it is laid out at a known origin -- the menu's own size
  // depends on its longest label, which varies per target.
  el.style.left = '0px';
  el.style.top = '0px';
  const rect = el.getBoundingClientRect();
  const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

function openDafMenu(target, x, y) {
  menuTarget = target;
  const el = ensureMenuEl();
  renderMenuItems(buildMenuItems(target));
  el.hidden = false;
  positionMenu(x, y);

  // The literal words are only needed for the labels that quote them (and
  // for Copy/Search/Look up when they run) -- fetched once, in the
  // background, with the labels refreshed in place if the menu is still
  // showing the same target when it lands.
  resolveTargetText(target).then((text) => {
    if (menuTarget !== target || !text) return;
    target.text = text;
    renderMenuItems(buildMenuItems(target));
    positionMenu(x, y);
  }).catch(() => {});
}

// --- Resolving what was clicked --------------------------------------------

// The segment covering a word, for the video timestamp action. A segment
// with no word bounds covers its whole ref.
function segmentForWord(ref, wordIndex) {
  const segments = (state.segments || []).filter((segment) => segment.ref === ref);
  return segments.find((segment) => segment.w0 == null || segment.w1 == null
    || (wordIndex >= segment.w0 && wordIndex <= segment.w1)) || segments[0] || null;
}

// Hit-tests the printed page's own word boxes (normalized 0..1 against the
// page wrap, which is also what every overlay there is positioned against,
// so this stays correct under zoom -- getBoundingClientRect already accounts
// for the wrap's transform). Falls back to the nearest box within a short
// radius so a click in the gap between two words still resolves to one.
function vilnaWordAt(clientX, clientY) {
  const wrap = $('vilnaPageWrap');
  const map = state.vilnaPageMap;
  if (!wrap || !map?.wordBoxes?.length) return null;
  const rect = wrap.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const nx = (clientX - rect.left) / rect.width;
  const ny = (clientY - rect.top) / rect.height;

  let nearest = null;
  let nearestDistance = Infinity;
  for (const box of map.wordBoxes) {
    if (nx >= box.x && nx <= box.x + box.w && ny >= box.y && ny <= box.y + box.h) return box;
    const dx = nx - (box.x + box.w / 2);
    // Vertical distance counts for more: the neighbouring word on the same
    // printed line is a far better guess than one directly above or below.
    const dy = (ny - (box.y + box.h / 2)) * 3;
    const distance = Math.hypot(dx, dy);
    if (distance < nearestDistance) { nearestDistance = distance; nearest = box; }
  }
  return nearestDistance <= 0.03 ? nearest : null;
}

function vilnaTargetAt(clientX, clientY) {
  const box = vilnaWordAt(clientX, clientY);
  if (!box) return null;
  // A right-click inside an active Select-text selection acts on that
  // whole selection -- however many refs it spans -- rather than the one
  // word under the pointer, since the reader already said what they meant
  // by dragging it.
  const selection = state.textSelection;
  const inSelection = selection?.runs.some((run) => run.ref === box.ref
    && box.wordIndex >= run.start && box.wordIndex <= run.end);
  const runs = inSelection ? selection.runs : [{ ref: box.ref, start: box.wordIndex, end: box.wordIndex }];
  const first = runs[0];
  return {
    source: 'vilna',
    ref: first.ref,
    start: first.start,
    end: first.end,
    text: null,
    segment: segmentForWord(first.ref, first.start),
    runs,
  };
}

// Character offset -> index of the word that offset falls in (or starts).
function wordIndexFromOffset(text, offset) {
  const before = text.slice(0, Math.max(0, offset));
  const words = before.split(/\s+/).filter(Boolean);
  const atBoundary = before.length === 0 || /\s$/.test(before);
  return atBoundary ? words.length : Math.max(0, words.length - 1);
}

function caretOffsetAt(clientX, clientY) {
  if (document.caretRangeFromPoint) {
    const range = document.caretRangeFromPoint(clientX, clientY);
    return range ? { node: range.startContainer, offset: range.startOffset } : null;
  }
  if (document.caretPositionFromPoint) {
    const position = document.caretPositionFromPoint(clientX, clientY);
    return position ? { node: position.offsetNode, offset: position.offset } : null;
  }
  return null;
}

// The segment span's own Hebrew text lives in a bare text node beside its
// marker <sup> (and its note button) -- see buildSegmentSpan in app.js.
function segmentTextNode(span) {
  return [...span.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.nodeValue.trim()) || null;
}

function textTargetAt(clientX, clientY) {
  const span = document.elementFromPoint(clientX, clientY)?.closest?.('.daf-segment');
  if (!span) return null;
  const index = Number(span.dataset.index);
  const segment = state.segments?.[index];
  if (!segment || !segment.ref) return null;
  const base = segment.w0 ?? 0;
  const textNode = segmentTextNode(span);
  const words = (textNode?.nodeValue || '').split(/\s+/).filter(Boolean);

  // An existing selection inside this same segment wins over the caret --
  // "copy what I selected" is unambiguous, and it is the only way to reach
  // a multi-word range in this view.
  const selection = window.getSelection?.();
  if (textNode && selection && !selection.isCollapsed && selection.rangeCount) {
    const range = selection.getRangeAt(0);
    if (range.intersectsNode(textNode) && selection.toString().trim()) {
      const startOffset = range.startContainer === textNode ? range.startOffset : 0;
      const endOffset = range.endContainer === textNode ? range.endOffset : (textNode.nodeValue || '').length;
      const start = wordIndexFromOffset(textNode.nodeValue, startOffset);
      const end = wordIndexFromOffset(textNode.nodeValue, Math.max(startOffset, endOffset - 1));
      return {
        source: 'text',
        ref: segment.ref,
        start: base + start,
        end: base + Math.max(start, end),
        text: selection.toString().trim(),
        segment,
        runs: [{ ref: segment.ref, start: base + start, end: base + Math.max(start, end) }],
      };
    }
  }

  const caret = caretOffsetAt(clientX, clientY);
  if (!textNode || !caret || caret.node !== textNode) {
    // Somewhere in the span but not on its text (the marker, the note
    // button, trailing space) -- still worth a menu, just for the whole line.
    return { source: 'text', ref: segment.ref, start: null, end: null, text: segment.he || null, segment, runs: [] };
  }
  const wordOffset = wordIndexFromOffset(textNode.nodeValue, caret.offset);
  return {
    source: 'text',
    ref: segment.ref,
    start: base + wordOffset,
    end: base + wordOffset,
    text: words[wordOffset] || null,
    segment,
    runs: [{ ref: segment.ref, start: base + wordOffset, end: base + wordOffset }],
  };
}

// --- Text resolution -------------------------------------------------------

function cacheKey(target) {
  const runs = target.runs?.length ? target.runs : [{ ref: target.ref, start: target.start, end: target.end }];
  return runs.map((run) => `${run.ref}:${run.start}-${run.end}`).join('|');
}

async function resolveTargetText(target) {
  if (target.text) return target.text;
  if (target.start == null) return '';
  const key = cacheKey(target);
  if (wordTextCache.has(key)) return wordTextCache.get(key);
  if (typeof resolveWordRangeRunsText !== 'function') return '';
  const runs = target.runs?.length ? target.runs : [{ ref: target.ref, start: target.start, end: target.end }];
  const text = await resolveWordRangeRunsText(runs);
  wordTextCache.set(key, text);
  return text;
}

// Hebrew words on the daf carry nikud and cantillation; the lexicon wants
// the consonantal form, and punctuation around a word (a maqaf, a colon at
// the end of a sugya) is never part of it either.
function bareHebrewWord(word) {
  return String(word || '')
    .replace(/[֑-ׇ]/g, '')
    .replace(/[^א-ת]/g, '')
    .trim();
}

async function withResolvedText(target, action) {
  let text;
  try {
    text = await resolveTargetText(target);
  } catch {
    showToast('Could not read this passage.', 'error');
    return;
  }
  if (!text) {
    showToast('Could not read this passage.', 'error');
    return;
  }
  action(text);
}

// --- Actions ---------------------------------------------------------------

async function copyToClipboard(value, successMessage) {
  try {
    await navigator.clipboard.writeText(value);
    showToast(successMessage);
  } catch {
    // Older/locked-down browsers, or a page that lost transient activation.
    const holder = document.createElement('textarea');
    holder.value = value;
    holder.setAttribute('readonly', '');
    holder.style.cssText = 'position:fixed;top:-1000px;opacity:0;';
    document.body.appendChild(holder);
    holder.select();
    const copied = document.execCommand?.('copy');
    holder.remove();
    showToast(copied ? successMessage : 'Could not copy.', copied ? 'normal' : 'error');
  }
}

function refDisplayOf(target) {
  const parsed = typeof parseDafRef === 'function' ? parseDafRef(target.ref) : null;
  return parsed ? `${parsed.tractate} ${parsed.daf}${parsed.amud}` : String(target.ref || '');
}

function addNoteFor(target) {
  if (target.runs?.length && window.DafNotesComposer) {
    window.DafNotesComposer.openForSelection(target.runs);
    return;
  }
  window.DafNotes?.open(target.ref, target.text || '');
}

function copyLineLink(target) {
  const url = `${location.origin}/browse/?ref=${encodeURIComponent(refDisplayOf(target))}`;
  copyToClipboard(url, 'Link copied.');
}

// Only offered when a YouTube shiur is actually loaded AND this passage has
// a real aligned start time -- a "moment" link built from anything else
// would point at a video that has nothing to do with these words.
function videoMomentUrl(target) {
  const source = state.videoSource;
  if (source?.type !== 'youtube' || !source.videoId) return null;
  const start = target.segment?.start;
  if (typeof start !== 'number' || !Number.isFinite(start)) return null;
  return `https://youtu.be/${source.videoId}?t=${Math.max(0, Math.floor(start))}`;
}

async function flagAnchorProblem(target) {
  const auth = window.DafSyncAuth;
  const user = auth?.getUser();
  if (!user) {
    showToast('Sign in to flag a problem.', 'error');
    return;
  }
  const reason = window.prompt('What looks wrong with this text? (required)');
  if (!reason || !reason.trim()) return;
  const info = typeof currentDafInfo === 'function' ? currentDafInfo() : null;
  let quoted = null;
  try {
    quoted = await resolveTargetText(target);
  } catch { /* the report is still worth filing without the quote */ }
  const { error } = await auth.client.from('reports').insert({
    reporter_id: user.id,
    target_type: 'anchor',
    target_id: null,
    reason: reason.trim().slice(0, 500),
    daf_ref_key: info?.key || null,
    segment_ref: target.ref,
    start_word: target.start,
    end_word: target.end,
    quoted_text: quoted || null,
  });
  if (error) {
    showToast(error.message || 'Could not submit the report.', 'error');
    return;
  }
  showToast('Thanks -- this passage has been flagged for review.');
}

// --- Dictionary lookup -----------------------------------------------------

function htmlToPlainText(value) {
  // DOMParser never runs scripts or loads anything -- this is only being
  // used to drop the markup Sefaria's lexicon entries carry, and the result
  // is escaped again before it goes anywhere near innerHTML.
  const doc = new DOMParser().parseFromString(String(value ?? ''), 'text/html');
  return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
}

function renderLexiconEntries(word, entries) {
  const body = $('wordLookupBody');
  if (!body) return;
  if (!entries.length) {
    body.innerHTML = `<p class="field-note">No dictionary entry found for “${escapeHtml(word)}”.</p>`;
    return;
  }
  body.innerHTML = entries.slice(0, 6).map((entry) => {
    const senses = collectSenses(entry.content).slice(0, 8);
    const definitions = senses.length
      ? `<ul class="word-lookup-senses">${senses.map((sense) => `<li>${escapeHtml(sense)}</li>`).join('')}</ul>`
      : '<p class="field-note">No definition text in this entry.</p>';
    const notes = entry.notes
      ? `<p class="word-lookup-notes">${escapeHtml(htmlToPlainText(entry.notes))}</p>`
      : '';
    return `
      <div class="word-lookup-entry">
        <div class="note-item-head">
          <span class="note-item-author" dir="rtl" lang="he">${escapeHtml(entry.headword || word)}</span>
          <span class="note-pill">${escapeHtml(entry.parent_lexicon || 'Lexicon')}</span>
        </div>
        ${definitions}
        ${notes}
      </div>`;
  }).join('');
}

// Sefaria's lexicon entries nest their senses irregularly (a sense can hold
// its own sub-senses, and either level may carry the definition), so this
// walks whatever shape came back rather than assuming one.
function collectSenses(content) {
  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.definition) {
      const text = htmlToPlainText(node.definition);
      if (text) out.push(text);
    }
    if (node.senses) walk(node.senses);
  };
  walk(content);
  return out;
}

async function lookUpWord(target) {
  const dialog = $('wordLookupDialog');
  if (!dialog) return;
  const title = $('wordLookupTitle');
  const body = $('wordLookupBody');
  await withResolvedText(target, async (text) => {
    // A range lookup only makes sense one word at a time -- the first word
    // of a multi-word selection is the one the reader is most likely after.
    const word = bareHebrewWord(text.split(/\s+/)[0]);
    if (!word) {
      showToast('No Hebrew word to look up here.', 'error');
      return;
    }
    if (title) title.textContent = word;
    if (body) body.innerHTML = '<p class="field-note">Looking up…</p>';
    dialog.showModal();
    try {
      const response = await fetch(`https://www.sefaria.org/api/words/${encodeURIComponent(word)}`);
      if (!response.ok) throw new Error(`Sefaria returned ${response.status}`);
      const entries = await response.json();
      // Sefaria's word lookup can return entries from several lexicons, and
      // their /api/words response carries no license field to tell them
      // apart -- Jastrow (1903) is safely public domain, but Klein
      // Dictionary (Carta, Jerusalem; 1987) is a modern work still well
      // within its copyright term. Filtering to Jastrow here, rather than
      // rendering whichever lexicon happened to answer, is what keeps this
      // feature from ever surfacing text DafSync has no license to show.
      const jastrowEntries = (Array.isArray(entries) ? entries : [])
        .filter((entry) => /jastrow/i.test(entry.parent_lexicon || ''));
      renderLexiconEntries(word, jastrowEntries);
    } catch {
      if (body) body.innerHTML = '<p class="field-note">Could not reach the dictionary just now.</p>';
    }
  });
}

// --- Menu contents ---------------------------------------------------------

function buildMenuItems(target) {
  const user = window.DafSyncAuth?.getUser();
  // True for any multi-word target, whether that's still one run (the
  // ordinary start<end case every action here has always had to handle) or
  // several -- a Select-text drag that crosses into another paragraph can
  // easily have start===end on its OWN first run while still covering many
  // words overall once every run is counted.
  const multiWord = (target.runs?.length > 1) || (target.start != null && target.end > target.start);
  const quoted = target.text ? `“${target.text.split(/\s+/)[0]}”` : 'this word';
  const existingHighlight = target.start != null
    ? window.DafHighlights?.covering(target.ref, target.start)
    : null;
  const momentUrl = videoMomentUrl(target);

  const items = [
    {
      label: multiWord ? 'Add note on this passage' : 'Add note here',
      onClick: () => addNoteFor(target),
    },
    {
      label: existingHighlight ? 'Remove highlight' : (multiWord ? 'Highlight this passage' : 'Highlight this word'),
      disabled: !user || target.start == null,
      hint: !user ? 'sign in' : '',
      onClick: () => withResolvedText(target, (text) => {
        window.DafHighlights?.toggle(target.runs?.length ? target.runs : [{ ref: target.ref, start: target.start, end: target.end }], text);
      }),
    },
    {
      label: `Look up ${quoted} in the dictionary`,
      disabled: target.start == null,
      onClick: () => lookUpWord(target),
    },
    { separator: true },
    {
      label: multiWord ? 'Copy this passage' : 'Copy this word',
      onClick: () => withResolvedText(target, (text) => copyToClipboard(text, 'Text copied.')),
    },
    {
      label: 'Copy link to this line',
      onClick: () => copyLineLink(target),
    },
  ];

  if (momentUrl) {
    items.push({
      label: 'Copy video link at this moment',
      onClick: () => copyToClipboard(momentUrl, 'Video link copied.'),
    });
  }

  items.push(
    { separator: true },
    {
      label: 'Search this in Cloud Chaburah',
      onClick: () => withResolvedText(target, (text) => window.DafNotesSearch?.openWith(text)),
    },
    {
      label: 'Flag a problem with this text',
      disabled: !user,
      hint: !user ? 'sign in' : '',
      onClick: () => flagAnchorProblem(target),
    }
  );
  return items;
}

// --- Wiring ----------------------------------------------------------------

function handleDafContextMenu(event, resolve) {
  const target = resolve(event.clientX, event.clientY);
  if (!target) return;
  event.preventDefault();
  openDafMenu(target, event.clientX, event.clientY);
}

function attachLongPress(el, resolve) {
  let timer = null;
  let startX = 0;
  let startY = 0;

  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  el.addEventListener('touchstart', (event) => {
    if (event.touches.length !== 1) return;
    const touch = event.touches[0];
    startX = touch.clientX;
    startY = touch.clientY;
    cancel();
    timer = setTimeout(() => {
      timer = null;
      const target = resolve(startX, startY);
      if (!target) return;
      // The browser may still synthesize a click at the end of this touch --
      // without this it would fall through to the phrase overlay and seek
      // the video the moment the menu appeared.
      suppressClickUntil = Date.now() + SUPPRESS_CLICK_WINDOW_MS;
      navigator.vibrate?.(15);
      openDafMenu(target, startX, startY);
    }, LONG_PRESS_MS);
  }, { passive: true });

  el.addEventListener('touchmove', (event) => {
    const touch = event.touches[0];
    if (!touch) return;
    if (Math.abs(touch.clientX - startX) > LONG_PRESS_MOVE_TOLERANCE
      || Math.abs(touch.clientY - startY) > LONG_PRESS_MOVE_TOLERANCE) cancel();
  }, { passive: true });
  el.addEventListener('touchend', cancel, { passive: true });
  el.addEventListener('touchcancel', cancel, { passive: true });
}

function initDafContextMenu() {
  const wrap = $('vilnaPageWrap');
  const page = $('dafPage');
  if (!wrap && !page) return; // no daf on this page (e.g. studio)

  if (wrap) {
    wrap.addEventListener('contextmenu', (event) => handleDafContextMenu(event, vilnaTargetAt));
    attachLongPress(wrap, vilnaTargetAt);
  }
  if (page) {
    page.addEventListener('contextmenu', (event) => handleDafContextMenu(event, textTargetAt));
    attachLongPress(page, textTargetAt);
  }

  $('closeWordLookupDialog')?.addEventListener('click', () => $('wordLookupDialog').close());

  document.addEventListener('click', (event) => {
    if (Date.now() < suppressClickUntil) {
      suppressClickUntil = 0;
      event.stopPropagation();
      event.preventDefault();
      return;
    }
    if (menuEl && !menuEl.hidden && !menuEl.contains(event.target)) closeDafMenu();
  }, true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeDafMenu();
  });
  window.addEventListener('resize', closeDafMenu);
  window.addEventListener('scroll', closeDafMenu, true);
}

window.DafContextMenu = { close: closeDafMenu };

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initDafContextMenu);
} else {
  initDafContextMenu();
}
