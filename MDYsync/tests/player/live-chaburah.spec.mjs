import { test, expect } from '@playwright/test';
import { preparePage } from '../support/harness.mjs';
import { buildDatabase, USERS } from '../fixtures/dataset.mjs';

// Cloud Chaburah Live on the Interactive Daf page: the panel of phrase-anchored
// conversations beside the daf. The database and Realtime are stand-ins here (the real
// rules -- who may post, how often, who may receive -- are proven against a real Postgres
// in supabase/tests/live_chaburah.sql): the stub's live_* write functions below do what the
// real ones do closely enough for the page to be exercised end to end, and a broadcast is
// pushed into the page's channels the way the database trigger would.

const DAF = 'Chullin-89a';
const T1 = '10000000-0000-4000-8000-000000000001'; // answered, near the start
const T2 = '10000000-0000-4000-8000-000000000002'; // open, later on the daf, busier
const T3 = '10000000-0000-4000-8000-000000000003'; // another daf
const minutesAgo = (m) => new Date(Date.now() - m * 60000).toISOString();

function liveSeed() {
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
function installFakeServer() {
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
    live_set_audience(p, db) { db.live_settings[0].audience = p.p_audience; return { data: null, error: null }; },
  };
}

async function open(page, { user = USERS.ordinary, audience = 'everyone', url = '/browse/?ref=Chullin%2089a', control = {}, mutate } = {}) {
  const db = buildDatabase();
  Object.assign(db, liveSeed());
  db.live_settings[0].audience = audience;
  if (mutate) mutate(db);
  await preparePage(page, { db, user, control });
  await page.addInitScript(installFakeServer);
  await page.goto(url);
  await expect.poll(() => page.evaluate(() => Boolean(window.DafLive))).toBe(true);
  return db;
}
const openPanel = async (page) => {
  await page.locator('.live-toggle').click();
  await expect(page.locator('#livePanel')).toBeVisible();
};
const cards = (page) => page.locator('.live-card');
const callsTo = (page, name) => page.evaluate((n) => (window.__DAFSYNC_TEST_CALLS__ || []).filter((c) => c.rpc === n).map((c) => c.params), name);
const emit = (page, topic, event, payload) => page.evaluate(([t, e, p]) => window.__DAFSYNC_TEST_EMIT__(t, e, p), [topic, event, payload]);

test.describe('Cloud Chaburah Live — who sees it', () => {
  test('before launch only an admin is offered it', async ({ page }) => {
    await open(page, { user: USERS.ordinary, audience: 'admins' });
    await page.waitForTimeout(400);
    await expect(page.locator('.live-toggle')).toHaveCount(0);
    expect(await page.evaluate(() => window.DafLive.available())).toBe(false);
  });

  test('an admin is offered it before launch, and can open it to everyone', async ({ page }) => {
    const db = await open(page, { user: USERS.admin, audience: 'admins' });
    await openPanel(page);
    await expect(page.locator('.live-admin-bar')).toContainText('admins only');
    await page.getByRole('button', { name: 'Open to everyone' }).click();
    await expect(page.locator('.live-admin-bar')).toContainText('everyone');
    expect(await page.evaluate(() => window.__DAFSYNC_TEST_DB__.live_settings[0].audience)).toBe('everyone');
    expect(db.live_settings[0].audience).toBe('admins'); // this copy is the test's own; the page has its own
  });

  test('after launch a signed-out reader can read but not post', async ({ page }) => {
    await open(page, { user: null });
    await openPanel(page);
    await expect(cards(page)).toHaveCount(2);
    await cards(page).first().click();
    await expect(page.locator('.live-input')).toBeDisabled();
    await expect(page.locator('.live-input')).toHaveAttribute('placeholder', /Sign in/);
  });
});

test.describe('Cloud Chaburah Live — the list of discussions', () => {
  test('shows this daf\'s discussions as cards, and none from another daf', async ({ page }) => {
    await open(page);
    await expect(page.locator('.live-toggle-count')).toHaveText('2');
    await openPanel(page);
    await expect(page.locator('.live-title')).toHaveText('Chullin 89a');
    await expect(cards(page)).toHaveCount(2);
    const first = page.locator('.live-card', { hasText: 'Why does the Gemara start here?' });
    await expect(first.locator('.live-card-quote')).toHaveText('תנו רבנן ארבעה');
    await expect(first).toContainText('2 replies');
    await expect(first.locator('.live-badge-answered')).toHaveText('Answered');
    await expect(page.locator('.live-card', { hasText: 'Can anyone explain the distinction?' })).toContainText('7 replies');
    await expect(page.locator('.live-card', { hasText: 'Elsewhere' })).toHaveCount(0);
  });

  test('"near my place" is the default and follows where the reader is on the daf', async ({ page }) => {
    await open(page);
    await page.evaluate(() => { state.textSelection = { anchorIndex: -1, runs: [{ ref: 'Chullin 89a.2', start: 1, end: 2 }] }; });
    await openPanel(page);
    await expect(page.locator('.live-sort')).toHaveValue('near');
    await expect(cards(page).first()).toContainText('Can anyone explain the distinction?');
    await page.evaluate(() => { state.textSelection = { anchorIndex: -1, runs: [{ ref: 'Chullin 89a.1', start: 2, end: 3 }] }; });
    await page.locator('.live-sort').selectOption('latest');
    await page.locator('.live-sort').selectOption('near');
    await expect(cards(page).first()).toContainText('Why does the Gemara start here?');
  });

  test('latest, unanswered and all discussions', async ({ page }) => {
    await open(page);
    await openPanel(page);
    await page.locator('.live-sort').selectOption('latest');
    await expect(cards(page).first()).toContainText('Can anyone explain the distinction?');
    await page.locator('.live-sort').selectOption('unanswered');
    await expect(cards(page)).toHaveCount(1);
    await expect(cards(page).first()).toContainText('Can anyone explain the distinction?');
    await page.locator('.live-sort').selectOption('all');
    await expect(cards(page)).toHaveCount(2);
    await expect(cards(page).first()).toContainText('Why does the Gemara start here?');
  });

  test('a daf with no discussions invites the first question', async ({ page }) => {
    await open(page, { mutate: (db) => { db.live_threads = []; db.live_messages = []; } });
    await openPanel(page);
    await expect(page.locator('.live-empty')).toContainText('No discussions on this daf yet');
    await expect(page.locator('.live-empty')).toContainText('Start live discussion');
  });

  test('how many people are learning this daf now', async ({ page }) => {
    await open(page);
    await openPanel(page);
    await page.evaluate((daf) => window.__DAFSYNC_TEST_PRESENCE__(`live:daf:${daf}`, { a: [{ presence_ref: '1' }], b: [{ presence_ref: '2' }], c: [{ presence_ref: '3' }] }), DAF);
    await expect(page.locator('.live-presence')).toHaveText('3 people learning this daf now');
  });

  test('a new thread, a changed thread and a removed thread arrive without a reload', async ({ page }) => {
    await open(page);
    await openPanel(page);
    await emit(page, `live:daf:${DAF}`, 'thread', {
      id: 'new-one', author_id: USERS.author.id, author_display_name: 'Author Two', daf_ref_key: DAF, segment_ref: 'Chullin 89a.2',
      word_ranges: [{ ref: 'Chullin 89a.2', start: 5, end: 6 }], quoted_text: 'מאי טעמא', anchor_segment: 2, anchor_word: 5,
      preview: 'A brand new question', message_count: 1, status: 'open', answer_message_id: null,
      created_at: new Date().toISOString(), last_message_at: new Date().toISOString(),
    });
    await expect(cards(page)).toHaveCount(3);
    await emit(page, `live:daf:${DAF}`, 'thread_updated', { id: T2, message_count: 12 });
    await expect(page.locator('.live-card', { hasText: 'Can anyone explain' })).toContainText('11 replies');
    await emit(page, `live:daf:${DAF}`, 'thread_removed', { id: 'new-one' });
    await expect(cards(page)).toHaveCount(2);
  });

  test('the channel is private, and opening the panel changes nothing about the video or the daf', async ({ page }) => {
    await open(page);
    const before = await page.evaluate(() => ({ dafRef: state.dafRef, source: state.videoSource, browse: state.browsePageRef }));
    await openPanel(page);
    await cards(page).first().click();
    const calls = await page.evaluate(() => (window.__DAFSYNC_TEST_CALLS__ || []).filter((c) => c.channel));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.private === true)).toBe(true);
    expect(await page.evaluate(() => ({ dafRef: state.dafRef, source: state.videoSource, browse: state.browsePageRef }))).toEqual(before);
  });
});

test.describe('Cloud Chaburah Live — a conversation', () => {
  async function openThread(page, text = 'Why does the Gemara start here?') {
    await openPanel(page);
    await page.locator('.live-card', { hasText: text }).click();
    await expect(page.locator('.live-chat-view')).toBeVisible();
  }

  test('shows the messages, the quoted reply and the answer, and highlights the words on the daf', async ({ page }) => {
    await open(page);
    await page.evaluate(() => { window.__hl = null; window.highlightTextRange = (runs) => { window.__hl = runs; }; });
    await openThread(page);
    await expect(page.locator('.live-message')).toHaveCount(3);
    await expect(page.locator('.live-anchor')).toHaveText('תנו רבנן ארבעה');
    await expect(page.locator('.live-chat-meta .live-badge-answered')).toBeVisible();
    await expect(page.locator('.live-message').nth(2).locator('.live-quoted')).toContainText('Admin Four: Because of the Mishnah');
    await expect(page.locator('.live-message').nth(1).locator('.live-badge-answered')).toHaveText('Answer');
    expect(await page.evaluate(() => window.__hl)).toEqual([{ ref: 'Chullin 89a.1', start: 2, end: 4 }]);
    await page.evaluate(() => { window.__hl = null; });
    await page.locator('.live-anchor').click();
    expect(await page.evaluate(() => window.__hl)).toEqual([{ ref: 'Chullin 89a.1', start: 2, end: 4 }]);
  });

  test('a sent message appears once, even when its broadcast arrives too', async ({ page }, testInfo) => {
    await open(page);
    await openThread(page);
    await page.locator('.live-input').fill('Here is my reply');
    // Enter sends on a keyboard; on a phone it is a new line, and the Send button sends.
    if (testInfo.project.name === 'mobile') {
      await page.locator('.live-input').press('Enter');
      expect(await callsTo(page, 'live_post_message')).toHaveLength(0);
      await page.locator('.live-input').fill('Here is my reply');
      await page.locator('.live-send').click();
    } else {
      await page.locator('.live-input').press('Enter');
    }
    await expect(page.locator('.live-message')).toHaveCount(4);
    await expect(page.locator('.live-message.live-mine .live-body-text')).toHaveText('Here is my reply');
    await expect(page.locator('.live-input')).toHaveValue('');
    const [call] = await callsTo(page, 'live_post_message');
    expect(call).toMatchObject({ p_thread_id: T1, p_body: 'Here is my reply', p_quoted_message_id: null });
    await page.waitForTimeout(300);
    await expect(page.locator('.live-message')).toHaveCount(4);
  });

  test('another person\'s message arrives live, and edits and removals replace it', async ({ page }) => {
    await open(page);
    await openThread(page);
    const message = { id: 'live-1', seq: 4, thread_id: T1, author_id: USERS.author.id, author_display_name: 'Author Two', body: 'Hello from elsewhere',
      quoted_message_id: null, created_at: new Date().toISOString(), edited_at: null, deleted_at: null, hidden: false };
    await emit(page, `live:thread:${T1}`, 'message', message);
    await expect(page.locator('.live-message')).toHaveCount(4);
    await expect(page.locator('.live-message').last()).toContainText('Hello from elsewhere');
    await emit(page, `live:thread:${T1}`, 'message', message);
    await expect(page.locator('.live-message')).toHaveCount(4);
    await emit(page, `live:thread:${T1}`, 'message_updated', { ...message, body: 'Hello (edited)', edited_at: new Date().toISOString() });
    await expect(page.locator('.live-message').last()).toContainText('Hello (edited)');
    await expect(page.locator('.live-message').last()).toContainText('edited');
    await emit(page, `live:thread:${T1}`, 'message_updated', { ...message, body: '', hidden: true });
    await expect(page.locator('.live-message').last()).toContainText('This message was removed.');
    await emit(page, `live:thread:${T2}`, 'message', { ...message, id: 'other', thread_id: T2 });
    await expect(page.locator('.live-message')).toHaveCount(4);
  });

  test('replying quotes the message you chose', async ({ page }) => {
    await open(page);
    await openThread(page);
    await page.locator('.live-message').nth(1).locator('.live-more-actions').click();
    await page.getByRole('button', { name: 'Reply', exact: true }).click();
    await expect(page.locator('.live-quote-bar')).toContainText('Admin Four: Because of the Mishnah');
    await page.locator('.live-input').fill('Following up');
    await page.locator('.live-send').click();
    await expect(page.locator('.live-message')).toHaveCount(4);
    const [call] = await callsTo(page, 'live_post_message');
    expect(call.p_quoted_message_id).toBe('m1b');
    await expect(page.locator('.live-quote-bar')).toBeHidden();
  });

  test('your own message can be edited and deleted', async ({ page }) => {
    await open(page);
    await openThread(page);
    await page.locator('.live-input').fill('Mine to change');
    await page.locator('.live-send').click();
    const mine = page.locator('.live-message.live-mine');
    await expect(mine).toHaveCount(1);
    await mine.locator('.live-more-actions').click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(page.locator('.live-input')).toHaveValue('Mine to change');
    await expect(page.locator('.live-quote-bar')).toContainText('Editing');
    await page.locator('.live-input').fill('Changed');
    await page.locator('.live-send').click();
    await expect(mine.locator('.live-body-text')).toHaveText('Changed');
    await expect(mine).toContainText('edited');
    const [edit] = await callsTo(page, 'live_edit_message');
    expect(edit.p_body).toBe('Changed');
    await mine.locator('.live-more-actions').click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(mine.locator('.live-body-text')).toHaveText('This message was deleted.');
    await expect(page.locator('.live-message')).toHaveCount(4);
  });

  test('someone else\'s message cannot be edited or deleted by a reader', async ({ page }) => {
    await open(page);
    await openThread(page);
    await page.locator('.live-message').nth(1).locator('.live-more-actions').click();
    await expect(page.getByRole('button', { name: 'Reply', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Remove', exact: true })).toHaveCount(0);
  });

  test('a moderator can remove someone else\'s message', async ({ page }) => {
    await open(page, { user: USERS.admin });
    await openThread(page);
    await page.locator('.live-message').nth(0).locator('.live-more-actions').click();
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(page.locator('.live-message').nth(0)).toContainText('This message was removed.');
    const [call] = await callsTo(page, 'live_moderate');
    expect(call).toEqual({ p_thread_id: T1, p_message_id: 'm1a', p_hidden: true });
  });

  test('only the person who asked can mark an answer', async ({ page }) => {
    await open(page, { user: USERS.author });
    await openThread(page, 'Can anyone explain the distinction?');
    await emit(page, `live:thread:${T2}`, 'message', { id: 'reply-1', seq: 2, thread_id: T2, author_id: USERS.admin.id, author_display_name: 'Admin Four',
      body: 'Here is the explanation', quoted_message_id: null, created_at: new Date().toISOString(), edited_at: null, deleted_at: null, hidden: false });
    await expect(page.locator('.live-message')).toHaveCount(2);
    await page.locator('.live-message').nth(1).locator('.live-more-actions').click();
    await page.getByRole('button', { name: 'Mark as answer' }).click();
    await expect(page.locator('.live-chat-meta .live-badge-answered')).toBeVisible();
    await expect(page.locator('.live-message').nth(1).locator('.live-badge-answered')).toHaveText('Answer');
    const [call] = await callsTo(page, 'live_set_answer');
    expect(call).toEqual({ p_thread_id: T2, p_message_id: 'reply-1' });
  });

  test('a message is shown as text, never as markup', async ({ page }) => {
    await open(page);
    await openThread(page);
    await emit(page, `live:thread:${T1}`, 'message', { id: 'xss', seq: 4, thread_id: T1, author_id: USERS.author.id, author_display_name: '<b>Bad</b>',
      body: '<img src=x onerror="window.__pwned=1"> <script>window.__pwned=1</script>', quoted_message_id: null,
      created_at: new Date().toISOString(), edited_at: null, deleted_at: null, hidden: false });
    await expect(page.locator('.live-message').last()).toContainText('<img src=x');
    await expect(page.locator('.live-message').last().locator('img, script')).toHaveCount(0);
    expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  });

  test('a refused send says why, in words', async ({ page }) => {
    await open(page);
    await openThread(page);
    await page.evaluate(() => { window.__LIVE_FAIL__ = 'live_rate_limited'; });
    await page.locator('.live-input').fill('Too fast');
    await page.locator('.live-send').click();
    await expect(page.locator('.live-chat-view .live-error')).toContainText('posting very quickly');
    await expect(page.locator('.live-message')).toHaveCount(3);
    await page.evaluate(() => { window.__LIVE_FAIL__ = 'live_account_too_new'; });
    await page.locator('.live-send').click();
    await expect(page.locator('.live-chat-view .live-error')).toContainText('24 hours');
  });

  test('an empty message is refused before it is sent', async ({ page }) => {
    await open(page);
    await openThread(page);
    await page.locator('.live-input').fill('   ');
    await page.locator('.live-send').click();
    await expect(page.locator('.live-chat-view .live-error')).toContainText('Write something first');
    expect(await callsTo(page, 'live_post_message')).toHaveLength(0);
  });

  test('follow, share and the way back', async ({ page }) => {
    await open(page);
    await openThread(page);
    await page.getByRole('button', { name: 'Follow this discussion' }).click();
    await expect(page.getByRole('button', { name: 'Stop following this discussion' })).toBeVisible();
    await page.getByRole('button', { name: 'Stop following this discussion' }).click();
    await expect(page.getByRole('button', { name: 'Follow this discussion' })).toBeVisible();
    await page.getByRole('button', { name: 'Back to the discussions' }).click();
    await expect(page.locator('.live-list-view')).toBeVisible();
  });

  test('when the channel cannot be joined the chat says it is updating on a timer', async ({ page }) => {
    await open(page, { control: { realtime: { fail: true } } });
    await openThread(page);
    await expect(page.locator('.live-chat-meta')).toContainText('Updating every few seconds');
  });

  test('a link with ?live= opens that discussion', async ({ page }) => {
    await open(page, { url: `/browse/?ref=Chullin%2089a&live=${T2}` });
    await expect(page.locator('#livePanel')).toBeVisible();
    await expect(page.locator('.live-chat-view')).toBeVisible();
    await expect(page.locator('.live-anchor')).toHaveText('אמר רב יהודה אמר רב');
  });

  test('a thread link names the daf and the discussion', async ({ page }) => {
    await open(page);
    await openThread(page);
    await page.evaluate(() => { window.__copied = null; navigator.clipboard.writeText = async (text) => { window.__copied = text; }; });
    await page.getByRole('button', { name: 'Copy a link to this discussion' }).click();
    expect(await page.evaluate(() => window.__copied)).toMatch(new RegExp(`/browse/\\?ref=Chullin%2089a&live=${T1}$`));
  });
});

test.describe('Cloud Chaburah Live — starting a discussion', () => {
  const RUNS = [{ ref: 'Chullin 89a.1', start: 1, end: 3 }];

  test('a selection becomes its own thread, anchored to those words', async ({ page }) => {
    await open(page);
    await page.evaluate((runs) => window.DafLive.startForSelection({ runs, text: '' }), RUNS);
    await expect(page.locator('.live-compose-view')).toBeVisible();
    await expect(page.locator('.live-compose-quote')).not.toBeEmpty();
    await page.locator('.live-compose-view .live-textarea').fill('  Why is it worded this way?  ');
    await page.getByRole('button', { name: 'Start discussion' }).click();
    await expect(page.locator('.live-chat-view')).toBeVisible();
    await expect(page.locator('.live-message')).toHaveCount(1);
    await expect(page.locator('.live-message').first()).toContainText('Why is it worded this way?');
    const [call] = await callsTo(page, 'live_start_thread');
    expect(call).toMatchObject({ p_daf_ref_key: DAF, p_segment_ref: 'Chullin 89a.1', p_word_ranges: RUNS, p_body: '  Why is it worded this way?  ' });
    expect(call.p_quoted_text.length).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Back to the discussions' }).click();
    await expect(cards(page)).toHaveCount(3);
  });

  test('two questions about the same words are two threads', async ({ page }) => {
    await open(page);
    for (const text of ['First question', 'Second question']) {
      await page.evaluate((runs) => window.DafLive.startForSelection({ runs, text: '' }), RUNS);
      await page.locator('.live-compose-view .live-textarea').fill(text);
      await page.getByRole('button', { name: 'Start discussion' }).click();
      await expect(page.locator('.live-message').first()).toContainText(text);
      await page.getByRole('button', { name: 'Back to the discussions' }).click();
    }
    await expect(cards(page)).toHaveCount(4);
  });

  test('an empty question is refused, a refused one says why, and cancelling changes nothing', async ({ page }) => {
    await open(page);
    await page.evaluate((runs) => window.DafLive.startForSelection({ runs, text: '' }), RUNS);
    await page.getByRole('button', { name: 'Start discussion' }).click();
    await expect(page.locator('.live-compose-view .live-error')).toContainText('Write something first');
    await page.evaluate(() => { window.__LIVE_FAIL__ = 'live_account_too_new'; });
    await page.locator('.live-compose-view .live-textarea').fill('A question');
    await page.getByRole('button', { name: 'Start discussion' }).click();
    await expect(page.locator('.live-compose-view .live-error')).toContainText('24 hours');
    await page.getByRole('button', { name: 'Cancel', exact: true }).last().click();
    await expect(cards(page)).toHaveCount(2);
  });

  test('a signed-out reader is asked to sign in instead', async ({ page }) => {
    await open(page, { user: null });
    await page.evaluate((runs) => window.DafLive.startForSelection({ runs, text: '' }), RUNS);
    await expect(page.locator('.live-compose-view')).toBeHidden();
    expect(await callsTo(page, 'live_start_thread')).toHaveLength(0);
  });

  test('the right-click menu offers it only to someone who may use it', async ({ page }) => {
    await open(page);
    const labels = await page.evaluate(() => buildMenuItems({ ref: 'Chullin 89a.1', start: 1, end: 2, text: 'אב גד', source: 'text' }).map((i) => i.label));
    expect(labels).toContain('Start live discussion on this passage');
    const single = await page.evaluate(() => buildMenuItems({ ref: 'Chullin 89a.1', start: 1, end: 1, text: 'אב', source: 'text' }).map((i) => i.label));
    expect(single).toContain('Start live discussion here');
  });

  test('and not to someone who may not', async ({ page }) => {
    await open(page, { audience: 'admins' });
    await page.waitForTimeout(300);
    const labels = await page.evaluate(() => buildMenuItems({ ref: 'Chullin 89a.1', start: 1, end: 2, text: 'אב גד', source: 'text' }).map((i) => i.label));
    expect(labels.some((l) => /live discussion/i.test(l))).toBe(false);
  });
});

test.describe('Cloud Chaburah Live — the panel itself', () => {
  test('loads without a page error', async ({ page }) => {
    // Uncaught exceptions only: the page itself makes a few unrelated requests that fail in a test run.
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await open(page);
    await openPanel(page);
    await cards(page).first().click();
    await page.getByRole('button', { name: 'Back to the discussions' }).click();
    expect(errors).toEqual([]);
  });

  test('Escape goes back, then closes', async ({ page }) => {
    await open(page);
    await openPanel(page);
    await cards(page).first().click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.live-list-view')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#livePanel')).toBeHidden();
  });

  test('on a phone it is a bottom sheet; on a desktop a drawer on the right', async ({ page }, testInfo) => {
    await page.emulateMedia({ reducedMotion: 'reduce' }); // measure it where it ends up, not mid-slide
    await open(page);
    await openPanel(page);
    const box = await page.locator('#livePanel').boundingBox();
    const viewport = page.viewportSize();
    if (testInfo.project.name === 'mobile') {
      expect(box.x).toBe(0);
      expect(Math.round(box.width)).toBe(viewport.width);
      expect(Math.round(box.y + box.height)).toBe(viewport.height);
      expect(box.height).toBeLessThan(viewport.height);
    } else {
      expect(Math.round(box.x + box.width)).toBe(viewport.width);
      expect(Math.round(box.y)).toBe(0);
    }
    // It scrolls on its own: the page behind is not what moves.
    await expect(page.locator('.live-scroll').first()).toHaveCSS('overflow-y', 'auto');
  });
});
