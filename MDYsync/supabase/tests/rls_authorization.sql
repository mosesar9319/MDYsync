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
do $$ begin raise notice 'ALL AUTHORIZATION TESTS PASSED'; end $$;
