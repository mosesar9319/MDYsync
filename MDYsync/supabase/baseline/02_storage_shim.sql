-- A minimal, LOCAL-ONLY stand-in for Supabase's own storage schema.
--
-- Unlike 00_current_production_schema.sql, this is not a replica of
-- anything in production -- Supabase Storage is platform-managed
-- infrastructure that lives outside the `public` schema this project's
-- baseline otherwise mirrors, and the real thing does far more than RLS
-- (its own API layer, size/mime validation, CDN). This file exists purely
-- so migration 20260916140000's avatars bucket policies -- who may read,
-- insert, update, or delete which objects -- are provable against a real
-- Postgres locally, the same discipline this project applies to every other
-- permission rule (see supabase/README.md). It proves the RLS predicate
-- only, nothing about Storage's other behavior.
--
-- Applied only if a real `storage` schema is not already present, so this
-- is a genuine no-op against a real Supabase project (which always has the
-- genuine article) and only ever activates for the throwaway local Postgres
-- run-tests.sh builds.
--
-- Table shapes and storage.foldername() match Supabase's real ones closely
-- enough for RLS purposes: storage.objects.name is the full object path
-- ("<uid>/avatar.webp"), and storage.foldername(name) returns that path's
-- directory components, which every avatars_* policy in the migration
-- indexes at [1] to pin an object to its owner's own folder.

do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    raise notice 'storage schema already exists -- skipping the local shim';
    return;
  end if;

  create schema storage;
  grant usage on schema storage to anon, authenticated, service_role;

  create table storage.buckets (
    id text primary key,
    name text not null,
    public boolean not null default false,
    -- Real Supabase Storage reads both of these at its own API layer, in
    -- front of Postgres -- neither is enforced here or by any RLS policy.
    -- Present so a migration setting them (e.g. 20260916150000) is provable
    -- to have configured the right VALUES; see that migration's own header
    -- for why that is all this shim can prove.
    file_size_limit bigint,
    allowed_mime_types text[],
    created_at timestamptz not null default now()
  );

  create table storage.objects (
    id uuid primary key default gen_random_uuid(),
    bucket_id text references storage.buckets(id),
    name text not null,
    owner uuid,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );

  create or replace function storage.foldername(name text) returns text[]
    language sql immutable
  as $fn$
    select case
      when position('/' in name) = 0 then array[]::text[]
      else (string_to_array(name, '/'))[1 : array_length(string_to_array(name, '/'), 1) - 1]
    end;
  $fn$;

  alter table storage.buckets enable row level security;
  alter table storage.objects enable row level security;

  grant select on storage.buckets to anon, authenticated, service_role;
  grant select, insert, update, delete on storage.objects to anon, authenticated, service_role;

  -- Buckets themselves are readable by anyone in this shim -- only
  -- storage.objects' own RLS (added per-bucket by the migration that needs
  -- it) is what this project actually has anything to prove about.
  create policy storage_buckets_read on storage.buckets for select using (true);
end;
$$;
