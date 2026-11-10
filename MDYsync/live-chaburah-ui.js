'use strict';

// Cloud Chaburah Live -- the discussion panel: a YouTube-style list of the daf's
// conversations (each one a small chat anchored to the Gemara words that started it),
// the chat itself, and the composer for a new discussion.
//
// A docked panel that lives beside the learning page rather than in it: it is built here,
// on first use, so a page needs only the scripts and the stylesheet. It never touches the
// video: opening, reading and replying leave playback exactly as it was. Selecting a
// thread highlights its words on the printed daf through the page's own highlighter
// (highlightTextRange in app.js) and scrolls them into view.
//
// Who sees it: admins until live_settings.audience is 'everyone' (the database enforces
// the same gate; this only avoids offering what would be refused).
//
// All user text goes in with textContent -- never innerHTML.

(function () {
  const core = window.LiveChaburahCore;
  const data = window.DafSyncLive.data;
  const auth = () => window.DafSyncAuth;

  const EDIT_WINDOW_MS = 15 * 60 * 1000;
  const PLACE_POLL_MS = 2000;
  const PLACE_QUIET_MS = 20000; // leave the list alone this long after the reader touched it
  const PLACE_BUCKET = 3; // re-rank only when the passage moves by this many segments
  const FOLLOW_KEY = 'dafsync.live.followPlace';
  const MARKERS_KEY = 'dafsync.live.markers';
  const SEARCH_DELAY_MS = 300;
  const UNREAD_POLL_MS = 60000;
  const FILTERS = [['all', 'All'], ['following', 'Following'], ['mine', 'Mine'], ['here', 'Here']];
  const SORTS = [
    ['near', 'Near my place'],
    ['latest', 'Latest activity'],
    ['unanswered', 'Unanswered'],
    ['active', 'Most active'],
    ['all', 'All discussions'],
  ];

  // A per-reader setting kept in the browser; the page works the same if storage is blocked.
  function storedFlag(key, fallback) {
    try {
      const value = window.localStorage.getItem(key);
      return value === null ? fallback : value === '1';
    } catch {
      return fallback;
    }
  }
  function storeFlag(key, value) {
    try { window.localStorage.setItem(key, value ? '1' : '0'); } catch { /* not remembered */ }
  }

  const L = {
    filter: 'all',
    query: '',
    matchIds: null, // thread ids a search found (null: no search)
    mine: new Set(), // threads the reader has posted in
    markerIds: null, // the threads behind a marker the reader clicked
    followPlace: storedFlag(FOLLOW_KEY, true),
    markersOn: storedFlag(MARKERS_KEY, true),
    unread: null, // { counts: Map(thread id -> n), dafs: Map(thread id -> daf key) }
    unreadTimer: null,
    searchTimer: null,
    searchToken: 0,
    available: false,
    built: false,
    open: false,
    view: 'list', // 'list' | 'chat' | 'compose'
    dafKey: null,
    dafLabel: '',
    threads: [],
    follows: new Set(),
    reads: new Map(),
    sort: 'near',
    place: null,
    placeBucket: null,
    touchedAt: 0,
    dafChannel: null,
    dafLive: false,
    dafPresence: 0,
    dafPoll: null,
    thread: null,
    messages: [],
    hasMore: false,
    threadChannel: null,
    threadLive: false,
    threadPresence: 0,
    threadPoll: null,
    quoteId: null,
    editingId: null,
    compose: null, // { runs, quotedText, dafKey, segmentRef }
    pendingDeepLink: core.threadIdFromSearch(location.search),
    loadToken: 0,
  };
  const els = {};

  // ---- small DOM helpers ---------------------------------------------------------------
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
  function button(className, text, onClick, label) {
    const node = el('button', className, text);
    node.type = 'button';
    if (label) node.setAttribute('aria-label', label);
    node.addEventListener('click', onClick);
    return node;
  }
  const toast = (message, type) => (typeof showToast === 'function' ? showToast(message, type) : undefined);
  const myId = () => auth()?.getUser?.()?.id || null;
  const isAdmin = () => Boolean(auth()?.isAdmin?.());
  const signedIn = () => Boolean(myId());

  function promptSignIn() {
    toast('Sign in to join the discussion.');
    document.getElementById('signInButton')?.click();
  }

  // ---- what daf, and where on it ----------------------------------------------------
  function currentDafRef() {
    const loaded = typeof state !== 'undefined' && (state.browsePageRef || state.dafRef);
    if (loaded) return loaded;
    // The player and watch pages know their daf from the link before the shiur has loaded.
    try { return new URLSearchParams(location.search).get('ref') || ''; } catch { return ''; }
  }

  // The reader's place on the daf. Where the shiur is, while it plays; otherwise the part of
  // the printed page in the middle of the screen; otherwise the last words selected; otherwise
  // wherever the (paused) shiur is. Null when none of these says anything about this daf.
  function placeFromPlayback() {
    const active = state.segments?.[state.activeIndex];
    if (active && state.dafRef && core.dafKeyFromRef(active.ref) === L.dafKey) {
      return { segment: core.segmentNumber(active.ref), word: 0 };
    }
    return null;
  }
  function placeFromScreen() {
    const wrap = document.getElementById('vilnaPageWrap');
    const boxes = state.vilnaPageMap?.wordBoxes;
    if (!wrap || !boxes?.length) return null;
    const rect = wrap.getBoundingClientRect();
    if (!rect.height) return null;
    const scroller = document.getElementById('dafScroll')?.getBoundingClientRect();
    const top = Math.max(rect.top, scroller ? scroller.top : 0, 0);
    const bottom = Math.min(rect.bottom, scroller ? scroller.bottom : Infinity, window.innerHeight);
    if (bottom <= top) return null;
    const place = core.placeFromViewport(boxes, ((top + bottom) / 2 - rect.top) / rect.height);
    return place && core.dafKeyFromRef(boxes[0].ref) === L.dafKey ? place : null;
  }
  function computePlace() {
    if (typeof state === 'undefined') return null;
    let playing = false;
    try { playing = typeof isPaused === 'function' && !isPaused(); } catch { /* unknown: treat as paused */ }
    if (playing) {
      const place = placeFromPlayback();
      if (place) return place;
    }
    const screen = placeFromScreen();
    if (screen) return screen;
    const run = state.textSelection?.runs?.[0];
    if (run && core.dafKeyFromRef(run.ref) === L.dafKey) {
      return { segment: core.segmentNumber(run.ref), word: Number(run.start) || 0 };
    }
    return placeFromPlayback();
  }

  // ---- building the panel ---------------------------------------------------------------
  function build() {
    if (L.built) return;
    L.built = true;

    els.toggle = el('button', 'live-toggle');
    els.toggle.type = 'button';
    els.toggle.hidden = !L.available;
    els.toggle.setAttribute('aria-controls', 'livePanel');
    els.toggle.setAttribute('aria-expanded', 'false');
    els.toggleLabel = el('span', 'live-toggle-label', 'Live discussions');
    els.toggleCount = el('span', 'live-toggle-count');
    els.toggleNew = el('span', 'live-toggle-new');
    els.toggleNew.hidden = true;
    els.toggle.append(el('span', 'live-toggle-dot'), els.toggleLabel, els.toggleCount, els.toggleNew);
    els.toggle.addEventListener('click', () => (L.open ? closePanel() : openPanel()));

    els.panel = el('aside', 'live-panel');
    els.panel.id = 'livePanel';
    els.panel.hidden = true;
    els.panel.setAttribute('aria-label', 'Cloud Chaburah Live');

    // Header
    const head = el('header', 'live-head');
    const headText = el('div', 'live-head-text');
    headText.append(el('div', 'live-eyebrow', 'Cloud Chaburah Live'));
    els.title = el('h2', 'live-title');
    els.presence = el('div', 'live-presence');
    els.presence.setAttribute('aria-live', 'polite');
    headText.append(els.title, els.presence);
    els.close = button('live-icon-button', '×', closePanel, 'Close discussions');
    head.append(headText, els.close);

    // List view
    els.listView = el('section', 'live-view live-list-view');
    const controls = el('div', 'live-controls');
    els.sort = el('select', 'live-sort');
    els.sort.setAttribute('aria-label', 'Order discussions');
    for (const [value, label] of SORTS) {
      const option = el('option', null, label);
      option.value = value;
      els.sort.append(option);
    }
    els.sort.addEventListener('change', () => { L.sort = els.sort.value; L.touchedAt = Date.now(); renderList(); });
    els.startHint = button('live-start-button', 'Start a discussion', () => beginFromCurrentSelection());
    controls.append(els.sort, els.startHint);

    // Search, filters and the options that decide how the list follows the reader.
    const searchRow = el('div', 'live-search-row');
    els.search = el('input', 'live-search');
    els.search.type = 'search';
    els.search.placeholder = 'Search this daf’s discussions';
    els.search.setAttribute('aria-label', 'Search discussions on this daf');
    els.search.addEventListener('input', onSearchInput);
    searchRow.append(els.search);
    els.filters = el('div', 'live-filters');
    els.filters.setAttribute('role', 'group');
    els.filters.setAttribute('aria-label', 'Show');
    for (const [value, label] of FILTERS) {
      const chip = el('button', 'live-chip live-filter', label);
      chip.type = 'button';
      chip.dataset.filter = value;
      chip.addEventListener('click', () => { L.filter = value; L.touchedAt = Date.now(); renderList(); });
      els.filters.append(chip);
    }
    els.options = el('div', 'live-options');
    els.followLabel = el('label', 'live-option');
    els.followBox = el('input');
    els.followBox.type = 'checkbox';
    els.followBox.checked = L.followPlace;
    els.followBox.addEventListener('change', () => {
      L.followPlace = els.followBox.checked;
      storeFlag(FOLLOW_KEY, L.followPlace);
      L.placeBucket = null;
      if (L.followPlace) renderList();
    });
    els.followLabel.append(els.followBox, el('span', null, 'Follow my place'));
    els.followLabel.title = 'Re-order the list as you move through the daf or the shiur moves on. Off: the list stays as it is until you change it.';
    els.markersLabel = el('label', 'live-option');
    els.markersBox = el('input');
    els.markersBox.type = 'checkbox';
    els.markersBox.checked = L.markersOn;
    els.markersBox.addEventListener('change', () => {
      L.markersOn = els.markersBox.checked;
      storeFlag(MARKERS_KEY, L.markersOn);
      renderMarkers();
    });
    els.markersLabel.append(els.markersBox, el('span', null, 'Markers on the daf'));
    els.options.append(els.followLabel, els.markersLabel);
    els.banner = el('div', 'live-banner');
    els.banner.hidden = true;
    els.status = el('p', 'live-status');
    els.status.setAttribute('role', 'status');
    els.threads = el('ul', 'live-threads');
    els.threads.setAttribute('aria-label', 'Discussions on this daf');
    els.empty = el('div', 'live-empty');
    els.listScroll = el('div', 'live-scroll');
    els.listScroll.append(els.status, els.threads, els.empty);
    els.listScroll.addEventListener('scroll', () => { L.touchedAt = Date.now(); }, { passive: true });
    els.adminBar = el('div', 'live-admin-bar');
    els.listView.append(controls, searchRow, els.filters, els.options, els.banner, els.listScroll, els.adminBar);

    // Chat view
    els.chatView = el('section', 'live-view live-chat-view');
    els.chatView.hidden = true;
    const chatHead = el('div', 'live-chat-head');
    els.back = button('live-icon-button live-back', '‹', backToList, 'Back to the discussions');
    els.anchor = el('button', 'live-anchor');
    els.anchor.type = 'button';
    els.anchor.setAttribute('dir', 'rtl');
    els.anchor.setAttribute('lang', 'he');
    els.anchor.addEventListener('click', () => showAnchor(L.thread));
    els.chatTools = el('div', 'live-chat-tools');
    chatHead.append(els.back, els.anchor, els.chatTools);
    els.chatMeta = el('div', 'live-chat-meta');
    els.messagesScroll = el('div', 'live-scroll live-messages-scroll');
    els.more = button('live-more', 'Load earlier messages', loadEarlier);
    els.more.hidden = true;
    els.messages = el('ol', 'live-messages');
    els.messages.setAttribute('aria-live', 'polite');
    els.newBelow = button('live-new-below', 'New messages ↓', () => scrollToBottom(true));
    els.newBelow.hidden = true;
    els.messagesScroll.append(els.more, els.messages);
    els.messagesScroll.addEventListener('scroll', () => { if (nearBottom()) els.newBelow.hidden = true; }, { passive: true });
    els.chatError = el('p', 'live-error');
    els.chatError.setAttribute('role', 'alert');
    els.chatError.hidden = true;
    els.composer = buildComposer();
    els.chatView.append(chatHead, els.chatMeta, els.messagesScroll, els.newBelow, els.chatError, els.composer);

    // New-discussion view
    els.composeView = el('section', 'live-view live-compose-view');
    els.composeView.hidden = true;
    const composeHead = el('div', 'live-chat-head');
    composeHead.append(button('live-icon-button live-back', '‹', backToList, 'Cancel'), el('strong', null, 'New live discussion'));
    els.composeQuote = el('blockquote', 'live-compose-quote');
    els.composeQuote.setAttribute('dir', 'rtl');
    els.composeQuote.setAttribute('lang', 'he');
    els.composeBody = el('textarea', 'live-textarea');
    els.composeBody.rows = 5;
    els.composeBody.maxLength = 2000;
    els.composeBody.placeholder = 'Ask your question, or share what you noticed…';
    els.composeBody.setAttribute('aria-label', 'Your question or comment');
    els.composeError = el('p', 'live-error');
    els.composeError.setAttribute('role', 'alert');
    els.composeError.hidden = true;
    els.composeNote = el('p', 'live-note', 'This starts its own live conversation about these words. Others learning this daf can find it and join in. For a lasting note, use “Add note”.');
    els.composeActions = el('div', 'live-compose-actions');
    els.composeCancel = button('live-secondary', 'Cancel', backToList);
    els.composeSend = button('live-primary', 'Start discussion', submitNewThread);
    els.composeActions.append(els.composeCancel, els.composeSend);
    els.composeBody.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submitNewThread();
    });
    els.composeView.append(composeHead, els.composeQuote, els.composeBody, els.composeError, els.composeNote, els.composeActions);

    els.panel.append(head, els.listView, els.chatView, els.composeView);
    document.body.append(els.toggle, els.panel);

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !L.open) return;
      if (event.target instanceof HTMLTextAreaElement && event.target.value) return;
      if (L.view !== 'list') backToList(); else closePanel();
    });
  }

  function buildComposer() {
    const form = el('form', 'live-composer');
    els.quoteBar = el('div', 'live-quote-bar');
    els.quoteBar.hidden = true;
    els.quoteText = el('span', 'live-quote-text');
    els.quoteBar.append(els.quoteText, button('live-icon-button', '×', clearQuote, 'Cancel the reply'));
    els.input = el('textarea', 'live-textarea live-input');
    els.input.rows = 1;
    els.input.maxLength = 2000;
    els.input.placeholder = 'Write a message';
    els.input.setAttribute('aria-label', 'Message');
    els.send = el('button', 'live-send');
    els.send.type = 'submit';
    els.send.textContent = 'Send';
    const row = el('div', 'live-composer-row');
    row.append(els.input, els.send);
    form.append(els.quoteBar, row);
    form.addEventListener('submit', (event) => { event.preventDefault(); sendMessage(); });
    els.input.addEventListener('input', autoGrow);
    els.input.addEventListener('keydown', (event) => {
      // Enter sends on a keyboard; on a phone it is a new line (the Send button sends).
      if (event.key === 'Enter' && !event.shiftKey && !window.matchMedia('(pointer: coarse)').matches) {
        event.preventDefault();
        sendMessage();
      }
    });
    return form;
  }

  function autoGrow() {
    els.input.style.height = 'auto';
    els.input.style.height = `${Math.min(els.input.scrollHeight, 140)}px`;
  }

  // ---- opening and closing ---------------------------------------------------------------
  function openPanel() {
    if (!L.available) return;
    build();
    L.open = true;
    els.panel.hidden = false;
    els.toggle.setAttribute('aria-expanded', 'true');
    document.body.classList.add('live-open');
    refreshDaf();
  }

  function closePanel() {
    if (!L.built) return;
    L.open = false;
    els.panel.hidden = true;
    els.toggle.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('live-open');
    leaveThread();
    leaveDaf();
    showView('list');
  }

  function showView(view) {
    L.view = view;
    els.listView.hidden = view !== 'list';
    els.chatView.hidden = view !== 'chat';
    els.composeView.hidden = view !== 'compose';
  }

  function backToList() {
    leaveThread();
    showView('list');
    renderList();
    els.sort?.focus?.();
  }

  // ---- the daf's list of discussions ----------------------------------------------------
  async function refreshDaf() {
    const key = core.dafKeyFromRef(currentDafRef());
    if (!key) {
      L.dafKey = null;
      renderHeader();
      renderList();
      return;
    }
    const changed = key !== L.dafKey;
    L.dafKey = key;
    L.dafLabel = core.dafLabelFromRef(currentDafRef());
    if (changed) {
      L.threads = [];
      L.place = null;
      L.placeBucket = null;
      L.query = '';
      L.matchIds = null;
      L.markerIds = null;
      L.mine = new Set();
      if (els.search) els.search.value = '';
      if (L.view !== 'compose') { leaveThread(); showView('list'); }
    }
    renderHeader();
    const token = ++L.loadToken;
    els.status.textContent = changed ? 'Loading discussions…' : '';
    try {
      const threads = await data.fetchThreads(key);
      if (token !== L.loadToken) return;
      L.threads = threads;
      const ids = threads.map((t) => t.id);
      if (signedIn()) {
        [L.follows, L.reads, L.mine] = await Promise.all([
          data.fetchFollows(ids), data.fetchReadStates(ids), data.fetchParticipated(ids).catch(() => new Set()),
        ]);
      } else {
        L.follows = new Set();
        L.reads = new Map();
        L.mine = new Set();
      }
      if (token !== L.loadToken) return;
      els.status.textContent = '';
    } catch (error) {
      if (token !== L.loadToken) return;
      els.status.textContent = core.errorText(error);
    }
    renderList();
    joinDaf();
    refreshUnread();
    openDeepLinkIfAny();
  }

  function joinDaf() {
    if (L.dafChannel?.key === L.dafKey) return;
    leaveDaf();
    const key = L.dafKey;
    const events = {
      thread: (payload) => { L.threads = core.mergeThread(L.threads, payload); renderList(); },
      thread_updated: (payload) => {
        scheduleUnreadRefresh();
        L.threads = core.mergeThread(L.threads, payload);
        if (L.thread?.id === payload.id) { L.thread = { ...L.thread, ...payload }; renderChatMeta(); }
        renderList();
      },
      thread_removed: (payload) => {
        L.threads = core.removeThread(L.threads, payload.id);
        if (L.thread?.id === payload.id) { toast('This discussion was removed.'); backToList(); }
        renderList();
      },
    };
    const handle = data.joinDaf(key, {
      events,
      onPresence: (count) => { L.dafPresence = count; renderHeader(); },
      onStatus: (status) => {
        L.dafLive = status === 'live';
        if (L.dafLive) stopDafPoll(); else startDafPoll();
        renderHeader();
      },
    });
    L.dafChannel = { key, close: handle.close };
  }

  function leaveDaf() {
    L.dafChannel?.close();
    L.dafChannel = null;
    L.dafLive = false;
    L.dafPresence = 0;
    stopDafPoll();
  }
  function startDafPoll() {
    if (L.dafPoll || !L.open) return;
    L.dafPoll = data.poll(async () => {
      if (!L.open || !L.dafKey) return;
      const threads = await data.fetchThreads(L.dafKey);
      L.threads = threads;
      renderList();
    });
  }
  function stopDafPoll() {
    L.dafPoll?.stop();
    L.dafPoll = null;
  }

  function renderHeader() {
    if (!L.built) return;
    els.title.textContent = L.dafLabel || 'No daf chosen';
    const parts = [];
    if (L.dafPresence > 0) parts.push(`${L.dafPresence} ${L.dafPresence === 1 ? 'person' : 'people'} learning this daf now`);
    if (L.view === 'chat' && L.threadPresence > 1) parts.push(`${L.threadPresence} in this conversation`);
    els.presence.textContent = parts.join(' · ');
    els.presence.hidden = parts.length === 0;
  }

  function updateToggleCount() {
    if (!L.built) return;
    const count = L.threads.length;
    els.toggleCount.textContent = count ? String(count) : '';
    els.toggleCount.hidden = count === 0;
    const fresh = L.unread ? core.unreadTotal(L.unread.counts) : 0;
    els.toggleNew.textContent = fresh ? `${fresh > 99 ? '99+' : fresh} new` : '';
    els.toggleNew.hidden = fresh === 0;
  }

  // The threads to show: the daf's, narrowed by the chosen filter, a search, or the marker the
  // reader tapped, and then put in the chosen order.
  function visibleThreads(place) {
    const narrowed = core.filterThreads(L.threads, {
      filter: L.filter, follows: L.follows, mine: L.mine, matchIds: L.matchIds, ids: L.markerIds,
      myId: myId(), place: place || computePlace(),
    });
    return core.sortThreads(narrowed, L.sort, place);
  }

  function renderList() {
    if (!L.built) return;
    updateToggleCount();
    const place = (L.place = computePlace());
    const sorted = visibleThreads(L.sort === 'near' ? place : null);
    els.threads.textContent = '';
    for (const thread of sorted) els.threads.append(threadCard(thread, place));
    els.filters.querySelectorAll('.live-filter').forEach((chip) => {
      chip.setAttribute('aria-pressed', String(chip.dataset.filter === L.filter));
      chip.classList.toggle('live-chip-on', chip.dataset.filter === L.filter);
    });
    els.followLabel.hidden = L.sort !== 'near';
    els.banner.textContent = '';
    els.banner.hidden = !L.markerIds;
    if (L.markerIds) {
      els.banner.append(el('span', null, `Showing the ${L.markerIds.size} discussions at the spot you tapped`),
        button('live-link', 'Show all', () => { L.markerIds = null; renderList(); }));
    }
    els.empty.textContent = '';
    if (!L.dafKey) {
      els.empty.append(el('p', null, 'Choose a daf to see its discussions.'));
    } else if (!L.threads.length) {
      els.empty.append(
        el('p', 'live-empty-title', 'No discussions on this daf yet.'),
        el('p', null, 'Be the first to ask. Select words in the Gemara, right-click (or press and hold), and choose “Start live discussion”.'),
      );
    } else if (!sorted.length) {
      els.empty.append(el('p', 'live-empty-title', L.query ? `Nothing found for “${L.query}”.` : emptyFilterText()));
    }
    renderAdminBar();
    renderMarkers();
  }

  function emptyFilterText() {
    if (L.filter === 'following') return 'You are not following any discussion on this daf yet.';
    if (L.filter === 'mine') return 'You have not asked or posted in any discussion on this daf.';
    if (L.filter === 'here') return 'No discussion is about the passage you are at.';
    if (L.sort === 'unanswered') return 'Every discussion here has an answer.';
    return 'Nothing here with this filter.';
  }

  function threadCard(thread, place) {
    const item = el('li', 'live-thread-item');
    const card = el('button', 'live-card');
    card.type = 'button';
    card.dataset.threadId = thread.id;
    const quote = el('span', 'live-card-quote', shortQuote(thread.quoted_text));
    quote.setAttribute('dir', 'rtl');
    quote.setAttribute('lang', 'he');
    const preview = el('span', 'live-card-preview', thread.preview);
    const meta = el('span', 'live-card-meta');
    const replies = core.replyCount(thread);
    meta.append(el('span', null, `${replies} ${replies === 1 ? 'reply' : 'replies'}`));
    meta.append(el('span', null, `Active ${core.timeAgo(thread.last_message_at)}`));
    if (thread.status === 'answered') meta.append(el('span', 'live-badge live-badge-answered', 'Answered'));
    const waiting = L.unread ? L.unread.counts.get(thread.id) || 0 : null;
    if (waiting) {
      const badge = el('span', 'live-unread', `${waiting > 99 ? '99+' : waiting} new`);
      badge.setAttribute('aria-label', `${waiting} new ${waiting === 1 ? 'message' : 'messages'}`);
      meta.append(badge);
    } else if (waiting === null && core.hasUnread(thread, L.reads.get(thread.id), L.follows.has(thread.id), myId())) {
      const dot = el('span', 'live-unread', 'New');
      dot.setAttribute('aria-label', 'New activity');
      meta.append(dot);
    }
    if (place && core.isHere(thread, place)) {
      const here = el('span', 'live-badge live-badge-here', 'Here');
      here.title = 'About the passage you are at';
      meta.append(here);
    }
    if (Date.now() - Date.parse(thread.last_message_at) < 120000) {
      const live = el('span', 'live-pulse');
      live.setAttribute('title', 'Active right now');
      live.setAttribute('aria-label', 'Active right now');
      meta.append(live);
    }
    card.append(quote, preview, meta);
    card.addEventListener('click', () => openThread(thread.id));
    item.append(card);
    return item;
  }

  function shortQuote(text) {
    const words = String(text || '').trim().split(/\s+/);
    return words.length > 9 ? `${words.slice(0, 9).join(' ')}…` : words.join(' ');
  }

  function renderAdminBar() {
    els.adminBar.textContent = '';
    els.adminBar.hidden = !isAdmin();
    if (!isAdmin()) return;
    const label = el('span', null, `Visible to: ${L.audience === 'everyone' ? 'everyone' : 'admins only'}`);
    const next = L.audience === 'everyone' ? 'admins' : 'everyone';
    els.adminBar.append(label, button('live-link', next === 'everyone' ? 'Open to everyone' : 'Admins only', async () => {
      try {
        await data.setAudience(next);
        L.audience = next;
        toast(next === 'everyone' ? 'Live discussions are now open to everyone.' : 'Live discussions are now admins only.');
        renderAdminBar();
      } catch (error) {
        toast(core.errorText(error), 'error');
      }
    }));
  }

  // ---- a conversation ------------------------------------------------------------------
  async function openThread(id) {
    if (!L.open) openPanel();
    leaveThread();
    showView('chat');
    L.touchedAt = Date.now();
    const known = L.threads.find((t) => t.id === id);
    L.thread = known || null;
    L.messages = [];
    L.hasMore = false;
    L.quoteId = null;
    L.editingId = null;
    els.messages.textContent = '';
    els.chatError.hidden = true;
    clearQuote();
    els.input.value = '';
    autoGrow();
    renderChatMeta();
    try {
      if (!L.thread) L.thread = await data.fetchThread(id);
      if (!L.thread) throw new Error('live_thread_missing');
      const { messages, hasMore } = await data.fetchMessages(id);
      L.messages = messages;
      L.hasMore = hasMore;
      if (signedIn() && !L.follows.has(id)) {
        try { L.follows = new Set([...(await data.fetchFollows([id])), ...L.follows]); } catch { /* shown as not following */ }
      }
    } catch (error) {
      showChatError(core.errorText(error));
      if (!L.thread) { backToList(); return; }
    }
    renderChatMeta();
    renderMessages();
    scrollToBottom(true);
    showAnchor(L.thread, { quiet: true });
    markReadNow();
    joinThread(id);
    els.input.focus({ preventScroll: true });
  }

  function leaveThread() {
    L.threadChannel?.close();
    L.threadChannel = null;
    L.threadLive = false;
    L.threadPresence = 0;
    L.threadPoll?.stop();
    L.threadPoll = null;
    L.thread = null;
    L.messages = [];
    renderHeader();
  }

  function joinThread(id) {
    const handle = data.joinThread(id, {
      events: {
        message: (payload) => receive(payload),
        message_updated: (payload) => receive(payload),
      },
      onPresence: (count) => { L.threadPresence = count; renderHeader(); },
      onStatus: (status) => {
        L.threadLive = status === 'live';
        if (L.thread?.id !== id) return;
        if (L.threadLive) { L.threadPoll?.stop(); L.threadPoll = null; catchUp(id); } else startThreadPoll(id);
        renderChatMeta();
      },
    });
    L.threadChannel = { id, close: handle.close };
  }

  function startThreadPoll(id) {
    if (L.threadPoll) return;
    L.threadPoll = data.poll(() => catchUp(id));
  }

  // Fetches what was missed (after a reconnect, or while the channel was not live).
  async function catchUp(id) {
    if (L.thread?.id !== id) return;
    const last = L.messages.reduce((max, m) => Math.max(max, Number(m.seq) || 0), 0);
    const missed = await data.fetchMessagesAfter(id, last);
    if (L.thread?.id !== id) return;
    for (const message of missed) receive(message);
  }

  function nearBottom() {
    const box = els.messagesScroll;
    return box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  }
  function scrollToBottom(force) {
    if (!force && !nearBottom()) return;
    els.messagesScroll.scrollTop = els.messagesScroll.scrollHeight;
    els.newBelow.hidden = true;
  }

  // One message from the database or from a broadcast.
  function receive(message) {
    if (!L.thread || message.thread_id !== L.thread.id) return;
    const wasAtBottom = nearBottom();
    const isNew = !L.messages.some((m) => m.id === message.id);
    L.messages = core.mergeMessage(L.messages, message);
    renderMessages();
    if (isNew && message.author_id !== myId()) {
      if (wasAtBottom) { scrollToBottom(true); markReadNow(); } else els.newBelow.hidden = false;
    } else if (isNew) {
      scrollToBottom(true);
    }
  }

  function renderChatMeta() {
    if (!L.built || !L.thread) return;
    const thread = L.thread;
    els.anchor.textContent = shortQuote(thread.quoted_text) || '—';
    els.anchor.title = 'Show these words on the daf';
    els.chatTools.textContent = '';
    const following = L.follows.has(thread.id);
    if (signedIn()) {
      els.chatTools.append(button('live-chip', following ? 'Following' : 'Follow', toggleFollow, following ? 'Stop following this discussion' : 'Follow this discussion'));
    }
    els.chatTools.append(button('live-chip', 'Share', shareThread, 'Copy a link to this discussion'));
    if (signedIn()) els.chatTools.append(button('live-chip', 'Report', () => reportThread(null), 'Report this discussion'));
    if (isAdmin()) els.chatTools.append(button('live-chip live-chip-danger', 'Hide', hideThread, 'Hide this discussion (moderator)'));
    els.chatMeta.textContent = '';
    const where = el('span', null, `${L.dafLabel || core.dafLabelFromRef(thread.segment_ref)} · ${thread.author_display_name}`);
    els.chatMeta.append(where);
    if (thread.status === 'answered') {
      els.chatMeta.append(el('span', 'live-badge live-badge-answered', 'Answered'));
      if (thread.answer_message_id) {
        els.chatMeta.append(button('live-link', 'Jump to the answer', () => jumpTo(thread.answer_message_id)));
      }
    }
    if (!L.threadLive && L.view === 'chat') {
      els.chatMeta.append(el('span', 'live-offline', 'Updating every few seconds'));
    }
    const canPost = signedIn();
    els.input.disabled = !canPost;
    els.send.disabled = !canPost;
    els.input.placeholder = canPost ? 'Write a message' : 'Sign in to join this discussion';
    renderHeader();
  }

  function jumpTo(messageId) {
    const node = els.messages.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
    if (!node) { toast('That message is further up. Load earlier messages first.'); return; }
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    node.classList.add('live-flash');
    setTimeout(() => node.classList.remove('live-flash'), 1600);
  }

  function renderMessages() {
    if (!L.built) return;
    els.more.hidden = !L.hasMore;
    els.messages.textContent = '';
    const byId = new Map(L.messages.map((m) => [m.id, m]));
    for (const message of L.messages) els.messages.append(messageBubble(message, byId));
  }

  function messageBubble(message, byId) {
    const mine = message.author_id === myId();
    const gone = Boolean(message.deleted_at || message.hidden);
    const item = el('li', `live-message${mine ? ' live-mine' : ''}${gone ? ' live-gone' : ''}`);
    item.dataset.messageId = message.id;
    const bubble = el('div', 'live-bubble');
    if (!mine) bubble.append(el('div', 'live-author', message.author_display_name));
    if (message.quoted_message_id) {
      const quoted = byId.get(message.quoted_message_id);
      const quote = el('button', 'live-quoted', quoted ? `${quoted.author_display_name}: ${core.quoteSnippet(quoted)}` : 'An earlier message');
      quote.type = 'button';
      quote.addEventListener('click', () => jumpTo(message.quoted_message_id));
      bubble.append(quote);
    }
    const body = el('div', 'live-body-text', gone ? (message.hidden ? 'This message was removed.' : 'This message was deleted.') : message.body);
    body.setAttribute('dir', 'auto');
    bubble.append(body);
    const foot = el('div', 'live-bubble-foot');
    foot.append(el('span', 'live-time', core.timeAgo(message.created_at)));
    if (message.edited_at && !gone) foot.append(el('span', 'live-edited', 'edited'));
    if (L.thread?.answer_message_id === message.id) foot.append(el('span', 'live-badge live-badge-answered', 'Answer'));
    if (!gone && signedIn()) foot.append(button('live-more-actions', '⋯', (event) => toggleActions(item, message, event), 'Message actions'));
    bubble.append(foot);
    item.append(bubble);
    return item;
  }

  function toggleActions(item, message, event) {
    event.stopPropagation();
    const existing = item.querySelector('.live-actions');
    document.querySelectorAll('.live-actions').forEach((node) => node.remove());
    if (existing) return;
    const mine = message.author_id === myId();
    const asker = L.thread?.author_id === myId();
    const actions = el('div', 'live-actions');
    actions.append(button('live-chip', 'Reply', () => { setQuote(message); actions.remove(); }));
    actions.append(button('live-chip', 'Copy', async () => {
      try { await navigator.clipboard.writeText(message.body); toast('Copied.'); } catch { toast('Could not copy.', 'error'); }
      actions.remove();
    }));
    if (mine && Date.now() - Date.parse(message.created_at) < EDIT_WINDOW_MS) {
      actions.append(button('live-chip', 'Edit', () => { startEdit(message); actions.remove(); }));
    }
    if (mine || isAdmin()) actions.append(button('live-chip', 'Delete', () => { actions.remove(); removeMessage(message); }));
    // The asker (or a moderator) can mark any reply -- not the opening question -- as the answer.
    const isOpeningQuestion = !L.hasMore && message.seq === L.messages[0]?.seq;
    if ((asker || isAdmin()) && !isOpeningQuestion) {
      const isAnswer = L.thread?.answer_message_id === message.id;
      actions.append(button('live-chip', isAnswer ? 'Not the answer' : 'Mark as answer', () => { actions.remove(); markAnswer(isAnswer ? null : message.id); }));
    }
    if (!mine) actions.append(button('live-chip', 'Report', () => { actions.remove(); reportThread(message.id); }));
    if (isAdmin() && !mine) actions.append(button('live-chip live-chip-danger', 'Remove', () => { actions.remove(); moderateMessage(message); }));
    item.querySelector('.live-bubble').append(actions);
  }

  // ---- sending, quoting, editing ---------------------------------------------------------
  function setQuote(message) {
    L.quoteId = message.id;
    els.quoteText.textContent = `${message.author_display_name}: ${core.quoteSnippet(message)}`;
    els.quoteBar.hidden = false;
    els.input.focus();
  }
  function clearQuote() {
    L.quoteId = null;
    L.editingId = null;
    if (els.quoteBar) els.quoteBar.hidden = true;
  }
  function startEdit(message) {
    L.editingId = message.id;
    L.quoteId = null;
    els.quoteText.textContent = `Editing: ${core.quoteSnippet(message)}`;
    els.quoteBar.hidden = false;
    els.input.value = message.body;
    autoGrow();
    els.input.focus();
  }

  function showChatError(message) {
    els.chatError.textContent = message;
    els.chatError.hidden = !message;
  }

  async function sendMessage() {
    if (!L.thread) return;
    if (!signedIn()) { promptSignIn(); return; }
    const body = els.input.value;
    const problem = core.bodyProblem(body);
    if (problem) { showChatError(problem); return; }
    showChatError('');
    els.send.disabled = true;
    try {
      if (L.editingId) {
        const message = await data.editMessage(L.editingId, body);
        L.messages = core.mergeMessage(L.messages, message);
      } else {
        const message = await data.postMessage(L.thread.id, body, L.quoteId);
        L.messages = core.mergeMessage(L.messages, message);
        if (!L.follows.has(L.thread.id)) { L.follows = new Set([...L.follows, L.thread.id]); renderChatMeta(); }
      }
      els.input.value = '';
      autoGrow();
      clearQuote();
      renderMessages();
      scrollToBottom(true);
      markReadNow();
    } catch (error) {
      showChatError(core.errorText(error));
    } finally {
      els.send.disabled = !signedIn();
    }
  }

  async function removeMessage(message) {
    try {
      const updated = await data.deleteMessage(message.id);
      L.messages = core.mergeMessage(L.messages, updated);
      renderMessages();
      if (updated.seq === L.messages[0]?.seq && !L.messages.some((m) => m.id !== updated.id && !m.deleted_at && !m.hidden)) {
        toast('Your question was deleted, and the discussion with it.');
        L.threads = core.removeThread(L.threads, L.thread.id);
        backToList();
      }
    } catch (error) {
      showChatError(core.errorText(error));
    }
  }

  async function moderateMessage(message) {
    try {
      await data.moderate(L.thread.id, message.id, true);
      L.messages = core.mergeMessage(L.messages, { ...message, body: '', hidden: true });
      renderMessages();
    } catch (error) {
      showChatError(core.errorText(error));
    }
  }

  async function hideThread() {
    try {
      await data.moderate(L.thread.id, null, true);
      L.threads = core.removeThread(L.threads, L.thread.id);
      toast('Discussion hidden. It can be restored from the database.');
      backToList();
    } catch (error) {
      showChatError(core.errorText(error));
    }
  }

  async function markAnswer(messageId) {
    try {
      const thread = await data.setAnswer(L.thread.id, messageId);
      L.thread = { ...L.thread, ...thread };
      L.threads = core.mergeThread(L.threads, thread);
      renderChatMeta();
      renderMessages();
    } catch (error) {
      showChatError(core.errorText(error));
    }
  }

  async function reportThread(messageId) {
    const reason = window.prompt('What is wrong with this? (optional)');
    if (reason === null) return;
    try {
      await data.report(L.thread.id, messageId, reason);
      toast('Thank you. A moderator will take a look.');
    } catch (error) {
      showChatError(core.errorText(error));
    }
  }

  async function toggleFollow() {
    const id = L.thread.id;
    try {
      if (L.follows.has(id)) { await data.unfollow(id); L.follows.delete(id); } else { await data.follow(id); L.follows.add(id); }
      L.follows = new Set(L.follows);
      renderChatMeta();
    } catch (error) {
      showChatError(core.errorText(error));
    }
  }

  async function shareThread() {
    const url = core.threadUrl(location.origin, L.dafLabel || L.thread.segment_ref, L.thread.id);
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied.');
    } catch {
      window.prompt('Copy this link', url);
    }
  }

  async function loadEarlier() {
    if (!L.thread || !L.messages.length) return;
    const first = Number(L.messages[0].seq);
    const keepHeight = els.messagesScroll.scrollHeight;
    try {
      const { messages, hasMore } = await data.fetchMessages(L.thread.id, { beforeSeq: first });
      for (const message of messages) L.messages = core.mergeMessage(L.messages, message);
      L.hasMore = hasMore;
      renderMessages();
      els.messagesScroll.scrollTop = els.messagesScroll.scrollHeight - keepHeight;
    } catch (error) {
      showChatError(core.errorText(error));
    }
  }

  function markReadNow() {
    if (!signedIn() || !L.thread) return;
    const last = L.messages.reduce((max, m) => Math.max(max, Number(m.seq) || 0), 0);
    if (!last) return;
    const id = L.thread.id;
    data.markRead(id, last).then(() => {
      L.reads.set(id, { thread_id: id, last_read_seq: last, updated_at: new Date().toISOString() });
      if (L.unread?.counts.delete(id)) updateToggleCount();
    }).catch(() => {});
  }

  // ---- anchoring: the words on the daf ----------------------------------------------------
  function showAnchor(thread, { quiet = false } = {}) {
    if (!thread?.word_ranges?.length) return;
    if (typeof highlightTextRange !== 'function') return;
    highlightTextRange(thread.word_ranges);
    requestAnimationFrame(() => {
      const rect = document.querySelector('#vilnaSelectTextSelectionOverlay > *');
      if (rect) rect.scrollIntoView({ block: 'center', behavior: 'smooth' });
      else if (!quiet) toast("This daf's printed page has no word positions yet, so these words can't be shown on it.");
    });
  }

  // ---- starting a discussion -------------------------------------------------------------
  // From the right-click menu (daf-context-menu.js).
  async function startForSelection(target) {
    if (!L.available) { toast('Live discussions are not open to you yet.'); return; }
    if (!signedIn()) { promptSignIn(); return; }
    const runs = core.runsFromTarget(target, typeof state !== 'undefined' ? state.segments : []);
    if (!runs.length) { toast('Select some words first.', 'error'); return; }
    let quotedText = String(target.text || '').trim();
    try {
      if (typeof resolveWordRangeRunsText === 'function') quotedText = await resolveWordRangeRunsText(runs);
    } catch { /* fall back to the text the menu already had */ }
    if (!quotedText) { toast('Could not read the selected words.', 'error'); return; }
    const dafKey = core.dafKeyFromRef(runs[0].ref);
    if (!dafKey) { toast('Could not tell which daf this is.', 'error'); return; }
    build();
    if (!L.open) openPanel();
    L.compose = { runs, quotedText: quotedText.slice(0, 600), dafKey, segmentRef: runs[0].ref };
    leaveThread();
    els.composeQuote.textContent = quotedText.length > 200 ? `${quotedText.slice(0, 199)}…` : quotedText;
    els.composeBody.value = '';
    els.composeError.hidden = true;
    els.composeSend.disabled = false;
    showView('compose');
    els.composeBody.focus();
    if (typeof highlightTextRange === 'function') highlightTextRange(runs);
  }

  // The panel's own "Start a discussion" button: uses whatever is selected on the page.
  function beginFromCurrentSelection() {
    const runs = typeof state !== 'undefined' ? state.textSelection?.runs : null;
    if (!runs?.length) {
      toast('Select some words in the Gemara first, then right-click (or press and hold) and choose “Start live discussion”.');
      return;
    }
    startForSelection({ runs, text: '' });
  }

  async function submitNewThread() {
    const draft = L.compose;
    if (!draft) return;
    const problem = core.bodyProblem(els.composeBody.value);
    if (problem) { els.composeError.textContent = problem; els.composeError.hidden = false; return; }
    els.composeError.hidden = true;
    els.composeSend.disabled = true;
    try {
      const thread = await data.startThread({
        dafKey: draft.dafKey, segmentRef: draft.segmentRef, runs: draft.runs,
        quotedText: draft.quotedText, body: els.composeBody.value,
      });
      L.compose = null;
      if (draft.dafKey === L.dafKey) L.threads = core.mergeThread(L.threads, thread);
      L.follows = new Set([...L.follows, thread.id]);
      renderList();
      await openThread(thread.id);
    } catch (error) {
      els.composeError.textContent = core.errorText(error);
      els.composeError.hidden = false;
      els.composeSend.disabled = false;
    }
  }

  // ---- availability, deep links, upkeep -----------------------------------------------------
  function openDeepLinkIfAny() {
    if (!L.pendingDeepLink) return;
    const id = L.pendingDeepLink;
    L.pendingDeepLink = null;
    openThread(id);
  }

  async function evaluateAvailability() {
    await auth()?.ready;
    L.audience = await data.fetchAudience();
    const before = L.available;
    L.available = L.audience === 'everyone' || (L.audience !== null && isAdmin());
    if (L.available && !L.built) build();
    if (L.built) els.toggle.hidden = !L.available;
    if (!L.available && L.open) closePanel();
    if (L.available && !before) {
      refreshDafSilently();
      refreshUnread();
      if (L.pendingDeepLink) openPanel();
    }
    if (L.built) { renderAdminBar(); renderMarkers(); }
  }

  async function refreshDafSilently() {
    const key = core.dafKeyFromRef(currentDafRef());
    if (!key || L.open) return;
    try {
      L.dafKey = key;
      L.dafLabel = core.dafLabelFromRef(currentDafRef());
      L.threads = await data.fetchThreads(key);
      L.markerIds = null;
      updateToggleCount();
      renderMarkers();
    } catch { /* the count simply stays empty */ }
  }

  // ---- search ---------------------------------------------------------------------------------
  // The list answers at once from what it holds (questions, quoted words, askers); the
  // conversations themselves are searched in the database a moment after typing stops.
  function onSearchInput() {
    const query = els.search.value.trim();
    L.query = query;
    L.touchedAt = Date.now();
    L.markerIds = null;
    clearTimeout(L.searchTimer);
    const token = ++L.searchToken;
    if (!query) {
      L.matchIds = null;
      renderList();
      return;
    }
    L.matchIds = new Set(L.threads.filter((t) => core.matchesQuery(t, query)).map((t) => t.id));
    renderList();
    L.searchTimer = setTimeout(async () => {
      try {
        const found = await data.searchMessages(L.threads.map((t) => t.id), query);
        if (token !== L.searchToken) return;
        L.matchIds = new Set([...L.matchIds, ...found]);
        renderList();
      } catch { /* the matches already shown stay */ }
    }, SEARCH_DELAY_MS);
  }

  // ---- what is new -----------------------------------------------------------------------------
  let unreadDebounce = null;
  function scheduleUnreadRefresh() {
    clearTimeout(unreadDebounce);
    unreadDebounce = setTimeout(refreshUnread, 2000);
  }

  // How many new messages wait in the threads the reader follows, on this daf and any other.
  async function refreshUnread() {
    if (!L.available) return;
    L.unread = signedIn() ? await data.fetchUnreadCounts() : null;
    updateToggleCount();
    if (L.open && L.view === 'list') renderList();
  }

  // ---- markers on the printed daf ----------------------------------------------------------------
  // A small speech bubble under the first words of each discussion, on the Vilna page itself.
  // Discussions whose bubbles would overlap share one, with a count. The layer sits among the
  // page's other overlays, takes no clicks except on a bubble, and goes away when switched off.
  function removeMarkerLayer() {
    document.getElementById('liveMarkersOverlay')?.remove();
  }

  function renderMarkers() {
    if (!L.available || !L.markersOn || typeof state === 'undefined' || !state.vilnaPageMap
        || typeof groupBoxesIntoLineRects !== 'function') {
      removeMarkerLayer();
      return;
    }
    const wrap = document.getElementById('vilnaPageWrap');
    if (!wrap) return;
    let layer = document.getElementById('liveMarkersOverlay');
    if (!layer) {
      layer = el('div', 'live-markers-overlay');
      layer.id = 'liveMarkersOverlay';
      const after = document.getElementById('vilnaNoteMarkersOverlay');
      if (after && after.parentNode === wrap) after.after(layer); else wrap.append(layer);
    }
    layer.textContent = '';
    const map = state.vilnaPageMap;
    if (!map.wordBoxes?.length || core.dafKeyFromRef(map.wordBoxes[0].ref) !== L.dafKey) return;
    const byRef = new Map();
    for (const box of map.wordBoxes) {
      if (!byRef.has(box.ref)) byRef.set(box.ref, []);
      byRef.get(box.ref).push(box);
    }
    const bands = typeof vilnaInkBands === 'function' ? vilnaInkBands(map) : [];
    const points = [];
    for (const thread of L.threads) {
      const run = thread.word_ranges?.[0];
      if (!run) continue;
      const boxes = (byRef.get(run.ref) || [])
        .filter((box) => box.wordIndex >= run.start && box.wordIndex <= run.end)
        .sort((a, b) => a.wordIndex - b.wordIndex);
      if (!boxes.length) continue;
      const rect = groupBoxesIntoLineRects(boxes, map, bands)[0];
      if (rect) points.push({ id: thread.id, x: rect.left + rect.width, y: rect.top + rect.height });
    }
    for (const cluster of core.clusterMarkers(points)) {
      const count = cluster.ids.length;
      const marker = el('button', 'live-marker');
      marker.type = 'button';
      marker.style.left = `${cluster.x * 100}%`;
      marker.style.top = `${cluster.y * 100}%`;
      marker.setAttribute('aria-label', count === 1 ? 'A live discussion on these words' : `${count} live discussions on these words`);
      if (count > 1) marker.append(el('span', 'live-marker-count', String(count)));
      marker.addEventListener('click', (event) => { event.stopPropagation(); onMarker(cluster.ids); });
      layer.append(marker);
    }
  }

  // One discussion opens; several show the list narrowed to them (with a way back to all).
  function onMarker(ids) {
    if (!L.open) openPanel();
    if (ids.length === 1) { openThread(ids[0]); return; }
    L.markerIds = new Set(ids);
    L.filter = 'all';
    L.query = '';
    L.matchIds = null;
    if (els.search) els.search.value = '';
    leaveThread();
    showView('list');
    renderList();
    showAnchor(L.threads.find((t) => t.id === ids[0]), { quiet: true });
  }

  window.addEventListener('dafsync:vilna-page', () => renderMarkers());

  // Upkeep: notice a change of daf, and re-rank "near my place" when the passage moves.
  setInterval(() => {
    if (!L.available || !L.built) return;
    const key = core.dafKeyFromRef(currentDafRef());
    if (key && key !== L.dafKey) {
      if (L.open) refreshDaf(); else { L.dafKey = null; refreshDafSilently(); }
      return;
    }
    // "Follow my place" (on by default): the list re-ranks when the reader's passage moves on,
    // but never while they are using it, and never at all when they switch it off.
    if (!L.open || L.view !== 'list' || !L.followPlace) return;
    if (L.sort !== 'near' && L.filter !== 'here') return;
    if (Date.now() - L.touchedAt < PLACE_QUIET_MS) return;
    const place = computePlace();
    const bucket = place ? Math.floor(place.segment / PLACE_BUCKET) : null;
    if (bucket !== L.placeBucket) {
      L.placeBucket = bucket;
      renderList();
    }
  }, PLACE_POLL_MS);

  // After an edit/menu click elsewhere, close any open message-actions row.
  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element) || event.target.closest('.live-actions, .live-more-actions')) return;
    document.querySelectorAll('.live-actions').forEach((node) => node.remove());
  });

  setInterval(() => {
    if (L.available && signedIn() && !document.hidden) refreshUnread();
  }, UNREAD_POLL_MS);

  window.DafLive = {
    available: () => L.available,
    renderMarkers,
    startForSelection,
    open: openPanel,
    close: closePanel,
    openThread,
    refresh: refreshDaf,
    // For tests and the console.
    _state: L,
  };

  evaluateAvailability();
  auth()?.onChange?.(() => { evaluateAvailability(); if (L.open) refreshDaf(); });
})();
