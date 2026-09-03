'use strict';

// Every Supabase read and write the Cloud Chabura thread reader makes.
//
// Three schema facts from the applied Phase 2 migration shape this file, and
// each replaces something the old note dialog did the hard way:
//
//   1. `root_comment_id` is stored and NOT NULL, so a permalink to a reply
//      nested four levels deep fetches its WHOLE ancestor chain in one query
//      (`root_comment_id = <that root>`) instead of walking parent pointers
//      one round trip at a time. comments_note_root_created_idx is
//      (note_id, root_comment_id, created_at, id), which is exactly that read.
//
//   2. Neither public-read policy filters `deleted_at`. A soft-deleted row is
//      still SELECTable, with its body redacted to '[deleted]' by the
//      redact_on_soft_delete trigger. That is the tombstone: the content is
//      gone server-side, the row stays so descendants remain connected. The
//      client renders the tombstone, it does not create it.
//
//   3. comments_insert already refuses a reply when the thread is locked,
//      deleted, private or hidden. The UI disables the composer for those, but
//      the rule is the server's -- the disabled control is a courtesy, not the
//      enforcement.

(function () {
  const { client, currentUser, describeError, generations } = window.DafSyncChabura.core;

  // Top-level branches per page, and how many descendants of a branch to pull
  // in one batch. Bounded on purpose: the plan's "do not render all replies at
  // once" applies to reading as much as to rendering.
  const BRANCH_PAGE_SIZE = 10;
  const DESCENDANT_BATCH = 200;

  const generation = generations();

  // A reply can be refused for several reasons that all arrive as the SAME
  // PostgREST error: comments_insert is one policy checking the thread is not
  // private, not hidden, not locked, not deleted, and that the account is old
  // enough to post publicly. "You do not have permission" is true but useless,
  // so the current state of the thread is re-read and the reason named.
  async function explainRejectedReply(noteId, error) {
    if (!error || (error.code !== '42501' && !/row-level security/i.test(error.message || ''))) return null;
    try {
      const { data } = await client()
        .from('line_notes').select('status, deleted_at, hidden, is_private').eq('id', noteId).maybeSingle();
      if (!data) return 'This discussion is no longer available. Your reply has been kept — copy it somewhere safe.';
      if (data.deleted_at) return 'This discussion was deleted while you were writing. Your reply has been kept — copy it somewhere safe.';
      if (data.status === 'locked') return 'This discussion was locked while you were writing. Your reply has been kept, but it cannot be posted here.';
      if (data.hidden) return 'A moderator hid this discussion while you were writing. Your reply has been kept.';
    } catch { /* fall through to the generic explanation */ }
    // Nothing about the thread changed, so the account itself is the reason.
    return 'New accounts cannot post publicly yet. Your reply has been kept — try again once your account is a day old.';
  }

  const NOTE_COLUMNS = [
    'id', 'author_id', 'author_display_name', 'daf_ref_key', 'segment_ref',
    'title', 'body', 'category', 'status', 'highlighted_comment_id',
    'selected_text', 'word_ranges', 'start_word', 'end_word',
    'video_timestamp_seconds', 'is_demo', 'is_private', 'hidden',
    'created_at', 'edited_at', 'deleted_at', 'last_activity_at',
  ].join(', ');

  const COMMENT_COLUMNS = [
    'id', 'note_id', 'author_id', 'author_display_name', 'body',
    'parent_comment_id', 'root_comment_id', 'depth', 'activity_sequence',
    'quoted_comment_id', 'quoted_excerpt', 'mentioned_user_ids',
    'hidden', 'is_demo', 'created_at', 'edited_at', 'deleted_at',
  ].join(', ');

  // --- Reading -------------------------------------------------------------

  // Distinguishes "no such thread" from "you may not see this one". RLS makes
  // both look like zero rows, so the two cases are told apart by whether the
  // viewer is signed in at all -- and neither message ever echoes an id back.
  async function fetchThread(noteId) {
    const { data, error } = await client()
      .from('line_notes').select(NOTE_COLUMNS).eq('id', noteId).maybeSingle();
    if (error) throw error;
    if (!data) {
      return {
        note: null,
        reason: currentUser() ? 'not-found-or-private' : 'sign-in-required',
      };
    }
    return { note: data, reason: null };
  }

  // Top-level branches only. Their descendants arrive separately so a thread
  // with one enormous branch cannot make the first page unbounded.
  async function fetchBranchPage(noteId, cursor) {
    let query = client()
      .from('comments').select(COMMENT_COLUMNS)
      .eq('note_id', noteId)
      .is('parent_comment_id', null);
    if (cursor) {
      query = query.or(
        `created_at.gt.${cursor.created_at},` +
        `and(created_at.eq.${cursor.created_at},id.gt.${cursor.id})`
      );
    }
    const { data, error } = await query
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(BRANCH_PAGE_SIZE + 1);
    if (error) throw error;

    const rows = data || [];
    const hasMore = rows.length > BRANCH_PAGE_SIZE;
    const page = hasMore ? rows.slice(0, BRANCH_PAGE_SIZE) : rows;
    const last = page[page.length - 1] || null;
    return {
      rows: page,
      hasMore,
      cursor: last ? { created_at: last.created_at, id: last.id } : null,
    };
  }

  // Descendants of already-loaded roots, batched so the feed's no-N+1 rule
  // holds here too: one query for a whole page of branches, not one per branch.
  async function fetchDescendants(noteId, rootIds) {
    if (!rootIds.length) return [];
    const { data, error } = await client()
      .from('comments').select(COMMENT_COLUMNS)
      .eq('note_id', noteId)
      .in('root_comment_id', rootIds)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(DESCENDANT_BATCH);
    if (error) throw error;
    // The roots themselves come back too (root_comment_id = own id); the state
    // layer dedupes by id, so this stays one round trip.
    return data || [];
  }

  // A ?comment= permalink. One lookup for the target, then one for its entire
  // branch -- which necessarily contains every ancestor, because they all
  // share the target's root_comment_id.
  async function fetchPermalinkBranch(noteId, commentId) {
    const { data: target, error: targetError } = await client()
      .from('comments').select(COMMENT_COLUMNS)
      .eq('id', commentId).eq('note_id', noteId).maybeSingle();
    if (targetError) throw targetError;
    if (!target) return { target: null, rows: [] };

    const { data, error } = await client()
      .from('comments').select(COMMENT_COLUMNS)
      .eq('note_id', noteId)
      .eq('root_comment_id', target.root_comment_id)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true });
    if (error) throw error;
    return { target, rows: data || [] };
  }

  // Searches the WHOLE thread, not the rows the client happens to have loaded.
  // comments.body_tsv is a generated tsvector with a gin index, so a match in a
  // branch that was never fetched is still found -- which is the difference
  // between "search this discussion" and "search what is on screen".
  async function searchThread(noteId, term) {
    const needle = (term || '').trim();
    if (!needle) return [];
    const { data, error } = await client()
      .from('comments').select(COMMENT_COLUMNS)
      .eq('note_id', noteId)
      .textSearch('body_tsv', needle, { type: 'websearch', config: 'simple' })
      .order('created_at', { ascending: true })
      .limit(200);
    if (error) throw error;
    return data || [];
  }

  // The branches those matches live in, so an expanded match has its ancestors
  // and siblings around it rather than appearing on its own.
  async function fetchBranchesFor(noteId, rootIds) {
    if (!rootIds.length) return [];
    const { data, error } = await client()
      .from('comments').select(COMMENT_COLUMNS)
      .eq('note_id', noteId)
      .in('root_comment_id', [...new Set(rootIds)])
      .order('created_at', { ascending: true })
      .limit(DESCENDANT_BATCH);
    if (error) throw error;
    return data || [];
  }

  // Link previews are fetched by the SERVER, never by the reader's browser --
  // see netlify/functions/link-preview.mjs for why. Cached per URL for the life
  // of the page so a thread quoting the same link twenty times asks once.
  const previewCache = new Map();

  async function fetchLinkPreview(url) {
    if (previewCache.has(url)) return previewCache.get(url);
    const pending = (async () => {
      try {
        const response = await fetch(`/api/link-preview?url=${encodeURIComponent(url)}`);
        if (!response.ok) return null;
        const preview = await response.json();
        return preview && (preview.title || preview.description) ? preview : null;
      } catch {
        // A preview is decoration. Failing to get one must never look like a
        // failure of the reply it belongs to.
        return null;
      }
    })();
    previewCache.set(url, pending);
    return pending;
  }

  // Safe public identity only. profiles carries the email; public_profiles is
  // the view that does not, and it is what the browser is allowed to read.
  async function fetchProfiles(userIds) {
    const profiles = new Map();
    const ids = [...new Set(userIds.filter(Boolean))];
    if (!ids.length) return profiles;
    const { data, error } = await client()
      .from('public_profiles').select('id, display_name, avatar_path, role_label')
      .in('id', ids);
    if (error) throw error;
    (data || []).forEach((row) => profiles.set(row.id, row));
    return profiles;
  }

  // Reactions for the root note and every loaded reply, in one query per
  // target type. Returns Map(targetId -> { counts: Map(type -> n), mine:Set }).
  async function fetchReactions(noteId, commentIds) {
    const byTarget = new Map();
    const user = currentUser();

    async function collect(targetType, targetIds) {
      if (!targetIds.length) return;
      const { data, error } = await client()
        .from('reactions').select('target_id, reaction_type, user_id')
        .eq('target_type', targetType).in('target_id', targetIds);
      if (error) throw error;
      (data || []).forEach((row) => {
        if (!byTarget.has(row.target_id)) byTarget.set(row.target_id, { counts: new Map(), mine: new Set() });
        const entry = byTarget.get(row.target_id);
        entry.counts.set(row.reaction_type, (entry.counts.get(row.reaction_type) || 0) + 1);
        if (user && row.user_id === user.id) entry.mine.add(row.reaction_type);
      });
    }

    await Promise.all([
      collect('note', [noteId]),
      collect('comment', commentIds),
    ]);
    return byTarget;
  }

  async function fetchViewerState(noteId) {
    const user = currentUser();
    const state = { isFollowed: false, isSaved: false, lastReadSequence: 0, isAdmin: false };
    if (!user) return state;

    const [follow, saved, read, profile] = await Promise.all([
      client().from('thread_follows').select('note_id').eq('user_id', user.id).eq('note_id', noteId).maybeSingle(),
      client().from('bookmarks').select('target_id').eq('user_id', user.id).eq('target_type', 'note').eq('target_id', noteId).maybeSingle(),
      client().from('thread_read_state').select('last_read_sequence').eq('user_id', user.id).eq('note_id', noteId).maybeSingle(),
      client().from('profiles').select('is_admin').eq('id', user.id).maybeSingle(),
    ]);
    if (follow.error) throw follow.error;
    if (saved.error) throw saved.error;
    if (read.error) throw read.error;
    // A missing profile row is not an error -- it just means "not an admin".
    state.isFollowed = Boolean(follow.data);
    state.isSaved = Boolean(saved.data);
    state.lastReadSequence = read.data?.last_read_sequence ?? 0;
    state.isAdmin = Boolean(profile.data?.is_admin);
    return state;
  }

  // --- Writing -------------------------------------------------------------

  // The id is generated by the CLIENT and sent with the insert, which is what
  // makes a retry safe: `comments.id` is the primary key, so a second attempt
  // carrying the same id collides (23505) instead of creating a second reply.
  // That turns "did my first request land before it timed out?" from a guess
  // into a question the database answers.
  function newCommentId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  async function postReply({ id, noteId, parentCommentId, body, mentionedUserIds, quotedCommentId, quotedExcerpt }) {
    const user = currentUser();
    if (!user) throw new Error('Sign in to reply.');
    const row = {
      id: id || newCommentId(),
      note_id: noteId,
      author_id: user.id,
      body,
      parent_comment_id: parentCommentId || null,
      mentioned_user_ids: mentionedUserIds || [],
    };
    // Only send the quote columns when there is a quote: the excerpt has a
    // 1..500 length check, and an empty string would trip it.
    if (quotedCommentId) {
      row.quoted_comment_id = quotedCommentId;
      row.quoted_excerpt = (quotedExcerpt || '').slice(0, 500) || null;
    }
    const { data, error } = await client().from('comments').insert(row).select(COMMENT_COLUMNS);
    if (error) {
      // A unique violation on a retry means the FIRST attempt succeeded and the
      // client simply never heard back. Fetch what landed rather than reporting
      // a failure for a reply that exists, and rather than posting it twice.
      if (error.code === '23505') {
        const existing = await fetchComment(row.id);
        if (existing) return existing;
      }
      throw error;
    }
    return (data && data[0]) || null;
  }

  async function fetchComment(commentId) {
    const { data, error } = await client()
      .from('comments').select(COMMENT_COLUMNS).eq('id', commentId).maybeSingle();
    if (error) return null;
    return data || null;
  }

  async function editComment(commentId, body) {
    const { data, error } = await client().from('comments')
      .update({ body, edited_at: new Date().toISOString() })
      .eq('id', commentId).select(COMMENT_COLUMNS);
    if (error) throw error;
    return (data && data[0]) || null;
  }

  async function editNote(noteId, patch) {
    const { data, error } = await client().from('line_notes')
      .update({ ...patch, edited_at: new Date().toISOString() })
      .eq('id', noteId).select(NOTE_COLUMNS);
    if (error) throw error;
    return (data && data[0]) || null;
  }

  // Soft delete. The body redaction is the trigger's job, not this function's
  // -- doing it here would let a client that skipped the step leave the
  // original text readable over the API.
  async function softDeleteComment(commentId) {
    const { data, error } = await client().from('comments')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', commentId).select(COMMENT_COLUMNS);
    if (error) throw error;
    return (data && data[0]) || null;
  }

  async function softDeleteNote(noteId) {
    const { data, error } = await client().from('line_notes')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', noteId).select(NOTE_COLUMNS);
    if (error) throw error;
    return (data && data[0]) || null;
  }

  // null clears the highlight. The same-thread and still-visible rules are
  // enforced by line_notes_validate_highlight, which raises 23514.
  async function setHighlightedComment(noteId, commentId) {
    const { data, error } = await client().from('line_notes')
      .update({ highlighted_comment_id: commentId })
      .eq('id', noteId).select(NOTE_COLUMNS);
    if (error) throw error;
    return (data && data[0]) || null;
  }

  async function setStatus(noteId, status) {
    const { data, error } = await client().from('line_notes')
      .update({ status }).eq('id', noteId).select(NOTE_COLUMNS);
    if (error) throw error;
    return (data && data[0]) || null;
  }

  async function toggleReaction({ targetType, targetId, reactionType, add }) {
    const user = currentUser();
    if (!user) throw new Error('Sign in to react.');
    if (add) {
      const { error } = await client().from('reactions')
        .insert({ user_id: user.id, target_type: targetType, target_id: targetId, reaction_type: reactionType });
      if (error) throw error;
    } else {
      const { error } = await client().from('reactions').delete()
        .eq('user_id', user.id).eq('target_type', targetType)
        .eq('target_id', targetId).eq('reaction_type', reactionType);
      if (error) throw error;
    }
  }

  async function setFollowed(noteId, shouldFollow) {
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

  async function fetchSavedCommentIds(commentIds) {
    const user = currentUser();
    if (!user || !commentIds.length) return new Set();
    const { data, error } = await client()
      .from('bookmarks').select('target_id')
      .eq('user_id', user.id).eq('target_type', 'comment').in('target_id', commentIds);
    if (error) throw error;
    return new Set((data || []).map((row) => row.target_id));
  }

  async function setCommentSaved(commentId, shouldSave) {
    const user = currentUser();
    if (!user) throw new Error('Sign in to save a reply.');
    if (shouldSave) {
      const { error } = await client().from('bookmarks')
        .insert({ user_id: user.id, target_type: 'comment', target_id: commentId });
      if (error) throw error;
    } else {
      const { error } = await client().from('bookmarks').delete()
        .eq('user_id', user.id).eq('target_type', 'comment').eq('target_id', commentId);
      if (error) throw error;
    }
  }

  // Replies added since the reader arrived. Polled rather than pushed: the
  // vendored client does carry realtime, but subscribing to `comments` needs
  // that table added to a publication in production, which is a production
  // configuration change and not one to make unilaterally. The user-facing
  // behaviour -- new replies never move the page under the reader, and a
  // control appears when they are offscreen -- is identical either way, and
  // this function is the seam a channel would drive instead.
  async function fetchRepliesSince(noteId, sinceSequence) {
    const { data, error } = await client()
      .from('comments').select(COMMENT_COLUMNS)
      .eq('note_id', noteId)
      .gt('activity_sequence', sinceSequence)
      .order('activity_sequence', { ascending: true })
      .limit(50);
    if (error) throw error;
    return data || [];
  }

  async function setSaved(noteId, shouldSave) {
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

  // Marks the thread read up to `sequence`. thread_read_state_monotonic clamps
  // this to the maximum already stored, so a stale tab reporting an older
  // position can never move a reader's marker backwards.
  async function markRead(noteId, sequence) {
    const user = currentUser();
    if (!user || !sequence) return;
    const { error } = await client().from('thread_read_state')
      .upsert({
        user_id: user.id,
        note_id: noteId,
        last_read_sequence: sequence,
        last_read_at: new Date().toISOString(),
      });
    if (error) throw error;
  }

  async function reportTarget(targetType, targetId, reason) {
    const user = currentUser();
    if (!user) throw new Error('Sign in to report.');
    const { error } = await client().from('reports')
      .insert({ reporter_id: user.id, target_type: targetType, target_id: targetId, reason });
    if (error) throw error;
  }

  window.DafSyncChabura = window.DafSyncChabura || {};
  window.DafSyncChabura.threadData = {
    BRANCH_PAGE_SIZE,
    DESCENDANT_BATCH,
    nextGeneration: () => generation.next(),
    isCurrent: (token) => generation.isCurrent(token),
    describeError,
    explainRejectedReply,
    fetchThread,
    fetchBranchPage,
    fetchDescendants,
    fetchPermalinkBranch,
    searchThread,
    fetchBranchesFor,
    fetchLinkPreview,
    fetchProfiles,
    fetchReactions,
    fetchViewerState,
    newCommentId,
    fetchComment,
    postReply,
    editComment,
    editNote,
    softDeleteComment,
    softDeleteNote,
    setHighlightedComment,
    setStatus,
    toggleReaction,
    setFollowed,
    setSaved,
    fetchSavedCommentIds,
    setCommentSaved,
    fetchRepliesSince,
    markRead,
    reportTarget,
  };
})();
