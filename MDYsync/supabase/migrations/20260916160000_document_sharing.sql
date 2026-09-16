-- Publishing an imported document, and keeping the original .docx/PDF file
-- it came from.
--
-- 20260915150000's own header was explicit that this table would never be
-- public: "NOTHING HERE IS EVER PUBLIC. There is no public-read policy...
-- A document is only ever visible to the account that imported it." This
-- migration is the deliberate reversal of that -- an owner may now choose
-- to publish a document exactly the way a kuntras is published (see
-- 20260916100000's own header: private/unlisted/public, INSERT pinned to
-- private, a dedicated action widens it afterward).
--
-- WHAT DOES NOT CHANGE: line_notes_validate_source_document (20260915170000)
-- still requires a note to cite a document its OWN author imported -- that
-- restriction was never about the document's visibility, it was about who
-- may attach provenance to their own note, and this migration leaves it
-- untouched. What changes is what happens AFTER a citation exists: a reader
-- who is not the note's author can now follow it into the document, but
-- only when the document's owner has published it -- the same way a public
-- kuntras entry's citation was always followable (see
-- 20260915230000_kuntras_cite_chaburah.sql), just arriving here later.
--
-- 20260915170000's own comments describing "note_documents has no read path
-- for anyone but its owner" and "What travels is a random UUID and nothing
-- else" are now stale in the specific case of a published document -- left
-- in place there as history of why the column was designed the way it was,
-- corrected by this comment rather than rewritten out from under a
-- migration already applied to production.

alter table public.note_documents
  add column if not exists visibility text not null default 'private'
    check (visibility in ('private', 'unlisted', 'public'));

-- The path of the ORIGINAL file in the new `documents` Storage bucket below,
-- when the reader chose to keep one (docx/pdf imports only -- pasted text,
-- .txt and .md have no "original" beyond the text itself, so this stays
-- null for those, exactly as it does for every document imported before
-- this migration). Deliberately not a foreign key into storage.objects:
-- Storage is platform-managed, uploaded in a SEPARATE call after this row
-- already has an id (see my-notes-data.js's own createDocument), so the
-- object cannot exist yet at INSERT time -- file_path is written by a
-- follow-up UPDATE once the upload succeeds, and stays null forever if it
-- does not (a document imports successfully either way; keeping the
-- original is best-effort, not a requirement of importing at all).
alter table public.note_documents
  add column if not exists file_path text
    check (file_path is null or char_length(file_path) <= 400);

drop policy if exists note_documents_owner_insert on public.note_documents;
create policy note_documents_owner_insert on public.note_documents
  for insert with check (auth.uid() = owner_id and visibility = 'private');

drop policy if exists note_documents_owner_update on public.note_documents;
create policy note_documents_owner_update on public.note_documents
  for update using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

-- Mirrors kuntrasim_public_read exactly: visibility <> 'private' is the
-- whole predicate, unlisted and public are identical for READ access (see
-- 20260916100000's own header on why), and the two differ only in whether
-- fetchPublicDocuments lists it.
create policy note_documents_public_read on public.note_documents
  for select using (visibility <> 'private' and deleted_at is null);

-- Previously withheld deliberately (see 20260915150000's own "anon is
-- granted NOTHING" note) because nothing anon could ever read existed. That
-- premise no longer holds now that a document can be public.
grant select on public.note_documents to anon;

comment on table public.note_documents is
  'A reader''s own imported notes/document. Private by default; may be published (unlisted or public) via note_documents_public_read, same visibility model as kuntrasim. The original file is kept in the documents Storage bucket, referenced by file_path, when the import came from a .docx/PDF and the upload succeeded.';

-- ===========================================================================
-- The `documents` Storage bucket: the ORIGINAL .docx/PDF file, when kept.
-- ===========================================================================
--
-- Unlike the avatars bucket (20260916140000), this one is NOT public=true:
-- an avatar is unconditionally as public as the display_name sitting next
-- to it, but a document's readability depends on its OWN visibility, which
-- can be private. A public Storage bucket serves objects through a public
-- URL that bypasses RLS entirely -- marking this one public would leak
-- every private document's file regardless of any policy below. Reads
-- therefore go through Supabase's signed-URL path (client().storage.from
-- ('documents').createSignedUrl(...)), which DOES consult storage.objects
-- RLS before issuing a URL -- see my-notes-data.js's own
-- getDocumentDownloadUrl.
--
-- Path convention: {owner_id}/{document_id}.{ext} -- the folder matches
-- avatars_owner_write's own {uid}/... convention (so the same
-- storage.foldername() check gates writes), and the filename embeds the
-- note_documents row's own id so the SELECT policy below can join back to
-- it without parsing anything out of the path by hand.
--
-- Guarded on the storage schema existing, exactly like 20260916140000 --
-- see that migration's own header, and baseline/02_storage_shim.sql, for
-- why (the local scratch Postgres run-tests.sh builds does not have one).

do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
      values ('documents', 'documents', false, 26214400, array[
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/pdf'
      ])
      on conflict (id) do nothing;

    drop policy if exists documents_owner_write on storage.objects;
    create policy documents_owner_write on storage.objects
      for insert with check (bucket_id = 'documents' and (storage.foldername(name))[1] = auth.uid()::text);

    drop policy if exists documents_owner_update on storage.objects;
    create policy documents_owner_update on storage.objects
      for update
      using (bucket_id = 'documents' and (storage.foldername(name))[1] = auth.uid()::text)
      with check (bucket_id = 'documents' and (storage.foldername(name))[1] = auth.uid()::text);

    drop policy if exists documents_owner_delete on storage.objects;
    create policy documents_owner_delete on storage.objects
      for delete using (bucket_id = 'documents' and (storage.foldername(name))[1] = auth.uid()::text);

    -- Read: the owner, always -- or anyone (anon included, matching
    -- note_documents_public_read) when the note_documents row this object
    -- belongs to says visibility <> 'private'. Joined by file_path, not by
    -- re-deriving a document id from the filename -- the row is the single
    -- source of truth for what this object is.
    drop policy if exists documents_read on storage.objects;
    create policy documents_read on storage.objects
      for select using (
        bucket_id = 'documents' and (
          (storage.foldername(name))[1] = auth.uid()::text
          or exists (
            select 1 from public.note_documents d
            where d.file_path = storage.objects.name
              and d.visibility <> 'private'
              and d.deleted_at is null
          )
        )
      );
  end if;
end;
$$;
