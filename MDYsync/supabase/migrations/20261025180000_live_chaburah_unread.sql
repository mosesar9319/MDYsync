-- Cloud Chaburah Live, phase 2: how many new messages a reader has waiting in the
-- discussions they follow -- per thread on one daf, or across every daf.
--
-- One function, written for the caller only (auth.uid()), so a reader can never ask about
-- someone else's reading position. A message counts as new when it is after the reader's
-- recorded position in that thread (live_read_state; none recorded = from the start), was
-- written by someone else, and is still there (not deleted, not removed by a moderator).
-- Threads with nothing new are simply absent from the result.

create or replace function public.live_unread_counts(p_daf_ref_key text default null)
returns table (thread_id uuid, daf_ref_key text, unread bigint)
language sql stable security definer set search_path = public as $$
  select t.id, t.daf_ref_key, count(m.id)
    from public.live_threads t
    join public.live_thread_follows f on f.thread_id = t.id and f.user_id = auth.uid()
    left join public.live_read_state r on r.thread_id = t.id and r.user_id = auth.uid()
    join public.live_messages m
      on m.thread_id = t.id
     and m.seq > coalesce(r.last_read_seq, 0)
     and m.author_id <> auth.uid()
     and m.deleted_at is null
     and not m.hidden
   where auth.uid() is not null
     and public.live_access()
     and not t.hidden
     and (p_daf_ref_key is null or t.daf_ref_key = p_daf_ref_key)
   group by t.id, t.daf_ref_key
   limit 500;
$$;

revoke all on function public.live_unread_counts(text) from public, anon, authenticated;
grant execute on function public.live_unread_counts(text) to authenticated;
