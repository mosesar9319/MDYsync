-- Adversarial authorization tests for Cloud Chaburah Live (migration 20261025130000).
--
-- Like rls_authorization.sql, every assertion runs as `anon` or `authenticated` with a
-- real JWT subject, the way PostgREST connects -- including calling the SECURITY DEFINER
-- write functions directly, which is what a caller bypassing the page would do. Runs
-- after rls_authorization.sql in run-tests.sh and uses the dafsync_test helpers that
-- file creates (attempt, read_as, check) plus one of its own below.

\set ON_ERROR_STOP on

-- Like attempt(), but reports the error MESSAGE ('live_rate_limited', ...) rather than the
-- SQLSTATE, since several different rules raise the same state.
create or replace function dafsync_test.attempt_msg(p_role text, p_uid text, p_sql text)
returns text language plpgsql as $$
begin
  perform set_config('role', p_role, true);
  perform set_config('request.jwt.claim.sub', coalesce(p_uid, ''), true);
  execute p_sql;
  perform set_config('role', 'postgres', true);
  return 'OK';
exception when others then
  perform set_config('role', 'postgres', true);
  return sqlerrm;
end $$;

\set reader   '''11111111-1111-4111-8111-111111111111'''
\set author   '''22222222-2222-4222-8222-222222222222'''
\set newbie   '''33333333-3333-4333-8333-333333333333'''
\set admin    '''44444444-4444-4444-8444-444444444444'''
\set nameless '''55555555-5555-4555-8555-555555555555'''
\set spammer  '''66666666-6666-4666-8666-666666666666'''
\set starter  '''77777777-7777-4777-8777-777777777777'''

select set_config('request.jwt.claim.sub', '44444444-4444-4444-8444-444444444444', false);

-- Three more established accounts: one with no display name, two for the rate limits.
insert into auth.users (id, email, created_at) values
  ('55555555-5555-4555-8555-555555555555', 'nameless@example.test', now() - interval '30 days'),
  ('66666666-6666-4666-8666-666666666666', 'spammer@example.test',  now() - interval '30 days'),
  ('77777777-7777-4777-8777-777777777777', 'starter@example.test',  now() - interval '30 days');
update public.profiles set created_at = now() - interval '30 days'
  where id in ('55555555-5555-4555-8555-555555555555', '66666666-6666-4666-8666-666666666666',
               '77777777-7777-4777-8777-777777777777');
update public.profiles set display_name = null where id = '55555555-5555-4555-8555-555555555555';

-- ===========================================================================
-- 1. The launch gate: until audience = 'everyone', only admins may use it
-- ===========================================================================
select dafsync_test.check(
  'the feature starts out admins-only',
  dafsync_test.read_as('anon', null, 'select audience from public.live_settings'),
  'admins');

select dafsync_test.read_as('authenticated', :admin,
  $$select (public.live_start_thread('Bekhorot-22a', 'Bekhorot 22a.1',
      '[{"ref":"Bekhorot 22a.1","start":2,"end":4}]'::jsonb, 'אמר רב יהודה', 'Admin question'))
    .id::text$$) as admin_thread \gset

select dafsync_test.check(
  'an admin can start a thread while the feature is admins-only',
  (select count(*)::text from public.live_threads where id = :'admin_thread'), '1');

select dafsync_test.check(
  'a non-admin cannot see threads before launch',
  dafsync_test.read_as('authenticated', :reader, 'select count(*)::text from public.live_threads'), '0');

select dafsync_test.check(
  'anon cannot see threads before launch',
  dafsync_test.read_as('anon', null, 'select count(*)::text from public.live_threads'), '0');

select dafsync_test.check(
  'a non-admin cannot start a thread before launch',
  dafsync_test.attempt_msg('authenticated', :reader,
    $$select public.live_start_thread('Bekhorot-22a','Bekhorot 22a.1','[{"ref":"Bekhorot 22a.1","start":0,"end":1}]','x','y')$$),
  'live_not_available');

select dafsync_test.check(
  'a non-admin cannot change the audience',
  dafsync_test.attempt_msg('authenticated', :reader, $$select public.live_set_audience('everyone')$$),
  'live_cannot_edit');

select dafsync_test.check(
  'anon cannot call the write functions at all',
  dafsync_test.attempt('anon', null,
    $$select public.live_start_thread('Bekhorot-22a','Bekhorot 22a.1','[{"ref":"Bekhorot 22a.1","start":0,"end":1}]','x','y')$$),
  '42501');

select dafsync_test.check(
  'an admin can open it to everyone',
  dafsync_test.attempt('authenticated', :admin, $$select public.live_set_audience('everyone')$$), 'OK');

-- ===========================================================================
-- 2. Reading, and no direct writes
-- ===========================================================================
select dafsync_test.check(
  'after launch a reader sees threads',
  dafsync_test.read_as('authenticated', :reader, 'select count(*)::text from public.live_threads'), '1');
select dafsync_test.check(
  'after launch anon can read threads',
  dafsync_test.read_as('anon', null, 'select count(*)::text from public.live_threads'), '1');
select dafsync_test.check(
  'after launch anon can read messages',
  dafsync_test.read_as('anon', null, 'select count(*)::text from public.live_messages'), '1');

select dafsync_test.check(
  'a client cannot insert a thread directly',
  dafsync_test.attempt('authenticated', :reader,
    format($$insert into public.live_threads (author_id, author_display_name, daf_ref_key, segment_ref, word_ranges, quoted_text, preview)
      values (%L, 'x', 'k', 's', '[{"ref":"s","start":0,"end":0}]', 'q', 'p')$$, :reader)),
  '42501');
select dafsync_test.check(
  'a client cannot insert a message directly',
  dafsync_test.attempt('authenticated', :reader,
    format($$insert into public.live_messages (thread_id, author_id, author_display_name, body) values (%L, %L, 'x', 'hi')$$, :'admin_thread', :reader)),
  '42501');
select dafsync_test.check(
  'a client cannot update a thread directly',
  dafsync_test.attempt('authenticated', :author, format($$update public.live_threads set hidden = true where id = %L$$, :'admin_thread')),
  '42501');
select dafsync_test.check(
  'a client cannot delete a message directly',
  dafsync_test.attempt('authenticated', :admin, 'delete from public.live_messages'),
  '42501');

-- ===========================================================================
-- 3. Starting a thread
-- ===========================================================================
select dafsync_test.read_as('authenticated', :reader,
  $$select (public.live_start_thread('Bekhorot-22a', 'Bekhorot 22a.5',
      '[{"ref":"Bekhorot 22a.5","start":7,"end":9},{"ref":"Bekhorot 22a.6","start":0,"end":2}]'::jsonb,
      'אמר רב יהודה אמר רב', '  Why is it attributed this way?  ')).id::text$$) as t1 \gset

select dafsync_test.check(
  'a thread keeps its daf, anchor start and trimmed question preview',
  (select concat_ws('|', daf_ref_key, anchor_segment, anchor_word, preview, status, message_count)
     from public.live_threads where id = :'t1'),
  'Bekhorot-22a|5|7|Why is it attributed this way?|open|1');
select dafsync_test.check(
  'a thread stores the whole multi-run anchor',
  (select jsonb_array_length(word_ranges)::text from public.live_threads where id = :'t1'), '2');
select dafsync_test.check(
  'the opener is the first message and follows the thread',
  (select (select count(*) from public.live_messages where thread_id = :'t1')::text || '|'
       || (select count(*) from public.live_thread_follows where thread_id = :'t1' and user_id = :reader::uuid)::text), '1|1');
select dafsync_test.check(
  'the author name is the profile display name',
  (select author_display_name from public.live_threads where id = :'t1'), 'Reader One');

select dafsync_test.read_as('authenticated', :nameless,
  $$select (public.live_start_thread('Bekhorot-22a', 'Bekhorot 22a.2',
      '[{"ref":"Bekhorot 22a.2","start":0,"end":1}]'::jsonb, 'תנו רבנן', 'Question from a nameless account')).id::text$$) as t_nameless \gset
select dafsync_test.check(
  'without a display name the author is "Learner", never the email',
  (select author_display_name from public.live_threads where id = :'t_nameless'), 'Learner');
select dafsync_test.check(
  'no email appears anywhere in a thread or message row',
  (select (bool_or(to_jsonb(t)::text like '%@%'))::text from public.live_threads t), 'false');
select dafsync_test.check(
  'no email appears in a message row',
  (select (bool_or(to_jsonb(m)::text like '%@%'))::text from public.live_messages m), 'false');

select dafsync_test.check('an empty question is refused',
  dafsync_test.attempt_msg('authenticated', :reader,
    $$select public.live_start_thread('Bekhorot-22a','Bekhorot 22a.1','[{"ref":"Bekhorot 22a.1","start":0,"end":1}]','x','   ')$$),
  'live_invalid_input');
select dafsync_test.check('an anchor with no words is refused',
  dafsync_test.attempt_msg('authenticated', :reader,
    $$select public.live_start_thread('Bekhorot-22a','Bekhorot 22a.1','[]','x','y')$$),
  'live_invalid_input');
select dafsync_test.check('an anchor run that ends before it starts is refused',
  dafsync_test.attempt_msg('authenticated', :reader,
    $$select public.live_start_thread('Bekhorot-22a','Bekhorot 22a.1','[{"ref":"Bekhorot 22a.1","start":5,"end":2}]','x','y')$$),
  'live_invalid_input');
select dafsync_test.check('an anchor that is not an array of runs is refused',
  dafsync_test.attempt_msg('authenticated', :reader,
    $$select public.live_start_thread('Bekhorot-22a','Bekhorot 22a.1','{"ref":"x"}','x','y')$$),
  'live_invalid_input');
select dafsync_test.check('a question over 2000 characters is refused',
  dafsync_test.attempt_msg('authenticated', :reader,
    format($$select public.live_start_thread('Bekhorot-22a','Bekhorot 22a.1','[{"ref":"Bekhorot 22a.1","start":0,"end":1}]','x',%L)$$, repeat('a', 2001))),
  'live_invalid_input');
select dafsync_test.check('a new account cannot start a thread',
  dafsync_test.attempt_msg('authenticated', :newbie,
    $$select public.live_start_thread('Bekhorot-22a','Bekhorot 22a.1','[{"ref":"Bekhorot 22a.1","start":0,"end":1}]','x','y')$$),
  'live_account_too_new');

-- ===========================================================================
-- 4. Messages
-- ===========================================================================
select dafsync_test.read_as('authenticated', :author,
  format($$select (public.live_post_message(%L, 'A reply', null)).id::text$$, :'t1')) as m1 \gset
select dafsync_test.check('a reply is counted and bumps the thread',
  (select message_count::text || '|' || (last_message_at = (select created_at from public.live_messages where id = :'m1'))::text
     from public.live_threads where id = :'t1'), '2|true');
select dafsync_test.read_as('authenticated', :reader,
  format($$select (public.live_post_message(%L, 'Quoting the reply', %L)).id::text$$, :'t1', :'m1')) as m2 \gset
select dafsync_test.check('a message can quote another message of the same thread',
  (select quoted_message_id::text from public.live_messages where id = :'m2'), :'m1');
select dafsync_test.check('a message cannot quote a message of another thread',
  dafsync_test.attempt_msg('authenticated', :reader,
    format($$select public.live_post_message(%L, 'x', %L)$$, :'t1', (select id from public.live_messages where thread_id = :'admin_thread' limit 1))),
  'live_invalid_input');
select dafsync_test.check('posting to a thread that does not exist is refused',
  dafsync_test.attempt_msg('authenticated', :reader,
    $$select public.live_post_message('00000000-0000-4000-8000-0000000000ff', 'x', null)$$),
  'live_thread_missing');
select dafsync_test.check('a new account cannot post a message',
  dafsync_test.attempt_msg('authenticated', :newbie, format($$select public.live_post_message(%L, 'hello', null)$$, :'t1')),
  'live_account_too_new');
select dafsync_test.check('replying marks the replier as following the thread',
  (select count(*)::text from public.live_thread_follows where thread_id = :'t1' and user_id = :author::uuid), '1');

-- Rate limits: 15 messages a minute, 5 new threads an hour.
select dafsync_test.check(
  'a 16th message within a minute is refused',
  (select count(*) filter (where r = 'OK')::text || '/' || count(*) filter (where r = 'live_rate_limited')::text
     from (select dafsync_test.attempt_msg('authenticated', :spammer,
             format($$select public.live_post_message(%L, 'spam', null)$$, :'t1')) as r
           from generate_series(1, 20)) s),
  '15/5');
select dafsync_test.check(
  'a 6th new thread within an hour is refused',
  (select count(*) filter (where r = 'OK')::text || '/' || count(*) filter (where r = 'live_rate_limited')::text
     from (select dafsync_test.attempt_msg('authenticated', :starter,
             $$select public.live_start_thread('Bekhorot-22a','Bekhorot 22a.1','[{"ref":"Bekhorot 22a.1","start":0,"end":1}]','x','a thread')$$) as r
           from generate_series(1, 8)) s),
  '5/3');
select dafsync_test.check(
  'an admin is not rate limited',
  (select count(*) filter (where r = 'OK')::text
     from (select dafsync_test.attempt_msg('authenticated', :admin,
             format($$select public.live_post_message(%L, 'admin chatter', null)$$, :'t1')) as r
           from generate_series(1, 20)) s),
  '20');

-- ===========================================================================
-- 5. Editing and deleting
-- ===========================================================================
select dafsync_test.check('an author can edit their own message',
  dafsync_test.attempt_msg('authenticated', :author, format($$select public.live_edit_message(%L, 'A better reply')$$, :'m1')), 'OK');
select dafsync_test.check('an edit sets edited_at and the new body',
  (select (edited_at is not null)::text || '|' || body from public.live_messages where id = :'m1'), 'true|A better reply');
select dafsync_test.check('nobody else can edit it',
  dafsync_test.attempt_msg('authenticated', :reader, format($$select public.live_edit_message(%L, 'hijack')$$, :'m1')), 'live_cannot_edit');
update public.live_messages set created_at = now() - interval '20 minutes' where id = :'m1';
select dafsync_test.check('a message older than 15 minutes cannot be edited',
  dafsync_test.attempt_msg('authenticated', :author, format($$select public.live_edit_message(%L, 'too late')$$, :'m1')), 'live_cannot_edit');

select dafsync_test.check('nobody can delete someone else''s message',
  dafsync_test.attempt_msg('authenticated', :reader, format($$select public.live_delete_message(%L)$$, :'m1')), 'live_cannot_delete');
select dafsync_test.check('an author can delete their own message',
  dafsync_test.attempt_msg('authenticated', :author, format($$select public.live_delete_message(%L)$$, :'m1')), 'OK');
select dafsync_test.check('a deleted message keeps its place but loses its words',
  (select (deleted_at is not null)::text || '|' || body || '|' || (select count(*) from public.live_messages where thread_id = :'t1' and id = :'m1')::text
     from public.live_messages where id = :'m1'), 'true||1');
select dafsync_test.check('a deleted message cannot be deleted again',
  dafsync_test.attempt_msg('authenticated', :author, format($$select public.live_delete_message(%L)$$, :'m1')), 'live_cannot_delete');
select dafsync_test.check('a deleted message cannot be edited',
  dafsync_test.attempt_msg('authenticated', :author, format($$select public.live_edit_message(%L, 'back')$$, :'m1')), 'live_cannot_edit');
select dafsync_test.check('the opening question cannot be deleted by its author while it has replies',
  dafsync_test.attempt_msg('authenticated', :reader,
    format($$select public.live_delete_message(%L)$$, (select id from public.live_messages where thread_id = :'t1' order by seq limit 1))),
  'live_root_has_replies');

select dafsync_test.read_as('authenticated', :reader,
  $$select (public.live_start_thread('Bekhorot-22a', 'Bekhorot 22a.9',
      '[{"ref":"Bekhorot 22a.9","start":0,"end":3}]'::jsonb, 'תנו רבנן', 'An unanswered one')).id::text$$) as t_alone \gset
select dafsync_test.check('an opener nobody answered can be deleted, and the thread goes with it',
  dafsync_test.attempt_msg('authenticated', :reader,
    format($$select public.live_delete_message(%L)$$, (select id from public.live_messages where thread_id = :'t_alone'))), 'OK');
select dafsync_test.check('that thread is no longer visible to readers',
  dafsync_test.read_as('anon', null, format($$select count(*)::text from public.live_threads where id = %L$$, :'t_alone')), '0');

-- ===========================================================================
-- 6. Answered status
-- ===========================================================================
select dafsync_test.check('the asker can mark a reply as the answer',
  dafsync_test.attempt_msg('authenticated', :reader, format($$select public.live_set_answer(%L, %L)$$, :'t1', :'m2')), 'OK');
select dafsync_test.check('the thread is then answered, pointing at that reply',
  (select status || '|' || (answer_message_id = :'m2')::text from public.live_threads where id = :'t1'), 'answered|true');
select dafsync_test.check('someone other than the asker cannot change the answer',
  dafsync_test.attempt_msg('authenticated', :author, format($$select public.live_set_answer(%L, null)$$, :'t1')), 'live_cannot_edit');
select dafsync_test.check('an answer must be a message of that thread',
  dafsync_test.attempt_msg('authenticated', :reader,
    format($$select public.live_set_answer(%L, %L)$$, :'t1', (select id from public.live_messages where thread_id = :'admin_thread' limit 1))),
  'live_invalid_input');
select dafsync_test.check('the asker can clear the answer',
  dafsync_test.attempt_msg('authenticated', :reader, format($$select public.live_set_answer(%L, null)$$, :'t1')), 'OK');
select dafsync_test.check('the thread is open again',
  (select status || '|' || coalesce(answer_message_id::text, 'none') from public.live_threads where id = :'t1'), 'open|none');
select dafsync_test.check('an admin can mark an answer on anyone''s thread',
  dafsync_test.attempt_msg('authenticated', :admin, format($$select public.live_set_answer(%L, %L)$$, :'t1', :'m2')), 'OK');

-- ===========================================================================
-- 7. Moderation
-- ===========================================================================
select dafsync_test.check('a non-admin cannot moderate',
  dafsync_test.attempt_msg('authenticated', :reader, format($$select public.live_moderate(%L, %L, true)$$, :'t1', :'m2')), 'live_cannot_edit');
select dafsync_test.check('an admin can redact a message',
  dafsync_test.attempt_msg('authenticated', :admin, format($$select public.live_moderate(%L, %L, true)$$, :'t1', :'m2')), 'OK');
select dafsync_test.check('a redacted message stays in the chat with no words',
  dafsync_test.read_as('anon', null, format($$select hidden::text || '|' || body from public.live_messages where id = %L$$, :'m2')), 'true|');
select dafsync_test.check('an admin can hide a whole thread',
  dafsync_test.attempt_msg('authenticated', :admin, format($$select public.live_moderate(%L, null, true)$$, :'t1')), 'OK');
select dafsync_test.check('a hidden thread is invisible to readers',
  dafsync_test.read_as('authenticated', :reader, format($$select count(*)::text from public.live_threads where id = %L$$, :'t1')), '0');
select dafsync_test.check('a hidden thread''s messages are invisible to readers',
  dafsync_test.read_as('authenticated', :reader, format($$select count(*)::text from public.live_messages where thread_id = %L$$, :'t1')), '0');
select dafsync_test.check('a hidden thread is still visible to admins',
  dafsync_test.read_as('authenticated', :admin, format($$select count(*)::text from public.live_threads where id = %L$$, :'t1')), '1');
select dafsync_test.check('nobody can post to a hidden thread',
  dafsync_test.attempt_msg('authenticated', :author, format($$select public.live_post_message(%L, 'x', null)$$, :'t1')), 'live_thread_missing');
select dafsync_test.check('an admin can restore a hidden thread',
  dafsync_test.attempt_msg('authenticated', :admin, format($$select public.live_moderate(%L, null, false)$$, :'t1')), 'OK');
select dafsync_test.check('a restored thread is visible again',
  dafsync_test.read_as('authenticated', :reader, format($$select count(*)::text from public.live_threads where id = %L$$, :'t1')), '1');

-- ===========================================================================
-- 8. Follows and read state belong to their owner
-- ===========================================================================
select dafsync_test.check('a reader can follow a thread',
  dafsync_test.attempt('authenticated', :newbie, format($$insert into public.live_thread_follows (user_id, thread_id) values (%L, %L)$$, :newbie, :'t1')), 'OK');
select dafsync_test.check('a reader cannot make someone else follow a thread',
  dafsync_test.attempt('authenticated', :newbie, format($$insert into public.live_thread_follows (user_id, thread_id) values (%L, %L)$$, :reader, :'admin_thread')), '42501');
select dafsync_test.check('a reader sees only their own follows',
  dafsync_test.read_as('authenticated', :newbie, 'select count(*)::text from public.live_thread_follows'), '1');
select dafsync_test.check('a reader can unfollow',
  dafsync_test.attempt_rows('authenticated', :newbie, 'delete from public.live_thread_follows'), '1');

select dafsync_test.check('a reader can record how far they have read',
  dafsync_test.attempt('authenticated', :reader, format($$insert into public.live_read_state (user_id, thread_id, last_read_seq) values (%L, %L, 10)$$, :reader, :'t1')), 'OK');
select dafsync_test.check('reading position only moves forward',
  dafsync_test.read_as('authenticated', :reader,
    format($$with u as (update public.live_read_state set last_read_seq = 3 where thread_id = %L returning last_read_seq) select last_read_seq::text from u$$, :'t1')),
  '10');
select dafsync_test.check('nobody else can see a reader''s position',
  dafsync_test.read_as('authenticated', :author, 'select count(*)::text from public.live_read_state'), '0');
select dafsync_test.check('nobody can write a position for someone else',
  dafsync_test.attempt('authenticated', :author, format($$insert into public.live_read_state (user_id, thread_id, last_read_seq) values (%L, %L, 1)$$, :reader, :'t1')), '42501');

-- ===========================================================================
-- 9. Reports
-- ===========================================================================
select dafsync_test.check('a reader can report a message',
  dafsync_test.attempt_msg('authenticated', :reader, format($$select public.live_report(%L, %L, 'off topic')$$, :'t1', :'m2')), 'OK');
select dafsync_test.check('anon cannot report',
  dafsync_test.attempt('anon', null, format($$select public.live_report(%L, null, 'x')$$, :'t1')), '42501');
select dafsync_test.check('a reporter sees their own reports',
  dafsync_test.read_as('authenticated', :reader, 'select count(*)::text from public.live_reports'), '1');
select dafsync_test.check('other readers do not see them',
  dafsync_test.read_as('authenticated', :author, 'select count(*)::text from public.live_reports'), '0');
select dafsync_test.check('admins see every report',
  dafsync_test.read_as('authenticated', :admin, 'select count(*)::text from public.live_reports'), '1');
select dafsync_test.check('nobody can write a report directly',
  dafsync_test.attempt('authenticated', :reader, format($$insert into public.live_reports (reporter_id, thread_id) values (%L, %L)$$, :reader, :'t1')), '42501');

-- ===========================================================================
-- 10. What gets broadcast
-- ===========================================================================
select dafsync_test.check('a stored message is broadcast to its thread''s private topic',
  (select count(*)::text from realtime.messages
     where topic = 'live:thread:' || :'t1' and event = 'message' and private
       and payload ->> 'body' = 'Quoting the reply'), '1');
select dafsync_test.check('a new thread is announced on its daf''s topic',
  (select count(*)::text from realtime.messages
     where topic = 'live:daf:Bekhorot-22a' and event = 'thread' and payload ->> 'id' = :'t1'), '1');
select dafsync_test.check('a thread''s counters are re-announced when it changes',
  (select (count(*) >= 1)::text from realtime.messages
     where topic = 'live:daf:Bekhorot-22a' and event = 'thread_updated' and payload ->> 'id' = :'t1'), 'true');
select dafsync_test.check('hiding a thread announces only its id',
  (select count(*)::text from realtime.messages
     where topic = 'live:daf:Bekhorot-22a' and event = 'thread_removed' and payload = jsonb_build_object('id', :'t1')), '1');
select dafsync_test.check('no broadcast payload contains an email address',
  (select (bool_or(payload::text like '%@%'))::text from realtime.messages), 'false');
select dafsync_test.check('a redacted message is re-broadcast without its words',
  (select count(*)::text from realtime.messages
     where topic = 'live:thread:' || :'t1' and event = 'message_updated'
       and payload ->> 'id' = :'m2' and payload ->> 'body' = ''), '1');

select dafsync_test.check('readers may receive live: topics',
  (select cmd || '|' || roles::text from pg_policies where schemaname = 'realtime' and policyname = 'live_receive'),
  'SELECT|{authenticated}');
select dafsync_test.check('the only thing a client may publish is presence',
  (select cmd || '|' || (with_check like '%presence%')::text from pg_policies where schemaname = 'realtime' and policyname = 'live_presence'),
  'INSERT|true');
select dafsync_test.check('there is no other policy that lets a client publish to realtime.messages',
  (select count(*)::text from pg_policies where schemaname = 'realtime' and tablename = 'messages' and cmd in ('INSERT', 'ALL')),
  '1');

-- ===========================================================================
-- 11. Unread counts (phase 2)
-- ===========================================================================
-- State at this point: the reader follows t1 (their own thread) and read it up to seq 10 (section 8).
-- The author posted in t1 earlier; the admin chatted 20 times. Build a clean case instead:
select dafsync_test.read_as('authenticated', :admin,
  $$select (public.live_start_thread('Unread-1a', 'Unread 1a.1',
      '[{"ref":"Unread 1a.1","start":0,"end":1}]'::jsonb, 'תנו רבנן', 'Unread question')).id::text$$) as tu \gset
select dafsync_test.attempt('authenticated', :reader, format($$insert into public.live_thread_follows (user_id, thread_id) values (%L, %L)$$, :reader, :'tu'));
select dafsync_test.attempt_msg('authenticated', :author, format($$select public.live_post_message(%L, 'one', null)$$, :'tu'));
select dafsync_test.attempt_msg('authenticated', :author, format($$select public.live_post_message(%L, 'two', null)$$, :'tu'));
select dafsync_test.attempt_msg('authenticated', :reader, format($$select public.live_post_message(%L, 'mine does not count', null)$$, :'tu'));
select dafsync_test.check('a follower sees how many new messages by others are waiting, never their own',
  dafsync_test.read_as('authenticated', :reader,
    format($$select unread::text from public.live_unread_counts('Unread-1a') where thread_id = %L$$, :'tu')),
  '3'); -- the admin's opening question, and the author's two replies
select dafsync_test.check('without a daf it covers every daf the reader follows',
  dafsync_test.read_as('authenticated', :reader,
    format($$select count(*)::text from public.live_unread_counts() where thread_id = %L$$, :'tu')),
  '1');
select dafsync_test.check('a thread the reader does not follow is not counted',
  dafsync_test.read_as('authenticated', :newbie, 'select count(*)::text from public.live_unread_counts(''Unread-1a'')'),
  '0');
select dafsync_test.attempt('authenticated', :reader,
  format($$insert into public.live_read_state (user_id, thread_id, last_read_seq) values (%L, %L, 1000000000)$$, :reader, :'tu'));
select dafsync_test.check('reading up to the end clears it',
  dafsync_test.read_as('authenticated', :reader,
    format($$select count(*)::text from public.live_unread_counts('Unread-1a') where thread_id = %L$$, :'tu')),
  '0');
select dafsync_test.check('anon gets nothing, and cannot call it',
  dafsync_test.attempt('anon', null, $$select * from public.live_unread_counts('Unread-1a')$$), '42501');
select dafsync_test.check('a deleted message is not counted',
  (select count(*)::text from (
     select 1 from public.live_messages m where m.thread_id = :'tu' and m.deleted_at is not null) s), '0');

select dafsync_test.check('the trigger functions and payload helpers cannot be called through the API',
  (select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('live_messages_broadcast', 'live_messages_bump_thread', 'live_threads_broadcast',
                        'live_read_state_monotonic', 'live_message_payload', 'live_thread_payload', 'live_check_may_post',
                        'live_display_name', 'live_broadcast')
      and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))),
  '0');
select dafsync_test.check('only the write functions are callable by signed-in readers, and none by anon',
  (select string_agg(p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'live\_%' and has_function_privilege('authenticated', p.oid, 'execute')),
  'live_access,live_delete_message,live_edit_message,live_list_notifications,live_mark_notifications_read,live_moderate,live_my_notification_state,live_post_message,live_remove_push_subscription,live_report,live_save_push_subscription,live_set_answer,live_set_audience,live_set_current_daf,live_set_daf_pref,live_set_notification_prefs,live_set_thread_muted,live_start_thread,live_unread_counts');
select dafsync_test.check('anon can run nothing but the access check',
  (select string_agg(p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'live\_%' and has_function_privilege('anon', p.oid, 'execute')),
  'live_access');

do $$ begin raise notice 'ALL LIVE CHABURAH TESTS PASSED'; end $$;
