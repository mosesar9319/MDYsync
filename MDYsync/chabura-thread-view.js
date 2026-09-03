'use strict';

// Render helpers for the Cloud Chabura thread reader.
//
// Everything builds real DOM nodes and sets user content with textContent. The
// single exception is a post body, which goes through
// DafNotesFormat.renderFormattedBody -- that function escapes the raw text
// FIRST and only then wraps ranges of the already-escaped string in its own
// hardcoded tags, so there is still no path from stored text to executable
// markup. See its comment in notes-format.js.

(function () {
  const S = window.DafSyncChabura.threadState;
  const fmt = () => window.DafNotesFormat;

  const REACTION_TYPES = [
    { key: 'helpful', label: 'Helpful' },
    { key: 'insightful', label: 'Insightful' },
    { key: 'chazak', label: 'Chazak' },
    { key: 'shtark', label: 'Shtark' },
    { key: 'great_kasha', label: 'Great Kasha' },
  ];

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function button(className, label, onClick, options = {}) {
    const node = el('button', className, label);
    node.type = 'button';
    if (options.title) node.title = options.title;
    if (options.ariaLabel) node.setAttribute('aria-label', options.ariaLabel);
    if (options.pressed !== undefined) node.setAttribute('aria-pressed', String(Boolean(options.pressed)));
    if (options.expanded !== undefined) node.setAttribute('aria-expanded', String(Boolean(options.expanded)));
    if (options.disabled) node.disabled = true;
    if (onClick) node.addEventListener('click', onClick);
    return node;
  }

  function initials(name) {
    return String(name || 'Anonymous').trim().split(/\s+/).slice(0, 2)
      .map((part) => part[0] || '').join('').toUpperCase() || '?';
  }

  function avatar(name, profile) {
    const node = el('span', 'ct-avatar', initials(name));
    node.setAttribute('aria-hidden', 'true');
    if (profile?.role_label) node.classList.add('ct-avatar-role');
    return node;
  }

  function timeNode(iso, editedAt) {
    const wrap = el('span', 'ct-time');
    const time = el('time', null, fmt().formatNoteTime(iso));
    const exact = new Date(iso);
    if (!Number.isNaN(exact.getTime())) {
      time.dateTime = exact.toISOString();
      // The exact datetime is available to a screen reader, not only on hover.
      time.title = exact.toLocaleString();
      time.setAttribute('aria-label', exact.toLocaleString());
    }
    wrap.appendChild(time);
    if (editedAt) {
      const edited = el('span', 'ct-edited', 'Edited');
      const when = new Date(editedAt);
      if (!Number.isNaN(when.getTime())) edited.title = `Edited ${when.toLocaleString()}`;
      wrap.appendChild(edited);
    }
    return wrap;
  }

  function categoryChip(categoryKey) {
    const info = fmt()?.categoryByKey(categoryKey);
    if (!info) return null;
    const node = el('span', 'cc-chip cc-chip-category');
    const he = el('span', 'cc-chip-he', info.he);
    he.lang = 'he';
    he.dir = 'rtl';
    node.append(he, el('span', 'cc-chip-en', info.en));
    node.title = info.meaning;
    return node;
  }

  function statusChip(note) {
    if (note.deleted_at) return el('span', 'cc-chip cc-chip-locked', 'Deleted');
    if (note.status === 'locked') return el('span', 'cc-chip cc-chip-locked', 'Locked');
    if (note.status === 'resolved') return el('span', 'cc-chip cc-chip-answered', 'Resolved');
    if (note.highlighted_comment_id) return el('span', 'cc-chip cc-chip-answered', 'Answered');
    return el('span', 'cc-chip cc-chip-unanswered', 'Open');
  }

  function displayTitle(note) {
    if (note.title) return note.title;
    if (note.deleted_at) return 'Deleted discussion';
    const firstLine = String(note.body || '').split('\n').find((line) => line.trim());
    const text = (firstLine || 'Untitled discussion').trim();
    return text.length > 120 ? `${text.slice(0, 119)}…` : text;
  }

  function bodyNode(row) {
    const node = el('p', 'ct-body');
    if (row.deleted_at || row.hidden) {
      node.classList.add('ct-body-removed');
      node.textContent = S.tombstoneLabel(row);
      return node;
    }
    node.innerHTML = fmt().renderFormattedBody(row.body || '');
    return node;
  }

  // --- Source context ------------------------------------------------------

  // The plan calls this the product's differentiator and says to treat it as
  // core UI rather than metadata, so it gets the passage itself -- not just a
  // reference to it.
  function sourceContext(note, options) {
    const panel = el('section', 'ct-source');
    panel.setAttribute('aria-label', 'Source');
    panel.appendChild(el('h2', 'ct-panel-title', 'Source'));

    const ref = el('p', 'ct-source-ref', (note.daf_ref_key || '').replace(/-/g, ' '));
    panel.appendChild(ref);
    if (note.segment_ref) panel.appendChild(el('p', 'ct-source-segment', note.segment_ref));

    if (note.selected_text) {
      const quote = el('blockquote', 'ct-source-text', note.selected_text);
      quote.lang = 'he';
      quote.dir = 'rtl';
      panel.appendChild(quote);
    } else {
      panel.appendChild(el('p', 'ct-source-empty', 'This discussion is attached to the whole passage rather than a selected phrase.'));
    }

    if (options.driftWarning) {
      const warn = el('p', 'ct-source-drift', '⚠ The daf’s word positions were rebuilt since this was written, so the highlighted passage may no longer match exactly.');
      warn.setAttribute('role', 'note');
      panel.appendChild(warn);
    }

    const actions = el('div', 'ct-source-actions');
    const onDaf = el('a', 'cc-btn cc-btn-sm', 'Show on daf');
    onDaf.href = options.dafHref;
    actions.appendChild(onDaf);

    // Never fabricate a timestamp. No alignment means no action and a plain
    // sentence saying so, rather than a button that seeks to zero.
    if (Number.isFinite(note.video_timestamp_seconds)) {
      const play = el('a', 'cc-btn cc-btn-sm', `▶ Play shiur moment (${fmt().formatTimestamp(note.video_timestamp_seconds)})`);
      play.href = options.playHref;
      actions.appendChild(play);
    }
    panel.appendChild(actions);

    if (!Number.isFinite(note.video_timestamp_seconds)) {
      panel.appendChild(el('p', 'ct-source-empty', 'No synchronized shiur moment for this passage.'));
    }
    return panel;
  }

  // --- Reactions -----------------------------------------------------------

  // Shows the one or two most-used reactions inline; the rest live behind
  // "Add reaction" so a reply's action row stays readable.
  function reactionBar(targetType, targetId, entry, handlers, options = {}) {
    const bar = el('div', 'ct-reactions');
    const counts = entry?.counts || new Map();
    const mine = entry?.mine || new Set();

    const used = REACTION_TYPES
      .map((type) => ({ ...type, count: counts.get(type.key) || 0, mine: mine.has(type.key) }))
      .filter((type) => type.count > 0 || type.mine)
      .sort((a, b) => b.count - a.count);

    used.slice(0, 2).forEach((type) => {
      bar.appendChild(reactionPill(targetType, targetId, type, handlers, options));
    });

    if (used.length > 2) {
      const more = el('span', 'ct-reaction-more', `+${used.length - 2}`);
      more.title = used.slice(2).map((type) => `${type.label} (${type.count})`).join(' · ');
      bar.appendChild(more);
    }

    if (!options.readOnly) {
      const add = button('ct-reaction-add', '＋', null, {
        ariaLabel: 'Add reaction',
        title: 'Add reaction',
        expanded: false,
      });
      add.addEventListener('click', (event) => {
        event.stopPropagation();
        handlers.openReactionMenu(add, targetType, targetId, entry);
      });
      bar.appendChild(add);
    }
    return bar;
  }

  function reactionPill(targetType, targetId, type, handlers, options) {
    const pill = button(
      `ct-reaction${type.mine ? ' is-mine' : ''}`,
      '',
      options.readOnly ? null : () => handlers.onToggleReaction(targetType, targetId, type.key, !type.mine),
      {
        pressed: type.mine,
        title: type.mine ? `Remove your ${type.label}` : `Mark as ${type.label}`,
        ariaLabel: `${type.label}, ${type.count}${type.mine ? ', selected' : ''}`,
        disabled: Boolean(options.readOnly),
      }
    );
    pill.append(el('span', 'ct-reaction-label', type.label), el('span', 'ct-reaction-count', String(type.count)));
    return pill;
  }

  function reactionMenu(entry, onPick) {
    const menu = el('div', 'ct-menu');
    menu.setAttribute('role', 'menu');
    const mine = entry?.mine || new Set();
    REACTION_TYPES.forEach((type) => {
      const item = button('ct-menu-item', type.label, () => onPick(type.key, !mine.has(type.key)), {
        pressed: mine.has(type.key),
      });
      item.setAttribute('role', 'menuitemcheckbox');
      item.setAttribute('aria-checked', String(mine.has(type.key)));
      menu.appendChild(item);
    });
    return menu;
  }

  // --- Action rows ---------------------------------------------------------

  function actionRow(row, kind, ctx) {
    const actions = el('div', 'ct-actions');
    const removed = S.isTombstone(row);
    const targetType = kind === 'note' ? 'note' : 'comment';
    const targetId = row.id;

    if (!removed) {
      actions.appendChild(reactionBar(targetType, targetId, ctx.reactions.get(targetId), ctx.handlers, {
        readOnly: !ctx.signedIn,
      }));
    }

    // Reply and More stay real buttons at every width -- the plan requires
    // them discoverable on touch, where there is no hover to reveal them.
    if (ctx.canReply && !removed) {
      actions.appendChild(button('cc-btn cc-btn-quiet cc-btn-sm', 'Reply',
        () => ctx.handlers.onReply(kind === 'note' ? null : row.id)));
      actions.appendChild(button('cc-btn cc-btn-quiet cc-btn-sm', 'Quote',
        () => ctx.handlers.onQuote(kind === 'note' ? null : row.id)));
    }

    const menuItems = buildMenuItems(row, kind, ctx);
    if (menuItems.length) {
      const more = button('cc-btn cc-btn-quiet cc-btn-sm ct-more', '⋯', null, {
        ariaLabel: 'More actions',
        expanded: false,
      });
      more.addEventListener('click', (event) => {
        event.stopPropagation();
        ctx.handlers.openActionMenu(more, menuItems);
      });
      actions.appendChild(more);
    }
    return actions;
  }

  function buildMenuItems(row, kind, ctx) {
    const items = [];
    const isNote = kind === 'note';
    const removed = S.isTombstone(row);
    const mine = ctx.viewerId && row.author_id === ctx.viewerId;

    items.push({
      label: isNote ? 'Copy link to discussion' : 'Copy link to reply',
      onSelect: () => ctx.handlers.onCopyLink(isNote ? null : row.id),
    });

    if (!removed && mine) {
      items.push({ label: 'Edit', onSelect: () => ctx.handlers.onEdit(isNote ? null : row.id) });
      items.push({ label: 'Delete', danger: true, onSelect: () => ctx.handlers.onDelete(isNote ? null : row.id) });
    }

    // Marking an answer belongs to the root author and to moderators, which is
    // exactly who line_notes_update lets write the column.
    if (!isNote && !removed && ctx.canHighlight) {
      const already = ctx.note.highlighted_comment_id === row.id;
      items.push({
        label: already ? 'Unmark as answer' : 'Mark as answer',
        onSelect: () => ctx.handlers.onHighlight(already ? null : row.id),
      });
    }

    if (isNote && ctx.canModerateThread && !removed) {
      items.push({
        label: ctx.note.status === 'resolved' ? 'Reopen discussion' : 'Mark resolved',
        onSelect: () => ctx.handlers.onStatus(ctx.note.status === 'resolved' ? 'open' : 'resolved'),
      });
      items.push({
        label: ctx.note.status === 'locked' ? 'Unlock discussion' : 'Lock discussion',
        onSelect: () => ctx.handlers.onStatus(ctx.note.status === 'locked' ? 'open' : 'locked'),
      });
    }

    if (!removed && ctx.signedIn && !mine) {
      items.push({ label: 'Report', onSelect: () => ctx.handlers.onReport(isNote ? 'note' : 'comment', row.id) });
    }
    return items;
  }

  function actionMenu(items) {
    const menu = el('div', 'ct-menu');
    menu.setAttribute('role', 'menu');
    items.forEach((item) => {
      const node = button(`ct-menu-item${item.danger ? ' is-danger' : ''}`, item.label, () => item.onSelect());
      node.setAttribute('role', 'menuitem');
      menu.appendChild(node);
    });
    return menu;
  }

  // --- Posts ---------------------------------------------------------------

  function quoteCard(row, ctx) {
    if (!row.quoted_comment_id && !row.quoted_excerpt) return null;
    const card = el('div', 'ct-quote');
    const source = ctx.state.commentsById.get(row.quoted_comment_id);
    const who = source ? (source.author_display_name || 'Anonymous') : 'A reply';
    const head = el('p', 'ct-quote-head');
    if (source && !S.isTombstone(source)) {
      const link = el('a', null, `${who} wrote`);
      link.href = `#comment-${row.quoted_comment_id}`;
      head.appendChild(link);
      // An excerpt is immutable, so it can drift from an original that was
      // edited afterwards. Saying so is the difference between a stale quote
      // and an apparent misquote.
      if (source.edited_at && Date.parse(source.edited_at) > Date.parse(row.created_at)) {
        head.appendChild(el('span', 'ct-quote-stale', ' — edited since'));
      }
    } else {
      // The stored excerpt is why a quote survives its original being removed.
      head.appendChild(el('span', null, source ? `${who} wrote — since removed` : 'Quoted reply'));
    }
    card.appendChild(head);
    card.appendChild(el('p', 'ct-quote-body', row.quoted_excerpt || ''));
    return card;
  }

  function rootPost(note, ctx) {
    const article = el('article', 'ct-root');
    article.id = 'root-post';
    article.setAttribute('aria-label', 'Opening post');

    const head = el('div', 'ct-post-head');
    head.appendChild(avatar(note.author_display_name, ctx.profiles.get(note.author_id)));
    const who = el('div', 'ct-who');
    who.appendChild(el('span', 'ct-author', note.author_display_name || 'Anonymous'));
    const role = ctx.profiles.get(note.author_id)?.role_label;
    if (role) who.appendChild(el('span', 'ct-role', role));
    who.appendChild(timeNode(note.created_at, note.edited_at));
    head.appendChild(who);
    article.appendChild(head);

    article.appendChild(bodyNode(note));
    article.appendChild(actionRow(note, 'note', ctx));
    return article;
  }

  // --- Reply tree ----------------------------------------------------------

  function collapsedBranch(rootId, stats, onExpand) {
    const node = el('div', 'ct-collapsed');
    const label = stats.unread > 0
      ? `${stats.replies} ${stats.replies === 1 ? 'reply' : 'replies'} · ${stats.unread} unread`
      : `${stats.replies} ${stats.replies === 1 ? 'reply' : 'replies'}`;
    const expand = button('ct-collapsed-button', label, () => onExpand(rootId), {
      expanded: false,
      ariaLabel: `Expand branch, ${label}`,
    });
    node.appendChild(expand);
    if (stats.unread > 0) node.appendChild(el('span', 'ct-unread-dot', ''));
    return node;
  }

  function replyItem(row, ctx) {
    const item = el('article', 'ct-reply');
    item.id = `comment-${row.id}`;
    item.dataset.id = row.id;
    item.dataset.depth = String(row.depth);

    const level = S.indentLevel(row.depth, ctx.isMobile);
    item.style.setProperty('--ct-indent', String(level));
    if (S.isIndentCapped(row.depth, ctx.isMobile)) item.classList.add('ct-reply-capped');

    if (row.pending) item.classList.add('is-pending');
    const unread = row.activity_sequence > ctx.state.viewer.lastReadSequence;
    if (unread) item.classList.add('is-unread');
    if (ctx.note.highlighted_comment_id === row.id) item.classList.add('is-answer');
    if (S.isTombstone(row)) item.classList.add('is-removed');

    // A screen reader gets the author and the nesting level, which the visual
    // indentation alone conveys only to sighted users.
    const parent = row.parent_comment_id ? ctx.state.commentsById.get(row.parent_comment_id) : null;
    const parentName = parent ? (parent.author_display_name || 'Anonymous') : null;
    item.setAttribute('aria-label',
      `Reply by ${row.author_display_name || 'Anonymous'}, level ${row.depth + 1}` +
      (parentName ? `, replying to ${parentName}` : ''));

    if (ctx.note.highlighted_comment_id === row.id) {
      item.appendChild(el('p', 'ct-answer-flag', 'Highlighted answer'));
    }

    const head = el('div', 'ct-post-head');
    if (!S.isTombstone(row)) {
      head.appendChild(avatar(row.author_display_name, ctx.profiles.get(row.author_id)));
    }
    const who = el('div', 'ct-who');
    if (S.isTombstone(row)) {
      who.appendChild(el('span', 'ct-author ct-author-removed', 'Removed'));
    } else {
      who.appendChild(el('span', 'ct-author', row.author_display_name || 'Anonymous'));
      const role = ctx.profiles.get(row.author_id)?.role_label;
      if (role) who.appendChild(el('span', 'ct-role', role));
      who.appendChild(timeNode(row.created_at, row.edited_at));
    }
    head.appendChild(who);

    // Past the indentation cap the parent is no longer visually obvious, so it
    // is stated instead of implied by an ever-narrowing column.
    if (S.isIndentCapped(row.depth, ctx.isMobile) && parentName) {
      const context = el('span', 'ct-replying-to');
      context.append(document.createTextNode('Replying to '));
      const link = el('a', null, parentName);
      link.href = `#comment-${row.parent_comment_id}`;
      context.appendChild(link);
      head.appendChild(context);
    }
    item.appendChild(head);

    const quote = quoteCard(row, ctx);
    if (quote) item.appendChild(quote);

    item.appendChild(bodyNode(row));
    if (row.pending) {
      // No action row while it is in flight: reacting to or replying to a reply
      // the server has not accepted yet would fail on a foreign key.
      const sending = el('p', 'ct-sending', 'Sending…');
      sending.setAttribute('role', 'status');
      item.appendChild(sending);
    } else if (!S.isTombstone(row)) {
      item.appendChild(actionRow(row, 'comment', ctx));
    }
    return item;
  }

  // Renders a branch depth-first. A collapsed branch renders its root plus a
  // summary line, never its descendants -- which is the point.
  function branch(rootId, ctx, out) {
    const row = ctx.state.commentsById.get(rootId);
    if (!row) return;
    out.appendChild(replyItem(row, ctx));

    const children = S.childIds(ctx.state, rootId);
    if (!children.length) return;

    if (ctx.state.collapsed.has(rootId)) {
      out.appendChild(collapsedBranch(rootId, S.branchStats(ctx.state, rootId), ctx.handlers.onExpandBranch));
      return;
    }
    children.forEach((childId) => branch(childId, ctx, out));
  }

  function replyTree(ctx) {
    const list = el('div', 'ct-replies');
    const roots = S.orderedTopLevel(ctx.state);
    if (!roots.length) {
      list.appendChild(el('p', 'ct-empty', 'No replies yet. Be the first to respond.'));
      return list;
    }
    roots.forEach((rootId) => {
      const wrap = el('section', 'ct-branch');
      wrap.dataset.root = rootId;
      const stats = S.branchStats(ctx.state, rootId);
      if (stats.replies) {
        wrap.appendChild(button('ct-branch-toggle',
          ctx.state.collapsed.has(rootId) ? 'Expand' : 'Collapse',
          () => ctx.handlers.onToggleBranch(rootId),
          {
            expanded: !ctx.state.collapsed.has(rootId),
            ariaLabel: `${ctx.state.collapsed.has(rootId) ? 'Expand' : 'Collapse'} branch with ${stats.replies} replies`,
          }));
      }
      branch(rootId, ctx, wrap);
      list.appendChild(wrap);
    });
    return list;
  }

  // --- Outline -------------------------------------------------------------

  function threadOutline(ctx) {
    const panel = el('section', 'ct-outline');
    panel.setAttribute('aria-label', 'Thread outline');
    panel.appendChild(el('h2', 'ct-panel-title', 'In this discussion'));

    const people = S.participants(ctx.state);
    const peopleList = el('ul', 'ct-participants');
    people.slice(0, 8).forEach((person) => {
      const item = el('li');
      item.appendChild(avatar(person.name, ctx.profiles.get(person.id)));
      item.appendChild(el('span', null, person.name));
      peopleList.appendChild(item);
    });
    panel.appendChild(peopleList);
    if (people.length > 8) panel.appendChild(el('p', 'ct-outline-more', `+${people.length - 8} more`));

    const roots = S.orderedTopLevel(ctx.state);
    const map = el('ul', 'ct-branch-map');
    roots.forEach((rootId) => {
      const row = ctx.state.commentsById.get(rootId);
      if (!row) return;
      const stats = S.branchStats(ctx.state, rootId);
      const item = el('li');
      const link = button('ct-branch-link', '', () => ctx.handlers.onJumpTo(rootId));
      const who = S.isTombstone(row) ? 'Removed' : (row.author_display_name || 'Anonymous');
      link.appendChild(el('span', 'ct-branch-author', who));
      link.appendChild(el('span', 'ct-branch-count',
        stats.unread ? `${stats.replies} · ${stats.unread} new` : String(stats.replies)));
      if (ctx.note.highlighted_comment_id &&
          [rootId].concat(S.descendantIds(ctx.state, rootId)).includes(ctx.note.highlighted_comment_id)) {
        link.appendChild(el('span', 'ct-branch-answer', '✓'));
      }
      item.appendChild(link);
      map.appendChild(item);
    });
    panel.appendChild(map);
    return panel;
  }

  window.DafSyncChabura = window.DafSyncChabura || {};
  window.DafSyncChabura.threadView = {
    REACTION_TYPES,
    el,
    button,
    initials,
    avatar,
    timeNode,
    categoryChip,
    statusChip,
    displayTitle,
    bodyNode,
    sourceContext,
    reactionBar,
    reactionMenu,
    actionRow,
    actionMenu,
    rootPost,
    replyItem,
    collapsedBranch,
    replyTree,
    threadOutline,
  };
})();
