'use strict';

// Personal word-level highlights on the daf -- the reader's own marker pen,
// strictly private (see the highlights table's own owner-only RLS policy),
// with none of the sharing/discussion machinery a note carries. Anchored the
// same way a word-range note is (segment ref + inclusive word indices), so
// the same wordBoxes/segment data already powering notes renders them on the
// printed Vilna page, and the same word indexing maps them onto the plain
// text view.
//
// Runs as a classic deferred script after app.js/notes.js, sharing their
// top-level bindings (state, $, escapeHtml, showToast, currentDafInfo,
// groupBoxesIntoLineRects, vilnaInkBands, appendLineRects) the same way
// notes.js and account-features.js already do.

// segment_ref -> [row], for whichever daf is currently on screen.
let highlightsByRef = new Map();
let highlightsDafKey = null;

function highlightsFor(ref) {
  return highlightsByRef.get(ref) || [];
}

// A highlight row's own runs -- word_ranges (see toggleHighlight) is the
// authoritative shape once a highlight can span more than one ref;
// start_word/end_word/segment_ref still mirror its FIRST run for whichever
// older row (or query) only ever knew that trio.
function highlightRuns(row) {
  return row.word_ranges?.length
    ? row.word_ranges
    : [{ ref: row.segment_ref, start: row.start_word, end: row.end_word }];
}

// The highlight (if any) covering one specific word -- what the context
// menu needs to decide between offering "Highlight" and "Remove highlight".
// Checks every run of a candidate row, not just its first -- highlightsFor
// already only returns rows that touch THIS ref at all (see
// loadHighlightsForCurrentDaf, which now buckets a row under every ref its
// runs touch, not just its primary one), but a row can still have OTHER
// runs on other refs, so which run actually covers wordIndex still needs
// checking.
function highlightCovering(ref, wordIndex) {
  return highlightsFor(ref).find((row) => highlightRuns(row)
    .some((run) => run.ref === ref && wordIndex >= run.start && wordIndex <= run.end)) || null;
}

async function loadHighlightsForCurrentDaf() {
  const auth = window.DafSyncAuth;
  const user = auth?.getUser();
  const info = typeof currentDafInfo === 'function' ? currentDafInfo() : null;
  if (!user || !info) {
    highlightsByRef = new Map();
    highlightsDafKey = null;
    renderHighlights();
    return;
  }
  const { data, error } = await auth.client
    .from('highlights').select('*')
    .eq('user_id', user.id)
    .eq('daf_ref_key', info.key)
    .order('start_word', { ascending: true });
  if (error) return;
  highlightsByRef = new Map();
  // Bucketed under EVERY ref its runs touch, not just its primary
  // segment_ref -- a multi-ref highlight (see toggleHighlight) needs to be
  // findable by highlightCovering/highlightsFor regardless of which of its
  // runs a reader is actually looking at.
  for (const row of data || []) {
    const seenRefs = new Set();
    for (const run of highlightRuns(row)) {
      if (seenRefs.has(run.ref)) continue;
      seenRefs.add(run.ref);
      if (!highlightsByRef.has(run.ref)) highlightsByRef.set(run.ref, []);
      highlightsByRef.get(run.ref).push(row);
    }
  }
  highlightsDafKey = info.key;
  renderHighlights();
}

// Insert or remove -- a right-click on an already-highlighted word offers
// removal of the whole highlight it falls inside, not a partial un-highlight
// (splitting one highlight into two on a middle word would be surprising).
// runs is the same [{ ref, start, end }, ...] shape a Select-text
// selection's own state.textSelection.runs carries (see app.js) -- almost
// always one run, but never assumed to be.
async function toggleHighlight(runs, selectedText) {
  const auth = window.DafSyncAuth;
  const user = auth?.getUser();
  const info = typeof currentDafInfo === 'function' ? currentDafInfo() : null;
  if (!user || !info || !runs?.length) return;
  const firstRun = runs[0];
  const existing = highlightCovering(firstRun.ref, firstRun.start);
  if (existing) {
    const { error } = await auth.client.from('highlights').delete().eq('id', existing.id);
    if (error) {
      showToast(error.message || 'Could not remove the highlight.', 'error');
      return;
    }
    showToast('Highlight removed.');
  } else {
    const { error } = await auth.client.from('highlights').insert({
      user_id: user.id,
      daf_ref_key: info.key,
      segment_ref: firstRun.ref,
      start_word: firstRun.start,
      end_word: firstRun.end,
      selected_text: selectedText || null,
      word_ranges: runs,
    });
    if (error) {
      showToast(error.message || 'Could not save the highlight.', 'error');
      return;
    }
    showToast('Highlighted.');
  }
  await loadHighlightsForCurrentDaf();
}

// --- Rendering -------------------------------------------------------------

function renderHighlights() {
  renderVilnaHighlightOverlay();
  // The text view rebuilds its spans constantly (every active-segment
  // change re-runs renderDafWindow), so highlights are applied there as
  // part of that render rather than patched in afterwards -- this just
  // asks for a fresh one now that the data changed.
  if (typeof renderDafWindow === 'function' && document.getElementById('dafPage')) renderDafWindow();
}

function renderVilnaHighlightOverlay() {
  const overlay = document.getElementById('vilnaHighlightsOverlay');
  if (!overlay) return;
  overlay.innerHTML = '';
  if (!state.vilnaPageMap || !highlightsByRef.size) return;
  const bands = vilnaInkBands(state.vilnaPageMap);
  // A multi-ref highlight now sits in more than one of highlightsByRef's
  // own buckets (see loadHighlightsForCurrentDaf) -- rendered once here
  // regardless, tracked by id, so it doesn't draw its shared runs twice.
  const seen = new Set();
  for (const rows of highlightsByRef.values()) {
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      for (const run of highlightRuns(row)) {
        const boxes = state.vilnaPageMap.wordBoxes
          .filter((box) => box.ref === run.ref && box.wordIndex >= run.start && box.wordIndex <= run.end)
          .sort((a, b) => a.wordIndex - b.wordIndex);
        if (!boxes.length) continue;
        appendLineRects(overlay, groupBoxesIntoLineRects(boxes, state.vilnaPageMap, bands), 'vilna-highlight-rect');
      }
    }
  }
}

// Absolute word index of a segment's FIRST word within its ref's own
// paragraph -- the indexing highlights (and word-range notes) are stored in.
// A segment carrying no word-level boundary can only be placed when it is
// the ref's only segment; otherwise there is no honest way to know which
// slice of the paragraph it is, and decorating the wrong words is worse
// than not decorating at all.
function segmentWordBase(segment) {
  if (segment.w0 != null) return segment.w0;
  const sameRef = state.segments.filter((s) => s.ref === segment.ref);
  return sameRef.length === 1 ? 0 : null;
}

// Called from buildSegmentSpan (app.js) once the span's own text is in
// place: re-splits that text node into words and wraps whichever ones fall
// inside a highlight. Rebuilding the node this way (rather than a regex over
// innerHTML) keeps the segment's own markup -- its marker <sup> and note
// button -- untouched.
function applyHighlightsToSegmentSpan(span, segment) {
  const rows = highlightsFor(segment.ref);
  if (!rows.length) return;
  const base = segmentWordBase(segment);
  if (base == null) return;
  const textNode = [...span.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.nodeValue.trim());
  if (!textNode) return;

  // Only the runs that actually touch THIS segment's own ref -- a
  // multi-ref highlight's other runs belong to a different segment's span
  // entirely, rendered there instead when buildSegmentSpan gets to it.
  const runs = rows.flatMap((row) => highlightRuns(row).filter((run) => run.ref === segment.ref));

  const raw = textNode.nodeValue;
  const parts = raw.split(/(\s+)/); // keeps the whitespace runs as their own parts
  const fragment = document.createDocumentFragment();
  let wordOffset = 0;
  for (const part of parts) {
    if (!part) continue;
    if (/^\s+$/.test(part)) {
      fragment.appendChild(document.createTextNode(part));
      continue;
    }
    const absolute = base + wordOffset;
    wordOffset += 1;
    if (runs.some((run) => absolute >= run.start && absolute <= run.end)) {
      const mark = document.createElement('mark');
      mark.className = 'daf-highlight';
      mark.textContent = part;
      fragment.appendChild(mark);
    } else {
      fragment.appendChild(document.createTextNode(part));
    }
  }
  span.replaceChild(fragment, textNode);
}

// --- "My highlights" dialog ------------------------------------------------

async function openHighlightsDialog() {
  const dialog = document.getElementById('highlightsDialog');
  const list = document.getElementById('highlightsList');
  if (!dialog || !list) return;
  // Re-entrant: deleting from inside the dialog re-runs this to refresh the
  // list, and showModal() on an already-open dialog throws.
  if (!dialog.open) dialog.showModal();
  list.innerHTML = '<p class="field-note">Loading…</p>';
  const auth = window.DafSyncAuth;
  const user = auth?.getUser();
  if (!user) {
    list.innerHTML = '<p class="field-note">Sign in to keep highlights.</p>';
    return;
  }
  const { data, error } = await auth.client
    .from('highlights').select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) {
    list.innerHTML = '<p class="field-note">Could not load your highlights.</p>';
    return;
  }
  const rows = data || [];
  if (!rows.length) {
    list.innerHTML = '<p class="field-note">No highlights yet. Right-click (or long-press) any word on the daf to make one.</p>';
    return;
  }
  list.innerHTML = rows.map((row) => {
    const refDisplay = row.daf_ref_key.replace(/-/g, ' ');
    const quote = row.selected_text
      ? `<p class="note-item-quote" dir="rtl" lang="he">${escapeHtml(row.selected_text)}</p>`
      : '<p class="field-note">(no text saved)</p>';
    return `
      <div class="note-item" data-id="${row.id}">
        <div class="note-item-head">
          <a class="note-pill" href="/browse/index.html?ref=${encodeURIComponent(refDisplay)}">${escapeHtml(refDisplay)}</a>
          <span class="note-item-time">${formatNoteTime(row.created_at)}</span>
          <button type="button" class="note-delete-button highlight-delete-button" data-id="${row.id}" aria-label="Delete highlight">×</button>
        </div>
        ${quote}
      </div>`;
  }).join('');
  list.querySelectorAll('.highlight-delete-button').forEach((button) => {
    button.addEventListener('click', async () => {
      const { error: deleteError } = await auth.client.from('highlights').delete().eq('id', button.dataset.id);
      if (deleteError) {
        showToast(deleteError.message || 'Could not delete the highlight.', 'error');
        return;
      }
      openHighlightsDialog();
      loadHighlightsForCurrentDaf();
    });
  });
}

function initHighlights() {
  if (!document.getElementById('vilnaHighlightsOverlay') && !document.getElementById('highlightsDialog')) return;

  document.getElementById('myHighlightsButton')?.addEventListener('click', () => {
    document.getElementById('accountDropdown').hidden = true;
    openHighlightsDialog();
  });
  document.getElementById('closeHighlightsDialog')?.addEventListener('click', () => {
    document.getElementById('highlightsDialog').close();
  });

  // Same daf-change detection notes.js and account-features.js already use.
  const dafTitle = document.getElementById('dafTitle');
  if (dafTitle) new MutationObserver(loadHighlightsForCurrentDaf).observe(dafTitle, { childList: true, characterData: true, subtree: true });
  window.DafSyncAuth?.onChange(loadHighlightsForCurrentDaf);
}

window.DafHighlights = {
  covering: highlightCovering,
  toggle: toggleHighlight,
  reload: loadHighlightsForCurrentDaf,
  renderVilnaOverlay: renderVilnaHighlightOverlay,
  applyToSegmentSpan: applyHighlightsToSegmentSpan,
  openDialog: openHighlightsDialog,
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initHighlights);
} else {
  initHighlights();
}
