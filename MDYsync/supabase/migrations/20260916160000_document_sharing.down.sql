-- Rollback for 20260916160000_document_sharing.sql.
--
-- Everything published is forced back to private first, so the narrowed
-- UPDATE/INSERT policies restored below cannot be left describing a row
-- that no longer satisfies them -- the same "roll back to the safest
-- representable state" approach 20260916100000's own down side takes.

update public.note_documents set visibility = 'private' where visibility <> 'private';

do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    drop policy if exists documents_read on storage.objects;
    drop policy if exists documents_owner_delete on storage.objects;
    drop policy if exists documents_owner_update on storage.objects;
    drop policy if exists documents_owner_write on storage.objects;
    delete from storage.objects where bucket_id = 'documents';
    delete from storage.buckets where id = 'documents';
  end if;
end;
$$;

revoke select on public.note_documents from anon;

drop policy if exists note_documents_public_read on public.note_documents;

drop policy if exists note_documents_owner_update on public.note_documents;
create policy note_documents_owner_update on public.note_documents
  for update using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

drop policy if exists note_documents_owner_insert on public.note_documents;
create policy note_documents_owner_insert on public.note_documents
  for insert with check (auth.uid() = owner_id);

alter table public.note_documents drop column if exists file_path;
alter table public.note_documents drop column if exists visibility;

comment on table public.note_documents is
  'A reader''s own typed notes imported from outside DafSync (pasted text, .txt, .md). Private to the importing account: no public-read or admin-read policy exists. Sharing happens by creating an ordinary line_notes note, not by exposing this table.';
