import { test, expect } from '@playwright/test';
import { USERS } from '../fixtures/dataset.mjs';
import { T1, T2, T3, DAF, notice, open, openPanel, cards, callsTo, emit } from '../support/live-chaburah.mjs';

// Cloud Chaburah Live, phase 3: the bell and inbox, the settings, follow / mute, live alerts
// while using the site, and background alerts (a stubbed browser push stack). The rules about
// who is notified, and when, are proven against a real Postgres in
// supabase/tests/live_chaburah_notifications.sql.

const seedNotices = (db) => {
  db.live_notifications = [
    notice('n1', 'reply_to_me', T2, { preview: 'Because of the Mishnah.', created_at: new Date(Date.now() - 3 * 60000).toISOString() }),
    notice('n2', 'reply_to_thread', T2, { preview: 'Also this.', created_at: new Date(Date.now() - 6 * 60000).toISOString() }),
    notice('n3', 'mention', T3, { daf_ref_key: 'Chullin-90a', actor_display_name: 'Bo Other', preview: 'What do you think?', created_at: new Date(Date.now() - 20 * 60000).toISOString() }),
    notice('n4', 'followed_activity', T1, { read_at: new Date().toISOString(), preview: 'Old news', created_at: new Date(Date.now() - 90 * 60000).toISOString() }),
  ];
};
const bell = (page) => page.locator('.live-bell');
const openInbox = async (page) => { await openPanel(page); await bell(page).click(); await expect(page.locator('.live-inbox-view')).toBeVisible(); };
const openSettings = async (page) => { await openPanel(page); await page.getByRole('button', { name: 'Notification settings' }).click(); await expect(page.locator('.live-settings-view')).toBeVisible(); };
const savedPrefs = async (page) => (await callsTo(page, 'live_set_notification_prefs')).map((c) => c.p);

test.describe('The bell and the inbox', () => {
  test('the unread count is on the bell and on the button', async ({ page }) => {
    await open(page, { mutate: seedNotices });
    await expect(page.locator('.live-toggle-alert')).toHaveText('3 alerts');
    await openPanel(page);
    await expect(page.locator('.live-bell-count')).toHaveText('3');
    await expect(bell(page)).toHaveAttribute('aria-label', 'Notifications, 3 unread');
  });

  test('one row per discussion, saying what happened, with the newest first', async ({ page }) => {
    await open(page, { mutate: seedNotices });
    await openInbox(page);
    const rows = page.locator('.live-notice');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText('Avi Author replied to you');
    await expect(rows.nth(0)).toContainText('Because of the Mishnah.');
    await expect(rows.nth(0)).toContainText('2 messages');
    await expect(rows.nth(0).locator('.live-notice-dot')).toHaveCount(1);
    await expect(rows.nth(1)).toContainText('Bo Other mentioned you');
    await expect(rows.nth(2).locator('.live-notice-dot')).toHaveCount(0);
  });

  test('a notification on this daf opens that discussion and clears its alerts', async ({ page }) => {
    await open(page, { mutate: seedNotices });
    await openInbox(page);
    await page.locator('.live-notice').first().click();
    await expect(page.locator('.live-chat-view')).toBeVisible();
    await expect(page.locator('.live-message').first()).toContainText('Can anyone explain the distinction?');
    await expect(page.locator('.live-bell-count')).toHaveText('1');
    expect((await callsTo(page, 'live_mark_notifications_read'))[0]).toEqual({ p_thread_id: T2, p_all: false });
  });

  test('a notification on another daf goes to that daf with the discussion open', async ({ page }) => {
    await open(page, { mutate: seedNotices });
    await openInbox(page);
    await page.locator('.live-notice', { hasText: 'Bo Other mentioned you' }).click();
    await page.waitForURL(/\/browse\/\?ref=Chullin%2090a&live=/);
    expect(new URL(page.url()).searchParams.get('live')).toBe(T3);
  });

  test('mark all read', async ({ page }) => {
    await open(page, { mutate: seedNotices });
    await openInbox(page);
    await page.getByRole('button', { name: 'Mark all read' }).click();
    await expect(page.locator('.live-notice-dot')).toHaveCount(0);
    await expect(page.locator('.live-bell-count')).toBeHidden();
    await expect(page.locator('.live-toggle-alert')).toBeHidden();
    expect((await callsTo(page, 'live_mark_notifications_read'))[0]).toEqual({ p_thread_id: null, p_all: true });
  });

  test('an empty inbox says what will appear', async ({ page }) => {
    await open(page);
    await openInbox(page);
    await expect(page.locator('.live-inbox-view .live-inbox-empty')).toContainText('Replies to you, mentions');
  });

  test('a new notification arrives live: the bell counts it and a message says what happened', async ({ page }) => {
    await open(page);
    await openPanel(page);
    await emit(page, `notify:user:${USERS.ordinary.id}`, 'notification', {
      id: 'live-1', kind: 'mention', thread_id: T2, message_id: 'mm', daf_ref_key: DAF, actor_display_name: 'Avi Author',
      preview: 'Reader, what do you think?', created_at: new Date().toISOString(),
    });
    await expect(page.locator('.live-bell-count')).toHaveText('1');
    await expect(page.locator('#toast')).toContainText('Avi Author mentioned you');
    // The same notification arriving twice (channel and catch-up) is one.
    await emit(page, `notify:user:${USERS.ordinary.id}`, 'notification', { id: 'live-1', kind: 'mention', thread_id: T2, daf_ref_key: DAF, actor_display_name: 'Avi Author', preview: 'x', created_at: new Date().toISOString() });
    await expect(page.locator('.live-bell-count')).toHaveText('1');
  });

  test('reading the discussion where it arrives raises no alert', async ({ page }) => {
    await open(page);
    await openPanel(page);
    await cards(page).filter({ hasText: 'Can anyone explain the distinction?' }).click();
    await expect(page.locator('.live-chat-view')).toBeVisible();
    await emit(page, `notify:user:${USERS.ordinary.id}`, 'notification', {
      id: 'live-2', kind: 'reply_to_thread', thread_id: T2, daf_ref_key: DAF, actor_display_name: 'Avi Author', preview: 'Here it is', created_at: new Date().toISOString(),
    });
    await expect(page.locator('.live-bell-count')).toBeHidden();
  });

  test('your channel is private to you', async ({ page }) => {
    await open(page);
    await expect.poll(() => page.evaluate(() => (window.__DAFSYNC_TEST_CALLS__ || []).some((c) => c.channel === 'notify:user:11111111-1111-4111-8111-111111111111'))).toBe(true);
    const joined = await page.evaluate(() => (window.__DAFSYNC_TEST_CALLS__ || []).filter((c) => String(c.channel || '').startsWith('notify:')));
    expect(joined.every((c) => c.channel === `notify:user:${USERS.ordinary.id}`)).toBe(true);
  });

  test('?live=inbox (what a grouped background alert opens) shows the inbox', async ({ page }) => {
    await open(page, { url: '/browse/?ref=Chullin%2089a&live=inbox', mutate: seedNotices });
    await expect(page.locator('.live-inbox-view')).toBeVisible();
    await expect(page.locator('.live-notice')).toHaveCount(3);
  });

  test('signed out: the inbox asks you to sign in, and nothing is called', async ({ page }) => {
    await open(page, { user: null });
    await openPanel(page);
    await bell(page).click();
    await expect(page.locator('.live-inbox-view .live-inbox-empty')).toContainText('Sign in to see your notifications');
    expect(await callsTo(page, 'live_list_notifications')).toEqual([]);
    expect(await callsTo(page, 'live_my_notification_state')).toEqual([]);
  });

  test('without the database part, the panel still works and nothing breaks', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await open(page, { init: () => { window.__LIVE_NOTIFY_MISSING__ = true; } });
    await openPanel(page);
    await expect(cards(page)).toHaveCount(2);
    await bell(page).click();
    await expect(page.locator('.live-inbox-view')).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe('Settings', () => {
  test('shows the defaults: my discussions on, the rest off', async ({ page }) => {
    await open(page);
    await openSettings(page);
    const box = (key) => page.locator(`input[data-pref="${key}"]`);
    await expect(box('lvl_mine')).toBeChecked();
    await expect(box('in_app_enabled')).toBeChecked();
    await expect(box('lvl_daf')).not.toBeChecked();
    await expect(box('lvl_everywhere')).not.toBeChecked();
    await expect(box('lvl_while_using')).not.toBeChecked();
    await expect(box('all_off')).not.toBeChecked();
  });

  test('levels are combinable, and each change is saved', async ({ page }) => {
    await open(page);
    await openSettings(page);
    await page.locator('input[data-pref="lvl_daf"]').check();
    await page.locator('input[data-pref="lvl_everywhere"]').check();
    await expect(page.locator('.live-save-status')).toHaveText('Saved');
    const merged = Object.assign({}, ...(await savedPrefs(page)));
    expect(merged).toMatchObject({ lvl_daf: true, lvl_everywhere: true });
    expect(merged.lvl_mine).toBeUndefined();
    // They reach the server's copy, and a reload that reads it back shows them.
    expect(await page.evaluate(() => window.__DAFSYNC_TEST_DB__.live_notif_prefs)).toMatchObject({ lvl_daf: true, lvl_everywhere: true });
  });

  test('quick successive changes are all sent', async ({ page }) => {
    await open(page);
    await openSettings(page);
    await page.locator('input[data-pref="quiet_enabled"]').check();
    await page.locator('select[data-pref="quiet_start"]').selectOption('23');
    await page.locator('select[data-pref="quiet_end"]').selectOption('6');
    await page.locator('input[data-pref="shabbos_pause"]').check();
    await expect(page.locator('.live-save-status')).toHaveText('Saved');
    const merged = Object.assign({}, ...(await savedPrefs(page)));
    expect(merged).toMatchObject({ quiet_enabled: true, quiet_start: 23, quiet_end: 6, shabbos_pause: true });
  });

  test('batching, the digest and its hour', async ({ page }) => {
    await open(page);
    await openSettings(page);
    await page.locator('select[data-pref="batch_minutes"]').selectOption('15');
    await page.locator('input[data-pref="digest_enabled"]').check();
    await page.locator('select[data-pref="digest_hour"]').selectOption('8');
    await expect(page.locator('.live-save-status')).toHaveText('Saved');
    expect(Object.assign({}, ...(await savedPrefs(page)))).toMatchObject({ batch_minutes: 15, digest_enabled: true, digest_hour: 8 });
    await expect(page.locator('select[data-pref="digest_hour"] option:checked')).toHaveText('8 am');
  });

  test('turning everything off, and pausing for a while', async ({ page }) => {
    await open(page);
    await openSettings(page);
    await page.locator('input[data-pref="all_off"]').check();
    await page.locator('select[data-pref="snooze_until"]').selectOption('4');
    await expect(page.locator('.live-save-status')).toHaveText('Saved');
    const merged = Object.assign({}, ...(await savedPrefs(page)));
    expect(merged.all_off).toBe(true);
    const until = new Date(merged.snooze_until).getTime() - Date.now();
    expect(until).toBeGreaterThan(3.9 * 3600 * 1000);
    expect(until).toBeLessThan(4.1 * 3600 * 1000);
    await expect(page.locator('.live-settings-view')).toContainText('Paused until');
  });

  test('the time zone follows the device when asked', async ({ browser }) => {
    const context = await browser.newContext({ timezoneId: 'Asia/Jerusalem' });
    const page = await context.newPage();
    await open(page);
    await openSettings(page);
    await expect(page.locator('.live-settings-view')).toContainText('Times are in UTC.');
    await page.getByRole('button', { name: 'Use this device’s time zone' }).click();
    await expect(page.locator('.live-settings-view')).toContainText('Times are in Asia/Jerusalem.');
    await expect.poll(async () => Object.assign({}, ...(await savedPrefs(page))).timezone).toBe('Asia/Jerusalem');
    await context.close();
  });

  test('a refused save says so and shows what the server has', async ({ page }) => {
    await open(page, { init: () => { window.__LIVE_FAIL__ = 'live_invalid_input'; } });
    await openSettings(page);
    await page.locator('input[data-pref="lvl_daf"]').check();
    await expect(page.locator('.live-save-status')).toContainText('could not be sent');
    await expect(page.locator('input[data-pref="lvl_daf"]')).not.toBeChecked();
  });

  test('signed out there is nothing to set', async ({ page }) => {
    await open(page, { user: null });
    await openSettings(page);
    await expect(page.locator('.live-settings-view')).toContainText('Sign in to choose');
    await expect(page.locator('input[data-pref="lvl_daf"]')).toBeHidden();
  });
});

test.describe('This daf and this discussion', () => {
  test('following a daf asks to hear about it, and muting it silences it', async ({ page }) => {
    await open(page);
    await openPanel(page);
    const follow = page.getByRole('button', { name: 'Follow Chullin 89a' });
    await follow.click();
    await expect(page.getByRole('button', { name: 'Following Chullin 89a' })).toHaveAttribute('aria-pressed', 'true');
    expect(await callsTo(page, 'live_set_daf_pref')).toEqual([{ p_daf_ref_key: DAF, p_following: true, p_muted: false }]);
    await expect.poll(async () => Object.assign({}, ...(await savedPrefs(page))).lvl_daf).toBe(true);
    await page.getByRole('button', { name: 'Mute daf' }).click();
    await expect(page.getByRole('button', { name: 'Muted' })).toHaveAttribute('aria-pressed', 'true');
    const calls = await callsTo(page, 'live_set_daf_pref');
    expect(calls[1]).toEqual({ p_daf_ref_key: DAF, p_following: true, p_muted: true });
  });

  test('a discussion can be muted and unmuted', async ({ page }) => {
    await open(page);
    await openPanel(page);
    await cards(page).filter({ hasText: 'Can anyone explain the distinction?' }).click();
    const mute = page.locator('.live-mute');
    await expect(mute).toHaveText('Mute');
    await mute.click();
    await expect(mute).toHaveText('Muted');
    expect(await callsTo(page, 'live_set_thread_muted')).toEqual([{ p_thread_id: T2, p_muted: true }]);
    await mute.click();
    await expect(mute).toHaveText('Mute');
  });

  test('the open daf is told to the server only for someone who wants "my daf" alerts', async ({ page }) => {
    await open(page);
    await page.waitForTimeout(500);
    expect(await callsTo(page, 'live_set_current_daf')).toEqual([]);
    await open(page, { mutate: (db) => { db.live_notif_prefs = { lvl_daf: true }; } });
    await expect.poll(async () => (await callsTo(page, 'live_set_current_daf')).length).toBeGreaterThan(0);
    expect((await callsTo(page, 'live_set_current_daf'))[0]).toEqual({ p_daf_ref_key: DAF });
  });
});

test.describe('Live alerts while using the site', () => {
  const thread = {
    id: 'new-thread', author_id: USERS.author.id, author_display_name: 'Author Two', daf_ref_key: DAF, segment_ref: 'Chullin 89a.3',
    word_ranges: [{ ref: 'Chullin 89a.3', start: 0, end: 1 }], quoted_text: 'x', anchor_segment: 3, anchor_word: 0, preview: 'A brand new question',
    message_count: 1, status: 'open', answer_message_id: null, hidden: false, created_at: new Date().toISOString(), last_message_at: new Date().toISOString(),
  };
  test('on: a new discussion on the open daf is announced, even with the panel closed', async ({ page }) => {
    await open(page, { mutate: (db) => { db.live_notif_prefs = { lvl_while_using: true }; } });
    await expect.poll(() => page.evaluate(() => (window.__DAFSYNC_TEST_CALLS__ || []).some((c) => c.channel === 'live:daf:Chullin-89a'))).toBe(true);
    await emit(page, 'live:daf:Chullin-89a', 'thread', thread);
    await expect(page.locator('#toast')).toContainText('Author Two started a discussion on Chullin 89a: A brand new question');
  });
  test('off: nothing is said, and the daf channel is not joined while the panel is closed', async ({ page }) => {
    await open(page);
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => (window.__DAFSYNC_TEST_CALLS__ || []).some((c) => c.channel === 'live:daf:Chullin-89a'))).toBe(false);
  });
  test('your own discussion is not announced to you', async ({ page }) => {
    await open(page, { mutate: (db) => { db.live_notif_prefs = { lvl_while_using: true }; } });
    await expect.poll(() => page.evaluate(() => (window.__DAFSYNC_TEST_CALLS__ || []).some((c) => c.channel === 'live:daf:Chullin-89a'))).toBe(true);
    await emit(page, 'live:daf:Chullin-89a', 'thread', { ...thread, author_id: USERS.ordinary.id });
    await page.waitForTimeout(300);
    await expect(page.locator('#toast')).not.toContainText('started a discussion');
  });
});

test.describe('Background alerts', () => {
  const pushStack = ({ permission = 'default', answer = 'granted', configured = true, supported = true } = {}) => async (page) => {
    await page.addInitScript(({ permission, answer, supported }) => {
      if (!supported) {
        delete window.PushManager;
        return;
      }
      let current = permission;
      const fakeSubscription = {
        endpoint: 'https://push.example.test/send/abcdefghijklmnop',
        toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'BPkeykeykeykeykeykeykey', auth: 'authsecretxx' } }; },
        async unsubscribe() { window.__PUSH_SUB__ = null; return true; },
      };
      window.__PUSH_SUB__ = null;
      const registration = {
        pushManager: {
          async getSubscription() { return window.__PUSH_SUB__; },
          async subscribe(options) { window.__PUSH_KEY__ = Array.from(options.applicationServerKey).length; window.__PUSH_SUB__ = fakeSubscription; return fakeSubscription; },
        },
      };
      Object.defineProperty(window, 'Notification', {
        configurable: true,
        value: Object.assign(function Notification() {}, {
          get permission() { return current; },
          requestPermission: async () => { window.__ASKED__ = (window.__ASKED__ || 0) + 1; current = answer; return answer; },
        }),
      });
      Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: {
          register: async (url, options) => { window.__SW__ = { url, scope: options && options.scope }; return registration; },
          ready: Promise.resolve(registration),
          getRegistration: async () => registration,
          addEventListener() {},
        },
      });
    }, { permission, answer, supported });
    await page.route('**/.netlify/functions/live-push-config', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify(configured ? { available: true, publicKey: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U' } : { available: false }),
    }));
  };

  test('off by default; turning it on asks the browser, then registers this device', async ({ page }) => {
    await pushStack()(page);
    await open(page);
    await openSettings(page);
    await expect(page.locator('.live-push')).toContainText('Off. Turn them on');
    await page.getByRole('button', { name: 'Turn on for this device' }).click();
    await expect(page.locator('.live-push')).toContainText('On. This device gets background alerts');
    expect(await page.evaluate(() => window.__ASKED__)).toBe(1);
    expect(await page.evaluate(() => window.__SW__)).toEqual({ url: '/live-sw.js', scope: '/' });
    expect(await page.evaluate(() => window.__PUSH_KEY__)).toBe(65);
    const saved = await callsTo(page, 'live_save_push_subscription');
    expect(saved).toEqual([{ p_endpoint: 'https://push.example.test/send/abcdefghijklmnop', p_p256dh: 'BPkeykeykeykeykeykeykey', p_auth: 'authsecretxx', p_label: expect.stringMatching(/ on /) }]);
    await expect(page.locator('.live-devices')).toContainText('added just now');
  });

  test('nothing is asked or sent until the button is pressed', async ({ page }) => {
    await pushStack()(page);
    await open(page);
    await openSettings(page);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__ASKED__)).toBeUndefined();
    expect(await callsTo(page, 'live_save_push_subscription')).toEqual([]);
  });

  test('saying no in the browser turns nothing on', async ({ page }) => {
    await pushStack({ answer: 'denied' })(page);
    await open(page);
    await openSettings(page);
    await page.getByRole('button', { name: 'Turn on for this device' }).click();
    await expect(page.locator('.live-push')).toContainText('blocking notifications');
    expect(await callsTo(page, 'live_save_push_subscription')).toEqual([]);
  });

  test('a browser that already blocks them says how to allow them', async ({ page }) => {
    await pushStack({ permission: 'denied' })(page);
    await open(page);
    await openSettings(page);
    await expect(page.locator('.live-push')).toContainText('blocking notifications');
    await expect(page.getByRole('button', { name: 'Turn on for this device' })).toHaveCount(0);
  });

  test('a server that is not set up says so, and registers nothing', async ({ page }) => {
    await pushStack({ configured: false })(page);
    await open(page);
    await openSettings(page);
    await page.getByRole('button', { name: 'Turn on for this device' }).click();
    await expect(page.locator('.live-push')).toContainText('not set up on the server yet');
    expect(await callsTo(page, 'live_save_push_subscription')).toEqual([]);
  });

  test('a browser without push still gets everything else', async ({ page }) => {
    await pushStack({ supported: false })(page);
    await open(page);
    await openSettings(page);
    await expect(page.locator('.live-push')).toContainText('cannot show background alerts');
    await expect(page.locator('input[data-pref="lvl_mine"]')).toBeVisible();
  });

  test('turning it off removes this device', async ({ page }) => {
    await pushStack()(page);
    await open(page);
    await openSettings(page);
    await page.getByRole('button', { name: 'Turn on for this device' }).click();
    await page.getByRole('button', { name: 'Turn off on this device' }).click();
    await expect(page.locator('.live-push')).toContainText('Off. Turn them on');
    expect(await callsTo(page, 'live_remove_push_subscription')).toEqual([{ p_device_id: null, p_endpoint: 'https://push.example.test/send/abcdefghijklmnop' }]);
    await expect(page.locator('.live-devices')).toHaveCount(0);
  });

  test('another device can be removed from here', async ({ page }) => {
    await pushStack()(page);
    await open(page, { mutate: (db) => { db.push_subscriptions = [{ id: 'dev-9', endpoint: 'https://push.example.test/other-device-endpoint', label: 'Chrome on Android', created_at: new Date(Date.now() - 86400000 * 3).toISOString() }]; } });
    await openSettings(page);
    await expect(page.locator('.live-devices')).toContainText('Chrome on Android');
    await page.getByRole('button', { name: 'Remove Chrome on Android' }).click();
    await expect(page.locator('.live-devices')).toHaveCount(0);
    expect(await callsTo(page, 'live_remove_push_subscription')).toEqual([{ p_device_id: 'dev-9', p_endpoint: null }]);
  });
});

test('on a phone the inbox and settings fit the bottom sheet', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await open(page, { mutate: seedNotices });
  await openInbox(page);
  const box = await page.locator('#livePanel').boundingBox();
  const row = await page.locator('.live-notice').first().boundingBox();
  expect(row.x).toBeGreaterThanOrEqual(box.x);
  expect(row.x + row.width).toBeLessThanOrEqual(box.x + box.width + 1);
  await page.locator('.live-inbox-view .live-back').click();
  await page.getByRole('button', { name: 'Notification settings' }).click();
  const scrollWidth = await page.locator('.live-settings-scroll').evaluate((n) => n.scrollWidth - n.clientWidth);
  expect(scrollWidth).toBeLessThanOrEqual(1);
});
