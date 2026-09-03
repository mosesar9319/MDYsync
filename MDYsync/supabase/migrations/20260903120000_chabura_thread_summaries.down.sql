-- Rollback for 20260903120000_chabura_thread_summaries.sql.
--
-- Summaries are a cache with no upstream: dropping the tables loses only
-- generated text and its feedback tallies, all of which one regeneration
-- rebuilds. Nothing in line_notes, comments, reactions or read state is
-- touched by this migration, so nothing is restored here -- the triggers are
-- simply removed from those tables.
--
-- Safe to run more than once.

-- Narrow the reports constraints back to the three original target types.
-- Any 'summary' report filed while the feature was live is deleted first --
-- the constraint cannot be restored while such a row exists, and a report
-- about a summary that no longer exists has nothing left to moderate.
delete from public.reports where target_type = 'summary';

alter table public.reports drop constraint if exists reports_target_type_check;
alter table public.reports drop constraint if exists reports_target_shape_check;

alter table public.reports add constraint reports_target_type_check
  check (target_type = any (array['note','comment','anchor']));

alter table public.reports add constraint reports_target_shape_check
  check (
    ((target_type = 'anchor') and (target_id is null) and (segment_ref is not null))
    or ((target_type = any (array['note','comment'])) and (target_id is not null))
  );

drop trigger if exists comments_invalidate_summaries        on public.comments;
drop trigger if exists comments_invalidate_summaries_delete on public.comments;
drop trigger if exists line_notes_drop_summaries            on public.line_notes;

drop function if exists public.comments_invalidate_summaries();
drop function if exists public.comments_invalidate_summaries_on_delete();
drop function if exists public.line_notes_drop_summaries_when_unpublished();
drop function if exists public.moderate_thread_summary(uuid, boolean, text);
drop function if exists public.moderate_thread_summary_point(uuid, boolean, text);

drop view if exists public.thread_summary_points_public;

-- Dropped before the function they call, and before their own table.
drop trigger if exists thread_summary_feedback_recount on public.thread_summary_feedback;
drop trigger if exists thread_summary_feedback_touch   on public.thread_summary_feedback;
drop function if exists public.thread_summary_feedback_recount();
drop function if exists public.thread_summary_feedback_touch();

drop table if exists public.thread_summary_feedback;
drop table if exists public.thread_summary_points;
drop table if exists public.thread_summaries;

-- Dropped last: the trigger functions above call it.
drop function if exists public.invalidate_summary_points_for_comment(uuid, uuid, text);
