-- Cloud Chaburah Live, phase 3: notifications.
--
-- Everything is additive: new tables and functions only. Nothing that already exists is
-- altered, except that live_unread_counts() (phase 2) is redefined so a muted discussion no
-- longer shows a number.
--
--   live_notification_prefs  one row per person: what they want to hear about, and when
--   live_daf_prefs           dapim followed or muted
--   live_thread_mutes        discussions muted
--   live_notifications       the inbox (also the queue background alerts are sent from)
--   push_subscriptions       one row per device that agreed to background alerts
--
-- The write path stays "SECURITY DEFINER functions only": none of these tables has an RLS
-- policy, so the API cannot read or change them directly, and push keys are never readable.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table if not exists public.live_notification_prefs (
  user_id uuid primary key references auth.users(id) on delete cascade,
  all_off boolean not null default false,
  snooze_until timestamptz,
  -- Where: in the panel, and/or as a background alert on devices that agreed.
  in_app_enabled boolean not null default true,
  push_enabled boolean not null default false,
  -- What (combinable): my discussions; my dapim; everything; and live alerts while using the site.
  lvl_mine boolean not null default true,
  lvl_daf boolean not null default false,
  lvl_everywhere boolean not null default false,
  lvl_while_using boolean not null default false,
  everywhere_mode text not null default 'digest' check (everywhere_mode in ('digest', 'live')),
  -- When.
  timezone text not null default 'UTC',
  batch_minutes smallint not null default 5 check (batch_minutes in (0, 5, 15, 60)),
  digest_enabled boolean not null default false,
  digest_hour smallint not null default 20 check (digest_hour between 0 and 23),
  quiet_enabled boolean not null default false,
  quiet_start smallint not null default 22 check (quiet_start between 0 and 23),
  quiet_end smallint not null default 7 check (quiet_end between 0 and 23),
  -- The daf the reader has open (kept fresh by the page), for "my daf" alerts.
  current_daf_key text check (char_length(current_daf_key) <= 80),
  current_daf_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.live_daf_prefs (
  user_id uuid not null references auth.users(id) on delete cascade,
  daf_ref_key text not null check (char_length(daf_ref_key) between 1 and 80),
  following boolean not null default false,
  muted boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, daf_ref_key)
);
create index if not exists live_daf_prefs_following on public.live_daf_prefs (daf_ref_key) where following and not muted;

create table if not exists public.live_thread_mutes (
  user_id uuid not null references auth.users(id) on delete cascade,
  thread_id uuid not null references public.live_threads(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, thread_id)
);

create table if not exists public.live_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in
    ('mention', 'reply_to_me', 'reply_to_thread', 'followed_activity', 'new_thread_daf', 'new_thread_everywhere')),
  thread_id uuid not null references public.live_threads(id) on delete cascade,
  message_id uuid not null references public.live_messages(id) on delete cascade,
  daf_ref_key text not null,
  actor_id uuid references auth.users(id) on delete set null,
  actor_display_name text not null,
  preview text not null,
  in_app boolean not null default true,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  -- Background alert: none (not wanted / no device), pending (waiting for its time), sent, skipped.
  push_state text not null default 'none' check (push_state in ('none', 'pending', 'sent', 'skipped')),
  deliver_after timestamptz,
  digest boolean not null default false,
  -- One notification per person per message, however many reasons there were.
  unique (user_id, message_id)
);
create index if not exists live_notifications_inbox on public.live_notifications (user_id, created_at desc) where in_app;
create index if not exists live_notifications_unread on public.live_notifications (user_id) where in_app and read_at is null;
create index if not exists live_notifications_push_due on public.live_notifications (deliver_after) where push_state = 'pending';
create index if not exists live_notifications_thread on public.live_notifications (thread_id);

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique check (char_length(endpoint) between 20 and 2000),
  p256dh text not null check (char_length(p256dh) between 20 and 200),
  auth text not null check (char_length(auth) between 8 and 100),
  label text not null default '' check (char_length(label) <= 80),
  created_at timestamptz not null default now(),
  last_sent_at timestamptz
);
create index if not exists push_subscriptions_user on public.push_subscriptions (user_id);

alter table public.live_notification_prefs enable row level security;
alter table public.live_daf_prefs enable row level security;
alter table public.live_thread_mutes enable row level security;
alter table public.live_notifications enable row level security;
alter table public.push_subscriptions enable row level security;
-- No policies on purpose: the API reaches these only through the functions below.
revoke all on public.live_notification_prefs, public.live_daf_prefs, public.live_thread_mutes,
  public.live_notifications, public.push_subscriptions from anon, authenticated;

-- What someone who has never opened the settings gets. Keys are named, so a column added to the
-- table later cannot shift them; the test suite checks they match the table's own defaults.
create or replace function public.live_default_prefs(p_uid uuid)
returns public.live_notification_prefs language sql stable set search_path = public as $$
  select jsonb_populate_record(null::public.live_notification_prefs, jsonb_build_object(
    'user_id', p_uid, 'all_off', false, 'in_app_enabled', true, 'push_enabled', false,
    'lvl_mine', true, 'lvl_daf', false, 'lvl_everywhere', false, 'lvl_while_using', false,
    'everywhere_mode', 'digest', 'timezone', 'UTC', 'batch_minutes', 5, 'digest_enabled', false,
    'digest_hour', 20, 'quiet_enabled', false, 'quiet_start', 22, 'quiet_end', 7,
    'updated_at', now()));
$$;

create or replace function public.live_prefs_or_default(p_uid uuid)
returns public.live_notification_prefs language sql stable set search_path = public as $$
  select coalesce((select np from public.live_notification_prefs np where np.user_id = p_uid),
                  public.live_default_prefs(p_uid));
$$;

-- ---------------------------------------------------------------------------
-- When may a background alert go out? Batching, quiet hours, a snooze,
-- and the daily digest hour, all in the person's own time zone.
-- ---------------------------------------------------------------------------
create or replace function public.live_push_time(p public.live_notification_prefs, p_digest boolean)
returns timestamptz language plpgsql stable set search_path = public as $$
declare
  v_tz text := coalesce(p.timezone, 'UTC');
  v_t timestamptz := now() + make_interval(mins => coalesce(p.batch_minutes, 0));
  v_local timestamp;
  v_hour integer;
  v_pass integer;
begin
  if p_digest then
    v_local := now() at time zone v_tz;
    v_t := (date_trunc('day', v_local) + make_interval(hours => p.digest_hour)) at time zone v_tz;
    if v_t <= now() then
      v_t := (date_trunc('day', v_local) + interval '1 day' + make_interval(hours => p.digest_hour)) at time zone v_tz;
    end if;
  end if;
  for v_pass in 1..3 loop
    if p.quiet_enabled and p.quiet_start <> p.quiet_end then
      v_local := v_t at time zone v_tz;
      v_hour := extract(hour from v_local);
      if (p.quiet_start < p.quiet_end and v_hour >= p.quiet_start and v_hour < p.quiet_end)
         or (p.quiet_start > p.quiet_end and (v_hour >= p.quiet_start or v_hour < p.quiet_end)) then
        v_local := date_trunc('day', v_local) + make_interval(hours => p.quiet_end);
        if v_local <= (v_t at time zone v_tz) then v_local := v_local + interval '1 day'; end if;
        v_t := v_local at time zone v_tz;
      end if;
    end if;
  end loop;
  if p.snooze_until is not null and p.snooze_until > v_t then v_t := p.snooze_until; end if;
  return v_t;
end $$;

-- ---------------------------------------------------------------------------
-- Who hears about a new message. One notification per person per message, for the most
-- specific reason: a mention, then a reply to them, then activity in their own discussion,
-- then one they follow; for a new discussion, the dapim they follow, then everything.
-- ---------------------------------------------------------------------------
create or replace function public.live_messages_notify()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  t public.live_threads;
  v_first boolean;
  v_quoted_author uuid;
  v_everyone boolean;
  v_preview text;
begin
  if new.hidden or new.deleted_at is not null then return new; end if;
  select * into t from public.live_threads where id = new.thread_id;
  if not found or t.hidden then return new; end if;
  v_first := t.message_count <= 1;
  select author_id into v_quoted_author from public.live_messages where id = new.quoted_message_id;
  select coalesce(audience = 'everyone', false) into v_everyone from public.live_settings where id;
  v_preview := left(btrim(regexp_replace(new.body, '\s+', ' ', 'g')), 140);

  insert into public.live_notifications
    (user_id, kind, thread_id, message_id, daf_ref_key, actor_id, actor_display_name, preview,
     in_app, push_state, deliver_after, digest)
  select c.user_id, c.kind, t.id, new.id, t.daf_ref_key, new.author_id, new.author_display_name, v_preview,
         p.in_app_enabled,
         case when p.push_enabled and exists (select 1 from public.push_subscriptions s where s.user_id = c.user_id)
              then 'pending' else 'none' end,
         case when p.push_enabled then public.live_push_time(p, dg.is_digest) end,
         dg.is_digest
    from (
      select distinct on (u.user_id) u.user_id, u.kind
        from (
          -- Someone replied in a discussion this person started.
          select t.author_id as user_id, 'reply_to_thread'::text as kind, 3 as prio where not v_first
          union all
          -- Someone replied to this person's own message.
          select v_quoted_author, 'reply_to_me', 2 where v_quoted_author is not null
          union all
          -- Activity in a discussion they follow.
          select f.user_id, 'followed_activity', 4
            from public.live_thread_follows f where f.thread_id = t.id and not v_first
          union all
          -- Mentioned by name ("@Name"), among the people in the conversation.
          select m.user_id, 'mention', 1
            from (select t.author_id as user_id
                  union select f.user_id from public.live_thread_follows f where f.thread_id = t.id
                  union select lm.author_id from public.live_messages lm where lm.thread_id = t.id) m
           where position('@' in new.body) > 0
             and lower(new.body) ~ ('@' || regexp_replace(lower(public.live_display_name(m.user_id)),
                   '([.*+?^${}()|\[\]\\])', '\\\1', 'g') || '(?![[:alnum:]_])')
          union all
          -- A new discussion on a daf they follow, or the one they have open.
          select dp.user_id, 'new_thread_daf', 5
            from public.live_daf_prefs dp where v_first and dp.daf_ref_key = t.daf_ref_key and dp.following and not dp.muted
          union all
          select np.user_id, 'new_thread_daf', 5
            from public.live_notification_prefs np
           where v_first and np.current_daf_key = t.daf_ref_key and np.current_daf_at > now() - interval '30 minutes'
          union all
          -- A new discussion anywhere, for those who asked for everything.
          (select np.user_id, 'new_thread_everywhere', 6
             from public.live_notification_prefs np where v_first and np.lvl_everywhere
            order by np.updated_at desc limit 500)
        ) u
       order by u.user_id, u.prio
    ) c
    join public.profiles pr on pr.id = c.user_id
    cross join lateral (select * from public.live_prefs_or_default(c.user_id)) p
    cross join lateral (
      select (p.digest_enabled or (c.kind = 'new_thread_everywhere' and p.everywhere_mode = 'digest')) as is_digest
    ) dg
   where c.user_id <> new.author_id
     and (v_everyone or pr.is_admin)
     and not p.all_off
     and case c.kind
           when 'new_thread_daf' then p.lvl_daf
           when 'new_thread_everywhere' then p.lvl_everywhere
           else p.lvl_mine end
     and (p.in_app_enabled or p.push_enabled)
     and not exists (select 1 from public.live_thread_mutes mu where mu.user_id = c.user_id and mu.thread_id = t.id)
     and not exists (select 1 from public.live_daf_prefs dm where dm.user_id = c.user_id and dm.daf_ref_key = t.daf_ref_key and dm.muted)
  on conflict (user_id, message_id) do nothing;
  return new;
exception when others then
  -- Telling people must never be the reason a message fails to save.
  raise warning 'live_messages_notify failed: %', sqlerrm;
  return new;
end $$;
-- Named to run after the counter trigger and before the broadcast (same event: alphabetical).
drop trigger if exists live_messages_y_notify on public.live_messages;
create trigger live_messages_y_notify after insert on public.live_messages
  for each row execute function public.live_messages_notify();

-- Reading a discussion clears its notifications, so the inbox and the unread counts agree.
create or replace function public.live_read_state_clear_notifications()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.live_notifications n set read_at = now()
    from public.live_messages m
   where n.user_id = new.user_id and n.thread_id = new.thread_id and n.read_at is null
     and m.id = n.message_id and m.seq <= new.last_read_seq;
  return new;
end $$;
drop trigger if exists live_read_state_clear_notifications on public.live_read_state;
create trigger live_read_state_clear_notifications after insert or update on public.live_read_state
  for each row execute function public.live_read_state_clear_notifications();

-- A new notification reaches an open page at once, on a channel only its owner may join.
create or replace function public.live_notifications_broadcast()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.in_app then
    perform public.live_broadcast(jsonb_build_object(
      'id', new.id, 'kind', new.kind, 'thread_id', new.thread_id, 'message_id', new.message_id,
      'daf_ref_key', new.daf_ref_key, 'actor_display_name', new.actor_display_name,
      'preview', new.preview, 'created_at', new.created_at), 'notification', 'notify:user:' || new.user_id::text);
  end if;
  return new;
end $$;
drop trigger if exists live_notifications_broadcast on public.live_notifications;
create trigger live_notifications_broadcast after insert on public.live_notifications
  for each row execute function public.live_notifications_broadcast();

-- ---------------------------------------------------------------------------
-- The API for readers
-- ---------------------------------------------------------------------------
create or replace function public.live_require_reader()
returns uuid language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'live_not_signed_in' using errcode = '42501'; end if;
  if not public.live_access() then raise exception 'live_not_available' using errcode = '42501'; end if;
  return auth.uid();
end $$;

-- Everything the settings view and the bell need, in one call.
create or replace function public.live_my_notification_state(p_daf_ref_key text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := public.live_require_reader();
  v_prefs public.live_notification_prefs;
begin
  v_prefs := public.live_prefs_or_default(v_uid);
  return jsonb_build_object(
    'prefs', to_jsonb(v_prefs) - 'user_id' - 'current_daf_key' - 'current_daf_at' - 'updated_at',
    'daf', coalesce((select jsonb_build_object('following', d.following, 'muted', d.muted)
                       from public.live_daf_prefs d where d.user_id = v_uid and d.daf_ref_key = p_daf_ref_key),
                    jsonb_build_object('following', false, 'muted', false)),
    'muted_thread_ids', coalesce((select jsonb_agg(thread_id) from (
                          select thread_id from public.live_thread_mutes where user_id = v_uid limit 500) mt), '[]'::jsonb),
    'devices', coalesce((select jsonb_agg(jsonb_build_object(
                          'id', s.id, 'label', s.label, 'created_at', s.created_at,
                          'host', substring(s.endpoint from '^https://([^/]+)')) order by s.created_at)
                         from public.push_subscriptions s where s.user_id = v_uid), '[]'::jsonb),
    'unread', (select count(*) from public.live_notifications n
                where n.user_id = v_uid and n.in_app and n.read_at is null),
    'daf_follows', coalesce((select jsonb_agg(daf_ref_key) from (
                      select daf_ref_key from public.live_daf_prefs where user_id = v_uid and following order by updated_at desc limit 100) df), '[]'::jsonb));
end $$;

create or replace function public.live_set_notification_prefs(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.live_require_reader();
  r public.live_notification_prefs;
  v_text text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'live_invalid_input' using errcode = '22023'; end if;
  insert into public.live_notification_prefs (user_id) values (v_uid) on conflict do nothing;
  select * into r from public.live_notification_prefs where user_id = v_uid;

  if p ? 'all_off' then r.all_off := (p ->> 'all_off')::boolean; end if;
  if p ? 'in_app_enabled' then r.in_app_enabled := (p ->> 'in_app_enabled')::boolean; end if;
  if p ? 'push_enabled' then r.push_enabled := (p ->> 'push_enabled')::boolean; end if;
  if p ? 'lvl_mine' then r.lvl_mine := (p ->> 'lvl_mine')::boolean; end if;
  if p ? 'lvl_daf' then r.lvl_daf := (p ->> 'lvl_daf')::boolean; end if;
  if p ? 'lvl_everywhere' then r.lvl_everywhere := (p ->> 'lvl_everywhere')::boolean; end if;
  if p ? 'lvl_while_using' then r.lvl_while_using := (p ->> 'lvl_while_using')::boolean; end if;
  if p ? 'everywhere_mode' then r.everywhere_mode := p ->> 'everywhere_mode'; end if;
  if p ? 'batch_minutes' then r.batch_minutes := (p ->> 'batch_minutes')::smallint; end if;
  if p ? 'digest_enabled' then r.digest_enabled := (p ->> 'digest_enabled')::boolean; end if;
  if p ? 'digest_hour' then r.digest_hour := (p ->> 'digest_hour')::smallint; end if;
  if p ? 'quiet_enabled' then r.quiet_enabled := (p ->> 'quiet_enabled')::boolean; end if;
  if p ? 'quiet_start' then r.quiet_start := (p ->> 'quiet_start')::smallint; end if;
  if p ? 'quiet_end' then r.quiet_end := (p ->> 'quiet_end')::smallint; end if;
  if p ? 'timezone' then
    v_text := p ->> 'timezone';
    if v_text is null or not exists (select 1 from pg_timezone_names where name = v_text) then
      raise exception 'live_invalid_input' using errcode = '22023';
    end if;
    r.timezone := v_text;
  end if;
  if p ? 'snooze_until' then
    if jsonb_typeof(p -> 'snooze_until') = 'null' then
      r.snooze_until := null;
    else
      r.snooze_until := (p ->> 'snooze_until')::timestamptz;
      if r.snooze_until > now() + interval '8 days' then r.snooze_until := now() + interval '8 days'; end if;
      if r.snooze_until <= now() then r.snooze_until := null; end if;
    end if;
  end if;

  update public.live_notification_prefs set
    all_off = r.all_off, snooze_until = r.snooze_until, in_app_enabled = r.in_app_enabled,
    push_enabled = r.push_enabled, lvl_mine = r.lvl_mine, lvl_daf = r.lvl_daf,
    lvl_everywhere = r.lvl_everywhere, lvl_while_using = r.lvl_while_using,
    everywhere_mode = r.everywhere_mode, timezone = r.timezone, batch_minutes = r.batch_minutes,
    digest_enabled = r.digest_enabled, digest_hour = r.digest_hour, quiet_enabled = r.quiet_enabled,
    quiet_start = r.quiet_start, quiet_end = r.quiet_end, updated_at = now()
  where user_id = v_uid;

  -- Turning background alerts (or everything) off also cancels the ones still waiting.
  if r.all_off or not r.push_enabled then
    update public.live_notifications set push_state = 'skipped', deliver_after = null
     where user_id = v_uid and push_state = 'pending';
  end if;
exception
  when invalid_text_representation or numeric_value_out_of_range or check_violation or datetime_field_overflow
       or invalid_datetime_format then
    raise exception 'live_invalid_input' using errcode = '22023';
end $$;

-- The daf the reader has open: lets "my daf" alerts reach them while they learn it.
create or replace function public.live_set_current_daf(p_daf_ref_key text)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.live_require_reader();
begin
  if p_daf_ref_key is null or char_length(p_daf_ref_key) not between 1 and 80 then
    raise exception 'live_invalid_input' using errcode = '22023';
  end if;
  insert into public.live_notification_prefs (user_id, current_daf_key, current_daf_at)
  values (v_uid, p_daf_ref_key, now())
  on conflict (user_id) do update set current_daf_key = excluded.current_daf_key, current_daf_at = excluded.current_daf_at;
end $$;

create or replace function public.live_set_daf_pref(p_daf_ref_key text, p_following boolean default null, p_muted boolean default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.live_require_reader();
begin
  if p_daf_ref_key is null or char_length(p_daf_ref_key) not between 1 and 80 then
    raise exception 'live_invalid_input' using errcode = '22023';
  end if;
  if coalesce(p_following, false) and (select count(*) from public.live_daf_prefs
       where user_id = v_uid and following and daf_ref_key <> p_daf_ref_key) >= 100 then
    raise exception 'live_too_many_dapim' using errcode = '54000';
  end if;
  insert into public.live_daf_prefs (user_id, daf_ref_key, following, muted)
  values (v_uid, p_daf_ref_key, coalesce(p_following, false), coalesce(p_muted, false))
  on conflict (user_id, daf_ref_key) do update set
    following = coalesce(p_following, public.live_daf_prefs.following),
    muted = coalesce(p_muted, public.live_daf_prefs.muted),
    updated_at = now();
  delete from public.live_daf_prefs
   where user_id = v_uid and daf_ref_key = p_daf_ref_key and not following and not muted;
end $$;

create or replace function public.live_set_thread_muted(p_thread_id uuid, p_muted boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.live_require_reader();
begin
  if not exists (select 1 from public.live_threads where id = p_thread_id and not hidden) then
    raise exception 'live_thread_missing' using errcode = 'P0002';
  end if;
  if coalesce(p_muted, false) then
    insert into public.live_thread_mutes (user_id, thread_id) values (v_uid, p_thread_id) on conflict do nothing;
  else
    delete from public.live_thread_mutes where user_id = v_uid and thread_id = p_thread_id;
  end if;
end $$;

create or replace function public.live_list_notifications(p_limit integer default 50, p_before timestamptz default null)
returns table (id uuid, kind text, thread_id uuid, message_id uuid, daf_ref_key text, actor_display_name text,
               preview text, thread_preview text, created_at timestamptz, read_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := public.live_require_reader();
begin
  return query
    select n.id, n.kind, n.thread_id, n.message_id, n.daf_ref_key, n.actor_display_name, n.preview,
           t.preview, n.created_at, n.read_at
      from public.live_notifications n
      join public.live_threads t on t.id = n.thread_id and not t.hidden
     where n.user_id = v_uid and n.in_app and (p_before is null or n.created_at < p_before)
     order by n.created_at desc
     limit least(greatest(coalesce(p_limit, 50), 1), 100);
end $$;

create or replace function public.live_mark_notifications_read(p_thread_id uuid default null, p_all boolean default false)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.live_require_reader();
begin
  update public.live_notifications set read_at = now()
   where user_id = v_uid and read_at is null and in_app
     and (coalesce(p_all, false) or thread_id = p_thread_id);
end $$;

-- ---------------------------------------------------------------------------
-- Devices (background alerts). A device is added only by the person's own request, from the
-- browser's own permission prompt; the keys are write-only for them.
-- ---------------------------------------------------------------------------
create or replace function public.live_save_push_subscription(
  p_endpoint text, p_p256dh text, p_auth text, p_label text default '')
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.live_require_reader();
begin
  if p_endpoint is null or p_endpoint !~ '^https://' or char_length(p_endpoint) not between 20 and 2000
     or p_p256dh is null or p_auth is null then
    raise exception 'live_invalid_input' using errcode = '22023';
  end if;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, label)
  values (v_uid, p_endpoint, p_p256dh, p_auth, left(coalesce(p_label, ''), 80))
  on conflict (endpoint) do update set
    user_id = v_uid, p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label;
  -- Ten devices at most; the oldest makes room.
  delete from public.push_subscriptions where id in (
    select id from public.push_subscriptions where user_id = v_uid order by created_at desc offset 10);
  insert into public.live_notification_prefs (user_id, push_enabled) values (v_uid, true)
  on conflict (user_id) do update set push_enabled = true, updated_at = now();
end $$;

create or replace function public.live_remove_push_subscription(p_device_id uuid default null, p_endpoint text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.live_require_reader();
begin
  delete from public.push_subscriptions
   where user_id = v_uid and ((p_device_id is not null and id = p_device_id) or (p_endpoint is not null and endpoint = p_endpoint));
  if not exists (select 1 from public.push_subscriptions where user_id = v_uid) then
    update public.live_notifications set push_state = 'skipped', deliver_after = null
     where user_id = v_uid and push_state = 'pending';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- The sender (a scheduled function holding the service key) asks for what is due. Alerts are
-- grouped per person: one per discussion, or a single digest. Anything already read is
-- dropped rather than sent.
-- ---------------------------------------------------------------------------
create or replace function public.live_push_claim(p_limit integer default 100)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_result jsonb;
begin
  with due as (
    select n.id from public.live_notifications n
     where n.push_state = 'pending' and n.deliver_after <= now()
     order by n.deliver_after
     limit greatest(least(coalesce(p_limit, 100), 500), 1) * 20
       for update skip locked
  ), judged as (
    select n.*, m.seq,
           (exists (select 1 from public.live_read_state r where r.user_id = n.user_id and r.thread_id = n.thread_id and r.last_read_seq >= m.seq)
            or n.read_at is not null
            or exists (select 1 from public.live_thread_mutes mu where mu.user_id = n.user_id and mu.thread_id = n.thread_id)
            or coalesce((select np.all_off or not np.push_enabled from public.live_notification_prefs np where np.user_id = n.user_id), true)
            or not exists (select 1 from public.push_subscriptions s where s.user_id = n.user_id)) as drop_it
      from public.live_notifications n
      join due d on d.id = n.id
      join public.live_messages m on m.id = n.message_id
  ), marked as (
    update public.live_notifications n
       set push_state = case when j.drop_it then 'skipped' else 'sent' end
      from judged j where j.id = n.id
    returning n.id
  )
  select coalesce(jsonb_agg(person), '[]'::jsonb) into v_result from (
    select jsonb_build_object(
      'user_id', j.user_id,
      'digest', bool_or(j.digest),
      'devices', (select jsonb_agg(jsonb_build_object('id', s.id, 'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth))
                    from public.push_subscriptions s where s.user_id = j.user_id),
      'items', jsonb_agg(jsonb_build_object(
        'thread_id', j.thread_id, 'daf_ref_key', j.daf_ref_key, 'kind', j.kind,
        'actor', j.actor_display_name, 'preview', j.preview) order by j.created_at desc)) as person
      from judged j
     where not j.drop_it
     group by j.user_id
     limit greatest(least(coalesce(p_limit, 100), 500), 1)
  ) people;
  return v_result;
end $$;

create or replace function public.live_push_drop(p_endpoint text)
returns void language sql security definer set search_path = public as $$
  delete from public.push_subscriptions where endpoint = p_endpoint;
$$;

-- ---------------------------------------------------------------------------
-- Phase 2's counts, now leaving out muted discussions
-- ---------------------------------------------------------------------------
create or replace function public.live_unread_counts(p_daf_ref_key text default null)
returns table (thread_id uuid, daf_ref_key text, unread bigint)
language sql stable security definer set search_path = public as $$
  select t.id, t.daf_ref_key, count(m.id)
    from public.live_threads t
    join public.live_thread_follows f on f.thread_id = t.id and f.user_id = auth.uid()
    left join public.live_read_state r on r.thread_id = t.id and r.user_id = auth.uid()
    join public.live_messages m on m.thread_id = t.id and m.seq > coalesce(r.last_read_seq, 0)
     and m.author_id <> auth.uid() and m.deleted_at is null and not m.hidden
   where auth.uid() is not null and public.live_access() and not t.hidden
     and (p_daf_ref_key is null or t.daf_ref_key = p_daf_ref_key)
     and not exists (select 1 from public.live_thread_mutes mu where mu.user_id = auth.uid() and mu.thread_id = t.id)
   group by t.id, t.daf_ref_key
   limit 500;
$$;

-- ---------------------------------------------------------------------------
-- Realtime: your own notifications channel, and nobody else's
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('realtime.messages') is not null then
    if not exists (select 1 from pg_policies where schemaname = 'realtime' and tablename = 'messages' and policyname = 'live_notify_receive') then
      create policy live_notify_receive on realtime.messages for select to authenticated
        using (realtime.topic() = 'notify:user:' || auth.uid()::text and public.live_access());
    end if;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Who may call what
-- ---------------------------------------------------------------------------
revoke all on function
  public.live_push_time(public.live_notification_prefs, boolean), public.live_default_prefs(uuid),
  public.live_prefs_or_default(uuid),
  public.live_messages_notify(), public.live_read_state_clear_notifications(),
  public.live_notifications_broadcast(), public.live_require_reader(),
  public.live_push_claim(integer), public.live_push_drop(text),
  public.live_my_notification_state(text), public.live_set_notification_prefs(jsonb),
  public.live_set_current_daf(text), public.live_set_daf_pref(text, boolean, boolean),
  public.live_set_thread_muted(uuid, boolean), public.live_list_notifications(integer, timestamptz),
  public.live_mark_notifications_read(uuid, boolean), public.live_save_push_subscription(text, text, text, text),
  public.live_remove_push_subscription(uuid, text), public.live_unread_counts(text)
  from public, anon, authenticated;

grant execute on function
  public.live_my_notification_state(text), public.live_set_notification_prefs(jsonb),
  public.live_set_current_daf(text), public.live_set_daf_pref(text, boolean, boolean),
  public.live_set_thread_muted(uuid, boolean), public.live_list_notifications(integer, timestamptz),
  public.live_mark_notifications_read(uuid, boolean), public.live_save_push_subscription(text, text, text, text),
  public.live_remove_push_subscription(uuid, text), public.live_unread_counts(text)
  to authenticated;

-- The sender runs with the service key only.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.live_push_claim(integer), public.live_push_drop(text) to service_role;
  end if;
end $$;
