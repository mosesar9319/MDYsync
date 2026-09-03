'use strict';

// Cloud Chabura home: state, URL synchronisation, Today's Daf, and the feed.
//
// Feed scope, category, tractate and search all live in the query string, so
// back/forward work and a filtered view is a shareable link -- the old page
// kept all of that in module variables and read only ?ref= (audit F-6).

(function () {
  const { data, components } = window.DafSyncChabura;
  const { el } = components;

  const TABS = [
    { id: 'for-you', label: 'For you', signedInOnly: true },
    { id: 'today', label: "Today's daf" },
    { id: 'following', label: 'Following', signedInOnly: true },
    { id: 'latest', label: 'Latest' },
    { id: 'unanswered', label: 'Unanswered' },
    { id: 'highlighted', label: 'Highlighted' },
    { id: 'saved', label: 'Saved', signedInOnly: true },
  ];

  const state = {
    scope: 'latest',
    category: '',
    tractate: '',
    search: '',
    rows: [],
    cursor: null,
    hasMore: false,
    loading: false,
    todayRef: null,      // "Chullin 89a"
    todayRefKey: null,   // "Chullin-89a"
    token: 0,
  };

  const els = {};

  function cacheEls() {
    els.tabs = document.getElementById('ccTabs');
    els.feed = document.getElementById('ccFeed');
    els.feedFooter = document.getElementById('ccFeedFooter');
    els.loadMore = document.getElementById('ccLoadMore');
    els.today = document.getElementById('ccToday');
    els.search = document.getElementById('ccSearch');
    els.category = document.getElementById('ccCategory');
    els.categorySheet = document.getElementById('ccCategorySheet');
    els.railNav = document.getElementById('ccRailNav');
    els.activity = document.getElementById('ccActivity');
    els.filterSheet = document.getElementById('ccFilterSheet');
    els.openFilters = document.getElementById('ccOpenFilters');
    els.closeFilters = document.getElementById('ccCloseFilters');
    els.status = document.getElementById('ccStatus');
  }

  function signedIn() {
    return Boolean(window.DafSyncAuth?.getUser?.());
  }

  // --- URL <-> state ------------------------------------------------------
  function readUrl() {
    const params = new URLSearchParams(location.search);
    const scope = params.get('view');
    // ?ref= is still honoured: it is how the daf pages link in here.
    const ref = params.get('ref');

    // Every field is derived from the URL, including when a parameter is
    // ABSENT. Leaving the previous value in place on a missing parameter is
    // what makes Back appear to do nothing: history restores an address with
    // no ?view=, the page keeps the scope it already had, and the feed then
    // contradicts its own address bar.
    if (scope && TABS.some((tab) => tab.id === scope)) state.scope = scope;
    else if (ref) state.scope = 'today';
    else state.scope = 'latest';

    state.category = params.get('category') || '';
    state.tractate = params.get('tractate') || '';
    state.search = params.get('q') || '';

    // Only overwrite the daf when the URL actually names one -- otherwise a
    // popstate back to a plain /chaburah/ would discard the daf the calendar
    // resolved at load.
    if (ref) state.todayRefKey = ref.replace(/\s+/g, '-');
  }

  function writeUrl(replace) {
    const params = new URLSearchParams();
    if (state.scope !== 'latest') params.set('view', state.scope);
    if (state.category) params.set('category', state.category);
    if (state.tractate) params.set('tractate', state.tractate);
    if (state.search) params.set('q', state.search);
    const query = params.toString();
    const url = query ? `${location.pathname}?${query}` : location.pathname;
    if (replace) history.replaceState({}, '', url);
    else history.pushState({}, '', url);
  }

  function announce(message) {
    if (els.status) els.status.textContent = message;
  }

  // --- Today's daf --------------------------------------------------------
  async function loadTodayRef() {
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      const response = await fetch(`/api/sefaria-calendars?timezone=${encodeURIComponent(timezone)}`);
      if (!response.ok) throw new Error(`Calendar returned ${response.status}`);
      const payload = await response.json();
      const item = (payload.calendar_items || [])
        .find((entry) => entry.category === 'Talmud' && entry.title?.en === 'Daf Yomi');
      if (!item) return null;
      const match = /^(.+?)\s+(\d+)$/.exec(String(item.displayValue?.en || '').trim());
      if (!match) return null;
      return `${match[1]} ${match[2]}a`;
    } catch (error) {
      // Never invent a daf. The panel says so rather than showing a wrong one.
      console.error("Could not load today's daf.", error);
      return null;
    }
  }

  async function renderToday() {
    if (!els.today) return;
    els.today.innerHTML = '';

    if (!state.todayRef) {
      els.today.appendChild(el('p', 'cc-today-eyebrow', "Today's Daf"));
      els.today.appendChild(el('h2', null, 'Unavailable right now'));
      els.today.appendChild(el('p', null, "The daily-daf calendar could not be reached, so today's daf is not shown. The rest of the feed is unaffected."));
      return;
    }

    els.today.appendChild(el('p', 'cc-today-eyebrow', "Today's Daf"));
    els.today.appendChild(el('h2', null, state.todayRef));

    let summary = { total: 0, unanswered: 0, previews: [] };
    try {
      summary = await data.fetchTodaySummary(state.todayRefKey);
    } catch (error) {
      console.error("Could not summarise today's daf.", error);
    }

    const stats = el('ul', 'cc-today-stats');
    const active = el('li');
    active.append(el('strong', null, String(summary.total)), document.createTextNode(summary.total === 1 ? ' discussion' : ' discussions'));
    stats.appendChild(active);
    const open = el('li');
    open.append(el('strong', null, String(summary.unanswered)), document.createTextNode(' unanswered'));
    stats.appendChild(open);
    els.today.appendChild(stats);

    if (summary.previews.length) {
      const list = el('div', 'cc-today-previews');
      summary.previews.forEach((row) => {
        const button = el('button', 'cc-today-preview', components.displayTitle(row));
        button.type = 'button';
        button.addEventListener('click', () => { location.href = threadHref(row); });
        list.appendChild(button);
      });
      els.today.appendChild(list);
    } else {
      els.today.appendChild(el('p', null, 'Be the first to open a question or share a source on today’s daf.'));
    }

    const actions = el('div', 'cc-today-actions');
    const openToday = el('button', 'cc-btn cc-btn-primary', summary.total ? 'Open today’s discussions' : 'Select a passage');
    openToday.type = 'button';
    openToday.addEventListener('click', () => {
      if (summary.total) setScope('today');
      else location.href = `/browse/?ref=${encodeURIComponent(state.todayRef)}`;
    });
    actions.appendChild(openToday);

    const openDaf = el('a', 'cc-btn', 'Open interactive daf');
    openDaf.href = `/browse/?ref=${encodeURIComponent(state.todayRef)}`;
    actions.appendChild(openDaf);
    els.today.appendChild(actions);
  }

  // --- Tabs and rail ------------------------------------------------------
  function renderTabs() {
    if (!els.tabs) return;
    els.tabs.innerHTML = '';
    TABS.forEach((tab) => {
      const button = el('button', 'cc-tab', tab.label);
      button.type = 'button';
      button.id = `cc-tab-${tab.id}`;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(state.scope === tab.id));
      // Signed-out readers can browse everything public; the personal views
      // are the only ones that need an account, and they say so rather than
      // disappearing.
      if (tab.signedInOnly && !signedIn()) {
        button.disabled = true;
        button.title = 'Sign in to use this view';
      }
      button.addEventListener('click', () => setScope(tab.id));
      els.tabs.appendChild(button);
    });

    // The tab strip scrolls horizontally on a phone, and the selected tab is
    // often past the right edge -- it rendered clipped mid-word. Centre it in
    // the strip directly rather than with scrollIntoView(), which would also
    // scroll the page itself.
    const active = els.tabs.querySelector('[aria-selected="true"]');
    if (active && els.tabs.scrollWidth > els.tabs.clientWidth) {
      els.tabs.scrollLeft = Math.max(0, active.offsetLeft - (els.tabs.clientWidth - active.offsetWidth) / 2);
    }
  }

  function renderRail() {
    if (!els.railNav) return;
    els.railNav.innerHTML = '';
    TABS.forEach((tab) => {
      const button = el('button', null, tab.label);
      button.type = 'button';
      button.setAttribute('aria-current', String(state.scope === tab.id));
      if (tab.signedInOnly && !signedIn()) {
        button.disabled = true;
        button.title = 'Sign in to use this view';
      }
      button.addEventListener('click', () => setScope(tab.id));
      els.railNav.appendChild(button);
    });
  }

  function populateCategorySelects() {
    const options = window.DafNotesFormat.CATEGORY_TYPES;
    [els.category, els.categorySheet].filter(Boolean).forEach((select) => {
      select.innerHTML = '';
      const all = el('option', null, 'All categories');
      all.value = '';
      select.appendChild(all);
      options.forEach((category) => {
        const option = el('option', null, `${category.he} — ${category.en}`);
        option.value = category.key;
        select.appendChild(option);
      });
      select.value = state.category;
    });
  }

  function threadHref(row) {
    // The dedicated thread route arrives with the thread reader (Prompt 4).
    // Until then a card opens the passage on the Interactive Daf, which is
    // where the discussion is readable today.
    const ref = components.dafLabel(row.daf_ref_key);
    return `/browse/?ref=${encodeURIComponent(ref)}`;
  }

  // --- Feed ---------------------------------------------------------------
  function filters() {
    return {
      category: state.category,
      tractate: state.tractate,
      search: state.search.trim(),
      dafRefKey: state.scope === 'today' ? state.todayRefKey : '',
    };
  }

  async function loadFeed({ append } = {}) {
    if (state.loading) return;
    state.loading = true;
    const token = data.nextGeneration();
    state.token = token;

    if (!append) {
      state.rows = [];
      state.cursor = null;
      els.feed.innerHTML = '';
      els.feed.appendChild(components.loadingState(3));
      els.feedFooter.hidden = true;
    }

    try {
      if (state.scope === 'today' && !state.todayRefKey) {
        renderEmpty({
          title: "Today's daf is unavailable",
          body: 'The daily-daf calendar could not be reached, so this view has nothing to filter by. Try Latest instead.',
          actionLabel: 'Show latest',
          onAction: () => setScope('latest'),
        });
        return;
      }

      // "For you" is followed threads first, then everything recent. With no
      // follows yet it is simply the latest feed rather than an empty page.
      const scope = state.scope === 'for-you' ? 'latest' : state.scope;
      const page = await data.fetchFeed({ scope, filters: filters(), cursor: state.cursor, token });

      // A newer request already started; drop this result rather than letting
      // it overwrite fresher content (audit F-5).
      if (page === null || !data.isCurrent(token)) return;

      if (page.requiresSignIn) {
        renderEmpty({
          title: 'Sign in to see this',
          body: 'Following, Saved and For you are personal views, so they need an account.',
        });
        return;
      }

      const decorated = await data.decorate(page.rows);
      if (!data.isCurrent(token)) return;

      state.rows = append ? state.rows.concat(decorated) : decorated;
      state.cursor = page.cursor;
      state.hasMore = page.hasMore;
      renderFeed();
    } catch (error) {
      if (!data.isCurrent(token)) return;
      console.error('Cloud Chabura feed failed.', error);
      els.feed.innerHTML = '';
      els.feed.appendChild(components.errorState({
        message: data.describeError(error),
        onRetry: () => loadFeed(),
      }));
      els.feedFooter.hidden = true;
      announce('The discussion feed failed to load.');
    } finally {
      state.loading = false;
    }
  }

  function renderEmpty(spec) {
    els.feed.innerHTML = '';
    els.feed.appendChild(components.emptyState(spec));
    els.feedFooter.hidden = true;
    announce(spec.title);
  }

  function renderFeed() {
    els.feed.innerHTML = '';

    if (!state.rows.length) {
      const activeTab = TABS.find((tab) => tab.id === state.scope);
      const filtered = Boolean(state.category || state.search || state.tractate);
      renderEmpty({
        title: filtered ? 'Nothing matches these filters' : `No discussions in ${activeTab ? activeTab.label : 'this view'} yet`,
        body: filtered
          ? 'Clearing the category or search will widen the results. Other views may still have discussions.'
          : 'Open a daf, select a passage, and start the first discussion here.',
        actionLabel: filtered ? 'Clear filters' : 'Open the interactive daf',
        onAction: filtered
          ? () => { state.category = ''; state.search = ''; state.tractate = ''; syncControls(); writeUrl(); loadFeed(); }
          : () => { location.href = '/browse/'; },
      });
      return;
    }

    const fragment = document.createDocumentFragment();
    state.rows.forEach((row) => {
      fragment.appendChild(components.threadCard(row, {
        threadHref,
        onToggleFollow: (target) => onToggleFollow(target),
        onToggleSaved: (target) => onToggleSaved(target),
      }));
    });
    els.feed.appendChild(fragment);

    els.feedFooter.hidden = !state.hasMore;
    announce(`${state.rows.length} discussion${state.rows.length === 1 ? '' : 's'} shown.`);
  }

  // Optimistic, reversed on failure -- and a signed-out reader is prompted at
  // the moment of action rather than being blocked from the page.
  async function onToggleFollow(row) {
    if (!signedIn()) return promptSignIn();
    const next = !row.isFollowed;
    row.isFollowed = next;
    renderFeed();
    try {
      await data.toggleFollow(row.id, next);
    } catch (error) {
      row.isFollowed = !next;
      renderFeed();
      announce(data.describeError(error));
    }
  }

  async function onToggleSaved(row) {
    if (!signedIn()) return promptSignIn();
    const next = !row.isSaved;
    row.isSaved = next;
    renderFeed();
    try {
      await data.toggleSaved(row.id, next);
    } catch (error) {
      row.isSaved = !next;
      renderFeed();
      announce(data.describeError(error));
    }
  }

  function promptSignIn() {
    const button = document.getElementById('signInButton');
    if (button) button.click();
    else announce('Sign in to do that.');
  }

  // --- Control wiring -----------------------------------------------------
  function setScope(scope) {
    if (state.scope === scope) return;
    state.scope = scope;
    renderTabs();
    renderRail();
    writeUrl();
    loadFeed();
  }

  function syncControls() {
    if (els.search) els.search.value = state.search;
    [els.category, els.categorySheet].filter(Boolean).forEach((select) => { select.value = state.category; });
  }

  function debounce(fn, wait) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }

  function wire() {
    const runSearch = debounce(() => {
      state.search = els.search.value;
      writeUrl(true);
      loadFeed();
    }, 300);
    els.search?.addEventListener('input', runSearch);

    [els.category, els.categorySheet].filter(Boolean).forEach((select) => {
      select.addEventListener('change', () => {
        state.category = select.value;
        syncControls();
        writeUrl();
        loadFeed();
      });
    });

    els.loadMore?.addEventListener('click', () => loadFeed({ append: true }));

    els.openFilters?.addEventListener('click', () => els.filterSheet?.showModal());
    els.closeFilters?.addEventListener('click', () => els.filterSheet?.close());
    els.filterSheet?.addEventListener('click', (event) => {
      if (event.target === els.filterSheet) els.filterSheet.close();
    });

    window.addEventListener('popstate', () => {
      readUrl();
      syncControls();
      renderTabs();
      renderRail();
      loadFeed();
    });

    // Re-render the personal views once the session resolves, and reload if
    // the reader signs in or out while the page is open.
    window.DafSyncAuth?.onChange(() => {
      renderTabs();
      renderRail();
      loadFeed();
    });
  }

  async function init() {
    cacheEls();
    if (!els.feed) return; // not the Cloud Chabura page
    readUrl();
    populateCategorySelects();
    syncControls();
    renderTabs();
    renderRail();
    writeUrl(true);

    const ref = await loadTodayRef();
    if (ref) {
      state.todayRef = ref;
      if (!state.todayRefKey) state.todayRefKey = ref.replace(/\s+/g, '-');
    }
    renderToday();

    wire();
    loadFeed();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
