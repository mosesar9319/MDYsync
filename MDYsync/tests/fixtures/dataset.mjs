// Fixture data for the Cloud Chaburah / notes regression suite.
//
// Shapes mirror the LIVE Supabase schema (see docs/PHASE1_CLOUD_CHABURA_AUDIT.md
// §2 for the pre-Phase-2 baseline). The Phase 2 migration
// 20260902190000_cloud_chabura_thread_foundation.sql has since been applied to
// production, so the columns the Phase 1 audit recorded as missing -- a
// highlighted answer, an author soft-delete distinct from moderator `hidden`,
// per-thread read state, saved threads -- now exist here too, populated the way
// the real triggers populate them.

export const USERS = {
  ordinary: { id: '11111111-1111-4111-8111-111111111111', email: 'reader@example.com', display_name: 'Reader One' },
  author: { id: '22222222-2222-4222-8222-222222222222', email: 'author@example.com', display_name: 'Author Two' },
  brandNew: { id: '33333333-3333-4333-8333-333333333333', email: 'newbie@example.com', display_name: 'New Account' },
  admin: { id: '44444444-4444-4444-8444-444444444444', email: 'admin@example.com', display_name: 'Admin Four' },
};

export function sessionFor(user) {
  return user ? { user: { id: user.id, email: user.email } } : null;
}

function isoMinutesAgo(minutes) {
  return new Date(Date.parse('2026-09-02T12:00:00.000Z') - minutes * 60000).toISOString();
}

// Note IDs are stable so specs can address a specific thread without depending
// on array order.
export const NOTE_IDS = {
  legacySegmentOnly: 'a0000000-0000-4000-8000-000000000001',
  singleWordRange: 'a0000000-0000-4000-8000-000000000002',
  multiRefWordRange: 'a0000000-0000-4000-8000-000000000003',
  noReplies: 'a0000000-0000-4000-8000-000000000004',
  deepThread: 'a0000000-0000-4000-8000-000000000005',
  hiddenParentThread: 'a0000000-0000-4000-8000-000000000006',
  largeThread: 'a0000000-0000-4000-8000-000000000007',
  privateNote: 'a0000000-0000-4000-8000-000000000008',
  otherMasechta: 'a0000000-0000-4000-8000-000000000009',
};

function note(overrides) {
  return {
    id: overrides.id,
    author_id: overrides.author_id || USERS.author.id,
    author_display_name: overrides.author_display_name || USERS.author.display_name,
    daf_ref_key: overrides.daf_ref_key || 'Chullin-89a',
    segment_ref: overrides.segment_ref || 'Chullin 89a.1',
    body: overrides.body,
    hidden: overrides.hidden || false,
    is_private: overrides.is_private || false,
    created_at: overrides.created_at,
    updated_at: overrides.created_at,
    start_word: overrides.start_word ?? null,
    end_word: overrides.end_word ?? null,
    selected_text: overrides.selected_text ?? null,
    word_ranges: overrides.word_ranges ?? null,
    mentioned_user_ids: overrides.mentioned_user_ids || [],
    category: overrides.category ?? null,
    video_timestamp_seconds: overrides.video_timestamp_seconds ?? null,
    is_demo: false,
    // Phase 2 columns. `title` is null on every fixture note on purpose: every
    // row that existed before the migration has one, and the feed has to keep
    // deriving a display title from the body for them.
    title: overrides.title ?? null,
    status: overrides.status || 'open',
    highlighted_comment_id: overrides.highlighted_comment_id ?? null,
    edited_at: null,
    deleted_at: overrides.deleted_at ?? null,
    // bump_note_last_activity() keeps this at or after created_at; the backfill
    // set it to created_at for every pre-existing row.
    last_activity_at: overrides.last_activity_at || overrides.created_at,
  };
}

function comment(overrides) {
  return {
    id: overrides.id,
    note_id: overrides.note_id,
    author_id: overrides.author_id || USERS.ordinary.id,
    author_display_name: overrides.author_display_name || USERS.ordinary.display_name,
    body: overrides.body,
    hidden: overrides.hidden || false,
    created_at: overrides.created_at,
    updated_at: overrides.created_at,
    parent_comment_id: overrides.parent_comment_id ?? null,
    mentioned_user_ids: overrides.mentioned_user_ids || [],
    is_demo: false,
    // Phase 2 columns. root_comment_id/depth/activity_sequence are derived by
    // the comments_derive_hierarchy trigger; buildDatabase() fills them in the
    // same order below rather than hand-writing them per row.
    root_comment_id: null,
    depth: 0,
    activity_sequence: 0,
    edited_at: overrides.edited_at ?? null,
    deleted_at: overrides.deleted_at ?? null,
    quoted_comment_id: overrides.quoted_comment_id ?? null,
    quoted_excerpt: overrides.quoted_excerpt ?? null,
  };
}

// A thread far past the plan's 300-reply threshold, built on demand rather than
// in every buildDatabase() call -- 1,000 extra rows in every test would slow the
// whole suite to measure something only two specs care about.
export function withHugeThread(db, replies = 1000) {
  const rootId = 'a0000000-0000-4000-8000-00000000000a';
  db.line_notes.push({
    id: rootId,
    author_id: USERS.author.id,
    author_display_name: USERS.author.display_name,
    daf_ref_key: 'Chullin-89a',
    segment_ref: 'Chullin 89a.1',
    body: 'Root of a thousand-reply thread.',
    hidden: false, is_private: false,
    created_at: isoMinutesAgo(200),
    updated_at: isoMinutesAgo(200),
    last_activity_at: isoMinutesAgo(1),
    start_word: null, end_word: null, selected_text: null, word_ranges: null,
    mentioned_user_ids: [], category: 'question', video_timestamp_seconds: null, is_demo: false,
    title: null, status: 'open', highlighted_comment_id: null, edited_at: null, deleted_at: null,
  });
  for (let i = 0; i < replies; i += 1) {
    const id = `e${String(i).padStart(7, '0')}-0000-4000-8000-000000000000`;
    db.comments.push({
      id,
      note_id: rootId,
      author_id: USERS.ordinary.id,
      author_display_name: USERS.ordinary.display_name,
      body: `Scale reply number ${i}.`,
      hidden: false,
      created_at: new Date(Date.parse('2026-09-02T06:00:00.000Z') + i * 1000).toISOString(),
      updated_at: new Date(Date.parse('2026-09-02T06:00:00.000Z') + i * 1000).toISOString(),
      parent_comment_id: null,
      mentioned_user_ids: [], is_demo: false,
      root_comment_id: id, depth: 0, activity_sequence: i + 1,
      edited_at: null, deleted_at: null, quoted_comment_id: null, quoted_excerpt: null,
    });
  }
  return { db, rootId };
}

// Builds a fresh, mutable database for one test. Always call this per test --
// specs mutate it (posting replies, reacting) and must not share state.
export function buildDatabase() {
  const line_notes = [
    // Legacy anchor: whole-segment note, no word range at all. Must keep
    // rendering after every future word_ranges-aware change.
    note({
      id: NOTE_IDS.legacySegmentOnly,
      body: 'Legacy whole-segment note with no word range.',
      category: 'question',
      created_at: isoMinutesAgo(10),
    }),
    note({
      id: NOTE_IDS.singleWordRange,
      body: 'Note anchored to a single word range.',
      category: 'insight',
      start_word: 3,
      end_word: 6,
      selected_text: 'ארבעה ראשי שנים הם',
      word_ranges: [{ ref: 'Chullin 89a.1', start: 3, end: 6 }],
      video_timestamp_seconds: 412.5,
      created_at: isoMinutesAgo(20),
    }),
    // The Select Text feature's defining case: a selection crossing refs.
    note({
      id: NOTE_IDS.multiRefWordRange,
      body: 'Note whose selection crosses two refs.',
      category: 'difficulty',
      start_word: 8,
      end_word: 11,
      selected_text: 'תנו רבנן ארבעה',
      word_ranges: [
        { ref: 'Chullin 89a.1', start: 8, end: 11 },
        { ref: 'Chullin 89a.2', start: 0, end: 2 },
      ],
      video_timestamp_seconds: null,
      created_at: isoMinutesAgo(30),
    }),
    note({ id: NOTE_IDS.noReplies, body: 'A thread with no replies at all.', category: 'source', created_at: isoMinutesAgo(40) }),
    note({
      id: NOTE_IDS.deepThread,
      body: 'Root of a four-level reply chain.',
      category: 'question',
      created_at: isoMinutesAgo(50),
      // A marked answer: the only fixture note in the Highlighted view.
      highlighted_comment_id: 'b0000000-0000-4000-8000-000000000001',
      last_activity_at: isoMinutesAgo(46),
    }),
    note({ id: NOTE_IDS.hiddenParentThread, body: 'Root whose middle reply is moderator-hidden.', category: 'answer', created_at: isoMinutesAgo(60) }),
    note({ id: NOTE_IDS.largeThread, body: 'Root of a very large thread.', category: 'explanation', created_at: isoMinutesAgo(70) }),
    // Never allowed to appear in any public feed, search result or count.
    note({
      id: NOTE_IDS.privateNote,
      author_id: USERS.ordinary.id,
      author_display_name: USERS.ordinary.display_name,
      body: 'PRIVATE-CANARY private note body.',
      is_private: true,
      created_at: isoMinutesAgo(5),
    }),
    note({ id: NOTE_IDS.otherMasechta, daf_ref_key: 'Berakhot-2a', segment_ref: 'Berakhot 2a.1', body: 'Note on a different masechta.', created_at: isoMinutesAgo(80) }),
  ];

  const comments = [];

  // Four nesting levels (the current MAX_REPLY_DEPTH ceiling).
  let parent = null;
  for (let level = 1; level <= 4; level += 1) {
    const id = `b0000000-0000-4000-8000-00000000000${level}`;
    comments.push(comment({
      id,
      note_id: NOTE_IDS.deepThread,
      parent_comment_id: parent,
      body: `Reply at level ${level}.`,
      created_at: isoMinutesAgo(50 - level),
    }));
    parent = id;
  }

  // A hidden middle reply that still has a visible descendant beneath it.
  comments.push(comment({ id: 'c0000000-0000-4000-8000-000000000001', note_id: NOTE_IDS.hiddenParentThread, body: 'Visible top reply.', created_at: isoMinutesAgo(59) }));
  comments.push(comment({ id: 'c0000000-0000-4000-8000-000000000002', note_id: NOTE_IDS.hiddenParentThread, parent_comment_id: 'c0000000-0000-4000-8000-000000000001', body: 'HIDDEN-CANARY moderator-hidden reply.', hidden: true, created_at: isoMinutesAgo(58) }));
  comments.push(comment({ id: 'c0000000-0000-4000-8000-000000000003', note_id: NOTE_IDS.hiddenParentThread, parent_comment_id: 'c0000000-0000-4000-8000-000000000002', body: 'Descendant of a hidden reply.', created_at: isoMinutesAgo(57) }));

  // Author-deleted, with a visible child beneath it. The body is already
  // '[deleted]' because redact_on_soft_delete rewrote it server-side -- the
  // fixture stores what the API actually returns, not the original text.
  comments.push(comment({
    id: 'c0000000-0000-4000-8000-000000000005',
    note_id: NOTE_IDS.hiddenParentThread,
    body: '[deleted]',
    deleted_at: isoMinutesAgo(56),
    created_at: isoMinutesAgo(58),
  }));
  comments.push(comment({
    id: 'c0000000-0000-4000-8000-000000000006',
    note_id: NOTE_IDS.hiddenParentThread,
    parent_comment_id: 'c0000000-0000-4000-8000-000000000005',
    body: 'Descendant of an author-deleted reply.',
    created_at: isoMinutesAgo(55),
  }));

  // A quoted reply: quoted_comment_id plus the immutable excerpt that keeps a
  // quote readable after its original is removed.
  comments.push(comment({
    id: 'c0000000-0000-4000-8000-000000000004',
    note_id: NOTE_IDS.deepThread,
    parent_comment_id: 'b0000000-0000-4000-8000-000000000001',
    body: 'Quoting the first reply.',
    quoted_comment_id: 'b0000000-0000-4000-8000-000000000001',
    quoted_excerpt: 'Reply at level 1.',
    created_at: isoMinutesAgo(44),
  }));

  // 320 replies: above the plan's 300+ performance fixture threshold.
  for (let i = 0; i < 320; i += 1) {
    comments.push(comment({
      id: `d${String(i).padStart(7, '0')}-0000-4000-8000-000000000000`,
      note_id: NOTE_IDS.largeThread,
      body: `Bulk reply number ${i}.`,
      created_at: isoMinutesAgo(70 - i / 100),
    }));
  }

  // Mirrors comments_derive_hierarchy: activity_sequence is a per-note counter
  // in insert order, and a reply's root is its own id when it is top-level.
  const sequenceByNote = new Map();
  const commentsById = new Map(comments.map((row) => [row.id, row]));
  comments.forEach((row) => {
    const next = (sequenceByNote.get(row.note_id) || 0) + 1;
    sequenceByNote.set(row.note_id, next);
    row.activity_sequence = next;
    if (!row.parent_comment_id) {
      row.root_comment_id = row.id;
      row.depth = 0;
    } else {
      const parent = commentsById.get(row.parent_comment_id);
      row.root_comment_id = parent ? parent.root_comment_id : row.id;
      row.depth = parent ? parent.depth + 1 : 0;
    }
  });

  return {
    profiles: Object.values(USERS).map((user) => ({
      id: user.id,
      email: user.email,
      display_name: user.display_name,
      is_admin: user.id === USERS.admin.id,
      // can_post_publicly() requires an account older than 24h; the brand-new
      // persona is younger. The stub does not enforce this (that is a server
      // rule) -- specs assert the CLIENT's handling of the server's rejection.
      created_at: user.id === USERS.brandNew.id ? isoMinutesAgo(30) : isoMinutesAgo(60 * 24 * 30),
    })),
    line_notes,
    comments,
    // The view the browser is allowed to read. Deliberately a SEPARATE array
    // from `profiles` and deliberately without `email`: a spec that queried
    // public_profiles and got an email back would be a real finding.
    public_profiles: Object.values(USERS).map((user) => ({
      id: user.id,
      display_name: user.display_name,
      avatar_path: null,
      role_label: user.id === USERS.admin.id ? 'Moderator' : null,
    })),
    reactions: [
      { id: 'e0000000-0000-4000-8000-000000000001', user_id: USERS.ordinary.id, target_type: 'note', target_id: NOTE_IDS.singleWordRange, reaction_type: 'helpful', created_at: isoMinutesAgo(9) },
      { id: 'e0000000-0000-4000-8000-000000000002', user_id: USERS.admin.id, target_type: 'note', target_id: NOTE_IDS.singleWordRange, reaction_type: 'insightful', created_at: isoMinutesAgo(8) },
      { id: 'e0000000-0000-4000-8000-000000000003', user_id: USERS.ordinary.id, target_type: 'note', target_id: NOTE_IDS.multiRefWordRange, reaction_type: 'chazak', created_at: isoMinutesAgo(7) },
    ],
    thread_follows: [
      { user_id: USERS.ordinary.id, note_id: NOTE_IDS.deepThread, created_at: isoMinutesAgo(6) },
    ],
    // Saved threads (Phase 2 `bookmarks`). Deliberately a DIFFERENT thread from
    // the followed one so a spec cannot pass by confusing the two views.
    bookmarks: [
      { id: 'f1000000-0000-4000-8000-000000000001', user_id: USERS.ordinary.id, target_type: 'note', target_id: NOTE_IDS.noReplies, created_at: isoMinutesAgo(4) },
    ],
    // Reader One has read the deep thread up to its second reply, so levels 3
    // and 4 are unread. Every other thread has no read-state row at all, which
    // means "never opened" -- not "everything is unread".
    thread_read_state: [
      { user_id: USERS.ordinary.id, note_id: NOTE_IDS.deepThread, last_read_sequence: 2, updated_at: isoMinutesAgo(3) },
    ],
    // A burst on ONE thread plus a single mention on another: enough to prove
    // grouping collapses the burst instead of showing five identical lines.
    notifications: [
      { id: 'n0000000-0000-4000-8000-000000000001', user_id: USERS.ordinary.id, type: 'reply', actor_id: USERS.author.id, actor_display_name: USERS.author.display_name, note_id: NOTE_IDS.deepThread, comment_id: 'b0000000-0000-4000-8000-000000000002', daf_ref_key: 'Chullin-89a', segment_ref: 'Chullin 89a.1', preview: 'Reply at level 2.', read: false, created_at: isoMinutesAgo(9) },
      { id: 'n0000000-0000-4000-8000-000000000002', user_id: USERS.ordinary.id, type: 'reply', actor_id: USERS.author.id, actor_display_name: USERS.author.display_name, note_id: NOTE_IDS.deepThread, comment_id: 'b0000000-0000-4000-8000-000000000003', daf_ref_key: 'Chullin-89a', segment_ref: 'Chullin 89a.1', preview: 'Reply at level 3.', read: false, created_at: isoMinutesAgo(8) },
      { id: 'n0000000-0000-4000-8000-000000000003', user_id: USERS.ordinary.id, type: 'reply', actor_id: USERS.author.id, actor_display_name: USERS.author.display_name, note_id: NOTE_IDS.deepThread, comment_id: 'b0000000-0000-4000-8000-000000000004', daf_ref_key: 'Chullin-89a', segment_ref: 'Chullin 89a.1', preview: 'Reply at level 4.', read: false, created_at: isoMinutesAgo(7) },
      { id: 'n0000000-0000-4000-8000-000000000004', user_id: USERS.ordinary.id, type: 'mention', actor_id: USERS.admin.id, actor_display_name: USERS.admin.display_name, note_id: NOTE_IDS.noReplies, comment_id: null, daf_ref_key: 'Chullin-89a', segment_ref: 'Chullin 89a.1', preview: 'Mentioned you here.', read: false, created_at: isoMinutesAgo(6) },
      // Already read, and belonging to someone else: neither may be counted.
      { id: 'n0000000-0000-4000-8000-000000000005', user_id: USERS.ordinary.id, type: 'reply', actor_id: USERS.author.id, actor_display_name: USERS.author.display_name, note_id: NOTE_IDS.largeThread, comment_id: null, daf_ref_key: 'Chullin-89a', segment_ref: 'Chullin 89a.1', preview: 'An older one.', read: true, created_at: isoMinutesAgo(120) },
      { id: 'n0000000-0000-4000-8000-000000000006', user_id: USERS.author.id, type: 'reply', actor_id: USERS.ordinary.id, actor_display_name: USERS.ordinary.display_name, note_id: NOTE_IDS.deepThread, comment_id: null, daf_ref_key: 'Chullin-89a', segment_ref: 'Chullin 89a.1', preview: 'OTHER-ACCOUNT-CANARY', read: false, created_at: isoMinutesAgo(5) },
    ],
    reports: [],
    highlights: [],
    favorites: [],
    progress: [],
    preferences: [],
  };
}
