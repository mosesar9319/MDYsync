-- Cloud Chabura Phase 8: generated thread summaries.
--
-- DRAFT -- NOT APPLIED TO PRODUCTION. Same rule every Cloud Chabura migration
-- has followed: the project owner approves the SQL and the rollback before it
-- runs anywhere real. Rollback:
--   supabase/migrations/20260903120000_chabura_thread_summaries.down.sql
-- Validated against supabase/baseline/ on a local Postgres 16 (supabase/README.md).
--
-- The whole point of this schema is that a generated summary is a CACHE of a
-- conversation that can change underneath it, and the conversation is the
-- authority -- never the cache. Three consequences shape every table here:
--
--   1. A point that cannot name a source is not storable. source_comment_ids
--      is NOT NULL with a cardinality >= 1 check, so "every generated point has
--      traceable source links" is a database constraint, not a convention the
--      generator is trusted to keep.
--
--   2. Moderation wins retroactively. When a reply is hidden, soft-deleted or
--      hard-deleted, every point that cited it is redacted in the same
--      statement and the summary is marked stale. A reader can never learn,
--      from a summary, what a moderator removed.
--
--   3. Nothing here is writable from the browser. There are no INSERT/UPDATE/
--      DELETE policies on the summary tables at all -- only the service role
--      (which bypasses RLS) writes them, from the Netlify function that holds
--      the provider credential. Moderator overrides go through two
--      SECURITY DEFINER functions that check is_admin() themselves.
--
-- Everything is additive: new tables, new functions, new triggers on existing
-- tables. No existing column, policy or grant changes.

-- ===========================================================================
-- 1. Tables
-- ===========================================================================

-- One CURRENT summary per thread. Regeneration replaces the row and bumps
-- summary_version rather than accumulating history: a superseded summary is
-- not something a reader can reach, and keeping it would mean keeping text
-- derived from replies that may since have been moderated -- exactly the
-- content this migration works to make unrecoverable.
create table if not exists public.thread_summaries (
  id uuid primary key default gen_random_uuid(),
  note_id uuid not null references public.line_notes(id) on delete cascade,

  -- 'thread' is the only cacheable scope. Catch-up output is viewer-specific
  -- and is deliberately NEVER stored -- see the check constraint below, which
  -- exists so a later change cannot quietly start caching per-viewer text in
  -- a publicly readable table.
  scope text not null default 'thread' check (scope = 'thread'),

  -- Provenance. summary_version counts regenerations of this thread;
  -- prompt_version identifies the instruction text, so a bad prompt can be
  -- found and re-run without guessing which rows it produced.
  summary_version integer not null default 1 check (summary_version >= 1),
  prompt_version  text    not null,
  model_id        text    not null,

  -- Scope of the source material, for staleness arithmetic on read:
  -- "N replies have arrived since this was written" is
  -- max(activity_sequence) - source_max_sequence.
  source_comment_ids   uuid[] not null,
  source_comment_count integer not null check (source_comment_count >= 0),
  source_max_sequence  bigint  not null check (source_max_sequence >= 0),

  generated_at  timestamptz not null default now(),
  generation_ms integer,
  input_tokens  integer,
  output_tokens integer,

  -- Hard invalidation: something a point rested on changed. Distinct from the
  -- soft "enough new replies to be worth regenerating" signal, which is
  -- computed on read and needs no stored state.
  stale        boolean not null default false,
  stale_reason text,

  -- Moderator override. Hiding the summary leaves the thread untouched.
  hidden        boolean not null default false,
  hidden_reason text,
  hidden_by     uuid references auth.users(id),
  hidden_at     timestamptz,

  -- Denormalised feedback tallies. The individual votes are private (knowing
  -- WHO called a summary useless is not a reader's business), so the counts
  -- cannot be a view over thread_summary_feedback -- they are maintained by
  -- trigger instead.
  useful_count     integer not null default 0 check (useful_count >= 0),
  not_useful_count integer not null default 0 check (not_useful_count >= 0)
);

-- One current summary per thread per scope.
create unique index if not exists thread_summaries_note_scope_idx
  on public.thread_summaries (note_id, scope);

create table if not exists public.thread_summary_points (
  id uuid primary key default gen_random_uuid(),
  summary_id uuid not null references public.thread_summaries(id) on delete cascade,
  position   smallint not null check (position >= 0 and position < 32),

  body text not null check (char_length(body) between 1 and 800),

  -- The traceability constraint. A point with no sources cannot exist.
  source_comment_ids uuid[] not null
    check (cardinality(source_comment_ids) between 1 and 12),

  -- Set when a cited reply is hidden or removed. The row stays so the summary
  -- keeps its shape and the reader is told a point was withdrawn, but body is
  -- no longer served: read through public.thread_summary_points_public, which
  -- blanks it.
  redacted_at     timestamptz,
  redacted_reason text,

  -- Moderator edit. Non-null edited_body replaces body for readers.
  edited_body text check (edited_body is null or char_length(edited_body) between 1 and 800),
  edited_by   uuid references auth.users(id),
  edited_at   timestamptz,

  unique (summary_id, position)
);

create index if not exists thread_summary_points_summary_idx
  on public.thread_summary_points (summary_id, position);

-- GIN so the moderation trigger's "which points cited this reply" lookup does
-- not scan every point in the table.
create index if not exists thread_summary_points_sources_idx
  on public.thread_summary_points using gin (source_comment_ids);

create table if not exists public.thread_summary_feedback (
  summary_id uuid not null references public.thread_summaries(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  verdict    text not null check (verdict = any (array['useful','not_useful'])),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (summary_id, user_id)
);

-- ===========================================================================
-- 2. The read projection
-- ===========================================================================
--
-- Readers never select thread_summary_points directly; this view is what they
-- are granted. It blanks the body of a redacted point at the DATABASE, so a
-- withdrawn point cannot be recovered by anyone who talks to PostgREST
-- instead of using the UI -- which is the only version of "cannot be
-- recovered" that means anything.
--
-- security_invoker = false (the Postgres default) so the view runs as its
-- owner and can read a base table the caller is not granted at all. That is
-- the point: the redaction has to live somewhere a caller cannot go around,
-- and a view whose base table is also readable is decoration. Same shape as
-- public_profiles, for the same reason -- column-level restriction, which RLS
-- cannot express because RLS filters rows, not columns.
--
-- Running as the owner means the base table's RLS does NOT filter for the
-- caller, so the view carries the visibility predicate itself: it repeats the
-- thread_summaries read rules rather than inheriting them. Supabase's linter
-- flags this (0010_security_definer_view); the warning is expected here.
create or replace view public.thread_summary_points_public
  with (security_invoker = false)
as
  select
    p.id,
    p.summary_id,
    p.position,
    case
      when p.redacted_at is not null then null
      else coalesce(p.edited_body, p.body)
    end as body,
    case when p.redacted_at is not null then '{}'::uuid[] else p.source_comment_ids end as source_comment_ids,
    (p.redacted_at is not null) as redacted,
    (p.edited_at is not null and p.redacted_at is null) as moderator_edited
  from public.thread_summary_points p
  join public.thread_summaries s on s.id = p.summary_id
  join public.line_notes n on n.id = s.note_id
  where not n.hidden
    and not n.is_private
    and n.deleted_at is null
    and (not s.hidden or public.is_admin());

revoke all on public.thread_summary_points_public from public, anon, authenticated;
grant select on public.thread_summary_points_public to anon, authenticated;

comment on view public.thread_summary_points_public is
  'Reader-facing projection of thread_summary_points: redacted points lose their body and their sources, and points belonging to a thread that is no longer public are not returned at all. The base table is granted to nobody.';


-- ===========================================================================
-- 3. Invalidation -- moderation and edits win retroactively
-- ===========================================================================

-- Shared by the comment triggers below. Redacts every live point that cited
-- the reply, on any summary belonging to that thread, and marks the summary
-- stale so the next reader is offered a regeneration.
create or replace function public.invalidate_summary_points_for_comment(
  p_note_id uuid, p_comment_id uuid, p_reason text
) returns void
  language plpgsql security definer set search_path to 'public'
as $$
begin
  update public.thread_summary_points p
  set redacted_at = now(), redacted_reason = p_reason
  from public.thread_summaries s
  where p.summary_id = s.id
    and s.note_id = p_note_id
    and p.redacted_at is null
    and p_comment_id = any (p.source_comment_ids);

  update public.thread_summaries
  set stale = true, stale_reason = coalesce(stale_reason, p_reason)
  where note_id = p_note_id
    and p_comment_id = any (source_comment_ids);
end;
$$;

-- Hidden, soft-deleted, or edited. The first two redact; an edit only marks
-- the summary stale, because the reply is still there and still readable --
-- what changed is whether the summary still describes it fairly.
create or replace function public.comments_invalidate_summaries() returns trigger
  language plpgsql security definer set search_path to 'public'
as $$
begin
  if (new.hidden and not old.hidden) then
    perform public.invalidate_summary_points_for_comment(new.note_id, new.id, 'source-hidden');
  elsif (old.deleted_at is null and new.deleted_at is not null) then
    perform public.invalidate_summary_points_for_comment(new.note_id, new.id, 'source-deleted');
  elsif (new.edited_at is distinct from old.edited_at and new.edited_at is not null) then
    update public.thread_summaries
    set stale = true, stale_reason = coalesce(stale_reason, 'source-edited')
    where note_id = new.note_id and new.id = any (source_comment_ids);
  end if;
  return new;
end;
$$;

drop trigger if exists comments_invalidate_summaries on public.comments;
create trigger comments_invalidate_summaries
  after update on public.comments
  for each row execute function public.comments_invalidate_summaries();

-- A hard DELETE takes the comments row with it but not the summary text
-- derived from it, and the uuid[] carries no foreign key that could cascade.
-- This is that missing cascade.
create or replace function public.comments_invalidate_summaries_on_delete() returns trigger
  language plpgsql security definer set search_path to 'public'
as $$
begin
  perform public.invalidate_summary_points_for_comment(old.note_id, old.id, 'source-removed');
  return old;
end;
$$;

drop trigger if exists comments_invalidate_summaries_delete on public.comments;
create trigger comments_invalidate_summaries_delete
  after delete on public.comments
  for each row execute function public.comments_invalidate_summaries_on_delete();

-- A thread leaving public view takes its summary with it. RLS below already
-- makes the summary unreadable in that case; this deletes it as well, so the
-- text derived from a now-private thread does not sit in a table waiting for
-- the next policy mistake. Deliberately destructive: a summary is a cache and
-- costs one regeneration to rebuild.
create or replace function public.line_notes_drop_summaries_when_unpublished() returns trigger
  language plpgsql security definer set search_path to 'public'
as $$
begin
  if (new.hidden and not old.hidden)
     or (new.is_private and not old.is_private)
     or (old.deleted_at is null and new.deleted_at is not null) then
    delete from public.thread_summaries where note_id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists line_notes_drop_summaries on public.line_notes;
create trigger line_notes_drop_summaries
  after update on public.line_notes
  for each row execute function public.line_notes_drop_summaries_when_unpublished();

-- Feedback tallies. Maintained here rather than counted on read so the
-- individual votes never need to be readable by anyone but their owner.
create or replace function public.thread_summary_feedback_recount() returns trigger
  language plpgsql security definer set search_path to 'public'
as $$
declare
  v_summary uuid := coalesce(new.summary_id, old.summary_id);
begin
  update public.thread_summaries s
  set useful_count = (
        select count(*) from public.thread_summary_feedback f
        where f.summary_id = v_summary and f.verdict = 'useful'),
      not_useful_count = (
        select count(*) from public.thread_summary_feedback f
        where f.summary_id = v_summary and f.verdict = 'not_useful')
  where s.id = v_summary;
  return null;
end;
$$;

drop trigger if exists thread_summary_feedback_recount on public.thread_summary_feedback;
create trigger thread_summary_feedback_recount
  after insert or update or delete on public.thread_summary_feedback
  for each row execute function public.thread_summary_feedback_recount();

create or replace function public.thread_summary_feedback_touch() returns trigger
  language plpgsql security definer set search_path to 'public'
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists thread_summary_feedback_touch on public.thread_summary_feedback;
create trigger thread_summary_feedback_touch
  before update on public.thread_summary_feedback
  for each row execute function public.thread_summary_feedback_touch();

-- ===========================================================================
-- 4. RLS
-- ===========================================================================
alter table public.thread_summaries       enable row level security;
alter table public.thread_summary_points  enable row level security;
alter table public.thread_summary_feedback enable row level security;

-- Readable exactly when the thread it describes is publicly readable. This is
-- the same predicate as line_notes_public_read plus the Phase 2 deleted_at
-- column, so a summary can never outlive its thread's visibility.
drop policy if exists thread_summaries_public_read on public.thread_summaries;
create policy thread_summaries_public_read on public.thread_summaries
  for select using (
    not hidden
    and exists (
      select 1 from public.line_notes n
      where n.id = thread_summaries.note_id
        and not n.hidden
        and not n.is_private
        and n.deleted_at is null
    )
  );

-- Moderators can see a summary they have hidden, so it can be reviewed and
-- un-hidden. Still bounded to non-private threads, matching line_notes_admin_read.
drop policy if exists thread_summaries_admin_read on public.thread_summaries;
create policy thread_summaries_admin_read on public.thread_summaries
  for select using (
    public.is_admin()
    and exists (
      select 1 from public.line_notes n
      where n.id = thread_summaries.note_id and not n.is_private
    )
  );

-- thread_summary_points gets NO policies at all -- not even for SELECT. RLS is
-- on and every policy list is empty, so any direct access from anon or
-- authenticated matches nothing; the grant is revoked as well, so it does not
-- even get that far. Readers go through thread_summary_points_public, which
-- runs as its owner and carries the visibility rules itself.
--
-- thread_summaries has no write policies for the same reason: with RLS on and
-- no permissive policy, a write from a browser is refused outright.
-- service_role bypasses RLS, and the moderator functions below are
-- SECURITY DEFINER.

drop policy if exists thread_summary_feedback_owner_all on public.thread_summary_feedback;
create policy thread_summary_feedback_owner_all on public.thread_summary_feedback
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ===========================================================================
-- 4b. Reporting a summary
-- ===========================================================================
--
-- The one non-additive change in this migration, and it only WIDENS: both
-- constraints on `reports` gain 'summary' as a target type. Every existing row
-- still satisfies them, and every existing client keeps working -- nothing is
-- required to start sending the new value.
--
-- Reporting the summary is deliberately separate from reporting a reply. A
-- reader who thinks a generated point misrepresents the discussion is
-- complaining about the summary, not about anyone who posted in it, and
-- filing that against a participant's reply would be both wrong and unfair.

alter table public.reports drop constraint if exists reports_target_type_check;
alter table public.reports drop constraint if exists reports_target_shape_check;

-- The original constraint is unnamed in production (an inline CHECK), so it is
-- located by definition rather than by name.
do $$
declare v_name text;
begin
  select conname into v_name
  from pg_constraint
  where conrelid = 'public.reports'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like '%target_type%'
    and pg_get_constraintdef(oid) not like '%target_id IS NULL%'
  limit 1;
  if v_name is not null then
    execute format('alter table public.reports drop constraint %I', v_name);
  end if;

  select conname into v_name
  from pg_constraint
  where conrelid = 'public.reports'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like '%segment_ref IS NOT NULL%'
  limit 1;
  if v_name is not null then
    execute format('alter table public.reports drop constraint %I', v_name);
  end if;
end $$;

alter table public.reports add constraint reports_target_type_check
  check (target_type = any (array['note','comment','anchor','summary']));

alter table public.reports add constraint reports_target_shape_check
  check (
    ((target_type = 'anchor') and (target_id is null) and (segment_ref is not null))
    or ((target_type = any (array['note','comment','summary'])) and (target_id is not null))
  );

-- ===========================================================================
-- 5. Moderator overrides
-- ===========================================================================

create or replace function public.moderate_thread_summary(
  p_summary_id uuid, p_hidden boolean, p_reason text default null
) returns void
  language plpgsql security definer set search_path to 'public'
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  update public.thread_summaries
  set hidden = p_hidden,
      hidden_reason = case when p_hidden then left(coalesce(p_reason, ''), 300) else null end,
      hidden_by = case when p_hidden then auth.uid() else null end,
      hidden_at = case when p_hidden then now() else null end
  where id = p_summary_id;
end;
$$;

-- Redact a point outright, or replace its wording. Passing p_redact = true
-- takes precedence: a point a moderator wants gone should not survive because
-- an edit was supplied in the same call.
create or replace function public.moderate_thread_summary_point(
  p_point_id uuid, p_redact boolean default false, p_body text default null
) returns void
  language plpgsql security definer set search_path to 'public'
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if p_redact then
    update public.thread_summary_points
    set redacted_at = now(), redacted_reason = 'moderator'
    where id = p_point_id;
  elsif p_body is not null then
    if char_length(btrim(p_body)) between 1 and 800 then
      update public.thread_summary_points
      set edited_body = btrim(p_body), edited_by = auth.uid(), edited_at = now()
      where id = p_point_id;
    else
      raise exception 'replacement text must be 1-800 characters' using errcode = '23514';
    end if;
  else
    -- Undo: clear both a redaction and an edit.
    update public.thread_summary_points
    set redacted_at = null, redacted_reason = null,
        edited_body = null, edited_by = null, edited_at = null
    where id = p_point_id;
  end if;
end;
$$;

-- ===========================================================================
-- 6. Grants -- explicit, never to PUBLIC (see migration 20260902180000)
-- ===========================================================================

-- Readers get the summary header and the projection view. The points BASE
-- table is not granted at all, so the redaction in the view cannot be
-- side-stepped by selecting the table directly.
grant select on public.thread_summaries to anon, authenticated;
revoke all on public.thread_summary_points from anon, authenticated;

grant select, insert, update, delete on public.thread_summary_feedback to authenticated;

revoke execute on function public.invalidate_summary_points_for_comment(uuid, uuid, text) from public;
revoke execute on function public.comments_invalidate_summaries()                          from public;
revoke execute on function public.comments_invalidate_summaries_on_delete()                from public;
revoke execute on function public.line_notes_drop_summaries_when_unpublished()             from public;
revoke execute on function public.thread_summary_feedback_recount()                        from public;
revoke execute on function public.thread_summary_feedback_touch()                          from public;

revoke execute on function public.moderate_thread_summary(uuid, boolean, text)        from public, anon;
revoke execute on function public.moderate_thread_summary_point(uuid, boolean, text)  from public, anon;
grant  execute on function public.moderate_thread_summary(uuid, boolean, text)        to authenticated;
grant  execute on function public.moderate_thread_summary_point(uuid, boolean, text)  to authenticated;
