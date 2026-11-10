-- Rollback for 20261026100000_live_chaburah_notifications.sql (phase 2's live_unread_counts
-- stays, without the mute filter, by re-applying 20261025180000_live_chaburah_unread.sql).
drop trigger if exists live_messages_y_notify on public.live_messages;
drop trigger if exists live_read_state_clear_notifications on public.live_read_state;
drop function if exists public.live_messages_notify();
drop function if exists public.live_read_state_clear_notifications();
drop function if exists public.live_notifications_broadcast();
drop function if exists public.live_require_reader();
drop function if exists public.live_my_notification_state(text);
drop function if exists public.live_set_notification_prefs(jsonb);
drop function if exists public.live_set_current_daf(text);
drop function if exists public.live_set_daf_pref(text, boolean, boolean);
drop function if exists public.live_set_thread_muted(uuid, boolean);
drop function if exists public.live_list_notifications(integer, timestamptz);
drop function if exists public.live_mark_notifications_read(uuid, boolean);
drop function if exists public.live_save_push_subscription(text, text, text, text);
drop function if exists public.live_remove_push_subscription(uuid, text);
drop function if exists public.live_push_claim(integer);
drop function if exists public.live_push_drop(text);
drop function if exists public.live_push_time(public.live_notification_prefs, boolean);
drop function if exists public.live_prefs_or_default(uuid);
drop function if exists public.live_default_prefs(uuid);
drop table if exists public.push_subscriptions;
drop table if exists public.live_notifications;
drop table if exists public.live_thread_mutes;
drop table if exists public.live_daf_prefs;
drop table if exists public.live_notification_prefs;
do $$ begin
  if to_regclass('realtime.messages') is not null then
    drop policy if exists live_notify_receive on realtime.messages;
  end if;
end $$;
