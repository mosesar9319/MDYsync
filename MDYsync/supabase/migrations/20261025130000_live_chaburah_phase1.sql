-- Cloud Chaburah Live, phase 1: independent live conversations, each anchored to
-- the exact words of the Gemara that started it.
--
-- WHAT THIS ADDS (new tables only; no existing table is altered)
--
--   live_settings        one row; who may see/use the feature ('admins' until launch)
--   live_threads         one row per discussion: daf, anchor (word_ranges), quoted text,
--                        a preview of the opening question, counters, answered status
--   live_messages        the chat itself; the opening question is its first message
--   live_thread_follows  who follows which thread
--   live_read_state      per reader, the last message seen in a thread (unread counts)
--   live_reports         reports of a thread or message, for moderators
--
-- THE WRITE MODEL
--
-- Clients can READ threads and messages (subject to RLS) but cannot INSERT, UPDATE or
-- DELETE them directly: every write goes through a SECURITY DEFINER function that checks
-- who is calling, whether they may post (account age, rate limits), and that the thread
-- and any quoted message are what they claim. That is the only way to enforce rate limits
-- and "this reply quotes a message from this thread" -- RLS can say whose row, not how
-- often or how it relates to another row -- and it keeps a caller who bypasses the UI
-- (the REST API, straight from the browser console) inside the same rules.
--
-- REAL TIME
--
-- A trigger copies every stored message (and every thread change) to a PRIVATE Realtime
-- Broadcast channel with realtime.send(): "live:thread:<id>" for a conversation and
-- "live:daf:<daf_ref_key>" for the sidebar. The message is saved first and only then
-- broadcast, so what a client receives is exactly what the database accepted, and clients
-- cannot publish to those topics at all: the only realtime.messages policies are
-- "receive" (SELECT) on live: topics, and "presence" (INSERT) for the who's-here counts.
-- Both require live_access(), the same gate as the tables.
--
-- THE LAUNCH GATE
--
-- live_access() is true for admins, and for everyone once live_settings.audience is set
-- to 'everyone' (live_set_audience(), admin only). Every policy and function below goes
-- through it, so before launch a non-admin cannot use the feature even by calling the API
-- directly.
--
-- MODERATION
--
-- A hidden or deleted MESSAGE is redacted in place (body emptied, flag set) so the chat
-- keeps its shape and quotes of it show "removed" instead of leaving a gap. A hidden
-- THREAD disappears from every reader but admins and can be restored.
--
-- DELIBERATE CHOICES
--
--   * author_display_name falls back to 'Learner', never to the account email.
--   * daf_ref_key is the daf itself ('Bekhorot-22a'), not a recording's key: the
--     discussion belongs to the Gemara and is shared by every shiur of that daf.
--   * Posting needs an account at least 24 hours old (the same rule as public notes),
--     but the rate limit is its own: ordinary back-and-forth must be possible, which
--     can_post_publicly()'s 10-posts-an-hour is not.

-- ---------------------------------------------------------------------------
-- Settings and the gate
-- ---------------------------------------------------------------------------
create table public.live_settings (
  id boolean primary key default true check (id),
  audience text not null default 'admins' check (audience in ('admins', 'everyone')),
  updated_at timestamptz not null default now()
);
insert into public.live_settings default values;

create or replace function public.live_access()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select audience = 'everyone' from public.live_settings where id), false)
         or public.is_admin();
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.live_threads (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references auth.users(id) on delete cascade,
  author_display_name text not null,
  daf_ref_key text not null check (char_length(daf_ref_key) between 1 and 80),
  segment_ref text not null check (char_length(segment_ref) between 1 and 120),
  word_ranges jsonb not null check (
    jsonb_typeof(word_ranges) = 'array' and jsonb_array_length(word_ranges) between 1 and 20),
  quoted_text text not null check (char_length(quoted_text) between 1 and 600),
  -- Where on the daf the anchor starts (segment number, word index), for "near my place".
  anchor_segment integer not null default 0,
  anchor_word integer not null default 0,
  preview text not null check (char_length(preview) between 1 and 240),
  message_count integer not null default 0 check (message_count >= 0),
  status text not null default 'open' check (status in ('open', 'answered')),
  answer_message_id uuid,
  hidden boolean not null default false,
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);
create index live_threads_daf_activity on public.live_threads (daf_ref_key, last_message_at desc);
create index live_threads_author on public.live_threads (author_id);

create table public.live_messages (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  thread_id uuid not null references public.live_threads(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete cascade,
  author_display_name text not null,
  body text not null,
  quoted_message_id uuid references public.live_messages(id) on delete set null,
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  hidden boolean not null default false,
  constraint live_messages_body_check check (
    char_length(body) <= 2000
    and (char_length(body) >= 1 or deleted_at is not null or hidden))
);
create index live_messages_thread_seq on public.live_messages (thread_id, seq);
create index live_messages_author_recent on public.live_messages (author_id, created_at desc);

alter table public.live_threads
  add constraint live_threads_answer_fk
  foreign key (answer_message_id) references public.live_messages(id) on delete set null;

create table public.live_thread_follows (
  user_id uuid not null references auth.users(id) on delete cascade,
  thread_id uuid not null references public.live_threads(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, thread_id)
);

create table public.live_read_state (
  user_id uuid not null references auth.users(id) on delete cascade,
  thread_id uuid not null references public.live_threads(id) on delete cascade,
  last_read_seq bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, thread_id)
);

create table public.live_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references auth.users(id) on delete cascade,
  thread_id uuid not null references public.live_threads(id) on delete cascade,
  message_id uuid references public.live_messages(id) on delete cascade,
  reason text not null default '' check (char_length(reason) <= 500),
  status text not null default 'pending' check (status in ('pending', 'resolved', 'dismissed')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id)
);
create index live_reports_pending on public.live_reports (status, created_at);

-- A reader's place in a thread only ever moves forward.
create or replace function public.live_read_state_monotonic()
returns trigger language plpgsql as $$
begin
  new.last_read_seq := greatest(old.last_read_seq, new.last_read_seq);
  new.updated_at := now();
  return new;
end $$;
create trigger live_read_state_monotonic before update on public.live_read_state
  for each row execute function public.live_read_state_monotonic();

-- ---------------------------------------------------------------------------
-- Row Level Security: read for everyone the gate lets in; no direct writes
-- ---------------------------------------------------------------------------
alter table public.live_settings enable row level security;
alter table public.live_threads enable row level security;
alter table public.live_messages enable row level security;
alter table public.live_thread_follows enable row level security;
alter table public.live_read_state enable row level security;
alter table public.live_reports enable row level security;

create policy live_settings_read on public.live_settings for select using (true);

create policy live_threads_read on public.live_threads for select
  using (public.live_access() and (not hidden or public.is_admin()));

create policy live_messages_read on public.live_messages for select
  using (
    public.live_access()
    and exists (select 1 from public.live_threads t
                where t.id = live_messages.thread_id and (not t.hidden or public.is_admin())));

create policy live_thread_follows_select_own on public.live_thread_follows for select
  using (auth.uid() = user_id);
create policy live_thread_follows_insert_own on public.live_thread_follows for insert
  with check (
    auth.uid() = user_id and public.live_access()
    and exists (select 1 from public.live_threads t where t.id = thread_id and not t.hidden));
create policy live_thread_follows_delete_own on public.live_thread_follows for delete
  using (auth.uid() = user_id);

create policy live_read_state_owner on public.live_read_state for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id and public.live_access());

create policy live_reports_read_own on public.live_reports for select
  using (auth.uid() = reporter_id);
create policy live_reports_admin_read on public.live_reports for select
  using (public.is_admin());

-- Supabase hands new tables to anon/authenticated by default; take that back and give
-- only what the policies above are written for.
revoke all on public.live_settings, public.live_threads, public.live_messages,
  public.live_thread_follows, public.live_read_state, public.live_reports
  from public, anon, authenticated;
grant select on public.live_settings, public.live_threads, public.live_messages
  to anon, authenticated;
grant select, insert, delete on public.live_thread_follows to authenticated;
grant select, insert, update on public.live_read_state to authenticated;
grant select on public.live_reports to authenticated;

-- ---------------------------------------------------------------------------
-- Who may post, and how often
-- ---------------------------------------------------------------------------
-- Raises, with a message the page maps to plain words:
--   live_not_signed_in / live_not_available / live_account_too_new / live_rate_limited
create or replace function public.live_check_may_post(p_new_thread boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'live_not_signed_in' using errcode = '28000';
  end if;
  if not public.live_access() then
    raise exception 'live_not_available' using errcode = '42501';
  end if;
  if public.is_admin() then
    return;
  end if;
  if not exists (select 1 from public.profiles
                 where id = v_uid and created_at <= now() - interval '24 hours') then
    raise exception 'live_account_too_new' using errcode = 'P0001';
  end if;
  if (select count(*) from public.live_messages
        where author_id = v_uid and created_at > now() - interval '1 minute') >= 15
     or (select count(*) from public.live_messages
        where author_id = v_uid and created_at > now() - interval '1 hour') >= 200 then
    raise exception 'live_rate_limited' using errcode = 'P0001';
  end if;
  if p_new_thread and (select count(*) from public.live_threads
        where author_id = v_uid and created_at > now() - interval '1 hour') >= 5 then
    raise exception 'live_rate_limited' using errcode = 'P0001';
  end if;
end $$;

create or replace function public.live_display_name(p_uid uuid)
returns text language sql stable security definer set search_path = public as $$
  select coalesce(nullif(btrim((select display_name from public.profiles where id = p_uid)), ''), 'Learner');
$$;

-- ---------------------------------------------------------------------------
-- Writes
-- ---------------------------------------------------------------------------
create or replace function public.live_start_thread(
  p_daf_ref_key text, p_segment_ref text, p_word_ranges jsonb,
  p_quoted_text text, p_body text)
returns public.live_threads language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_body text := btrim(coalesce(p_body, ''));
  v_quoted text := btrim(coalesce(p_quoted_text, ''));
  v_name text;
  v_thread public.live_threads;
  v_run jsonb;
begin
  perform public.live_check_may_post(true);
  if char_length(v_body) < 1 or char_length(v_body) > 2000
     or char_length(v_quoted) < 1 or char_length(v_quoted) > 600
     or p_daf_ref_key is null or char_length(p_daf_ref_key) not between 1 and 80
     or p_segment_ref is null or char_length(p_segment_ref) not between 1 and 120
     or p_word_ranges is null or jsonb_typeof(p_word_ranges) <> 'array'
     or jsonb_array_length(p_word_ranges) not between 1 and 20 then
    raise exception 'live_invalid_input' using errcode = '22023';
  end if;
  for v_run in select * from jsonb_array_elements(p_word_ranges) loop
    if jsonb_typeof(v_run) <> 'object'
       or jsonb_typeof(v_run -> 'ref') <> 'string'
       or jsonb_typeof(v_run -> 'start') <> 'number'
       or jsonb_typeof(v_run -> 'end') <> 'number'
       or (v_run ->> 'start')::numeric < 0
       or (v_run ->> 'end')::numeric < (v_run ->> 'start')::numeric then
      raise exception 'live_invalid_input' using errcode = '22023';
    end if;
  end loop;

  v_name := public.live_display_name(v_uid);
  insert into public.live_threads
    (author_id, author_display_name, daf_ref_key, segment_ref, word_ranges, quoted_text,
     anchor_segment, anchor_word, preview)
  values
    (v_uid, v_name, p_daf_ref_key, p_segment_ref, p_word_ranges, v_quoted,
     coalesce(nullif(substring(p_segment_ref from '\.(\d+)$'), '')::integer, 0),
     (p_word_ranges -> 0 ->> 'start')::integer,
     left(v_body, 240))
  returning * into v_thread;

  insert into public.live_messages (thread_id, author_id, author_display_name, body)
  values (v_thread.id, v_uid, v_name, v_body);

  insert into public.live_thread_follows (user_id, thread_id)
  values (v_uid, v_thread.id) on conflict do nothing;

  select * into v_thread from public.live_threads where id = v_thread.id;
  return v_thread;
end $$;

create or replace function public.live_post_message(
  p_thread_id uuid, p_body text, p_quoted_message_id uuid default null)
returns public.live_messages language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_body text := btrim(coalesce(p_body, ''));
  v_message public.live_messages;
begin
  perform public.live_check_may_post(false);
  if char_length(v_body) < 1 or char_length(v_body) > 2000 then
    raise exception 'live_invalid_input' using errcode = '22023';
  end if;
  if not exists (select 1 from public.live_threads where id = p_thread_id and not hidden) then
    raise exception 'live_thread_missing' using errcode = 'P0002';
  end if;
  if p_quoted_message_id is not null and not exists (
       select 1 from public.live_messages where id = p_quoted_message_id and thread_id = p_thread_id) then
    raise exception 'live_invalid_input' using errcode = '22023';
  end if;
  insert into public.live_messages (thread_id, author_id, author_display_name, body, quoted_message_id)
  values (p_thread_id, v_uid, public.live_display_name(v_uid), v_body, p_quoted_message_id)
  returning * into v_message;
  insert into public.live_thread_follows (user_id, thread_id)
  values (v_uid, p_thread_id) on conflict do nothing;
  return v_message;
end $$;

-- Your own message, within 15 minutes of posting it, while it is still there.
create or replace function public.live_edit_message(p_message_id uuid, p_body text)
returns public.live_messages language plpgsql security definer set search_path = public as $$
declare
  v_body text := btrim(coalesce(p_body, ''));
  v_message public.live_messages;
begin
  if auth.uid() is null then raise exception 'live_not_signed_in' using errcode = '28000'; end if;
  if not public.live_access() then raise exception 'live_not_available' using errcode = '42501'; end if;
  if char_length(v_body) < 1 or char_length(v_body) > 2000 then
    raise exception 'live_invalid_input' using errcode = '22023';
  end if;
  update public.live_messages
     set body = v_body, edited_at = now()
   where id = p_message_id and author_id = auth.uid()
     and deleted_at is null and not hidden
     and created_at > now() - interval '15 minutes'
  returning * into v_message;
  if v_message.id is null then
    raise exception 'live_cannot_edit' using errcode = '42501';
  end if;
  return v_message;
end $$;

-- Delete your own message (an admin may delete anyone's). The opening question of a
-- conversation that has replies stays, so the replies keep their context; an opening
-- question nobody answered takes its whole thread with it.
create or replace function public.live_delete_message(p_message_id uuid)
returns public.live_messages language plpgsql security definer set search_path = public as $$
declare
  v_message public.live_messages;
  v_root_seq bigint;
  v_others integer;
begin
  if auth.uid() is null then raise exception 'live_not_signed_in' using errcode = '28000'; end if;
  if not public.live_access() then raise exception 'live_not_available' using errcode = '42501'; end if;
  select * into v_message from public.live_messages where id = p_message_id;
  if v_message.id is null or v_message.deleted_at is not null
     or (v_message.author_id <> auth.uid() and not public.is_admin()) then
    raise exception 'live_cannot_delete' using errcode = '42501';
  end if;
  select min(seq) into v_root_seq from public.live_messages where thread_id = v_message.thread_id;
  select count(*) into v_others from public.live_messages
    where thread_id = v_message.thread_id and id <> v_message.id and deleted_at is null and not hidden;
  if v_message.seq = v_root_seq and v_others > 0 and not public.is_admin() then
    raise exception 'live_root_has_replies' using errcode = 'P0001';
  end if;
  update public.live_messages set body = '', deleted_at = now()
   where id = p_message_id returning * into v_message;
  if v_message.seq = v_root_seq and v_others = 0 then
    update public.live_threads set hidden = true where id = v_message.thread_id;
  end if;
  return v_message;
end $$;

-- Mark which reply answered the question (or clear it with null). The asker or an admin.
create or replace function public.live_set_answer(p_thread_id uuid, p_message_id uuid)
returns public.live_threads language plpgsql security definer set search_path = public as $$
declare v_thread public.live_threads;
begin
  if auth.uid() is null then raise exception 'live_not_signed_in' using errcode = '28000'; end if;
  if not public.live_access() then raise exception 'live_not_available' using errcode = '42501'; end if;
  select * into v_thread from public.live_threads where id = p_thread_id and not hidden;
  if v_thread.id is null then raise exception 'live_thread_missing' using errcode = 'P0002'; end if;
  if v_thread.author_id <> auth.uid() and not public.is_admin() then
    raise exception 'live_cannot_edit' using errcode = '42501';
  end if;
  if p_message_id is not null and not exists (
       select 1 from public.live_messages
        where id = p_message_id and thread_id = p_thread_id and deleted_at is null and not hidden) then
    raise exception 'live_invalid_input' using errcode = '22023';
  end if;
  update public.live_threads
     set answer_message_id = p_message_id,
         status = case when p_message_id is null then 'open' else 'answered' end
   where id = p_thread_id returning * into v_thread;
  return v_thread;
end $$;

-- Admin only. With a message: redact it. Without: hide or restore the whole thread.
create or replace function public.live_moderate(p_thread_id uuid, p_message_id uuid, p_hidden boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'live_cannot_edit' using errcode = '42501'; end if;
  if p_message_id is not null then
    update public.live_messages set body = '', hidden = true
     where id = p_message_id and thread_id = p_thread_id;
  else
    update public.live_threads set hidden = coalesce(p_hidden, true) where id = p_thread_id;
  end if;
end $$;

create or replace function public.live_report(p_thread_id uuid, p_message_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'live_not_signed_in' using errcode = '28000'; end if;
  if not public.live_access() then raise exception 'live_not_available' using errcode = '42501'; end if;
  if not exists (select 1 from public.live_threads where id = p_thread_id and not hidden) then
    raise exception 'live_thread_missing' using errcode = 'P0002';
  end if;
  if p_message_id is not null and not exists (
       select 1 from public.live_messages where id = p_message_id and thread_id = p_thread_id) then
    raise exception 'live_invalid_input' using errcode = '22023';
  end if;
  insert into public.live_reports (reporter_id, thread_id, message_id, reason)
  values (auth.uid(), p_thread_id, p_message_id, left(coalesce(p_reason, ''), 500));
end $$;

create or replace function public.live_set_audience(p_audience text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'live_cannot_edit' using errcode = '42501'; end if;
  if p_audience not in ('admins', 'everyone') then
    raise exception 'live_invalid_input' using errcode = '22023';
  end if;
  update public.live_settings set audience = p_audience, updated_at = now() where id;
end $$;

revoke all on function
  public.live_check_may_post(boolean), public.live_display_name(uuid),
  public.live_start_thread(text, text, jsonb, text, text),
  public.live_post_message(uuid, text, uuid), public.live_edit_message(uuid, text),
  public.live_delete_message(uuid), public.live_set_answer(uuid, uuid),
  public.live_moderate(uuid, uuid, boolean), public.live_report(uuid, uuid, text),
  public.live_set_audience(text)
  from public, anon, authenticated;
grant execute on function
  public.live_start_thread(text, text, jsonb, text, text),
  public.live_post_message(uuid, text, uuid), public.live_edit_message(uuid, text),
  public.live_delete_message(uuid), public.live_set_answer(uuid, uuid),
  public.live_moderate(uuid, uuid, boolean), public.live_report(uuid, uuid, text),
  public.live_set_audience(text)
  to authenticated;
-- live_access() is used inside policies, so every role that can read needs to run it.
grant execute on function public.live_access() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Counters, and the broadcast of what the database accepted
-- ---------------------------------------------------------------------------
create or replace function public.live_messages_bump_thread()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.live_threads
     set message_count = message_count + 1, last_message_at = new.created_at
   where id = new.thread_id;
  return new;
end $$;
-- Named so it runs before the broadcast triggers below (same event: alphabetical order).
create trigger live_messages_a_bump after insert on public.live_messages
  for each row execute function public.live_messages_bump_thread();

-- realtime.send() exists on Supabase; without it (a plain Postgres) there is simply
-- nothing to broadcast to.
create or replace function public.live_broadcast(p_payload jsonb, p_event text, p_topic text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is null then
    return;
  end if;
  perform realtime.send(p_payload, p_event, p_topic, true);
exception when others then
  -- Broadcasting must never be the reason a message fails to save.
  raise warning 'live_broadcast failed: %', sqlerrm;
end $$;
revoke all on function public.live_broadcast(jsonb, text, text) from public, anon, authenticated;

-- The columns a reader is allowed to see; never an email, never an auth id beyond author_id.
create or replace function public.live_message_payload(m public.live_messages)
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'id', m.id, 'seq', m.seq, 'thread_id', m.thread_id, 'author_id', m.author_id,
    'author_display_name', m.author_display_name, 'body', m.body,
    'quoted_message_id', m.quoted_message_id, 'created_at', m.created_at,
    'edited_at', m.edited_at, 'deleted_at', m.deleted_at, 'hidden', m.hidden);
$$;

create or replace function public.live_thread_payload(t public.live_threads)
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'id', t.id, 'author_id', t.author_id, 'author_display_name', t.author_display_name,
    'daf_ref_key', t.daf_ref_key, 'segment_ref', t.segment_ref, 'word_ranges', t.word_ranges,
    'quoted_text', t.quoted_text, 'anchor_segment', t.anchor_segment, 'anchor_word', t.anchor_word,
    'preview', t.preview, 'message_count', t.message_count, 'status', t.status,
    'answer_message_id', t.answer_message_id, 'created_at', t.created_at,
    'last_message_at', t.last_message_at);
$$;

create or replace function public.live_messages_broadcast()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.live_broadcast(
    public.live_message_payload(new),
    case tg_op when 'INSERT' then 'message' else 'message_updated' end,
    'live:thread:' || new.thread_id);
  return new;
end $$;
create trigger live_messages_z_broadcast after insert or update on public.live_messages
  for each row execute function public.live_messages_broadcast();

create or replace function public.live_threads_broadcast()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.hidden then
    perform public.live_broadcast(jsonb_build_object('id', new.id), 'thread_removed',
      'live:daf:' || new.daf_ref_key);
  else
    perform public.live_broadcast(public.live_thread_payload(new),
      case tg_op when 'INSERT' then 'thread' else 'thread_updated' end,
      'live:daf:' || new.daf_ref_key);
  end if;
  return new;
end $$;
create trigger live_threads_broadcast after insert or update on public.live_threads
  for each row execute function public.live_threads_broadcast();

-- ---------------------------------------------------------------------------
-- Realtime authorization: receive on live: topics, track presence; never publish
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('realtime.messages') is not null then
    if not exists (select 1 from pg_policies where schemaname = 'realtime' and tablename = 'messages' and policyname = 'live_receive') then
      create policy live_receive on realtime.messages for select to authenticated
        using (realtime.topic() like 'live:%' and public.live_access());
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'realtime' and tablename = 'messages' and policyname = 'live_presence') then
      create policy live_presence on realtime.messages for insert to authenticated
        with check (realtime.topic() like 'live:%' and extension = 'presence' and public.live_access());
    end if;
  end if;
end $$;
