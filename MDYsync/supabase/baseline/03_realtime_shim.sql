-- A minimal local stand-in for Supabase's platform-managed `realtime` schema, applied
-- only when a real one isn't already present. Exists so the live-chat migration's
-- broadcast triggers and realtime.messages policies can be proven locally:
--   * realtime.send() stores what would be broadcast, so tests can assert topic,
--     event and payload;
--   * realtime.messages carries RLS like the real one, with realtime.topic() read from
--     a setting the test sets.
-- It does not model channels, delivery or presence.
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'realtime') then
    return;
  end if;
  create schema realtime;
  create table realtime.messages (
    id uuid primary key default gen_random_uuid(),
    topic text not null,
    extension text not null,
    event text,
    payload jsonb,
    private boolean default false,
    inserted_at timestamptz not null default now()
  );
  alter table realtime.messages enable row level security;
  create function realtime.topic() returns text language sql stable as
    $f$ select nullif(current_setting('realtime.topic', true), '') $f$;
  create function realtime.send(payload jsonb, event text, topic text, private boolean default true)
  returns void language plpgsql security definer as $f$
  begin
    insert into realtime.messages (topic, extension, event, payload, private)
    values (topic, 'broadcast', event, payload, private);
  end $f$;
  grant usage on schema realtime to anon, authenticated;
  grant select, insert on realtime.messages to authenticated;
  grant execute on function realtime.topic() to anon, authenticated;
end $$;
