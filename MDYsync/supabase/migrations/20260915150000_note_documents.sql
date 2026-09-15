-- My Notes imports: a reader's own typed Torah notes brought in from
-- outside DafSync (pasted text, a .txt or .md file) and kept as a private,
-- searchable document.
--
-- NOT YET APPLIED TO PRODUCTION. Rollback:
--   supabase/migrations/20260915150000_note_documents.down.sql
-- Validate against supabase/baseline/ on a local Postgres 16 first
-- (supabase/README.md).
--
-- WHY A NEW TABLE RATHER THAN A BIGGER line_notes.body:
--
-- line_notes.daf_ref_key and line_notes.segment_ref are both NOT NULL -- a
-- note is, by construction, a note ON a passage. An imported document has
-- no passage until the reader attaches it to one, so it simply cannot be
-- represented as a line_notes row at import time, whatever the body cap
-- were raised to. The cap is also worth keeping where it is: 2000
-- characters is a sensible ceiling for a DISCUSSION post, and raising it so
-- a 200-page notebook fits would change what every existing consumer of
-- that column (the feed, the thread reader, the moderation queue) has to
-- render.
--
-- Attaching a document to a daf is deliberately NOT part of this migration.
-- That step adds a nullable line_notes.source_document_id and touches the
-- note composer on the Interactive Daf; documents have to exist before
-- there is anything to attach, so they come first and alone.
--
-- NOTHING HERE IS EVER PUBLIC. There is no public-read policy and no
-- admin-read policy, unlike line_notes (where an admin can read non-private
-- notes in order to moderate them). A document is only ever visible to the
-- account that imported it, so there is nothing for a moderator to act on
-- and no reason to grant a way in. If a reader later wants to share
-- something out of a document, that happens by creating an ordinary note
-- from it -- which goes through line_notes and its existing moderation
-- path, not through this table.

create table if not exists public.note_documents (
  id       uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,

  title text not null check (char_length(title) >= 1 and char_length(title) <= 200),

  -- How it arrived. Constrained rather than free text so the import UI and
  -- this table cannot drift; .docx/PDF/scan values get added by the
  -- migration that actually teaches the app to read those formats, not
  -- speculatively now.
  source_kind text not null check (source_kind in ('paste', 'txt', 'md')),

  -- The name of the file it came from, when it came from one at all
  -- (pasted text has none). Kept for the reader's own orientation -- "which
  -- file was this?" -- and never used to locate anything: no file is
  -- stored anywhere by this migration.
  original_filename text check (original_filename is null or char_length(original_filename) <= 260),

  -- OCTET_length, not char_length: a Hebrew character is two bytes in
  -- UTF-8, so a character-based cap would quietly allow a Hebrew document
  -- twice the byte weight of an English one. ~500 KiB is roughly 250 pages
  -- of English prose (about half that in Hebrew) -- comfortably more than
  -- any single realistic notebook, while keeping one row a sane thing to
  -- fetch. The import UI refuses anything larger with a message telling
  -- the reader to split it, rather than truncating and silently losing
  -- the tail.
  full_text text not null check (char_length(full_text) >= 1 and octet_length(full_text) <= 512000),

  -- First few lines, so the Documents list can render a card without
  -- fetching the document itself. Without this the list would pull
  -- full_text for every row -- up to half a megabyte each, twenty rows a
  -- page -- purely to show a two-line excerpt. Generated rather than
  -- written by the client so it can never disagree with the text it
  -- previews, including after an edit.
  preview text generated always as (left(full_text, 300)) stored,

  -- Mirrors line_notes.body_tsv exactly, including the 'simple' config:
  -- there is no Hebrew stemmer here, and 'english' would mangle Hebrew
  -- while helping little. The title is indexed alongside the text so
  -- searching for a document by name works through the same one query.
  full_text_tsv tsvector generated always as (
    to_tsvector('simple'::regconfig, ((coalesce(title, ''::text) || ' '::text) || coalesce(full_text, ''::text)))
  ) stored,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Soft delete, matching line_notes/comments: a document the reader
  -- removes stops being listed immediately, but is not shredded out from
  -- under any note that may later cite it.
  deleted_at timestamptz
);

-- The Documents list: one owner's rows, newest first. Composite rather than
-- owner_id alone so the sort is served by the same index.
create index if not exists note_documents_owner_idx
  on public.note_documents (owner_id, created_at desc);

create index if not exists note_documents_tsv_idx
  on public.note_documents using gin (full_text_tsv);

-- Table privileges, granted EXPLICITLY rather than left to Supabase's
-- ALTER DEFAULT PRIVILEGES. The baseline replica grants the existing tables
-- their access with a one-time `grant all on all tables in schema public`,
-- which by definition covers only the tables that existed when it ran -- a
-- new table picks up nothing from it, and the owner cannot read their own
-- rows however correct the policies are. (Caught exactly that way: the first
-- run of the authorization suite against this migration failed with 42501 on
-- "the owner reads their own document.")
--
-- anon is granted NOTHING, deliberately unlike every other table here. Every
-- policy below requires auth.uid() = owner_id, which no anonymous session can
-- ever satisfy, so a grant would buy nothing but a wider surface; withholding
-- it means a signed-out caller is stopped by table privileges before RLS is
-- even consulted. This follows 20260902180000's own direction of travel
-- (grant to the role that needs it, nothing wider), and the authorization
-- suite asserts anon gets 42501 here rather than an empty result.
grant select, insert, update, delete on public.note_documents to authenticated;
grant all on public.note_documents to service_role;

alter table public.note_documents enable row level security;

-- Owner-only, all four verbs. See the header: no public read, no admin read.
create policy note_documents_owner_read on public.note_documents
  for select using (auth.uid() = owner_id);

create policy note_documents_owner_insert on public.note_documents
  for insert with check (auth.uid() = owner_id);

-- WITH CHECK as well as USING, so an update cannot reassign a document to
-- another account on its way past the policy.
create policy note_documents_owner_update on public.note_documents
  for update using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

create policy note_documents_owner_delete on public.note_documents
  for delete using (auth.uid() = owner_id);

comment on table public.note_documents is
  'A reader''s own typed notes imported from outside DafSync (pasted text, .txt, .md). Private to the importing account: no public-read or admin-read policy exists. Sharing happens by creating an ordinary line_notes note, not by exposing this table.';
