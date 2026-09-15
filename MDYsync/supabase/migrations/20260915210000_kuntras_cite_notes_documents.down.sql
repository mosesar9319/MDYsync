-- Rollback for 20260915210000_kuntras_cite_notes_documents.sql.
--
-- READ THIS BEFORE RUNNING IT. Narrowing kind back to just 'freeform' FAILS
-- if any entry has since been created with kind 'note' or 'document',
-- because the constraint is validated against existing rows as it is added
-- -- the same behavior 20260915190000's own rollback documents for
-- note_documents.source_kind. That failure is the safe outcome, not a bug
-- in this script: it refuses rather than silently destroying provenance.
--
-- To see what would block it:
--   select count(*) from public.kuntras_entries where kind in ('note','document');
--
-- If that count is not zero, decide deliberately. The entry's TEXT is not in
-- question either way -- it was already copied into body -- only the label
-- for where it came from is. Re-labelling as freeform loses that provenance
-- but keeps every entry intact:
--   update public.kuntras_entries set kind = 'freeform',
--          source_note_id = null, source_document_id = null
--    where kind in ('note', 'document');
--
-- This script deliberately does NOT do that for you -- silently rewriting
-- rows to make a rollback succeed is how provenance disappears without
-- anyone deciding it should.
--
-- Order matters: the trigger references the function; the source-matches-kind
-- constraint references both columns; drop all three before the columns.
-- Safe to run more than once.

drop trigger if exists kuntras_entries_validate_source_trg on public.kuntras_entries;
drop function if exists public.kuntras_entries_validate_source();

drop index if exists public.kuntras_entries_source_note_idx;
drop index if exists public.kuntras_entries_source_document_idx;

alter table public.kuntras_entries
  drop constraint if exists kuntras_entries_source_matches_kind;

alter table public.kuntras_entries drop column if exists source_note_id;
alter table public.kuntras_entries drop column if exists source_document_id;

alter table public.kuntras_entries
  drop constraint if exists kuntras_entries_kind_check;

alter table public.kuntras_entries
  add constraint kuntras_entries_kind_check
  check (kind in ('freeform'));
