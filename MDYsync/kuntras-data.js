'use strict';

// Kuntras Builder data layer -- every Supabase read/write the builder makes.
//
// Slice 1 only: kuntrasim, kuntras_sections and kuntras_entries with
// kind='freeform'. Nothing here reads from line_notes, note_documents or
// comments -- pulling in existing content is a later slice, once this shell
// has been proven the same way My Notes was (library, then import, then
// citation). Nothing here is ever public either: visibility is pinned to
// 'private' by the database's own insert/update policies, not merely by
// this file choosing not to send anything else, so a bug here cannot
// publish a kuntras before publishing exists.
//
// Built on window.DafSyncChabura.core exactly as my-notes-data.js is, for
// the same reason: /kuntras/ is a signed-in-only personal page, not the
// public feed, and sharing a base query with chaburah-data.js would risk
// the public feed inheriting a filter meant only for this one.

(function () {
  const { client, currentUser, describeError } = window.DafSyncChabura.core;
  const generation = window.DafSyncChabura.core.generations();

  const KUNTRAS_LIST_COLUMNS = ['id', 'title', 'visibility', 'created_at', 'updated_at'].join(', ');

  async function fetchMyKuntrasim() {
    const user = currentUser();
    if (!user) return { rows: [], requiresSignIn: true };
    const { data, error } = await client()
      .from('kuntrasim')
      .select(KUNTRAS_LIST_COLUMNS)
      .eq('owner_id', user.id)
      .is('deleted_at', null)
      .order('updated_at', { ascending: false });
    if (error) throw error;
    return { rows: data || [], requiresSignIn: false };
  }

  async function createKuntras(title) {
    const user = currentUser();
    if (!user) throw new Error('Sign in to build a kuntras.');
    const { data, error } = await client()
      .from('kuntrasim')
      .insert({ owner_id: user.id, title })
      .select('id')
      .single();
    if (error) throw error;
    return data;
  }

  async function renameKuntras(id, title) {
    const { error } = await client()
      .from('kuntrasim')
      .update({ title, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw error;
  }

  // Soft delete, matching note_documents. RLS confines this to the owner's
  // own row regardless, but the app never offers to delete anyone else's.
  async function deleteKuntras(id) {
    const { error } = await client()
      .from('kuntrasim')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw error;
  }

  // Fetches one kuntras plus its full tree in three queries (the kuntras
  // itself, all its sections, all its entries) rather than one query per
  // section -- a kuntras with twenty sections would otherwise cost twenty
  // round trips to render. The CALLER assembles the tree from the flat
  // section/entry lists (see buildTree in kuntras.js): sections and entries
  // both carry their own parent id, which is everything a client-side tree
  // build needs, and building it here would mean this file also owning the
  // UI's notion of what a "tree" looks like.
  async function fetchKuntrasTree(kuntrasId) {
    const [kuntras, sections, entries] = await Promise.all([
      client().from('kuntrasim').select(KUNTRAS_LIST_COLUMNS).eq('id', kuntrasId).maybeSingle(),
      client().from('kuntras_sections').select('id, parent_section_id, title, position')
        .eq('kuntras_id', kuntrasId).order('position', { ascending: true }),
      client().from('kuntras_entries').select('id, section_id, kind, title, body, position')
        .eq('kuntras_id', kuntrasId).order('position', { ascending: true }),
    ]);
    if (kuntras.error) throw kuntras.error;
    if (sections.error) throw sections.error;
    if (entries.error) throw entries.error;
    if (!kuntras.data) return null;
    return { kuntras: kuntras.data, sections: sections.data || [], entries: entries.data || [] };
  }

  // position for a new sibling: one past the current maximum in the group,
  // so a fresh section/entry lands at the end without renumbering anything
  // else. Local to the in-memory list already fetched, rather than a
  // separate query, since the builder always has the current tree loaded
  // before it lets the reader add to it.
  function nextPosition(rows, matchKey, matchValue) {
    const siblings = rows.filter((r) => r[matchKey] === matchValue);
    if (!siblings.length) return 0;
    return Math.max(...siblings.map((r) => r.position)) + 1;
  }

  async function createSection(kuntrasId, { parentSectionId = null, title, position }) {
    const { data, error } = await client()
      .from('kuntras_sections')
      .insert({ kuntras_id: kuntrasId, parent_section_id: parentSectionId, title, position })
      .select('id, parent_section_id, title, position')
      .single();
    if (error) throw error;
    return data;
  }

  async function renameSection(id, title) {
    const { error } = await client()
      .from('kuntras_sections')
      .update({ title, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw error;
  }

  // Cascades to every nested section and entry beneath it (the foreign keys
  // are all ON DELETE CASCADE) -- the confirmation this triggers in the UI
  // has to say so, since this can silently remove far more than the one row
  // the reader clicked delete on.
  async function deleteSection(id) {
    const { error } = await client().from('kuntras_sections').delete().eq('id', id);
    if (error) throw error;
  }

  // Reorders a set of SIBLINGS (same kuntras, same parent) to match the
  // array order given -- the client already knows the full new order (this
  // is how the up/down move controls work: swap two entries in the local
  // array, then persist the whole group), so this writes position 0..n-1 in
  // one batch rather than the caller computing a diff.
  async function reorderSections(orderedIds) {
    const updates = orderedIds.map((id, position) =>
      client().from('kuntras_sections').update({ position }).eq('id', id));
    const results = await Promise.all(updates);
    const failed = results.find((r) => r.error);
    if (failed) throw failed.error;
  }

  async function createEntry(kuntrasId, { sectionId = null, title = null, body, position }) {
    const { data, error } = await client()
      .from('kuntras_entries')
      .insert({ kuntras_id: kuntrasId, section_id: sectionId, kind: 'freeform', title, body, position })
      .select('id, section_id, kind, title, body, position')
      .single();
    if (error) throw error;
    return data;
  }

  async function updateEntry(id, { title, body }) {
    const { error } = await client()
      .from('kuntras_entries')
      .update({ title, body, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw error;
  }

  async function deleteEntry(id) {
    const { error } = await client().from('kuntras_entries').delete().eq('id', id);
    if (error) throw error;
  }

  async function reorderEntries(orderedIds) {
    const updates = orderedIds.map((id, position) =>
      client().from('kuntras_entries').update({ position }).eq('id', id));
    const results = await Promise.all(updates);
    const failed = results.find((r) => r.error);
    if (failed) throw failed.error;
  }

  window.DafSyncKuntras = window.DafSyncKuntras || {};
  window.DafSyncKuntras.data = {
    fetchMyKuntrasim,
    createKuntras,
    renameKuntras,
    deleteKuntras,
    fetchKuntrasTree,
    nextPosition,
    createSection,
    renameSection,
    deleteSection,
    reorderSections,
    createEntry,
    updateEntry,
    deleteEntry,
    reorderEntries,
    describeError,
    nextGeneration: () => generation.next(),
    isCurrent: (token) => generation.isCurrent(token),
  };
})();
