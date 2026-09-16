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
    // The full last-opened document row ({ id, title, visibility, file_path,
    // ... }) -- kept for the share dialog and the download button, which need
    // more than the bare id above already tracks.
    openDocument: null,
    // True only for a document opened via openSharedDocument (a ?doc= link),
    // mirroring kuntras.js's own readOnly flag exactly: suppresses Share/
    // Rename/Delete, whatever the viewer's relationship to the document.
    // Never true for a document reached via openDocument, even a published
    // one -- opening your OWN document from your own list always goes
    // through that path.
    readOnly: false,
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
      'mnDocDialog', 'mnDocClose', 'mnDocMeta', 'mnDocTitle', 'mnDocVisibility', 'mnDocText',
      'mnDocDownload', 'mnDocShare', 'mnDocRename', 'mnDocDelete', 'mnDocCitations', 'mnDocCitationsList',
      'mnDocShareDialog', 'mnDocShareClose', 'mnDocShareError',
      'mnDocShareLinkRow', 'mnDocShareLinkInput', 'mnDocShareCopyButton', 'mnDocShareCopyStatus',
      'mnPublicDocsSection', 'mnPublicDocsSearch', 'mnPublicDocsFeed',
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
    // Public documents sit alongside the reader's own, on the Documents tab
    // only -- and works signed out too, unlike mnFeed above it (see "Public
    // documents" below).
    if (els.mnPublicDocsSection) {
      els.mnPublicDocsSection.hidden = onNotes;
      if (!onNotes) loadPublicDocuments();
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

  const SOURCE_LABELS = { paste: 'Pasted', txt: 'Text file', md: 'Markdown', docx: 'Word', pdf: 'PDF' };

  // Mirrors kuntras.js's own VISIBILITY_LABELS/visibilityChip exactly -- the
  // same three-state model, now shared by documents too (see
  // 20260916160000_document_sharing.sql).
  const VISIBILITY_LABELS = { private: ['Private', 'cc-chip-private'], unlisted: ['Unlisted', 'cc-chip-shared'], public: ['Public', 'cc-chip-answered'] };
  function visibilityChip(visibility) {
    const [label, variant] = VISIBILITY_LABELS[visibility] || VISIBILITY_LABELS.private;
    return ui.chip(label, variant);
  }

  function documentCard(row) {
    const card = ui.el('article', 'cc-card');
    card.dataset.id = row.id;
    card.dataset.kind = 'document';

    const top = ui.el('div', 'cc-card-top');
    top.appendChild(ui.chip(SOURCE_LABELS[row.source_kind] || row.source_kind, 'cc-chip-daf'));
    top.appendChild(visibilityChip(row.visibility));
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

  // Shared by openDocument (the owner's own path) and openSharedDocument (a
  // ?doc= link to someone else's published document) -- every action button
  // here exists only to CHANGE the document, so a read-only visitor gets
  // none of them, and the owner gets them all back the moment they open
  // their own document the normal way, however it was left after a
  // previous read-only visit earlier in the same page session.
  function applyDocChrome() {
    const editable = !state.readOnly;
    els.mnDocShare.hidden = !editable;
    els.mnDocRename.hidden = !editable;
    els.mnDocDelete.hidden = !editable;
  }

  function renderOpenDocument(doc) {
    state.openDocumentId = doc.id;
    state.openDocument = doc;
    els.mnDocTitle.textContent = doc.title;
    els.mnDocMeta.textContent = `${SOURCE_LABELS[doc.source_kind] || doc.source_kind}`
      + (doc.original_filename ? ` · ${doc.original_filename}` : '');
    els.mnDocVisibility.innerHTML = '';
    els.mnDocVisibility.appendChild(visibilityChip(doc.visibility));
    els.mnDocDownload.hidden = !doc.file_path;
    // textContent, not innerHTML: an imported document is arbitrary text
    // the reader supplied, and it is rendered in a <pre> that preserves its
    // own line breaks. Nothing here is ever interpreted as markup.
    els.mnDocText.textContent = doc.full_text;
    applyDocChrome();
    els.mnDocDialog.showModal();
    // After showModal, not before: the document itself is the point of
    // opening the reader, and it should not wait on a second round trip
    // for a list that is empty for most documents. Skipped entirely in
    // read-only mode: fetchDocumentCitations is scoped to the CURRENT
    // VIEWER's own notes, so it would naturally come back empty for anyone
    // but the owner, but the "Quoted on" section is gated explicitly here
    // rather than relying on that.
    if (state.readOnly) {
      els.mnDocCitations.hidden = true;
    } else {
      renderCitations(doc.id);
    }
  }

  async function openDocument(id) {
    state.readOnly = false;
    try {
      const doc = await data.fetchDocument(id);
      if (!doc) { announce('That document is no longer available.'); return; }
      renderOpenDocument(doc);
    } catch (error) {
      announce(data.describeError(error));
    }
  }

  // A ?doc=<id> link: read-only, and not scoped to the signed-in reader's
  // own documents at all -- fetchPublicDocument carries no owner filter,
  // mirroring kuntras.js's own openSharedKuntras. Anyone (including signed
  // out) may land here; the database's own note_documents_public_read
  // policy is what actually decides whether anything comes back.
  async function openSharedDocument(id) {
    state.readOnly = true;
    try {
      const doc = await data.fetchPublicDocument(id);
      if (!doc) {
        announce('This document is not available. It may be private, or the link may no longer be valid.');
        return;
      }
      renderOpenDocument(doc);
    } catch (error) {
      announce(data.describeError(error));
    }
  }

  async function onDownloadDocument() {
    if (!state.openDocument || !state.openDocument.file_path) return;
    try {
      const url = await data.getDocumentDownloadUrl(state.openDocument.file_path);
      window.open(url, '_blank', 'noopener');
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

  // --- Sharing --------------------------------------------------------------
  //
  // private/unlisted/public IS the whole sharing model here too -- there is
  // no separate "publish" step distinct from picking one of the three (see
  // 20260916160000's own header). The link shown for unlisted/public is just
  // this page's own URL with ?doc=<id> -- the same query param
  // openSharedDocument reads on load, so copying it and opening it in
  // another browser (or signed out) is the entire "share" feature. Mirrors
  // kuntras.js's own knShareDialog wiring exactly.

  function shareLinkFor(id) {
    const url = new URL(location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('doc', id);
    return url.toString();
  }

  function updateShareDialog() {
    if (!state.openDocument) return;
    const visibility = state.openDocument.visibility;
    els.mnDocShareDialog.querySelectorAll('input[name="mnDocShareVisibility"]').forEach((input) => {
      input.checked = input.value === visibility;
    });
    const shared = visibility !== 'private';
    els.mnDocShareLinkRow.hidden = !shared;
    if (shared) {
      els.mnDocShareLinkInput.value = shareLinkFor(state.openDocument.id);
      els.mnDocShareCopyStatus.textContent = '';
    }
  }

  function openShareDialog() {
    els.mnDocShareError.hidden = true;
    updateShareDialog();
    els.mnDocShareDialog.showModal();
  }

  async function onShareVisibilityChange(event) {
    const visibility = event.target.value;
    els.mnDocShareError.hidden = true;
    try {
      await data.updateDocumentVisibility(state.openDocument.id, visibility);
      state.openDocument.visibility = visibility;
      els.mnDocVisibility.innerHTML = '';
      els.mnDocVisibility.appendChild(visibilityChip(visibility));
      updateShareDialog();
      // Keeps the card underneath in sync, same as renameOpenDocument and
      // deleteOpenDocument already do for their own mutations -- without
      // this the list would still show the visibility the document had
      // when it was first loaded, until some unrelated action reloaded it.
      load();
    } catch (error) {
      els.mnDocShareError.textContent = data.describeError(error);
      els.mnDocShareError.hidden = false;
      updateShareDialog(); // revert the radio selection to what actually saved
    }
  }

  async function onCopyShareLink() {
    els.mnDocShareCopyStatus.textContent = '';
    try {
      await navigator.clipboard.writeText(els.mnDocShareLinkInput.value);
      els.mnDocShareCopyStatus.textContent = 'Copied.';
    } catch {
      // Clipboard access can be refused (permissions, insecure context, an
      // older browser with no navigator.clipboard at all) -- the link is
      // already selected and visible in a plain text input either way, so a
      // manual copy still works without this button.
      els.mnDocShareLinkInput.select();
      els.mnDocShareCopyStatus.textContent = 'Could not copy automatically -- the link is selected, so Ctrl/Cmd+C will still work.';
    }
  }

  // --- Public documents -------------------------------------------------
  //
  // Offered on the SAME Documents tab as "my documents", not a separate view
  // -- unlike the reader's own list, this one works signed out too
  // (fetchPublicDocuments carries no currentUser() gate). Mirrors
  // kuntras.js's own publicKuntrasCard/loadPublicKuntrasim, including the
  // lack of a loading-generation guard: a stale response landing after a
  // newer one is a self-correcting glitch fixed by the next keystroke, not a
  // race worth a token for.

  function publicDocumentCard(row) {
    const card = ui.el('article', 'cc-card');
    card.dataset.id = row.id;

    const top = ui.el('div', 'cc-card-top');
    top.appendChild(ui.chip(SOURCE_LABELS[row.source_kind] || row.source_kind, 'cc-chip-daf'));
    card.appendChild(top);

    const title = ui.el('h3', 'cc-card-title');
    const open = ui.el('a', null, row.title);
    open.href = `?doc=${encodeURIComponent(row.id)}`;
    title.appendChild(open);
    card.appendChild(title);

    if (row.preview) {
      const body = ui.el('p', 'cc-card-body', row.preview);
      card.appendChild(body);
    }

    const meta = ui.el('div', 'cc-card-meta');
    const time = ui.el('time', null, `Edited ${fmt().formatNoteTime(row.updated_at)}`);
    const exact = new Date(row.updated_at);
    if (!Number.isNaN(exact.getTime())) {
      time.dateTime = exact.toISOString();
      time.title = exact.toLocaleString();
    }
    meta.appendChild(time);
    card.appendChild(meta);

    return card;
  }

  async function loadPublicDocuments() {
    if (!els.mnPublicDocsFeed) return;
    els.mnPublicDocsFeed.innerHTML = '';
    els.mnPublicDocsFeed.appendChild(ui.loadingState(3));
    const search = (els.mnPublicDocsSearch?.value || '').trim();
    try {
      const rows = await data.fetchPublicDocuments({ search });
      els.mnPublicDocsFeed.innerHTML = '';
      if (!rows.length) {
        els.mnPublicDocsFeed.appendChild(ui.emptyState({
          title: search ? 'No public document matches that.' : 'No public documents yet',
          body: search ? '' : 'When a reader publishes one, it appears here for anyone to browse.',
        }));
        return;
      }
      rows.forEach((row) => els.mnPublicDocsFeed.appendChild(publicDocumentCard(row)));
    } catch (error) {
      els.mnPublicDocsFeed.innerHTML = '';
      els.mnPublicDocsFeed.appendChild(ui.errorState({
        title: 'Could not load public documents',
        message: data.describeError(error),
        onRetry: loadPublicDocuments,
      }));
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

  // The parsers are an ES module (pdf.js is one, and this has to import it),
  // loaded on demand: a reader who only ever pastes text never downloads a
  // PDF engine. See note-import-parsers.mjs for why no file is ever stored.
  let parsersPromise = null;
  function loadParsers() {
    if (!parsersPromise) parsersPromise = import('/note-import-parsers.mjs');
    return parsersPromise;
  }

  // A SEPARATE, much larger ceiling from MAX_DOCUMENT_BYTES, because for a
  // .docx or a PDF the two measure different things. Bytes on disk are a fair
  // proxy for bytes of text in a .txt, and a bad one here: a Word file with
  // one embedded photograph is megabytes of image around a few kilobytes of
  // prose, and refusing it on its file size would reject documents that
  // import perfectly. So the file size is only a "do not pull this into
  // memory" guard; what actually has to fit in note_documents is the
  // EXTRACTED TEXT, which is checked after parsing like any other import.
  const MAX_SOURCE_FILE_BYTES = 25 * 1024 * 1024;

  function importStatus(message) {
    els.mnImportSize.classList.remove('over');
    els.mnImportSize.textContent = message;
  }

  async function onImportFileChosen() {
    const file = els.mnImportFile.files && els.mnImportFile.files[0];
    if (!file) return;
    els.mnImportError.hidden = true;

    const { sourceKindForFilename, BINARY_KINDS, extractText, ImportParseError } = await loadParsers();
    const kind = sourceKindForFilename(file.name);
    const isBinary = BINARY_KINDS.has(kind);

    const ceiling = isBinary ? MAX_SOURCE_FILE_BYTES : data.MAX_DOCUMENT_BYTES;
    if (file.size > ceiling) {
      importError(isBinary
        ? `That file is ${Math.round(file.size / (1024 * 1024))} MB, which is too large to open in the browser. `
          + 'Split it into parts and import them separately.'
        : `That file is ${Math.round(file.size / 1024)} KB. The limit is `
          + `${Math.round(data.MAX_DOCUMENT_BYTES / 1024)} KB — split it into parts and import them separately.`);
      els.mnImportFile.value = '';
      return;
    }

    // Reading a long PDF is genuinely slow -- seconds, sometimes more -- and
    // a dialog that simply sits there looks broken. The page count is known
    // only once pdf.js has opened the file, so the first message cannot
    // promise one.
    els.mnImportSubmit.disabled = true;
    importStatus(isBinary ? `Reading ${file.name}…` : '');
    try {
      const text = await extractText(file, {
        onProgress: (page, total) => importStatus(`Reading page ${page} of ${total}…`),
      });
      els.mnImportText.value = text;
      if (!els.mnImportTitle.value.trim()) {
        els.mnImportTitle.value = file.name.replace(/\.(txt|md|markdown|docx|pdf)$/i, '').slice(0, 200);
      }
      els.mnImportFile.dataset.kind = kind;
      els.mnImportFile.dataset.filename = file.name;
      // What the file actually contained, so onImportSubmit can tell whether
      // the text being submitted is still the file's or has since been
      // replaced by hand.
      els.mnImportFile.dataset.loadedText = text;
      refreshImportSize();
    } catch (error) {
      // ImportParseError messages are written for the reader and say what to
      // do about it -- a password-protected PDF, a scan with no text layer, a
      // .doc renamed to .docx. Anything else is a surprise and gets a generic
      // message rather than an internal one.
      importStatus('');
      importError(error instanceof ImportParseError
        ? error.message
        : 'That file could not be read. It may be damaged, or not the format its name suggests.');
      els.mnImportFile.value = '';
      delete els.mnImportFile.dataset.kind;
      delete els.mnImportFile.dataset.filename;
      delete els.mnImportFile.dataset.loadedText;
    } finally {
      els.mnImportSubmit.disabled = false;
      // The reader may have typed over the extracted text while a long PDF
      // was still parsing; refreshImportSize is the authority on whether
      // Import can be pressed, so it has the last word.
      refreshImportSize();
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
    const kind = fromFile ? els.mnImportFile.dataset.kind : 'paste';
    // Only docx/pdf have an ORIGINAL worth keeping beyond their extracted
    // text -- a pasted, .txt or .md "original" would just be the same text
    // again, so there is nothing to upload for those (see
    // 20260916160000_document_sharing.sql's own header).
    const keepOriginal = fromFile && (kind === 'docx' || kind === 'pdf');
    els.mnImportSubmit.disabled = true;
    try {
      await data.createDocument({
        title,
        sourceKind: kind,
        originalFilename: fromFile ? els.mnImportFile.dataset.filename : null,
        fullText,
        file: keepOriginal ? els.mnImportFile.files[0] : null,
        fileExtension: keepOriginal ? kind : null,
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
    els.mnDocDownload?.addEventListener('click', onDownloadDocument);
    els.mnDocShare?.addEventListener('click', openShareDialog);
    els.mnDocRename?.addEventListener('click', renameOpenDocument);
    els.mnDocDelete?.addEventListener('click', deleteOpenDocument);

    els.mnDocShareClose?.addEventListener('click', () => els.mnDocShareDialog.close());
    els.mnDocShareDialog?.querySelectorAll('input[name="mnDocShareVisibility"]').forEach((input) => {
      input.addEventListener('change', onShareVisibilityChange);
    });
    els.mnDocShareCopyButton?.addEventListener('click', onCopyShareLink);

    let publicDocsSearchTimer = null;
    els.mnPublicDocsSearch?.addEventListener('input', () => {
      clearTimeout(publicDocsSearchTimer);
      publicDocsSearchTimer = setTimeout(loadPublicDocuments, 250);
    });

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
    // Read BEFORE writeUrl(true) below: that call rewrites location.search
    // from state's own filter fields (tab/tractate/category/visibility/q)
    // only, which do not include `doc` -- so reading it any later would see
    // the already-stripped URL and silently never open the shared dialog.
    const sharedDocId = new URLSearchParams(location.search).get('doc');
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

    // ?doc=<id> opens that document read-only over whatever the page
    // underneath is showing, regardless of who is signed in or whether they
    // own it -- see openSharedDocument's own header. Every other way of
    // reaching /notes/ leaves the dialog closed until a card is clicked.
    if (sharedDocId) openSharedDocument(sharedDocId);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
