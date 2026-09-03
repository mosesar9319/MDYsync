'use strict';

// Cloud Chabura thread reader controller.
//
// Route: /chaburah/thread/?thread=<note uuid>&comment=<optional comment uuid>
// UUIDs rather than title slugs, so a permalink cannot rot when a title is
// edited and nothing has to guess which discussion a slug meant.

(function () {
  const data = window.DafSyncChabura.threadData;
  const S = window.DafSyncChabura.threadState;
  const V = window.DafSyncChabura.threadView;
  const C = window.DafSyncChabura.threadComposer;
  const { el, button } = V;

  const MOBILE_QUERY = '(max-width: 900px)';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  let state = S.createState();
  const els = {};
  let activeComposer = null;      // { parentId, instance, host }
  let openMenu = null;
  let pageWordBoxes = null;
  let driftChecked = false;

  function isMobile() { return window.matchMedia(MOBILE_QUERY).matches; }
  function signedIn() { return Boolean(window.DafSyncAuth?.getUser?.()); }
  function viewerId() { return window.DafSyncAuth?.getUser?.()?.id || null; }

  function cacheEls() {
    els.root = document.getElementById('ctRoot');
    els.source = document.getElementById('ctSource');
    els.outline = document.getElementById('ctOutline');
    els.header = document.getElementById('ctHeader');
    els.discussion = document.getElementById('ctDiscussion');
    els.replies = document.getElementById('ctReplies');
    els.composer = document.getElementById('ctComposer');
    els.status = document.getElementById('ctStatus');
    els.toolbar = document.getElementById('ctToolbar');
    els.search = document.getElementById('ctSearch');
    els.sort = document.getElementById('ctSort');
    els.loadMore = document.getElementById('ctLoadMore');
    els.loadMoreWrap = document.getElementById('ctLoadMoreWrap');
    els.help = document.getElementById('ctHelp');
    els.helpDialog = document.getElementById('ctHelpDialog');
    els.sourceToggle = document.getElementById('ctSourceToggle');
    els.outlineToggle = document.getElementById('ctOutlineToggle');
  }

  function announce(message) {
    if (els.status) els.status.textContent = message;
  }

  function toast(message) {
    announce(message);
    let node = document.getElementById('ctToast');
    if (!node) {
      node = el('div', 'ct-toast');
      node.id = 'ctToast';
      document.body.appendChild(node);
    }
    node.textContent = message;
    node.classList.add('is-visible');
    clearTimeout(node.dataset.timer);
    node.dataset.timer = String(setTimeout(() => node.classList.remove('is-visible'), 4000));
  }

  // --- URL -----------------------------------------------------------------

  function readUrl() {
    const params = new URLSearchParams(location.search);
    const thread = params.get('thread');
    const comment = params.get('comment');
    return {
      noteId: UUID.test(thread || '') ? thread : null,
      commentId: UUID.test(comment || '') ? comment : null,
      back: params.get('back') || '',
    };
  }

  function threadUrl(commentId) {
    const url = new URL(location.href);
    if (commentId) url.searchParams.set('comment', commentId);
    else url.searchParams.delete('comment');
    return url.toString();
  }

  // --- Loading -------------------------------------------------------------

  async function load() {
    const { noteId, commentId } = readUrl();
    if (!noteId) {
      renderMessage('This link is missing a discussion', 'The address does not name a discussion to open. Go back to Cloud Chabura and pick one.');
      return;
    }

    const token = data.nextGeneration();
    state = S.createState();
    state.loading = true;
    renderSkeleton();

    try {
      const { note, reason } = await data.fetchThread(noteId);
      if (!data.isCurrent(token)) return;
      if (!note) {
        state.reason = reason;
        renderUnavailable(reason);
        return;
      }
      state.note = note;

      const [branchPage, viewer] = await Promise.all([
        data.fetchBranchPage(noteId, null),
        data.fetchViewerState(noteId),
      ]);
      if (!data.isCurrent(token)) return;

      state.viewer = viewer;
      S.mergeComments(state, branchPage.rows);
      state.branchCursor = branchPage.cursor;
      state.hasMoreBranches = branchPage.hasMore;
      branchPage.rows.forEach((row) => state.loadedBranchRoots.add(row.id));

      if (branchPage.rows.length) {
        const descendants = await data.fetchDescendants(noteId, branchPage.rows.map((row) => row.id));
        if (!data.isCurrent(token)) return;
        S.mergeComments(state, descendants);
      }

      // A permalink may point outside the first page of branches, so its branch
      // is fetched explicitly rather than hoped for.
      if (commentId) {
        state.permalinkPending = true;
        const { target, rows } = await data.fetchPermalinkBranch(noteId, commentId);
        if (!data.isCurrent(token)) return;
        if (target) {
          S.mergeComments(state, rows);
          state.permalinkTarget = target.id;
          state.loadedBranchRoots.add(target.root_comment_id);
        } else {
          toast('That reply is no longer available. Showing the discussion instead.');
        }
        state.permalinkPending = false;
      }

      await hydrate(token);
      if (!data.isCurrent(token)) return;

      state.loading = false;
      render();
      afterRender({ scrollToPermalink: Boolean(state.permalinkTarget) });
      checkDrift();
      scheduleMarkRead();
    } catch (error) {
      if (!data.isCurrent(token)) return;
      console.error('Cloud Chabura thread failed to load.', error);
      state.loading = false;
      state.error = data.describeError(error);
      renderError();
    }
  }

  // Profiles and reactions for whatever is currently loaded.
  async function hydrate(token) {
    const commentIds = [...state.commentsById.keys()];
    const authorIds = [state.note.author_id].concat([...state.commentsById.values()].map((row) => row.author_id));
    const [profiles, reactions] = await Promise.all([
      data.fetchProfiles(authorIds),
      data.fetchReactions(state.note.id, commentIds),
    ]);
    if (!data.isCurrent(token)) return;
    state.profiles = profiles;
    state.reactions = reactions;
  }

  // The drift heuristic needs this daf's word boxes. Fetched once, only when
  // the note actually has a word range to check, and a failure is silent --
  // a missing page map means "cannot tell", never a false alarm.
  async function checkDrift() {
    if (driftChecked || !state.note) return;
    driftChecked = true;
    const runs = window.DafNotesFormat.noteAnchorRuns(state.note);
    if (!runs.length || !state.note.daf_ref_key) return;
    try {
      const path = `pages/${state.note.daf_ref_key}.json`;
      const response = await fetch(`/api/get-results-file?path=${encodeURIComponent(path)}`);
      if (!response.ok) return;
      const map = await response.json();
      pageWordBoxes = Array.isArray(map.wordBoxes)
        ? map.wordBoxes.map((box) => ({ ...box, ref: String(box.ref || '').replace(/:(\d+)$/, '.$1') }))
        : [];
      if (window.DafNotesFormat.anchorMayHaveShifted(state.note, pageWordBoxes)) renderSource();
    } catch { /* cannot tell; say nothing rather than warn wrongly */ }
  }

  async function loadMoreBranches() {
    if (!state.hasMoreBranches) return;
    const token = data.nextGeneration();
    els.loadMore.disabled = true;
    try {
      const page = await data.fetchBranchPage(state.note.id, state.branchCursor);
      if (!data.isCurrent(token)) return;
      S.mergeComments(state, page.rows);
      state.branchCursor = page.cursor;
      state.hasMoreBranches = page.hasMore;
      page.rows.forEach((row) => state.loadedBranchRoots.add(row.id));
      if (page.rows.length) {
        const descendants = await data.fetchDescendants(state.note.id, page.rows.map((row) => row.id));
        if (!data.isCurrent(token)) return;
        S.mergeComments(state, descendants);
      }
      await hydrate(token);
      if (!data.isCurrent(token)) return;
      render();
      afterRender({});
      announce(`${state.commentsById.size} replies loaded.`);
    } catch (error) {
      toast(data.describeError(error));
    } finally {
      els.loadMore.disabled = false;
    }
  }

  // --- Rendering -----------------------------------------------------------

  function renderSkeleton() {
    els.discussion.innerHTML = '';
    const wrap = el('div', 'ct-skeleton-wrap');
    for (let i = 0; i < 3; i += 1) {
      const card = el('div', 'cc-skeleton');
      card.setAttribute('aria-hidden', 'true');
      ['40%', '90%', '70%'].forEach((width) => {
        const line = el('div', 'cc-skeleton-line');
        line.style.width = width;
        card.appendChild(line);
      });
      wrap.appendChild(card);
    }
    els.discussion.appendChild(wrap);
    announce('Loading discussion.');
  }

  function renderMessage(title, body, actionLabel, onAction) {
    els.discussion.innerHTML = '';
    els.source.innerHTML = '';
    els.outline.innerHTML = '';
    els.composer.innerHTML = '';
    els.loadMoreWrap.hidden = true;
    els.toolbar.hidden = true;
    const wrap = el('div', 'cc-empty');
    wrap.appendChild(el('h2', null, title));
    wrap.appendChild(el('p', null, body));
    const back = el('a', 'cc-btn', 'Back to Cloud Chabura');
    back.href = '/chaburah/';
    wrap.appendChild(back);
    if (actionLabel && onAction) wrap.appendChild(button('cc-btn cc-btn-primary', actionLabel, onAction));
    els.discussion.appendChild(wrap);
    announce(title);
  }

  // Never names the id, and never says "this discussion exists but is private"
  // to someone who may not know it exists at all.
  function renderUnavailable(reason) {
    if (reason === 'sign-in-required') {
      renderMessage(
        'Sign in to see this discussion',
        'This discussion is not publicly readable. If you have access, signing in will open it.',
        'Sign in',
        () => document.getElementById('signInButton')?.click()
      );
      return;
    }
    renderMessage(
      'This discussion is not available',
      'It may have been removed, or it may not be shared with you.'
    );
  }

  function renderError() {
    els.discussion.innerHTML = '';
    const wrap = el('div', 'cc-error');
    wrap.setAttribute('role', 'alert');
    wrap.appendChild(el('h2', null, 'Could not load this discussion'));
    wrap.appendChild(el('p', null, state.error));
    wrap.appendChild(button('cc-btn', 'Try again', () => load()));
    els.discussion.appendChild(wrap);
  }

  function context() {
    const note = state.note;
    const mine = viewerId() && note.author_id === viewerId();
    return {
      state,
      note,
      profiles: state.profiles,
      reactions: state.reactions,
      viewerId: viewerId(),
      signedIn: signedIn(),
      isMobile: isMobile(),
      canReply: signedIn() && note.status !== 'locked' && !note.deleted_at,
      canHighlight: Boolean(mine || state.viewer.isAdmin),
      canModerateThread: Boolean(mine || state.viewer.isAdmin),
      handlers,
    };
  }

  function render() {
    renderHeader();
    renderSource();
    renderDiscussion();
    renderOutlinePanel();
    renderComposer();
    els.toolbar.hidden = false;
    els.loadMoreWrap.hidden = !state.hasMoreBranches;
  }

  function renderHeader() {
    const note = state.note;
    els.header.innerHTML = '';

    const { back } = readUrl();
    const backLink = el('a', 'ct-back', '← Back to Cloud Chabura');
    // Preserves the feed's filters when the feed handed them over.
    backLink.href = back ? `/chaburah/${back.startsWith('?') ? back : `?${back}`}` : '/chaburah/';
    els.header.appendChild(backLink);

    const chips = el('div', 'ct-header-chips');
    const category = V.categoryChip(note.category);
    if (category) chips.appendChild(category);
    if (note.daf_ref_key) chips.appendChild(el('span', 'cc-chip cc-chip-daf', note.daf_ref_key.replace(/-/g, ' ')));
    chips.appendChild(V.statusChip(note));
    els.header.appendChild(chips);

    const heading = el('h1', 'ct-title', V.displayTitle(note));
    els.header.appendChild(heading);

    const actions = el('div', 'ct-header-actions');
    actions.appendChild(button('cc-btn cc-btn-sm', state.viewer.isFollowed ? 'Following' : 'Follow',
      () => handlers.onToggleFollow(), { pressed: state.viewer.isFollowed }));
    actions.appendChild(button('cc-btn cc-btn-sm', state.viewer.isSaved ? 'Saved' : 'Save',
      () => handlers.onToggleSaved(), { pressed: state.viewer.isSaved }));
    actions.appendChild(button('cc-btn cc-btn-sm', 'Share', () => handlers.onCopyLink(null)));
    els.header.appendChild(actions);
  }

  function renderSource() {
    els.source.innerHTML = '';
    const note = state.note;
    const ref = (note.daf_ref_key || '').replace(/-/g, ' ');
    els.source.appendChild(V.sourceContext(note, {
      dafHref: `/browse/?ref=${encodeURIComponent(ref)}`,
      playHref: `/watch/?ref=${encodeURIComponent(ref)}&t=${Math.floor(note.video_timestamp_seconds || 0)}`,
      driftWarning: pageWordBoxes
        ? window.DafNotesFormat.anchorMayHaveShifted(note, pageWordBoxes)
        : false,
    }));
  }

  function renderDiscussion() {
    const ctx = context();
    els.discussion.innerHTML = '';
    els.discussion.appendChild(V.rootPost(state.note, ctx));

    const unread = S.unreadIds(state);
    if (unread.length) {
      const marker = el('p', 'ct-unread-marker', 'New since your last visit');
      marker.dataset.firstUnread = unread[0];
      els.discussion.appendChild(marker);
    }

    els.replies = V.replyTree(ctx);
    els.replies.id = 'ctReplies';
    els.discussion.appendChild(els.replies);
    applySearchHighlight();
  }

  function renderOutlinePanel() {
    els.outline.innerHTML = '';
    els.outline.appendChild(V.threadOutline(context()));
  }

  function renderComposer() {
    els.composer.innerHTML = '';
    if (activeComposer && activeComposer.parentId) return; // an inline composer owns the focus
    const note = state.note;
    let disabledReason = null;
    if (!signedIn()) disabledReason = 'Sign in to join this discussion.';
    else if (note.deleted_at) disabledReason = 'This discussion was deleted, so it can no longer be replied to.';
    else if (note.status === 'locked') disabledReason = 'This discussion is locked. It stays readable, but no new replies can be posted.';

    const composer = C.createComposer({
      noteId: note.id,
      parentId: null,
      participants: S.participants(state),
      viewerId: viewerId(),
      disabledReason,
      onSubmit: (payload) => submitReply(null, payload),
    });
    els.composer.appendChild(composer.node);
    if (!disabledReason) activeComposer = { parentId: null, instance: composer, host: els.composer };
  }

  function afterRender({ scrollToPermalink }) {
    if (scrollToPermalink && state.permalinkTarget) focusPermalink(state.permalinkTarget);
  }

  // Scrolls the target clear of the sticky header rather than under it, then
  // moves real keyboard focus there so a screen-reader user lands on it too.
  function focusPermalink(commentId) {
    S.expandAncestors(state, commentId);
    renderDiscussion();
    const node = document.getElementById(`comment-${commentId}`);
    if (!node) return;
    const offset = (document.querySelector('.ct-sticky-top')?.getBoundingClientRect().height || 0) + 16;
    const top = node.getBoundingClientRect().top + window.scrollY - offset;
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    node.setAttribute('tabindex', '-1');
    node.focus({ preventScroll: true });
    node.classList.add('is-permalinked');
    setTimeout(() => node.classList.remove('is-permalinked'), 2600);
  }

  // --- Search --------------------------------------------------------------

  function applySearchHighlight() {
    const needle = state.search.trim().toLowerCase();
    els.discussion.querySelectorAll('.ct-reply').forEach((node) => {
      node.classList.remove('is-search-hit', 'is-search-current');
      if (!needle) return;
      const row = state.commentsById.get(node.dataset.id);
      if (row && !S.isTombstone(row) && String(row.body || '').toLowerCase().includes(needle)) {
        node.classList.add('is-search-hit');
      }
    });
    const current = state.searchMatches[state.searchIndex];
    if (current) document.getElementById(`comment-${current}`)?.classList.add('is-search-current');
  }

  function runSearch(term) {
    S.runSearch(state, term);
    // A match inside a collapsed branch is unreachable until it is expanded.
    state.searchMatches.forEach((id) => S.expandAncestors(state, id));
    renderDiscussion();
    if (!term.trim()) { announce(''); return; }
    if (!state.searchMatches.length) {
      announce('No matches among the replies loaded so far.');
      return;
    }
    // Jump first, then announce -- jumpToSearch also announces, and doing it
    // the other way round replaced the count with "Match 1 of N" before a
    // screen reader ever reached it.
    jumpToSearch(0);
    const count = state.searchMatches.length;
    announce(`${count} matching ${count === 1 ? 'reply' : 'replies'} among the replies loaded so far. Showing match 1 of ${count}.`);
  }

  function jumpToSearch(index) {
    if (!state.searchMatches.length) return;
    const count = state.searchMatches.length;
    state.searchIndex = ((index % count) + count) % count;
    const id = state.searchMatches[state.searchIndex];
    applySearchHighlight();
    scrollTo(id);
    announce(`Match ${state.searchIndex + 1} of ${count}.`);
  }

  function scrollTo(commentId) {
    S.expandAncestors(state, commentId);
    const node = document.getElementById(`comment-${commentId}`);
    if (!node) { renderDiscussion(); }
    const target = document.getElementById(`comment-${commentId}`);
    if (!target) return;
    const offset = (document.querySelector('.ct-sticky-top')?.getBoundingClientRect().height || 0) + 16;
    window.scrollTo({ top: Math.max(0, target.getBoundingClientRect().top + window.scrollY - offset), behavior: 'smooth' });
    target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
  }

  // --- Unread --------------------------------------------------------------

  function jumpToUnread(direction = 1) {
    const unread = S.unreadIds(state);
    if (!unread.length) { announce('Nothing new since your last visit.'); return; }
    const current = document.activeElement?.closest?.('.ct-reply')?.dataset.id;
    let index = unread.indexOf(current);
    index = index < 0 ? 0 : (index + direction + unread.length) % unread.length;
    scrollTo(unread[index]);
  }

  // Only marks read what the viewer has actually had rendered to them, and the
  // monotonic trigger makes a stale tab harmless.
  let markReadTimer = null;
  function scheduleMarkRead() {
    clearTimeout(markReadTimer);
    markReadTimer = setTimeout(async () => {
      if (!signedIn() || !state.note) return;
      const highest = S.highestSequence(state);
      if (!highest || highest <= state.viewer.lastReadSequence) return;
      try {
        await data.markRead(state.note.id, highest);
        state.viewer.lastReadSequence = highest;
      } catch (error) {
        console.error('Could not save your reading position.', error);
      }
    }, 2500);
  }

  // --- Menus and dialogs ---------------------------------------------------

  function closeMenu() {
    if (!openMenu) return;
    openMenu.trigger?.setAttribute('aria-expanded', 'false');
    openMenu.node.remove();
    openMenu = null;
  }

  function showMenu(trigger, node) {
    closeMenu();
    document.body.appendChild(node);
    const box = trigger.getBoundingClientRect();
    node.style.top = `${box.bottom + window.scrollY + 4}px`;
    node.style.left = `${Math.max(8, Math.min(box.left + window.scrollX, window.innerWidth - 220))}px`;
    trigger.setAttribute('aria-expanded', 'true');
    openMenu = { trigger, node };
    node.querySelector('button')?.focus();
  }

  function confirmDialog({ title, body, confirmLabel, danger }) {
    return new Promise((resolve) => {
      const dialog = document.createElement('dialog');
      dialog.className = 'ct-confirm';
      dialog.appendChild(el('h2', null, title));
      dialog.appendChild(el('p', null, body));
      const row = el('div', 'ct-confirm-actions');
      row.appendChild(button('cc-btn', 'Cancel', () => { dialog.close(); resolve(false); }));
      row.appendChild(button(`cc-btn ${danger ? 'ct-btn-danger' : 'cc-btn-primary'}`, confirmLabel,
        () => { dialog.close(); resolve(true); }));
      dialog.appendChild(row);
      dialog.addEventListener('close', () => { dialog.remove(); resolve(false); }, { once: true });
      document.body.appendChild(dialog);
      dialog.showModal();
    });
  }

  // --- Mutations -----------------------------------------------------------

  async function submitReply(parentId, payload) {
    const row = await data.postReply({
      noteId: state.note.id,
      parentCommentId: parentId,
      body: payload.body,
      mentionedUserIds: payload.mentionedUserIds,
      quotedCommentId: payload.quotedCommentId,
      quotedExcerpt: payload.quotedExcerpt,
    });
    if (row) {
      S.mergeComments(state, [row]);
      state.loadedBranchRoots.add(row.root_comment_id);
      if (parentId) { activeComposer = null; }
      render();
      afterRender({});
      scrollTo(row.id);
      announce('Reply posted.');
    }
  }

  const handlers = {
    onReply(parentId) {
      if (!signedIn()) { document.getElementById('signInButton')?.click(); return; }
      openInlineComposer(parentId, null);
    },

    onQuote(commentId) {
      if (!signedIn()) { document.getElementById('signInButton')?.click(); return; }
      const source = commentId ? state.commentsById.get(commentId) : state.note;
      if (!source) return;
      const excerpt = String(source.body || '').replace(/\s+/g, ' ').trim().slice(0, 500);
      openInlineComposer(commentId, {
        commentId: commentId || null,
        author: source.author_display_name || 'Anonymous',
        excerpt,
      });
    },

    async onToggleReaction(targetType, targetId, reactionType, add) {
      if (!signedIn()) { document.getElementById('signInButton')?.click(); return; }
      const entry = state.reactions.get(targetId) || { counts: new Map(), mine: new Set() };
      const before = { counts: new Map(entry.counts), mine: new Set(entry.mine) };
      if (add) {
        entry.counts.set(reactionType, (entry.counts.get(reactionType) || 0) + 1);
        entry.mine.add(reactionType);
      } else {
        entry.counts.set(reactionType, Math.max(0, (entry.counts.get(reactionType) || 1) - 1));
        if (!entry.counts.get(reactionType)) entry.counts.delete(reactionType);
        entry.mine.delete(reactionType);
      }
      state.reactions.set(targetId, entry);
      render();
      try {
        await data.toggleReaction({ targetType, targetId, reactionType, add });
      } catch (error) {
        state.reactions.set(targetId, before);
        render();
        toast(data.describeError(error));
      }
    },

    openReactionMenu(trigger, targetType, targetId, entry) {
      showMenu(trigger, V.reactionMenu(entry, (reactionType, add) => {
        closeMenu();
        handlers.onToggleReaction(targetType, targetId, reactionType, add);
      }));
    },

    openActionMenu(trigger, items) {
      showMenu(trigger, V.actionMenu(items.map((item) => ({
        ...item,
        onSelect: () => { closeMenu(); item.onSelect(); },
      }))));
    },

    onToggleBranch(rootId) {
      if (state.collapsed.has(rootId)) state.collapsed.delete(rootId);
      else state.collapsed.add(rootId);
      renderDiscussion();
    },

    onExpandBranch(rootId) {
      state.collapsed.delete(rootId);
      renderDiscussion();
    },

    onJumpTo(commentId) { scrollTo(commentId); },

    async onCopyLink(commentId) {
      const url = threadUrl(commentId);
      try {
        await navigator.clipboard.writeText(url);
        toast('Link copied.');
      } catch {
        // Clipboard access is denied in plenty of contexts; show the link so
        // it can still be copied by hand rather than failing silently.
        window.prompt('Copy this link:', url);
      }
    },

    async onToggleFollow() {
      if (!signedIn()) { document.getElementById('signInButton')?.click(); return; }
      const next = !state.viewer.isFollowed;
      state.viewer.isFollowed = next;
      renderHeader();
      try { await data.setFollowed(state.note.id, next); }
      catch (error) {
        state.viewer.isFollowed = !next;
        renderHeader();
        toast(data.describeError(error));
      }
    },

    async onToggleSaved() {
      if (!signedIn()) { document.getElementById('signInButton')?.click(); return; }
      const next = !state.viewer.isSaved;
      state.viewer.isSaved = next;
      renderHeader();
      try { await data.setSaved(state.note.id, next); }
      catch (error) {
        state.viewer.isSaved = !next;
        renderHeader();
        toast(data.describeError(error));
      }
    },

    async onEdit(commentId) {
      const row = commentId ? state.commentsById.get(commentId) : state.note;
      if (!row) return;
      const next = window.prompt('Edit your post:', row.body || '');
      if (next === null || next.trim() === (row.body || '').trim()) return;
      if (next.length > C.BODY_LIMIT) {
        toast(`That is ${next.length - C.BODY_LIMIT} characters over the ${C.BODY_LIMIT} limit. Nothing was changed.`);
        return;
      }
      try {
        const updated = commentId
          ? await data.editComment(commentId, next.trim())
          : await data.editNote(state.note.id, { body: next.trim() });
        if (commentId) S.mergeComments(state, [updated]);
        else state.note = updated;
        render();
        announce('Edit saved.');
      } catch (error) { toast(data.describeError(error)); }
    },

    async onDelete(commentId) {
      const row = commentId ? state.commentsById.get(commentId) : state.note;
      if (!row) return;
      const replies = commentId ? S.descendantIds(state, commentId).length : state.commentsById.size;
      const ok = await confirmDialog({
        title: commentId ? 'Delete this reply?' : 'Delete this discussion?',
        // States exactly what survives, which is the plan's requirement.
        body: replies
          ? `The text will be replaced with “deleted” and cannot be recovered. The ${replies} ${replies === 1 ? 'reply' : 'replies'} beneath it stay visible and stay connected.`
          : 'The text will be replaced with “deleted” and cannot be recovered.',
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      try {
        if (commentId) S.mergeComments(state, [await data.softDeleteComment(commentId)]);
        else state.note = await data.softDeleteNote(state.note.id);
        render();
        announce('Deleted.');
      } catch (error) { toast(data.describeError(error)); }
    },

    async onHighlight(commentId) {
      try {
        state.note = await data.setHighlightedComment(state.note.id, commentId);
        render();
        announce(commentId ? 'Marked as the answer.' : 'Answer unmarked.');
      } catch (error) { toast(data.describeError(error)); }
    },

    async onStatus(status) {
      try {
        state.note = await data.setStatus(state.note.id, status);
        render();
        announce(`Discussion marked ${status}.`);
      } catch (error) { toast(data.describeError(error)); }
    },

    async onReport(targetType, targetId) {
      const reason = window.prompt('What is wrong with this post? A moderator will review it.');
      if (!reason || !reason.trim()) return;
      try {
        await data.reportTarget(targetType, targetId, reason.trim());
        toast('Reported. Thank you.');
      } catch (error) { toast(data.describeError(error)); }
    },
  };

  // Only one inline composer at a time on mobile, and switching away from a
  // nonempty one asks first rather than dropping what was typed.
  function openInlineComposer(parentId, quote) {
    if (activeComposer && activeComposer.parentId !== parentId) {
      if (activeComposer.instance.isDirty() && !window.confirm('You have an unsent reply. Discard it and reply here instead?')) return;
      if (activeComposer.parentId !== null) activeComposer.host.remove();
      activeComposer = null;
    }
    if (parentId === null) {
      renderComposer();
      if (quote) activeComposer?.instance.setQuote(quote);
      activeComposer?.instance.focus();
      return;
    }

    const anchor = document.getElementById(`comment-${parentId}`);
    if (!anchor) return;
    const parent = state.commentsById.get(parentId);
    const host = el('div', 'ct-inline-composer');
    const composer = C.createComposer({
      noteId: state.note.id,
      parentId,
      parentName: parent?.author_display_name || 'this reply',
      participants: S.participants(state),
      viewerId: viewerId(),
      quote,
      onSubmit: (payload) => submitReply(parentId, payload),
      onCancel: () => { host.remove(); activeComposer = null; renderComposer(); },
    });
    host.appendChild(composer.node);
    anchor.after(host);
    activeComposer = { parentId, instance: composer, host };
    composer.focus();
  }

  // --- Keyboard ------------------------------------------------------------

  function inEditableField(target) {
    return Boolean(target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable));
  }

  function onKeydown(event) {
    if (event.key === 'Escape') {
      if (openMenu) { closeMenu(); return; }
      const sheet = document.querySelector('.ct-drawer.is-open');
      if (sheet) { sheet.classList.remove('is-open'); return; }
    }
    // Never shadow a browser or system shortcut, and never fire inside a field.
    if (inEditableField(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;

    switch (event.key) {
      case '/':
        event.preventDefault();
        els.search?.focus();
        break;
      case 'r':
        event.preventDefault();
        handlers.onReply(null);
        break;
      case 'u':
        event.preventDefault();
        jumpToUnread(1);
        break;
      case 'j':
        event.preventDefault();
        moveBranch(1);
        break;
      case 'k':
        event.preventDefault();
        moveBranch(-1);
        break;
      case '?':
        event.preventDefault();
        els.helpDialog?.showModal();
        break;
      default:
        break;
    }
  }

  function moveBranch(direction) {
    const roots = S.orderedTopLevel(state);
    if (!roots.length) return;
    const current = document.activeElement?.closest?.('.ct-branch')?.dataset.root;
    let index = roots.indexOf(current);
    index = index < 0 ? (direction > 0 ? 0 : roots.length - 1) : (index + direction + roots.length) % roots.length;
    scrollTo(roots[index]);
  }

  // --- Wiring --------------------------------------------------------------

  function wire() {
    let searchTimer = null;
    els.search?.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => runSearch(els.search.value), 250);
    });
    els.search?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        jumpToSearch(state.searchIndex + (event.shiftKey ? -1 : 1));
      }
      if (event.key === 'Escape') { els.search.value = ''; runSearch(''); els.search.blur(); }
    });

    document.getElementById('ctSearchNext')?.addEventListener('click', () => jumpToSearch(state.searchIndex + 1));
    document.getElementById('ctSearchPrev')?.addEventListener('click', () => jumpToSearch(state.searchIndex - 1));
    document.getElementById('ctJumpUnread')?.addEventListener('click', () => jumpToUnread(1));

    document.getElementById('ctCollapseRead')?.addEventListener('click', () => {
      S.orderedTopLevel(state).forEach((rootId) => {
        if (S.branchStats(state, rootId).unread === 0) state.collapsed.add(rootId);
      });
      renderDiscussion();
      announce('Read branches collapsed.');
    });
    document.getElementById('ctExpandAll')?.addEventListener('click', () => {
      state.collapsed.clear();
      renderDiscussion();
      announce('All loaded branches expanded.');
    });

    els.sort?.addEventListener('change', () => {
      state.sort = els.sort.value;
      renderDiscussion();
      renderOutlinePanel();
      announce(`Branches sorted by ${els.sort.options[els.sort.selectedIndex].text}.`);
    });

    els.loadMore?.addEventListener('click', () => loadMoreBranches());
    els.help?.addEventListener('click', () => els.helpDialog?.showModal());
    document.getElementById('ctHelpClose')?.addEventListener('click', () => els.helpDialog?.close());

    els.sourceToggle?.addEventListener('click', () => {
      els.source.classList.toggle('is-open');
      els.sourceToggle.setAttribute('aria-expanded', String(els.source.classList.contains('is-open')));
    });
    els.outlineToggle?.addEventListener('click', () => {
      els.outline.classList.toggle('is-open');
      els.outlineToggle.setAttribute('aria-expanded', String(els.outline.classList.contains('is-open')));
    });

    document.addEventListener('keydown', onKeydown);
    document.addEventListener('click', (event) => {
      if (openMenu && !openMenu.node.contains(event.target) && event.target !== openMenu.trigger) closeMenu();
    });

    window.addEventListener('popstate', () => load());
    window.DafSyncAuth?.onChange(() => load());
  }

  function init() {
    cacheEls();
    if (!els.discussion) return; // not the thread page
    wire();
    load();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
