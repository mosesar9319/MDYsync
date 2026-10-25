-- Adversarial tests for Cloud Chaburah Live notifications (migration 20261026100000).
--
-- Runs after live_chaburah.sql in run-tests.sh, in the same database, and uses its helpers
-- (dafsync_test.attempt, attempt_msg, read_as, check). Messages are written directly (as the
-- table owner) where the posting rules are not the thing under test, so the fan-out trigger is
-- exercised exactly as a real post exercises it; everything a person can do is done as
-- `authenticated` with a real JWT subject, the way PostgREST connects.

\set ON_ERROR_STOP on

\set reader  '''11111111-1111-4111-8111-111111111111'''
\set author  '''22222222-2222-4222-8222-222222222222'''
\set newbie  '''33333333-3333-4333-8333-333333333333'''
\set starter '''77777777-7777-4777-8777-777777777777'''

select set_config('request.jwt.claim.sub', '44444444-4444-4444-8444-444444444444', false);
update public.live_settings set audience = 'everyone' where id;
update public.profiles set display_name = 'Reuven Reader' where id = '11111111-1111-4111-8111-111111111111';
update public.profiles set display_name = 'Avi Author'    where id = '22222222-2222-4222-8222-222222222222';
update public.profiles set display_name = 'Nechama Newbie' where id = '33333333-3333-4333-8333-333333333333';
update public.profiles set display_name = 'Shimon Starter' where id = '77777777-7777-4777-8777-777777777777';

create schema if not exists nt;
create or replace function nt.open_thread(p_daf text, p_author uuid, p_body text)
returns uuid language plpgsql as $$
declare v_id uuid;
begin
  insert into public.live_threads (author_id, author_display_name, daf_ref_key, segment_ref, word_ranges, quoted_text, preview)
  values (p_author, public.live_display_name(p_author), p_daf, replace(p_daf, '-', ' ') || '.1',
          jsonb_build_array(jsonb_build_object('ref', replace(p_daf, '-', ' ') || '.1', 'start', 0, 'end', 1)), 'quoted', left(p_body, 240))
  returning id into v_id;
  insert into public.live_messages (thread_id, author_id, author_display_name, body)
  values (v_id, p_author, public.live_display_name(p_author), p_body);
  insert into public.live_thread_follows (user_id, thread_id) values (p_author, v_id) on conflict do nothing;
  return v_id;
end $$;
create or replace function nt.say(p_thread uuid, p_author uuid, p_body text, p_quoted uuid default null)
returns uuid language plpgsql as $$
declare v_id uuid;
begin
  insert into public.live_messages (thread_id, author_id, author_display_name, body, quoted_message_id)
  values (p_thread, p_author, public.live_display_name(p_author), p_body, p_quoted) returning id into v_id;
  insert into public.live_thread_follows (user_id, thread_id) values (p_author, p_thread) on conflict do nothing;
  return v_id;
end $$;
create or replace function nt.kinds(p_user uuid, p_thread uuid default null)
returns text language sql as $$
  select coalesce(string_agg(kind, ',' order by created_at, kind), '-') from public.live_notifications
   where user_id = p_user and (p_thread is null or thread_id = p_thread);
$$;

-- ===========================================================================
-- 1. The defaults a person gets before they ever open the settings
-- ===========================================================================
insert into auth.users (id, email, created_at) values ('99999999-9999-4999-8999-999999999999', 'defaults@example.test', now());
insert into public.live_notification_prefs (user_id) values ('99999999-9999-4999-8999-999999999999');
select dafsync_test.check('the built-in defaults are the table defaults',
  (select ((to_jsonb(public.live_default_prefs(p.user_id)) - 'updated_at') = (to_jsonb(p) - 'updated_at'))::text
     from public.live_notification_prefs p where p.user_id = '99999999-9999-4999-8999-999999999999'),
  'true');

-- ===========================================================================
-- 2. Who hears about what
-- ===========================================================================
-- The reader follows the daf and wants to hear about new discussions on it; the author asked
-- for everything (as a digest); the newbie did nothing.
select dafsync_test.check('a reader can follow a daf',
  dafsync_test.attempt('authenticated', :reader, $$select public.live_set_daf_pref('Notif-1a', true, null)$$), 'OK');
select dafsync_test.check('and ask to hear about their dapim',
  dafsync_test.attempt('authenticated', :reader, $$select public.live_set_notification_prefs('{"lvl_daf": true}')$$), 'OK');
select dafsync_test.check('the author asks for everything',
  dafsync_test.attempt('authenticated', :author, $$select public.live_set_notification_prefs('{"lvl_everywhere": true}')$$), 'OK');

select nt.open_thread('Notif-1a', :starter, 'Why does the Gemara ask this?') as t1 \gset

select dafsync_test.check('a new discussion on a followed daf reaches the follower',
  nt.kinds(:reader, :'t1'), 'new_thread_daf');
select dafsync_test.check('and, as a digest, the person who asked for everything',
  nt.kinds(:author, :'t1') || '/' || (select digest::text from public.live_notifications where user_id = :author and thread_id = :'t1'),
  'new_thread_everywhere/true');
select dafsync_test.check('the asker is not told about their own question', nt.kinds(:starter, :'t1'), '-');
select dafsync_test.check('someone who asked for nothing hears nothing', nt.kinds(:newbie, :'t1'), '-');

-- A reply: the asker hears it (reader and author do not follow the thread, so no one else does).
select nt.say(:'t1', :author, 'Because of the Mishnah.') as m1 \gset
select dafsync_test.check('a reply in your own discussion reaches you',
  (select string_agg(kind, ',') from public.live_notifications where user_id = :starter and message_id = :'m1'), 'reply_to_thread');
select dafsync_test.check('a thread you do not follow tells you nothing',
  (select count(*)::text from public.live_notifications where user_id = :reader and message_id = :'m1'), '0');
select dafsync_test.check('the writer is never told about their own message',
  (select count(*)::text from public.live_notifications where user_id = :author and message_id = :'m1'), '0');

-- A reply quoting someone, and following: one notification each, for the most specific reason.
select nt.say(:'t1', :reader, 'I do not follow, can you explain?') as m2 \gset
select nt.say(:'t1', :starter, 'Sure.', :'m2') as m3 \gset
select dafsync_test.check('replying to a message tells its writer so',
  (select string_agg(kind, ',') from public.live_notifications where user_id = :reader and message_id = :'m3'), 'reply_to_me');
select dafsync_test.check('whoever else follows the thread hears of it once',
  (select string_agg(kind, ',') from public.live_notifications where user_id = :author and message_id = :'m3'), 'followed_activity');
select dafsync_test.check('one notification per person per message, however many reasons',
  (select max(c)::text from (select count(*) c from public.live_notifications group by user_id, message_id) s), '1');

-- A mention by name reaches a person in the conversation, and outranks the other reasons.
select nt.say(:'t1', :author, 'Good question @Reuven Reader, what do you think?', :'m2') as m4 \gset
select dafsync_test.check('a mention outranks a reply',
  (select string_agg(kind, ',') from public.live_notifications where user_id = :reader and message_id = :'m4'), 'mention');
select nt.say(:'t1', :author, 'Ask @Reuven Readerson about it') as m5 \gset
select dafsync_test.check('a longer name is not a mention of a shorter one',
  (select count(*)::text from public.live_notifications where user_id = :reader and message_id = :'m5' and kind = 'mention'), '0');

-- Hidden and removed messages tell no one.
insert into public.live_messages (thread_id, author_id, author_display_name, body, hidden)
values (:'t1', :author, 'Avi Author', 'spam', true) returning id as m6 \gset
select dafsync_test.check('a hidden message tells no one',
  (select count(*)::text from public.live_notifications where message_id = :'m6'), '0');

-- ===========================================================================
-- 3. Turning things down
-- ===========================================================================
select nt.open_thread('Notif-2a', :starter, 'Second question') as t2 \gset
select nt.say(:'t2', :author, 'An answer') as m7 \gset
select dafsync_test.check('before muting, the asker hears the reply', nt.kinds(:starter, :'t2'), 'reply_to_thread');

select dafsync_test.check('a discussion can be muted',
  dafsync_test.attempt('authenticated', :starter, format($$select public.live_set_thread_muted(%L, true)$$, :'t2')), 'OK');
select nt.say(:'t2', :author, 'Another answer') as m8 \gset
select dafsync_test.check('a muted discussion tells you nothing more',
  (select count(*)::text from public.live_notifications where user_id = :starter and message_id = :'m8'), '0');
select dafsync_test.check('and shows no unread count',
  dafsync_test.read_as('authenticated', :starter, format($$select count(*)::text from public.live_unread_counts() where thread_id = %L$$, :'t2')), '0');
select dafsync_test.attempt('authenticated', :starter, format($$select public.live_set_thread_muted(%L, false)$$, :'t2'));
select dafsync_test.check('unmuting brings the count back',
  dafsync_test.read_as('authenticated', :starter, format($$select count(*)::text from public.live_unread_counts() where thread_id = %L$$, :'t2')), '1');

select dafsync_test.attempt('authenticated', :reader, $$select public.live_set_daf_pref('Notif-3a', true, true)$$);
select nt.open_thread('Notif-3a', :starter, 'Third question') as t3 \gset
select dafsync_test.check('a muted daf is silent even when followed', nt.kinds(:reader, :'t3'), '-');

select dafsync_test.attempt('authenticated', :author, $$select public.live_set_notification_prefs('{"all_off": true}')$$);
select nt.open_thread('Notif-4a', :starter, 'Fourth question') as t4 \gset
select dafsync_test.check('"everything off" really is everything', nt.kinds(:author, :'t4'), '-');
select dafsync_test.attempt('authenticated', :author, $$select public.live_set_notification_prefs('{"all_off": false}')$$);

select dafsync_test.attempt('authenticated', :starter, $$select public.live_set_notification_prefs('{"in_app_enabled": false}')$$);
select nt.say(:'t1', :author, 'One more thought') as m9 \gset
select dafsync_test.check('with in-app and background both off, nothing is stored',
  (select count(*)::text from public.live_notifications where user_id = :starter and message_id = :'m9'), '0');
select dafsync_test.attempt('authenticated', :starter, $$select public.live_set_notification_prefs('{"in_app_enabled": true}')$$);

-- ===========================================================================
-- 4. Settings are validated by the database
-- ===========================================================================
select dafsync_test.check('an unknown time zone is refused',
  dafsync_test.attempt_msg('authenticated', :reader, $$select public.live_set_notification_prefs('{"timezone": "Mars/Olympus"}')$$), 'live_invalid_input');
select dafsync_test.check('an odd batching interval is refused',
  dafsync_test.attempt_msg('authenticated', :reader, $$select public.live_set_notification_prefs('{"batch_minutes": 7}')$$), 'live_invalid_input');
select dafsync_test.check('an hour past midnight is refused',
  dafsync_test.attempt_msg('authenticated', :reader, $$select public.live_set_notification_prefs('{"quiet_start": 30}')$$), 'live_invalid_input');
select dafsync_test.check('a setting that is not a setting is refused',
  dafsync_test.attempt_msg('authenticated', :reader, $$select public.live_set_notification_prefs('{"lvl_mine": "maybe"}')$$), 'live_invalid_input');
select dafsync_test.check('unknown keys cannot reach the table',
  dafsync_test.attempt('authenticated', :reader, $$select public.live_set_notification_prefs('{"user_id": "22222222-2222-4222-8222-222222222222"}')$$), 'OK');
select dafsync_test.check('and did not move anyone else''s settings',
  (select count(*)::text from public.live_notification_prefs where user_id = :reader), '1');
select dafsync_test.check('a good time zone is kept',
  dafsync_test.attempt('authenticated', :reader, $$select public.live_set_notification_prefs('{"timezone": "America/New_York", "quiet_enabled": true, "quiet_start": 23, "quiet_end": 6}')$$), 'OK');
select dafsync_test.check('and read back',
  dafsync_test.read_as('authenticated', :reader, $$select (public.live_my_notification_state() -> 'prefs' ->> 'timezone')$$), 'America/New_York');
select dafsync_test.attempt('authenticated', :reader,
  $$select public.live_set_notification_prefs(jsonb_build_object('snooze_until', now() + interval '90 days'))$$);
select dafsync_test.check('a snooze is capped at about a week',
  (select (snooze_until between now() + interval '7 days' and now() + interval '8 days 1 minute')::text
     from public.live_notification_prefs where user_id = :reader),
  'true');
select dafsync_test.attempt('authenticated', :reader, $$select public.live_set_notification_prefs('{"snooze_until": null}')$$);

-- ===========================================================================
-- 5. When a background alert may go out
-- ===========================================================================
create or replace function nt.prefs(p_json jsonb)
returns public.live_notification_prefs language sql as $$
  select jsonb_populate_record(public.live_default_prefs('99999999-9999-4999-8999-999999999999'::uuid), p_json);
$$;
select dafsync_test.check('batching waits the batch interval',
  (public.live_push_time(nt.prefs('{"batch_minutes": 15}'), false) between now() + interval '14 minutes' and now() + interval '16 minutes')::text, 'true');
select dafsync_test.check('batching of zero is immediate',
  (public.live_push_time(nt.prefs('{"batch_minutes": 0}'), false) <= now() + interval '1 second')::text, 'true');
select dafsync_test.check('quiet hours push the alert to the end of the quiet window',
  extract(hour from public.live_push_time(nt.prefs('{"timezone":"Asia/Jerusalem","quiet_enabled":true,"quiet_start":0,"quiet_end":23}'), false)
                    at time zone 'Asia/Jerusalem')::text, '23');
select dafsync_test.check('and wrap past midnight',
  (extract(hour from public.live_push_time(nt.prefs('{"timezone":"America/New_York","quiet_enabled":true,"quiet_start":1,"quiet_end":0}'), false)
                     at time zone 'America/New_York') = 0)::text, 'true');
select dafsync_test.check('the Shabbos pause never lets an alert land between Friday and Saturday night',
  (select (extract(dow from t at time zone 'Asia/Jerusalem') not in (5)
           and not (extract(dow from t at time zone 'Asia/Jerusalem') = 6 and extract(hour from t at time zone 'Asia/Jerusalem') < 23))::text
     from (select public.live_push_time(nt.prefs('{"timezone":"Asia/Jerusalem","shabbos_pause":true,"shabbos_start_hour":0,"shabbos_end_hour":23,"batch_minutes":0}'), false) t) s),
  'true');
select dafsync_test.check('the digest goes out at the chosen hour, in the future',
  (select (extract(hour from t at time zone 'Europe/London') = 8 and extract(minute from t) = 0 and t > now())::text
     from (select public.live_push_time(nt.prefs('{"timezone":"Europe/London","digest_hour":8}'), true) t) s),
  'true');
select dafsync_test.check('a snooze holds everything until it ends',
  (public.live_push_time(nt.prefs(format('{"snooze_until": "%s"}', now() + interval '3 hours')::jsonb), false) >= now() + interval '3 hours')::text, 'true');

-- ===========================================================================
-- 6. Devices and the sender
-- ===========================================================================
select dafsync_test.check('a device needs an https endpoint',
  dafsync_test.attempt_msg('authenticated', :starter, $$select public.live_save_push_subscription('http://insecure.example/x', 'k', 'a', 'Phone')$$), 'live_invalid_input');
select dafsync_test.check('a device can be added',
  dafsync_test.attempt('authenticated', :starter,
    $$select public.live_save_push_subscription('https://push.example.test/send/abcdefghijklmnop', 'BPkeykeykeykeykeykeykey', 'authsecretxx', 'Phone')$$), 'OK');
select dafsync_test.check('adding one is the consent to background alerts',
  (select push_enabled::text from public.live_notification_prefs where user_id = :starter), 'true');
select dafsync_test.check('the device list never shows keys or the full endpoint',
  (dafsync_test.read_as('authenticated', :starter, $$select (public.live_my_notification_state() -> 'devices' -> 0)::text$$)
     !~ '(p256dh|authsecret|BPkey|abcdefghijklmnop)')::text,
  'true');

select dafsync_test.attempt('authenticated', :starter, $$select public.live_set_notification_prefs('{"batch_minutes": 0}')$$);
select nt.say(:'t1', :author, 'A reply for the phone') as m10 \gset
select dafsync_test.check('a reply queues a background alert for a person with a device',
  (select push_state from public.live_notifications where user_id = :starter and message_id = :'m10'), 'pending');
select dafsync_test.check('and none for someone with no device',
  (select push_state from public.live_notifications where user_id = :author and thread_id = :'t1' order by created_at limit 1), 'none');

select dafsync_test.check('the sender is handed what is due, with the device',
  (select (c -> 0 -> 'items' -> 0 ->> 'preview') || '/' || (c -> 0 -> 'devices' -> 0 ->> 'endpoint')
     from (select public.live_push_claim(50) c) s),
  'A reply for the phone/https://push.example.test/send/abcdefghijklmnop');
select dafsync_test.check('and gets it only once',
  (select jsonb_array_length(public.live_push_claim(50))::text), '0');
select dafsync_test.check('it is then marked sent',
  (select push_state from public.live_notifications where user_id = :starter and message_id = :'m10'), 'sent');

select nt.say(:'t1', :author, 'Read before it was sent') as m11 \gset
insert into public.live_read_state (user_id, thread_id, last_read_seq) values (:starter, :'t1', 1000000000)
  on conflict (user_id, thread_id) do update set last_read_seq = excluded.last_read_seq;
select dafsync_test.check('a message you have already read is not sent to your phone',
  (select jsonb_array_length(public.live_push_claim(50))::text), '0');
select dafsync_test.check('and is marked skipped',
  (select push_state from public.live_notifications where user_id = :starter and message_id = :'m11'), 'skipped');
select dafsync_test.check('reading a discussion clears its notifications',
  (select count(*)::text from public.live_notifications where user_id = :starter and thread_id = :'t1' and read_at is null), '0');

select nt.say(:'t1', :author, 'Cancelled before it was sent') as m12 \gset
select dafsync_test.attempt('authenticated', :starter, $$select public.live_set_notification_prefs('{"push_enabled": false}')$$);
select dafsync_test.check('turning background alerts off cancels the ones waiting',
  (select push_state from public.live_notifications where user_id = :starter and message_id = :'m12'), 'skipped');

select dafsync_test.check('removing the last device also cancels',
  dafsync_test.attempt('authenticated', :starter,
    $$select public.live_remove_push_subscription(null, 'https://push.example.test/send/abcdefghijklmnop')$$), 'OK');
select dafsync_test.check('and it is gone',
  (select count(*)::text from public.push_subscriptions where user_id = :starter), '0');

select dafsync_test.check('twelve devices can be offered',
  (select count(*)::text from generate_series(1, 12) g
    where dafsync_test.attempt('authenticated', '77777777-7777-4777-8777-777777777777',
      format($$select public.live_save_push_subscription('https://push.example.test/send/device-%s-xxxxxxxx', 'BPkeykeykeykeykeykeykey', 'authsecretxx', '')$$, g)) = 'OK'),
  '12');
select dafsync_test.check('with the oldest making room',
  (select count(*)::text from public.push_subscriptions where user_id = :starter), '10');
delete from public.push_subscriptions where user_id = :starter;

-- ===========================================================================
-- 7. Privacy
-- ===========================================================================
select dafsync_test.check('your inbox holds only your own notifications',
  (dafsync_test.read_as('authenticated', :reader, $$select count(*)::text from public.live_list_notifications()$$)
     = (select count(*)::text from public.live_notifications where user_id = :reader and in_app))::text,
  'true');
select dafsync_test.attempt('authenticated', :newbie, $$select public.live_mark_notifications_read(null, true)$$);
select dafsync_test.check('marking everything read marks only your own',
  (select (count(*) > 0)::text from public.live_notifications where user_id = :reader and read_at is null), 'true');
select dafsync_test.check('marking read touches only your own',
  dafsync_test.attempt('authenticated', :reader, $$select public.live_mark_notifications_read(null, true)$$), 'OK');
select dafsync_test.check('and does clear them',
  dafsync_test.read_as('authenticated', :reader, $$select (public.live_my_notification_state() ->> 'unread')$$), '0');
select dafsync_test.check('no one can read the tables directly',
  dafsync_test.attempt('authenticated', :reader, 'select * from public.live_notifications'), '42501');
select dafsync_test.check('push subscriptions are not readable directly either',
  dafsync_test.attempt('authenticated', :reader, 'select * from public.push_subscriptions'), '42501');
select dafsync_test.check('or writable directly',
  dafsync_test.attempt('authenticated', :reader,
    format($$insert into public.live_notifications (user_id, kind, thread_id, message_id, daf_ref_key, actor_display_name, preview)
             values (%L, 'mention', %L, %L, 'x', 'x', 'x')$$, :reader, :'t1', :'m1')), '42501');
select dafsync_test.check('the settings table is closed too',
  dafsync_test.attempt('authenticated', :reader, $$update public.live_notification_prefs set all_off = true$$), '42501');
select dafsync_test.check('signed-out callers get nothing',
  dafsync_test.attempt('anon', null, $$select public.live_my_notification_state()$$), '42501');
select dafsync_test.check('the sender''s functions are not callable with a reader''s key',
  dafsync_test.attempt('authenticated', :reader, $$select public.live_push_claim(10)$$), '42501');
select dafsync_test.check('nor to drop a device',
  dafsync_test.attempt('authenticated', :reader, $$select public.live_push_drop('https://x.example/abcdefghijklmnop')$$), '42501');
update public.live_settings set audience = 'admins' where id;
select dafsync_test.check('while it is admins-only, an ordinary account is refused',
  dafsync_test.attempt_msg('authenticated', :reader, $$select public.live_my_notification_state()$$), 'live_not_available');
select nt.say(:'t1', :author, 'Said during the admins-only period') as m13 \gset
select dafsync_test.check('and an ordinary account is not notified',
  (select count(*)::text from public.live_notifications where message_id = :'m13'), '0');
update public.live_settings set audience = 'everyone' where id;

select dafsync_test.check('the notification functions are callable by signed-in readers only',
  (select string_agg(p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'live_my_notification_state', 'live_set_notification_prefs', 'live_set_current_daf', 'live_set_daf_pref',
      'live_set_thread_muted', 'live_list_notifications', 'live_mark_notifications_read',
      'live_save_push_subscription', 'live_remove_push_subscription')
      and has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')),
  'live_list_notifications,live_mark_notifications_read,live_my_notification_state,live_remove_push_subscription,live_save_push_subscription,live_set_current_daf,live_set_daf_pref,live_set_notification_prefs,live_set_thread_muted');
select dafsync_test.check('the helpers and the sender''s functions are not callable through the API',
  (select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'live_push_time', 'live_default_prefs', 'live_prefs_or_default', 'live_messages_notify',
      'live_read_state_clear_notifications', 'live_notifications_broadcast', 'live_require_reader',
      'live_push_claim', 'live_push_drop')
      and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))),
  '0');

-- The page tells the database which daf is open, so "my daf" alerts reach someone learning it.
select dafsync_test.check('the open daf is recorded',
  dafsync_test.attempt('authenticated', :newbie, $$select public.live_set_current_daf('Notif-5a')$$), 'OK');
select dafsync_test.attempt('authenticated', :newbie, $$select public.live_set_notification_prefs('{"lvl_daf": true}')$$);
select nt.open_thread('Notif-5a', :starter, 'Fifth question') as t5 \gset
select dafsync_test.check('someone with a daf open hears about a new question on it',
  nt.kinds(:newbie, :'t5'), 'new_thread_daf');
update public.live_notification_prefs set current_daf_at = now() - interval '2 hours' where user_id = :newbie;
select nt.open_thread('Notif-5a', :starter, 'Sixth question') as t6 \gset
select dafsync_test.check('but not once they have long since left',
  nt.kinds(:newbie, :'t6'), '-');

drop schema nt cascade;
do $$ begin raise notice 'ALL LIVE CHABURAH NOTIFICATION TESTS PASSED'; end $$;
