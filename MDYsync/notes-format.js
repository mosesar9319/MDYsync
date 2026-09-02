'use strict';

// Shared note-formatting helpers: the category vocabulary and the small set of
// pure render functions that turn a stored note/reply row into display markup.
//
// Extracted from notes.js so more than one page can render a note without
// either duplicating these or depending on notes.js's internals. chaburah.js
// and highlights.js already reached into notes.js for exactly these
// (CATEGORY_TYPES, categoryByKey, formatNoteTime, renderFormattedBody,
// renderTimestampPill, demoPillHtml), which made notes.js a de facto shared
// library by accident of script order. The Cloud Chabura rebuild needs the
// same helpers from new modules, and copying them would guarantee drift.
//
// Loaded as a plain classic script BEFORE notes.js, matching the rest of the
// site (no build step, no modules). Definitions stay bare globals so every
// existing caller keeps working unchanged; window.DafNotesFormat below is the
// handle new code should use, so it does not have to rely on load-order luck.
//
// Depends on escapeHtml (app.js) at call time only.

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

// mm:ss, or h:mm:ss once a shiur runs past an hour.
function formatTimestamp(totalSeconds) {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// Clickable only where the currently-loaded video is guaranteed to be the
// SAME one the note is about (the per-line dialog on the daf itself) --
// search results and the moderation queue can list notes from any daf, and
// seeking whatever video happens to be playing to a timestamp from a
// completely different shiur would be actively wrong, so those render a
// plain, non-interactive label instead.
function renderTimestampPill(row, clickable) {
  if (row.video_timestamp_seconds == null) return '';
  const label = `▶ ${formatTimestamp(row.video_timestamp_seconds)}`;
  if (!clickable) return `<span class="note-pill note-timestamp-pill">${label}</span>`;
  return `<button type="button" class="note-pill note-timestamp-pill note-timestamp-seek" data-seconds="${row.video_timestamp_seconds}" title="Jump to this moment in the video">${label}</button>`;
}

// Seed content shown to early readers so a still-empty site doesn't look
// dead -- clearly labeled everywhere it can appear (per-line dialog, search,
// the Chaburah feed, the moderation queue) rather than relying on the
// author name alone, which a skimming reader could easily miss.
function demoPillHtml(row) {
  return row.is_demo ? '<span class="note-pill note-pill-demo" title="Example content, not from a real reader">🧪 Demo</span>' : '';
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

// Explicit surface for new code. The bare globals above remain for the
// existing callers; prefer this handle in anything written from here on.
window.DafNotesFormat = {
  CATEGORY_TYPES,
  categoryByKey,
  formatTimestamp,
  renderTimestampPill,
  demoPillHtml,
  formatNoteTime,
  NOTE_FORMAT_MARKERS,
  renderFormattedBody,
};
