-- Kuntras Builder, slice 1: the shell.
--
-- NOT YET APPLIED. Rollback:
--   supabase/migrations/20260915200000_kuntras_builder.down.sql
--
-- A kuntras is an assembled pamphlet: a title, an ordered tree of sections,
-- and ordered entries inside those sections. This slice builds the shell
-- ONLY -- an owner writing FREEFORM text into their own private kuntras.
-- Nothing here reads from line_notes, note_documents or comments yet, and
-- nothing here is ever public: that is deliberately left to later slices,
-- once the shell itself has been proven, the same order My Notes was built
-- in (library, then import, then citation).
--
-- WHY THREE TABLES RATHER THAN ONE. A kuntras entry belongs to a specific
-- position inside a specific kuntras's tree, and that tree has structure of
-- its own (nested sections) independent of what any entry contains. Folding
-- sections into the entries table would mean either a self-referential
-- "this row is a section OR an entry" polymorphism, or repeating a
-- section's title on every entry beneath it. Three tables keep each
-- question -- "what kuntrasim does this owner have," "how is this one
-- organized," "what is actually written in it" -- answerable on its own.

create table if not exists public.kuntrasim (
  id       uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,

  title text not null check (char_length(title) >= 1 and char_length(title) <= 200),

  -- Only 'private' is reachable in this slice -- the insert/update policies
  -- below enforce that directly rather than leaving it to application code,
  -- so a client bug cannot publish a kuntras before publishing exists.
  -- 'unlisted' and 'public' are named now so the later migration that
  -- activates them is a constraint change, not a column rename touching
  -- every existing row.
  visibility text not null default 'private'
    check (visibility in ('private', 'unlisted', 'public')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- A section within one kuntras. parent_section_id makes the tree, the same
-- self-referential shape comments.parent_comment_id already uses for reply
-- nesting in this schema -- ON DELETE CASCADE there too, so removing a
-- section removes what was nested under it rather than orphaning it.
--
-- No cycle-prevention trigger: comments.parent_comment_id carries none
-- either, on the same reasoning -- the ONLY way to reach this table is
-- through the owner's own UI, which only ever offers an EXISTING section of
-- this SAME kuntras as a parent when creating a new one, so a cycle cannot
-- arise through normal use. A hand-crafted request naming a section as its
-- own ancestor would produce a tree no query here ever walks upward, not a
-- privilege anyone gains -- RLS still confines every operation to the
-- caller's own rows.
create table if not exists public.kuntras_sections (
  id                uuid primary key default gen_random_uuid(),
  kuntras_id        uuid not null references public.kuntrasim(id) on delete cascade,
  parent_section_id uuid references public.kuntras_sections(id) on delete cascade,

  title text not null check (char_length(title) >= 1 and char_length(title) <= 200),

  -- Sibling order. An integer the CLIENT renumbers on every reorder within
  -- one (kuntras_id, parent_section_id) group, the same "app owns the
  -- numbering" choice made for every other ordered list in this schema
  -- (word_ranges, the reply tree). Not unique: two siblings briefly sharing
  -- a position mid-drag is harmless, and a uniqueness constraint would only
  -- buy a race condition to fight instead.
  position integer not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A section cannot be its own parent. This is the one cycle a single
  -- CHECK constraint can actually catch (a cycle through an intermediate
  -- section cannot be expressed as a row-local check); it is here because
  -- it is free, not because it is a complete guarantee.
  constraint kuntras_sections_not_own_parent check (id is distinct from parent_section_id)
);

-- One piece of content inside a kuntras: either at the top level
-- (section_id null) or inside a specific section.
--
-- kind is constrained to 'freeform' alone in this slice, on purpose: adding
-- 'note', 'document' and 'discussion' later is a widened CHECK constraint
-- (see 20260915190000's own precedent for note_documents.source_kind)
-- plus the nullable source-reference columns THAT migration will add, not a
-- redesign of this table. Every entry's actual content lives in `body`
-- regardless of kind -- a cited note's text is COPIED in at the moment it
-- is added, the same "never a live reference" rule source_document_id
-- already established for My Notes citations, so a kuntras entry can never
-- change out from under a reader because the note it was built from was
-- later edited or deleted.
create table if not exists public.kuntras_entries (
  id         uuid primary key default gen_random_uuid(),
  kuntras_id uuid not null references public.kuntrasim(id) on delete cascade,
  section_id uuid references public.kuntras_sections(id) on delete cascade,

  kind text not null default 'freeform' check (kind in ('freeform')),

  -- Optional heading for this one entry, independent of the section title
  -- it sits under (a section may hold several entries, each worth its own
  -- caption).
  title text check (title is null or char_length(title) <= 200),

  -- Matches line_notes.body's own ceiling: an entry is prose written or
  -- quoted at note-length, not a second copy of an entire note_documents
  -- import pasted in whole. A future slice that lets an entry cite a whole
  -- document will need its own answer to how much of it gets copied in;
  -- this ceiling does not have to be right for that slice, only for this
  -- one.
  body text not null check (char_length(body) >= 1 and char_length(body) <= 2000),

  position integer not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- section_id must belong to the SAME kuntras_id as the entry, and
-- parent_section_id must belong to the same kuntras_id as its child
-- section. Neither is expressible as a CHECK constraint (a check cannot
-- read another table), so both are triggers -- the same reason this schema
-- already uses a trigger for line_notes_validate_source_document rather
-- than trying to express "this row may only reference a row the same
-- owner controls" as a constraint.
--
-- Without this, a section or entry could be moved into a DIFFERENT
-- kuntras's tree by id alone (still one the same owner owns, since RLS
-- confines both to the caller -- but a builder is expected to keep one
-- kuntras's tree self-contained, and letting the two drift apart would
-- make "delete this kuntras" silently leave orphaned sections behind
-- errors, or reparenting bugs, rather than a real permission problem).
create or replace function public.kuntras_validate_section_parentage() returns trigger
  language plpgsql security definer set search_path to 'public'
as $$
begin
  if new.parent_section_id is not null then
    if not exists (
      select 1 from public.kuntras_sections p
      where p.id = new.parent_section_id and p.kuntras_id = new.kuntras_id
    ) then
      raise exception 'A section''s parent must belong to the same kuntras.';
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function public.kuntras_validate_section_parentage() from public;
revoke execute on function public.kuntras_validate_section_parentage() from anon;
revoke execute on function public.kuntras_validate_section_parentage() from authenticated;

drop trigger if exists kuntras_sections_validate_parentage on public.kuntras_sections;
create trigger kuntras_sections_validate_parentage
  before insert or update on public.kuntras_sections
  for each row execute function public.kuntras_validate_section_parentage();

create or replace function public.kuntras_validate_entry_section() returns trigger
  language plpgsql security definer set search_path to 'public'
as $$
begin
  if new.section_id is not null then
    if not exists (
      select 1 from public.kuntras_sections s
      where s.id = new.section_id and s.kuntras_id = new.kuntras_id
    ) then
      raise exception 'An entry''s section must belong to the same kuntras.';
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function public.kuntras_validate_entry_section() from public;
revoke execute on function public.kuntras_validate_entry_section() from anon;
revoke execute on function public.kuntras_validate_entry_section() from authenticated;

drop trigger if exists kuntras_entries_validate_section on public.kuntras_entries;
create trigger kuntras_entries_validate_section
  before insert or update on public.kuntras_entries
  for each row execute function public.kuntras_validate_entry_section();

create index if not exists kuntrasim_owner_idx on public.kuntrasim (owner_id, created_at desc);
create index if not exists kuntras_sections_kuntras_idx on public.kuntras_sections (kuntras_id, parent_section_id, position);
create index if not exists kuntras_entries_kuntras_idx on public.kuntras_entries (kuntras_id, section_id, position);

-- Table privileges, granted AND withheld explicitly in this same migration.
--
-- 20260915150000 granted note_documents to authenticated and said nothing
-- about anon, on the reasoning that a table nobody grants to is a table
-- anon cannot touch -- true of the committed baseline's one-time
-- `grant all on all tables in schema public`, which only covers tables that
-- existed when it ran, but NOT true of the real database, where Supabase's
-- ALTER DEFAULT PRIVILEGES hands every new table to anon automatically.
-- Verified directly after applying that migration: anon held full DML on
-- note_documents until a follow-up migration (20260915180000) revoked it.
-- That follow-up should not have been a follow-up -- so here the explicit
-- `revoke all ... from anon` for all three tables ships in the SAME
-- migration that creates them, not after the gap is found in production a
-- second time.
grant select, insert, update, delete on public.kuntrasim        to authenticated;
grant select, insert, update, delete on public.kuntras_sections to authenticated;
grant select, insert, update, delete on public.kuntras_entries  to authenticated;
grant all on public.kuntrasim        to service_role;
grant all on public.kuntras_sections to service_role;
grant all on public.kuntras_entries  to service_role;

revoke all on public.kuntrasim        from anon;
revoke all on public.kuntras_sections from anon;
revoke all on public.kuntras_entries  from anon;

alter table public.kuntrasim        enable row level security;
alter table public.kuntras_sections enable row level security;
alter table public.kuntras_entries  enable row level security;

-- Owner-only, all four verbs, on all three tables -- nothing here is ever
-- public in this slice, so there is no public-read or admin-read policy on
-- any of them (matching note_documents, not line_notes).
create policy kuntrasim_owner_read on public.kuntrasim
  for select using (auth.uid() = owner_id);
create policy kuntrasim_owner_insert on public.kuntrasim
  for insert with check (auth.uid() = owner_id and visibility = 'private');
create policy kuntrasim_owner_update on public.kuntrasim
  for update using (auth.uid() = owner_id) with check (auth.uid() = owner_id and visibility = 'private');
create policy kuntrasim_owner_delete on public.kuntrasim
  for delete using (auth.uid() = owner_id);

-- Sections and entries have no owner_id column of their own: ownership is
-- decided by which kuntras they belong to, exactly as comments' visibility
-- is decided through the note they belong to rather than a copy of its own
-- author_id. WITH CHECK on insert/update re-derives ownership through the
-- same join, so a caller cannot attach a section to a kuntras they do not
-- own by naming its id directly.
create policy kuntras_sections_owner_read on public.kuntras_sections
  for select using (exists (
    select 1 from public.kuntrasim k where k.id = kuntras_sections.kuntras_id and k.owner_id = auth.uid()
  ));
create policy kuntras_sections_owner_insert on public.kuntras_sections
  for insert with check (exists (
    select 1 from public.kuntrasim k where k.id = kuntras_sections.kuntras_id and k.owner_id = auth.uid()
  ));
create policy kuntras_sections_owner_update on public.kuntras_sections
  for update using (exists (
    select 1 from public.kuntrasim k where k.id = kuntras_sections.kuntras_id and k.owner_id = auth.uid()
  )) with check (exists (
    select 1 from public.kuntrasim k where k.id = kuntras_sections.kuntras_id and k.owner_id = auth.uid()
  ));
create policy kuntras_sections_owner_delete on public.kuntras_sections
  for delete using (exists (
    select 1 from public.kuntrasim k where k.id = kuntras_sections.kuntras_id and k.owner_id = auth.uid()
  ));

create policy kuntras_entries_owner_read on public.kuntras_entries
  for select using (exists (
    select 1 from public.kuntrasim k where k.id = kuntras_entries.kuntras_id and k.owner_id = auth.uid()
  ));
create policy kuntras_entries_owner_insert on public.kuntras_entries
  for insert with check (exists (
    select 1 from public.kuntrasim k where k.id = kuntras_entries.kuntras_id and k.owner_id = auth.uid()
  ));
create policy kuntras_entries_owner_update on public.kuntras_entries
  for update using (exists (
    select 1 from public.kuntrasim k where k.id = kuntras_entries.kuntras_id and k.owner_id = auth.uid()
  )) with check (exists (
    select 1 from public.kuntrasim k where k.id = kuntras_entries.kuntras_id and k.owner_id = auth.uid()
  ));
create policy kuntras_entries_owner_delete on public.kuntras_entries
  for delete using (exists (
    select 1 from public.kuntrasim k where k.id = kuntras_entries.kuntras_id and k.owner_id = auth.uid()
  ));

comment on table public.kuntrasim is
  'An assembled pamphlet: title + owner + visibility. Slice 1 -- visibility is pinned to private by the insert/update policies; unlisted and public are named but not yet reachable.';
comment on table public.kuntras_sections is
  'The tree structure of one kuntras. Ownership is derived through kuntras_id, not stored locally.';
comment on table public.kuntras_entries is
  'One piece of content inside a kuntras. Slice 1 -- kind is constrained to freeform; every entry''s body is written directly, never yet cited from another table.';
