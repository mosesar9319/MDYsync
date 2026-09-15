-- Rollback for 20260915170000_note_source_document.sql.
--
-- WHAT IS LOST: the provenance link only -- which document each note was
-- excerpted from. No note is deleted and no note's text changes: the excerpt
-- was copied into line_notes.body when it was taken, and that column is not
-- touched here. Re-running the up migration afterwards leaves every existing
-- note with a null citation; there is no way to recover which document a
-- note came from once this column is gone, so record it first if it matters.
--
-- Order matters: the trigger references the function, so it goes first.
-- Safe to run more than once.

drop trigger if exists line_notes_validate_source_document on public.line_notes;
drop function if exists public.line_notes_validate_source_document();
drop index if exists public.line_notes_source_document_idx;
alter table public.line_notes drop column if exists source_document_id;
