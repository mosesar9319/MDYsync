-- Rollback for 20260916140000_profile_self_service.sql.

do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    drop policy if exists avatars_owner_delete on storage.objects;
    drop policy if exists avatars_owner_update on storage.objects;
    drop policy if exists avatars_owner_write  on storage.objects;
    drop policy if exists avatars_public_read  on storage.objects;
    delete from storage.objects where bucket_id = 'avatars';
    delete from storage.buckets where id = 'avatars';
  end if;
end;
$$;

revoke execute on function public.set_profile_role_label(uuid, text) from authenticated;
drop function if exists public.set_profile_role_label(uuid, text);

drop policy if exists profiles_admin_read  on public.profiles;
drop policy if exists profiles_owner_update on public.profiles;

drop trigger if exists profiles_guard_update on public.profiles;
drop function if exists public.profiles_guard_update();

alter table public.profiles drop constraint if exists profiles_display_name_check;
