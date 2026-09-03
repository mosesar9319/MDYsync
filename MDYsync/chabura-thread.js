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
      observeForReading();
      startPolling();
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
    const [profiles, reactions, savedComments] = await Promise.all([
      data.fetchProfiles(authorIds),
      data.fetchReactions(state.note.id, commentIds),
      data.fetchSavedCommentIds(commentIds),
    ]);
    if (!data.isCurrent(token)) return;
    state.profiles = profiles;
    state.reactions = reactions;
    state.savedComments = savedComments;
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
      savedComments: state.savedComments,
      currentBranchId: state.currentBranchId,
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
    // Re-observe: the previous nodes were just discarded by the re-render.
    observeForReading();
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
    attachLinkPreviews();
  }

  // Previews load after the thread is readable and are appended in place, so a
  // slow or failed preview never delays or breaks the discussion itself.
  const previewed = new Set();
  function attachLinkPreviews() {
    const posts = [...els.discussion.querySelectorAll('.ct-reply, .ct-root')];
    posts.forEach(async (node) => {
      const id = node.dataset.id || 'root';
      if (previewed.has(id)) return;
      const row = node.dataset.id ? state.commentsById.get(node.dataset.id) : state.note;
      if (!row || S.isTombstone(row)) return;
      const url = V.firstLinkIn(row.body);
      if (!url) return;
      previewed.add(id);
      const preview = await data.fetchLinkPreview(url);
      if (!preview) return;
      // The node may have been replaced by a re-render while the fetch was in
      // flight; look it up again rather than appending to a detached element.
      const live = node.dataset.id
        ? document.getElementById(`comment-${node.dataset.id}`)
        : document.getElementById('root-post');
      if (!live || live.querySelector('.ct-preview')) return;
      live.querySelector('.ct-body')?.after(V.linkPreviewCard(preview));
    });
  }

  // Scrolls the target clear of the sticky header rather than under it, then
  // moves real keyboard focus there so a screen-reader user lands on it too.
  function focusPermalink(commentId) {
    suppressReadTracking();
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

  // Asks the SERVER, so a match in a branch this client never loaded is still
  // found; the matching branches are then fetched so each hit is shown in
  // context rather than floating alone.
  let searchToken = 0;
  async function runSearch(term) {
    const token = (searchToken += 1);
    if (!term.trim()) {
      S.runSearch(state, '');
      renderDiscussion();
      announce('');
      return;
    }
    announce('Searching…');
    let matches = [];
    try {
      matches = await data.searchThread(state.note.id, term);
    } catch (error) {
      if (token !== searchToken) return;
      toast(data.describeError(error));
      return;
    }
    if (token !== searchToken) return;

    if (matches.length) {
      const missingRoots = matches
        .map((row) => row.root_comment_id)
        .filter((rootId) => !state.commentsById.has(rootId));
      if (missingRoots.length) {
        try {
          const branches = await data.fetchBranchesFor(state.note.id, missingRoots);
          if (token !== searchToken) return;
          S.mergeComments(state, branches);
          branches.forEach((row) => state.loadedBranchRoots.add(row.root_comment_id));
        } catch (error) { console.error('Could not load a matching branch.', error); }
      }
      S.mergeComments(state, matches);
    }

    // The local pass now runs over a state that contains every server match,
    // so ordering and highlighting stay consistent with what is rendered.
    S.runSearch(state, term);
    state.searchMatches.forEach((id) => S.expandAncestors(state, id));
    renderDiscussion();
    renderOutlinePanel();

    if (!state.searchMatches.length) {
      announce(`No replies in this discussion match “${term.trim()}”.`);
      return;
    }
    // Jump first, then announce -- jumpToSearch also announces, and doing it
    // the other way round replaced the count with "Match 1 of N" before a
    // screen reader ever reached it.
    jumpToSearch(0);
    const count = state.searchMatches.length;
    announce(`${count} matching ${count === 1 ? 'reply' : 'replies'} in this discussion. Showing match 1 of ${count}.`);
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
    // Navigation, not reading: whatever the viewport sweeps past on the way
    // must not count.
    suppressReadTracking();
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

  // --- Read state ----------------------------------------------------------
  //
  // "Do not mark a thread read on load." The previous version marked the
  // highest LOADED sequence 2.5 seconds after load, which meant opening a
  // months-old permalink silently marked every newer reply read -- the reader
  // lost their unread markers by following a link, without ever seeing the
  // replies. Read state now advances only for replies that were actually on
  // screen long enough to have been read.

  const READ_DWELL_MS = 1200;     // how long a reply must be visible to count
  const READ_FLUSH_MS = 2000;     // batching window, so scrolling is not chatty
  const seenSequences = new Set();
  const dwellTimers = new Map();
  let readObserver = null;
  let flushTimer = null;
  // Programmatic scrolling (a permalink, a search jump, jump-to-unread) sweeps
  // the viewport past replies the reader never looked at. Observation is muted
  // while that happens, so navigation cannot mark anything read.
  let suppressUntil = 0;

  function suppressReadTracking(ms = 900) {
    suppressUntil = Date.now() + ms;
  }

  function observeForReading() {
    if (!signedIn() || !state.note) return;
    if (readObserver) readObserver.disconnect();
    dwellTimers.forEach((timer) => clearTimeout(timer));
    dwellTimers.clear();

    if (typeof IntersectionObserver !== 'function') return; // nothing marked rather than everything

    readObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        const id = entry.target.dataset.id;
        if (!id) return;
        if (!entry.isIntersecting) {
          clearTimeout(dwellTimers.get(id));
          dwellTimers.delete(id);
          return;
        }
        if (dwellTimers.has(id)) return;
        dwellTimers.set(id, setTimeout(() => {
          dwellTimers.delete(id);
          if (Date.now() < suppressUntil) return;
          const row = state.commentsById.get(id);
          if (!row || row.pending) return;
          seenSequences.add(row.activity_sequence);
          scheduleFlush();
        }, READ_DWELL_MS));
      });
    }, { threshold: 0.6 });

    els.discussion.querySelectorAll('.ct-reply').forEach((node) => readObserver.observe(node));
  }

  // The branch nearest the top of the viewport, so the outline can say where
  // the reader currently is in a long thread.
  function trackLocation() {
    const branches = [...els.discussion.querySelectorAll('.ct-branch')];
    let current = null;
    let best = Infinity;
    branches.forEach((node) => {
      const top = node.getBoundingClientRect().top;
      const distance = Math.abs(top - 120);
      if (top < window.innerHeight && distance < best) { best = distance; current = node.dataset.root; }
    });
    if (current && current !== state.currentBranchId) {
      state.currentBranchId = current;
      renderOutlinePanel();
    }
  }

  function scheduleFlush() {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flushReadState, READ_FLUSH_MS);
  }

  // Only advances to the highest CONTIGUOUS sequence actually seen. Jumping to
  // reply 90 and reading it must not mark 3..89 read as a side effect, so the
  // marker stops at the first gap.
  async function flushReadState() {
    if (!signedIn() || !state.note || !seenSequences.size) return;
    let candidate = state.viewer.lastReadSequence;
    while (seenSequences.has(candidate + 1)) candidate += 1;
    if (candidate <= state.viewer.lastReadSequence) return;
    try {
      await data.markRead(state.note.id, candidate);
      state.viewer.lastReadSequence = candidate;
      renderOutlinePanel();
    } catch (error) {
      console.error('Could not save your reading position.', error);
    }
  }

  // A reader leaving the page mid-scroll should not lose the position they did
  // reach, so the pending batch is flushed on the way out.
  function flushOnExit() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') { clearTimeout(flushTimer); flushReadState(); }
    });
    window.addEventListener('pagehide', () => { clearTimeout(flushTimer); flushReadState(); });
  }

  // --- New replies while reading -------------------------------------------
  //
  // Replies that arrive while the page is open are NEVER inserted underneath
  // the reader: doing so moves the text they are mid-sentence in. They are held
  // and announced by a control, and inserted only when the reader asks.

  const NEW_REPLY_POLL_MS = 30000;
  let pollTimer = null;

  function startPolling() {
    clearInterval(pollTimer);
    if (!state.note) return;
    pollTimer = setInterval(checkForNewReplies, NEW_REPLY_POLL_MS);
  }

  async function checkForNewReplies() {
    if (!state.note || document.visibilityState === 'hidden') return;
    const highest = S.highestSequence(state);
    try {
      const rows = await data.fetchRepliesSince(state.note.id, highest);
      const fresh = rows.filter((row) => !state.commentsById.has(row.id));
      if (!fresh.length) return;
      state.newReplies = state.newReplies.concat(fresh);
      renderNewRepliesControl();
    } catch { /* a failed poll is not worth interrupting a reader for */ }
  }

  function renderNewRepliesControl() {
    let bar = document.getElementById('ctNewReplies');
    if (!state.newReplies.length) { bar?.remove(); return; }
    if (!bar) {
      bar = el('div', 'ct-new-replies');
      bar.id = 'ctNewReplies';
      bar.setAttribute('role', 'status');
      document.body.appendChild(bar);
    }
    bar.innerHTML = '';
    const count = state.newReplies.length;
    bar.appendChild(button('cc-btn cc-btn-primary cc-btn-sm',
      `${count} new ${count === 1 ? 'reply' : 'replies'} — show`,
      () => showNewReplies()));
    bar.appendChild(button('cc-btn cc-btn-quiet cc-btn-sm', 'Dismiss', () => {
      // Dismiss hides the control; the replies still arrive on the next load.
      state.newReplies = [];
      renderNewRepliesControl();
    }, { ariaLabel: 'Dismiss new replies notice' }));
  }

  function showNewReplies() {
    const rows = state.newReplies;
    state.newReplies = [];
    if (!rows.length) return;
    // Anchor on the scroll position so inserting above the viewport does not
    // shift what the reader is looking at.
    const anchor = document.querySelector('.ct-reply');
    const before = anchor ? anchor.getBoundingClientRect().top : 0;
    S.mergeComments(state, rows);
    rows.forEach((row) => state.loadedBranchRoots.add(row.root_comment_id));
    renderDiscussion();
    renderOutlinePanel();
    renderNewRepliesControl();
    const after = anchor && document.body.contains(anchor) ? anchor.getBoundingClientRect().top : before;
    if (after !== before) window.scrollBy(0, after - before);
    announce(`${rows.length} new ${rows.length === 1 ? 'reply' : 'replies'} added.`);
  }

  // --- Menus and dialogs ---------------------------------------------------

  function closeMenu() {
    if (!openMenu) return;
    const { trigger, node } = openMenu;
    openMenu = null;
    trigger?.setAttribute('aria-expanded', 'false');
    // Return focus only if it is still inside the menu being removed; stealing
    // it back after the reader has clicked elsewhere would be worse than losing it.
    const restore = node.contains(document.activeElement);
    node.remove();
    if (restore) trigger?.focus();
  }

  function showMenu(trigger, node) {
    closeMenu();
    document.body.appendChild(node);
    const box = trigger.getBoundingClientRect();
    node.style.top = `${box.bottom + window.scrollY + 4}px`;
    node.style.left = `${Math.max(8, Math.min(box.left + window.scrollX, window.innerWidth - 220))}px`;
    trigger.setAttribute('aria-expanded', 'true');
    openMenu = { trigger, node };

    // Arrow keys, Home/End and Escape, with focus returning to the trigger on
    // close -- otherwise closing a menu drops keyboard focus to the top of the
    // document and a keyboard-only reader loses their place in the thread.
    const items = [...node.querySelectorAll('button')];
    node.addEventListener('keydown', (event) => {
      const index = items.indexOf(document.activeElement);
      if (event.key === 'ArrowDown') { event.preventDefault(); items[(index + 1) % items.length]?.focus(); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); items[(index - 1 + items.length) % items.length]?.focus(); }
      else if (event.key === 'Home') { event.preventDefault(); items[0]?.focus(); }
      else if (event.key === 'End') { event.preventDefault(); items[items.length - 1]?.focus(); }
      else if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); closeMenu(); }
    });
    items[0]?.focus();
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

  // Renders the reply immediately in a sending state, then reconciles with what
  // the server actually stored. The id is generated up front and sent with the
  // insert, so the optimistic row and the confirmed row are the SAME row --
  // there is nothing to deduplicate afterwards, and a retry after a timeout
  // collides on the primary key instead of posting twice.
  async function submitReply(parentId, payload) {
    const user = window.DafSyncAuth?.getUser?.();
    if (!user) throw new Error('Sign in to reply.');

    const id = payload.id || data.newCommentId();
    const parent = parentId ? state.commentsById.get(parentId) : null;
    const optimistic = {
      id,
      note_id: state.note.id,
      author_id: user.id,
      author_display_name: user.display_name || user.email || 'You',
      body: payload.body,
      parent_comment_id: parentId || null,
      root_comment_id: parent ? parent.root_comment_id : id,
      depth: parent ? (parent.depth || 0) + 1 : 0,
      activity_sequence: S.highestSequence(state) + 1,
      quoted_comment_id: payload.quotedCommentId || null,
      quoted_excerpt: payload.quotedExcerpt || null,
      mentioned_user_ids: payload.mentionedUserIds || [],
      hidden: false,
      is_demo: false,
      created_at: new Date().toISOString(),
      edited_at: null,
      deleted_at: null,
      pending: true,
    };

    S.mergeComments(state, [optimistic]);
    state.loadedBranchRoots.add(optimistic.root_comment_id);

    // Only the discussion is redrawn, NOT the composer. A full render() here
    // replaced the composer element while its own submit was still in flight,
    // so a failure showed its message on a node already detached from the
    // document -- the reader saw an empty composer and no error at all.
    renderDiscussion();
    renderOutlinePanel();
    scrollTo(id);
    announce('Posting your reply…');

    try {
      const row = await data.postReply({
        id,
        noteId: state.note.id,
        parentCommentId: parentId,
        body: payload.body,
        mentionedUserIds: payload.mentionedUserIds,
        quotedCommentId: payload.quotedCommentId,
        quotedExcerpt: payload.quotedExcerpt,
      });
      // The server's row wins: it carries the derived depth, root and sequence,
      // and `pending` is cleared by the merge overwriting it.
      S.mergeComments(state, [{ ...(row || optimistic), pending: false }]);
      // Now that it is accepted, the composer can go: an inline one is removed,
      // the root one is rebuilt empty.
      if (parentId && activeComposer && activeComposer.parentId === parentId) {
        activeComposer.host.remove();
        activeComposer = null;
      }
      render();
      afterRender({});
      announce('Reply posted.');
    } catch (error) {
      // The optimistic row goes so the reader is never left believing a failed
      // reply was published, but the composer stays mounted -- it is what
      // holds the draft and shows the reason.
      S.removeComment(state, id);
      renderDiscussion();
      renderOutlinePanel();
      throw error;
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

    async onToggleSavedComment(commentId) {
      if (!signedIn()) { document.getElementById('signInButton')?.click(); return; }
      const next = !state.savedComments.has(commentId);
      if (next) state.savedComments.add(commentId); else state.savedComments.delete(commentId);
      renderDiscussion();
      try { await data.setCommentSaved(commentId, next); }
      catch (error) {
        if (next) state.savedComments.delete(commentId); else state.savedComments.add(commentId);
        renderDiscussion();
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

    onEdit(commentId) {
      const row = commentId ? state.commentsById.get(commentId) : state.note;
      if (!row) return;
      openEditor(commentId, row);
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
        if (commentId) {
          S.mergeComments(state, [await data.softDeleteComment(commentId)]);
          // clear_highlight_when_reply_unavailable drops the pointer server-side
          // the moment its reply is deleted or hidden. Mirroring that here stops
          // the thread advertising an answer nobody can read until a reload.
          if (state.note.highlighted_comment_id === commentId) {
            state.note = { ...state.note, highlighted_comment_id: null };
            announce('That reply was the marked answer, so the discussion is open again.');
          }
        } else {
          state.note = await data.softDeleteNote(state.note.id);
        }
        closeEditor();
        render();
        afterRender({});
        if (!commentId) announce('Deleted.');
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
      const reason = await reportDialog();
      if (!reason) return;
      try {
        await data.reportTarget(targetType, targetId, reason);
        toast('Reported. A moderator will review it. Thank you.');
      } catch (error) { toast(data.describeError(error)); }
    },
  };

  // Replaces the post's body with an editor in place, so the reader keeps the
  // surrounding thread as context while rewriting.
  let activeEditor = null;
  function openEditor(commentId, row) {
    closeEditor();
    const host = commentId ? document.getElementById(`comment-${commentId}`) : document.getElementById('root-post');
    if (!host) return;
    const body = host.querySelector('.ct-body');
    const actions = host.querySelector('.ct-actions');
    const editor = C.createEditor({
      body: row.body || '',
      onSave: async (next) => {
        const updated = commentId
          ? await data.editComment(commentId, next)
          : await data.editNote(state.note.id, { body: next });
        if (commentId) S.mergeComments(state, [updated]);
        else state.note = updated;
        activeEditor = null;
        render();
        afterRender({});
        announce('Edit saved.');
      },
      onCancel: () => { closeEditor(); render(); afterRender({}); },
    });
    if (body) body.hidden = true;
    if (actions) actions.hidden = true;
    host.appendChild(editor.node);
    activeEditor = { commentId, node: editor.node, host };
    editor.focus();
  }

  function closeEditor() {
    if (!activeEditor) return;
    activeEditor.node.remove();
    activeEditor = null;
  }

  // A real dialog rather than window.prompt: it can explain what reporting does
  // before the reader commits, and it is reachable by keyboard like every other
  // control here.
  function reportDialog() {
    return new Promise((resolve) => {
      const dialog = document.createElement('dialog');
      dialog.className = 'ct-confirm';
      dialog.appendChild(el('h2', null, 'Report this post'));
      dialog.appendChild(el('p', null, 'Tell a moderator what is wrong with it. Your name is recorded with the report so it can be followed up, and the author is not told who reported them.'));

      // Categories, because "what is wrong with it" alone gives a moderator no
      // way to triage a queue. The chosen category is prefixed onto the stored
      // reason rather than needing a schema change, and the free-text box stays
      // because a category is never the whole story.
      const CATEGORIES = [
        ['off-topic', 'Off topic for this passage'],
        ['incorrect', 'Factually wrong or misleading'],
        ['unsourced', 'States something as fact without a source'],
        ['disrespectful', 'Disrespectful or personal'],
        ['spam', 'Spam or advertising'],
        ['other', 'Something else'],
      ];
      const group = el('div', 'ct-report-categories');
      group.setAttribute('role', 'radiogroup');
      group.setAttribute('aria-label', 'Reason category');
      let chosen = null;
      CATEGORIES.forEach(([key, label]) => {
        const option = button('ct-report-category', label, () => {
          chosen = key;
          group.querySelectorAll('.ct-report-category').forEach((node) => {
            node.setAttribute('aria-checked', String(node === option));
            node.classList.toggle('is-chosen', node === option);
          });
        }, { ariaLabel: label });
        option.setAttribute('role', 'radio');
        option.setAttribute('aria-checked', 'false');
        option.dataset.category = key;
        group.appendChild(option);
      });
      dialog.appendChild(group);

      const label = el('label', 'cc-visually-hidden', 'Reason');
      label.setAttribute('for', 'ctReportReason');
      const input = document.createElement('textarea');
      input.id = 'ctReportReason';
      input.className = 'ct-composer-input';
      input.rows = 3;
      input.placeholder = 'What is wrong with this post?';
      dialog.append(label, input);
      const row = el('div', 'ct-confirm-actions');
      row.appendChild(button('cc-btn', 'Cancel', () => { dialog.close(); resolve(null); }));
      const send = button('cc-btn ct-btn-danger', 'Report', () => {
        const reason = input.value.trim();
        if (!chosen && !reason) { group.querySelector('.ct-report-category')?.focus(); return; }
        dialog.close();
        // The category leads so a moderator can sort the queue without reading
        // every body; the reader's own words follow.
        resolve(chosen ? `[${chosen}] ${reason}`.trim() : reason);
      });
      row.appendChild(send);
      dialog.appendChild(row);
      dialog.addEventListener('close', () => { dialog.remove(); resolve(null); }, { once: true });
      document.body.appendChild(dialog);
      dialog.showModal();
      input.focus();
    });
  }

  // Only one inline composer at a time on mobile, and switching away from a
  // nonempty one asks first rather than dropping what was typed.
  function openInlineComposer(parentId, quote) {
    if (activeComposer && activeComposer.parentId !== parentId) {
      // Only an INLINE composer is destroyed by switching, so only that case
      // costs anything. The root composer stays mounted with its text intact,
      // so asking about it would be a decision with no consequence.
      const losesText = activeComposer.parentId !== null && activeComposer.instance.isDirty();
      if (losesText && !window.confirm('You have an unsent reply here. Discard it and reply somewhere else instead?')) return;
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
    document.getElementById('ctUnreadNext')?.addEventListener('click', () => jumpToUnread(1));
    document.getElementById('ctUnreadPrev')?.addEventListener('click', () => jumpToUnread(-1));

    let locationTimer = null;
    window.addEventListener('scroll', () => {
      clearTimeout(locationTimer);
      locationTimer = setTimeout(trackLocation, 150);
    }, { passive: true });

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
    flushOnExit();
    window.DafSyncChabura.notifications?.mount({ onError: (message) => toast(message) });
    load();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
