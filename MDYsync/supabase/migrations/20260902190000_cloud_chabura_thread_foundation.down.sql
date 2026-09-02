-- Rollback for 20260902190000_cloud_chabura_thread_foundation.sql.
--
-- Returns the schema to its post-20260902183000 state (i.e. WITH the reply
-- recursion hotfix still in place -- that fix is not part of this rollback and
-- must not be undone, or posting replies breaks again).
--
-- Data loss on rollback, stated plainly:
--   * thread_read_state and bookmarks are dropped, so per-viewer unread
--     positions and saved items are lost. Nothing else references them.
--   * titles, statuses, highlighted answers, edited_at/deleted_at markers and
--     quote links are dropped with their columns.
--   * Author soft-deletes are NOT recoverable: redact_on_soft_delete()
--     overwrote the original body with '[deleted]' at delete time. Restoring
--     those bodies requires a point-in-time restore, not this script.
-- Take a backup before rolling back if any of that has been used in anger.
--
-- Ordering matters: triggers and policies first, then columns, then tables.

-- Policies -----------------------------------------------------------------
drop policy if exists bookmarks_select_own on public.bookmarks;
drop policy if exists bookmarks_delete_own on public.bookmarks;
drop policy if exists bookmarks_insert_own on public.bookmarks;
drop policy if exists thread_read_state_owner_all on public.thread_read_state;

-- Restore the comments_insert policy exactly as 20260902183000 left it
-- (without the locked/deleted clause, still using the non-recursive helper).
drop policy if exists comments_insert on public.comments;
create policy comments_insert on public.comments for insert with check (
  (auth.uid() = author_id)
  and public.can_post_publicly()
  and exists (
    select 1 from public.line_notes n
    where n.id = comments.note_id
      and n.is_private = false
      and not n.hidden
  )
  and (
    (parent_comment_id is null)
    or public.comment_is_in_note(parent_comment_id, note_id)
  )
);

-- Triggers -----------------------------------------------------------------
drop trigger if exists comments_derive_hierarchy        on public.comments;
drop trigger if exists comments_clear_highlight         on public.comments;
drop trigger if exists comments_bump_note_activity      on public.comments;
drop trigger if exists comments_redact_on_soft_delete   on public.comments;
drop trigger if exists line_notes_validate_highlight    on public.line_notes;
drop trigger if exists line_notes_redact_on_soft_delete on public.line_notes;
drop trigger if exists thread_read_state_monotonic      on public.thread_read_state;

drop function if exists public.comments_derive_hierarchy();
drop function if exists public.line_notes_validate_highlight();
drop function if exists public.clear_highlight_when_reply_unavailable();
drop function if exists public.bump_note_last_activity();
drop function if exists public.thread_read_state_monotonic();
drop function if exists public.redact_on_soft_delete();

-- Indexes ------------------------------------------------------------------
drop index if exists public.comments_note_activity_idx;
drop index if exists public.comments_note_root_created_idx;
drop index if exists public.bookmarks_user_created_idx;
drop index if exists public.line_notes_activity_feed_idx;

-- Restore the feed index this migration replaced.
create index if not exists line_notes_public_feed_idx
  on public.line_notes (created_at desc)
  where not hidden and not is_private;

-- Tables -------------------------------------------------------------------
drop table if exists public.bookmarks;
drop table if exists public.thread_read_state;

-- Columns ------------------------------------------------------------------
alter table public.comments drop column if exists quoted_excerpt;
alter table public.comments drop column if exists quoted_comment_id;
alter table public.comments drop column if exists deleted_at;
alter table public.comments drop column if exists edited_at;
alter table public.comments drop column if exists activity_sequence;  -- drops the owned sequence too
alter table public.comments drop column if exists depth;
alter table public.comments drop column if exists root_comment_id;

alter table public.line_notes drop column if exists last_activity_at;
alter table public.line_notes drop column if exists deleted_at;
alter table public.line_notes drop column if exists edited_at;
alter table public.line_notes drop column if exists highlighted_comment_id;
alter table public.line_notes drop column if exists status;
alter table public.line_notes drop column if exists title;

-- Public identity ----------------------------------------------------------
drop view if exists public.public_profiles;
alter table public.profiles drop constraint if exists profiles_role_label_check;
alter table public.profiles drop constraint if exists profiles_avatar_path_check;
alter table public.profiles drop column if exists role_label;
alter table public.profiles drop column if exists avatar_path;
