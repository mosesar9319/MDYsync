-- Rollback for 20260915180000_note_documents_revoke_anon.sql.
--
-- Restores what Supabase's ALTER DEFAULT PRIVILEGES would have granted a
-- newly created table and function, which is what the database held before
-- that migration ran. It does NOT make anon able to read anyone's documents:
-- RLS stays enabled and every policy still requires auth.uid() = owner_id,
-- so this only puts the outer layer back.
--
-- Safe to run more than once.

grant select, insert, update, delete, truncate, references, trigger
  on public.note_documents to anon;

grant execute on function public.line_notes_validate_source_document() to anon;
grant execute on function public.line_notes_validate_source_document() to authenticated;
