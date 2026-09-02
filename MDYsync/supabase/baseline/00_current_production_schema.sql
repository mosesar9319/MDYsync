-- A local, runnable replica of the CURRENT production public schema
-- (Supabase project cyexvsymuivvvhvpeber), reconstructed on 2026-09-02 from
-- pg_catalog: table definitions, constraints, RLS policies, functions,
-- triggers, indexes and grants -- including the grant tightening applied in
-- migration 20260902180000.
--
-- Why this exists: the Playwright suite stubs Supabase entirely and therefore
-- cannot prove authorization (see tests/README.md). RLS and SECURITY DEFINER
-- behaviour has to be exercised against a real Postgres, and doing that
-- against production would mean writing test rows into the live database. So
-- migrations and the adversarial RLS tests run here instead.
--
-- This is a TEST FIXTURE, not a production dump. Two deliberate differences:
--   * auth.uid() is implemented the way Supabase implements it (reading the
--     request.jwt.claim.sub GUC) so tests can impersonate a role with
--     `set local role` + `set local request.jwt.claim.sub`.
--   * handle_new_user() hardcodes an admin email in production; here it uses
--     an obviously-fake address. Nothing depends on the specific value.
--
-- Usage: see supabase/README.md.

-- ---------------------------------------------------------------------------
-- Roles and auth shim
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end $$;

grant usage on schema public to anon, authenticated, service_role;

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  created_at timestamptz not null default now()
);

-- Matches Supabase's own definition: the current request's JWT subject.
create or replace function auth.uid() returns uuid
  language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.series (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  speaker text,
  description text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.favorites (
  user_id uuid not null references auth.users(id) on delete cascade,
  ref_key text not null,
  variant text not null default 'regular' check (variant = any (array['regular','chazarah'])),
  ref_display text,
  created_at timestamptz not null default now(),
  primary key (user_id, ref_key, variant)
);

create table if not exists public.progress (
  user_id uuid not null references auth.users(id) on delete cascade,
  ref_key text not null,
  variant text not null default 'regular' check (variant = any (array['regular','chazarah'])),
  ref_display text,
  position_seconds numeric not null default 0,
  duration_seconds numeric,
  updated_at timestamptz not null default now(),
  primary key (user_id, ref_key, variant)
);

create table if not exists public.preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.line_notes (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references auth.users(id) on delete cascade,
  author_display_name text not null,
  daf_ref_key text not null,
  segment_ref text not null,
  body text not null check (char_length(body) >= 1 and char_length(body) <= 2000),
  hidden boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  is_private boolean not null default false,
  start_word integer,
  end_word integer,
  selected_text text,
  mentioned_user_ids uuid[] not null default '{}'::uuid[],
  body_tsv tsvector generated always as (
    to_tsvector('simple'::regconfig, ((coalesce(body, ''::text) || ' '::text) || coalesce(selected_text, ''::text)))
  ) stored,
  category text check (category = any (array[
    'question','insight','difficulty','explanation','answer','further_study',
    'textual_precision','source','practical_implication','summary',
    'needs_clarification','alternative_approach','supporting_proof',
    'parallel_passage','practical_halacha','background','review_point','lesson'
  ])),
  video_timestamp_seconds numeric check (video_timestamp_seconds is null or video_timestamp_seconds >= 0),
  is_demo boolean not null default false,
  word_ranges jsonb check (word_ranges is null or (jsonb_typeof(word_ranges) = 'array' and jsonb_array_length(word_ranges) > 0)),
  constraint line_notes_word_range_check check (
    ((start_word is null) and (end_word is null) and (selected_text is null))
    or ((start_word is not null) and (end_word is not null) and (selected_text is not null)
        and (start_word >= 0) and (end_word >= start_word))
  )
);

create table if not exists public.comments (
  id uuid primary key default gen_random_uuid(),
  note_id uuid not null references public.line_notes(id) on delete cascade,
  author_id uuid not null references auth.users(id),
  author_display_name text not null,
  body text not null check (char_length(body) >= 1 and char_length(body) <= 2000),
  hidden boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  parent_comment_id uuid references public.comments(id) on delete cascade,
  mentioned_user_ids uuid[] not null default '{}'::uuid[],
  body_tsv tsvector generated always as (to_tsvector('simple'::regconfig, body)) stored,
  is_demo boolean not null default false
);

create table if not exists public.reactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  target_type text not null check (target_type = any (array['note','comment'])),
  target_id uuid not null,
  created_at timestamptz not null default now(),
  reaction_type text not null default 'helpful'
    check (reaction_type = any (array['helpful','insightful','chazak','shtark','great_kasha'])),
  unique (user_id, target_type, target_id, reaction_type)
);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  type text not null check (type = any (array['reply','mention','thread'])),
  actor_id uuid not null references auth.users(id),
  actor_display_name text not null,
  note_id uuid not null references public.line_notes(id) on delete cascade,
  comment_id uuid references public.comments(id) on delete cascade,
  daf_ref_key text not null,
  segment_ref text not null,
  preview text not null,
  read boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.thread_follows (
  user_id uuid not null references auth.users(id),
  note_id uuid not null references public.line_notes(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, note_id)
);

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references auth.users(id),
  target_type text not null check (target_type = any (array['note','comment','anchor'])),
  target_id uuid,
  reason text not null default ''::text check (char_length(reason) <= 500),
  status text not null default 'pending' check (status = any (array['pending','resolved','dismissed'])),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id),
  daf_ref_key text,
  segment_ref text,
  start_word integer,
  end_word integer,
  quoted_text text,
  constraint reports_target_shape_check check (
    ((target_type = 'anchor') and (target_id is null) and (segment_ref is not null))
    or ((target_type = any (array['note','comment'])) and (target_id is not null))
  )
);

create table if not exists public.highlights (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  daf_ref_key text not null,
  segment_ref text not null,
  start_word integer not null check (start_word >= 0),
  end_word integer not null,
  selected_text text,
  created_at timestamptz not null default now(),
  word_ranges jsonb check (word_ranges is null or (jsonb_typeof(word_ranges) = 'array' and jsonb_array_length(word_ranges) > 0)),
  constraint highlights_word_range_check check (end_word >= start_word)
);

-- ---------------------------------------------------------------------------
-- Functions (all SECURITY DEFINER with an explicit search_path, as in prod)
-- ---------------------------------------------------------------------------
create or replace function public.is_admin() returns boolean
  language sql security definer set search_path to 'public'
as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

create or replace function public.can_post_publicly() returns boolean
  language sql security definer set search_path to 'public'
as $$
  select
    exists (
      select 1 from public.profiles
      where id = auth.uid() and created_at <= now() - interval '24 hours'
    )
    and (
      (select count(*) from public.line_notes where author_id = auth.uid() and is_private = false and created_at > now() - interval '1 hour')
      + (select count(*) from public.comments where author_id = auth.uid() and created_at > now() - interval '1 hour')
    ) < 10;
$$;

-- Production hardcodes the owner's real address here; a fake one is used in
-- this fixture deliberately (nothing depends on the value).
create or replace function public.handle_new_user() returns trigger
  language plpgsql security definer set search_path to 'public'
as $$
begin
  insert into public.profiles (id, email, is_admin)
  values (new.id, new.email, new.email = 'admin@example.test');
  return new;
end;
$$;

create or replace function public.line_notes_guard_hidden() returns trigger
  language plpgsql security definer set search_path to 'public'
as $$
begin
  if NEW.hidden is distinct from OLD.hidden and not public.is_admin() then
    NEW.hidden := OLD.hidden;
  end if;
  NEW.updated_at := now();
  return NEW;
end;
$$;

create or replace function public.validate_mentions() returns trigger
  language plpgsql security definer set search_path to 'public'
as $$
declare
  mention_count integer;
begin
  if new.mentioned_user_ids is null then
    new.mentioned_user_ids := '{}';
    return new;
  end if;
  mention_count := array_length(new.mentioned_user_ids, 1);
  if mention_count is not null and mention_count > 5 then
    raise exception 'Too many mentions (max 5).';
  end if;
  if mention_count is not null and exists (
    select 1 from unnest(new.mentioned_user_ids) as uid
    where not exists (select 1 from auth.users u where u.id = uid)
  ) then
    raise exception 'One or more mentioned users do not exist.';
  end if;
  return new;
end;
$$;

create or replace function public.notify_on_note_insert() returns trigger
  language plpgsql security definer set search_path to 'public'
as $$
declare
  v_mentioned uuid;
begin
  if not new.is_private then
    insert into public.thread_follows (user_id, note_id) values (new.author_id, new.id)
    on conflict (user_id, note_id) do nothing;
  end if;

  if new.is_private or new.mentioned_user_ids is null then
    return new;
  end if;
  foreach v_mentioned in array new.mentioned_user_ids loop
    if v_mentioned <> new.author_id then
      insert into public.notifications
        (user_id, type, actor_id, actor_display_name, note_id, comment_id, daf_ref_key, segment_ref, preview)
      values
        (v_mentioned, 'mention', new.author_id, new.author_display_name, new.id, null, new.daf_ref_key, new.segment_ref, left(new.body, 140));
    end if;
  end loop;
  return new;
end;
$$;

create or replace function public.notify_on_comment_insert() returns trigger
  language plpgsql security definer set search_path to 'public'
as $$
declare
  v_note public.line_notes%rowtype;
  v_recipient uuid;
  v_mentioned uuid;
  v_follower uuid;
  v_already_notified uuid[];
begin
  select * into v_note from public.line_notes where id = new.note_id;

  insert into public.thread_follows (user_id, note_id) values (new.author_id, new.note_id)
  on conflict (user_id, note_id) do nothing;

  if new.parent_comment_id is null then
    v_recipient := v_note.author_id;
  else
    select author_id into v_recipient from public.comments where id = new.parent_comment_id;
  end if;

  v_already_notified := array[new.author_id];

  if v_recipient is not null and v_recipient <> new.author_id then
    insert into public.notifications
      (user_id, type, actor_id, actor_display_name, note_id, comment_id, daf_ref_key, segment_ref, preview)
    values
      (v_recipient, 'reply', new.author_id, new.author_display_name, v_note.id, new.id, v_note.daf_ref_key, v_note.segment_ref, left(new.body, 140));
    v_already_notified := array_append(v_already_notified, v_recipient);
  end if;

  if new.mentioned_user_ids is not null then
    foreach v_mentioned in array new.mentioned_user_ids loop
      if not (v_mentioned = any(v_already_notified)) then
        insert into public.notifications
          (user_id, type, actor_id, actor_display_name, note_id, comment_id, daf_ref_key, segment_ref, preview)
        values
          (v_mentioned, 'mention', new.author_id, new.author_display_name, v_note.id, new.id, v_note.daf_ref_key, v_note.segment_ref, left(new.body, 140));
        v_already_notified := array_append(v_already_notified, v_mentioned);
      end if;
    end loop;
  end if;

  for v_follower in select user_id from public.thread_follows where note_id = new.note_id loop
    if not (v_follower = any(v_already_notified)) then
      insert into public.notifications
        (user_id, type, actor_id, actor_display_name, note_id, comment_id, daf_ref_key, segment_ref, preview)
      values
        (v_follower, 'thread', new.author_id, new.author_display_name, v_note.id, new.id, v_note.daf_ref_key, v_note.segment_ref, left(new.body, 140));
      v_already_notified := array_append(v_already_notified, v_follower);
    end if;
  end loop;

  return new;
end;
$$;

create or replace function public.set_note_hidden(p_note_id uuid, p_hidden boolean) returns void
  language plpgsql security definer set search_path to 'public'
as $$
begin
  if not public.is_admin() then
    raise exception 'only admins can hide or unhide notes' using errcode = '42501';
  end if;
  update public.line_notes set hidden = p_hidden, updated_at = now() where id = p_note_id;
end;
$$;

create or replace function public.set_comment_hidden(p_comment_id uuid, p_hidden boolean) returns void
  language plpgsql security definer set search_path to 'public'
as $$
begin
  if not public.is_admin() then
    raise exception 'only admins can hide or unhide comments' using errcode = '42501';
  end if;
  update public.comments set hidden = p_hidden, updated_at = now() where id = p_comment_id;
end;
$$;

create or replace function public.resolve_report(p_report_id uuid, p_status text) returns void
  language plpgsql security definer set search_path to 'public'
as $$
begin
  if not public.is_admin() then
    raise exception 'only admins can resolve reports' using errcode = '42501';
  end if;
  if p_status not in ('resolved', 'dismissed') then
    raise exception 'invalid status: %', p_status;
  end if;
  update public.reports
  set status = p_status, resolved_at = now(), resolved_by = auth.uid()
  where id = p_report_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

drop trigger if exists line_notes_before_update on public.line_notes;
create trigger line_notes_before_update before update on public.line_notes
  for each row execute function public.line_notes_guard_hidden();

drop trigger if exists line_notes_validate_mentions on public.line_notes;
create trigger line_notes_validate_mentions before insert or update on public.line_notes
  for each row execute function public.validate_mentions();

drop trigger if exists line_notes_notify_after_insert on public.line_notes;
create trigger line_notes_notify_after_insert after insert on public.line_notes
  for each row execute function public.notify_on_note_insert();

drop trigger if exists comments_validate_mentions on public.comments;
create trigger comments_validate_mentions before insert or update on public.comments
  for each row execute function public.validate_mentions();

drop trigger if exists comments_notify_after_insert on public.comments;
create trigger comments_notify_after_insert after insert on public.comments
  for each row execute function public.notify_on_comment_insert();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.profiles       enable row level security;
alter table public.series         enable row level security;
alter table public.favorites      enable row level security;
alter table public.progress       enable row level security;
alter table public.preferences    enable row level security;
alter table public.line_notes     enable row level security;
alter table public.comments       enable row level security;
alter table public.reactions      enable row level security;
alter table public.notifications  enable row level security;
alter table public.thread_follows enable row level security;
alter table public.reports        enable row level security;
alter table public.highlights     enable row level security;

create policy profiles_select_own on public.profiles for select using (auth.uid() = id);
create policy series_public_read on public.series for select using (true);
create policy favorites_owner_all on public.favorites for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy progress_owner_all on public.progress for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy preferences_owner_all on public.preferences for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy highlights_owner_all on public.highlights for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy line_notes_public_read on public.line_notes for select using ((not hidden) and (not is_private));
create policy line_notes_author_read_own on public.line_notes for select using (auth.uid() = author_id);
create policy line_notes_admin_read on public.line_notes for select using (public.is_admin() and (not is_private));
create policy line_notes_insert on public.line_notes for insert
  with check ((auth.uid() = author_id) and (is_private or public.can_post_publicly()));
create policy line_notes_update on public.line_notes for update
  using ((auth.uid() = author_id) or public.is_admin())
  with check ((auth.uid() = author_id) or public.is_admin());
create policy line_notes_delete on public.line_notes for delete
  using ((auth.uid() = author_id) or public.is_admin());

create policy comments_public_read on public.comments for select using (
  (not hidden) and exists (
    select 1 from public.line_notes n
    where n.id = comments.note_id and n.is_private = false and not n.hidden
  )
);
create policy comments_author_read_own on public.comments for select using (auth.uid() = author_id);
create policy comments_admin_read on public.comments for select using (public.is_admin());
create policy comments_insert on public.comments for insert with check (
  (auth.uid() = author_id) and public.can_post_publicly()
  and exists (
    select 1 from public.line_notes n
    where n.id = comments.note_id and n.is_private = false and not n.hidden
  )
  and ((parent_comment_id is null) or exists (
    select 1 from public.comments p
    where p.id = comments.parent_comment_id and p.note_id = comments.note_id
  ))
);
create policy comments_update on public.comments for update
  using ((auth.uid() = author_id) or public.is_admin())
  with check ((auth.uid() = author_id) or public.is_admin());
create policy comments_delete on public.comments for delete
  using ((auth.uid() = author_id) or public.is_admin());

create policy reactions_public_read on public.reactions for select using (
  ((target_type = 'note') and exists (
    select 1 from public.line_notes n where n.id = reactions.target_id and n.is_private = false and not n.hidden))
  or ((target_type = 'comment') and exists (
    select 1 from public.comments c join public.line_notes n on n.id = c.note_id
    where c.id = reactions.target_id and not c.hidden and n.is_private = false and not n.hidden))
);
create policy reactions_author_read_own on public.reactions for select using (auth.uid() = user_id);
create policy reactions_insert on public.reactions for insert with check (
  (auth.uid() = user_id) and (
    ((target_type = 'note') and exists (
      select 1 from public.line_notes n where n.id = reactions.target_id and n.is_private = false and not n.hidden))
    or ((target_type = 'comment') and exists (
      select 1 from public.comments c join public.line_notes n on n.id = c.note_id
      where c.id = reactions.target_id and not c.hidden and n.is_private = false and not n.hidden))
  )
);
create policy reactions_delete on public.reactions for delete using (auth.uid() = user_id);

create policy notifications_select_own on public.notifications for select using (auth.uid() = user_id);
create policy notifications_update_own on public.notifications for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy notifications_delete_own on public.notifications for delete using (auth.uid() = user_id);

create policy thread_follows_select_own on public.thread_follows for select using (auth.uid() = user_id);
create policy thread_follows_insert_own on public.thread_follows for insert with check (
  (auth.uid() = user_id) and exists (
    select 1 from public.line_notes n
    where n.id = thread_follows.note_id and n.is_private = false and not n.hidden
  )
);
create policy thread_follows_delete_own on public.thread_follows for delete using (auth.uid() = user_id);

create policy reports_insert on public.reports for insert with check (auth.uid() = reporter_id);
create policy reports_read_own on public.reports for select using (auth.uid() = reporter_id);
create policy reports_admin_read on public.reports for select using (public.is_admin());

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
create index if not exists line_notes_author_id_idx   on public.line_notes (author_id);
create index if not exists line_notes_body_tsv_idx    on public.line_notes using gin (body_tsv);
create index if not exists line_notes_category_idx    on public.line_notes (category);
create index if not exists line_notes_daf_ref_key_idx on public.line_notes (daf_ref_key);
create index if not exists line_notes_segment_ref_idx on public.line_notes (segment_ref);
create index if not exists comments_author_id_idx         on public.comments (author_id);
create index if not exists comments_body_tsv_idx          on public.comments using gin (body_tsv);
create index if not exists comments_note_id_idx           on public.comments (note_id);
create index if not exists comments_parent_comment_id_idx on public.comments (parent_comment_id);
create index if not exists reactions_target_idx on public.reactions (target_type, target_id);
create index if not exists notifications_user_id_created_at_idx on public.notifications (user_id, created_at desc);
create index if not exists reports_status_idx on public.reports (status);
create index if not exists reports_target_idx on public.reports (target_type, target_id);
create index if not exists highlights_user_daf_idx on public.highlights (user_id, daf_ref_key);

-- Added by migration 20260902180000 (already applied in production).
create index if not exists line_notes_public_feed_idx
  on public.line_notes (created_at desc)
  where not hidden and not is_private;

-- ---------------------------------------------------------------------------
-- Grants -- Supabase's defaults, then the tightening from 20260902180000.
-- ---------------------------------------------------------------------------
grant all on all tables in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
grant select on auth.users to authenticated, service_role;

revoke execute on function public.handle_new_user() from public;
revoke execute on function public.line_notes_guard_hidden() from public;
revoke execute on function public.notify_on_comment_insert() from public;
revoke execute on function public.notify_on_note_insert() from public;
revoke execute on function public.validate_mentions() from public;

revoke execute on function public.resolve_report(uuid, text) from public;
revoke execute on function public.resolve_report(uuid, text) from anon;
grant execute on function public.resolve_report(uuid, text) to authenticated;

revoke execute on function public.set_comment_hidden(uuid, boolean) from public;
revoke execute on function public.set_comment_hidden(uuid, boolean) from anon;
grant execute on function public.set_comment_hidden(uuid, boolean) to authenticated;

revoke execute on function public.set_note_hidden(uuid, boolean) from public;
revoke execute on function public.set_note_hidden(uuid, boolean) from anon;
grant execute on function public.set_note_hidden(uuid, boolean) to authenticated;
