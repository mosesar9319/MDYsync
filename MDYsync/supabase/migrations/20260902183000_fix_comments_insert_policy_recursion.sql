-- HOTFIX: posting any reply is currently impossible in production.
--
-- Symptom: every INSERT into public.comments by the `authenticated` role fails
-- with `42P17: infinite recursion detected in policy for relation "comments"`.
-- Reading replies is unaffected; only writing them is broken.
--
-- Cause: the comments_insert policy's WITH CHECK contains a subquery against
-- `comments` itself:
--
--     and ((parent_comment_id is null) or exists (
--       select 1 from public.comments p
--       where p.id = comments.parent_comment_id and p.note_id = comments.note_id))
--
-- A policy on a relation that itself queries that relation makes Postgres
-- expand the policy recursively, and it aborts rather than looping. This is
-- detected at PLAN time, so the `parent_comment_id is null` branch does not
-- short-circuit it: top-level replies fail too, not just nested ones.
--
-- Introduced by migration 20260901103135 (comments_nested_replies) on
-- 2026-09-01. The only two rows in `comments` both carry the timestamp of the
-- 20260901145415 seed_demo_notes migration, i.e. they were inserted as
-- `postgres` with RLS bypassed -- consistent with no real user ever having
-- successfully posted a reply since.
--
-- Fix: keep exactly the same rule, but evaluate it through a SECURITY DEFINER
-- helper. The helper is owned by `postgres`, which owns `comments`, so its
-- lookup is not subject to RLS and no policy expansion recurses.
--
-- This migration stands alone: it does not depend on the Phase 2 thread
-- foundation migration and can be applied immediately.

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

comment on function public.comment_is_in_note(uuid, uuid) is
  'Used by the comments_insert policy to check a reply parent without the policy referencing `comments` directly, which would recurse. See migration 20260902183000.';

-- Never to PUBLIC (see migration 20260902180000). Only the role that actually
-- inserts replies needs it.
revoke execute on function public.comment_is_in_note(uuid, uuid) from public;
grant  execute on function public.comment_is_in_note(uuid, uuid) to authenticated;

-- Recreated with the self-reference replaced. Every other condition is
-- preserved verbatim, so the authorization rules are unchanged.
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
