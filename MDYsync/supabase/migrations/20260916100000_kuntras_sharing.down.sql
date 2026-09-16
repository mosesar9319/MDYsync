-- Rollback for 20260916100000_kuntras_sharing.sql.
--
-- Anything published is forced back to private first, so the narrowed
-- UPDATE policy's WITH CHECK (restored below) cannot be left describing a
-- row that no longer satisfies it -- the same "roll back to the safest
-- representable state" approach other widening migrations' down side take.

update public.kuntrasim set visibility = 'private' where visibility <> 'private';

revoke select on public.kuntrasim        from anon;
revoke select on public.kuntras_sections from anon;
revoke select on public.kuntras_entries  from anon;

drop policy if exists kuntras_entries_public_read on public.kuntras_entries;
drop policy if exists kuntras_sections_public_read on public.kuntras_sections;
drop policy if exists kuntrasim_public_read on public.kuntrasim;

drop policy if exists kuntrasim_owner_update on public.kuntrasim;
create policy kuntrasim_owner_update on public.kuntrasim
  for update using (auth.uid() = owner_id) with check (auth.uid() = owner_id and visibility = 'private');

comment on table public.kuntrasim is
  'An assembled pamphlet: title + owner + visibility. Slice 1 -- visibility is pinned to private by the insert/update policies; unlisted and public are named but not yet reachable.';
comment on column public.kuntrasim.visibility is null;
