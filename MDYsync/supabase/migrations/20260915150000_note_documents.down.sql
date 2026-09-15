-- Rollback for 20260915150000_note_documents.sql.
--
-- Nothing else references note_documents: no foreign key points at it, no
-- trigger on another table touches it, and line_notes was deliberately left
-- unchanged by that migration (attaching a document to a daf is a separate,
-- later change). So this drops cleanly.
--
-- WHAT IS LOST: every imported document, which for a pasted import is the
-- only copy DafSync holds -- no file was stored anywhere else, because that
-- migration stores no files. Export anything worth keeping before running
-- this.
--
-- Safe to run more than once.

drop table if exists public.note_documents;
