-- Daf Scan diagnostic logging: which OCR engine ran, what it matched (or
-- didn't), for real scan requests.
--
-- DRAFT -- NOT APPLIED TO PRODUCTION. Same rule every migration in this repo
-- has followed: the project owner approves the SQL and the rollback before it
-- runs anywhere real. Rollback:
--   supabase/migrations/20260913150000_scan_events_logging.down.sql
-- Validated against supabase/baseline/ on a local Postgres 16 (supabase/README.md).
--
-- Why this exists: scan-daf-page.mjs was, until now, completely stateless --
-- it OCRs a photo, returns a match (or doesn't), and writes nothing anywhere.
-- There was no way to answer "which engine actually ran on the last few
-- scans" after the fact, only what the code's OWN default logic would choose
-- given no explicit request. This table is a plain append-only log, one row
-- per scan attempt (success or failure), written by the Netlify function
-- with the service-role key -- never by the browser.
--
-- No INSERT/UPDATE/DELETE policy exists for anon/authenticated at all: the
-- only writer is the service role (which bypasses RLS entirely), matching
-- thread_summaries' own "nothing here is writable from the browser" rule.
-- SELECT is admin-only, the same shape as reports_admin_read/comments_admin_read.

create table if not exists public.scan_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),

  -- What the client asked for vs. what actually ran. requested_engine is
  -- always one of the three toggle values; engine_used narrows to which
  -- engine(s) actually produced the logged result -- 'both' specifically
  -- means both ran and agreed (see confirmScan/ocrAndMatchOneEngine's own
  -- "picks tesseract's arbitrarily" comment for why a single engine name
  -- would be misleading there).
  requested_engine text not null check (requested_engine in ('tesseract', 'google-vision', 'both')),
  engine_used      text     check (engine_used in ('tesseract', 'google-vision', 'both')),

  -- Outcome. A row exists even for a failed scan (no header could be read,
  -- or a header was read but matched no known daf) -- those are exactly the
  -- cases worth being able to see later, not just successes.
  matched     boolean not null,
  tractate    text,
  daf         integer,
  amud        text check (amud in ('a', 'b')),
  match_score numeric,

  -- Only meaningful when requested_engine = 'both'.
  comparison_agree boolean,

  -- Short, human-readable failure reason (header unreadable, no match,
  -- no page data for this daf) -- never a raw stack trace or request body.
  error text
);

create index if not exists scan_events_created_at_idx
  on public.scan_events (created_at desc);

alter table public.scan_events enable row level security;

create policy scan_events_admin_read on public.scan_events
  for select using (public.is_admin());

comment on table public.scan_events is
  'Append-only diagnostic log of Daf Scan attempts: which OCR engine ran and what it matched. Written only by the service role from scan-daf-page.mjs; readable only by admins.';
