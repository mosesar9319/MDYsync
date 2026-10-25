-- Rollback for 20261025130000_live_chaburah_phase1.sql: removes everything it added.
-- Deletes all live discussions and messages (there is no other copy).

do $$
begin
  if to_regclass('realtime.messages') is not null then
    drop policy if exists live_receive on realtime.messages;
    drop policy if exists live_presence on realtime.messages;
  end if;
end $$;

drop trigger if exists live_threads_broadcast on public.live_threads;
drop trigger if exists live_messages_z_broadcast on public.live_messages;
drop trigger if exists live_messages_a_bump on public.live_messages;

drop function if exists public.live_threads_broadcast();
drop function if exists public.live_messages_broadcast();
drop function if exists public.live_thread_payload(public.live_threads);
drop function if exists public.live_message_payload(public.live_messages);
drop function if exists public.live_broadcast(jsonb, text, text);
drop function if exists public.live_messages_bump_thread();
drop function if exists public.live_set_audience(text);
drop function if exists public.live_report(uuid, uuid, text);
drop function if exists public.live_moderate(uuid, uuid, boolean);
drop function if exists public.live_set_answer(uuid, uuid);
drop function if exists public.live_delete_message(uuid);
drop function if exists public.live_edit_message(uuid, text);
drop function if exists public.live_post_message(uuid, text, uuid);
drop function if exists public.live_start_thread(text, text, jsonb, text, text);
drop function if exists public.live_display_name(uuid);
drop function if exists public.live_check_may_post(boolean);

drop table if exists public.live_reports;
drop table if exists public.live_read_state;
drop table if exists public.live_thread_follows;
alter table if exists public.live_threads drop constraint if exists live_threads_answer_fk;
drop table if exists public.live_messages;
drop table if exists public.live_threads;
drop function if exists public.live_read_state_monotonic();
drop function if exists public.live_access();
drop table if exists public.live_settings;
