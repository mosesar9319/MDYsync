-- User profiles, made self-service.
--
-- 20260902190000 added avatar_path/role_label to `profiles` and the
-- public_profiles view that exposes them (plus display_name) -- but nothing
-- since has ever let anyone WRITE those columns. `profiles` has carried only
-- profiles_select_own; there has never been an UPDATE policy on it at all.
-- This migration is that write path, split three ways by who may touch what:
--
--   * display_name, avatar_path -- the owner, and only the owner.
--   * role_label                -- an admin, on ANY profile, never the owner.
--   * email, is_admin           -- nobody, through this path, ever.
--
-- RLS alone cannot express that split: a USING/WITH CHECK predicate governs
-- which ROWS an UPDATE may touch, not which COLUMNS within an allowed row
-- changed. A single permissive `auth.uid() = id` policy would let an owner
-- update their own row AND smuggle a role_label or is_admin change into the
-- very same statement. So the row-level question (whose profile) and the
-- column-level question (which fields) are deliberately answered by two
-- different mechanisms, the same split this codebase already uses for
-- cross-row/cross-column validation RLS cannot express on its own (see
-- kuntras_entries_validate_source's own header):
--
--   * profiles_owner_update (RLS) answers "whose row" for a plain client
--     `.update()` -- the caller's own, full stop.
--   * profiles_guard_update (a BEFORE UPDATE trigger) answers "which
--     columns" for EVERY update to this table, regardless of which policy
--     let it through: email and is_admin are frozen unconditionally;
--     role_label is frozen unless the caller is an admin.
--
-- role_label's own write path is set_profile_role_label, a SECURITY DEFINER
-- RPC mirroring set_note_hidden/set_comment_hidden exactly (self-checks
-- is_admin(), runs as the function owner so it bypasses RLS on its own
-- UPDATE -- but NOT the guard trigger above, which still fires and still
-- passes, since is_admin() reads the original caller's auth.uid() even
-- inside a SECURITY DEFINER function). No separate admin RLS UPDATE policy
-- on profiles is needed for this reason -- exactly why set_note_hidden never
-- needed one on line_notes either.
--
-- profiles_admin_read is new too: there was no way for an admin to find a
-- user to label in the first place (profiles_select_own is owner-only,
-- public_profiles never exposes email). Mirrors line_notes_admin_read /
-- comments_admin_read / reports_admin_read exactly.

alter table public.profiles drop constraint if exists profiles_display_name_check;
alter table public.profiles add  constraint profiles_display_name_check
  check (display_name is null or char_length(display_name) between 1 and 80);

create or replace function public.profiles_guard_update() returns trigger
  language plpgsql security definer set search_path to 'public'
as $$
begin
  if NEW.email is distinct from OLD.email then
    raise exception 'email cannot be changed here' using errcode = '42501';
  end if;
  if NEW.is_admin is distinct from OLD.is_admin then
    raise exception 'is_admin cannot be changed here' using errcode = '42501';
  end if;
  if NEW.role_label is distinct from OLD.role_label and not public.is_admin() then
    raise exception 'only an admin can set a role label' using errcode = '42501';
  end if;
  return NEW;
end;
$$;

drop trigger if exists profiles_guard_update on public.profiles;
create trigger profiles_guard_update
  before update on public.profiles
  for each row execute function public.profiles_guard_update();

create policy profiles_owner_update on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

create policy profiles_admin_read on public.profiles
  for select using (public.is_admin());

create or replace function public.set_profile_role_label(p_user_id uuid, p_role_label text) returns void
  language plpgsql security definer set search_path to 'public'
as $$
begin
  if not public.is_admin() then
    raise exception 'only admins can set a role label' using errcode = '42501';
  end if;
  update public.profiles set role_label = p_role_label where id = p_user_id;
end;
$$;

revoke execute on function public.set_profile_role_label(uuid, text) from public, anon;
grant execute on function public.set_profile_role_label(uuid, text) to authenticated;

comment on function public.profiles_guard_update() is
  'Freezes profiles.email and profiles.is_admin against every UPDATE; freezes role_label unless the caller is an admin. See this migration''s own header for why this lives in a trigger rather than RLS.';
comment on function public.set_profile_role_label(uuid, text) is
  'Admin-only: assigns (or clears, with null) the role_label badge shown next to a poster''s name in Cloud Chaburah. Mirrors set_note_hidden/set_comment_hidden.';

-- ===========================================================================
-- Avatars: a public Storage bucket, one object per user at {user_id}/avatar.*
-- ===========================================================================
--
-- Guarded on the storage schema actually existing: real Supabase always has
-- it (it is platform-managed, not part of this repo's `public` baseline),
-- but the throwaway Postgres run-tests.sh builds from
-- baseline/00_current_production_schema.sql does not -- that file is
-- explicitly a replica of production's `public` schema only. See
-- baseline/02_storage_shim.sql for the minimal local stand-in that makes the
-- policies below actually provable in the local suite; this guard is what
-- lets the same migration file apply cleanly to both.

do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public)
      values ('avatars', 'avatars', true)
      on conflict (id) do nothing;

    -- storage.foldername(name) splits the object path on '/' and returns
    -- every directory component; [1] is therefore the top-level folder,
    -- which every policy below pins to the caller's own uid. Anyone
    -- (including anon) may read -- an avatar is exactly as public as the
    -- display_name/role_label sitting next to it in public_profiles.
    drop policy if exists avatars_public_read on storage.objects;
    create policy avatars_public_read on storage.objects
      for select using (bucket_id = 'avatars');

    drop policy if exists avatars_owner_write on storage.objects;
    create policy avatars_owner_write on storage.objects
      for insert with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

    drop policy if exists avatars_owner_update on storage.objects;
    create policy avatars_owner_update on storage.objects
      for update
      using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
      with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

    drop policy if exists avatars_owner_delete on storage.objects;
    create policy avatars_owner_delete on storage.objects
      for delete using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
  end if;
end;
$$;
