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
// Optional single category key (see CATEGORY_TYPES) for the note currently
// being composed, or null for "no category" -- a valid, expected state.
let activeNoteCategory = null;
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
// A small, deliberately restrained set of respectful reaction types -- not
// a full likes/emoji picker. A user can mark more than one of these on the
// same target (see the migration's own unique constraint, which now
// includes reaction_type), so they're independent toggles, not a
// single-choice picker.
const REACTION_TYPES = [
  { key: 'helpful', label: 'Helpful' },
  { key: 'insightful', label: 'Insightful' },
  { key: 'chazak', label: 'Chazak' },
  { key: 'shtark', label: 'Shtark' },
  { key: 'great_kasha', label: 'Great Kasha' },
];

// "note:<id>:<reaction_type>" / "comment:<id>:<reaction_type>" -> { count, mine }
const reactionsByTarget = new Map();

function reactionKey(targetType, targetId, reactionType) {
  return `${targetType}:${targetId}:${reactionType}`;
}

// note ids the current viewer follows, among the notes currently loaded --
// rebuilt on every refreshNoteList the same way reactionsByTarget is.
const followedNoteIds = new Set();

// Optional single category tag on a NOTE (not a reply -- replies aren't
// categorized). `primary: true` entries show directly in the composer;
// the rest sit behind "More categories" so the picker doesn't open onto an
// 18-item wall the first time. he/meaning render alongside the English
// label -- the Hebrew/Yeshivish term is the prominent one (see
// renderCategoryLabel), matching how this project already talks about a
// segment ("A word-range note quoting a specific phrase," Frank Ruhl Libre
// for the Hebrew) rather than translating everything into English-first.
const CATEGORY_TYPES = [
  { key: 'question', en: 'Question', he: 'שאלה / קשיא', meaning: 'A question about the passage', icon: '❓', primary: true },
  { key: 'insight', en: 'Insight', he: 'חידוש', meaning: 'An original or insightful thought', icon: '💡', primary: true },
  { key: 'difficulty', en: 'Difficulty', he: 'קושיא', meaning: 'A contradiction or problem in the text', icon: '⚠️', primary: true },
  { key: 'explanation', en: 'Explanation', he: 'ביאור', meaning: 'An explanation of the Gemara', icon: '📝', primary: true },
  { key: 'answer', en: 'Answer', he: 'תירוץ / תשובה', meaning: 'A proposed answer to a question', icon: '✅', primary: true },
  { key: 'further_study', en: 'Needs Further Study', he: 'צריך עיון', meaning: 'A point requiring deeper examination', icon: '📚', primary: true },
  { key: 'textual_precision', en: 'Textual Precision', he: 'דיוק בלשון', meaning: 'An observation about the exact wording', icon: '🔬', primary: true },
  { key: 'source', en: 'Source', he: 'מראה מקום', meaning: 'A related source or reference', icon: '📖', primary: true },
  { key: 'practical_implication', en: 'Practical Implication', he: 'נפקא מינה', meaning: 'A practical or conceptual difference', icon: '🔀', primary: true },
  { key: 'summary', en: 'Summary', he: 'סיכום / מהלך הסוגיא', meaning: 'A summary or outline of the sugya', icon: '📋', primary: true },
  { key: 'needs_clarification', en: 'Needs Clarification', he: 'צריך בירור', meaning: 'Something that still needs clarification', icon: '❔', primary: false },
  { key: 'alternative_approach', en: 'Alternative Approach', he: 'מהלך אחר / פשט אחר', meaning: 'A different way to understand the passage', icon: '🧭', primary: false },
  { key: 'supporting_proof', en: 'Supporting Proof', he: 'ראיה', meaning: 'Evidence supporting an explanation', icon: '⚖️', primary: false },
  { key: 'parallel_passage', en: 'Parallel Passage', he: 'סוגיא מקבילה', meaning: 'A connection to another sugya', icon: '🔗', primary: false },
  { key: 'practical_halacha', en: 'Practical Halacha', he: 'הלכה למעשה', meaning: 'A practical halachic conclusion', icon: '📜', primary: false },
  { key: 'background', en: 'Background', he: 'הקדמה / רקע', meaning: 'Helpful introductory context', icon: '🏛️', primary: false },
  { key: 'review_point', en: 'Review Point', he: 'נקודה לחזרה', meaning: 'Something worth remembering for chazarah', icon: '📌', primary: false },
  { key: 'lesson', en: 'Lesson', he: 'מוסר השכל', meaning: 'A personal or practical lesson', icon: '🎓', primary: false },
];

function categoryByKey(key) {
  return CATEGORY_TYPES.find((c) => c.key === key) || null;
}

function noteDialogEls() {
  return {
    dialog: $('noteDialog'),
    refLabel: $('noteDialogRef'),
    textLabel: $('noteDialogText'),
    list: $('noteList'),
    compose: $('noteCompose'),
    privacyToggle: $('notePrivacyToggle'),
    privacyHint: $('notePrivacyHint'),
    categoryOptions: $('noteCategoryOptions'),
    categorySecondaryOptions: $('noteCategorySecondaryOptions'),
    categoryMoreToggle: $('noteCategoryMoreToggle'),
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

// --- Formatting: a small hardcoded markup, not a rich-text/contenteditable
// editor -- keeps every note/reply body a plain string in the DB (safe to
// full-text-search, diff, and moderate exactly like today) while still
// letting the toolbar below offer bold/italic/highlight/large text/a
// bullet list. Safety depends entirely on the order here: escape the RAW
// text first, THEN wrap ranges of that already-escaped text in OUR OWN
// hardcoded tags -- at no point does anything the user typed get treated
// as HTML, so there's no stored-XSS surface even though public notes are
// rendered for every reader, signed in or not.
const NOTE_FORMAT_MARKERS = { bold: '**', italic: '*', highlight: '==', large: '++' };

function renderFormattedBody(raw) {
  const escaped = escapeHtml(raw)
    .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+?)\*/g, '<em>$1</em>')
    .replace(/==([^=\n]+?)==/g, '<mark>$1</mark>')
    .replace(/\+\+([^+\n]+?)\+\+/g, '<span class="note-body-large">$1</span>')
    .replace(/^- +/gm, '• ');
  return escaped;
}

// Wraps the textarea's current selection in the format's markers (or
// inserts an empty pair with the cursor placed between them), the same
// "insert markdown" pattern most comment boxes with a formatting toolbar
// use. The bullet list format is line-prefixed instead of wrapped, so it
// gets its own branch.
function applyNoteFormatting(textarea, format) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const value = textarea.value;

  if (format === 'list') {
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    let lineEnd = value.indexOf('\n', end);
    if (lineEnd === -1) lineEnd = value.length;
    const block = value.slice(lineStart, lineEnd);
    const newBlock = block.split('\n').map((line) => (line.startsWith('- ') ? line : `- ${line}`)).join('\n');
    textarea.value = value.slice(0, lineStart) + newBlock + value.slice(lineEnd);
    textarea.focus();
    textarea.setSelectionRange(lineStart, lineStart + newBlock.length);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }

  const marker = NOTE_FORMAT_MARKERS[format];
  if (!marker) return;
  const selected = value.slice(start, end);
  const placeholder = selected || 'text';
  const inserted = `${marker}${placeholder}${marker}`;
  textarea.value = value.slice(0, start) + inserted + value.slice(end);
  textarea.focus();
  if (selected) {
    textarea.setSelectionRange(start, start + inserted.length);
  } else {
    textarea.setSelectionRange(start + marker.length, start + marker.length + placeholder.length);
  }
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

function formatToolbarHtml() {
  return `
    <div class="note-format-toolbar" role="group" aria-label="Formatting">
      <button type="button" class="note-format-button" data-format="bold" title="Bold" aria-label="Bold"><strong>B</strong></button>
      <button type="button" class="note-format-button" data-format="italic" title="Italic" aria-label="Italic"><em>I</em></button>
      <button type="button" class="note-format-button" data-format="highlight" title="Highlight" aria-label="Highlight">🖍</button>
      <button type="button" class="note-format-button" data-format="large" title="Large text" aria-label="Large text">A+</button>
      <button type="button" class="note-format-button" data-format="list" title="Bullet list" aria-label="Bullet list">≡</button>
    </div>`;
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

// Visual nesting cap only -- replies keep their real parent_comment_id
// (and so stay logically threaded, moderation and notifications still see
// the true chain) no matter how deep a conversation actually goes, but the
// indentation itself stops growing past this depth so a long back-and-forth
// can't push the reply panel into a sliver.
const MAX_REPLY_DEPTH = 4;

// note_id -> Map(parent_comment_id-or-null -> [comment rows]), rebuilt fresh
// each render off the flat rows loadCommentsForNotes fetched -- the DB
// stores an adjacency list (parent_comment_id), not a tree, so this is the
// one place that shape gets turned into something renderCommentItem can
// walk.
function buildCommentTree(comments) {
  const byParent = new Map();
  for (const row of comments) {
    const key = row.parent_comment_id || null;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(row);
  }
  return byParent;
}

function reactionEntry(targetType, targetId, reactionType) {
  return reactionsByTarget.get(reactionKey(targetType, targetId, reactionType)) || { count: 0, mine: false };
}

// A signed-out reader still sees which reactions exist (if any) but gets a
// plain summary label instead of a menu -- reacting requires
// auth.uid() = user_id at the DB level, so there's nothing a click could do
// for them.
function renderReactionButton(targetType, targetId) {
  const user = window.DafSyncAuth?.getUser();
  const entries = REACTION_TYPES.map((type) => ({ ...type, ...reactionEntry(targetType, targetId, type.key) }));
  const totalCount = entries.reduce((sum, e) => sum + e.count, 0);
  const mineCount = entries.filter((e) => e.mine).length;
  if (!user) {
    if (!totalCount) return '';
    const summary = entries.filter((e) => e.count > 0).map((e) => `${e.label} (${e.count})`).join(' · ');
    return `<span class="reaction-count-label">${escapeHtml(summary)}</span>`;
  }
  const menuItems = entries.map((e) => {
    const countLabel = e.count > 0 ? ` (${e.count})` : '';
    return `<button type="button" class="reaction-menu-item${e.mine ? ' active' : ''}" data-target-type="${targetType}" data-target-id="${targetId}" data-reaction-type="${e.key}">${escapeHtml(e.label)}${countLabel}</button>`;
  }).join('');
  const triggerLabel = totalCount > 0 ? `React (${totalCount})` : 'React';
  return `
    <div class="reaction-widget">
      <button type="button" class="reaction-trigger-button${mineCount > 0 ? ' active' : ''}">${triggerLabel} ▾</button>
      <div class="reaction-menu" hidden>${menuItems}</div>
    </div>`;
}

// Only ever on the NOTE itself (not individual replies) -- following means
// "notify me about new activity in this thread," which is a thread-level
// concept. You're auto-followed on your own notes/replies (see the
// migration's own thread_follows insert in notify_on_*_insert), so this
// button mostly serves to let you opt back OUT, or opt in without posting.
function renderFollowButton(noteId) {
  const user = window.DafSyncAuth?.getUser();
  if (!user) return '';
  const following = followedNoteIds.has(noteId);
  return `<button type="button" class="follow-toggle-button${following ? ' active' : ''}" data-note-id="${noteId}">${following ? 'Following' : 'Follow'}</button>`;
}

// Who a reply on this note can @-mention: the note's own author plus
// everyone who has already replied on it, minus yourself. There is no
// public directory to search against (profiles is owner-read-only -- see
// profiles_select_own), so mentions are deliberately limited to people
// already named out loud in this exact thread, not an open user search.
function getMentionableForNote(noteId) {
  const user = window.DafSyncAuth?.getUser();
  const people = new Map();
  const note = (notesByRef.get(activeNoteRef) || []).find((n) => n.id === noteId);
  if (note && (!user || note.author_id !== user.id)) {
    people.set(note.author_id, note.author_display_name || 'Anonymous');
  }
  for (const comment of commentsByNoteId.get(noteId) || []) {
    if (user && comment.author_id === user.id) continue;
    if (!people.has(comment.author_id)) people.set(comment.author_id, comment.author_display_name || 'Anonymous');
  }
  return [...people.entries()].map(([id, name]) => ({ id, name }));
}

// Chips, not free-text @-parsing -- toggled active/inactive the same way
// the privacy toggle already does it (.note-privacy-option.active), and
// read back the same way at submit time (postComment queries
// .mention-chip.active within the composer). No separate JS-side selection
// state to keep in sync with a rebuilt DOM.
function renderMentionChips(noteId) {
  const people = getMentionableForNote(noteId);
  if (!people.length) return '';
  const chips = people
    .map((p) => `<button type="button" class="mention-chip" data-user-id="${p.id}">@${escapeHtml(p.name)}</button>`)
    .join('');
  return `<div class="mention-picker">${chips}</div>`;
}

function renderCommentItem(row, byParent, depth, noteId) {
  const user = window.DafSyncAuth?.getUser();
  const mine = user && row.author_id === user.id;
  const who = mine ? 'You' : escapeHtml(row.author_display_name || 'Anonymous');
  const hiddenPill = row.hidden ? '<span class="note-pill note-pill-hidden">Hidden by moderators</span>' : '';
  // Reporting your own reply makes no sense, and reporting requires being
  // signed in (reports_insert's own auth.uid() = reporter_id check).
  const reportButton = (!mine && user)
    ? `<button type="button" class="note-report-button" data-target-type="comment" data-target-id="${row.id}" aria-label="Report reply" title="Report this reply">🚩</button>`
    : '';
  // Every reply (not just the note itself) can be replied to -- these use
  // the SAME .reply-toggle-button/.reply-compose/.reply-post-button classes
  // as the note-level ones below, keyed by (noteId, parentId) so the click
  // handlers in renderNoteList don't need two separate code paths.
  const replyButton = user
    ? `<button type="button" class="reply-toggle-button" data-note-id="${noteId}" data-parent-id="${row.id}">Reply</button>`
    : '';
  const composeHtml = user
    ? `<div class="reply-compose" data-note-id="${noteId}" data-parent-id="${row.id}" hidden>
        ${formatToolbarHtml()}
        <textarea class="reply-body-input" maxlength="2000" rows="2" placeholder="Write a reply…"></textarea>
        ${renderMentionChips(noteId)}
        <div class="reply-compose-actions">
          <button type="button" class="button primary small reply-post-button" data-note-id="${noteId}" data-parent-id="${row.id}">Post reply</button>
        </div>
      </div>`
    : '';
  const children = byParent.get(row.id) || [];
  const childDepth = Math.min(depth + 1, MAX_REPLY_DEPTH);
  const childrenHtml = children.length
    ? `<div class="reply-children">${children.map((child) => renderCommentItem(child, byParent, childDepth, noteId)).join('')}</div>`
    : '';
  const reactionButton = renderReactionButton('comment', row.id);
  const footer = (reactionButton || replyButton) ? `<div class="item-footer">${reactionButton}${replyButton}</div>` : '';
  return `
    <div class="comment-item" data-id="${row.id}" style="--reply-depth: ${depth}">
      <div class="comment-item-head">
        <span class="note-item-author">${who}</span>
        ${hiddenPill}
        <span class="note-item-time">${formatNoteTime(row.created_at)}</span>
        ${reportButton}
        ${mine ? '<button type="button" class="comment-delete-button" data-id="' + row.id + '" aria-label="Delete reply">×</button>' : ''}
      </div>
      <p class="comment-item-body">${renderFormattedBody(row.body)}</p>
      ${footer}
      ${composeHtml}
      ${childrenHtml}
    </div>`;
}

// Nested reply thread for one public note -- private and hidden notes never
// get a reply section at all (see commentsByNoteId's own comment), matching
// the DB design where comments can't exist under either.
function renderReplySection(row) {
  if (row.is_private || row.hidden) return '';
  const user = window.DafSyncAuth?.getUser();
  const comments = commentsByNoteId.get(row.id) || [];
  const byParent = buildCommentTree(comments);
  const topLevel = byParent.get(null) || [];
  const repliesHtml = topLevel.map((child) => renderCommentItem(child, byParent, 0, row.id)).join('');
  // The note's own top-level "Reply" (parent-id left empty) vs. a reply's
  // own reply button above both render through the same markup shape.
  const replyButton = user
    ? `<button type="button" class="reply-toggle-button" data-note-id="${row.id}" data-parent-id="">Reply</button>`
    : '';
  const composeHtml = user
    ? `<div class="reply-compose" data-note-id="${row.id}" data-parent-id="" hidden>
        ${formatToolbarHtml()}
        <textarea class="reply-body-input" maxlength="2000" rows="2" placeholder="Write a reply…"></textarea>
        ${renderMentionChips(row.id)}
        <div class="reply-compose-actions">
          <button type="button" class="button primary small reply-post-button" data-note-id="${row.id}" data-parent-id="">Post reply</button>
        </div>
      </div>`
    : '';
  const reactionButton = renderReactionButton('note', row.id);
  const followButton = renderFollowButton(row.id);
  const footer = (reactionButton || followButton || replyButton) ? `<div class="item-footer">${reactionButton}${followButton}${replyButton}</div>` : '';
  if (!repliesHtml && !footer) return '';
  return `
    <div class="note-replies">
      ${repliesHtml ? `<div class="reply-list">${repliesHtml}</div>` : ''}
      ${footer}
      ${composeHtml}
    </div>`;
}

// Category display order (primary categories first, matching what a reader
// already recognizes from composing) -- used by the search dialog's own
// category filter/ordering, not by this per-line list (see the "Sort by"
// control's removal: sorting matters for browsing/searching across many
// notes, not a single line's handful).
const CATEGORY_SORT_INDEX = new Map(CATEGORY_TYPES.map((c, i) => [c.key, i]));

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
    const categoryInfo = row.category ? categoryByKey(row.category) : null;
    const categoryPill = categoryInfo
      ? `<span class="note-pill note-category-pill" title="${escapeHtml(categoryInfo.en)} — ${escapeHtml(categoryInfo.meaning)}">${categoryInfo.icon} <span dir="rtl" lang="he">${escapeHtml(categoryInfo.he)}</span></span>`
      : '';
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
          ${categoryPill}
          ${hiddenPill}
          ${driftPill}
          <span class="note-item-time">${formatNoteTime(row.created_at)}</span>
          ${reportButton}
          ${mine ? '<button type="button" class="note-delete-button" data-id="' + row.id + '" aria-label="Delete note">×</button>' : ''}
        </div>
        ${quote}
        <p class="note-item-body">${renderFormattedBody(row.body)}</p>
        ${renderReplySection(row)}
      </div>`;
  }).join('');
  list.querySelectorAll('.note-delete-button').forEach((button) => {
    button.addEventListener('click', () => deleteNote(button.dataset.id));
  });
  list.querySelectorAll('.reply-toggle-button').forEach((button) => {
    button.addEventListener('click', () => {
      const composer = list.querySelector(`.reply-compose[data-note-id="${button.dataset.noteId}"][data-parent-id="${button.dataset.parentId}"]`);
      if (composer) composer.hidden = !composer.hidden;
    });
  });
  list.querySelectorAll('.reply-post-button').forEach((button) => {
    button.addEventListener('click', () => postComment(button.dataset.noteId, button.dataset.parentId || null));
  });
  list.querySelectorAll('.comment-delete-button').forEach((button) => {
    button.addEventListener('click', () => deleteComment(button.dataset.id));
  });
  list.querySelectorAll('.note-report-button').forEach((button) => {
    button.addEventListener('click', () => reportItem(button.dataset.targetType, button.dataset.targetId));
  });
  list.querySelectorAll('.reaction-trigger-button').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const menu = button.nextElementSibling;
      // Only one reaction menu open at a time -- closing any sibling that
      // was already open before toggling this one.
      list.querySelectorAll('.reaction-menu').forEach((m) => { if (m !== menu) m.hidden = true; });
      menu.hidden = !menu.hidden;
    });
  });
  list.querySelectorAll('.reaction-menu-item').forEach((button) => {
    button.addEventListener('click', () => toggleReaction(button.dataset.targetType, button.dataset.targetId, button.dataset.reactionType));
  });
  list.querySelectorAll('.mention-chip').forEach((chip) => {
    chip.addEventListener('click', () => chip.classList.toggle('active'));
  });
  list.querySelectorAll('.follow-toggle-button').forEach((button) => {
    button.addEventListener('click', () => toggleFollow(button.dataset.noteId));
  });
}

async function toggleFollow(noteId) {
  const auth = window.DafSyncAuth;
  const user = auth?.getUser();
  if (!user) return;
  if (followedNoteIds.has(noteId)) {
    const { error } = await auth.client.from('thread_follows').delete()
      .eq('user_id', user.id).eq('note_id', noteId);
    if (error) {
      showToast(error.message || 'Could not update this.', 'error');
      return;
    }
  } else {
    const { error } = await auth.client.from('thread_follows').insert({ user_id: user.id, note_id: noteId });
    if (error) {
      showToast(error.message || 'Could not update this.', 'error');
      return;
    }
  }
  if (activeNoteRef) refreshNoteList(activeNoteRef);
}

async function toggleReaction(targetType, targetId, reactionType) {
  const auth = window.DafSyncAuth;
  const user = auth?.getUser();
  if (!user) return;
  const entry = reactionsByTarget.get(reactionKey(targetType, targetId, reactionType));
  if (entry?.mine) {
    const { error } = await auth.client.from('reactions').delete()
      .eq('user_id', user.id).eq('target_type', targetType).eq('target_id', targetId).eq('reaction_type', reactionType);
    if (error) {
      showToast(error.message || 'Could not update this.', 'error');
      return;
    }
  } else {
    const { error } = await auth.client.from('reactions').insert({
      user_id: user.id, target_type: targetType, target_id: targetId, reaction_type: reactionType,
    });
    if (error) {
      showToast(error.message || 'Could not update this.', 'error');
      return;
    }
  }
  if (activeNoteRef) refreshNoteList(activeNoteRef);
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

// Two passes (note targets, then comment targets) rather than one query --
// Supabase's client doesn't have a clean way to express "(target_type,
// target_id) in (...)" as a single filter over a list of tuples.
async function loadReactionsForTargets(noteIds, commentIds) {
  const auth = window.DafSyncAuth;
  const user = auth?.getUser();
  reactionsByTarget.clear();
  if (!noteIds.length && !commentIds.length) return;
  const noteReactions = noteIds.length
    ? await auth.client.from('reactions').select('*').eq('target_type', 'note').in('target_id', noteIds)
    : { data: [] };
  const commentReactions = commentIds.length
    ? await auth.client.from('reactions').select('*').eq('target_type', 'comment').in('target_id', commentIds)
    : { data: [] };
  for (const row of [...(noteReactions.data || []), ...(commentReactions.data || [])]) {
    const key = reactionKey(row.target_type, row.target_id, row.reaction_type);
    if (!reactionsByTarget.has(key)) reactionsByTarget.set(key, { count: 0, mine: false });
    const entry = reactionsByTarget.get(key);
    entry.count += 1;
    if (user && row.user_id === user.id) entry.mine = true;
  }
}

async function loadFollowsForNotes(noteIds) {
  const auth = window.DafSyncAuth;
  const user = auth?.getUser();
  followedNoteIds.clear();
  if (!user || !noteIds.length) return;
  const { data, error } = await auth.client
    .from('thread_follows').select('note_id')
    .eq('user_id', user.id)
    .in('note_id', noteIds);
  if (error || !data) return;
  for (const row of data) followedNoteIds.add(row.note_id);
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
  const commentIds = [...commentsByNoteId.values()].flat().map((c) => c.id);
  const publicNoteIds = rows.filter((r) => !r.is_private).map((r) => r.id);
  await loadReactionsForTargets(publicNoteIds, commentIds);
  if (activeNoteRef !== ref) return; // dialog moved on while reactions loaded
  await loadFollowsForNotes(publicNoteIds);
  if (activeNoteRef !== ref) return; // dialog moved on while follow state loaded
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

async function postComment(noteId, parentCommentId) {
  const auth = window.DafSyncAuth;
  const user = auth?.getUser();
  const profile = auth?.getProfile();
  if (!user) return;
  const { list } = noteDialogEls();
  const composer = list.querySelector(`.reply-compose[data-note-id="${noteId}"][data-parent-id="${parentCommentId || ''}"]`);
  const textarea = composer?.querySelector('.reply-body-input');
  const button = composer?.querySelector('.reply-post-button');
  const body = textarea?.value.trim();
  if (!body) return;
  const mentionedUserIds = [...(composer?.querySelectorAll('.mention-chip.active') || [])].map((chip) => chip.dataset.userId);
  if (button) button.disabled = true;
  const { error } = await auth.client.from('comments').insert({
    note_id: noteId,
    parent_comment_id: parentCommentId || null,
    author_id: user.id,
    author_display_name: profile?.display_name || user.email,
    body,
    mentioned_user_ids: mentionedUserIds,
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

function categoryChipHtml(category) {
  return `
    <button type="button" class="note-category-chip" data-category="${category.key}" title="${escapeHtml(category.en)} — ${escapeHtml(category.meaning)}">
      <span class="note-category-chip-icon">${category.icon}</span>
      <span class="note-category-chip-text">
        <span class="note-category-chip-he" dir="rtl" lang="he">${escapeHtml(category.he)}</span>
        <span class="note-category-chip-en">${escapeHtml(category.en)}</span>
      </span>
    </button>`;
}

// Built once (the chip set is static) rather than on every dialog open --
// unlike the note list, this doesn't depend on which note/segment is active.
function renderCategoryPicker() {
  const { categoryOptions, categorySecondaryOptions } = noteDialogEls();
  if (!categoryOptions) return;
  categoryOptions.innerHTML = CATEGORY_TYPES.filter((c) => c.primary).map(categoryChipHtml).join('');
  categorySecondaryOptions.innerHTML = CATEGORY_TYPES.filter((c) => !c.primary).map(categoryChipHtml).join('');
  [categoryOptions, categorySecondaryOptions].forEach((container) => {
    container.querySelectorAll('.note-category-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        setNoteCategory(activeNoteCategory === chip.dataset.category ? null : chip.dataset.category);
      });
    });
  });
}

function setNoteCategory(key) {
  activeNoteCategory = key;
  const { categoryOptions, categorySecondaryOptions } = noteDialogEls();
  [categoryOptions, categorySecondaryOptions].forEach((container) => {
    container?.querySelectorAll('.note-category-chip').forEach((chip) => {
      chip.classList.toggle('active', chip.dataset.category === key);
    });
  });
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
    category: activeNoteCategory,
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
  setNoteCategory(null);
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
  setNoteCategory(null);
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
  renderCategoryPicker();
  $('noteCategoryMoreToggle')?.addEventListener('click', () => {
    const secondary = $('noteCategorySecondaryOptions');
    secondary.hidden = !secondary.hidden;
    $('noteCategoryMoreToggle').textContent = secondary.hidden ? 'More categories ▾' : 'Fewer categories ▴';
  });
  $('noteSignInButton').addEventListener('click', () => {
    dialog.close();
    $('signInButton')?.click();
  });

  // Click-outside-to-close for reaction menus -- attached once here rather
  // than per render, since renderNoteList rebuilds the list's contents
  // (and any menus in it) on every refresh.
  document.addEventListener('click', () => {
    dialog.querySelectorAll('.reaction-menu:not([hidden])').forEach((menu) => { menu.hidden = true; });
  });

  // Formatting toolbar buttons -- delegated on the dialog itself (same
  // reasoning as the reaction-menu listener above) since reply composers
  // are rebuilt on every renderNoteList call, but the top-level note
  // composer's own toolbar is static markup present from page load.
  dialog.addEventListener('click', (event) => {
    const button = event.target.closest('.note-format-button');
    if (!button) return;
    const textarea = button.closest('.note-compose, .reply-compose')?.querySelector('textarea');
    if (textarea) applyNoteFormatting(textarea, button.dataset.format);
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
      <p class="note-item-body">${renderFormattedBody(row.body)}</p>
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
        <p class="note-item-body">${renderFormattedBody(row.body)}</p>
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
      ? `<p class="note-item-quote" dir="ltr">${renderFormattedBody(target.body)}${target.hidden ? ' (already hidden)' : ''}</p>`
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

// --- Notifications: reply + mention alerts -------------------------------
// No realtime -- fetched when you sign in and refreshed when you open the
// bell, the same "refresh after posting is enough, this isn't a chat app"
// call made for the rest of this feature. Rows themselves are only ever
// created server-side (see notify_on_comment_insert/notify_on_note_insert
// in the migration) since a poster can't insert into someone else's inbox
// under RLS.

let notificationRows = [];

function notifDialogEls() {
  return {
    bellButton: $('notifBellButton'),
    badge: $('notifBadge'),
    dropdown: $('notifDropdown'),
    list: $('notifList'),
    markAllButton: $('notifMarkAllReadButton'),
  };
}

function formatNotifText(row) {
  const verb = row.type === 'mention' ? 'mentioned you in'
    : row.type === 'thread' ? 'posted a new reply on'
    : 'replied to you on';
  return `${escapeHtml(row.actor_display_name)} ${verb} ${escapeHtml(row.segment_ref)}`;
}

function renderNotifList() {
  const { list, badge } = notifDialogEls();
  if (!list) return; // page doesn't ship the notification bell
  const unreadCount = notificationRows.filter((row) => !row.read).length;
  badge.textContent = String(unreadCount);
  badge.hidden = unreadCount === 0;
  if (!notificationRows.length) {
    list.innerHTML = '<p class="field-note">No notifications yet.</p>';
    return;
  }
  list.innerHTML = notificationRows.map((row) => `
    <button type="button" class="notif-item${row.read ? '' : ' unread'}" data-id="${row.id}" data-daf-ref-key="${escapeHtml(row.daf_ref_key)}">
      <span class="notif-item-text">${formatNotifText(row)}</span>
      <span class="notif-item-preview">${escapeHtml(row.preview)}</span>
      <span class="notif-item-time">${formatNoteTime(row.created_at)}</span>
    </button>`).join('');
  list.querySelectorAll('.notif-item').forEach((el) => {
    el.addEventListener('click', () => openNotification(el.dataset.id, el.dataset.dafRefKey));
  });
}

async function loadNotifications() {
  const auth = window.DafSyncAuth;
  const user = auth?.getUser();
  if (!user) {
    notificationRows = [];
    renderNotifList();
    return;
  }
  const { data, error } = await auth.client
    .from('notifications').select('*')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return;
  notificationRows = data || [];
  renderNotifList();
}

async function openNotification(id, dafRefKey) {
  const auth = window.DafSyncAuth;
  const row = notificationRows.find((r) => r.id === id);
  if (row && !row.read) {
    row.read = true;
    renderNotifList();
    await auth.client.from('notifications').update({ read: true }).eq('id', id);
  }
  // Same ref-link shape the studio moderation queues already use.
  window.location.href = `../browse/index.html?ref=${encodeURIComponent(dafRefKey.replace(/-/g, ' '))}`;
}

async function markAllNotificationsRead() {
  const auth = window.DafSyncAuth;
  const user = auth?.getUser();
  if (!user || !notificationRows.some((row) => !row.read)) return;
  for (const row of notificationRows) row.read = true;
  renderNotifList();
  await auth.client.from('notifications').update({ read: true }).eq('user_id', user.id).eq('read', false);
}

function initNotifications() {
  const { bellButton, dropdown, markAllButton } = notifDialogEls();
  if (!bellButton) return; // page doesn't ship the notification bell

  bellButton.addEventListener('click', () => {
    dropdown.hidden = !dropdown.hidden;
    if (!dropdown.hidden) loadNotifications();
  });
  markAllButton.addEventListener('click', markAllNotificationsRead);
  // Click-outside-to-close, same pattern as the account dropdown.
  document.addEventListener('click', (event) => {
    if (!dropdown.hidden && !dropdown.contains(event.target) && !bellButton.contains(event.target)) {
      dropdown.hidden = true;
    }
  });

  window.DafSyncAuth?.onChange((user) => {
    if (user) loadNotifications();
    else { notificationRows = []; renderNotifList(); }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initNotifications);
} else {
  initNotifications();
}

// --- Search: public notes/replies, plus your own private notes -------------
// A plain postgres full-text search (body_tsv, config 'simple' -- see the
// migration's own comment on why not 'english': no good built-in Hebrew
// config, and note bodies are typically English commentary anyway) rather
// than a naive ILIKE scan. Public results are available to signed-out
// readers too -- still governed by the exact same public-read RLS as
// everything else here, just reached through textSearch instead of a plain
// .select(). Also doubles as a category browser: picking a category with no
// text typed still runs (a category filter alone is a valid query), which
// is the actual point of putting sort/filter-by-category here rather than
// on a single line's own short note list.

let searchDebounceTimer = null;

function searchDialogEls() {
  return {
    dialog: $('searchNotesDialog'),
    input: $('searchNotesInput'),
    categoryFilter: $('searchCategoryFilter'),
    results: $('searchNotesResults'),
  };
}

function renderSearchCategoryFilter() {
  const { categoryFilter } = searchDialogEls();
  if (!categoryFilter) return;
  categoryFilter.innerHTML = [
    '<option value="">All categories</option>',
    ...CATEGORY_TYPES.map((c) => `<option value="${c.key}">${c.icon} ${escapeHtml(c.en)} (${escapeHtml(c.he)})</option>`),
  ].join('');
}

function renderSearchResults(notes, comments) {
  const { results } = searchDialogEls();
  const user = window.DafSyncAuth?.getUser();
  const rows = [
    ...notes.map((row) => ({ kind: 'note', ...row })),
    ...comments.map((row) => ({ kind: 'comment', ...row })),
  ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  if (!rows.length) {
    results.innerHTML = '<p class="field-note">No results.</p>';
    return;
  }
  results.innerHTML = rows.map((row) => {
    const mine = user && row.author_id === user.id;
    const who = mine ? 'You' : escapeHtml(row.author_display_name || 'Anonymous');
    const kindPill = `<span class="note-pill">${row.kind === 'note' ? 'Note' : 'Reply'}</span>`;
    // Only a note carries its own privacy -- a reply only ever exists under
    // a public note in the first place (see comments_insert's own check),
    // so there's nothing to distinguish there.
    const privacyPill = row.kind === 'note'
      ? (row.is_private ? '<span class="note-pill note-pill-private">🔒 Private</span>' : '<span class="note-pill note-pill-live">🌐 Live</span>')
      : '';
    const categoryInfo = row.category ? categoryByKey(row.category) : null;
    const categoryPill = categoryInfo
      ? `<span class="note-pill note-category-pill">${categoryInfo.icon} <span dir="rtl" lang="he">${escapeHtml(categoryInfo.he)}</span></span>`
      : '';
    const refDisplay = row.daf_ref_key ? row.daf_ref_key.replace(/-/g, ' ') : '';
    return `
      <a class="note-item search-result-item" href="../browse/index.html?ref=${encodeURIComponent(refDisplay)}">
        <div class="note-item-head">
          <span class="note-item-author">${who}</span>
          ${kindPill}
          ${privacyPill}
          ${categoryPill}
          ${refDisplay ? `<span class="note-pill">${escapeHtml(refDisplay)}</span>` : ''}
          <span class="note-item-time">${formatNoteTime(row.created_at)}</span>
        </div>
        <p class="note-item-body">${renderFormattedBody(row.body)}</p>
      </a>`;
  }).join('');
}

async function runNotesSearch() {
  const auth = window.DafSyncAuth;
  const { input, categoryFilter, results } = searchDialogEls();
  const trimmed = input.value.trim();
  const category = categoryFilter.value || null;
  results.dataset.query = trimmed;
  results.dataset.category = category || '';
  if (!trimmed && !category) {
    results.innerHTML = '<p class="field-note">Type to search, or pick a category to browse.</p>';
    return;
  }
  results.innerHTML = '<p class="field-note">Searching…</p>';

  const user = auth?.getUser();
  const withTextSearch = (q) => (trimmed ? q.textSearch('body_tsv', trimmed, { type: 'websearch', config: 'simple' }) : q);

  let publicNotesQuery = auth.client.from('line_notes').select('*').eq('is_private', false).eq('hidden', false);
  if (category) publicNotesQuery = publicNotesQuery.eq('category', category);
  publicNotesQuery = withTextSearch(publicNotesQuery).order('created_at', { ascending: false }).limit(30);

  // Comments have no category of their own -- a category filter has nothing
  // to match there, so skip searching replies entirely rather than
  // silently ignoring the filter and returning replies that don't fit it.
  const commentsPromise = category
    ? Promise.resolve({ data: [] })
    : withTextSearch(auth.client.from('comments').select('*').eq('hidden', false))
        .order('created_at', { ascending: false }).limit(30);

  let privateNotesPromise = Promise.resolve({ data: [] });
  if (user) {
    let privateNotesQuery = auth.client.from('line_notes').select('*').eq('is_private', true).eq('author_id', user.id);
    if (category) privateNotesQuery = privateNotesQuery.eq('category', category);
    privateNotesPromise = withTextSearch(privateNotesQuery).order('created_at', { ascending: false }).limit(30);
  }

  const [publicNotesResult, commentsResult, privateNotesResult] = await Promise.all([publicNotesQuery, commentsPromise, privateNotesPromise]);
  if (results.dataset.query !== trimmed || results.dataset.category !== (category || '')) return; // a newer search superseded this one
  if (publicNotesResult.error && commentsResult.error && privateNotesResult.error) {
    results.innerHTML = '<p class="field-note">Could not search right now.</p>';
    return;
  }
  const commentRows = commentsResult.data || [];
  const noteIds = [...new Set(commentRows.map((row) => row.note_id))];
  const noteById = new Map();
  if (noteIds.length) {
    const { data: parentNotes } = await auth.client
      .from('line_notes').select('id, daf_ref_key, is_private, hidden')
      .in('id', noteIds);
    for (const note of parentNotes || []) noteById.set(note.id, note);
  }
  // Belt and braces, not the actual security boundary (comments_public_read
  // already gates this at the DB level) -- just keeps a comment whose
  // parent note is private/hidden from surfacing here even transiently.
  const visibleComments = commentRows
    .filter((row) => {
      const note = noteById.get(row.note_id);
      return note && !note.is_private && !note.hidden;
    })
    .map((row) => ({ ...row, daf_ref_key: noteById.get(row.note_id).daf_ref_key }));
  const allNotes = [...(publicNotesResult.data || []), ...(privateNotesResult.data || [])];
  renderSearchResults(allNotes, visibleComments);
}

function initNotesSearch() {
  const { dialog, input, categoryFilter } = searchDialogEls();
  if (!dialog) return; // page doesn't ship notes search

  renderSearchCategoryFilter();

  $('searchNotesButton')?.addEventListener('click', () => {
    dialog.showModal();
    input.focus();
  });
  $('closeSearchNotesDialog')?.addEventListener('click', () => dialog.close());
  input.addEventListener('input', () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => runNotesSearch(), 300);
  });
  categoryFilter.addEventListener('change', () => runNotesSearch());
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initNotesSearch);
} else {
  initNotesSearch();
}
