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

// ref -> array of line_notes rows visible to the current viewer, used only
// to badge segments with how many notes they have without a query per line.
const notesByRef = new Map();
let notesLoadedForDafKey = null;
let activeNoteRef = null;
let activeNotePrivacy = 'private';

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
    return `
      <div class="note-item" data-id="${row.id}">
        <div class="note-item-head">
          <span class="note-item-author">${who}</span>
          ${privacyPill}
          ${hiddenPill}
          <span class="note-item-time">${formatNoteTime(row.created_at)}</span>
          ${mine ? '<button type="button" class="note-delete-button" data-id="' + row.id + '" aria-label="Delete note">×</button>' : ''}
        </div>
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
  const { error } = await auth.client.from('line_notes').insert({
    author_id: user.id,
    author_display_name: profile?.display_name || user.email,
    daf_ref_key: info.key,
    segment_ref: activeNoteRef,
    body,
    is_private: activeNotePrivacy === 'private',
  });
  saveButton.disabled = false;
  if (error) {
    showToast(error.message || 'Could not save the note.', 'error');
    return;
  }
  bodyInput.value = '';
  refreshNoteList(activeNoteRef);
}

function openNoteDialog(ref, text) {
  activeNoteRef = ref;
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
