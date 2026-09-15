'use strict';

// Kuntras Builder controller: the library view (list your kuntrasim) and the
// builder view (edit one kuntras' tree of sections and entries).
//
// Slice 1 only -- freeform entries, private visibility. Reordering is up/down
// buttons rather than drag-and-drop: this schema's `position` column supports
// either (see kuntras-data.js's reorderSections/reorderEntries), so
// drag-and-drop can be added later without a migration; it is left out of
// this slice to avoid pulling in a drag library or hand-rolling pointer
// tracking for a first pass whose job is to prove the data model.

(function () {
  const { el, chip, emptyState, errorState, loadingState } = window.DafSyncChabura.components;
  const fmt = () => window.DafNotesFormat;

  const state = {
    view: 'library', // 'library' | 'builder'
    kuntrasim: [],
    openKuntras: null, // { id, title, visibility, created_at, updated_at }
    sections: [],
    entries: [],
    // Set while the entry dialog is open for an EXISTING entry; null while
    // adding a new one. Distinguishes "Save entry" meaning create vs update.
    editingEntryId: null,
    // Where a new entry (or the "Add subsection" action) should attach --
    // set by whichever button opened the dialog / ran the action, read back
    // when the form is submitted.
    pendingSectionId: null,
  };

  const els = {};
  function cacheEls() {
    [
      'knStatus', 'knLibrary', 'knFeed', 'knNewButton',
      'knBuilder', 'knBackButton', 'knBuilderTitle', 'knRenameButton', 'knDeleteButton',
      'knTree', 'knAddRootSection', 'knAddRootEntry',
      'knEntryDialog', 'knEntryClose', 'knEntryDialogTitle', 'knEntryForm',
      'knEntryTitle', 'knEntryBody', 'knEntrySize', 'knEntryError', 'knEntrySubmit',
    ].forEach((id) => { els[id] = document.getElementById(id); });
  }

  function announce(message) {
    if (els.knStatus) els.knStatus.textContent = message;
  }

  const data = () => window.DafSyncKuntras.data;

  // --- Library ---------------------------------------------------------

  function kuntrasCard(row) {
    const card = el('article', 'cc-card');
    card.dataset.id = row.id;

    const top = el('div', 'cc-card-top');
    // Every kuntras is private in this slice -- see the migration's own
    // comment on why visibility is pinned there, not merely defaulted here.
    top.appendChild(chip('Private', 'cc-chip-private'));
    card.appendChild(top);

    const title = el('h3', 'cc-card-title');
    const open = el('a', null, row.title);
    open.href = '#';
    open.addEventListener('click', (event) => {
      event.preventDefault();
      openKuntras(row.id);
    });
    title.appendChild(open);
    card.appendChild(title);

    const meta = el('div', 'cc-card-meta');
    const time = el('time', null, `Edited ${fmt().formatNoteTime(row.updated_at)}`);
    const exact = new Date(row.updated_at);
    if (!Number.isNaN(exact.getTime())) {
      time.dateTime = exact.toISOString();
      time.title = exact.toLocaleString();
    }
    meta.appendChild(time);
    card.appendChild(meta);

    return card;
  }

  async function loadLibrary() {
    const token = data().nextGeneration();
    els.knFeed.innerHTML = '';
    els.knFeed.appendChild(loadingState(3));
    try {
      const { rows, requiresSignIn } = await data().fetchMyKuntrasim();
      if (!data().isCurrent(token)) return;
      els.knFeed.innerHTML = '';
      if (requiresSignIn) {
        els.knFeed.appendChild(emptyState({
          title: 'Sign in to build a kuntras',
          body: 'Your kuntrasim are private to your account.',
        }));
        return;
      }
      state.kuntrasim = rows;
      if (!rows.length) {
        els.knFeed.appendChild(emptyState({
          title: 'No kuntrasim yet',
          body: 'Start one to begin assembling notes and writing into your own pamphlet.',
          actionLabel: 'New kuntras',
          onAction: onNewKuntras,
        }));
        return;
      }
      rows.forEach((row) => els.knFeed.appendChild(kuntrasCard(row)));
    } catch (error) {
      if (!data().isCurrent(token)) return;
      els.knFeed.innerHTML = '';
      els.knFeed.appendChild(errorState({
        title: 'Could not load your kuntrasim',
        message: data().describeError(error),
        onRetry: loadLibrary,
      }));
    }
  }

  async function onNewKuntras() {
    const title = window.prompt('Title for the new kuntras');
    if (title === null) return;
    const trimmed = title.trim();
    if (!trimmed) return;
    try {
      const created = await data().createKuntras(trimmed);
      await openKuntras(created.id);
    } catch (error) {
      announce(data().describeError(error));
      window.alert(data().describeError(error));
    }
  }

  // --- Switching views ---------------------------------------------------

  function showLibrary() {
    state.view = 'library';
    state.openKuntras = null;
    els.knLibrary.hidden = false;
    els.knBuilder.hidden = true;
    loadLibrary();
  }

  async function openKuntras(id) {
    try {
      const tree = await data().fetchKuntrasTree(id);
      if (!tree) { announce('That kuntras is no longer available.'); showLibrary(); return; }
      state.view = 'builder';
      state.openKuntras = tree.kuntras;
      state.sections = tree.sections;
      state.entries = tree.entries;
      els.knLibrary.hidden = true;
      els.knBuilder.hidden = false;
      els.knBuilderTitle.textContent = tree.kuntras.title;
      renderTree();
    } catch (error) {
      announce(data().describeError(error));
    }
  }

  async function refreshOpenKuntras() {
    if (!state.openKuntras) return;
    const tree = await data().fetchKuntrasTree(state.openKuntras.id);
    if (!tree) { showLibrary(); return; }
    state.sections = tree.sections;
    state.entries = tree.entries;
    renderTree();
  }

  // --- Tree rendering ------------------------------------------------------
  //
  // Rebuilt from the flat sections/entries arrays on every mutation, the
  // same "re-render the whole list from state" pattern renderNoteList uses --
  // simpler to get right than patching individual DOM nodes for a structure
  // whose shape (nesting, ordering) changes on nearly every action here.

  function childSections(parentId) {
    return state.sections
      .filter((s) => s.parent_section_id === parentId)
      .sort((a, b) => a.position - b.position);
  }

  function entriesIn(sectionId) {
    return state.entries
      .filter((e) => e.section_id === sectionId)
      .sort((a, b) => a.position - b.position);
  }

  function renderTree() {
    els.knTree.innerHTML = '';
    els.knTree.appendChild(renderLevel(null));
  }

  // Renders everything that lives directly at ONE level of the tree: the
  // entries with this section_id (entries come first, matching how a
  // section's own body already ordered them before this was generalized),
  // then the child sections with this parent_section_id. Called with null
  // for the top level (entries with no section, and root sections) and with
  // a section's own id for what nests under it -- the root level and every
  // section's body are otherwise the same kind of container, so one
  // function renders both instead of the top level silently dropping
  // whatever isn't inside a section.
  function renderLevel(sectionId) {
    const wrap = el('div', 'kn-level');
    const entries = entriesIn(sectionId);
    entries.forEach((entry, index) => wrap.appendChild(renderEntryNode(entry, entries, index)));
    const sections = childSections(sectionId);
    sections.forEach((section, index) => wrap.appendChild(renderSectionNode(section, sections, index)));
    return wrap;
  }

  function moveButtons(items, index, onMove) {
    const wrap = el('span', 'kn-move-buttons');
    const up = el('button', 'kn-icon-button', '↑');
    up.type = 'button';
    up.disabled = index === 0;
    up.setAttribute('aria-label', 'Move up');
    up.addEventListener('click', () => onMove(index, index - 1));
    const down = el('button', 'kn-icon-button', '↓');
    down.type = 'button';
    down.disabled = index === items.length - 1;
    down.setAttribute('aria-label', 'Move down');
    down.addEventListener('click', () => onMove(index, index + 1));
    wrap.append(up, down);
    return wrap;
  }

  async function moveSectionSiblings(siblings, from, to) {
    const reordered = siblings.slice();
    const [moved] = reordered.splice(from, 1);
    reordered.splice(to, 0, moved);
    try {
      await data().reorderSections(reordered.map((s) => s.id));
      await refreshOpenKuntras();
    } catch (error) {
      announce(data().describeError(error));
    }
  }

  async function moveEntrySiblings(siblings, from, to) {
    const reordered = siblings.slice();
    const [moved] = reordered.splice(from, 1);
    reordered.splice(to, 0, moved);
    try {
      await data().reorderEntries(reordered.map((e) => e.id));
      await refreshOpenKuntras();
    } catch (error) {
      announce(data().describeError(error));
    }
  }

  function renderSectionNode(section, siblings, index) {
    const node = el('div', 'kn-section');

    const head = el('div', 'kn-section-head');
    head.appendChild(moveButtons(siblings, index, (from, to) => moveSectionSiblings(siblings, from, to)));

    const title = el('h3', 'kn-section-title', section.title);
    head.appendChild(title);

    const actions = el('div', 'kn-section-actions');
    const renameBtn = el('button', 'cc-btn cc-btn-sm cc-btn-quiet', 'Rename');
    renameBtn.type = 'button';
    renameBtn.addEventListener('click', () => onRenameSection(section));
    const addSubBtn = el('button', 'cc-btn cc-btn-sm cc-btn-quiet', '+ Subsection');
    addSubBtn.type = 'button';
    addSubBtn.addEventListener('click', () => onAddSection(section.id));
    const addEntryBtn = el('button', 'cc-btn cc-btn-sm cc-btn-quiet', '+ Entry');
    addEntryBtn.type = 'button';
    addEntryBtn.addEventListener('click', () => openEntryDialog({ sectionId: section.id }));
    const deleteBtn = el('button', 'cc-btn cc-btn-sm cc-btn-quiet cc-btn-danger', 'Delete');
    deleteBtn.type = 'button';
    deleteBtn.addEventListener('click', () => onDeleteSection(section));
    actions.append(renameBtn, addSubBtn, addEntryBtn, deleteBtn);
    head.appendChild(actions);

    node.appendChild(head);

    const body = el('div', 'kn-section-body');
    body.appendChild(renderLevel(section.id));
    node.appendChild(body);

    return node;
  }

  function renderEntryNode(entry, siblings, index) {
    const node = el('div', 'kn-entry');
    const head = el('div', 'kn-entry-head');
    head.appendChild(moveButtons(siblings, index, (from, to) => moveEntrySiblings(siblings, from, to)));
    if (entry.title) head.appendChild(el('h4', 'kn-entry-title', entry.title));

    const actions = el('div', 'kn-entry-actions');
    const editBtn = el('button', 'cc-btn cc-btn-sm cc-btn-quiet', 'Edit');
    editBtn.type = 'button';
    editBtn.addEventListener('click', () => openEntryDialog({ sectionId: entry.section_id, entry }));
    const deleteBtn = el('button', 'cc-btn cc-btn-sm cc-btn-quiet cc-btn-danger', 'Delete');
    deleteBtn.type = 'button';
    deleteBtn.addEventListener('click', () => onDeleteEntry(entry));
    actions.append(editBtn, deleteBtn);
    head.appendChild(actions);
    node.appendChild(head);

    // Plain textContent: slice 1 offers no formatting toolbar for an entry's
    // body (unlike the note composer), so nothing here is ever more than
    // the text the reader actually typed -- there is no markup syntax to
    // render safely or unsafely in the first place.
    node.appendChild(el('p', 'kn-entry-body', entry.body));

    return node;
  }

  // --- Sections ------------------------------------------------------------

  async function onAddSection(parentSectionId) {
    const title = window.prompt('Section title');
    if (title === null) return;
    const trimmed = title.trim();
    if (!trimmed) return;
    try {
      const position = data().nextPosition(state.sections, 'parent_section_id', parentSectionId);
      await data().createSection(state.openKuntras.id, { parentSectionId, title: trimmed, position });
      await refreshOpenKuntras();
    } catch (error) {
      window.alert(data().describeError(error));
    }
  }

  async function onRenameSection(section) {
    const title = window.prompt('Rename section', section.title);
    if (title === null) return;
    const trimmed = title.trim();
    if (!trimmed) return;
    try {
      await data().renameSection(section.id, trimmed);
      await refreshOpenKuntras();
    } catch (error) {
      window.alert(data().describeError(error));
    }
  }

  function countUnder(sectionId) {
    // How much a delete would actually take with it -- every descendant
    // section (recursively) and every entry inside any of them, so the
    // confirmation can say a true number rather than "this section," which
    // understates what CASCADE actually removes.
    let sections = 0;
    let entries = entriesIn(sectionId).length;
    for (const child of childSections(sectionId)) {
      sections += 1;
      const nested = countUnder(child.id);
      sections += nested.sections;
      entries += nested.entries;
    }
    return { sections, entries };
  }

  async function onDeleteSection(section) {
    const { sections, entries } = countUnder(section.id);
    const parts = [];
    if (sections) parts.push(`${sections} nested section${sections === 1 ? '' : 's'}`);
    if (entries) parts.push(`${entries} entr${entries === 1 ? 'y' : 'ies'}`);
    const warning = parts.length ? ` This also removes ${parts.join(' and ')} inside it.` : '';
    if (!window.confirm(`Delete "${section.title}"?${warning}`)) return;
    try {
      await data().deleteSection(section.id);
      await refreshOpenKuntras();
    } catch (error) {
      window.alert(data().describeError(error));
    }
  }

  // --- Entries ---------------------------------------------------------

  function openEntryDialog({ sectionId, entry }) {
    state.pendingSectionId = sectionId;
    state.editingEntryId = entry ? entry.id : null;
    els.knEntryDialogTitle.textContent = entry ? 'Edit entry' : 'Add entry';
    els.knEntryTitle.value = entry?.title || '';
    els.knEntryBody.value = entry?.body || '';
    els.knEntryError.hidden = true;
    refreshEntrySize();
    els.knEntryDialog.showModal();
    els.knEntryBody.focus();
  }

  function refreshEntrySize() {
    const length = els.knEntryBody.value.length;
    els.knEntrySize.textContent = `${length} of 2000 characters`;
    els.knEntrySize.classList.toggle('over', length > 2000);
  }

  async function onEntrySubmit(event) {
    event.preventDefault();
    els.knEntryError.hidden = true;
    const title = els.knEntryTitle.value.trim() || null;
    const body = els.knEntryBody.value.trim();
    if (!body) {
      els.knEntryError.textContent = 'Write something before saving.';
      els.knEntryError.hidden = false;
      return;
    }
    if (body.length > 2000) {
      els.knEntryError.textContent = `That is ${body.length} characters; the limit is 2000.`;
      els.knEntryError.hidden = false;
      return;
    }
    els.knEntrySubmit.disabled = true;
    try {
      if (state.editingEntryId) {
        await data().updateEntry(state.editingEntryId, { title, body });
      } else {
        const position = data().nextPosition(state.entries, 'section_id', state.pendingSectionId);
        await data().createEntry(state.openKuntras.id, { sectionId: state.pendingSectionId, title, body, position });
      }
      els.knEntryDialog.close();
      await refreshOpenKuntras();
    } catch (error) {
      els.knEntryError.textContent = data().describeError(error);
      els.knEntryError.hidden = false;
    } finally {
      els.knEntrySubmit.disabled = false;
    }
  }

  async function onDeleteEntry(entry) {
    if (!window.confirm('Delete this entry?')) return;
    try {
      await data().deleteEntry(entry.id);
      await refreshOpenKuntras();
    } catch (error) {
      window.alert(data().describeError(error));
    }
  }

  // --- Kuntras-level actions ---------------------------------------------

  async function onRenameKuntras() {
    const title = window.prompt('Rename this kuntras', state.openKuntras.title);
    if (title === null) return;
    const trimmed = title.trim();
    if (!trimmed) return;
    try {
      await data().renameKuntras(state.openKuntras.id, trimmed);
      state.openKuntras.title = trimmed;
      els.knBuilderTitle.textContent = trimmed;
    } catch (error) {
      window.alert(data().describeError(error));
    }
  }

  async function onDeleteKuntras() {
    if (!window.confirm(`Delete "${state.openKuntras.title}"? This removes every section and entry inside it.`)) return;
    try {
      await data().deleteKuntras(state.openKuntras.id);
      showLibrary();
    } catch (error) {
      window.alert(data().describeError(error));
    }
  }

  // --- Init ----------------------------------------------------------------

  function init() {
    cacheEls();
    if (!els.knLibrary) return; // page doesn't ship the builder UI

    els.knNewButton.addEventListener('click', onNewKuntras);
    els.knBackButton.addEventListener('click', showLibrary);
    els.knRenameButton.addEventListener('click', onRenameKuntras);
    els.knDeleteButton.addEventListener('click', onDeleteKuntras);
    els.knAddRootSection.addEventListener('click', () => onAddSection(null));
    els.knAddRootEntry.addEventListener('click', () => openEntryDialog({ sectionId: null }));

    els.knEntryClose.addEventListener('click', () => els.knEntryDialog.close());
    els.knEntryForm.addEventListener('submit', onEntrySubmit);
    els.knEntryBody.addEventListener('input', refreshEntrySize);

    window.DafSyncAuth?.onChange(() => {
      if (state.view === 'library') loadLibrary();
    });

    showLibrary();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
