'use strict';

// Cloud Chabura data layer: every Supabase read the home page makes, plus
// pagination, request-race protection and error mapping.
//
// Namespaced on window.DafSyncChabura so nothing here relies on load-order
// luck the way the old chaburah.js relied on notes.js's bare globals.
//
// Three Phase 1 audit findings shaped this file:
//   F-2  the old feed re-fetched from row 0 on every "Load more" (offset+limit,
//        sliced client-side): page 5 fetched 101 rows to show 20. This uses
//        keyset pagination -- each page asks for rows strictly after the last
//        one already shown.
//   F-3  "Most helpful"/"Unanswered" scanned the newest 200 notes and ranked in
//        the browser, so anything outside that window could never appear. These
//        now filter server-side on real columns.
//   F-5  there was no guard against a slow earlier request landing after a fast
//        later one and overwriting it. Every query here carries a generation
//        token; a stale result is dropped rather than rendered.

(function () {
  const PAGE_SIZE = 20;

  // Bumped on every user-initiated load. A result whose token is no longer
  // current is discarded -- the cheap, dependency-free equivalent of
  // AbortController for a query builder that does not accept a signal.
  let generation = 0;
  function nextGeneration() { generation += 1; return generation; }
  function isCurrent(token) { return token === generation; }

  function client() {
    const auth = window.DafSyncAuth;
    if (!auth || !auth.client) throw new Error('Sign-in library is not ready.');
    return auth.client;
  }

  function currentUser() {
    return window.DafSyncAuth?.getUser?.() || null;
  }

  // PostgREST errors are not presentable as-is. Map the ones a reader can
  // actually hit to something that says what to do about it, and keep the
  // original for the console so a real fault is still debuggable.
  function describeError(error) {
    if (!error) return 'Something went wrong.';
    const code = error.code || '';
    if (code === 'PGRST301' || code === '401') return 'Your session expired. Sign in again to continue.';
    if (code === '42501') return 'You do not have permission to do that.';
    if (code === '42P17') return 'The server rejected this request. This is a bug, not something you did.';
    if (error.message && /Failed to fetch|NetworkError/i.test(error.message)) {
      return 'Could not reach the server. Check your connection and try again.';
    }
    return error.message || 'Something went wrong.';
  }

  // The columns the feed renders. Explicit rather than '*' so a future column
  // (or a private one) is never shipped to the browser by accident.
  const FEED_COLUMNS = [
    'id', 'author_id', 'author_display_name', 'daf_ref_key', 'segment_ref',
    'title', 'body', 'category', 'status', 'highlighted_comment_id',
    'selected_text', 'video_timestamp_seconds', 'is_demo',
    'created_at', 'last_activity_at', 'deleted_at',
  ].join(', ');

  function baseFeedQuery(filters) {
    let query = client()
      .from('line_notes')
      .select(FEED_COLUMNS)
      .eq('is_private', false)
      .eq('hidden', false)
      .is('deleted_at', null);
    if (filters.category) query = query.eq('category', filters.category);
    if (filters.dafRefKey) query = query.eq('daf_ref_key', filters.dafRefKey);
    if (filters.tractate) query = query.ilike('daf_ref_key', `${filters.tractate}-%`);
    if (filters.search) {
      query = query.textSearch('body_tsv', filters.search, { type: 'websearch', config: 'simple' });
    }
    return query;
  }

  // Keyset pagination on (last_activity_at desc, id desc). `cursor` is the
  // last row of the previous page, so each request reads only the next slice
  // instead of re-reading everything above it.
  function applyKeyset(query, cursor) {
    if (cursor) {
      query = query.or(
        `last_activity_at.lt.${cursor.last_activity_at},` +
        `and(last_activity_at.eq.${cursor.last_activity_at},id.lt.${cursor.id})`
      );
    }
    return query
      .order('last_activity_at', { ascending: false })
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
      cursor: last ? { last_activity_at: last.last_activity_at, id: last.id } : null,
    };
  }

  async function fetchFeed({ scope, filters = {}, cursor = null, token }) {
    const user = currentUser();

    if (scope === 'following') {
      if (!user) return { rows: [], hasMore: false, cursor: null, requiresSignIn: true };
      const { data: follows, error: followError } = await client()
        .from('thread_follows').select('note_id').eq('user_id', user.id);
      if (followError) throw followError;
      const ids = (follows || []).map((row) => row.note_id);
      if (!ids.length) return { rows: [], hasMore: false, cursor: null };
      const { data, error } = await applyKeyset(baseFeedQuery(filters).in('id', ids), cursor);
      if (error) throw error;
      return toPage(data);
    }

    if (scope === 'saved') {
      if (!user) return { rows: [], hasMore: false, cursor: null, requiresSignIn: true };
      const { data: saved, error: savedError } = await client()
        .from('bookmarks').select('target_id')
        .eq('user_id', user.id).eq('target_type', 'note');
      if (savedError) throw savedError;
      const ids = (saved || []).map((row) => row.target_id);
      if (!ids.length) return { rows: [], hasMore: false, cursor: null };
      const { data, error } = await applyKeyset(baseFeedQuery(filters).in('id', ids), cursor);
      if (error) throw error;
      return toPage(data);
    }

    let query = baseFeedQuery(filters);

    // Server-side now that `highlighted_comment_id` and `status` exist -- the
    // old client-side ranking could only ever see the newest 200 notes (F-3).
    if (scope === 'highlighted') query = query.not('highlighted_comment_id', 'is', null);
    if (scope === 'unanswered') {
      query = query.is('highlighted_comment_id', null).eq('status', 'open');
    }

    const { data, error } = await applyKeyset(query, cursor);
    if (error) throw error;
    const page = toPage(data);

    // "Unanswered" means nobody has answered, so a thread that already has
    // replies does not belong there even without a highlighted answer. Done
    // as a second pass over ONE page (not a 200-row prescan) so it stays
    // bounded regardless of corpus size.
    if (scope === 'unanswered' && page.rows.length) {
      const counts = await fetchReplyCounts(page.rows.map((row) => row.id));
      page.rows = page.rows.filter((row) => (counts.get(row.id) || 0) === 0);
    }

    if (!isCurrent(token)) return null;
    return page;
  }

  // Batched so the feed never does one query per card (the plan's explicit
  // no-N+1 requirement). Returns Map(noteId -> count).
  async function fetchReplyCounts(noteIds) {
    const counts = new Map();
    if (!noteIds.length) return counts;
    const { data, error } = await client()
      .from('comments')
      .select('note_id')
      .in('note_id', noteIds)
      .eq('hidden', false)
      .is('deleted_at', null);
    if (error) throw error;
    (data || []).forEach((row) => counts.set(row.note_id, (counts.get(row.note_id) || 0) + 1));
    return counts;
  }

  async function fetchParticipantCounts(noteIds) {
    const participants = new Map();
    if (!noteIds.length) return participants;
    const { data, error } = await client()
      .from('comments')
      .select('note_id, author_id')
      .in('note_id', noteIds)
      .eq('hidden', false)
      .is('deleted_at', null);
    if (error) throw error;
    (data || []).forEach((row) => {
      if (!participants.has(row.note_id)) participants.set(row.note_id, new Set());
      participants.get(row.note_id).add(row.author_id);
    });
    return participants;
  }

  async function fetchReactionCounts(noteIds) {
    const counts = new Map();
    if (!noteIds.length) return counts;
    const { data, error } = await client()
      .from('reactions').select('target_id')
      .eq('target_type', 'note').in('target_id', noteIds);
    if (error) throw error;
    (data || []).forEach((row) => counts.set(row.target_id, (counts.get(row.target_id) || 0) + 1));
    return counts;
  }

  // Unread = replies newer than this viewer's stored read position. A thread
  // with no read-state row has never been opened, so nothing is "unread" in
  // the sense the badge means -- showing every reply as unread on first sight
  // would make the whole feed shout.
  async function fetchUnreadCounts(noteIds) {
    const unread = new Map();
    const user = currentUser();
    if (!user || !noteIds.length) return unread;

    const { data: readRows, error: readError } = await client()
      .from('thread_read_state')
      .select('note_id, last_read_sequence')
      .eq('user_id', user.id)
      .in('note_id', noteIds);
    if (readError) throw readError;
    if (!readRows || !readRows.length) return unread;

    const readBy = new Map(readRows.map((row) => [row.note_id, row.last_read_sequence]));
    const { data: comments, error: commentError } = await client()
      .from('comments')
      .select('note_id, activity_sequence')
      .in('note_id', [...readBy.keys()])
      .eq('hidden', false)
      .is('deleted_at', null);
    if (commentError) throw commentError;

    (comments || []).forEach((row) => {
      if (row.activity_sequence > (readBy.get(row.note_id) ?? 0)) {
        unread.set(row.note_id, (unread.get(row.note_id) || 0) + 1);
      }
    });
    return unread;
  }

  async function fetchFollowedIds(noteIds) {
    const user = currentUser();
    if (!user || !noteIds.length) return new Set();
    const { data, error } = await client()
      .from('thread_follows').select('note_id')
      .eq('user_id', user.id).in('note_id', noteIds);
    if (error) throw error;
    return new Set((data || []).map((row) => row.note_id));
  }

  async function fetchSavedIds(noteIds) {
    const user = currentUser();
    if (!user || !noteIds.length) return new Set();
    const { data, error } = await client()
      .from('bookmarks').select('target_id')
      .eq('user_id', user.id).eq('target_type', 'note').in('target_id', noteIds);
    if (error) throw error;
    return new Set((data || []).map((row) => row.target_id));
  }

  // One round of batched lookups for a whole page of cards.
  async function decorate(rows) {
    if (!rows.length) return rows;
    const ids = rows.map((row) => row.id);
    const [replies, participants, reactions, unread, followed, saved] = await Promise.all([
      fetchReplyCounts(ids),
      fetchParticipantCounts(ids),
      fetchReactionCounts(ids),
      fetchUnreadCounts(ids),
      fetchFollowedIds(ids),
      fetchSavedIds(ids),
    ]);
    return rows.map((row) => ({
      ...row,
      replyCount: replies.get(row.id) || 0,
      participantCount: (participants.get(row.id)?.size || 0) + 1, // +1 for the author
      reactionCount: reactions.get(row.id) || 0,
      unreadCount: unread.get(row.id) || 0,
      isFollowed: followed.has(row.id),
      isSaved: saved.has(row.id),
    }));
  }

  async function fetchTodaySummary(dafRefKey) {
    if (!dafRefKey) return { total: 0, unanswered: 0, previews: [] };
    const { data, error } = await client()
      .from('line_notes')
      .select('id, title, body, category, highlighted_comment_id, status')
      .eq('is_private', false).eq('hidden', false).is('deleted_at', null)
      .eq('daf_ref_key', dafRefKey)
      .order('last_activity_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    const rows = data || [];
    return {
      total: rows.length,
      unanswered: rows.filter((row) => !row.highlighted_comment_id && row.status === 'open').length,
      previews: rows.slice(0, 3),
    };
  }

  async function toggleFollow(noteId, shouldFollow) {
    const user = currentUser();
    if (!user) throw new Error('Sign in to follow a discussion.');
    if (shouldFollow) {
      const { error } = await client().from('thread_follows').insert({ user_id: user.id, note_id: noteId });
      if (error) throw error;
    } else {
      const { error } = await client().from('thread_follows').delete()
        .eq('user_id', user.id).eq('note_id', noteId);
      if (error) throw error;
    }
  }

  async function toggleSaved(noteId, shouldSave) {
    const user = currentUser();
    if (!user) throw new Error('Sign in to save a discussion.');
    if (shouldSave) {
      const { error } = await client().from('bookmarks')
        .insert({ user_id: user.id, target_type: 'note', target_id: noteId });
      if (error) throw error;
    } else {
      const { error } = await client().from('bookmarks').delete()
        .eq('user_id', user.id).eq('target_type', 'note').eq('target_id', noteId);
      if (error) throw error;
    }
  }

  window.DafSyncChabura = window.DafSyncChabura || {};
  window.DafSyncChabura.data = {
    PAGE_SIZE,
    nextGeneration,
    isCurrent,
    describeError,
    fetchFeed,
    decorate,
    fetchTodaySummary,
    toggleFollow,
    toggleSaved,
  };
})();
