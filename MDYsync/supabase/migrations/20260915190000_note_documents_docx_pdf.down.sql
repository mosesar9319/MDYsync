-- Rollback for 20260915190000_note_documents_docx_pdf.sql.
--
-- READ THIS BEFORE RUNNING IT. Narrowing the constraint back to
-- ('paste','txt','md') FAILS if any document has since been imported from a
-- .docx or a PDF, because the constraint is validated against existing rows
-- as it is added. That failure is the safe outcome -- it refuses rather than
-- destroying anything -- but it means this is not a rollback you can run
-- blind.
--
-- To see what would block it:
--   select count(*) from public.note_documents where source_kind in ('docx','pdf');
--
-- If that count is not zero, decide deliberately what those documents should
-- become. Their TEXT is not in question either way; only the label for where
-- it came from is. Re-labelling them as pasted text loses that provenance but
-- keeps every document readable:
--   update public.note_documents set source_kind = 'paste'
--    where source_kind in ('docx','pdf');
--
-- This script deliberately does NOT do that for you: silently rewriting rows
-- to make a rollback succeed is how provenance disappears without anyone
-- deciding it should.

alter table public.note_documents
  drop constraint if exists note_documents_source_kind_check;

alter table public.note_documents
  add constraint note_documents_source_kind_check
  check (source_kind in ('paste', 'txt', 'md'));
