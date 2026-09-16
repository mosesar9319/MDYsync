-- Caps the avatars bucket added in 20260916140000: a size limit and an
-- allow-list of mime types, neither of which that migration set (it left
-- both at Supabase's own defaults -- unlimited size, any content type).
--
-- The client only ever uploads a 320x320 canvas export as image/webp (see
-- profile.js's own onSaveAvatar), which is at most tens of KB -- but that is
-- a CLIENT promise, not a server one. Nothing before this migration stopped
-- a caller hitting the Storage API directly (bypassing the client, and
-- bypassing avatars_owner_write's RLS entirely, since RLS governs which ROW
-- an insert may touch, not the size or type of the bytes behind it) from
-- uploading an arbitrarily large or arbitrarily typed file into their own
-- folder.
--
-- IMPORTANT, stated here because it is not obvious: neither file_size_limit
-- nor allowed_mime_types is enforced by Postgres or by any policy in this
-- migration. Both are read and enforced by Supabase's own Storage API layer,
-- which sits in front of Postgres -- the same reason storage.objects RLS
-- alone was never going to be able to express this (see 20260916140000's own
-- header on what RLS can and cannot say). This migration can only prove the
-- BUCKET ROW carries the right configuration, in the same local shim used
-- there (see baseline/02_storage_shim.sql) -- it cannot prove an oversized or
-- wrong-typed upload is actually refused, since that refusal never reaches
-- this database at all. Confirming that end-to-end needs a real Supabase
-- project.
--
-- 5 MiB, not a tighter bound matched to the ~50-100 KB a real crop actually
-- produces: enough headroom that a future higher-resolution or non-webp
-- export does not need a follow-up migration, while still nowhere near
-- large enough to be a meaningful storage/bandwidth concern per user.

do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    update storage.buckets
      set file_size_limit = 5242880,
          allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp']
      where id = 'avatars';
  end if;
end;
$$;
