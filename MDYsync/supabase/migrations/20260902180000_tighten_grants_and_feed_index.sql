-- Cloud Chabura Phase 1 cheap wins (PHASE1_CLOUD_CHABURA_AUDIT.md, recommendation 3).
--
-- First migration committed to version control. The 24 migrations before this
-- one were applied live via the Supabase MCP tool with no SQL under source
-- control (audit F-1); this repo starts tracking schema history here.
--
-- Three independent, low-risk, reversible changes:
--   1. Revoke the default PUBLIC EXECUTE grant on five trigger-only functions.
--   2. Narrow the three admin RPCs to `authenticated` only (they already
--      self-enforce is_admin() -- see audit S2.4 -- this removes the `anon`
--      grant as defence in depth, not because it was exploitable).
--   3. Add the index the public feed's own ordering was missing.
--
-- Explicitly NOT touched: is_admin() and can_post_publicly() keep their PUBLIC
-- execute grant. Both are called from inside RLS policy expressions
-- (line_notes_admin_read, line_notes_insert, comments_insert), which requires
-- the connecting role itself to hold EXECUTE on them -- revoking would break
-- every policy that calls them for anon/authenticated. Since anon and
-- authenticated are exactly the two roles PostgREST ever connects as, an
-- explicit anon+authenticated grant would be no narrower than PUBLIC here;
-- left alone rather than churned for a change with no security effect.

-- 1. Trigger-only functions: never meant to be called directly (they read
-- NEW/OLD/TG_OP and error if invoked outside trigger context, so this was not
-- exploitable -- see audit S2.4), but callable via /rest/v1/rpc/<name> today
-- purely because Postgres grants EXECUTE to PUBLIC by default on CREATE
-- FUNCTION and nothing revoked it since. Revoking does not affect trigger
-- firing: Postgres does not check the firing statement's role against the
-- trigger function's own EXECUTE grant.
revoke execute on function public.handle_new_user() from public;
revoke execute on function public.line_notes_guard_hidden() from public;
revoke execute on function public.notify_on_comment_insert() from public;
revoke execute on function public.notify_on_note_insert() from public;
revoke execute on function public.validate_mentions() from public;

-- 2. Admin RPCs: keep authenticated (a genuine admin is always authenticated;
-- is_admin() already rejects everyone else internally), drop anon and PUBLIC.
revoke execute on function public.resolve_report(uuid, text) from public;
revoke execute on function public.resolve_report(uuid, text) from anon;
grant execute on function public.resolve_report(uuid, text) to authenticated;

revoke execute on function public.set_comment_hidden(uuid, boolean) from public;
revoke execute on function public.set_comment_hidden(uuid, boolean) from anon;
grant execute on function public.set_comment_hidden(uuid, boolean) to authenticated;

revoke execute on function public.set_note_hidden(uuid, boolean) from public;
revoke execute on function public.set_note_hidden(uuid, boolean) from anon;
grant execute on function public.set_note_hidden(uuid, boolean) to authenticated;

-- 3. The public feed (chaburahBaseQuery in chaburah.js) always filters
-- is_private = false AND hidden = false and orders by created_at desc, with
-- no supporting index (audit S2.5). A partial index matching that exact
-- predicate keeps this cheap even as the corpus grows past today's 3 rows.
-- Phase 2's last_activity_at column supersedes this; drop it there rather
-- than stacking both.
create index if not exists line_notes_public_feed_idx
  on public.line_notes (created_at desc)
  where not hidden and not is_private;
