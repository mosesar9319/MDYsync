'use strict';

// Cloud Chaburah Live -- everything that talks to Supabase: reading threads and
// messages, the write functions (the database checks who may post and how often; see
// supabase/migrations/20261025130000_live_chaburah_phase1.sql), and the Realtime
// channels that deliver other people's messages without a reload.
//
// Writes are RPC calls, never direct inserts: the tables accept no client writes.
// Failures are thrown as the database raised them ("live_rate_limited", ...);
// LiveChaburahCore.errorText turns them into words.
//
// Realtime: a private Broadcast channel per daf ("live:daf:<key>", thread summaries) and
// per conversation ("live:thread:<id>", messages), fed by database triggers after a
// message is saved -- a client can receive but never publish there. Presence on the same
// channels gives the "N learning this daf" and "N in this conversation" counts, keyed by a
// random id per tab rather than by user, so other readers cannot tell who is here. When a
// channel cannot be joined (signed out, or the connection fails) the page falls back to
// fetching what it missed every few seconds.

(function () {
  const core = window.LiveChaburahCore;
  const THREAD_COLUMNS = [
    'id', 'author_id', 'author_display_name', 'daf_ref_key', 'segment_ref', 'word_ranges',
    'quoted_text', 'anchor_segment', 'anchor_word', 'preview', 'message_count', 'status',
    'answer_message_id', 'created_at', 'last_message_at',
  ].join(', ');
  const MESSAGE_COLUMNS = [
    'id', 'seq', 'thread_id', 'author_id', 'author_display_name', 'body', 'quoted_message_id',
    'created_at', 'edited_at', 'deleted_at', 'hidden',
  ].join(', ');
  const PAGE = 50;
  const POLL_MS = 6000;

  function client() {
    const auth = window.DafSyncAuth;
    if (!auth || !auth.client) throw new Error('Sign-in library is not ready.');
    return auth.client;
  }
  const me = () => window.DafSyncAuth?.getUser?.() || null;

  function unwrap({ data, error }) {
    if (error) throw error;
    return Array.isArray(data) ? data[0] : data;
  }

  // 'admins' (before launch), 'everyone', or null when it could not be read.
  async function fetchAudience() {
    try {
      const { data, error } = await client().from('live_settings').select('audience').maybeSingle();
      if (error) return null;
      return data?.audience || null;
    } catch {
      return null;
    }
  }

  async function fetchThreads(dafKey) {
    const { data, error } = await client().from('live_threads').select(THREAD_COLUMNS)
      .eq('daf_ref_key', dafKey).order('last_message_at', { ascending: false }).limit(200);
    if (error) throw error;
    return data || [];
  }

  async function fetchThread(id) {
    const { data, error } = await client().from('live_threads').select(THREAD_COLUMNS).eq('id', id).maybeSingle();
    if (error) throw error;
    return data;
  }

  // The newest `limit` messages (or the `limit` before `beforeSeq`), oldest first.
  async function fetchMessages(threadId, { beforeSeq = null, limit = PAGE } = {}) {
    let query = client().from('live_messages').select(MESSAGE_COLUMNS)
      .eq('thread_id', threadId).order('seq', { ascending: false }).limit(limit + 1);
    if (beforeSeq != null) query = query.lt('seq', beforeSeq);
    const { data, error } = await query;
    if (error) throw error;
    const rows = data || [];
    return { messages: rows.slice(0, limit).reverse(), hasMore: rows.length > limit };
  }

  // What arrived while the page was not listening.
  async function fetchMessagesAfter(threadId, afterSeq) {
    const { data, error } = await client().from('live_messages').select(MESSAGE_COLUMNS)
      .eq('thread_id', threadId).gt('seq', afterSeq).order('seq', { ascending: true }).limit(200);
    if (error) throw error;
    return data || [];
  }

  const startThread = async ({ dafKey, segmentRef, runs, quotedText, body }) => unwrap(await client().rpc('live_start_thread', {
    p_daf_ref_key: dafKey, p_segment_ref: segmentRef, p_word_ranges: runs, p_quoted_text: quotedText, p_body: body,
  }));
  const postMessage = async (threadId, body, quotedMessageId = null) => unwrap(await client().rpc('live_post_message', {
    p_thread_id: threadId, p_body: body, p_quoted_message_id: quotedMessageId,
  }));
  const editMessage = async (messageId, body) => unwrap(await client().rpc('live_edit_message', { p_message_id: messageId, p_body: body }));
  const deleteMessage = async (messageId) => unwrap(await client().rpc('live_delete_message', { p_message_id: messageId }));
  const setAnswer = async (threadId, messageId) => unwrap(await client().rpc('live_set_answer', { p_thread_id: threadId, p_message_id: messageId }));
  const moderate = async (threadId, messageId, hidden) => unwrap(await client().rpc('live_moderate', { p_thread_id: threadId, p_message_id: messageId, p_hidden: hidden }));
  const setAudience = async (audience) => unwrap(await client().rpc('live_set_audience', { p_audience: audience }));
  const report = async (threadId, messageId, reason) => unwrap(await client().rpc('live_report', { p_thread_id: threadId, p_message_id: messageId, p_reason: reason || '' }));

  async function fetchFollows(threadIds) {
    const user = me();
    if (!user || !threadIds.length) return new Set();
    const { data, error } = await client().from('live_thread_follows').select('thread_id')
      .eq('user_id', user.id).in('thread_id', threadIds);
    if (error) throw error;
    return new Set((data || []).map((row) => row.thread_id));
  }
  async function follow(threadId) {
    const user = me();
    const { error } = await client().from('live_thread_follows').upsert(
      { user_id: user.id, thread_id: threadId }, { onConflict: 'user_id,thread_id', ignoreDuplicates: true });
    if (error) throw error;
  }
  async function unfollow(threadId) {
    const user = me();
    const { error } = await client().from('live_thread_follows').delete().eq('user_id', user.id).eq('thread_id', threadId);
    if (error) throw error;
  }

  async function fetchReadStates(threadIds) {
    const user = me();
    if (!user || !threadIds.length) return new Map();
    const { data, error } = await client().from('live_read_state').select('thread_id, last_read_seq, updated_at')
      .eq('user_id', user.id).in('thread_id', threadIds);
    if (error) throw error;
    return new Map((data || []).map((row) => [row.thread_id, row]));
  }
  async function markRead(threadId, seq) {
    const user = me();
    if (!user) return;
    const { error } = await client().from('live_read_state').upsert(
      { user_id: user.id, thread_id: threadId, last_read_seq: seq }, { onConflict: 'user_id,thread_id' });
    if (error) throw error;
  }

  // ---- Realtime -----------------------------------------------------------------------
  function randomKey() {
    return (window.crypto?.randomUUID?.() || `tab-${Math.random().toString(36).slice(2)}${Date.now()}`);
  }

  // Joins `topic`, calls handlers.events[eventName](payload) for each broadcast, reports
  // presence counts and connection status. Returns { close() }. Signed-out readers (who
  // cannot join a private channel) get `onStatus('offline')` straight away.
  function join(topic, handlers) {
    if (!me()) {
      handlers.onStatus?.('offline');
      return { close() {} };
    }
    let channel = null;
    let closed = false;
    (async () => {
      try { await client().realtime.setAuth(); } catch { /* the client reads the session itself */ }
      if (closed) return;
      channel = client().channel(topic, { config: { private: true, presence: { key: randomKey() } } });
      for (const [event, handler] of Object.entries(handlers.events || {})) {
        channel.on('broadcast', { event }, ({ payload }) => handler(payload));
      }
      channel.on('presence', { event: 'sync' }, () => {
        handlers.onPresence?.(core.presenceCount(channel.presenceState()));
      });
      channel.subscribe(async (status) => {
        if (closed) return;
        if (status === 'SUBSCRIBED') {
          try { await channel.track({ here: true }); } catch { /* presence is a nicety */ }
          handlers.onStatus?.('live');
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          handlers.onStatus?.('offline');
        }
      });
    })();
    return {
      close() {
        closed = true;
        if (channel) client().removeChannel(channel);
      },
    };
  }

  const joinDaf = (dafKey, handlers) => join(`live:daf:${dafKey}`, handlers);
  const joinThread = (threadId, handlers) => join(`live:thread:${threadId}`, handlers);

  // Calls `tick` every few seconds until stopped; the page's fallback when a channel is
  // not live. Skips a tick while the tab is hidden.
  function poll(tick) {
    const id = setInterval(() => {
      if (document.hidden) return;
      Promise.resolve(tick()).catch(() => {});
    }, POLL_MS);
    return { stop() { clearInterval(id); } };
  }

  window.DafSyncLive = window.DafSyncLive || {};
  window.DafSyncLive.data = {
    fetchAudience, fetchThreads, fetchThread, fetchMessages, fetchMessagesAfter,
    startThread, postMessage, editMessage, deleteMessage, setAnswer, moderate, setAudience, report,
    fetchFollows, follow, unfollow, fetchReadStates, markRead, joinDaf, joinThread, poll,
    PAGE,
  };
})();
