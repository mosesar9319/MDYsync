-- Kuntras Builder, slice 4: sharing -- private, an unlisted link, or fully
-- public in Cloud Chaburah's own public listing.
--
-- NOT YET APPLIED. Rollback:
--   supabase/migrations/20260916100000_kuntras_sharing.down.sql
-- Depends on 20260915200000_kuntras_builder.sql, whose own header already
-- named 'unlisted'/'public' in kuntrasim.visibility's CHECK constraint and
-- said plainly that this slice, not that one, is what makes them reachable:
-- "visibility is pinned to private by the insert/update policies; unlisted
-- and public are named but not yet reachable."
--
-- 'unlisted' and 'public' are IDENTICAL for read access -- both mean "anyone
-- who has the id may read it," anon included. They differ only in
-- discoverability: a public one also appears in the public listing query
-- (see kuntras-data.js's fetchPublicKuntrasim); an unlisted one is reachable
-- only by whoever has the link. Nothing here treats them differently on
-- purpose -- the distinction lives entirely in which rows a LISTING query
-- asks for, not in what a single-row read is allowed to see.

-- Only UPDATE is widened, not INSERT: a kuntras always starts private (the
-- library's own "New kuntras" flow has no publish step of its own), and is
-- published afterward through a deliberate action in the builder. Insert
-- staying pinned to 'private' means a client bug in the CREATE path still
-- cannot publish a kuntras before its own content exists.
drop policy if exists kuntrasim_owner_update on public.kuntrasim;
create policy kuntrasim_owner_update on public.kuntrasim
  for update using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id and visibility in ('private', 'unlisted', 'public'));

-- Added ALONGSIDE kuntrasim_owner_read, not replacing it -- Postgres ORs
-- permissive policies together, so the owner keeps seeing their own private
-- rows through the original policy while anyone (anon included) can now see
-- a row that has been published, through this one.
create policy kuntrasim_public_read on public.kuntrasim
  for select using (visibility <> 'private' and deleted_at is null);

create policy kuntras_sections_public_read on public.kuntras_sections
  for select using (exists (
    select 1 from public.kuntrasim k
    where k.id = kuntras_sections.kuntras_id
      and k.visibility <> 'private' and k.deleted_at is null
  ));

create policy kuntras_entries_public_read on public.kuntras_entries
  for select using (exists (
    select 1 from public.kuntrasim k
    where k.id = kuntras_entries.kuntras_id
      and k.visibility <> 'private' and k.deleted_at is null
  ));

-- 20260915200000 revoked ALL from anon on these three tables outright, since
-- slice 1 had nothing anon was ever allowed to see. A published kuntras
-- changes that -- but only for reading; anon still has no insert/update/
-- delete grant on any of the three, so the new read policies above are the
-- only thing this opens up.
grant select on public.kuntrasim        to anon;
grant select on public.kuntras_sections to anon;
grant select on public.kuntras_entries  to anon;

comment on table public.kuntrasim is
  'An assembled pamphlet: title + owner + visibility. Slice 4 -- private, unlisted (readable by anyone with the id) or public (also listed) are all reachable now.';
comment on column public.kuntrasim.visibility is
  'private: owner only. unlisted: anyone with the id, never listed. public: anyone with the id, and listed in the public browse query. Identical read access for unlisted/public -- see this migration''s own header.';
