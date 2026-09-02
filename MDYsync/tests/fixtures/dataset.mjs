// Fixture data for the Cloud Chaburah / notes regression suite.
//
// Shapes mirror the LIVE Supabase schema as inspected on 2026-09-02 (see
// docs/PHASE1_CLOUD_CHABURA_AUDIT.md §2). Where the redesign plan calls for a
// fixture the current schema cannot express yet -- a highlighted answer, an
// author soft-delete distinct from moderator `hidden`, per-thread read state --
// that fixture is deliberately absent and noted in the audit rather than faked,
// so these tests keep describing the system that actually exists today.

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
  };
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
    note({ id: NOTE_IDS.deepThread, body: 'Root of a four-level reply chain.', category: 'question', created_at: isoMinutesAgo(50) }),
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

  // 320 replies: above the plan's 300+ performance fixture threshold.
  for (let i = 0; i < 320; i += 1) {
    comments.push(comment({
      id: `d${String(i).padStart(7, '0')}-0000-4000-8000-000000000000`,
      note_id: NOTE_IDS.largeThread,
      body: `Bulk reply number ${i}.`,
      created_at: isoMinutesAgo(70 - i / 100),
    }));
  }

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
    reactions: [
      { id: 'e0000000-0000-4000-8000-000000000001', user_id: USERS.ordinary.id, target_type: 'note', target_id: NOTE_IDS.singleWordRange, reaction_type: 'helpful', created_at: isoMinutesAgo(9) },
      { id: 'e0000000-0000-4000-8000-000000000002', user_id: USERS.admin.id, target_type: 'note', target_id: NOTE_IDS.singleWordRange, reaction_type: 'insightful', created_at: isoMinutesAgo(8) },
      { id: 'e0000000-0000-4000-8000-000000000003', user_id: USERS.ordinary.id, target_type: 'note', target_id: NOTE_IDS.multiRefWordRange, reaction_type: 'chazak', created_at: isoMinutesAgo(7) },
    ],
    thread_follows: [
      { user_id: USERS.ordinary.id, note_id: NOTE_IDS.deepThread, created_at: isoMinutesAgo(6) },
    ],
    notifications: [],
    reports: [],
    highlights: [],
    favorites: [],
    progress: [],
    preferences: [],
  };
}
