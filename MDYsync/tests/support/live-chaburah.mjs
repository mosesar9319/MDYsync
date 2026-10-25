import { expect } from '@playwright/test';
import { preparePage } from './harness.mjs';
import { buildDatabase, USERS } from '../fixtures/dataset.mjs';

// Shared by the Cloud Chaburah Live specs: a seeded set of discussions, stand-ins for the
// database's write functions (the real rules are proven against a real Postgres in
// supabase/tests/live_chaburah.sql), and small helpers for driving the panel.

export const DAF = 'Chullin-89a';
export const notice = (id, kind, thread_id, extra = {}) => ({
  id, kind, thread_id, message_id: `m-${id}`, daf_ref_key: DAF, actor_display_name: 'Avi Author', preview: 'A reply', thread_preview: 'A question',
  created_at: new Date(Date.now() - 5 * 60000).toISOString(), read_at: null, ...extra,
});
export const T1 = '10000000-0000-4000-8000-000000000001'; // answered, near the start
export const T2 = '10000000-0000-4000-8000-000000000002'; // open, later on the daf, busier
export const T3 = '10000000-0000-4000-8000-000000000003'; // another daf
const minutesAgo = (m) => new Date(Date.now() - m * 60000).toISOString();

export function liveSeed() {
  const thread = (id, extra) => ({
    author_id: USERS.author.id, author_display_name: USERS.author.display_name, daf_ref_key: DAF,
    segment_ref: 'Chullin 89a.1', word_ranges: [{ ref: 'Chullin 89a.1', start: 2, end: 4 }], quoted_text: 'תנו רבנן ארבעה',
    anchor_segment: 1, anchor_word: 2, preview: 'A question', message_count: 1, status: 'open',
    answer_message_id: null, hidden: false, created_at: minutesAgo(60), last_message_at: minutesAgo(30), id, ...extra,
  });
  const message = (id, seq, thread_id, extra) => ({
    id, seq, thread_id, author_id: USERS.author.id, author_display_name: USERS.author.display_name, body: 'text',
    quoted_message_id: null, created_at: minutesAgo(40), edited_at: null, deleted_at: null, hidden: false, ...extra,
  });
  return {
    live_settings: [{ id: true, audience: 'everyone' }],
    live_threads: [
      thread(T1, { preview: 'Why does the Gemara start here?', message_count: 3, status: 'answered', answer_message_id: 'm1b', last_message_at: minutesAgo(50), anchor_segment: 1, anchor_word: 2 }),
      thread(T2, {
        preview: 'Can anyone explain the distinction?', message_count: 8, quoted_text: 'אמר רב יהודה אמר רב',
        segment_ref: 'Chullin 89a.2', word_ranges: [{ ref: 'Chullin 89a.2', start: 0, end: 3 }],
        anchor_segment: 2, anchor_word: 0, last_message_at: minutesAgo(3),
      }),
      thread(T3, { daf_ref_key: 'Chullin-90a', preview: 'Elsewhere' }),
    ],
    live_messages: [
      message('m1a', 1, T1, { body: 'Why does the Gemara start here?' }),
      message('m1b', 2, T1, { body: 'Because of the Mishnah before it.', author_id: USERS.admin.id, author_display_name: USERS.admin.display_name }),
      message('m1c', 3, T1, { body: 'Thank you!', quoted_message_id: 'm1b' }),
      message('m2a', 1, T2, { body: 'Can anyone explain the distinction?' }),
      message('m3a', 1, T3, { body: 'Elsewhere' }),
    ],
    live_thread_follows: [], live_read_state: [],
  };
}

// The write functions, as the page's Supabase stub will run them.
export function installFakeServer() {
  const control = window.__DAFSYNC_TEST_CONTROL__;
  const me = () => window.__DAFSYNC_TEST_SESSION__?.user;
  const names = { '11111111-1111-4111-8111-111111111111': 'Reader One', '44444444-4444-4444-8444-444444444444': 'Admin Four' };
  const fail = () => (window.__LIVE_FAIL__ ? { data: null, error: { message: window.__LIVE_FAIL__ } } : null);
  const emit = (topic, event, payload) => window.__DAFSYNC_TEST_EMIT__(topic, event, payload);
  const nextSeq = (db) => db.live_messages.reduce((m, r) => Math.max(m, r.seq), 0) + 1;
  const addMessage = (db, thread, body, quoted) => {
    const row = {
      id: `msg-${Math.random().toString(36).slice(2)}`, seq: db.live_messages.filter((m) => m.thread_id === thread.id).length + 1,
      thread_id: thread.id, author_id: me().id, author_display_name: names[me().id] || 'Learner', body,
      quoted_message_id: quoted || null, created_at: new Date().toISOString(), edited_at: null, deleted_at: null, hidden: false,
    };
    db.live_messages.push(row);
    thread.message_count += 1;
    thread.last_message_at = row.created_at;
    return row;
  };
  control.rpc = {
    live_start_thread(p, db) {
      const failure = fail(); if (failure) return failure;
      const thread = {
        id: `thread-${Math.random().toString(36).slice(2)}`, author_id: me().id, author_display_name: names[me().id] || 'Learner',
        daf_ref_key: p.p_daf_ref_key, segment_ref: p.p_segment_ref, word_ranges: p.p_word_ranges, quoted_text: p.p_quoted_text,
        anchor_segment: Number(/\.(\d+)$/.exec(p.p_segment_ref)?.[1] || 0), anchor_word: p.p_word_ranges[0].start,
        preview: p.p_body.trim().slice(0, 240), message_count: 0, status: 'open', answer_message_id: null, hidden: false,
        created_at: new Date().toISOString(), last_message_at: new Date().toISOString(),
      };
      db.live_threads.push(thread);
      addMessage(db, thread, p.p_body.trim(), null);
      db.live_thread_follows.push({ user_id: me().id, thread_id: thread.id });
      emit(`live:daf:${thread.daf_ref_key}`, 'thread', thread);
      return { data: thread, error: null };
    },
    live_post_message(p, db) {
      const failure = fail(); if (failure) return failure;
      const thread = db.live_threads.find((t) => t.id === p.p_thread_id);
      if (!thread) return { data: null, error: { message: 'live_thread_missing' } };
      const row = addMessage(db, thread, p.p_body.trim(), p.p_quoted_message_id);
      emit(`live:thread:${thread.id}`, 'message', row);
      emit(`live:daf:${thread.daf_ref_key}`, 'thread_updated', thread);
      return { data: row, error: null };
    },
    live_edit_message(p, db) {
      const failure = fail(); if (failure) return failure;
      const row = db.live_messages.find((m) => m.id === p.p_message_id);
      Object.assign(row, { body: p.p_body.trim(), edited_at: new Date().toISOString() });
      emit(`live:thread:${row.thread_id}`, 'message_updated', row);
      return { data: row, error: null };
    },
    live_delete_message(p, db) {
      const row = db.live_messages.find((m) => m.id === p.p_message_id);
      Object.assign(row, { body: '', deleted_at: new Date().toISOString() });
      emit(`live:thread:${row.thread_id}`, 'message_updated', row);
      return { data: row, error: null };
    },
    live_set_answer(p, db) {
      const thread = db.live_threads.find((t) => t.id === p.p_thread_id);
      Object.assign(thread, { answer_message_id: p.p_message_id, status: p.p_message_id ? 'answered' : 'open' });
      emit(`live:daf:${thread.daf_ref_key}`, 'thread_updated', thread);
      return { data: thread, error: null };
    },
    live_report(p, db) { (db.live_reports = db.live_reports || []).push(p); return { data: null, error: null }; },
    live_moderate(p, db) {
      const thread = db.live_threads.find((t) => t.id === p.p_thread_id);
      if (p.p_message_id) Object.assign(db.live_messages.find((m) => m.id === p.p_message_id), { body: '', hidden: true });
      else { thread.hidden = true; emit(`live:daf:${thread.daf_ref_key}`, 'thread_removed', { id: thread.id }); }
      return { data: null, error: null };
    },
    live_unread_counts() {
      if (window.__LIVE_UNREAD_MISSING__) return { data: null, error: { message: 'Could not find the function public.live_unread_counts' } };
      return { data: window.__LIVE_UNREAD__ || [], error: null };
    },
    // ---- notifications (the real rules are in supabase/tests/live_chaburah_notifications.sql) ----
    live_my_notification_state(p, db) {
      if (window.__LIVE_NOTIFY_MISSING__) return { data: null, error: { message: 'Could not find the function public.live_my_notification_state' } };
      const defaults = {
        all_off: false, snooze_until: null, in_app_enabled: true, push_enabled: false, lvl_mine: true, lvl_daf: false,
        lvl_everywhere: false, lvl_while_using: false, everywhere_mode: 'digest', timezone: 'UTC', batch_minutes: 5,
        digest_enabled: false, digest_hour: 20, quiet_enabled: false, quiet_start: 22, quiet_end: 7,
      };
      const daf = (db.live_daf_prefs || []).find((d) => d.daf_ref_key === p.p_daf_ref_key) || { following: false, muted: false };
      return { data: {
        prefs: { ...defaults, ...(db.live_notif_prefs || {}) },
        daf: { following: daf.following, muted: daf.muted },
        muted_thread_ids: (db.live_thread_mutes || []).map((m) => m.thread_id),
        devices: (db.push_subscriptions || []).map((d) => ({ id: d.id, label: d.label, created_at: d.created_at, host: 'push.example' })),
        unread: (db.live_notifications || []).filter((n) => !n.read_at).length,
        daf_follows: (db.live_daf_prefs || []).filter((d) => d.following).map((d) => d.daf_ref_key),
      }, error: null };
    },
    live_set_notification_prefs(p, db) {
      const failure = fail(); if (failure) return failure;
      db.live_notif_prefs = { ...(db.live_notif_prefs || {}), ...p.p };
      return { data: null, error: null };
    },
    live_set_current_daf(p, db) { db.live_current_daf = p.p_daf_ref_key; return { data: null, error: null }; },
    live_set_daf_pref(p, db) {
      db.live_daf_prefs = db.live_daf_prefs || [];
      let row = db.live_daf_prefs.find((d) => d.daf_ref_key === p.p_daf_ref_key);
      if (!row) { row = { daf_ref_key: p.p_daf_ref_key, following: false, muted: false }; db.live_daf_prefs.push(row); }
      if (p.p_following !== null) row.following = p.p_following;
      if (p.p_muted !== null) row.muted = p.p_muted;
      return { data: null, error: null };
    },
    live_set_thread_muted(p, db) {
      db.live_thread_mutes = (db.live_thread_mutes || []).filter((m) => m.thread_id !== p.p_thread_id);
      if (p.p_muted) db.live_thread_mutes.push({ thread_id: p.p_thread_id });
      return { data: null, error: null };
    },
    live_list_notifications(p, db) {
      if (window.__LIVE_NOTIFY_MISSING__) return { data: null, error: { message: 'Could not find the function' } };
      return { data: (db.live_notifications || []).slice().sort((a, b) => (a.created_at < b.created_at ? 1 : -1)), error: null };
    },
    live_mark_notifications_read(p, db) {
      const now = new Date().toISOString();
      for (const n of db.live_notifications || []) if (!n.read_at && (p.p_all || n.thread_id === p.p_thread_id)) n.read_at = now;
      return { data: null, error: null };
    },
    live_save_push_subscription(p, db) {
      db.push_subscriptions = (db.push_subscriptions || []).filter((d) => d.endpoint !== p.p_endpoint);
      db.push_subscriptions.push({ id: `dev-${db.push_subscriptions.length + 1}`, endpoint: p.p_endpoint, label: p.p_label, created_at: new Date().toISOString() });
      db.live_notif_prefs = { ...(db.live_notif_prefs || {}), push_enabled: true };
      return { data: null, error: null };
    },
    live_remove_push_subscription(p, db) {
      db.push_subscriptions = (db.push_subscriptions || []).filter((d) => d.id !== p.p_device_id && d.endpoint !== p.p_endpoint);
      return { data: null, error: null };
    },
    live_set_audience(p, db) { db.live_settings[0].audience = p.p_audience; return { data: null, error: null }; },
  };
}

export async function open(page, { user = USERS.ordinary, audience = 'everyone', url = '/browse/?ref=Chullin%2089a', control = {}, mutate, init, initArg } = {}) {
  const db = buildDatabase();
  Object.assign(db, liveSeed());
  db.live_settings[0].audience = audience;
  if (mutate) mutate(db);
  await preparePage(page, { db, user, control });
  await page.addInitScript(installFakeServer);
  if (init) await page.addInitScript(init, initArg);
  await page.goto(url);
  await expect.poll(() => page.evaluate(() => Boolean(window.DafLive))).toBe(true);
  return db;
}
export const openPanel = async (page) => {
  await page.locator('.live-toggle').click();
  await expect(page.locator('#livePanel')).toBeVisible();
};
export const cards = (page) => page.locator('.live-card');
export const callsTo = (page, name) => page.evaluate((n) => (window.__DAFSYNC_TEST_CALLS__ || []).filter((c) => c.rpc === n).map((c) => c.params), name);
export const emit = (page, topic, event, payload) => page.evaluate(([t, e, p]) => window.__DAFSYNC_TEST_EMIT__(t, e, p), [topic, event, payload]);

