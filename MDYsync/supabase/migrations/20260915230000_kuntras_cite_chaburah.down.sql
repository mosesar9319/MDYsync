-- Rollback for 20260915230000_kuntras_cite_chaburah.sql.
--
-- Any entry with kind='chaburah' would violate the narrowed CHECK constraint
-- once restored, so those rows are reset to freeform first -- the same
-- "roll back to the safest representable state" approach as widening
-- migrations elsewhere in this project take on their own down side.

update public.kuntras_entries
  set kind = 'freeform', source_chaburah_note_id = null
  where kind = 'chaburah';

drop index if exists public.kuntras_entries_source_chaburah_idx;

create or replace function public.kuntras_entries_validate_source() returns trigger
  language plpgsql security definer set search_path to 'public'
as $$
declare
  v_owner uuid;
begin
  if TG_OP = 'UPDATE' and new.source_note_id is null and new.source_document_id is null then
    new.kind := 'freeform';
    return new;
  end if;

  if new.source_note_id is null and new.source_document_id is null then
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

  return new;
end;
$$;

revoke execute on function public.kuntras_entries_validate_source() from public;
revoke execute on function public.kuntras_entries_validate_source() from anon;
revoke execute on function public.kuntras_entries_validate_source() from authenticated;

alter table public.kuntras_entries
  drop constraint if exists kuntras_entries_source_matches_kind;

alter table public.kuntras_entries
  add constraint kuntras_entries_source_matches_kind check (
    (kind = 'freeform' and source_note_id is null and source_document_id is null)
    or (kind = 'note' and source_note_id is not null and source_document_id is null)
    or (kind = 'document' and source_document_id is not null and source_note_id is null)
  );

alter table public.kuntras_entries
  drop column if exists source_chaburah_note_id;

alter table public.kuntras_entries
  drop constraint if exists kuntras_entries_kind_check;

alter table public.kuntras_entries
  add constraint kuntras_entries_kind_check
  check (kind in ('freeform', 'note', 'document'));
