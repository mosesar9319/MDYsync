-- Adversarial authorization tests for the Cloud Chabura schema.
--
-- These exist because the Playwright suite CANNOT prove authorization: it
-- replaces supabase-js with an in-memory stub that answers every query as a
-- trusted caller and has no RLS (see tests/README.md). Permission behaviour
-- has to be exercised against a real Postgres as the real roles.
--
-- Every check runs as `anon` or `authenticated` with a real JWT subject, the
-- same way PostgREST connects -- including calling SECURITY DEFINER functions
-- directly, which is what a caller bypassing the UI would do.
--
-- Run: see supabase/README.md. Any failure raises and aborts with ON_ERROR_STOP.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- Harness
-- ---------------------------------------------------------------------------
create schema if not exists dafsync_test;

-- Runs one statement as a given role/subject and reports what happened,
-- instead of aborting. The EXCEPTION block opens a subtransaction, so a
-- rejected statement leaves the surrounding session usable.
create or replace function dafsync_test.attempt(p_role text, p_uid text, p_sql text)
returns text language plpgsql as $$
begin
  perform set_config('role', p_role, true);
  perform set_config('request.jwt.claim.sub', coalesce(p_uid, ''), true);
  execute p_sql;
  perform set_config('role', 'postgres', true);
  return 'OK';
exception when others then
  perform set_config('role', 'postgres', true);
  return sqlstate;
end $$;

-- Like attempt(), but reports how many rows the statement actually touched.
-- Necessary because RLS does not make a forbidden UPDATE *fail* -- it makes it
-- match zero rows and succeed, which attempt() reports as 'OK' exactly like a
-- real one. Any test asserting "X may not modify Y" has to look at the count.
create or replace function dafsync_test.attempt_rows(p_role text, p_uid text, p_sql text)
returns text language plpgsql as $$
declare v_count integer;
begin
  perform set_config('role', p_role, true);
  perform set_config('request.jwt.claim.sub', coalesce(p_uid, ''), true);
  execute p_sql;
  get diagnostics v_count = row_count;
  perform set_config('role', 'postgres', true);
  return v_count::text;
exception when others then
  perform set_config('role', 'postgres', true);
  return sqlstate;
end $$;

-- Reads a single value as a given role/subject.
create or replace function dafsync_test.read_as(p_role text, p_uid text, p_sql text)
returns text language plpgsql as $$
declare v_result text;
begin
  perform set_config('role', p_role, true);
  perform set_config('request.jwt.claim.sub', coalesce(p_uid, ''), true);
  execute p_sql into v_result;
  perform set_config('role', 'postgres', true);
  return v_result;
exception when others then
  perform set_config('role', 'postgres', true);
  return 'ERROR:' || sqlstate;
end $$;

create or replace function dafsync_test.check(p_label text, p_actual text, p_expected text)
returns void language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'FAIL: % (expected %, got %)', p_label, p_expected, p_actual;
  end if;
  raise notice 'pass: %', p_label;
end $$;

-- Personas, matching supabase/baseline/01_seed_representative_data.sql.
\set reader   '''11111111-1111-4111-8111-111111111111'''
\set author   '''22222222-2222-4222-8222-222222222222'''
\set newbie   '''33333333-3333-4333-8333-333333333333'''
\set admin    '''44444444-4444-4444-8444-444444444444'''
\set private_note '''a0000000-0000-4000-8000-000000000008'''
\set hidden_note  '''a0000000-0000-4000-8000-000000000009'''
\set open_note    '''a0000000-0000-4000-8000-000000000004'''
\set deep_note    '''a0000000-0000-4000-8000-000000000005'''
\set hidden_reply '''c0000000-0000-4000-8000-000000000002'''
\set deep_reply   '''b0000000-0000-4000-8000-000000000001'''

-- Statements written at the top level of this file are fixture setup, not
-- assertions, and run as postgres. Give the session an admin JWT subject so
-- moderation guards (line_notes_guard_hidden, the admin-only RPCs) behave as
-- they would for a real moderator. Every actual assertion goes through
-- attempt()/read_as(), which set their own role and subject locally and
-- therefore ignore this.
select set_config('request.jwt.claim.sub', '44444444-4444-4444-8444-444444444444', false);

-- ===========================================================================
-- 1. Anonymous callers
-- ===========================================================================
select dafsync_test.check(
  'anon cannot see a private note',
  dafsync_test.read_as('anon', null, 'select count(*)::text from public.line_notes where is_private'),
  '0');

select dafsync_test.check(
  'anon cannot see a moderator-hidden note',
  dafsync_test.read_as('anon', null, format('select count(*)::text from public.line_notes where id = %L', :hidden_note)),
  '0');

select dafsync_test.check(
  'anon can read public notes',
  dafsync_test.read_as('anon', null, 'select count(*)::text from public.line_notes'),
  '3');

select dafsync_test.check(
  'anon cannot read profiles at all',
  dafsync_test.read_as('anon', null, 'select count(*)::text from public.profiles'),
  '0');

-- The new public identity surface: readable, but only the safe columns exist.
select dafsync_test.check(
  'anon can read public_profiles display names',
  dafsync_test.read_as('anon', null, 'select count(*)::text from public.public_profiles where display_name is not null'),
  '4');

select dafsync_test.check(
  'anon cannot select email through public_profiles',
  dafsync_test.read_as('anon', null, 'select email from public.public_profiles limit 1'),
  'ERROR:42703');  -- undefined_column

select dafsync_test.check(
  'anon cannot write through the auto-updatable public_profiles view',
  dafsync_test.attempt('anon', null, 'update public.public_profiles set display_name = ''pwned'''),
  '42501');  -- insufficient_privilege

select dafsync_test.check(
  'anon cannot insert a note',
  dafsync_test.attempt('anon', null, format(
    'insert into public.line_notes (author_id, author_display_name, daf_ref_key, segment_ref, body) values (%L, ''x'', ''Chullin-89a'', ''Chullin 89a.1'', ''nope'')', :author)),
  '42501');

select dafsync_test.check(
  'anon cannot execute set_note_hidden',
  dafsync_test.attempt('anon', null, format('select public.set_note_hidden(%L, true)', :open_note)),
  '42501');

select dafsync_test.check(
  'anon cannot execute resolve_report',
  dafsync_test.attempt('anon', null, 'select public.resolve_report(gen_random_uuid(), ''resolved'')'),
  '42501');

select dafsync_test.check(
  'anon cannot execute set_comment_hidden',
  dafsync_test.attempt('anon', null, format('select public.set_comment_hidden(%L, false)', :hidden_reply)),
  '42501');

-- ===========================================================================
-- 2. Ordinary signed-in caller who owns nothing here
-- ===========================================================================
select dafsync_test.check(
  'signed-in non-owner cannot see another user''s private note',
  dafsync_test.read_as('authenticated', :author, format('select count(*)::text from public.line_notes where id = %L', :private_note)),
  '0');

select dafsync_test.check(
  'signed-in non-owner cannot read another user''s profile row',
  dafsync_test.read_as('authenticated', :reader, format('select count(*)::text from public.profiles where id = %L', :admin)),
  '0');

-- The heart of the SECURITY DEFINER question: these RPCs are reachable by any
-- signed-in caller, so the function's own is_admin() check is the only thing
-- standing between a normal user and moderating the site.
select dafsync_test.check(
  'non-admin calling set_note_hidden is REJECTED, not silently ignored',
  dafsync_test.attempt('authenticated', :reader, format('select public.set_note_hidden(%L, true)', :open_note)),
  '42501');

select dafsync_test.check(
  'non-admin calling set_comment_hidden is REJECTED',
  dafsync_test.attempt('authenticated', :reader, format('select public.set_comment_hidden(%L, false)', :hidden_reply)),
  '42501');

select dafsync_test.check(
  'non-admin calling resolve_report is REJECTED',
  dafsync_test.attempt('authenticated', :reader, 'select public.resolve_report(gen_random_uuid(), ''resolved'')'),
  '42501');

select dafsync_test.check(
  'the rejected set_note_hidden left the note visible',
  dafsync_test.read_as('anon', null, format('select hidden::text from public.line_notes where id = %L', :open_note)),
  'false');

-- A brand-new account is blocked from posting publicly by can_post_publicly().
select dafsync_test.check(
  'an account younger than 24h cannot post publicly',
  dafsync_test.attempt('authenticated', :newbie, format(
    'insert into public.line_notes (author_id, author_display_name, daf_ref_key, segment_ref, body, is_private) values (%L, ''New Account'', ''Chullin-89a'', ''Chullin 89a.1'', ''too new'', false)', :newbie)),
  '42501');

select dafsync_test.check(
  'the same new account CAN save a private note',
  dafsync_test.attempt('authenticated', :newbie, format(
    'insert into public.line_notes (author_id, author_display_name, daf_ref_key, segment_ref, body, is_private) values (%L, ''New Account'', ''Chullin-89a'', ''Chullin 89a.1'', ''private is fine'', true)', :newbie)),
  'OK');

-- ---------------------------------------------------------------------------
-- Posting replies. These are the checks whose absence let a total outage ship:
-- every INSERT into `comments` failed in production with 42P17 (infinite
-- recursion in the comments_insert policy) from 2026-09-01 until the
-- 20260902183000 hotfix, and nothing caught it because the browser suite
-- stubs the database out entirely.
-- ---------------------------------------------------------------------------
select dafsync_test.check(
  'an established account CAN post a top-level reply',
  dafsync_test.attempt('authenticated', :reader, format(
    'insert into public.comments (note_id, author_id, author_display_name, body) values (%L, %L, ''Reader One'', ''a top-level reply'')',
    :deep_note, :reader)),
  'OK');

select dafsync_test.check(
  'an established account CAN post a nested reply',
  dafsync_test.attempt('authenticated', :reader, format(
    'insert into public.comments (note_id, author_id, author_display_name, body, parent_comment_id) values (%L, %L, ''Reader One'', ''a nested reply'', %L)',
    :deep_note, :reader, :deep_reply)),
  'OK');

select dafsync_test.check(
  'nobody can post a reply as someone else',
  dafsync_test.attempt('authenticated', :reader, format(
    'insert into public.comments (note_id, author_id, author_display_name, body) values (%L, %L, ''Author Two'', ''spoofed'')',
    :deep_note, :author)),
  '42501');

select dafsync_test.check(
  'nobody can reply to a private note they do not own',
  dafsync_test.attempt('authenticated', :author, format(
    'insert into public.comments (note_id, author_id, author_display_name, body) values (%L, %L, ''Author Two'', ''into a private thread'')',
    :private_note, :author)),
  '42501');

select dafsync_test.check(
  'nobody can reply to a moderator-hidden note',
  dafsync_test.attempt('authenticated', :reader, format(
    'insert into public.comments (note_id, author_id, author_display_name, body) values (%L, %L, ''Reader One'', ''into a hidden thread'')',
    :hidden_note, :reader)),
  '42501');

select dafsync_test.check(
  'a brand-new account cannot post a reply',
  dafsync_test.attempt('authenticated', :newbie, format(
    'insert into public.comments (note_id, author_id, author_display_name, body) values (%L, %L, ''New Account'', ''too new to reply'')',
    :deep_note, :newbie)),
  '42501');

-- ===========================================================================
-- 3. Owner-only tables added in this migration
-- ===========================================================================
insert into public.thread_read_state (user_id, note_id, last_read_sequence)
values ('11111111-1111-4111-8111-111111111111', 'a0000000-0000-4000-8000-000000000005', 5);

select dafsync_test.check(
  'a reader sees their own read state',
  dafsync_test.read_as('authenticated', :reader, 'select count(*)::text from public.thread_read_state'),
  '1');

select dafsync_test.check(
  'another user cannot see that read state',
  dafsync_test.read_as('authenticated', :author, 'select count(*)::text from public.thread_read_state'),
  '0');

-- Stronger than "returns no rows": anon has no grant on this table at all, so
-- the request is refused outright rather than filtered by RLS.
select dafsync_test.check(
  'anon is refused thread_read_state outright (no grant, not merely no rows)',
  dafsync_test.read_as('anon', null, 'select count(*)::text from public.thread_read_state'),
  'ERROR:42501');

select dafsync_test.check(
  'anon is refused bookmarks outright',
  dafsync_test.read_as('anon', null, 'select count(*)::text from public.bookmarks'),
  'ERROR:42501');

select dafsync_test.check(
  'a reader cannot bookmark a private note they do not own',
  dafsync_test.attempt('authenticated', :author, format(
    'insert into public.bookmarks (user_id, target_type, target_id) values (%L, ''note'', %L)', :author, :private_note)),
  '42501');

select dafsync_test.check(
  'a reader CAN bookmark a public note',
  dafsync_test.attempt('authenticated', :author, format(
    'insert into public.bookmarks (user_id, target_type, target_id) values (%L, ''note'', %L)', :author, :open_note)),
  'OK');

select dafsync_test.check(
  'a reader cannot bookmark on someone else''s behalf',
  dafsync_test.attempt('authenticated', :author, format(
    'insert into public.bookmarks (user_id, target_type, target_id) values (%L, ''note'', %L)', :reader, :open_note)),
  '42501');

-- ===========================================================================
-- 4. Admin
-- ===========================================================================
select dafsync_test.check(
  'admin CAN hide a note through the RPC',
  dafsync_test.attempt('authenticated', :admin, format('select public.set_note_hidden(%L, true)', :open_note)),
  'OK');

select dafsync_test.check(
  'the note is now hidden from anon',
  dafsync_test.read_as('anon', null, format('select count(*)::text from public.line_notes where id = %L', :open_note)),
  '0');

select dafsync_test.check(
  'admin can still see the hidden note for moderation',
  dafsync_test.read_as('authenticated', :admin, format('select count(*)::text from public.line_notes where id = %L', :open_note)),
  '1');

select dafsync_test.check(
  'admin CANNOT read a private note belonging to someone else',
  dafsync_test.read_as('authenticated', :admin, format('select count(*)::text from public.line_notes where id = %L', :private_note)),
  '0');

-- Put it back so later checks see a normal thread.
select public.set_note_hidden('a0000000-0000-4000-8000-000000000004', false);

-- ===========================================================================
-- 5. Structural integrity enforced server-side, not by the client
-- ===========================================================================
select dafsync_test.check(
  'a reply cannot claim a parent in a different thread',
  dafsync_test.attempt('authenticated', :reader, format(
    'insert into public.comments (note_id, author_id, author_display_name, body, parent_comment_id) values (%L, %L, ''Reader One'', ''cross thread'', %L)',
    :open_note, :reader, :deep_reply)),
  '23514');

select dafsync_test.check(
  'a reply cannot quote a comment from a different thread',
  dafsync_test.attempt('authenticated', :reader, format(
    'insert into public.comments (note_id, author_id, author_display_name, body, quoted_comment_id) values (%L, %L, ''Reader One'', ''cross quote'', %L)',
    :open_note, :reader, :deep_reply)),
  '23514');

select dafsync_test.check(
  'a reply cannot be re-parented after the fact (the only way to form a cycle)',
  dafsync_test.attempt('authenticated', :reader, format(
    'update public.comments set parent_comment_id = %L where id = %L', :deep_reply, :deep_reply)),
  '23514');

-- depth and root_comment_id are server-derived: whatever the client sends is
-- discarded, so a caller cannot flatten or forge the tree.
insert into public.comments (id, note_id, author_id, author_display_name, body, parent_comment_id, depth, root_comment_id)
values ('e0000000-0000-4000-8000-00000000000f', 'a0000000-0000-4000-8000-000000000005',
        '11111111-1111-4111-8111-111111111111', 'Reader One', 'client lies about depth',
        'b0000000-0000-4000-8000-000000000002', 99, 'a0000000-0000-4000-8000-000000000004');

select dafsync_test.check(
  'server overrides a client-supplied depth',
  (select depth::text from public.comments where id = 'e0000000-0000-4000-8000-00000000000f'),
  '2');

select dafsync_test.check(
  'server overrides a client-supplied root_comment_id',
  (select substr(root_comment_id::text, 1, 8) from public.comments where id = 'e0000000-0000-4000-8000-00000000000f'),
  'b0000000');

-- ===========================================================================
-- 6. Highlighted answer, lock, soft delete, monotonic read state
-- ===========================================================================
select dafsync_test.check(
  'a highlighted answer must belong to the same thread',
  dafsync_test.attempt('authenticated', :author, format(
    'update public.line_notes set highlighted_comment_id = %L where id = %L', :deep_reply, :open_note)),
  '23514');

update public.line_notes set highlighted_comment_id = 'b0000000-0000-4000-8000-000000000001'
  where id = 'a0000000-0000-4000-8000-000000000005';

select dafsync_test.check(
  'hiding the highlighted reply clears the pointer automatically',
  (select coalesce(highlighted_comment_id::text, 'cleared')
   from public.line_notes where id = 'a0000000-0000-4000-8000-000000000005'),
  'b0000000-0000-4000-8000-000000000001');

select public.set_comment_hidden('b0000000-0000-4000-8000-000000000001', true);

select dafsync_test.check(
  'after hiding, the thread no longer advertises an answer',
  (select coalesce(highlighted_comment_id::text, 'cleared')
   from public.line_notes where id = 'a0000000-0000-4000-8000-000000000005'),
  'cleared');

select public.set_comment_hidden('b0000000-0000-4000-8000-000000000001', false);

-- Locking a thread stops new replies but leaves it readable.
update public.line_notes set status = 'locked' where id = 'a0000000-0000-4000-8000-000000000004';

select dafsync_test.check(
  'a locked thread accepts no new replies',
  dafsync_test.attempt('authenticated', :reader, format(
    'insert into public.comments (note_id, author_id, author_display_name, body) values (%L, %L, ''Reader One'', ''after lock'')',
    :open_note, :reader)),
  '42501');

select dafsync_test.check(
  'a locked thread is still readable',
  dafsync_test.read_as('anon', null, format('select count(*)::text from public.line_notes where id = %L', :open_note)),
  '1');

update public.line_notes set status = 'open' where id = 'a0000000-0000-4000-8000-000000000004';

-- Soft delete redacts server-side rather than relying on the client to hide it.
update public.line_notes set deleted_at = now() where id = 'a0000000-0000-4000-8000-000000000006';

select dafsync_test.check(
  'soft-deleting a note redacts its body in the database',
  dafsync_test.read_as('anon', null, 'select body from public.line_notes where id = ''a0000000-0000-4000-8000-000000000006'''),
  '[deleted]');

select dafsync_test.check(
  'replies under a soft-deleted note survive as a tombstoned thread',
  dafsync_test.read_as('anon', null, 'select count(*)::text from public.comments where note_id = ''a0000000-0000-4000-8000-000000000006'' and not hidden'),
  '2');

-- Read state must never rewind: an old permalink or a late request cannot
-- un-read newer replies.
update public.thread_read_state set last_read_sequence = 9
  where user_id = '11111111-1111-4111-8111-111111111111';
update public.thread_read_state set last_read_sequence = 2
  where user_id = '11111111-1111-4111-8111-111111111111';

select dafsync_test.check(
  'read state never moves backwards',
  (select last_read_sequence::text from public.thread_read_state
   where user_id = '11111111-1111-4111-8111-111111111111'),
  '9');

-- ===========================================================================
-- Prompt 4: the write paths the thread reader added.
--
-- The Playwright suite drives these through a stub with NO row-level security,
-- so it can only prove the UI calls them. Whether a reader is ALLOWED to do
-- them is decided here, against a real Postgres with real roles.
-- ===========================================================================

-- Editing ------------------------------------------------------------------

select dafsync_test.check(
  'an author may edit their own reply',
  dafsync_test.attempt_rows('authenticated', :reader,
    format('update public.comments set body = ''edited by owner'', edited_at = now() where id = %L', :deep_reply)),
  '1');

select dafsync_test.check(
  'a non-author''s edit of someone else''s reply matches zero rows',
  dafsync_test.attempt_rows('authenticated', :author,
    format('update public.comments set body = ''hijacked'' where id = %L', :deep_reply)),
  '0');

select dafsync_test.check(
  'the edit by the non-author did not land',
  dafsync_test.read_as('anon', null, format('select body from public.comments where id = %L', :deep_reply)),
  'edited by owner');

select dafsync_test.check(
  'anon may not edit any reply',
  dafsync_test.attempt_rows('anon', null,
    format('update public.comments set body = ''anon was here'' where id = %L', :deep_reply)),
  '0');

-- Soft delete --------------------------------------------------------------

select dafsync_test.check(
  'an author may soft-delete their own reply',
  dafsync_test.attempt_rows('authenticated', :reader,
    format('update public.comments set deleted_at = now() where id = %L', :deep_reply)),
  '1');

select dafsync_test.check(
  'soft-deleting a reply redacts its body server-side, not merely in the UI',
  dafsync_test.read_as('anon', null, format('select body from public.comments where id = %L', :deep_reply)),
  '[deleted]');

select dafsync_test.check(
  'the tombstoned reply is still readable, so descendants stay connected',
  dafsync_test.read_as('anon', null, format('select count(*)::text from public.comments where id = %L', :deep_reply)),
  '1');

-- The invariant that matters is reachability of the whole branch, not a direct
-- child count (earlier tests in this file add children of their own). The seed
-- chain runs six levels deep beneath this reply.
select dafsync_test.check(
  'the deepest descendant of a soft-deleted reply is still readable',
  dafsync_test.read_as('anon', null,
    'select body from public.comments where id = ''b0000000-0000-4000-8000-000000000006'''),
  'Reply at level 5.');

select dafsync_test.check(
  'no descendant was redacted along with its deleted ancestor',
  dafsync_test.read_as('anon', null,
    format('select count(*)::text from public.comments where root_comment_id = %L and body = ''[deleted]''', :deep_reply)),
  '1');

-- Highlighted answer -------------------------------------------------------
-- The reply used below is a fresh, visible one on the open note.
insert into public.comments (id, note_id, author_id, author_display_name, body)
values ('b0000000-0000-4000-8000-00000000000a', :open_note, :reader, 'Reader One', 'A candidate answer.');

select dafsync_test.check(
  'the root author may mark a reply as the answer',
  dafsync_test.attempt_rows('authenticated', :author,
    format('update public.line_notes set highlighted_comment_id = %L where id = %L',
           'b0000000-0000-4000-8000-00000000000a', :open_note)),
  '1');

select dafsync_test.check(
  'the answer pointer is actually stored',
  dafsync_test.read_as('anon', null,
    format('select highlighted_comment_id::text from public.line_notes where id = %L', :open_note)),
  'b0000000-0000-4000-8000-00000000000a');

select dafsync_test.check(
  'a reader who is neither author nor admin matches zero rows marking an answer',
  dafsync_test.attempt_rows('authenticated', :newbie,
    format('update public.line_notes set highlighted_comment_id = null where id = %L', :open_note)),
  '0');

select dafsync_test.check(
  'and the answer they tried to clear is still set',
  dafsync_test.read_as('anon', null,
    format('select highlighted_comment_id::text from public.line_notes where id = %L', :open_note)),
  'b0000000-0000-4000-8000-00000000000a');

select dafsync_test.check(
  'an admin may change the highlighted answer',
  dafsync_test.attempt_rows('authenticated', :admin,
    format('update public.line_notes set highlighted_comment_id = null where id = %L', :open_note)),
  '1');

-- A reply from a DIFFERENT thread must be refused: the pointer is validated
-- server-side, so a crafted request cannot make one thread advertise another
-- thread's reply as its answer.
select dafsync_test.check(
  'a reply from another thread cannot be marked as this thread''s answer',
  dafsync_test.attempt_rows('authenticated', :author,
    format('update public.line_notes set highlighted_comment_id = %L where id = %L', :deep_reply, :open_note)),
  '23514');

-- Status -------------------------------------------------------------------

select dafsync_test.check(
  'the root author may resolve their own discussion',
  dafsync_test.attempt_rows('authenticated', :author,
    format('update public.line_notes set status = ''resolved'' where id = %L', :open_note)),
  '1');

-- Resolved is not locked: the plan is explicit that a question can be settled
-- without shutting the conversation down.
select dafsync_test.check(
  'a resolved discussion still accepts replies',
  dafsync_test.attempt('authenticated', :reader,
    format('insert into public.comments (note_id, author_id, author_display_name, body) values (%L, %L, ''Reader One'', ''Still talking.'')', :open_note, :reader)),
  'OK');

select dafsync_test.check(
  'an unrelated reader matches zero rows changing a discussion''s status',
  dafsync_test.attempt_rows('authenticated', :newbie,
    format('update public.line_notes set status = ''locked'' where id = %L', :open_note)),
  '0');

select dafsync_test.check(
  'an invalid status value is refused',
  dafsync_test.attempt_rows('authenticated', :author,
    format('update public.line_notes set status = ''archived'' where id = %L', :open_note)),
  '23514');

-- Quoting ------------------------------------------------------------------

select dafsync_test.check(
  'a quote may point at a reply in the same thread',
  dafsync_test.attempt('authenticated', :reader,
    format('insert into public.comments (note_id, author_id, author_display_name, body, quoted_comment_id, quoted_excerpt) values (%L, %L, ''Reader One'', ''Quoting.'', %L, ''An excerpt.'')',
           :open_note, :reader, 'b0000000-0000-4000-8000-00000000000a')),
  'OK');

select dafsync_test.check(
  'an over-long quote excerpt is refused rather than silently truncated',
  dafsync_test.attempt('authenticated', :reader,
    format('insert into public.comments (note_id, author_id, author_display_name, body, quoted_excerpt) values (%L, %L, ''Reader One'', ''Quoting.'', %L)',
           :open_note, :reader, repeat('x', 501))),
  '23514');

-- Bookmarks ----------------------------------------------------------------

select dafsync_test.check(
  'a reader may save a thread for themselves',
  dafsync_test.attempt('authenticated', :reader,
    format('insert into public.bookmarks (user_id, target_type, target_id) values (%L, ''note'', %L)', :reader, :open_note)),
  'OK');

select dafsync_test.check(
  'a reader may not save a thread on someone else''s behalf',
  dafsync_test.attempt('authenticated', :reader,
    format('insert into public.bookmarks (user_id, target_type, target_id) values (%L, ''note'', %L)', :author, :open_note)),
  '42501');

select dafsync_test.check(
  'a reader cannot read another reader''s saved threads',
  dafsync_test.read_as('authenticated', :author,
    format('select count(*)::text from public.bookmarks where user_id = %L', :reader)),
  '0');

-- read_as() prefixes a failure with ERROR:, unlike attempt() which returns the
-- bare sqlstate. 42501 here is stronger than "zero rows": anon has no grant on
-- the table at all, so the request is refused outright.
select dafsync_test.check(
  'anon cannot read saved threads at all',
  dafsync_test.read_as('anon', null, 'select count(*)::text from public.bookmarks'),
  'ERROR:42501');

-- Locking ------------------------------------------------------------------

select dafsync_test.check(
  'the root author may lock their discussion',
  dafsync_test.attempt_rows('authenticated', :author,
    format('update public.line_notes set status = ''locked'' where id = %L', :open_note)),
  '1');

select dafsync_test.check(
  'a locked discussion refuses new replies server-side',
  dafsync_test.attempt('authenticated', :reader,
    format('insert into public.comments (note_id, author_id, author_display_name, body) values (%L, %L, ''Reader One'', ''Sneaking in.'')', :open_note, :reader)),
  '42501');

select dafsync_test.check(
  'a locked discussion is still readable',
  dafsync_test.read_as('anon', null, format('select count(*)::text from public.line_notes where id = %L', :open_note)),
  '1');

-- ===========================================================================
-- Prompt 6: notifications and per-reply saves.
--
-- The notifications panel groups rows and marks them read from the browser, so
-- what matters here is that a reader can only ever see and clear their OWN --
-- the stub has no RLS and would happily serve everyone's.
-- ===========================================================================

insert into public.notifications
  (id, user_id, type, actor_id, actor_display_name, note_id, daf_ref_key, segment_ref, preview)
values
  ('d1000000-0000-4000-8000-000000000001', :reader, 'reply', :author, 'Author Two',
   :open_note, 'Chullin-89a', 'Chullin 89a.1', 'A reply for the reader.'),
  ('d1000000-0000-4000-8000-000000000002', :author, 'reply', :reader, 'Reader One',
   :open_note, 'Chullin-89a', 'Chullin 89a.1', 'A reply for the author.');

-- Scoped to the two rows inserted just above: the seed already carries
-- notifications of its own, so an unqualified count would be measuring the
-- fixture rather than the policy.
select dafsync_test.check(
  'a reader sees only their own of the two just written',
  dafsync_test.read_as('authenticated', :reader,
    'select count(*)::text from public.notifications where id in (''d1000000-0000-4000-8000-000000000001'', ''d1000000-0000-4000-8000-000000000002'')'),
  '1');

select dafsync_test.check(
  'and the one they see is theirs',
  dafsync_test.read_as('authenticated', :reader,
    'select preview from public.notifications where id in (''d1000000-0000-4000-8000-000000000001'', ''d1000000-0000-4000-8000-000000000002'')'),
  'A reply for the reader.');

select dafsync_test.check(
  'the other account sees only its own of the same two',
  dafsync_test.read_as('authenticated', :author,
    'select preview from public.notifications where id in (''d1000000-0000-4000-8000-000000000001'', ''d1000000-0000-4000-8000-000000000002'')'),
  'A reply for the author.');

select dafsync_test.check(
  'a reader cannot mark someone else''s notification read',
  dafsync_test.attempt_rows('authenticated', :reader,
    format('update public.notifications set read = true where id = %L', 'd1000000-0000-4000-8000-000000000002')),
  '0');

select dafsync_test.check(
  'the other account''s notification is still unread',
  dafsync_test.read_as('authenticated', :author,
    format('select read::text from public.notifications where id = %L', 'd1000000-0000-4000-8000-000000000002')),
  'false');

select dafsync_test.check(
  'a reader CAN mark their own notification read',
  dafsync_test.attempt_rows('authenticated', :reader,
    format('update public.notifications set read = true where id = %L', 'd1000000-0000-4000-8000-000000000001')),
  '1');

select dafsync_test.check(
  'a reader cannot delete someone else''s notification',
  dafsync_test.attempt_rows('authenticated', :reader,
    format('delete from public.notifications where id = %L', 'd1000000-0000-4000-8000-000000000002')),
  '0');

-- Weaker than bookmarks and thread_read_state, which anon has no grant on at
-- all and which therefore fail with 42501. notifications DOES grant select to
-- anon and relies on RLS (auth.uid() = user_id) to return nothing, since
-- auth.uid() is null for anon. Safe, but safe by one mechanism rather than two,
-- so it is asserted as what it actually is rather than what would be tidier.
select dafsync_test.check(
  'anon reads no notifications (filtered to empty by RLS, not refused outright)',
  dafsync_test.read_as('anon', null, 'select count(*)::text from public.notifications'),
  '0');

-- Saving an individual reply ------------------------------------------------
-- bookmarks has carried target_type='comment' since Phase 2; Prompt 6 is the
-- first thing to write one, so the ownership rules get their own coverage.

select dafsync_test.check(
  'a reader may save an individual reply',
  dafsync_test.attempt('authenticated', :reader,
    format('insert into public.bookmarks (user_id, target_type, target_id) values (%L, ''comment'', %L)',
           :reader, 'b0000000-0000-4000-8000-00000000000a')),
  'OK');

select dafsync_test.check(
  'a saved reply is not visible to another account',
  dafsync_test.read_as('authenticated', :author,
    format('select count(*)::text from public.bookmarks where target_type = ''comment'' and target_id = %L',
           'b0000000-0000-4000-8000-00000000000a')),
  '0');

select dafsync_test.check(
  'a reader cannot save a reply on someone else''s behalf',
  dafsync_test.attempt('authenticated', :reader,
    format('insert into public.bookmarks (user_id, target_type, target_id) values (%L, ''comment'', %L)',
           :author, 'b0000000-0000-4000-8000-00000000000a')),
  '42501');

-- 42501, not the 23514 the CHECK constraint would give: bookmarks_insert_own
-- enumerates the valid target types itself AND requires the target to exist and
-- be visible to this reader, so the policy refuses first. Stronger than the
-- constraint alone, which is why it is asserted as the policy's answer.
select dafsync_test.check(
  'an invalid bookmark target type is refused by the policy, before the constraint',
  dafsync_test.attempt('authenticated', :reader,
    format('insert into public.bookmarks (user_id, target_type, target_id) values (%L, ''daf'', %L)',
           :reader, :open_note)),
  '42501');

select dafsync_test.check(
  'a reply that does not exist cannot be saved',
  dafsync_test.attempt('authenticated', :reader,
    format('insert into public.bookmarks (user_id, target_type, target_id) values (%L, ''comment'', %L)',
           :reader, 'b0000000-0000-4000-8000-0000000000ff')),
  '42501');

select dafsync_test.check(
  'a reply on a private note belonging to someone else cannot be saved',
  dafsync_test.attempt('authenticated', :author,
    format('insert into public.bookmarks (user_id, target_type, target_id) values (%L, ''comment'', %L)',
           :author, :hidden_reply)),
  '42501');

-- ===========================================================================
do $$ begin raise notice 'ALL AUTHORIZATION TESTS PASSED'; end $$;
