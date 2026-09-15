-- Citing an imported document from a note on the daf.
--
-- Depends on 20260915150000_note_documents.sql. NOT YET APPLIED TO
-- PRODUCTION. Rollback:
--   supabase/migrations/20260915170000_note_source_document.down.sql
--
-- WHAT THIS DOES, AND WHAT IT DELIBERATELY DOES NOT
--
-- A reader who has imported their own notebook can now, while reading a
-- daf, pick a passage out of that notebook and post it as an ORDINARY note
-- -- a normal line_notes row, with a normal body, subject to the same 2000
-- character cap, the same privacy toggle, the same categories, the same
-- moderation path as every other note. The only thing this column adds is
-- provenance: "this note came out of that document."
--
-- It is NOT a join that makes the document readable through the note. It
-- carries no text of its own; the excerpt lives in line_notes.body, copied
-- at the moment the reader chose it. Editing the document afterwards does
-- not rewrite notes already taken from it, which is the intended behavior:
-- a note posted to a public discussion must not silently change under the
-- people reading it because its author edited a private file.

-- WHAT A NON-AUTHOR CAN SEE. line_notes_public_read selects whole rows, so
-- this column travels with a note the reader chose to share. What travels is
-- a random UUID and nothing else: note_documents has no public-read and no
-- admin-read policy, so the id cannot be exchanged for a title, a preview or
-- a byte of text by anyone but the owner. The one thing it does reveal is
-- that two of the same author's public notes were quoted from the same file
-- -- notes already published under one name, so this groups what was already
-- attributable. Postgres cannot make a column's visibility depend on the
-- row (column privileges are table-wide), so this is documented rather than
-- engineered around; the UI shows the attribution only to the author.

alter table public.line_notes
  add column if not exists source_document_id uuid
    references public.note_documents(id) on delete set null;

comment on column public.line_notes.source_document_id is
  'The imported document this note was excerpted from, when it was. Provenance only -- the excerpt itself lives in body. Never exposes the document: note_documents has no read path for anyone but its owner.';

-- ON DELETE SET NULL rather than CASCADE, and it is close to unreachable in
-- practice either way: the app soft-deletes a document (sets deleted_at)
-- precisely so a note citing it cannot end up pointing at nothing. This
-- clause only matters for a genuine hard DELETE -- an account being erased,
-- or an operator removing a row by hand -- and in that case losing the
-- provenance is clearly right, while losing the NOTE would not be. The note
-- is the reader's own writing, published under their name, possibly with a
-- discussion under it; it must outlive the file it was quoted from.

-- Partial: the overwhelming majority of notes cite nothing, and the only
-- question ever asked of this column is the reverse lookup "which notes came
-- out of this document" (the per-document citation list in My Notes).
create index if not exists line_notes_source_document_idx
  on public.line_notes (source_document_id)
  where source_document_id is not null;

-- A note may only cite a document its OWN AUTHOR imported.
--
-- Without this, nothing stops a client from writing any UUID at all into the
-- column, including one belonging to another account, which would render
-- that reader an attribution to a document they never wrote and cannot see.
-- RLS cannot express this: line_notes' insert policy governs the line_notes
-- row, and note_documents' policies govern reads of THAT table -- neither
-- looks across the two. A trigger is where this schema already puts exactly
-- this kind of cross-table validation (validate_mentions does the same job
-- for mentioned_user_ids).
--
-- SECURITY DEFINER so the check asks the real question -- "does this
-- document belong to this author" -- rather than the invoker's RLS-filtered
-- view of it. Both end up rejecting a foreign document, but for different
-- reasons, and a validation that fails because the row was INVISIBLE rather
-- than because it was someone else's is a validation that breaks the moment
-- a policy changes. search_path is pinned, per this schema's convention for
-- every definer function.
--
-- It is written against author_id, not auth.uid(): line_notes_insert already
-- requires those to match for an ordinary caller, and going through
-- author_id means the rule still holds for a service_role write or a
-- backfill, where auth.uid() is null.
create or replace function public.line_notes_validate_source_document() returns trigger
  language plpgsql security definer set search_path to 'public'
as $$
begin
  if new.source_document_id is null then
    return new;
  end if;
  if not exists (
    select 1 from public.note_documents d
    where d.id = new.source_document_id
      and d.owner_id = new.author_id
  ) then
    raise exception 'A note can only cite a document imported by its own author.';
  end if;
  return new;
end;
$$;

revoke execute on function public.line_notes_validate_source_document() from public;

-- BEFORE UPDATE as well as INSERT: an update is how a note would be
-- retargeted at a different document, and it has to pass the same check.
drop trigger if exists line_notes_validate_source_document on public.line_notes;
create trigger line_notes_validate_source_document
  before insert or update on public.line_notes
  for each row execute function public.line_notes_validate_source_document();
