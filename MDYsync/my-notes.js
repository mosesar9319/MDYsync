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

  const TABS = [
    { id: 'notes', label: 'Notes' },
    { id: 'documents', label: 'Documents' },
  ];

  const state = {
    tab: 'notes',
    tractate: '',
    category: '',
    visibility: '',
    search: '',
    cursor: null,
    hasMore: false,
    loading: false,
    loadedOnce: false,
    openDocumentId: null,
  };

  const els = {};

  function cacheEls() {
    [
      'mnFeed', 'mnFeedFooter', 'mnLoadMore', 'mnStatus', 'mnSearch',
      'mnCategory', 'mnCategorySheet', 'mnVisibility', 'mnVisibilitySheet',
      'mnTractateNav', 'mnOpenFilters', 'mnCloseFilters', 'mnFilterSheet',
      'mnTabs', 'mnFilterRail', 'mnMobileFilterBar',
      'mnImportButton', 'mnImportDialog', 'mnImportClose', 'mnImportForm',
      'mnImportTitle', 'mnImportFile', 'mnImportText', 'mnImportSize', 'mnImportError',
      'mnImportSubmit',
      'mnDocDialog', 'mnDocClose', 'mnDocMeta', 'mnDocTitle', 'mnDocText',
      'mnDocRename', 'mnDocDelete', 'mnDocCitations', 'mnDocCitationsList',
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
    state.tab = params.get('tab') === 'documents' ? 'documents' : 'notes';
    state.tractate = params.get('tractate') || '';
    state.category = params.get('category') || '';
    state.visibility = params.get('visibility') || '';
    state.search = params.get('q') || '';
  }

  function writeUrl(replace) {
    const params = new URLSearchParams();
    if (state.tab !== 'notes') params.set('tab', state.tab);
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

  function renderTabs() {
    if (!els.mnTabs) return;
    els.mnTabs.innerHTML = '';
    TABS.forEach((tab) => {
      const button = ui.el('button', 'cc-tab', tab.label);
      button.type = 'button';
      button.id = `mn-tab-${tab.id}`;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(state.tab === tab.id));
      button.addEventListener('click', () => {
        if (state.tab === tab.id) return;
        state.tab = tab.id;
        state.cursor = null;
        syncTabChrome();
        writeUrl(false);
        load();
      });
      els.mnTabs.appendChild(button);
    });
  }

  // The masechta/category/visibility filters describe notes and mean nothing
  // for a document, so they are hidden rather than left present and inert.
  // Search stays available on both tabs -- it just searches a different
  // column (see fetchMyDocuments).
  function syncTabChrome() {
    renderTabs();
    const onNotes = state.tab === 'notes';
    if (els.mnFilterRail) els.mnFilterRail.hidden = !onNotes;
    // Hiding the rail removes it from the grid, so the shell has to be told
    // to stop reserving a column for it -- otherwise .cc-main lands in the
    // rail's own 240px slot and the cards render in a narrow strip.
    document.querySelector('.cc-shell')?.classList.toggle('no-rail', !onNotes);
    if (els.mnMobileFilterBar) els.mnMobileFilterBar.hidden = !onNotes;
    if (els.mnSearch) {
      els.mnSearch.placeholder = onNotes ? 'Search your notes…' : 'Search your documents…';
    }
    if (els.mnLoadMore) {
      els.mnLoadMore.textContent = onNotes ? 'Load more notes' : 'Load more documents';
    }
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

  const SOURCE_LABELS = { paste: 'Pasted', txt: 'Text file', md: 'Markdown' };

  function documentCard(row) {
    const card = ui.el('article', 'cc-card');
    card.dataset.id = row.id;
    card.dataset.kind = 'document';

    const top = ui.el('div', 'cc-card-top');
    top.appendChild(ui.chip(SOURCE_LABELS[row.source_kind] || row.source_kind, 'cc-chip-daf'));
    // Every document is private -- there is no way to make one public (see
    // the migration). Saying so on the card is the same reassurance the
    // Private chip gives a note.
    top.appendChild(ui.chip('Private', 'cc-chip-private'));
    card.appendChild(top);

    const title = ui.el('h3', 'cc-card-title');
    const open = ui.el('a', null, row.title);
    open.href = '#';
    open.addEventListener('click', (event) => {
      event.preventDefault();
      openDocument(row.id);
    });
    title.appendChild(open);
    card.appendChild(title);

    // `preview` is a generated column holding the first 300 characters, so
    // this renders without the list ever fetching the document itself.
    if (row.preview) {
      const body = ui.el('p', 'cc-card-body', row.preview);
      card.appendChild(body);
    }

    const meta = ui.el('div', 'cc-card-meta');
    const time = ui.el('time', null, fmt().formatNoteTime(row.created_at));
    const exact = new Date(row.created_at);
    if (!Number.isNaN(exact.getTime())) {
      time.dateTime = exact.toISOString();
      time.title = exact.toLocaleString();
    }
    meta.appendChild(time);
    if (row.original_filename) meta.appendChild(ui.el('span', null, row.original_filename));
    card.appendChild(meta);

    return card;
  }

  // --- Document reader ----------------------------------------------------

  async function openDocument(id) {
    try {
      const doc = await data.fetchDocument(id);
      if (!doc) { announce('That document is no longer available.'); return; }
      state.openDocumentId = doc.id;
      els.mnDocTitle.textContent = doc.title;
      els.mnDocMeta.textContent = `${SOURCE_LABELS[doc.source_kind] || doc.source_kind}`
        + (doc.original_filename ? ` · ${doc.original_filename}` : '');
      // textContent, not innerHTML: an imported document is arbitrary text
      // the reader supplied, and it is rendered in a <pre> that preserves its
      // own line breaks. Nothing here is ever interpreted as markup.
      els.mnDocText.textContent = doc.full_text;
      els.mnDocDialog.showModal();
      // After showModal, not before: the document itself is the point of
      // opening the reader, and it should not wait on a second round trip
      // for a list that is empty for most documents.
      renderCitations(doc.id);
    } catch (error) {
      announce(data.describeError(error));
    }
  }

  // "Quoted on": every daf this document has been excerpted onto. The reverse
  // of line_notes.source_document_id, and the one question the citation makes
  // answerable -- without it a document is a file you can read, with it it is
  // a file you can see the use of.
  async function renderCitations(documentId) {
    const section = els.mnDocCitations;
    const list = els.mnDocCitationsList;
    if (!section || !list) return;
    section.hidden = true;
    list.innerHTML = '';
    let rows = [];
    try {
      rows = await data.fetchDocumentCitations(documentId);
    } catch (error) {
      // A failure here must not take the document down with it: the reader
      // came to read the text, and it is already on screen.
      announce(data.describeError(error));
      return;
    }
    // The dialog may have been closed, or another document opened, while
    // this was in flight.
    if (state.openDocumentId !== documentId) return;
    if (!rows.length) return;

    rows.forEach((row) => {
      const href = dafHref(row);
      // A key that will not parse gets a plain list entry rather than a link
      // to nowhere -- dafHref returns null for exactly that case.
      const item = ui.el(href ? 'a' : 'div', 'cc-doc-citation');
      if (href) item.href = href;
      const where = ui.el('span', 'cc-doc-citation-daf', data.dafLabelFromKey(row.daf_ref_key));
      item.appendChild(where);
      // The note's own opening words, so a document quoted onto the same daf
      // twice gives the reader something to tell the two apart by.
      const excerpt = ui.el('span', 'cc-doc-citation-body', row.body.slice(0, 120));
      item.appendChild(excerpt);
      if (!row.is_private) item.appendChild(ui.chip('Shared', 'cc-chip-shared'));
      list.appendChild(item);
    });
    section.hidden = false;
  }

  async function renameOpenDocument() {
    const current = els.mnDocTitle.textContent;
    const next = window.prompt('Rename this document', current);
    if (next === null) return;
    const title = next.trim();
    if (!title) return;
    try {
      await data.renameDocument(state.openDocumentId, title);
      els.mnDocTitle.textContent = title;
      load();
    } catch (error) {
      announce(data.describeError(error));
    }
  }

  async function deleteOpenDocument() {
    if (!window.confirm('Delete this document? Your notes that quote it are not affected.')) return;
    try {
      await data.deleteDocument(state.openDocumentId);
      els.mnDocDialog.close();
      load();
    } catch (error) {
      announce(data.describeError(error));
    }
  }

  // --- Import -------------------------------------------------------------

  function describeSize(text) {
    const bytes = data.documentByteLength(text);
    const maxKb = Math.round(data.MAX_DOCUMENT_BYTES / 1024);
    // "0 KB of 500 KB" reads as though nothing was counted; anything that
    // rounds to zero is shown as "under 1 KB" instead.
    const size = bytes < 1024 ? 'under 1 KB' : `${Math.round(bytes / 1024)} KB`;
    return { bytes, label: `${size} of ${maxKb} KB`, tooBig: bytes > data.MAX_DOCUMENT_BYTES };
  }

  function refreshImportSize() {
    const { label, tooBig } = describeSize(els.mnImportText.value);
    els.mnImportSize.textContent = els.mnImportText.value ? label : '';
    els.mnImportSize.classList.toggle('over', tooBig);
    els.mnImportSubmit.disabled = tooBig;
  }

  function importError(message) {
    els.mnImportError.textContent = message;
    els.mnImportError.hidden = false;
  }

  async function onImportFileChosen() {
    const file = els.mnImportFile.files && els.mnImportFile.files[0];
    if (!file) return;
    els.mnImportError.hidden = true;
    // Checked before reading, so a huge file is refused without being pulled
    // into memory first. The text is re-measured after decoding too, since
    // bytes on disk and bytes of decoded text need not match.
    if (file.size > data.MAX_DOCUMENT_BYTES) {
      importError(`That file is ${Math.round(file.size / 1024)} KB. The limit is `
        + `${Math.round(data.MAX_DOCUMENT_BYTES / 1024)} KB — split it into parts and import them separately.`);
      els.mnImportFile.value = '';
      return;
    }
    try {
      els.mnImportText.value = await file.text();
      if (!els.mnImportTitle.value.trim()) {
        els.mnImportTitle.value = file.name.replace(/\.(txt|md|markdown)$/i, '').slice(0, 200);
      }
      els.mnImportFile.dataset.kind = /\.(md|markdown)$/i.test(file.name) ? 'md' : 'txt';
      els.mnImportFile.dataset.filename = file.name;
      // What the file actually contained, so onImportSubmit can tell whether
      // the text being submitted is still the file's or has since been
      // replaced by hand.
      els.mnImportFile.dataset.loadedText = els.mnImportText.value;
      refreshImportSize();
    } catch {
      importError('That file could not be read. It may not be plain text.');
    }
  }

  async function onImportSubmit(event) {
    event.preventDefault();
    els.mnImportError.hidden = true;

    const title = els.mnImportTitle.value.trim();
    const fullText = els.mnImportText.value;
    if (!title) { importError('Give this document a title.'); return; }
    if (!fullText.trim()) { importError('Paste some text, or choose a file.'); return; }

    const { tooBig, label } = describeSize(fullText);
    if (tooBig) {
      importError(`This is ${label}. Split it into parts and import them separately.`);
      return;
    }

    // A file only counts as the source if its text is still what is being
    // submitted -- if the reader picked a file and then replaced the text by
    // hand, this is a paste.
    const fromFile = els.mnImportFile.dataset.kind && els.mnImportFile.dataset.loadedText === fullText;
    els.mnImportSubmit.disabled = true;
    try {
      await data.createDocument({
        title,
        sourceKind: fromFile ? els.mnImportFile.dataset.kind : 'paste',
        originalFilename: fromFile ? els.mnImportFile.dataset.filename : null,
        fullText,
      });
      els.mnImportDialog.close();
      els.mnImportForm.reset();
      els.mnImportSize.textContent = '';
      delete els.mnImportFile.dataset.kind;
      delete els.mnImportFile.dataset.filename;
      delete els.mnImportFile.dataset.loadedText;
      state.tab = 'documents';
      state.cursor = null;
      syncTabChrome();
      writeUrl(false);
      load();
      announce('Document imported.');
    } catch (error) {
      importError(data.describeError(error));
    } finally {
      els.mnImportSubmit.disabled = false;
    }
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
      body: 'Your notes and imported documents are private to your account, so there is nothing to show until you sign in.',
    }));
    els.mnFeedFooter.hidden = true;
    if (els.mnTractateNav) els.mnTractateNav.innerHTML = '';
    if (els.mnImportButton) els.mnImportButton.hidden = true;
    announce('Sign in to see your notes.');
  }

  function showEmpty() {
    els.mnFeed.innerHTML = '';
    if (state.tab === 'documents') {
      els.mnFeed.appendChild(state.search.trim()
        ? ui.emptyState({
          title: 'No documents match that search',
          body: 'Try a different word, or clear the search box.',
        })
        : ui.emptyState({
          title: 'No documents yet',
          body: 'Bring in notes you already have — paste them in, or choose a .txt or .md file.',
          actionLabel: 'Import notes',
          onAction: () => els.mnImportDialog.showModal(),
        }));
      els.mnFeedFooter.hidden = true;
      announce(state.search.trim() ? 'No documents match that search.' : 'You have not imported any documents yet.');
      return;
    }
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

  // Both tabs share one feed element, one loading path and one race guard --
  // only the query and the card builder differ.
  function load({ append = false } = {}) {
    return state.tab === 'documents'
      ? loadPage({ append, fetch: (cursor) => data.fetchMyDocuments({ search: state.search.trim(), cursor }), card: documentCard })
      : loadPage({ append, fetch: (cursor) => data.fetchMyNotes({ filters: filters(), cursor }), card: noteCard });
  }

  async function loadPage({ append = false, fetch, card } = {}) {
    if (state.loading) return;
    state.loading = true;
    const token = data.nextGeneration();

    if (!append) {
      els.mnFeed.innerHTML = '';
      els.mnFeed.appendChild(ui.loadingState());
      els.mnFeedFooter.hidden = true;
    }

    try {
      const page = await fetch(append ? state.cursor : null);
      if (!data.isCurrent(token)) return; // a newer load already landed
      if (page.requiresSignIn) { showSignedOut(); return; }
      if (els.mnImportButton) els.mnImportButton.hidden = false;

      if (!append) els.mnFeed.innerHTML = '';
      if (!append && !page.rows.length) { showEmpty(); return; }

      const fragment = document.createDocumentFragment();
      page.rows.forEach((row) => fragment.appendChild(card(row)));
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
        onRetry: () => load(),
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
    load();
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
        load();
      }, 300);
    });

    [els.mnCategory, els.mnCategorySheet].forEach((select) => {
      select?.addEventListener('change', () => { state.category = select.value; onFiltersChanged(); });
    });
    [els.mnVisibility, els.mnVisibilitySheet].forEach((select) => {
      select?.addEventListener('change', () => { state.visibility = select.value; onFiltersChanged(); });
    });

    els.mnLoadMore?.addEventListener('click', () => load({ append: true }));
    els.mnOpenFilters?.addEventListener('click', () => els.mnFilterSheet?.showModal());
    els.mnCloseFilters?.addEventListener('click', () => els.mnFilterSheet?.close());

    els.mnImportButton?.addEventListener('click', () => {
      els.mnImportError.hidden = true;
      els.mnImportDialog.showModal();
    });
    els.mnImportClose?.addEventListener('click', () => els.mnImportDialog.close());
    els.mnImportFile?.addEventListener('change', onImportFileChosen);
    els.mnImportText?.addEventListener('input', refreshImportSize);
    els.mnImportForm?.addEventListener('submit', onImportSubmit);

    els.mnDocClose?.addEventListener('click', () => els.mnDocDialog.close());
    els.mnDocRename?.addEventListener('click', renameOpenDocument);
    els.mnDocDelete?.addEventListener('click', deleteOpenDocument);

    window.addEventListener('popstate', () => {
      readUrl();
      state.cursor = null;
      syncControls();
      syncTabChrome();
      load();
    });
  }

  function init() {
    cacheEls();
    if (!els.mnFeed) return; // not the My Notes page
    readUrl();
    populateCategorySelects();
    syncControls();
    syncTabChrome();
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
      load();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
