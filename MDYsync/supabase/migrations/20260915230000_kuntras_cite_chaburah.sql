-- Kuntras Builder, slice 3: quoting a public Cloud Chaburah discussion.
--
-- NOT YET APPLIED. Rollback:
--   supabase/migrations/20260915230000_kuntras_cite_chaburah.down.sql
-- Depends on 20260915210000_kuntras_cite_notes_documents.sql.
--
-- Widens kuntras_entries.kind again, the same drop-and-recreate move as
-- 20260915210000, to accept 'chaburah' alongside 'freeform'/'note'/
-- 'document'. Every existing row's value already satisfies the wider
-- constraint, so this cannot fail on real data.

alter table public.kuntras_entries
  drop constraint if exists kuntras_entries_kind_check;

alter table public.kuntras_entries
  add constraint kuntras_entries_kind_check
  check (kind in ('freeform', 'note', 'document', 'chaburah'));

-- A SEPARATE column from source_note_id, even though both reference
-- line_notes, because the two mean different things and are validated
-- differently below: source_note_id is a PRIVATE note the kuntras owner
-- wrote themselves (checked by author_id); source_chaburah_note_id is a
-- PUBLIC discussion anyone may quote, written by anyone, checked by
-- visibility rather than authorship. Collapsing them into one column would
-- collapse that distinction too, and a client would be free to claim a
-- 'note' citation on someone else's public post.
alter table public.kuntras_entries
  add column if not exists source_chaburah_note_id uuid
    references public.line_notes(id) on delete set null;

comment on column public.kuntras_entries.source_chaburah_note_id is
  'The line_notes row (a PUBLIC Cloud Chaburah discussion) this entry was quoted from, when it was. Provenance only -- the excerpt itself lives in body. Unlike source_note_id, ownership is not required: any public discussion may be quoted.';

-- An entry cites at most one source; which column may be set follows from
-- kind, same shape as 20260915210000's own version of this constraint,
-- extended with the new kind/column pair.
alter table public.kuntras_entries
  drop constraint if exists kuntras_entries_source_matches_kind;

alter table public.kuntras_entries
  add constraint kuntras_entries_source_matches_kind check (
    (kind = 'freeform' and source_note_id is null and source_document_id is null and source_chaburah_note_id is null)
    or (kind = 'note' and source_note_id is not null and source_document_id is null and source_chaburah_note_id is null)
    or (kind = 'document' and source_document_id is not null and source_note_id is null and source_chaburah_note_id is null)
    or (kind = 'chaburah' and source_chaburah_note_id is not null and source_note_id is null and source_document_id is null)
  );

-- Replaces kuntras_entries_validate_source() to add the 'chaburah' branch.
-- Everything about the 'note'/'document' branches, and the UPDATE-only
-- normalization at the top, is unchanged from 20260915210000 -- see that
-- migration's own header for why the normalization is scoped to UPDATE
-- and not INSERT.
--
-- The 'chaburah' check is deliberately NOT an ownership check: a Cloud
-- Chaburah discussion is quotable by anyone, not only its own author,
-- which is the entire point of a slice that pulls in PUBLIC content rather
-- than the reader's own. What it checks instead is that the row is still a
-- live, public discussion at the moment it is cited -- the same predicate
-- line_notes_public_read's own RLS policy uses (not hidden and not
-- is_private), checked directly here rather than relied upon via RLS
-- because this function runs SECURITY DEFINER and therefore bypasses RLS
-- entirely; the check has to be explicit or it would not exist at all.
-- Deliberately does NOT check deleted_at is null: a soft-deleted note has
-- already had its citations pointed at nothing via ON DELETE SET NULL on
-- the same trigger's UPDATE path only for a HARD delete, never a soft
-- one -- soft-deleted line_notes rows are excluded from is_private/hidden's
-- public-read policy already via other code paths, and this trigger is not
-- the place to duplicate that; it is checked at INSERT/UPDATE time only, the
-- same "provenance, not a live reference" scope every other source check in
-- this table already has.
create or replace function public.kuntras_entries_validate_source() returns trigger
  language plpgsql security definer set search_path to 'public'
as $$
declare
  v_owner uuid;
begin
  if TG_OP = 'UPDATE'
    and new.source_note_id is null
    and new.source_document_id is null
    and new.source_chaburah_note_id is null
  then
    new.kind := 'freeform';
    return new;
  end if;

  if new.source_note_id is null and new.source_document_id is null and new.source_chaburah_note_id is null then
    return new;
  end if;

  select owner_id into v_owner from public.kuntrasim where id = new.kuntras_id;
  if v_owner is null then
    raise exception 'This entry does not belong to a real kuntras.';
  end if;

  if new.source_note_id is not null and not exists (
    select 1 from public.line_notes n
    where n.id = new.source_note_id and n.author_id = v_owner
  ) then
    raise exception 'A kuntras entry can only quote a note written by the kuntras'' own owner.';
  end if;

  if new.source_document_id is not null and not exists (
    select 1 from public.note_documents d
    where d.id = new.source_document_id and d.owner_id = v_owner
  ) then
    raise exception 'A kuntras entry can only quote a document imported by the kuntras'' own owner.';
  end if;

  if new.source_chaburah_note_id is not null and not exists (
    select 1 from public.line_notes n
    where n.id = new.source_chaburah_note_id and n.is_private = false and n.hidden = false
  ) then
    raise exception 'A kuntras entry can only quote a public Cloud Chaburah discussion.';
  end if;

  return new;
end;
$$;

revoke execute on function public.kuntras_entries_validate_source() from public;
revoke execute on function public.kuntras_entries_validate_source() from anon;
revoke execute on function public.kuntras_entries_validate_source() from authenticated;

-- The trigger itself is unchanged (still fires before insert or update on
-- kuntras_entries) -- only the function body it calls changed, so it does
-- not need to be dropped and recreated.

create index if not exists kuntras_entries_source_chaburah_idx
  on public.kuntras_entries (source_chaburah_note_id)
  where source_chaburah_note_id is not null;
