'use strict';

// Cloud Chabura render helpers.
//
// Everything here builds real DOM nodes and sets user content via textContent.
// The one exception is the note body, which goes through
// DafNotesFormat.renderFormattedBody -- that function escapes the raw text
// FIRST and only then wraps ranges of the already-escaped string in its own
// hardcoded tags, so there is still no path from stored text to executable
// markup. See its comment in notes-format.js.

(function () {
  const fmt = () => window.DafNotesFormat;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function chip(text, variant) {
    const node = el('span', `cc-chip${variant ? ' ' + variant : ''}`);
    node.textContent = text;
    return node;
  }

  // Category chips show the Hebrew term AND the English gloss. The old feed
  // put the English in a title attribute only, which is hover-only and simply
  // unavailable on touch (audit F-11).
  function categoryChip(categoryKey) {
    const info = fmt()?.categoryByKey(categoryKey);
    if (!info) return null;
    const node = el('span', 'cc-chip cc-chip-category');
    const he = el('span', 'cc-chip-he', info.he);
    he.lang = 'he';
    he.dir = 'rtl';
    const en = el('span', 'cc-chip-en', info.en);
    node.append(he, en);
    node.title = info.meaning;
    return node;
  }

  function dafLabel(dafRefKey) {
    return (dafRefKey || '').replace(/-/g, ' ');
  }

  function skeletonCard() {
    const card = el('div', 'cc-skeleton');
    card.setAttribute('aria-hidden', 'true');
    [
      { width: '38%' },
      { width: '82%' },
      { width: '64%' },
      { width: '28%' },
    ].forEach((spec) => {
      const line = el('div', 'cc-skeleton-line');
      line.style.width = spec.width;
      card.appendChild(line);
    });
    return card;
  }

  function loadingState(count) {
    const wrap = document.createDocumentFragment();
    for (let i = 0; i < (count || 3); i += 1) wrap.appendChild(skeletonCard());
    return wrap;
  }

  // Empty copy names what is empty and what to do next, and never claims the
  // site is empty when only a filter came back with nothing.
  function emptyState({ title, body, actionLabel, onAction }) {
    const wrap = el('div', 'cc-empty');
    wrap.appendChild(el('h3', null, title));
    if (body) wrap.appendChild(el('p', null, body));
    if (actionLabel && onAction) {
      const button = el('button', 'cc-btn cc-btn-primary', actionLabel);
      button.type = 'button';
      button.addEventListener('click', onAction);
      wrap.appendChild(button);
    }
    return wrap;
  }

  function errorState({ message, onRetry }) {
    const wrap = el('div', 'cc-error');
    wrap.setAttribute('role', 'alert');
    wrap.appendChild(el('h3', null, 'Could not load discussions'));
    wrap.appendChild(el('p', null, message));
    if (onRetry) {
      const button = el('button', 'cc-btn', 'Try again');
      button.type = 'button';
      button.addEventListener('click', onRetry);
      wrap.appendChild(button);
    }
    return wrap;
  }

  // A legacy note has no title -- derive a display one from its first line
  // rather than backfilling the column destructively.
  function displayTitle(row) {
    if (row.title) return row.title;
    const firstLine = String(row.body || '').split('\n').find((line) => line.trim());
    const text = (firstLine || 'Untitled discussion').trim();
    return text.length > 90 ? `${text.slice(0, 89)}…` : text;
  }

  // When the heading was BORROWED from the body's first line, printing the body
  // verbatim underneath repeats that sentence twice on every legacy card --
  // which is precisely how it looked. A note with a real stored title keeps its
  // whole body, because nothing was taken from it.
  function bodyPreview(row) {
    const body = String(row.body || '');
    if (row.title) return body;
    const lines = body.split('\n');
    const first = lines.findIndex((line) => line.trim());
    if (first < 0) return body;
    return lines.slice(first + 1).join('\n').trim();
  }

  function threadCard(row, handlers) {
    const card = el('article', 'cc-card');
    card.dataset.id = row.id;
    card.dataset.dafRefKey = row.daf_ref_key || '';

    const top = el('div', 'cc-card-top');
    const category = categoryChip(row.category);
    if (category) top.appendChild(category);
    if (row.daf_ref_key) top.appendChild(chip(dafLabel(row.daf_ref_key), 'cc-chip-daf'));

    if (row.highlighted_comment_id) top.appendChild(chip('Answered', 'cc-chip-answered'));
    else if (row.status === 'open' && row.replyCount === 0) top.appendChild(chip('Unanswered', 'cc-chip-unanswered'));
    if (row.status === 'resolved') top.appendChild(chip('Resolved', 'cc-chip-answered'));
    if (row.status === 'locked') top.appendChild(chip('Locked', 'cc-chip-locked'));
    if (row.video_timestamp_seconds != null) {
      top.appendChild(chip(`▶ ${fmt().formatTimestamp(row.video_timestamp_seconds)}`, 'cc-chip-video'));
    }
    if (row.is_demo) top.appendChild(chip('Demo', 'cc-chip-demo'));
    if (row.unreadCount > 0) {
      top.appendChild(chip(`${row.unreadCount} new`, 'cc-chip-unread'));
    }
    card.appendChild(top);

    const title = el('h3', 'cc-card-title');
    const link = el('a', null, displayTitle(row));
    link.href = handlers.threadHref(row);
    title.appendChild(link);
    card.appendChild(title);

    // The exact passage the discussion is about, when there is one -- the
    // product's whole differentiator, so it sits above the body, not below.
    if (row.selected_text) {
      const source = el('p', 'cc-card-source', row.selected_text);
      source.lang = 'he';
      source.dir = 'rtl';
      card.appendChild(source);
    }

    const preview = bodyPreview(row);
    if (preview) {
      const body = el('p', 'cc-card-body');
      body.innerHTML = fmt().renderFormattedBody(preview);
      card.appendChild(body);
    }

    const meta = el('div', 'cc-card-meta');
    meta.appendChild(el('span', null, row.author_display_name || 'Anonymous'));

    const time = el('time', null, fmt().formatNoteTime(row.last_activity_at || row.created_at));
    const exact = new Date(row.last_activity_at || row.created_at);
    if (!Number.isNaN(exact.getTime())) {
      time.dateTime = exact.toISOString();
      time.title = exact.toLocaleString();
    }
    meta.appendChild(time);

    const replies = row.replyCount === 1 ? '1 reply' : `${row.replyCount} replies`;
    meta.appendChild(el('span', null, replies));
    if (row.participantCount > 1) {
      meta.appendChild(el('span', null, `${row.participantCount} people`));
    }
    if (row.reactionCount > 0) {
      meta.appendChild(el('span', null, row.reactionCount === 1 ? '1 reaction' : `${row.reactionCount} reactions`));
    }

    const actions = el('div', 'cc-card-actions');
    actions.appendChild(toggleButton({
      label: row.isFollowed ? 'Following' : 'Follow',
      pressed: row.isFollowed,
      title: row.isFollowed ? 'Stop following this discussion' : 'Follow this discussion',
      onClick: () => handlers.onToggleFollow(row),
    }));
    actions.appendChild(toggleButton({
      label: row.isSaved ? 'Saved' : 'Save',
      pressed: row.isSaved,
      title: row.isSaved ? 'Remove from saved' : 'Save for later',
      onClick: () => handlers.onToggleSaved(row),
    }));
    meta.appendChild(actions);

    card.appendChild(meta);
    return card;
  }

  function toggleButton({ label, pressed, title, onClick }) {
    const button = el('button', 'cc-btn cc-btn-quiet cc-btn-sm', label);
    button.type = 'button';
    button.title = title;
    button.setAttribute('aria-pressed', String(Boolean(pressed)));
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
    return button;
  }

  window.DafSyncChabura = window.DafSyncChabura || {};
  window.DafSyncChabura.components = {
    el,
    chip,
    categoryChip,
    dafLabel,
    displayTitle,
    bodyPreview,
    loadingState,
    emptyState,
    errorState,
    threadCard,
  };
})();
