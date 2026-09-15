'use strict';

// My Notes controller: the signed-in reader's own notes from every daf, in
// one list.
//
// Until this page existed, a note was only reachable from the daf it was
// attached to -- there was no way to see everything you had written, which
// made the notes people accumulate effectively write-only. This is a pure
// read layer: no schema change, no new policy, no writes. Editing a note
// still happens where it always has, on the daf itself.
//
// Card rendering deliberately reuses chabura-components.js's own helpers
// (el/chip/categoryChip/displayTitle/bodyPreview) rather than copying them.
// The one thing it does NOT reuse is that file's dafLabel(), which turns a
// stored key straight into text with dashes swapped for spaces -- that reads
// as "Hebrew Chazarah Daf Chullin 89a" here. my-notes-data.js decodes the
// prefixes properly instead.

(function () {
  const data = window.DafSyncMyNotes.data;
  const ui = window.DafSyncChabura.components;
  const fmt = () => window.DafNotesFormat;

  const state = {
    tractate: '',
    category: '',
    visibility: '',
    search: '',
    cursor: null,
    hasMore: false,
    loading: false,
    loadedOnce: false,
  };

  const els = {};

  function cacheEls() {
    [
      'mnFeed', 'mnFeedFooter', 'mnLoadMore', 'mnStatus', 'mnSearch',
      'mnCategory', 'mnCategorySheet', 'mnVisibility', 'mnVisibilitySheet',
      'mnTractateNav', 'mnOpenFilters', 'mnCloseFilters', 'mnFilterSheet',
    ].forEach((id) => { els[id] = document.getElementById(id); });
  }

  function announce(message) {
    if (els.mnStatus) els.mnStatus.textContent = message;
  }

  // --- URL state ----------------------------------------------------------
  // Filters live in the query string so a filtered view survives a reload and
  // the back button, the same way /chaburah/ carries its own feed state.

  function readUrl() {
    const params = new URLSearchParams(location.search);
    state.tractate = params.get('tractate') || '';
    state.category = params.get('category') || '';
    state.visibility = params.get('visibility') || '';
    state.search = params.get('q') || '';
  }

  function writeUrl(replace) {
    const params = new URLSearchParams();
    if (state.tractate) params.set('tractate', state.tractate);
    if (state.category) params.set('category', state.category);
    if (state.visibility) params.set('visibility', state.visibility);
    if (state.search) params.set('q', state.search);
    const query = params.toString();
    const url = query ? `${location.pathname}?${query}` : location.pathname;
    if (replace) history.replaceState(null, '', url);
    else history.pushState(null, '', url);
  }

  // --- Controls -----------------------------------------------------------

  function populateCategorySelects() {
    const options = ['<option value="">All categories</option>'].concat(
      (fmt().CATEGORY_TYPES || []).map(
        (type) => `<option value="${type.key}">${type.label}</option>`
      )
    ).join('');
    [els.mnCategory, els.mnCategorySheet].forEach((select) => {
      if (select) select.innerHTML = options;
    });
  }

  function syncControls() {
    if (els.mnSearch) els.mnSearch.value = state.search;
    [els.mnCategory, els.mnCategorySheet].forEach((select) => {
      if (select) select.value = state.category;
    });
    [els.mnVisibility, els.mnVisibilitySheet].forEach((select) => {
      if (select) select.value = state.visibility;
    });
  }

  // Matches /chaburah/'s own rail markup exactly -- a bare <button> inside
  // .cc-rail-nav, active state via aria-current (which is both what
  // chaburah.css styles and what a screen reader announces), and the count in
  // its own .cc-rail-count span rather than baked into the label text.
  function railButton(label, count, isActive, onClick) {
    const button = ui.el('button');
    button.type = 'button';
    if (isActive) button.setAttribute('aria-current', 'true');
    button.appendChild(ui.el('span', null, label));
    if (count !== null) button.appendChild(ui.el('span', 'cc-rail-count', count));
    button.addEventListener('click', onClick);
    return button;
  }

  function renderTractateNav(index) {
    if (!els.mnTractateNav) return;
    els.mnTractateNav.innerHTML = '';
    const total = index.reduce((sum, entry) => sum + entry.count, 0);
    els.mnTractateNav.appendChild(railButton('All masechtos', total, !state.tractate, () => {
      state.tractate = '';
      onFiltersChanged();
    }));
    index.forEach((entry) => {
      els.mnTractateNav.appendChild(railButton(
        entry.tractate,
        entry.count,
        state.tractate === entry.tractate,
        () => { state.tractate = entry.tractate; onFiltersChanged(); }
      ));
    });
  }

  // --- Cards --------------------------------------------------------------

  // Where this note lives on the daf. The variant/language prefixes are
  // dropped on purpose (see dafRefFromKey): they say which recording the note
  // was taken against, not which page of Shas it belongs to.
  function dafHref(row) {
    const ref = data.dafRefFromKey(row.daf_ref_key);
    if (!ref) return null;
    return `/browse/?ref=${encodeURIComponent(ref)}`;
  }

  function noteCard(row) {
    const card = ui.el('article', 'cc-card');
    card.dataset.id = row.id;
    card.dataset.dafRefKey = row.daf_ref_key || '';

    const top = ui.el('div', 'cc-card-top');
    const category = ui.categoryChip(row.category);
    if (category) top.appendChild(category);
    if (row.daf_ref_key) top.appendChild(ui.chip(data.dafLabelFromKey(row.daf_ref_key), 'cc-chip-daf'));
    // The visibility of a note is the single most important thing to be able
    // to see at a glance in a personal library -- it answers "did I share
    // this?" without opening anything.
    top.appendChild(ui.chip(row.is_private ? 'Private' : 'Shared', row.is_private ? 'cc-chip-private' : 'cc-chip-shared'));
    if (row.video_timestamp_seconds != null) {
      top.appendChild(ui.chip(`▶ ${fmt().formatTimestamp(row.video_timestamp_seconds)}`, 'cc-chip-video'));
    }
    // A note a moderator has hidden still belongs to its author and still
    // shows here -- saying so is more honest than quietly listing it as
    // though it were publicly visible.
    if (row.hidden) top.appendChild(ui.chip('Hidden by a moderator', 'cc-chip-locked'));
    card.appendChild(top);

    const title = ui.el('h3', 'cc-card-title');
    const href = dafHref(row);
    if (href) {
      const link = ui.el('a', null, ui.displayTitle(row));
      link.href = href;
      title.appendChild(link);
    } else {
      title.textContent = ui.displayTitle(row);
    }
    card.appendChild(title);

    if (row.selected_text) {
      const source = ui.el('p', 'cc-card-source', row.selected_text);
      source.lang = 'he';
      source.dir = 'rtl';
      card.appendChild(source);
    }

    const preview = ui.bodyPreview(row);
    if (preview) {
      const body = ui.el('p', 'cc-card-body');
      body.innerHTML = fmt().renderFormattedBody(preview);
      card.appendChild(body);
    }

    const meta = ui.el('div', 'cc-card-meta');
    const when = row.created_at;
    const time = ui.el('time', null, fmt().formatNoteTime(when));
    const exact = new Date(when);
    if (!Number.isNaN(exact.getTime())) {
      time.dateTime = exact.toISOString();
      time.title = exact.toLocaleString();
    }
    meta.appendChild(time);
    if (row.edited_at) meta.appendChild(ui.el('span', null, 'edited'));

    if (href) {
      const open = ui.el('a', 'cc-card-action', 'Open on the daf');
      open.href = href;
      meta.appendChild(open);
    }
    // Only a shared note has a public discussion to open; a private one has
    // no thread page to send anyone to.
    if (!row.is_private) {
      const thread = ui.el('a', 'cc-card-action', 'Open discussion');
      thread.href = `/chaburah/thread/?thread=${encodeURIComponent(row.id)}`;
      meta.appendChild(thread);
    }
    card.appendChild(meta);

    return card;
  }

  // --- Loading ------------------------------------------------------------

  function filters() {
    return {
      tractate: state.tractate,
      category: state.category,
      visibility: state.visibility,
      search: state.search.trim(),
    };
  }

  function hasAnyFilter() {
    return Boolean(state.tractate || state.category || state.visibility || state.search.trim());
  }

  function showSignedOut() {
    els.mnFeed.innerHTML = '';
    els.mnFeed.appendChild(ui.emptyState({
      title: 'Sign in to see your notes',
      body: 'Your notes are private to your account, so there is nothing to show until you sign in.',
    }));
    els.mnFeedFooter.hidden = true;
    if (els.mnTractateNav) els.mnTractateNav.innerHTML = '';
    announce('Sign in to see your notes.');
  }

  function showEmpty() {
    els.mnFeed.innerHTML = '';
    els.mnFeed.appendChild(hasAnyFilter()
      ? ui.emptyState({
        title: 'No notes match these filters',
        body: 'Try clearing a filter or searching for something else.',
        actionLabel: 'Clear filters',
        onAction: () => {
          state.tractate = ''; state.category = ''; state.visibility = ''; state.search = '';
          onFiltersChanged();
        },
      })
      : ui.emptyState({
        title: 'No notes yet',
        body: 'Open a daf, select a word or phrase, and write your first note — it will show up here.',
        actionLabel: 'Open a daf',
        onAction: () => { location.href = '/browse/'; },
      }));
    els.mnFeedFooter.hidden = true;
    announce(hasAnyFilter() ? 'No notes match these filters.' : 'You have not written any notes yet.');
  }

  async function loadNotes({ append = false } = {}) {
    if (state.loading) return;
    state.loading = true;
    const token = data.nextGeneration();

    if (!append) {
      els.mnFeed.innerHTML = '';
      els.mnFeed.appendChild(ui.loadingState());
      els.mnFeedFooter.hidden = true;
    }

    try {
      const page = await data.fetchMyNotes({ filters: filters(), cursor: append ? state.cursor : null });
      if (!data.isCurrent(token)) return; // a newer load already landed
      if (page.requiresSignIn) { showSignedOut(); return; }

      if (!append) els.mnFeed.innerHTML = '';
      if (!append && !page.rows.length) { showEmpty(); return; }

      const fragment = document.createDocumentFragment();
      page.rows.forEach((row) => fragment.appendChild(noteCard(row)));
      els.mnFeed.appendChild(fragment);

      state.cursor = page.cursor;
      state.hasMore = page.hasMore;
      els.mnFeedFooter.hidden = !page.hasMore;
      state.loadedOnce = true;
      announce(`${els.mnFeed.querySelectorAll('.cc-card').length} note${els.mnFeed.querySelectorAll('.cc-card').length === 1 ? '' : 's'} shown.`);
    } catch (error) {
      if (!data.isCurrent(token)) return;
      const message = data.describeError(error);
      els.mnFeed.innerHTML = '';
      els.mnFeed.appendChild(ui.errorState({
        title: 'Could not load your notes',
        message,
        onRetry: () => loadNotes(),
      }));
      els.mnFeedFooter.hidden = true;
      announce(message);
    } finally {
      state.loading = false;
    }
  }

  async function loadTractateIndex() {
    try {
      renderTractateNav(await data.fetchMyDafIndex());
    } catch {
      // The rail is an aid, not the content -- a failure here should not
      // replace the notes the reader came for with an error.
      renderTractateNav([]);
    }
  }

  function onFiltersChanged() {
    state.cursor = null;
    syncControls();
    writeUrl(false);
    loadTractateIndex();
    loadNotes();
  }

  // --- Wiring -------------------------------------------------------------

  function wire() {
    let searchTimer = null;
    els.mnSearch?.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.search = els.mnSearch.value;
        state.cursor = null;
        writeUrl(false);
        loadNotes();
      }, 300);
    });

    [els.mnCategory, els.mnCategorySheet].forEach((select) => {
      select?.addEventListener('change', () => { state.category = select.value; onFiltersChanged(); });
    });
    [els.mnVisibility, els.mnVisibilitySheet].forEach((select) => {
      select?.addEventListener('change', () => { state.visibility = select.value; onFiltersChanged(); });
    });

    els.mnLoadMore?.addEventListener('click', () => loadNotes({ append: true }));
    els.mnOpenFilters?.addEventListener('click', () => els.mnFilterSheet?.showModal());
    els.mnCloseFilters?.addEventListener('click', () => els.mnFilterSheet?.close());

    window.addEventListener('popstate', () => {
      readUrl();
      state.cursor = null;
      syncControls();
      loadNotes();
    });
  }

  function init() {
    cacheEls();
    if (!els.mnFeed) return; // not the My Notes page
    readUrl();
    populateCategorySelects();
    syncControls();
    writeUrl(true);
    wire();

    // onChange fires immediately with the current state once the initial
    // session check resolves, so this covers both "already signed in on load"
    // and "signed in/out while the page is open" without a separate first
    // load that would race it.
    window.DafSyncAuth.onChange((user) => {
      state.cursor = null;
      if (!user) { showSignedOut(); return; }
      loadTractateIndex();
      loadNotes();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
