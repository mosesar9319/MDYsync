-- Rollback for 20260916150000_avatars_bucket_limits.sql.

do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    update storage.buckets
      set file_size_limit = null,
          allowed_mime_types = null
      where id = 'avatars';
  end if;
end;
$$;
