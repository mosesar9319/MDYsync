// Per-line notes: private (author-only) and live (shared, subject to
// moderation) notes attached to a single Talmud segment. Runs as a classic
// deferred script after app.js/account-features.js, sharing their top-level
// bindings (state, $, escapeHtml, showToast) the same way account-features.js
// does, and reusing account-features.js's currentDafInfo() for the
// daf_ref_key format. Only wired up on pages that ship the #noteDialog
// markup (browse/player/watch) -- app.js's buildSegmentSpan() only adds the
// note button when that element exists, so this file is a silent no-op
// (nothing to attach to) if loaded anywhere else.
'use strict';

// ref -> array of line_notes rows visible to the current viewer, used both
// to badge segments with how many notes they have (applyNoteBadges) and to
// position app.js's own margin markers (renderVilnaNoteMarkers).
const notesByRef = new Map();
let notesLoadedForDafKey = null;
let activeNoteRef = null;
let activeNotePrivacy = 'private';
// { ref, start, end, selectedText } while composing a note FROM a Notes
// Mode word-range selection (see openNoteComposerForSelection); null for
// the original whole-segment 🗒-button flow (openNoteDialog), which still
// works exactly as it always has and still saves start_word/end_word/
// selected_text as null -- "the whole segment," the same as every row
// this table already had before the word-range anchor migration.
let activeNoteSelection = null;

function noteDialogEls() {
  return {
    dialog: $('noteDialog'),
    refLabel: $('noteDialogRef'),
    textLabel: $('noteDialogText'),
    list: $('noteList'),
    compose: $('noteCompose'),
    privacyToggle: $('notePrivacyToggle'),
    privacyHint: $('notePrivacyHint'),
    bodyInput: $('noteBodyInput'),
    saveButton: $('saveNoteButton'),
    signInPrompt: $('noteSignInPrompt'),
  };
}

function formatNoteTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// --- Badges: annotate whichever segment spans are currently in the DOM ---

function applyNoteBadges() {
  document.querySelectorAll('.segment-note-button').forEach((button) => {
    const notes = notesByRef.get(button.dataset.ref);
    const count = notes ? notes.length : 0;
    button.classList.toggle('has-notes', count > 0);
    button.title = count > 0 ? `${count} note${count === 1 ? '' : 's'} on this line` : 'Notes for this line';
  });
  // Word-range notes' own margin markers on the Vilna page -- app.js's own
  // function (it owns wordBoxes/page-position math), called from here since
  // this is the one place notesByRef changing already funnels through,
  // whether that's a fresh daf's notes loading or this ref's own list
  // being refreshed after an add/delete.
  renderVilnaNoteMarkers();
}

async function loadNotesForCurrentDaf() {
  const auth = window.DafSyncAuth;
  const info = currentDafInfo();
  if (!info) return;
  notesLoadedForDafKey = info.key;
  const { data, error } = await auth.client
    .from('line_notes').select('*')
    .eq('daf_ref_key', info.key)
    .order('created_at', { ascending: true });
  if (notesLoadedForDafKey !== info.key) return; // a newer daf loaded meanwhile
  notesByRef.clear();
  if (!error && data) {
    for (const row of data) {
      if (!notesByRef.has(row.segment_ref)) notesByRef.set(row.segment_ref, []);
      notesByRef.get(row.segment_ref).push(row);
    }
  }
  applyNoteBadges();
}

// --- Dialog: reading and writing notes for one segment ---

// A note's saved word range can, in principle, drift out from under it if
// this daf's page-image word positions ever get regenerated with different
// segmentation (see the migration's own comment on selected_text, and
// build-page-cache.yml, which can do exactly that). Full verification would
// mean re-fetching the ref's canonical text from Sefaria and diffing it
// against selected_text on every render, which is real network cost paid
// on every note just to guard against a rare event. This is the cheap
// version instead: does the saved range still resolve to as many real word
// boxes on the CURRENT page as it did at save time (end - start + 1)? A
// mismatch is a reliable sign something shifted (a word dropped out of, or
// added into, that span) even though a same-count shift with different
// content would slip past it -- a real gap in coverage, traded here for
// not costing every note render a round trip.
function noteAnchorMayHaveShifted(row) {
  if (row.start_word === null || row.end_word === null) return false;
  if (!state.vilnaPageMap) return false;
  const count = state.vilnaPageMap.wordBoxes
    .filter((box) => box.ref === row.segment_ref && box.wordIndex >= row.start_word && box.wordIndex <= row.end_word)
    .length;
  return count !== (row.end_word - row.start_word + 1);
}

function renderNoteList(rows) {
  const { list } = noteDialogEls();
  const user = window.DafSyncAuth?.getUser();
  if (!rows.length) {
    list.innerHTML = '<p class="field-note">No notes on this line yet.</p>';
    return;
  }
  list.innerHTML = rows.map((row) => {
    const mine = user && row.author_id === user.id;
    const who = mine ? 'You' : escapeHtml(row.author_display_name || 'Anonymous');
    const privacyPill = row.is_private
      ? '<span class="note-pill note-pill-private">🔒 Private</span>'
      : '<span class="note-pill note-pill-live">🌐 Live</span>';
    const hiddenPill = row.hidden ? '<span class="note-pill note-pill-hidden">Hidden by moderators</span>' : '';
    const driftPill = noteAnchorMayHaveShifted(row)
      ? '<span class="note-pill note-pill-drift" title="This daf\'s word positions were rebuilt since this note was written -- the highlighted passage may not exactly match anymore.">⚠ May have shifted</span>'
      : '';
    // A word-range note (Notes Mode) quotes its own specific passage above
    // the note body -- several notes on the same segment_ref can each be
    // about different sub-ranges, so this can't just reuse the dialog's own
    // single top-of-dialog quote (which only ever shows the CURRENT
    // compose selection, if any -- see openNoteComposerForSelection).
    const quote = row.selected_text
      ? `<p class="note-item-quote" dir="rtl" lang="he">${escapeHtml(row.selected_text)}</p>`
      : '';
    return `
      <div class="note-item" data-id="${row.id}">
        <div class="note-item-head">
          <span class="note-item-author">${who}</span>
          ${privacyPill}
          ${hiddenPill}
          ${driftPill}
          <span class="note-item-time">${formatNoteTime(row.created_at)}</span>
          ${mine ? '<button type="button" class="note-delete-button" data-id="' + row.id + '" aria-label="Delete note">×</button>' : ''}
        </div>
        ${quote}
        <p class="note-item-body">${escapeHtml(row.body)}</p>
      </div>`;
  }).join('');
  list.querySelectorAll('.note-delete-button').forEach((button) => {
    button.addEventListener('click', () => deleteNote(button.dataset.id));
  });
}

async function refreshNoteList(ref) {
  const auth = window.DafSyncAuth;
  const { list } = noteDialogEls();
  list.innerHTML = '<p class="field-note">Loading notes…</p>';
  const { data, error } = await auth.client
    .from('line_notes').select('*')
    .eq('segment_ref', ref)
    .order('created_at', { ascending: true });
  if (activeNoteRef !== ref) return; // dialog moved on to a different line
  if (error) {
    list.innerHTML = '<p class="field-note">Could not load notes.</p>';
    return;
  }
  notesByRef.set(ref, data || []);
  applyNoteBadges();
  renderNoteList(data || []);
}

async function deleteNote(id) {
  const auth = window.DafSyncAuth;
  if (!window.confirm('Delete this note?')) return;
  const { error } = await auth.client.from('line_notes').delete().eq('id', id);
  if (error) {
    showToast(error.message || 'Could not delete the note.', 'error');
    return;
  }
  if (activeNoteRef) refreshNoteList(activeNoteRef);
}

function setNotePrivacy(privacy) {
  activeNotePrivacy = privacy;
  const { privacyToggle, privacyHint } = noteDialogEls();
  privacyToggle.querySelectorAll('.note-privacy-option').forEach((button) => {
    button.classList.toggle('active', button.dataset.privacy === privacy);
  });
  privacyHint.textContent = privacy === 'private'
    ? 'Only you will see this note.'
    : 'Visible to everyone once posted (subject to review).';
}

async function saveNote() {
  const auth = window.DafSyncAuth;
  const user = auth?.getUser();
  const profile = auth?.getProfile();
  const info = currentDafInfo();
  if (!user || !info || !activeNoteRef) return;
  const { bodyInput, saveButton } = noteDialogEls();
  const body = bodyInput.value.trim();
  if (!body) return;
  saveButton.disabled = true;
  const selection = activeNoteSelection;
  const { error } = await auth.client.from('line_notes').insert({
    author_id: user.id,
    author_display_name: profile?.display_name || user.email,
    daf_ref_key: info.key,
    segment_ref: activeNoteRef,
    body,
    is_private: activeNotePrivacy === 'private',
    // Whole-segment notes (the original 🗒 flow, no selection active) leave
    // all three columns unset -- the same "the whole segment" meaning
    // every pre-existing row already has, per the migration's own check
    // constraint.
    ...(selection ? { start_word: selection.start, end_word: selection.end, selected_text: selection.selectedText } : {}),
  });
  saveButton.disabled = false;
  if (error) {
    showToast(error.message || 'Could not save the note.', 'error');
    return;
  }
  bodyInput.value = '';
  refreshNoteList(activeNoteRef);
  // A word-range save came from Notes Mode's own selection (see
  // openNoteComposerForSelection) -- clear it now that it's been saved, so
  // the gold highlight/floating action bar don't linger over words that
  // already have a note attached.
  if (selection) {
    activeNoteSelection = null;
    clearNotesSelection();
  }
}

function openNoteDialog(ref, text) {
  activeNoteRef = ref;
  activeNoteSelection = null; // the whole-segment 🗒 flow, not a word-range one
  const auth = window.DafSyncAuth;
  const user = auth?.getUser();
  const { dialog, refLabel, textLabel, compose, bodyInput, signInPrompt } = noteDialogEls();
  refLabel.textContent = ref || 'Note';
  textLabel.textContent = text || '';
  bodyInput.value = '';
  setNotePrivacy('private');
  compose.hidden = !user;
  signInPrompt.hidden = Boolean(user);
  dialog.showModal();
  refreshNoteList(ref);
}

window.DafNotes = { open: openNoteDialog };

// Resolves the literal Hebrew text for [start,end] (inclusive word indices,
// the SAME canonical indexing wordBoxes/wordIndex already carry -- see
// page_ocr_align.py's own "canon" comment: this project's word_index is
// deliberately the same indexing the video caption engine's wordTimeline
// uses too) by fetching the ref's real paragraph text fresh from Sefaria
// and splitting it the same way. Word boxes carry POSITION only, never the
// literal word (see build_word_boxes in page_ocr_align.py), so this is the
// only source of truth for what a saved note should actually quote --
// reusing app.js's own fetchSefariaParagraphs rather than a second fetch
// path, the same "one Sefaria paragraph -> segment_ref" shape
// fillMissingDafText already trusts elsewhere.
async function resolveWordRangeText(ref, start, end) {
  const parsed = parseDafRef(ref);
  if (!parsed) throw new Error('Could not resolve this passage.');
  const { paragraphs } = await fetchSefariaParagraphs(`${parsed.tractate} ${parsed.daf}${parsed.amud}`);
  const paragraph = paragraphs.find((p) => p.ref === ref);
  if (!paragraph) throw new Error('Could not find this passage.');
  const words = paragraph.he.split(/\s+/).filter(Boolean);
  const text = words.slice(start, end + 1).join(' ');
  if (!text) throw new Error('Could not resolve this passage.');
  return text;
}

// Entry point for Notes Mode's own "Add note" action (see
// #vilnaNotesAddButton's click handler in app.js) -- the word-range
// counterpart to openNoteDialog above, opening the SAME dialog but quoting
// the specific selected words instead of a whole segment.
async function openNoteComposerForSelection(ref, start, end) {
  const info = currentDafInfo();
  if (!info) return;
  const { dialog, refLabel, textLabel, compose, bodyInput, signInPrompt } = noteDialogEls();
  let selectedText;
  try {
    selectedText = await resolveWordRangeText(ref, start, end);
  } catch (error) {
    showToast(error.message || 'Could not load this passage.', 'error');
    return;
  }
  activeNoteRef = ref;
  activeNoteSelection = { ref, start, end, selectedText };
  const auth = window.DafSyncAuth;
  const user = auth?.getUser();
  refLabel.textContent = ref;
  textLabel.textContent = selectedText;
  bodyInput.value = '';
  setNotePrivacy('private');
  compose.hidden = !user;
  signInPrompt.hidden = Boolean(user);
  dialog.showModal();
  refreshNoteList(ref);
}

window.DafNotesComposer = { openForSelection: openNoteComposerForSelection };

function initNoteDialog() {
  const dialog = $('noteDialog');
  if (!dialog) return; // page doesn't ship the notes UI (e.g. studio)

  $('closeNoteDialog').addEventListener('click', () => dialog.close());
  $('saveNoteButton').addEventListener('click', saveNote);
  $('notePrivacyToggle').querySelectorAll('.note-privacy-option').forEach((button) => {
    button.addEventListener('click', () => setNotePrivacy(button.dataset.privacy));
  });
  $('noteSignInButton').addEventListener('click', () => {
    dialog.close();
    $('signInButton')?.click();
  });

  // renderDafWindow() (app.js) rebuilds the segment spans on every active-
  // segment change during playback/auto-scroll, so badges need reapplying
  // after each rebuild rather than once at load.
  const dafPage = $('dafPage');
  if (dafPage) new MutationObserver(applyNoteBadges).observe(dafPage, { childList: true, subtree: true });

  // Same daf-change detection account-features.js uses for favorites/progress.
  const dafTitle = $('dafTitle');
  if (dafTitle) new MutationObserver(loadNotesForCurrentDaf).observe(dafTitle, { childList: true, characterData: true, subtree: true });

  window.DafSyncAuth?.onChange(() => {
    if (currentDafInfo()) loadNotesForCurrentDaf();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initNoteDialog);
} else {
  initNoteDialog();
}

// --- Studio moderation queue: every live (non-private) note, site-wide -----
// Only wired up on studio/index.html, which ships #moderationList and is
// already gated behind a real admin sign-in (see studio-locked in that
// page). Everywhere else this section is a no-op, same as initNoteDialog
// above.

let moderationRows = [];
let moderationFilter = 'visible';

function moderationRefDisplay(row) {
  return row.daf_ref_key.replace(/-/g, ' ');
}

function renderModerationList() {
  const list = $('moderationList');
  const rows = moderationRows.filter((row) => {
    if (moderationFilter === 'visible') return !row.hidden;
    if (moderationFilter === 'hidden') return row.hidden;
    return true;
  });
  if (!rows.length) {
    list.innerHTML = '<p class="field-note">No notes here.</p>';
    return;
  }
  list.innerHTML = rows.map((row) => `
    <div class="note-item" data-id="${row.id}">
      <div class="note-item-head">
        <span class="note-item-author">${escapeHtml(row.author_display_name || 'Anonymous')}</span>
        <a class="note-pill note-pill-live" href="../browse/index.html?ref=${encodeURIComponent(moderationRefDisplay(row))}" target="_blank" rel="noopener">${escapeHtml(moderationRefDisplay(row))}</a>
        ${row.hidden ? '<span class="note-pill note-pill-hidden">Hidden</span>' : ''}
        <span class="note-item-time">${formatNoteTime(row.created_at)}</span>
      </div>
      <p class="note-item-body">${escapeHtml(row.body)}</p>
      <div class="note-mod-actions">
        <button type="button" class="button ${row.hidden ? 'primary' : 'secondary'} small mod-toggle-button" data-id="${row.id}" data-hidden="${row.hidden}">
          ${row.hidden ? 'Unhide' : 'Hide'}
        </button>
      </div>
    </div>`).join('');
  list.querySelectorAll('.mod-toggle-button').forEach((button) => {
    button.addEventListener('click', () => toggleModerationHidden(button.dataset.id, button.dataset.hidden !== 'true'));
  });
}

async function toggleModerationHidden(id, hidden) {
  const auth = window.DafSyncAuth;
  const { error } = await auth.client.rpc('set_note_hidden', { p_note_id: id, p_hidden: hidden });
  if (error) {
    showToast(error.message || 'Could not update this note.', 'error');
    return;
  }
  const row = moderationRows.find((r) => r.id === id);
  if (row) row.hidden = hidden;
  renderModerationList();
}

async function loadModerationQueue() {
  const auth = window.DafSyncAuth;
  const list = $('moderationList');
  list.innerHTML = '<p class="field-note">Loading…</p>';
  const { data, error } = await auth.client
    .from('line_notes').select('*')
    .eq('is_private', false)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) {
    list.innerHTML = '<p class="field-note">Could not load the moderation queue.</p>';
    return;
  }
  moderationRows = data || [];
  renderModerationList();
}

function initModerationQueue() {
  const list = $('moderationList');
  if (!list) return; // not on studio -- nothing to attach to

  $('refreshModerationButton').addEventListener('click', loadModerationQueue);
  $('moderationFilter').querySelectorAll('button').forEach((button) => {
    button.addEventListener('click', () => {
      moderationFilter = button.dataset.filter;
      $('moderationFilter').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === button));
      renderModerationList();
    });
  });

  window.DafSyncAuth?.onChange((user, profile) => {
    if (user && profile?.is_admin) loadModerationQueue();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initModerationQueue);
} else {
  initModerationQueue();
}
