-- Let note_documents record a .docx or PDF import.
--
-- NOT YET APPLIED. Rollback:
--   supabase/migrations/20260915190000_note_documents_docx_pdf.down.sql
--
-- 20260915150000 constrained source_kind to ('paste','txt','md') and said
-- why: the values are constrained rather than free text so the import UI and
-- this table cannot drift, and the file-backed kinds would be added by the
-- migration that actually teaches the app to read those formats. This is that
-- migration.
--
-- STILL NO FILE IS STORED. These two formats are parsed in the BROWSER --
-- PDF through the pdf.js already vendored for the Vilna page renderer, .docx
-- by reading word/document.xml out of its ZIP -- and only the extracted text
-- is sent here. There is no storage bucket, no upload endpoint and no
-- retention question, and 20260915150000's "no file is stored anywhere by
-- this migration" holds exactly as before. source_kind records what the text
-- CAME FROM, not where a file went.
--
-- Dropping and re-adding rather than ALTER ... ADD CONSTRAINT alone: a check
-- constraint cannot be widened in place. The new constraint is validated
-- against every existing row as it is added, which is what we want -- every
-- stored value is one of the three the old constraint already allowed, so
-- this cannot fail on real data.

alter table public.note_documents
  drop constraint if exists note_documents_source_kind_check;

alter table public.note_documents
  add constraint note_documents_source_kind_check
  check (source_kind in ('paste', 'txt', 'md', 'docx', 'pdf'));

comment on column public.note_documents.source_kind is
  'How the text arrived: pasted, or read out of a .txt/.md/.docx/PDF file in the browser. No file is stored anywhere -- this records the origin of the text, not a pointer to anything.';
