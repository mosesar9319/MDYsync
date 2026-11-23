-- The Daf Yomi calendar: a learner's own note on a day.
--
-- One row per learner per day (calendar/day-notes.js). A learner sees and
-- changes only their own rows; an emptied note is deleted.

create table if not exists public.calendar_notes (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  body text not null check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);

alter table public.calendar_notes enable row level security;

drop policy if exists calendar_notes_owner_all on public.calendar_notes;
create policy calendar_notes_owner_all on public.calendar_notes
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all on public.calendar_notes from anon;
grant select, insert, update, delete on public.calendar_notes to authenticated;
