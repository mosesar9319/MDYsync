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
// note id -> array of comments rows visible to the current viewer. Only
// fetched/rendered for notes that are public and not hidden -- comments
// only ever attach to such notes (see comments_insert's own note-visibility
// check in the migration), and hiding a note is meant to suppress its whole
// reply thread, so a hidden note's replies are never loaded here either.
const commentsByNoteId = new Map();

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

function renderCommentItem(row) {
  const user = window.DafSyncAuth?.getUser();
  const mine = user && row.author_id === user.id;
  const who = mine ? 'You' : escapeHtml(row.author_display_name || 'Anonymous');
  const hiddenPill = row.hidden ? '<span class="note-pill note-pill-hidden">Hidden by moderators</span>' : '';
  // Reporting your own reply makes no sense, and reporting requires being
  // signed in (reports_insert's own auth.uid() = reporter_id check).
  const reportButton = (!mine && user)
    ? `<button type="button" class="note-report-button" data-target-type="comment" data-target-id="${row.id}" aria-label="Report reply" title="Report this reply">🚩</button>`
    : '';
  return `
    <div class="comment-item" data-id="${row.id}">
      <div class="comment-item-head">
        <span class="note-item-author">${who}</span>
        ${hiddenPill}
        <span class="note-item-time">${formatNoteTime(row.created_at)}</span>
        ${reportButton}
        ${mine ? '<button type="button" class="comment-delete-button" data-id="' + row.id + '" aria-label="Delete reply">×</button>' : ''}
      </div>
      <p class="comment-item-body">${escapeHtml(row.body)}</p>
    </div>`;
}

// Flat reply thread for one public note -- private and hidden notes never
// get a reply section at all (see commentsByNoteId's own comment), matching
// the DB design where comments can't exist under either.
function renderReplySection(row) {
  if (row.is_private || row.hidden) return '';
  const user = window.DafSyncAuth?.getUser();
  const comments = commentsByNoteId.get(row.id) || [];
  const repliesHtml = comments.map(renderCommentItem).join('');
  const replyButton = user
    ? `<button type="button" class="reply-toggle-button" data-note-id="${row.id}">Reply</button>`
    : '';
  const composeHtml = user
    ? `<div class="reply-compose" data-note-id="${row.id}" hidden>
        <textarea class="reply-body-input" maxlength="2000" rows="2" placeholder="Write a reply…"></textarea>
        <div class="reply-compose-actions">
          <button type="button" class="button primary small reply-post-button" data-note-id="${row.id}">Post reply</button>
        </div>
      </div>`
    : '';
  if (!repliesHtml && !replyButton) return '';
  return `
    <div class="note-replies">
      ${repliesHtml ? `<div class="reply-list">${repliesHtml}</div>` : ''}
      ${replyButton}
      ${composeHtml}
    </div>`;
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
    // Reporting your own note makes no sense, and only a Live note is ever
    // visible to anyone else to report in the first place.
    const reportButton = (!mine && !row.is_private && user)
      ? `<button type="button" class="note-report-button" data-target-type="note" data-target-id="${row.id}" aria-label="Report note" title="Report this note">🚩</button>`
      : '';
    return `
      <div class="note-item" data-id="${row.id}">
        <div class="note-item-head">
          <span class="note-item-author">${who}</span>
          ${privacyPill}
          ${hiddenPill}
          ${driftPill}
          <span class="note-item-time">${formatNoteTime(row.created_at)}</span>
          ${reportButton}
          ${mine ? '<button type="button" class="note-delete-button" data-id="' + row.id + '" aria-label="Delete note">×</button>' : ''}
        </div>
        ${quote}
        <p class="note-item-body">${escapeHtml(row.body)}</p>
        ${renderReplySection(row)}
      </div>`;
  }).join('');
  list.querySelectorAll('.note-delete-button').forEach((button) => {
    button.addEventListener('click', () => deleteNote(button.dataset.id));
  });
  list.querySelectorAll('.reply-toggle-button').forEach((button) => {
    button.addEventListener('click', () => {
      const composer = list.querySelector(`.reply-compose[data-note-id="${button.dataset.noteId}"]`);
      if (composer) composer.hidden = !composer.hidden;
    });
  });
  list.querySelectorAll('.reply-post-button').forEach((button) => {
    button.addEventListener('click', () => postComment(button.dataset.noteId));
  });
  list.querySelectorAll('.comment-delete-button').forEach((button) => {
    button.addEventListener('click', () => deleteComment(button.dataset.id));
  });
  list.querySelectorAll('.note-report-button').forEach((button) => {
    button.addEventListener('click', () => reportItem(button.dataset.targetType, button.dataset.targetId));
  });
}

async function reportItem(targetType, targetId) {
  const auth = window.DafSyncAuth;
  const user = auth?.getUser();
  if (!user) return;
  const reason = window.prompt('Why are you reporting this? (required)');
  if (!reason || !reason.trim()) return;
  const { error } = await auth.client.from('reports').insert({
    reporter_id: user.id,
    target_type: targetType,
    target_id: targetId,
    reason: reason.trim().slice(0, 500),
  });
  if (error) {
    showToast(error.message || 'Could not submit the report.', 'error');
    return;
  }
  showToast('Report submitted. Thank you.');
}

async function loadCommentsForNotes(rows) {
  const auth = window.DafSyncAuth;
  for (const row of rows) commentsByNoteId.delete(row.id);
  const publicNoteIds = rows.filter((row) => !row.is_private && !row.hidden).map((row) => row.id);
  if (!publicNoteIds.length) return;
  const { data, error } = await auth.client
    .from('comments').select('*')
    .in('note_id', publicNoteIds)
    .order('created_at', { ascending: true });
  if (error || !data) return;
  for (const row of data) {
    if (!commentsByNoteId.has(row.note_id)) commentsByNoteId.set(row.note_id, []);
    commentsByNoteId.get(row.note_id).push(row);
  }
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
  const rows = data || [];
  notesByRef.set(ref, rows);
  applyNoteBadges();
  await loadCommentsForNotes(rows);
  if (activeNoteRef !== ref) return; // dialog moved on while replies loaded
  renderNoteList(rows);
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

async function postComment(noteId) {
  const auth = window.DafSyncAuth;
  const user = auth?.getUser();
  const profile = auth?.getProfile();
  if (!user) return;
  const { list } = noteDialogEls();
  const composer = list.querySelector(`.reply-compose[data-note-id="${noteId}"]`);
  const textarea = composer?.querySelector('.reply-body-input');
  const button = composer?.querySelector('.reply-post-button');
  const body = textarea?.value.trim();
  if (!body) return;
  if (button) button.disabled = true;
  const { error } = await auth.client.from('comments').insert({
    note_id: noteId,
    author_id: user.id,
    author_display_name: profile?.display_name || user.email,
    body,
  });
  if (button) button.disabled = false;
  if (error) {
    showToast(error.message || 'Could not post the reply.', 'error');
    return;
  }
  if (activeNoteRef) refreshNoteList(activeNoteRef);
}

async function deleteComment(id) {
  const auth = window.DafSyncAuth;
  if (!window.confirm('Delete this reply?')) return;
  const { error } = await auth.client.from('comments').delete().eq('id', id);
  if (error) {
    showToast(error.message || 'Could not delete the reply.', 'error');
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

// --- Studio moderation queue: live replies (comments), same shape as the --
// notes queue above, just pointed at the comments table + set_comment_hidden.
// Comments have no privacy concept of their own (see the migration -- they
// only ever attach to a public, unhidden note), so every row here is
// "live" the way only non-private rows were for notes.

let commentModerationRows = [];
let commentModerationFilter = 'visible';
// note_id -> { id, daf_ref_key } for the parent note of each loaded comment,
// batch-fetched once per load rather than per-row -- comments don't carry
// their own daf_ref_key, so this is the only way to link a reply back to
// the daf it's actually on for the "jump to" pill below.
let commentModerationNoteById = new Map();

function renderCommentModerationList() {
  const list = $('commentModerationList');
  const rows = commentModerationRows.filter((row) => {
    if (commentModerationFilter === 'visible') return !row.hidden;
    if (commentModerationFilter === 'hidden') return row.hidden;
    return true;
  });
  if (!rows.length) {
    list.innerHTML = '<p class="field-note">No replies here.</p>';
    return;
  }
  list.innerHTML = rows.map((row) => {
    const note = commentModerationNoteById.get(row.note_id);
    const refDisplay = note ? note.daf_ref_key.replace(/-/g, ' ') : null;
    const refLink = refDisplay
      ? `<a class="note-pill note-pill-live" href="../browse/index.html?ref=${encodeURIComponent(refDisplay)}" target="_blank" rel="noopener">${escapeHtml(refDisplay)}</a>`
      : '<span class="note-pill note-pill-hidden">Note not found</span>';
    return `
      <div class="note-item" data-id="${row.id}">
        <div class="note-item-head">
          <span class="note-item-author">${escapeHtml(row.author_display_name || 'Anonymous')}</span>
          ${refLink}
          ${row.hidden ? '<span class="note-pill note-pill-hidden">Hidden</span>' : ''}
          <span class="note-item-time">${formatNoteTime(row.created_at)}</span>
        </div>
        <p class="note-item-body">${escapeHtml(row.body)}</p>
        <div class="note-mod-actions">
          <button type="button" class="button ${row.hidden ? 'primary' : 'secondary'} small comment-mod-toggle-button" data-id="${row.id}" data-hidden="${row.hidden}">
            ${row.hidden ? 'Unhide' : 'Hide'}
          </button>
        </div>
      </div>`;
  }).join('');
  list.querySelectorAll('.comment-mod-toggle-button').forEach((button) => {
    button.addEventListener('click', () => toggleCommentModerationHidden(button.dataset.id, button.dataset.hidden !== 'true'));
  });
}

async function toggleCommentModerationHidden(id, hidden) {
  const auth = window.DafSyncAuth;
  const { error } = await auth.client.rpc('set_comment_hidden', { p_comment_id: id, p_hidden: hidden });
  if (error) {
    showToast(error.message || 'Could not update this reply.', 'error');
    return;
  }
  const row = commentModerationRows.find((r) => r.id === id);
  if (row) row.hidden = hidden;
  renderCommentModerationList();
}

async function loadCommentModerationQueue() {
  const auth = window.DafSyncAuth;
  const list = $('commentModerationList');
  list.innerHTML = '<p class="field-note">Loading…</p>';
  const { data, error } = await auth.client
    .from('comments').select('*')
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) {
    list.innerHTML = '<p class="field-note">Could not load replies.</p>';
    return;
  }
  commentModerationRows = data || [];
  commentModerationNoteById = new Map();
  const noteIds = [...new Set(commentModerationRows.map((row) => row.note_id))];
  if (noteIds.length) {
    const { data: notes } = await auth.client
      .from('line_notes').select('id, daf_ref_key')
      .in('id', noteIds);
    for (const note of notes || []) commentModerationNoteById.set(note.id, note);
  }
  renderCommentModerationList();
}

function initCommentModerationQueue() {
  const list = $('commentModerationList');
  if (!list) return; // not on studio -- nothing to attach to

  $('refreshCommentModerationButton').addEventListener('click', loadCommentModerationQueue);
  $('commentModerationFilter').querySelectorAll('button').forEach((button) => {
    button.addEventListener('click', () => {
      commentModerationFilter = button.dataset.filter;
      $('commentModerationFilter').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === button));
      renderCommentModerationList();
    });
  });

  window.DafSyncAuth?.onChange((user, profile) => {
    if (user && profile?.is_admin) loadCommentModerationQueue();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initCommentModerationQueue);
} else {
  initCommentModerationQueue();
}

// --- Studio moderation queue: reports -------------------------------------
// Reports are polymorphic (a note or a comment -- see the migration's own
// target_type check constraint), so this queue batch-fetches BOTH tables by
// the ids actually referenced rather than joining, and shows a preview of
// whatever was reported inline so a moderator doesn't have to leave the
// page to see what's being flagged.

let reportRows = [];
let reportFilter = 'pending';
// "note:<id>" / "comment:<id>" -> { id, body, hidden } for whatever a
// report's target_id actually points at right now (it may since have been
// hidden by other moderation, or deleted entirely by its own author).
let reportTargetsById = new Map();

function reportTargetKey(row) {
  return `${row.target_type}:${row.target_id}`;
}

function renderReportList() {
  const list = $('reportList');
  const rows = reportRows.filter((row) => reportFilter === 'all' || row.status === reportFilter);
  if (!rows.length) {
    list.innerHTML = '<p class="field-note">No reports here.</p>';
    return;
  }
  list.innerHTML = rows.map((row) => {
    const target = reportTargetsById.get(reportTargetKey(row));
    const kindPill = row.target_type === 'note'
      ? '<span class="note-pill note-pill-live">Note</span>'
      : '<span class="note-pill note-pill-private">Reply</span>';
    const statusPill = row.status !== 'pending'
      ? `<span class="note-pill note-pill-hidden">${row.status === 'resolved' ? 'Resolved' : 'Dismissed'}</span>`
      : '';
    const targetPreview = target
      ? `<p class="note-item-quote" dir="ltr">${escapeHtml(target.body)}${target.hidden ? ' (already hidden)' : ''}</p>`
      : '<p class="field-note">The reported content no longer exists.</p>';
    const actions = row.status === 'pending' ? `
      <div class="note-mod-actions">
        ${target && !target.hidden ? `<button type="button" class="button secondary small report-hide-button" data-id="${row.id}">Hide &amp; resolve</button>` : ''}
        ${target && target.hidden ? `<button type="button" class="button secondary small report-resolve-button" data-id="${row.id}">Mark resolved</button>` : ''}
        <button type="button" class="button ghost small report-dismiss-button" data-id="${row.id}">Dismiss</button>
      </div>` : '';
    return `
      <div class="note-item" data-id="${row.id}">
        <div class="note-item-head">
          ${kindPill}
          ${statusPill}
          <span class="note-item-time">${formatNoteTime(row.created_at)}</span>
        </div>
        <p class="note-item-body">Reason: ${escapeHtml(row.reason)}</p>
        ${targetPreview}
        ${actions}
      </div>`;
  }).join('');
  list.querySelectorAll('.report-hide-button').forEach((button) => {
    button.addEventListener('click', () => hideAndResolveReport(button.dataset.id));
  });
  list.querySelectorAll('.report-resolve-button').forEach((button) => {
    button.addEventListener('click', () => resolveReportStatus(button.dataset.id, 'resolved'));
  });
  list.querySelectorAll('.report-dismiss-button').forEach((button) => {
    button.addEventListener('click', () => resolveReportStatus(button.dataset.id, 'dismissed'));
  });
}

async function hideAndResolveReport(id) {
  const auth = window.DafSyncAuth;
  const row = reportRows.find((r) => r.id === id);
  if (!row) return;
  const rpc = row.target_type === 'note' ? 'set_note_hidden' : 'set_comment_hidden';
  const params = row.target_type === 'note'
    ? { p_note_id: row.target_id, p_hidden: true }
    : { p_comment_id: row.target_id, p_hidden: true };
  const { error } = await auth.client.rpc(rpc, params);
  if (error) {
    showToast(error.message || 'Could not hide this content.', 'error');
    return;
  }
  const target = reportTargetsById.get(reportTargetKey(row));
  if (target) target.hidden = true;
  await resolveReportStatus(id, 'resolved');
}

async function resolveReportStatus(id, status) {
  const auth = window.DafSyncAuth;
  const { error } = await auth.client.rpc('resolve_report', { p_report_id: id, p_status: status });
  if (error) {
    showToast(error.message || 'Could not update this report.', 'error');
    return;
  }
  const row = reportRows.find((r) => r.id === id);
  if (row) row.status = status;
  renderReportList();
}

async function loadReportsQueue() {
  const auth = window.DafSyncAuth;
  const list = $('reportList');
  list.innerHTML = '<p class="field-note">Loading…</p>';
  const { data, error } = await auth.client
    .from('reports').select('*')
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) {
    list.innerHTML = '<p class="field-note">Could not load reports.</p>';
    return;
  }
  reportRows = data || [];
  reportTargetsById = new Map();
  const noteIds = reportRows.filter((row) => row.target_type === 'note').map((row) => row.target_id);
  const commentIds = reportRows.filter((row) => row.target_type === 'comment').map((row) => row.target_id);
  if (noteIds.length) {
    const { data: notes } = await auth.client.from('line_notes').select('id, body, hidden').in('id', noteIds);
    for (const note of notes || []) reportTargetsById.set(`note:${note.id}`, note);
  }
  if (commentIds.length) {
    const { data: comments } = await auth.client.from('comments').select('id, body, hidden').in('id', commentIds);
    for (const comment of comments || []) reportTargetsById.set(`comment:${comment.id}`, comment);
  }
  renderReportList();
}

function initReportsQueue() {
  const list = $('reportList');
  if (!list) return; // not on studio -- nothing to attach to

  $('refreshReportsButton').addEventListener('click', loadReportsQueue);
  $('reportFilter').querySelectorAll('button').forEach((button) => {
    button.addEventListener('click', () => {
      reportFilter = button.dataset.filter;
      $('reportFilter').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === button));
      renderReportList();
    });
  });

  window.DafSyncAuth?.onChange((user, profile) => {
    if (user && profile?.is_admin) loadReportsQueue();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initReportsQueue);
} else {
  initReportsQueue();
}
