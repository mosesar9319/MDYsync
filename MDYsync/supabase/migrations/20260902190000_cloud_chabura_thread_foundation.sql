-- Cloud Chabura Phase 2: thread foundation.
--
-- DRAFT -- NOT APPLIED TO PRODUCTION. Per the redesign handoff's Prompt 2:
-- "Do not apply them to production until the project owner approves the SQL
-- and rollback plan." Validated by running against supabase/baseline/ on a
-- local Postgres 16 (see supabase/README.md); the rollback is in
-- supabase/migrations/20260902190000_cloud_chabura_thread_foundation.down.sql
-- and the backfill/rollout notes are in supabase/PHASE2_MIGRATION_PLAN.md.
--
-- Scope decisions made with the project owner before drafting:
--   * NO cached reply_count/participant_count. Counting on read is instant at
--     the current corpus (3 notes, 2 replies) and cannot drift or mis-handle
--     hidden/deleted replies. Revisit only if threads actually get large.
--   * NO branch_follows table yet. Whole-thread following already works;
--     the migration plan documents how to add branch-level following later.
--   * Public identity extends `profiles` + a read-only view, rather than a
--     separate community_profiles table that would need syncing.
--
-- Everything here is additive and backwards compatible: every new column is
-- nullable or defaulted, no existing column changes type or nullability, and
-- current clients keep working untouched before any new UI ships.

-- ===========================================================================
-- 1. profiles: public-safe identity, exposed through a read-only view
-- ===========================================================================
alter table public.profiles add column if not exists avatar_path text;
alter table public.profiles add column if not exists role_label  text;

alter table public.profiles drop constraint if exists profiles_avatar_path_check;
alter table public.profiles add  constraint profiles_avatar_path_check
  check (avatar_path is null or char_length(avatar_path) <= 400);

alter table public.profiles drop constraint if exists profiles_role_label_check;
alter table public.profiles add  constraint profiles_role_label_check
  check (role_label is null or char_length(role_label) between 1 and 40);

-- `profiles` is owner-read-only (profiles_select_own), which is why mentions
-- are currently limited to people already visible in a thread -- there is no
-- public identity lookup at all. This view is that lookup, and it is
-- deliberately a security-DEFINER view (security_invoker = false, Postgres's
-- default): it must read rows the caller's own RLS would hide, while
-- exposing only columns that are safe to publish. `email` and `is_admin` are
-- not in the column list and therefore cannot be selected through it.
--
-- Supabase's linter flags security-definer views (0010_security_definer_view).
-- That warning is expected and accepted here: column-level restriction is the
-- entire point, and RLS cannot express it (RLS filters rows, not columns).
-- The alternative -- column-level GRANTs on profiles itself -- would break
-- auth.js, which does `select('*')` on the caller's own row.
create or replace view public.public_profiles
  with (security_invoker = false)
as
  select id, display_name, avatar_path, role_label
  from public.profiles;

-- A single-table view like this is auto-updatable in Postgres, and Supabase's
-- default privileges would otherwise grant writes on it -- which would let a
-- caller UPDATE profiles straight through the view, bypassing RLS entirely.
-- Revoke everything first, then grant read only.
revoke all on public.public_profiles from public, anon, authenticated;
grant select on public.public_profiles to anon, authenticated;

comment on view public.public_profiles is
  'Public-safe projection of profiles (no email, no is_admin). Read-only: see the migration that created it for why writes are revoked.';

-- ===========================================================================
-- 2. line_notes: title, lifecycle status, highlighted answer, activity, soft delete
-- ===========================================================================
alter table public.line_notes add column if not exists title                  text;
alter table public.line_notes add column if not exists status                 text not null default 'open';
alter table public.line_notes add column if not exists highlighted_comment_id uuid;
alter table public.line_notes add column if not exists edited_at              timestamptz;
alter table public.line_notes add column if not exists deleted_at             timestamptz;
alter table public.line_notes add column if not exists last_activity_at       timestamptz not null default now();

alter table public.line_notes drop constraint if exists line_notes_title_check;
alter table public.line_notes add  constraint line_notes_title_check
  check (title is null or char_length(title) between 1 and 200);

-- 'open' | 'resolved' | 'locked'. Deliberately separate from `hidden`
-- (moderator action) and `deleted_at` (author action): the audit found these
-- three meanings were at risk of being collapsed into `hidden` alone.
alter table public.line_notes drop constraint if exists line_notes_status_check;
alter table public.line_notes add  constraint line_notes_status_check
  check (status = any (array['open','resolved','locked']));

alter table public.line_notes drop constraint if exists line_notes_highlighted_comment_id_fkey;
alter table public.line_notes add  constraint line_notes_highlighted_comment_id_fkey
  foreign key (highlighted_comment_id) references public.comments(id) on delete set null;

-- ===========================================================================
-- 3. comments: hierarchy, stable ordering, soft delete, quoting
-- ===========================================================================
alter table public.comments add column if not exists root_comment_id   uuid;
alter table public.comments add column if not exists depth             smallint not null default 0;
alter table public.comments add column if not exists activity_sequence bigint;
alter table public.comments add column if not exists edited_at         timestamptz;
alter table public.comments add column if not exists deleted_at        timestamptz;
alter table public.comments add column if not exists quoted_comment_id uuid;
alter table public.comments add column if not exists quoted_excerpt    text;

-- NOTE, and a deliberate deviation from the redesign plan's wording:
-- the plan says "cap stored reply depth at four". The CURRENT system has no
-- storage cap at all -- notes.js's MAX_REPLY_DEPTH = 4 caps INDENTATION only,
-- and its own comment says replies "stay logically threaded ... no matter how
-- deep a conversation actually goes". Enforcing a hard cap of 4 here would
-- start rejecting replies the live system accepts today: a product change,
-- not a schema detail. This keeps current behaviour and sets only a
-- pathological-abuse ceiling. Lower it to 3 if a real cap is wanted.
alter table public.comments drop constraint if exists comments_depth_check;
alter table public.comments add  constraint comments_depth_check
  check (depth >= 0 and depth <= 64);

alter table public.comments drop constraint if exists comments_quoted_excerpt_check;
alter table public.comments add  constraint comments_quoted_excerpt_check
  check (quoted_excerpt is null or char_length(quoted_excerpt) between 1 and 500);

alter table public.comments drop constraint if exists comments_root_comment_id_fkey;
alter table public.comments add  constraint comments_root_comment_id_fkey
  foreign key (root_comment_id) references public.comments(id) on delete cascade;

alter table public.comments drop constraint if exists comments_quoted_comment_id_fkey;
alter table public.comments add  constraint comments_quoted_comment_id_fkey
  foreign key (quoted_comment_id) references public.comments(id) on delete set null;

-- ===========================================================================
-- 4. Backfill existing rows (before any NOT NULL is enforced)
-- ===========================================================================

-- Derive root_comment_id/depth for every pre-existing comment. A top-level
-- comment is its own root, so every row is reachable from this walk.
with recursive tree as (
  select id, id as root_id, 0::smallint as lvl
  from public.comments
  where parent_comment_id is null
  union all
  select c.id, t.root_id, (t.lvl + 1)::smallint
  from public.comments c
  join tree t on c.parent_comment_id = t.id
)
update public.comments c
set root_comment_id = tree.root_id,
    depth           = tree.lvl
from tree
where tree.id = c.id;

-- Stable, monotonic ordering key for unread tracking. Backfilled in
-- created_at order so existing history reads correctly, then handed a
-- sequence that starts above the highest backfilled value.
with ordered as (
  select id, row_number() over (order by created_at, id) as rn
  from public.comments
)
update public.comments c
set activity_sequence = ordered.rn
from ordered
where ordered.id = c.id;

create sequence if not exists public.comments_activity_sequence_seq
  owned by public.comments.activity_sequence;

select setval(
  'public.comments_activity_sequence_seq',
  coalesce((select max(activity_sequence) from public.comments), 0) + 1,
  false
);

alter table public.comments
  alter column activity_sequence set default nextval('public.comments_activity_sequence_seq');

-- Safe now that every row is populated.
alter table public.comments alter column activity_sequence set not null;
alter table public.comments alter column root_comment_id   set not null;

-- last_activity_at defaulted to now() for existing rows, which would flatten
-- the feed's ordering. Recompute it from real history instead.
--
-- line_notes_before_update (line_notes_guard_hidden) fires on this UPDATE and
-- would stamp updated_at = now() across every row. Disabled for the backfill
-- so a data migration does not masquerade as user edits.
alter table public.line_notes disable trigger line_notes_before_update;

update public.line_notes n
set last_activity_at = greatest(
  n.created_at,
  coalesce((select max(c.created_at) from public.comments c where c.note_id = n.id), n.created_at)
);

alter table public.line_notes enable trigger line_notes_before_update;

-- ===========================================================================
-- 5. New tables
-- ===========================================================================

-- Per-viewer read position within a thread, keyed to comments.activity_sequence.
create table if not exists public.thread_read_state (
  user_id            uuid not null references auth.users(id) on delete cascade,
  note_id            uuid not null references public.line_notes(id) on delete cascade,
  last_read_sequence bigint not null default 0 check (last_read_sequence >= 0),
  last_read_at       timestamptz not null default now(),
  primary key (user_id, note_id)
);

create table if not exists public.bookmarks (
  user_id     uuid not null references auth.users(id) on delete cascade,
  target_type text not null check (target_type = any (array['note','comment'])),
  target_id   uuid not null,
  created_at  timestamptz not null default now(),
  primary key (user_id, target_type, target_id)
);

-- ===========================================================================
-- 6. Integrity triggers -- every derived value is server-side, never trusted
--    from the client.
-- ===========================================================================

-- Derives root_comment_id and depth, and rejects the structural mistakes the
-- redesign plan calls out: a parent in a different thread, a quote pointing
-- at a different thread, and re-parenting after the fact (which is the only
-- way an adjacency list like this can be made to form a cycle).
create or replace function public.comments_derive_hierarchy() returns trigger
  language plpgsql security definer set search_path to 'public'
as $$
declare
  v_parent public.comments%rowtype;
begin
  if tg_op = 'UPDATE' then
    if new.note_id is distinct from old.note_id then
      raise exception 'a reply cannot be moved to another thread' using errcode = '23514';
    end if;
    if new.parent_comment_id is distinct from old.parent_comment_id then
      raise exception 'a reply cannot be re-parented' using errcode = '23514';
    end if;
    -- Derived columns are server-owned: ignore whatever the client sent.
    new.root_comment_id := old.root_comment_id;
    new.depth           := old.depth;
  else
    if new.parent_comment_id is null then
      new.root_comment_id := new.id;
      new.depth           := 0;
    else
      select * into v_parent from public.comments where id = new.parent_comment_id;
      if not found then
        raise exception 'parent reply does not exist' using errcode = '23503';
      end if;
      if v_parent.note_id <> new.note_id then
        raise exception 'parent reply belongs to a different thread' using errcode = '23514';
      end if;
      new.root_comment_id := v_parent.root_comment_id;
      new.depth           := (v_parent.depth + 1)::smallint;
    end if;
  end if;

  if new.quoted_comment_id is not null then
    if not exists (
      select 1 from public.comments q
      where q.id = new.quoted_comment_id and q.note_id = new.note_id
    ) then
      raise exception 'quoted reply belongs to a different thread' using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists comments_derive_hierarchy on public.comments;
create trigger comments_derive_hierarchy
  before insert or update on public.comments
  for each row execute function public.comments_derive_hierarchy();

-- A highlighted answer must be a live reply on the same thread. Re-checked on
-- every write rather than trusted once, and cleared automatically if the
-- chosen reply is later hidden or deleted.
create or replace function public.line_notes_validate_highlight() returns trigger
  language plpgsql security definer set search_path to 'public'
as $$
begin
  if new.highlighted_comment_id is not null then
    if not exists (
      select 1 from public.comments c
      where c.id = new.highlighted_comment_id
        and c.note_id = new.id
        and not c.hidden
        and c.deleted_at is null
    ) then
      raise exception 'highlighted reply must be a visible reply on this thread' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists line_notes_validate_highlight on public.line_notes;
create trigger line_notes_validate_highlight
  before insert or update on public.line_notes
  for each row execute function public.line_notes_validate_highlight();

-- If the highlighted reply is hidden or soft-deleted afterwards, drop the
-- pointer rather than leaving a thread advertising an answer nobody can read.
create or replace function public.clear_highlight_when_reply_unavailable() returns trigger
  language plpgsql security definer set search_path to 'public'
as $$
begin
  if new.hidden or new.deleted_at is not null then
    update public.line_notes
    set highlighted_comment_id = null
    where id = new.note_id and highlighted_comment_id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists comments_clear_highlight on public.comments;
create trigger comments_clear_highlight
  after update on public.comments
  for each row execute function public.clear_highlight_when_reply_unavailable();

-- Feed ordering: a new reply bumps its thread.
create or replace function public.bump_note_last_activity() returns trigger
  language plpgsql security definer set search_path to 'public'
as $$
begin
  update public.line_notes
  set last_activity_at = greatest(last_activity_at, new.created_at)
  where id = new.note_id;
  return new;
end;
$$;

drop trigger if exists comments_bump_note_activity on public.comments;
create trigger comments_bump_note_activity
  after insert on public.comments
  for each row execute function public.bump_note_last_activity();

-- Read state only ever moves forward. Without this, an old permalink or a
-- slow request landing late could rewind someone's unread marker.
create or replace function public.thread_read_state_monotonic() returns trigger
  language plpgsql security definer set search_path to 'public'
as $$
begin
  new.last_read_sequence := greatest(old.last_read_sequence, new.last_read_sequence);
  new.last_read_at := greatest(old.last_read_at, new.last_read_at);
  return new;
end;
$$;

drop trigger if exists thread_read_state_monotonic on public.thread_read_state;
create trigger thread_read_state_monotonic
  before update on public.thread_read_state
  for each row execute function public.thread_read_state_monotonic();

-- An author deleting their own post redacts its content but keeps the row, so
-- replies underneath stay connected (the plan's tombstone requirement). The
-- redaction happens server-side so the original text is not merely hidden by
-- the client while still being served over the API.
create or replace function public.redact_on_soft_delete() returns trigger
  language plpgsql security definer set search_path to 'public'
as $$
begin
  if old.deleted_at is null and new.deleted_at is not null then
    new.body := '[deleted]';
    if tg_table_name = 'line_notes' then
      new.title         := null;
      new.selected_text := null;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists line_notes_redact_on_soft_delete on public.line_notes;
create trigger line_notes_redact_on_soft_delete
  before update on public.line_notes
  for each row execute function public.redact_on_soft_delete();

drop trigger if exists comments_redact_on_soft_delete on public.comments;
create trigger comments_redact_on_soft_delete
  before update on public.comments
  for each row execute function public.redact_on_soft_delete();

-- ===========================================================================
-- 7. RLS for the new tables (owner-only), and the one existing-policy change
-- ===========================================================================
alter table public.thread_read_state enable row level security;
alter table public.bookmarks         enable row level security;

drop policy if exists thread_read_state_owner_all on public.thread_read_state;
create policy thread_read_state_owner_all on public.thread_read_state
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Bookmarking must not become a way to confirm that a private note exists:
-- inserting one requires the target to be visible to the caller, so read and
-- delete are owner-only but insert carries its own visibility check.
drop policy if exists bookmarks_owner_all on public.bookmarks;
drop policy if exists bookmarks_select_own on public.bookmarks;
drop policy if exists bookmarks_delete_own on public.bookmarks;
drop policy if exists bookmarks_insert_own on public.bookmarks;
create policy bookmarks_select_own on public.bookmarks
  for select using (auth.uid() = user_id);
create policy bookmarks_delete_own on public.bookmarks
  for delete using (auth.uid() = user_id);
create policy bookmarks_insert_own on public.bookmarks
  for insert with check (
    auth.uid() = user_id
    and (
      (target_type = 'note' and exists (
        select 1 from public.line_notes n
        where n.id = bookmarks.target_id
          and not n.hidden
          and (n.is_private = false or n.author_id = auth.uid())
      ))
      or (target_type = 'comment' and exists (
        select 1 from public.comments c
        join public.line_notes n on n.id = c.note_id
        where c.id = bookmarks.target_id
          and not c.hidden
          and not n.hidden
          and (n.is_private = false or n.author_id = auth.uid())
      ))
    )
  );

-- Repeated from migration 20260902183000 so this migration is self-sufficient
-- if applied to a database that has not taken that hotfix yet. A policy on
-- `comments` must never query `comments` directly -- Postgres expands that
-- recursively and aborts with 42P17, which is exactly the bug 20260902183000
-- fixed (it made posting ANY reply impossible).
create or replace function public.comment_is_in_note(p_comment_id uuid, p_note_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
    select 1 from public.comments
    where id = p_comment_id and note_id = p_note_id
  );
$$;
revoke execute on function public.comment_is_in_note(uuid, uuid) from public;
grant  execute on function public.comment_is_in_note(uuid, uuid) to authenticated;

-- Recreated to add one clause: a locked or author-deleted thread accepts no
-- new replies. Every other condition is preserved from the post-hotfix policy.
-- No row is locked or deleted today (both columns are new), so this is a no-op
-- against current data.
--
-- The parent check is belt-and-braces with comments_derive_hierarchy(), which
-- raises 23514 from a BEFORE INSERT trigger and therefore fires first.
drop policy if exists comments_insert on public.comments;
create policy comments_insert on public.comments for insert with check (
  (auth.uid() = author_id)
  and public.can_post_publicly()
  and exists (
    select 1 from public.line_notes n
    where n.id = comments.note_id
      and n.is_private = false
      and not n.hidden
      and n.status <> 'locked'
      and n.deleted_at is null
  )
  and (
    (parent_comment_id is null)
    or public.comment_is_in_note(parent_comment_id, note_id)
  )
);

-- ===========================================================================
-- 8. Indexes for the new access paths
-- ===========================================================================

-- Feed ordering. Supersedes line_notes_public_feed_idx from migration
-- 20260902180000, which ordered by created_at; dropped so the two do not
-- stack (that migration's own comment anticipated this).
drop index if exists public.line_notes_public_feed_idx;
create index if not exists line_notes_activity_feed_idx
  on public.line_notes (last_activity_at desc, id)
  where not hidden and not is_private and deleted_at is null;

-- Unread lookups and in-order reply paging within one thread.
create index if not exists comments_note_activity_idx
  on public.comments (note_id, activity_sequence);

-- Loading one top-level branch at a time.
create index if not exists comments_note_root_created_idx
  on public.comments (note_id, root_comment_id, created_at, id);

create index if not exists bookmarks_user_created_idx
  on public.bookmarks (user_id, created_at desc);

-- ===========================================================================
-- 9. Grants -- explicit, and never to PUBLIC (see migration 20260902180000).
-- ===========================================================================
grant select, insert, update, delete on public.thread_read_state to authenticated;
grant select, insert, delete         on public.bookmarks         to authenticated;
grant usage, select on sequence public.comments_activity_sequence_seq to authenticated;

revoke execute on function public.comments_derive_hierarchy()               from public;
revoke execute on function public.line_notes_validate_highlight()           from public;
revoke execute on function public.clear_highlight_when_reply_unavailable()  from public;
revoke execute on function public.bump_note_last_activity()                 from public;
revoke execute on function public.thread_read_state_monotonic()             from public;
revoke execute on function public.redact_on_soft_delete()                   from public;
