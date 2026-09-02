-- Representative pre-migration data for validating Phase 2's backfill and the
-- adversarial RLS tests. Mirrors the fixture personas in tests/fixtures/dataset.mjs
-- so the SQL-side and browser-side suites describe the same world.
--
-- Deliberately includes the shapes the backfill has to get right:
--   * a note with no replies at all
--   * a six-deep reply chain (deeper than notes.js's MAX_REPLY_DEPTH of 4,
--     because that constant caps indentation, not storage -- see the migration)
--   * a private note that must never surface publicly
--   * a moderator-hidden reply that still has a visible descendant
--   * replies created out of id order, so activity_sequence must come from
--     created_at rather than insertion order

insert into auth.users (id, email, created_at) values
  ('11111111-1111-4111-8111-111111111111', 'reader@example.test',  now() - interval '30 days'),
  ('22222222-2222-4222-8222-222222222222', 'author@example.test',  now() - interval '30 days'),
  ('33333333-3333-4333-8333-333333333333', 'newbie@example.test',  now() - interval '30 hours'),
  ('44444444-4444-4444-8444-444444444444', 'admin@example.test',   now() - interval '30 days');

-- handle_new_user() created the profiles rows; set display names and flag the admin.
update public.profiles set display_name = 'Reader One' where id = '11111111-1111-4111-8111-111111111111';
update public.profiles set display_name = 'Author Two' where id = '22222222-2222-4222-8222-222222222222';
update public.profiles set display_name = 'New Account' where id = '33333333-3333-4333-8333-333333333333';
update public.profiles set display_name = 'Admin Four' where id = '44444444-4444-4444-8444-444444444444';

-- handle_new_user() defaults profiles.created_at to now(), so without this
-- every persona looks brand new and can_post_publicly()'s 24h rule blocks
-- them all -- including the ones that are supposed to be established.
update public.profiles set created_at = now() - interval '30 days'
  where id in (
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '44444444-4444-4444-8444-444444444444'
  );
update public.profiles set created_at = now() - interval '30 minutes'
  where id = '33333333-3333-4333-8333-333333333333';

insert into public.line_notes
  (id, author_id, author_display_name, daf_ref_key, segment_ref, body, is_private, hidden, category, created_at)
values
  ('a0000000-0000-4000-8000-000000000004', '22222222-2222-4222-8222-222222222222', 'Author Two',
   'Chullin-89a', 'Chullin 89a.1', 'A thread with no replies at all.', false, false, 'source', now() - interval '40 hours'),
  ('a0000000-0000-4000-8000-000000000005', '22222222-2222-4222-8222-222222222222', 'Author Two',
   'Chullin-89a', 'Chullin 89a.1', 'Root of a deep reply chain.', false, false, 'question', now() - interval '50 hours'),
  ('a0000000-0000-4000-8000-000000000006', '22222222-2222-4222-8222-222222222222', 'Author Two',
   'Chullin-89a', 'Chullin 89a.1', 'Root whose middle reply is moderator-hidden.', false, false, 'answer', now() - interval '60 hours'),
  ('a0000000-0000-4000-8000-000000000008', '11111111-1111-4111-8111-111111111111', 'Reader One',
   'Chullin-89a', 'Chullin 89a.1', 'PRIVATE-CANARY private note body.', true, false, null, now() - interval '5 hours'),
  ('a0000000-0000-4000-8000-000000000009', '22222222-2222-4222-8222-222222222222', 'Author Two',
   'Chullin-89a', 'Chullin 89a.1', 'HIDDEN-NOTE-CANARY moderator-hidden note.', false, true, null, now() - interval '70 hours');

-- A six-level chain. Inserted deepest-id-first on purpose so nothing can pass
-- by relying on insertion order instead of the parent walk.
insert into public.comments (id, note_id, author_id, author_display_name, body, created_at, parent_comment_id) values
  ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000005',
   '11111111-1111-4111-8111-111111111111', 'Reader One', 'Reply at level 0.', now() - interval '49 hours', null),
  ('b0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000005',
   '11111111-1111-4111-8111-111111111111', 'Reader One', 'Reply at level 1.', now() - interval '48 hours', 'b0000000-0000-4000-8000-000000000001'),
  ('b0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000005',
   '11111111-1111-4111-8111-111111111111', 'Reader One', 'Reply at level 2.', now() - interval '47 hours', 'b0000000-0000-4000-8000-000000000002'),
  ('b0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000005',
   '11111111-1111-4111-8111-111111111111', 'Reader One', 'Reply at level 3.', now() - interval '46 hours', 'b0000000-0000-4000-8000-000000000003'),
  ('b0000000-0000-4000-8000-000000000005', 'a0000000-0000-4000-8000-000000000005',
   '11111111-1111-4111-8111-111111111111', 'Reader One', 'Reply at level 4.', now() - interval '45 hours', 'b0000000-0000-4000-8000-000000000004'),
  ('b0000000-0000-4000-8000-000000000006', 'a0000000-0000-4000-8000-000000000005',
   '11111111-1111-4111-8111-111111111111', 'Reader One', 'Reply at level 5.', now() - interval '44 hours', 'b0000000-0000-4000-8000-000000000005'),
  -- A second top-level branch on the same thread.
  ('b0000000-0000-4000-8000-000000000007', 'a0000000-0000-4000-8000-000000000005',
   '44444444-4444-4444-8444-444444444444', 'Admin Four', 'A second top-level branch.', now() - interval '43 hours', null);

-- Hidden middle reply that still has a visible descendant beneath it.
insert into public.comments (id, note_id, author_id, author_display_name, body, hidden, created_at, parent_comment_id) values
  ('c0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000006',
   '11111111-1111-4111-8111-111111111111', 'Reader One', 'Visible top reply.', false, now() - interval '59 hours', null),
  ('c0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000006',
   '11111111-1111-4111-8111-111111111111', 'Reader One', 'HIDDEN-CANARY moderator-hidden reply.', true, now() - interval '58 hours', 'c0000000-0000-4000-8000-000000000001'),
  ('c0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000006',
   '11111111-1111-4111-8111-111111111111', 'Reader One', 'Descendant of a hidden reply.', false, now() - interval '57 hours', 'c0000000-0000-4000-8000-000000000002');

insert into public.reactions (user_id, target_type, target_id, reaction_type) values
  ('11111111-1111-4111-8111-111111111111', 'note', 'a0000000-0000-4000-8000-000000000005', 'helpful'),
  ('44444444-4444-4444-8444-444444444444', 'note', 'a0000000-0000-4000-8000-000000000005', 'insightful');
