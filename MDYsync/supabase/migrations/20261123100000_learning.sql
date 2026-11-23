-- The Daf Yomi tracker: what a signed-in learner has heard of each shiur.
--
-- One row per learner per shiur (learning-tracker.js writes it while a shiur
-- plays), or per daf marked as learned by hand (manual). The calendar reads a
-- learner's rows and works out each daf from them (shared/daf-progress.mjs).
--
--   shiur_key   which shiur: "<maggid>:<language>:<variant>:<tractate>:<daf>",
--               or "manual:<tractate>:<daf>" for a daf marked by hand
--   tractate, daf   the daf the shiur is on (the day it belongs to)
--   ranges      the stretches of the recording heard, in seconds: [[from, to], ...]
--   heard       the words of the daf heard, per amud: { "Arakhin 6a": [[from, to], ...] }
--   reads       the stretch of each amud the shiur itself reads: { "Arakhin 6a": [from, to] }
--   words       how many words each paragraph of those amudim has: { "Arakhin 6a": [17, 12, ...] }
--   finished    heard through the last line the maggid reads
--
-- A learner sees and changes only their own rows.

create table if not exists public.learning (
  user_id uuid not null references auth.users (id) on delete cascade,
  shiur_key text not null,
  tractate text not null,
  daf integer not null,
  maggid text not null default 'default',
  variant text not null default 'regular',
  language text not null default 'en',
  position_seconds numeric not null default 0,
  duration_seconds numeric,
  ranges jsonb not null default '[]'::jsonb,
  heard jsonb not null default '{}'::jsonb,
  reads jsonb not null default '{}'::jsonb,
  words jsonb not null default '{}'::jsonb,
  finished boolean not null default false,
  finished_at timestamptz,
  manual boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, shiur_key)
);

create index if not exists learning_user_daf on public.learning (user_id, tractate, daf);

alter table public.learning enable row level security;

drop policy if exists learning_owner_all on public.learning;
create policy learning_owner_all on public.learning
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all on public.learning from anon;
grant select, insert, update, delete on public.learning to authenticated;
