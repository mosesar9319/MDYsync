-- Kuntras Builder, slice 2: quoting your own notes and documents.
--
-- NOT YET APPLIED. Rollback:
--   supabase/migrations/20260915210000_kuntras_cite_notes_documents.down.sql
-- Depends on 20260915200000_kuntras_builder.sql.
--
-- Widens kuntras_entries.kind from 'freeform' alone to also accept 'note'
-- and 'document' -- the same drop-and-recreate-the-check-constraint move
-- 20260915190000 used to widen note_documents.source_kind for .docx/PDF,
-- for the same reason: every existing row's value ('freeform') already
-- satisfies the wider constraint, so this cannot fail on real data.
--
-- The excerpt is COPIED into `body` at the moment it is chosen, exactly like
-- line_notes.source_document_id already works (see 20260915170000's own
-- header) -- these two columns are PROVENANCE ONLY. Editing or deleting the
-- source note or document afterwards never rewrites an entry already built
-- from it; a kuntras a reader is assembling must not change out from under
-- them because something it quoted was edited or removed elsewhere.

alter table public.kuntras_entries
  drop constraint if exists kuntras_entries_kind_check;

alter table public.kuntras_entries
  add constraint kuntras_entries_kind_check
  check (kind in ('freeform', 'note', 'document'));

alter table public.kuntras_entries
  add column if not exists source_note_id uuid
    references public.line_notes(id) on delete set null;

alter table public.kuntras_entries
  add column if not exists source_document_id uuid
    references public.note_documents(id) on delete set null;

-- ON DELETE SET NULL, not CASCADE, on both -- the same reasoning
-- 20260915170000 already gave for line_notes.source_document_id: an entry
-- is the reader's own assembled writing, and it must outlive whatever it
-- was quoted from. Losing the provenance on a hard delete is correct; losing
-- the ENTRY would not be.

-- An entry cites at most ONE source, and which column may be set follows
-- directly from its kind -- a 'note' entry that also carried a
-- source_document_id (or vice versa) would be a citation to two different
-- places at once, which is not a thing a single copied excerpt can be.
alter table public.kuntras_entries
  add constraint kuntras_entries_source_matches_kind check (
    (kind = 'freeform' and source_note_id is null and source_document_id is null)
    or (kind = 'note' and source_note_id is not null and source_document_id is null)
    or (kind = 'document' and source_document_id is not null and source_note_id is null)
  );

comment on column public.kuntras_entries.source_note_id is
  'The line_notes row this entry was quoted from, when it was. Provenance only -- the excerpt itself lives in body.';
comment on column public.kuntras_entries.source_document_id is
  'The note_documents row this entry was quoted from, when it was. Provenance only -- the excerpt itself lives in body. Never exposes the document: note_documents has no read path for anyone but its owner.';

-- An entry may only cite a note or document belonging to the SAME OWNER as
-- the kuntras it is in.
--
-- Without this, nothing stops a client writing any line_notes or
-- note_documents id at all into these columns -- including someone else's --
-- rendering that kuntras an attribution to content its owner never wrote and,
-- for a private note or any document, cannot even see. RLS cannot express
-- this: kuntras_entries' own insert/update policy governs that this row's
-- kuntras_id belongs to the caller, and it has no way to also constrain what
-- a DIFFERENT table's row, referenced by id, belongs to. A trigger is where
-- this schema already puts exactly this kind of cross-table check --
-- line_notes_validate_source_document does the identical job one hop over.
--
-- kuntras_entries carries no owner_id of its own (see 20260915200000's own
-- header: ownership is always derived through kuntras_id), so the owner to
-- check against is read from kuntrasim first.
--
-- SECURITY DEFINER for the same reason as line_notes_validate_source_document:
-- the question is "does this note/document belong to this kuntras's owner,"
-- not the invoker's RLS-filtered view of it -- a check that fails because a
-- row was invisible rather than because it belonged to someone else breaks
-- the moment a policy changes.
create or replace function public.kuntras_entries_validate_source() returns trigger
  language plpgsql security definer set search_path to 'public'
as $$
declare
  v_owner uuid;
begin
  -- Normalizes kind BACK to 'freeform' the moment an UPDATE leaves neither
  -- source column set, rather than merely allowing that state through. This
  -- matters for a path no client ever drives directly: ON DELETE SET NULL on
  -- source_note_id/source_document_id fires this same BEFORE UPDATE trigger
  -- when the cited note or document is hard-deleted, and it only nulls the
  -- one column the foreign key points at -- kind is left exactly as it was.
  -- Without this, a 'note' entry whose note was deleted would end up
  -- kind='note' with source_note_id null, which the CHECK constraint below
  -- (kuntras_entries_source_matches_kind) correctly refuses -- turning
  -- "the reader deleted an old note" into a hard failure of the DELETE
  -- itself, exactly the outcome ON DELETE SET NULL exists to avoid. An
  -- ordinary client update that clears both source columns on purpose gets
  -- the same, correct, result: an entry with no citation is a freeform one.
  --
  -- Scoped to UPDATE only, deliberately NOT insert. A fresh INSERT of
  -- kind='note' with no source_note_id is not a citation losing its source
  -- -- it never had one -- and is a genuine client bug that the CHECK
  -- constraint below should refuse loudly, not one this trigger quietly
  -- reinterprets as "must have meant freeform."
  if TG_OP = 'UPDATE' and new.source_note_id is null and new.source_document_id is null then
    new.kind := 'freeform';
    return new;
  end if;

  if new.source_note_id is null and new.source_document_id is null then
    return new;
  end if;

  select owner_id into v_owner from public.kuntrasim where id = new.kuntras_id;
  if v_owner is null then
    -- The kuntras_id foreign key (inherited from 20260915200000) already
    -- guarantees a matching row exists; this is only reachable if that
    -- constraint were somehow bypassed, and refusing is the right response
    -- either way -- there is no owner to check a citation against.
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

-- BEFORE UPDATE too: an update is how an entry would be retargeted at a
-- different note/document its own kuntras's owner does not control.
drop trigger if exists kuntras_entries_validate_source_trg on public.kuntras_entries;
create trigger kuntras_entries_validate_source_trg
  before insert or update on public.kuntras_entries
  for each row execute function public.kuntras_entries_validate_source();

-- Partial: almost every entry cites nothing, and the only question this
-- column is ever asked is a reverse lookup -- "which kuntras entries came
-- from this note/document" -- the same shape and the same reasoning as
-- line_notes_source_document_idx.
create index if not exists kuntras_entries_source_note_idx
  on public.kuntras_entries (source_note_id)
  where source_note_id is not null;

create index if not exists kuntras_entries_source_document_idx
  on public.kuntras_entries (source_document_id)
  where source_document_id is not null;
