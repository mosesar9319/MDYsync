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
-- Prompt 7: every SECURITY DEFINER function reachable over PostgREST, called
-- directly as anon and as an ordinary authenticated user.
--
-- "UI hiding is not security." resolve_report, set_note_hidden and
-- set_comment_hidden are covered above. These are the remaining three that a
-- browser can call: is_admin and can_post_publicly (granted to anon AND
-- authenticated) and comment_is_in_note (authenticated only). Each is a
-- SECURITY DEFINER function running as its owner, so each is worth calling
-- directly rather than trusting that only our own code calls it.
-- ===========================================================================

select dafsync_test.check(
  'is_admin() is false for anon',
  dafsync_test.read_as('anon', null, 'select public.is_admin()::text'),
  'false');

select dafsync_test.check(
  'is_admin() is false for an ordinary authenticated user',
  dafsync_test.read_as('authenticated', :reader, 'select public.is_admin()::text'),
  'false');

select dafsync_test.check(
  'is_admin() is true only for the admin',
  dafsync_test.read_as('authenticated', :admin, 'select public.is_admin()::text'),
  'true');

select dafsync_test.check(
  'can_post_publicly() is false for anon',
  dafsync_test.read_as('anon', null, 'select public.can_post_publicly()::text'),
  'false');

select dafsync_test.check(
  'can_post_publicly() is false for an account younger than a day',
  dafsync_test.read_as('authenticated', :newbie, 'select public.can_post_publicly()::text'),
  'false');

select dafsync_test.check(
  'can_post_publicly() is true for an established account',
  dafsync_test.read_as('authenticated', :reader, 'select public.can_post_publicly()::text'),
  'true');

-- comment_is_in_note is the helper the reply-recursion hotfix introduced. It
-- answers one boolean about a pair of ids the caller must already hold, and it
-- must not become a way to probe threads a reader cannot see.
select dafsync_test.check(
  'anon cannot call comment_is_in_note at all',
  dafsync_test.read_as('anon', null,
    format('select public.comment_is_in_note(%L, %L)::text', :deep_reply, :deep_note)),
  'ERROR:42501');

select dafsync_test.check(
  'comment_is_in_note answers truthfully for a pair the caller already holds',
  dafsync_test.read_as('authenticated', :reader,
    format('select public.comment_is_in_note(%L, %L)::text', :deep_reply, :deep_note)),
  'true');

select dafsync_test.check(
  'comment_is_in_note says false for a mismatched pair rather than erroring',
  dafsync_test.read_as('authenticated', :reader,
    format('select public.comment_is_in_note(%L, %L)::text', :deep_reply, :open_note)),
  'false');

-- The trigger functions must remain uncallable: they were revoked from PUBLIC
-- in the Prompt 1 grant tightening, and a regression there would hand any
-- browser a SECURITY DEFINER function that writes rows.
select dafsync_test.check(
  'authenticated cannot call the new-user trigger function',
  dafsync_test.read_as('authenticated', :reader, 'select public.handle_new_user()::text'),
  'ERROR:42501');

select dafsync_test.check(
  'authenticated cannot call the mention-validation trigger function',
  dafsync_test.read_as('authenticated', :reader, 'select public.validate_mentions()::text'),
  'ERROR:42501');

select dafsync_test.check(
  'anon cannot call the hidden-note guard trigger function',
  dafsync_test.read_as('anon', null, 'select public.line_notes_guard_hidden()::text'),
  'ERROR:42501');

-- ===========================================================================
-- 10. Generated thread summaries (Phase 8)
-- ===========================================================================
--
-- The summary tables are written ONLY by the service role, from the Netlify
-- function that holds the provider credential. Every check below is about a
-- browser -- anon or an ordinary signed-in reader -- and what it can do when
-- it talks to PostgREST directly instead of using the UI.

-- Fixture, created as postgres exactly as the service role would. One summary
-- on the public deep thread, citing two live replies and the moderator-hidden
-- one, so redaction has something real to bite on.
\set summary_a '''d0000000-0000-4000-8000-000000000001'''
\set summary_private '''d0000000-0000-4000-8000-000000000002'''
\set point_live '''e0000000-0000-4000-8000-000000000001'''
\set point_cites_hidden '''e0000000-0000-4000-8000-000000000002'''

insert into public.thread_summaries
  (id, note_id, prompt_version, model_id, source_comment_ids, source_comment_count, source_max_sequence)
values
  (:summary_a, :deep_note, 'chabura-thread-v1', 'test-model',
   array[:deep_reply::uuid, 'b0000000-0000-4000-8000-000000000007'::uuid], 2,
   (select max(activity_sequence) from public.comments where note_id = :deep_note)),
  (:summary_private, :private_note, 'chabura-thread-v1', 'test-model',
   array[:deep_reply::uuid], 1, 0);

insert into public.thread_summary_points (id, summary_id, position, body, source_comment_ids) values
  (:point_live, :summary_a, 0, 'A point resting on a live reply.', array[:deep_reply::uuid]),
  (:point_cites_hidden, :summary_a, 1, 'CANARY-SUMMARY point resting on a reply a moderator will hide.',
   array['b0000000-0000-4000-8000-000000000007'::uuid]);

-- --- Traceability is a constraint, not a convention ------------------------
select dafsync_test.check(
  'a summary point with no sources cannot be stored at all',
  dafsync_test.attempt('postgres', null, format(
    'insert into public.thread_summary_points (summary_id, position, body, source_comment_ids)
     values (%L, 9, ''uncited'', ''{}''::uuid[])', :summary_a)),
  '23514');  -- check_violation

-- --- What a browser may read ----------------------------------------------
select dafsync_test.check(
  'anon can read a summary of a public thread',
  dafsync_test.read_as('anon', null, format(
    'select count(*)::text from public.thread_summaries where id = %L', :summary_a)),
  '1');

select dafsync_test.check(
  'anon cannot read a summary of a private thread',
  dafsync_test.read_as('anon', null, format(
    'select count(*)::text from public.thread_summaries where id = %L', :summary_private)),
  '0');

select dafsync_test.check(
  'a signed-in reader cannot read a summary of someone else''s private thread',
  dafsync_test.read_as('authenticated', :reader, format(
    'select count(*)::text from public.thread_summaries where id = %L', :summary_private)),
  '0');

-- The base points table is not granted to a browser at all: the redaction
-- lives in the view, so reaching the table would side-step it.
select dafsync_test.check(
  'anon cannot select the summary points base table',
  dafsync_test.read_as('anon', null, 'select count(*)::text from public.thread_summary_points'),
  'ERROR:42501');

select dafsync_test.check(
  'a signed-in reader cannot select the summary points base table either',
  dafsync_test.read_as('authenticated', :reader, 'select count(*)::text from public.thread_summary_points'),
  'ERROR:42501');

select dafsync_test.check(
  'anon reads summary points through the projection view',
  dafsync_test.read_as('anon', null, format(
    'select count(*)::text from public.thread_summary_points_public where summary_id = %L', :summary_a)),
  '2');

-- --- Nothing in a browser may write a summary ------------------------------
select dafsync_test.check(
  'anon cannot insert a summary',
  dafsync_test.attempt('anon', null, format(
    'insert into public.thread_summaries (note_id, prompt_version, model_id, source_comment_ids,
     source_comment_count, source_max_sequence) values (%L, ''x'', ''x'', ''{}''::uuid[], 0, 0)', :open_note)),
  '42501');

select dafsync_test.check(
  'a signed-in reader cannot insert a summary',
  dafsync_test.attempt('authenticated', :reader, format(
    'insert into public.thread_summaries (note_id, prompt_version, model_id, source_comment_ids,
     source_comment_count, source_max_sequence) values (%L, ''x'', ''x'', ''{}''::uuid[], 0, 0)', :open_note)),
  '42501');

-- RLS narrows an UPDATE to zero rows rather than refusing it, so this asks how
-- many rows actually changed -- see attempt_rows()'s header.
select dafsync_test.check(
  'a signed-in reader cannot rewrite a summary''s text',
  dafsync_test.attempt_rows('authenticated', :reader, format(
    'update public.thread_summaries set stale = false, model_id = ''pwned'' where id = %L', :summary_a)),
  '42501');

select dafsync_test.check(
  'a signed-in reader cannot delete a summary',
  dafsync_test.attempt_rows('authenticated', :reader, format(
    'delete from public.thread_summaries where id = %L', :summary_a)),
  '42501');

-- Unlike public_profiles -- a single-table view, and therefore auto-updatable
-- and needing an explicit REVOKE to stop writes going straight through it --
-- this one joins three tables, so Postgres refuses to make it writable at all
-- (55000, object_not_in_prerequisite_state). Asserted so a later simplification
-- of the view cannot quietly turn it into a write path.
select dafsync_test.check(
  'the projection view is not writable at all',
  dafsync_test.attempt('authenticated', :reader,
    'update public.thread_summary_points_public set body = ''pwned'''),
  '55000');

-- --- Feedback is private to its author -------------------------------------
select dafsync_test.check(
  'a reader may record their own feedback',
  dafsync_test.attempt('authenticated', :reader, format(
    'insert into public.thread_summary_feedback (summary_id, user_id, verdict) values (%L, %L, ''useful'')',
    :summary_a, :reader)),
  'OK');

select dafsync_test.check(
  'the tally is maintained server-side',
  dafsync_test.read_as('anon', null, format(
    'select useful_count::text from public.thread_summaries where id = %L', :summary_a)),
  '1');

select dafsync_test.check(
  'a reader cannot see who else voted',
  dafsync_test.read_as('authenticated', :author,
    'select count(*)::text from public.thread_summary_feedback'),
  '0');

select dafsync_test.check(
  'a reader cannot vote on someone else''s behalf',
  dafsync_test.attempt('authenticated', :author, format(
    'insert into public.thread_summary_feedback (summary_id, user_id, verdict) values (%L, %L, ''not_useful'')',
    :summary_a, :reader)),
  '42501');

-- --- Moderator overrides ---------------------------------------------------
select dafsync_test.check(
  'anon cannot call the summary moderation function',
  dafsync_test.read_as('anon', null, format(
    'select public.moderate_thread_summary(%L, true, ''nope'')::text', :summary_a)),
  'ERROR:42501');

select dafsync_test.check(
  'an ordinary reader cannot hide a summary',
  dafsync_test.read_as('authenticated', :reader, format(
    'select public.moderate_thread_summary(%L, true, ''nope'')::text', :summary_a)),
  'ERROR:42501');

select dafsync_test.check(
  'an ordinary reader cannot rewrite a summary point',
  dafsync_test.read_as('authenticated', :reader, format(
    'select public.moderate_thread_summary_point(%L, false, ''pwned'')::text', :point_live)),
  'ERROR:42501');

-- Returns void, which read_as() reports as an empty string; anything else
-- would be an error code.
select dafsync_test.check(
  'a moderator can rewrite a summary point',
  dafsync_test.read_as('authenticated', :admin, format(
    'select public.moderate_thread_summary_point(%L, false, ''Reworded by a moderator.'')::text',
    :point_live)),
  '');

select dafsync_test.check(
  'the projection view serves the moderator''s wording',
  dafsync_test.read_as('anon', null, format(
    'select body from public.thread_summary_points_public where id = %L', :point_live)),
  'Reworded by a moderator.');

select dafsync_test.check(
  'the moderator edit is flagged as such',
  dafsync_test.read_as('anon', null, format(
    'select moderator_edited::text from public.thread_summary_points_public where id = %L', :point_live)),
  'true');

-- --- Moderation of a REPLY invalidates the points that rested on it --------
-- This is the acceptance criterion "hidden/private content cannot be
-- recovered through summaries", tested at the only layer that can enforce it.
select dafsync_test.attempt('postgres', :admin,
  'update public.comments set hidden = true where id = ''b0000000-0000-4000-8000-000000000007''');

select dafsync_test.check(
  'hiding a reply redacts every summary point that cited it',
  dafsync_test.read_as('anon', null, format(
    'select redacted::text from public.thread_summary_points_public where id = %L', :point_cites_hidden)),
  'true');

select dafsync_test.check(
  'a redacted point serves no text at all',
  dafsync_test.read_as('anon', null, format(
    'select coalesce(body, ''<null>'') from public.thread_summary_points_public where id = %L', :point_cites_hidden)),
  '<null>');

select dafsync_test.check(
  'a redacted point serves no sources either',
  dafsync_test.read_as('anon', null, format(
    'select cardinality(source_comment_ids)::text from public.thread_summary_points_public where id = %L',
    :point_cites_hidden)),
  '0');

select dafsync_test.check(
  'the point that did not cite the hidden reply is untouched',
  dafsync_test.read_as('anon', null, format(
    'select redacted::text from public.thread_summary_points_public where id = %L', :point_live)),
  'false');

select dafsync_test.check(
  'hiding a cited reply marks the whole summary stale',
  dafsync_test.read_as('anon', null, format(
    'select stale::text from public.thread_summaries where id = %L', :summary_a)),
  'true');

-- A hard DELETE has no foreign key to cascade through a uuid[], so the
-- delete trigger is the only thing standing between a removed reply and a
-- summary that still quotes it.
select dafsync_test.attempt('postgres', :admin, format(
  'delete from public.comments where id = %L', :deep_reply));

select dafsync_test.check(
  'deleting a reply outright redacts the points that cited it',
  dafsync_test.read_as('anon', null, format(
    'select redacted::text from public.thread_summary_points_public where id = %L', :point_live)),
  'true');

-- --- A thread leaving public view takes its summary with it ---------------
select dafsync_test.attempt('postgres', :admin, format(
  'update public.line_notes set is_private = true where id = %L', :deep_note));

select dafsync_test.check(
  'making a thread private deletes its summary rather than merely hiding it',
  dafsync_test.read_as('postgres', null, format(
    'select count(*)::text from public.thread_summaries where id = %L', :summary_a)),
  '0');

select dafsync_test.check(
  'and its points go with it',
  dafsync_test.read_as('postgres', null, format(
    'select count(*)::text from public.thread_summary_points where summary_id = %L', :summary_a)),
  '0');

-- ===========================================================================
-- note_documents -- imported notes are private to the account that imported
-- them, with no way in for anyone else.
--
-- This table has no public-read and no admin-read policy, which makes it the
-- only table here where "an admin cannot see it either" is itself a rule
-- worth holding. line_notes deliberately lets an admin read non-private
-- notes so they can be moderated; nothing in note_documents is ever public,
-- so there is nothing to moderate and no reason to grant a path.
-- ===========================================================================

\set doc_reader '''d0000000-0000-4000-8000-000000000001'''
\set doc_author '''d0000000-0000-4000-8000-000000000002'''

insert into public.note_documents (id, owner_id, title, source_kind, full_text)
values
  (:doc_reader, '11111111-1111-4111-8111-111111111111',
   'Reader One''s private notebook', 'paste', 'chullin shechita notes'),
  (:doc_author, '22222222-2222-4222-8222-222222222222',
   'Author Two''s private notebook', 'txt', 'berachos notes');

-- --- Reading --------------------------------------------------------------
select dafsync_test.check(
  'the owner reads their own document',
  dafsync_test.read_as('authenticated', '11111111-1111-4111-8111-111111111111',
    format('select title from public.note_documents where id = %L', :doc_reader)),
  'Reader One''s private notebook');

select dafsync_test.check(
  'another signed-in reader cannot see it at all',
  dafsync_test.read_as('authenticated', '22222222-2222-4222-8222-222222222222',
    format('select count(*)::text from public.note_documents where id = %L', :doc_reader)),
  '0');

-- 42501, not an empty result: anon holds no table privilege here at all
-- (see the migration's grant block), so it is stopped before RLS is even
-- consulted. Every other table in this schema grants anon SELECT and lets
-- RLS filter; this one deliberately does not.
select dafsync_test.check(
  'anon is refused at the table, not merely filtered by RLS',
  dafsync_test.read_as('anon', null,
    format('select count(*)::text from public.note_documents where id = %L', :doc_reader)),
  'ERROR:42501');

-- The rule this table exists to hold: privacy here is not moderator-visible.
select dafsync_test.check(
  'an admin cannot read someone else''s document',
  dafsync_test.read_as('authenticated', '44444444-4444-4444-8444-444444444444',
    format('select count(*)::text from public.note_documents where id = %L', :doc_reader)),
  '0');

select dafsync_test.check(
  'a reader listing documents sees only their own',
  dafsync_test.read_as('authenticated', '11111111-1111-4111-8111-111111111111',
    'select count(*)::text from public.note_documents'),
  '1');

-- --- Writing --------------------------------------------------------------
select dafsync_test.check(
  'anon cannot import a document',
  dafsync_test.attempt('anon', null,
    'insert into public.note_documents (owner_id, title, source_kind, full_text)
     values (''11111111-1111-4111-8111-111111111111'', ''x'', ''paste'', ''y'')'),
  '42501');

-- The insert policy is WITH CHECK (auth.uid() = owner_id), so a client that
-- names someone else as the owner is rejected outright rather than silently
-- creating a document in their library.
select dafsync_test.check(
  'a reader cannot import a document into someone else''s library',
  dafsync_test.attempt('authenticated', '11111111-1111-4111-8111-111111111111',
    'insert into public.note_documents (owner_id, title, source_kind, full_text)
     values (''22222222-2222-4222-8222-222222222222'', ''planted'', ''paste'', ''y'')'),
  '42501');

-- RLS makes a forbidden UPDATE match zero rows rather than fail, so this has
-- to count rows, not just check for an error (see attempt_rows).
select dafsync_test.check(
  'a reader cannot rename someone else''s document',
  dafsync_test.attempt_rows('authenticated', '11111111-1111-4111-8111-111111111111',
    format('update public.note_documents set title = ''seized'' where id = %L', :doc_author)),
  '0');

select dafsync_test.check(
  'a reader cannot read someone else''s text by rewriting it',
  dafsync_test.attempt_rows('authenticated', '11111111-1111-4111-8111-111111111111',
    format('update public.note_documents set full_text = ''overwritten'' where id = %L', :doc_author)),
  '0');

-- The update policy carries WITH CHECK as well as USING, so an owner cannot
-- hand their own document to another account on the way past the policy.
select dafsync_test.check(
  'an owner cannot reassign their document to another account',
  dafsync_test.attempt('authenticated', '11111111-1111-4111-8111-111111111111',
    format('update public.note_documents set owner_id = ''22222222-2222-4222-8222-222222222222'' where id = %L', :doc_reader)),
  '42501');

select dafsync_test.check(
  'a reader cannot delete someone else''s document',
  dafsync_test.attempt_rows('authenticated', '11111111-1111-4111-8111-111111111111',
    format('delete from public.note_documents where id = %L', :doc_author)),
  '0');

select dafsync_test.check(
  'an admin cannot delete someone else''s document either',
  dafsync_test.attempt_rows('authenticated', '44444444-4444-4444-8444-444444444444',
    format('delete from public.note_documents where id = %L', :doc_author)),
  '0');

select dafsync_test.check(
  'the owner can rename their own document',
  dafsync_test.attempt_rows('authenticated', '11111111-1111-4111-8111-111111111111',
    format('update public.note_documents set title = ''Renamed'' where id = %L', :doc_reader)),
  '1');

select dafsync_test.check(
  'the owner can delete their own document',
  dafsync_test.attempt_rows('authenticated', '22222222-2222-4222-8222-222222222222',
    format('delete from public.note_documents where id = %L', :doc_author)),
  '1');

-- --- Size ceiling ---------------------------------------------------------
-- octet_length, not char_length: a Hebrew character costs two bytes, so a
-- character-based cap would let a Hebrew import weigh twice an English one.
-- This proves the constraint counts bytes by feeding it 300k Hebrew
-- characters -- comfortably under any character limit, 600k bytes and so
-- over this one.
select dafsync_test.check(
  'an over-size import is refused rather than truncated',
  dafsync_test.attempt('authenticated', '11111111-1111-4111-8111-111111111111',
    'insert into public.note_documents (owner_id, title, source_kind, full_text)
     values (''11111111-1111-4111-8111-111111111111'', ''huge'', ''paste'', repeat(''א'', 300000))'),
  '23514');

-- --- Search ---------------------------------------------------------------
-- The generated tsvector is what makes an imported document findable at all;
-- if it stopped being populated the Documents search would silently return
-- nothing rather than fail.
select dafsync_test.check(
  'document text is searchable by its owner',
  dafsync_test.read_as('authenticated', '11111111-1111-4111-8111-111111111111',
    format('select count(*)::text from public.note_documents
            where id = %L and full_text_tsv @@ websearch_to_tsquery(''simple'', ''shechita'')', :doc_reader)),
  '1');

-- The rename above changed this document's title from "...private notebook"
-- to "Renamed". That the OLD title is no longer findable, and the new one is,
-- proves the generated column is recomputed on update rather than only
-- populated at insert -- which is what keeps a renamed document findable by
-- the name it now has.
select dafsync_test.check(
  'a renamed document is no longer findable by its old title',
  dafsync_test.read_as('authenticated', '11111111-1111-4111-8111-111111111111',
    format('select count(*)::text from public.note_documents
            where id = %L and full_text_tsv @@ websearch_to_tsquery(''simple'', ''notebook'')', :doc_reader)),
  '0');

select dafsync_test.check(
  'and is findable by its new one, through the same column as its text',
  dafsync_test.read_as('authenticated', '11111111-1111-4111-8111-111111111111',
    format('select count(*)::text from public.note_documents
            where id = %L and full_text_tsv @@ websearch_to_tsquery(''simple'', ''Renamed'')', :doc_reader)),
  '1');

-- ===========================================================================
-- line_notes.source_document_id -- citing an imported document from a note.
--
-- The column is provenance only: the excerpt itself is copied into
-- line_notes.body when the note is written, and note_documents stays as
-- unreadable to everyone but its owner as it was before. What needs proving
-- here is that the link cannot be forged (a note citing a document its
-- author does not own), and that it cannot be used as a side channel into a
-- table the reader has no other way into.
-- ===========================================================================

\set doc_cited  '''d0000000-0000-4000-8000-000000000003'''
\set note_cited '''a0000000-0000-4000-8000-00000000000a'''
\set note_open  '''a0000000-0000-4000-8000-00000000000b'''

-- A fresh document rather than one of the two above: those have been renamed
-- and hard-deleted by the tests preceding this section, and a test that
-- depends on the mutations of an earlier test breaks the moment either is
-- reordered.
insert into public.note_documents (id, owner_id, title, source_kind, full_text)
values (:doc_cited, '11111111-1111-4111-8111-111111111111',
        'Reader One''s cited notebook', 'paste', 'a passage worth quoting on the daf');

-- --- Forging the link -----------------------------------------------------

select dafsync_test.check(
  'an author can cite a document they imported themselves',
  dafsync_test.attempt_rows('authenticated', '11111111-1111-4111-8111-111111111111',
    format('insert into public.line_notes
              (id, author_id, author_display_name, daf_ref_key, segment_ref, body, is_private, source_document_id)
            values (%L, ''11111111-1111-4111-8111-111111111111'', ''Reader One'',
                    ''Chullin-89a'', ''Chullin 89a.1'', ''An excerpt from my notebook.'', true, %L)',
           :note_cited, :doc_cited)),
  '1');

-- P0001, the trigger's own raise, NOT 23503: the foreign key alone would
-- happily accept another account's document, since it only asks whether the
-- row exists. This is the check that makes the column mean what it says.
select dafsync_test.check(
  'a note cannot cite a document belonging to someone else',
  dafsync_test.attempt('authenticated', '22222222-2222-4222-8222-222222222222',
    format('insert into public.line_notes
              (author_id, author_display_name, daf_ref_key, segment_ref, body, is_private, source_document_id)
            values (''22222222-2222-4222-8222-222222222222'', ''Author Two'',
                    ''Chullin-89a'', ''Chullin 89a.1'', ''Quoting a file I cannot read.'', true, %L)',
           :doc_cited)),
  'P0001');

-- The trigger runs BEFORE the foreign key is checked, so a made-up id is
-- stopped by ownership rather than by referential integrity. Asserted so the
-- order stays deliberate: the ownership rule is the one that must never be
-- reachable around.
select dafsync_test.check(
  'a note cannot cite a document that does not exist',
  dafsync_test.attempt('authenticated', '11111111-1111-4111-8111-111111111111',
    'insert into public.line_notes
       (author_id, author_display_name, daf_ref_key, segment_ref, body, is_private, source_document_id)
     values (''11111111-1111-4111-8111-111111111111'', ''Reader One'',
             ''Chullin-89a'', ''Chullin 89a.1'', ''Citing nothing.'', true,
             ''d0000000-0000-4000-8000-0000000000ff'')'),
  'P0001');

-- The trigger is BEFORE INSERT OR UPDATE, not INSERT alone: an update is the
-- obvious way to retarget an already-accepted note at a document its author
-- does not own.
select dafsync_test.check(
  'an existing note cannot be retargeted at someone else''s document',
  dafsync_test.attempt('authenticated', '22222222-2222-4222-8222-222222222222',
    format('update public.line_notes set source_document_id = %L where id = %L',
           :doc_cited, :open_note)),
  'P0001');

-- The column is nullable and almost every note leaves it so; the trigger has
-- to let an uncited note through untouched rather than treating null as a
-- failed lookup.
select dafsync_test.check(
  'a note citing nothing is unaffected by the check',
  dafsync_test.attempt_rows('authenticated', '11111111-1111-4111-8111-111111111111',
    'insert into public.line_notes
       (author_id, author_display_name, daf_ref_key, segment_ref, body, is_private)
     values (''11111111-1111-4111-8111-111111111111'', ''Reader One'',
             ''Chullin-89a'', ''Chullin 89a.1'', ''An ordinary note.'', true)'),
  '1');

-- --- The link is not a way into the document ------------------------------

select dafsync_test.check(
  'an author can share a note that was excerpted from a private document',
  dafsync_test.attempt_rows('authenticated', '11111111-1111-4111-8111-111111111111',
    format('insert into public.line_notes
              (id, author_id, author_display_name, daf_ref_key, segment_ref, body, is_private, source_document_id)
            values (%L, ''11111111-1111-4111-8111-111111111111'', ''Reader One'',
                    ''Chullin-89a'', ''Chullin 89a.1'', ''SHARED-EXCERPT from my notebook.'', false, %L)',
           :note_open, :doc_cited)),
  '1');

-- The point of the previous insert. Another reader gets the note -- which is
-- what sharing means -- and the id of its source, and that is the end of the
-- road: note_documents has no policy that admits them.
select dafsync_test.check(
  'another reader can read the shared note itself',
  dafsync_test.read_as('authenticated', '22222222-2222-4222-8222-222222222222',
    format('select body from public.line_notes where id = %L', :note_open)),
  'SHARED-EXCERPT from my notebook.');

select dafsync_test.check(
  'but cannot follow its citation into the document',
  dafsync_test.read_as('authenticated', '22222222-2222-4222-8222-222222222222',
    format('select count(*)::text from public.note_documents d
            join public.line_notes n on n.source_document_id = d.id
            where n.id = %L', :note_open)),
  '0');

select dafsync_test.check(
  'and neither can an admin',
  dafsync_test.read_as('authenticated', '44444444-4444-4444-8444-444444444444',
    format('select count(*)::text from public.note_documents d
            join public.line_notes n on n.source_document_id = d.id
            where n.id = %L', :note_open)),
  '0');

-- anon is refused by table privileges before RLS is consulted (the migration
-- grants it nothing), so this is an error rather than an empty result.
select dafsync_test.check(
  'anon is refused at the table when following a citation',
  dafsync_test.read_as('anon', null,
    format('select count(*)::text from public.note_documents d
            join public.line_notes n on n.source_document_id = d.id
            where n.id = %L', :note_open)),
  'ERROR:42501');

-- --- Losing the document keeps the note -----------------------------------
--
-- The app soft-deletes, so this path is close to unreachable in normal use;
-- it matters for an account erasure or a hand-run DELETE. The note is the
-- reader's own published writing and must survive -- ON DELETE SET NULL, not
-- CASCADE. Getting this backwards would silently delete notes, possibly
-- public ones with discussions under them, when a private file was removed.
select dafsync_test.check(
  'the owner can hard-delete a document that notes cite',
  dafsync_test.attempt_rows('authenticated', '11111111-1111-4111-8111-111111111111',
    format('delete from public.note_documents where id = %L', :doc_cited)),
  '1');

select dafsync_test.check(
  'the note survives its document being deleted',
  dafsync_test.read_as('authenticated', '11111111-1111-4111-8111-111111111111',
    format('select body from public.line_notes where id = %L', :note_cited)),
  'An excerpt from my notebook.');

select dafsync_test.check(
  'and its citation is cleared rather than left dangling',
  dafsync_test.read_as('authenticated', '11111111-1111-4111-8111-111111111111',
    format('select (source_document_id is null)::text from public.line_notes where id = %L', :note_cited)),
  'true');

-- ===========================================================================
-- note_documents.source_kind -- the file-backed import kinds.
--
-- The point of constraining this column rather than leaving it free text is
-- that the import UI and the table cannot drift apart. These checks are what
-- make that true in both directions: the kinds the UI can now produce are
-- accepted, and one it cannot is still refused.
-- ===========================================================================

select dafsync_test.check(
  'a .docx import is accepted',
  dafsync_test.attempt_rows('authenticated', '11111111-1111-4111-8111-111111111111',
    'insert into public.note_documents (owner_id, title, source_kind, original_filename, full_text)
     values (''11111111-1111-4111-8111-111111111111'', ''From Word'', ''docx'', ''notes.docx'', ''text read out of the docx'')'),
  '1');

select dafsync_test.check(
  'a PDF import is accepted',
  dafsync_test.attempt_rows('authenticated', '11111111-1111-4111-8111-111111111111',
    'insert into public.note_documents (owner_id, title, source_kind, original_filename, full_text)
     values (''11111111-1111-4111-8111-111111111111'', ''From a PDF'', ''pdf'', ''notes.pdf'', ''text read out of the pdf'')'),
  '1');

-- The constraint is still a constraint. A kind the app has no parser for must
-- not become storable just because the list grew.
select dafsync_test.check(
  'a format the app cannot read is still refused',
  dafsync_test.attempt('authenticated', '11111111-1111-4111-8111-111111111111',
    'insert into public.note_documents (owner_id, title, source_kind, full_text)
     values (''11111111-1111-4111-8111-111111111111'', ''From a .doc'', ''doc'', ''x'')'),
  '23514');

-- A file-backed import is no more visible to anyone else than a pasted one:
-- widening source_kind changed what may be STORED, never who may read it.
select dafsync_test.check(
  'another reader still cannot see a .docx import',
  dafsync_test.read_as('authenticated', '22222222-2222-4222-8222-222222222222',
    'select count(*)::text from public.note_documents where source_kind = ''docx'''),
  '0');

select dafsync_test.check(
  'anon is still refused at the table for file-backed imports',
  dafsync_test.read_as('anon', null,
    'select count(*)::text from public.note_documents where source_kind in (''docx'', ''pdf'')'),
  'ERROR:42501');

-- ===========================================================================
do $$ begin raise notice 'ALL AUTHORIZATION TESTS PASSED'; end $$;
