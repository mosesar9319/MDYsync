'use strict';

// My Notes data layer: every Supabase read the personal notes library makes.
//
// Deliberately separate from chabura-data.js even though both read
// line_notes: that file's baseFeedQuery hard-codes `is_private = false` and
// `hidden = false` because it serves the PUBLIC feed. This one serves the
// signed-in reader their OWN notes -- private ones included -- so the two
// can never share a base query without one of them growing a flag that
// silently decides whether private rows ship to the browser. Keeping them
// apart means the public feed cannot accidentally be handed a query that
// omits that filter.
//
// No new tables, columns or policies: line_notes_author_read_own
// (`auth.uid() = author_id`) already returns every note its author wrote,
// private or not, so this is a pure read layer over data that already
// exists.

(function () {
  const PAGE_SIZE = 20;

  const { client, currentUser, describeError } = window.DafSyncChabura.core;
  const generation = window.DafSyncChabura.core.generations();

  // Explicit rather than '*', matching chabura-data.js's FEED_COLUMNS: a
  // column added later (or one that should never reach the browser) is then
  // an opt-in, not an automatic shipment.
  const NOTE_COLUMNS = [
    'id', 'daf_ref_key', 'segment_ref', 'title', 'body', 'category', 'source_document_id',
    'is_private', 'hidden', 'status', 'selected_text', 'start_word', 'end_word',
    'word_ranges', 'video_timestamp_seconds', 'created_at', 'edited_at',
    'last_activity_at',
  ].join(', ');

  // Decodes a stored daf_ref_key back into its parts. app.js's refKey() is
  // the encoder this must stay in lockstep with; shared/daf-key-parsing.mjs
  // does the same job server-side for the results branch's filenames (it is
  // an ES module, and these pages load classic scripts, hence this copy
  // rather than an import).
  //
  // Anchored on the TRAILING `-<daf><amud>` rather than splitting on the
  // first hyphen, because a slugified tractate contains hyphens of its own
  // ("Bava-Kamma", "Rosh-Hashanah"). That also means this needs no tractate
  // list to be correct, unlike the server-side parser.
  const REF_KEY_PATTERN = /^(?:Voice-)?(Hebrew-)?(Chazarah-Daf-)?(.+)-(\d+)([ab])$/;

  function parseDafRefKey(key) {
    const match = REF_KEY_PATTERN.exec(String(key || '').trim());
    if (!match) return null;
    return {
      language: match[1] ? 'he' : 'en',
      variant: match[2] ? 'chazarah' : 'regular',
      tractate: match[3].replace(/-/g, ' '),
      daf: Number(match[4]),
      amud: match[5],
    };
  }

  // The plain Sefaria-style ref the Interactive Daf's own ?ref= expects --
  // variant/language prefixes deliberately dropped, since those describe
  // which RECORDING the note was taken against, not which page of Shas it
  // belongs to. A note taken on the Hebrew Chazarah Daf of Chullin 89a is
  // still a note on Chullin 89a.
  function dafRefFromKey(key) {
    const parsed = parseDafRefKey(key);
    if (!parsed) return null;
    return `${parsed.tractate} ${parsed.daf}${parsed.amud}`;
  }

  // Human label for a note's origin, keeping the variant/language visible
  // (two notes on the same daf from the regular and Chazarah shiurim are
  // otherwise indistinguishable in a list).
  function dafLabelFromKey(key) {
    const parsed = parseDafRefKey(key);
    if (!parsed) return String(key || '').replace(/-/g, ' ');
    const variant = parsed.variant === 'chazarah' ? ' · Chazarah Daf' : '';
    const language = parsed.language === 'he' ? ' · Hebrew' : '';
    return `${parsed.tractate} ${parsed.daf}${parsed.amud}${variant}${language}`;
  }

  function baseQuery(userId, filters) {
    let query = client()
      .from('line_notes')
      .select(NOTE_COLUMNS)
      .eq('author_id', userId)
      .is('deleted_at', null);

    if (filters.category) query = query.eq('category', filters.category);
    if (filters.dafRefKey) query = query.eq('daf_ref_key', filters.dafRefKey);
    // daf_ref_key starts with an optional Hebrew-/Chazarah-Daf- prefix, so a
    // tractate filter cannot anchor at the start the way chabura-data.js's
    // can -- it matches the slug wherever the prefixes leave it.
    if (filters.tractate) {
      query = query.ilike('daf_ref_key', `%${filters.tractate.replace(/\s+/g, '-')}-%`);
    }
    if (filters.visibility === 'private') query = query.eq('is_private', true);
    if (filters.visibility === 'public') query = query.eq('is_private', false);
    if (filters.search) {
      query = query.textSearch('body_tsv', filters.search, { type: 'websearch', config: 'simple' });
    }
    return query;
  }

  // Keyset pagination on (created_at desc, id desc) -- newest first, which is
  // what a personal library wants by default. `line_notes_author_id_idx`
  // already narrows to one author before the sort, so no new index is needed
  // at the volumes a single person writes. A reader with tens of thousands of
  // notes would want a composite (author_id, created_at desc, id desc), which
  // is a migration and deliberately not part of this read-only change.
  function applyKeyset(query, cursor) {
    if (cursor) {
      query = query.or(
        `created_at.lt.${cursor.created_at},` +
        `and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`
      );
    }
    return query
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(PAGE_SIZE + 1);
  }

  function toPage(rows) {
    const list = rows || [];
    const hasMore = list.length > PAGE_SIZE;
    const page = hasMore ? list.slice(0, PAGE_SIZE) : list;
    const last = page[page.length - 1] || null;
    return {
      rows: page,
      hasMore,
      cursor: last ? { created_at: last.created_at, id: last.id } : null,
    };
  }

  async function fetchMyNotes({ filters = {}, cursor = null } = {}) {
    const user = currentUser();
    if (!user) return { rows: [], hasMore: false, cursor: null, requiresSignIn: true };
    const { data, error } = await applyKeyset(baseQuery(user.id, filters), cursor);
    if (error) throw error;
    return toPage(data);
  }

  // Every distinct daf the reader has written on, for the tractate/daf
  // filter. Reads only daf_ref_key (not whole rows) and counts client-side:
  // PostgREST has no GROUP BY, and a per-tractate count query would be one
  // round trip per tractate.
  async function fetchMyDafIndex() {
    const user = currentUser();
    if (!user) return [];
    const { data, error } = await client()
      .from('line_notes')
      .select('daf_ref_key')
      .eq('author_id', user.id)
      .is('deleted_at', null);
    if (error) throw error;
    const counts = new Map();
    for (const row of data || []) {
      const parsed = parseDafRefKey(row.daf_ref_key);
      const tractate = parsed ? parsed.tractate : (row.daf_ref_key || 'Unknown');
      counts.set(tractate, (counts.get(tractate) || 0) + 1);
    }
    return [...counts.entries()]
      .map(([tractate, count]) => ({ tractate, count }))
      .sort((a, b) => a.tractate.localeCompare(b.tractate));
  }

  // --- Imported documents --------------------------------------------------
  //
  // A document is NOT a note: line_notes.daf_ref_key and segment_ref are both
  // NOT NULL, so a note is by construction a note ON a passage, and an import
  // has no passage until the reader attaches it to one. Hence its own table.
  // See supabase/migrations/20260915150000_note_documents.sql.

  // Must match the octet_length ceiling on note_documents.full_text. Checked
  // here as well as there so an over-size import is refused with a sentence
  // the reader can act on, rather than surfacing as a raw 23514 constraint
  // violation.
  const MAX_DOCUMENT_BYTES = 512000;

  // Bytes, not characters: a Hebrew character costs two bytes in UTF-8, and
  // the database constraint counts bytes. Measuring characters here would
  // pass an import the server then rejects.
  function documentByteLength(text) {
    return new TextEncoder().encode(String(text || '')).length;
  }

  // Deliberately omits full_text: a list of twenty documents would otherwise
  // pull up to 10MB to render twenty excerpts. `preview` is a generated
  // column for exactly this. The reader fetches full_text for one document
  // only, on demand (see fetchDocument).
  const DOCUMENT_LIST_COLUMNS = [
    'id', 'title', 'source_kind', 'original_filename', 'preview',
    'created_at', 'updated_at',
  ].join(', ');

  async function fetchMyDocuments({ search = '', cursor = null } = {}) {
    const user = currentUser();
    if (!user) return { rows: [], hasMore: false, cursor: null, requiresSignIn: true };

    let query = client()
      .from('note_documents')
      .select(DOCUMENT_LIST_COLUMNS)
      .eq('owner_id', user.id)
      .is('deleted_at', null);
    if (search) {
      query = query.textSearch('full_text_tsv', search, { type: 'websearch', config: 'simple' });
    }
    if (cursor) {
      query = query.or(
        `created_at.lt.${cursor.created_at},` +
        `and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`
      );
    }
    const { data, error } = await query
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(PAGE_SIZE + 1);
    if (error) throw error;
    return toPage(data);
  }

  async function fetchDocument(id) {
    const user = currentUser();
    if (!user) return null;
    const { data, error } = await client()
      .from('note_documents')
      .select('id, title, source_kind, original_filename, full_text, created_at, updated_at')
      .eq('id', id)
      .eq('owner_id', user.id)
      .is('deleted_at', null)
      .maybeSingle();
    if (error) throw error;
    return data || null;
  }

  async function createDocument({ title, sourceKind, originalFilename = null, fullText }) {
    const user = currentUser();
    if (!user) throw new Error('Sign in to import a document.');
    const { data, error } = await client()
      .from('note_documents')
      .insert({
        owner_id: user.id,
        title,
        source_kind: sourceKind,
        original_filename: originalFilename,
        full_text: fullText,
      })
      .select('id')
      .single();
    if (error) throw error;
    return data;
  }

  async function renameDocument(id, title) {
    const user = currentUser();
    if (!user) throw new Error('Sign in to rename a document.');
    // updated_at is set here rather than by a trigger: this schema has no
    // updated_at trigger convention, and line_notes' own writers set it the
    // same way.
    const { error } = await client()
      .from('note_documents')
      .update({ title, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('owner_id', user.id);
    if (error) throw error;
  }

  // Soft delete, matching how a note is removed: the row stays so that a note
  // citing this document later cannot end up pointing at nothing.
  async function deleteDocument(id) {
    const user = currentUser();
    if (!user) throw new Error('Sign in to delete a document.');
    const { error } = await client()
      .from('note_documents')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
      .eq('owner_id', user.id);
    if (error) throw error;
  }

  // Every note this reader wrote out of one document -- the reverse of
  // line_notes.source_document_id, and what its partial index exists for.
  // This is the question the citation makes answerable and nothing else
  // does: "which dafs have I used this notebook on."
  //
  // Scoped to author_id as well as source_document_id. RLS would already
  // hold (a reader can only own documents whose citations are their own
  // notes), but stating it means the query says what it means rather than
  // relying on a policy elsewhere to be the thing that makes it true.
  async function fetchDocumentCitations(documentId) {
    const user = currentUser();
    if (!user) return [];
    const { data, error } = await client()
      .from('line_notes')
      .select('id, daf_ref_key, segment_ref, body, is_private, created_at')
      .eq('source_document_id', documentId)
      .eq('author_id', user.id)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    return data || [];
  }

  window.DafSyncMyNotes = window.DafSyncMyNotes || {};
  window.DafSyncMyNotes.data = {
    PAGE_SIZE,
    MAX_DOCUMENT_BYTES,
    documentByteLength,
    fetchMyNotes,
    fetchMyDafIndex,
    fetchMyDocuments,
    fetchDocument,
    fetchDocumentCitations,
    createDocument,
    renameDocument,
    deleteDocument,
    parseDafRefKey,
    dafRefFromKey,
    dafLabelFromKey,
    describeError,
    nextGeneration: () => generation.next(),
    isCurrent: (token) => generation.isCurrent(token),
  };
})();
