import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { USERS } from '../fixtures/dataset.mjs';
import { DAF, T1, T2, T3, open, openPanel, cards, callsTo } from '../support/live-chaburah.mjs';

// Cloud Chaburah Live, phase 2: finding discussions (search, filters), following the reader's
// place, what is new, markers on the printed daf, and the other reading pages.

const pageMap91a = JSON.parse(readFileSync(new URL('../fixtures/pagemap-chullin-91a.json', import.meta.url), 'utf8'));
// The page map as the app holds it: paragraph refs in their dotted form.
const boxes91a = pageMap91a.wordBoxes.map((box) => ({ ...box, ref: box.ref.replace(':', '.') }));

const first = (page) => cards(page).first();

test.describe('Search', () => {
  test('a word from a question narrows the list at once, a word from the conversation a moment later', async ({ page }) => {
    await open(page);
    await openPanel(page);
    await page.locator('.live-search').fill('distinction');
    await expect(cards(page)).toHaveCount(1);
    await expect(first(page)).toContainText('Can anyone explain the distinction?');
    // "Mishnah" is only in a reply to the other thread: the database finds it.
    await page.locator('.live-search').fill('Mishnah');
    await expect(cards(page)).toHaveCount(1, { timeout: 5000 });
    await expect(first(page)).toContainText('Why does the Gemara start here?');
    await page.locator('.live-search').fill('');
    await expect(cards(page)).toHaveCount(2);
  });

  test('Hebrew is found with or without vowel points', async ({ page }) => {
    await open(page);
    await openPanel(page);
    await page.locator('.live-search').fill('תָּנוּ רַבָּנַן');
    await expect(cards(page)).toHaveCount(1);
    await expect(first(page).locator('.live-card-quote')).toHaveText('תנו רבנן ארבעה');
  });

  test('nothing found says so, and a wildcard is searched for, not obeyed', async ({ page }) => {
    await open(page);
    await openPanel(page);
    await page.locator('.live-search').fill('zzzz');
    await expect(page.locator('.live-empty')).toContainText('Nothing found for “zzzz”');
    await page.locator('.live-search').fill('%');
    await expect(page.locator('.live-empty')).toContainText('Nothing found');
    const queries = await page.evaluate(() => (window.__DAFSYNC_TEST_QUERIES__ || []).length);
    expect(queries).toBeGreaterThan(0);
  });

  test('changing daf clears the search', async ({ page }) => {
    await open(page);
    await openPanel(page);
    await page.locator('.live-search').fill('distinction');
    await expect(cards(page)).toHaveCount(1);
    await page.evaluate(() => { state.browsePageRef = 'Chullin 90a'; });
    await expect(page.locator('.live-search')).toHaveValue('', { timeout: 5000 });
    await expect(first(page)).toContainText('Elsewhere');
  });
});

test.describe('Filters', () => {
  test('following, mine and the way each looks when empty', async ({ page }) => {
    await open(page);
    await openPanel(page);
    await page.locator('.live-filter[data-filter="following"]').click();
    await expect(page.locator('.live-empty')).toContainText('not following any discussion');
    await page.locator('.live-filter[data-filter="mine"]').click();
    await expect(page.locator('.live-empty')).toContainText('not asked or posted');
    await page.locator('.live-filter[data-filter="all"]').click();
    await expect(cards(page)).toHaveCount(2);
    await expect(page.locator('.live-filter[data-filter="all"]')).toHaveAttribute('aria-pressed', 'true');
  });

  test('following shows what you followed, mine shows what you asked or posted in', async ({ page }) => {
    await open(page, { user: USERS.author });
    await openPanel(page);
    await page.locator('.live-filter[data-filter="mine"]').click();
    await expect(cards(page)).toHaveCount(2);
    await cards(page).first().click();
    await page.getByRole('button', { name: 'Follow this discussion' }).click();
    await page.getByRole('button', { name: 'Back to the discussions' }).click();
    await page.locator('.live-filter[data-filter="following"]').click();
    await expect(cards(page)).toHaveCount(1);
  });

  test('filters combine with a search', async ({ page }) => {
    await open(page, { user: USERS.author });
    await openPanel(page);
    await page.locator('.live-filter[data-filter="mine"]').click();
    await page.locator('.live-search').fill('distinction');
    await expect(cards(page)).toHaveCount(1);
    await page.locator('.live-search').fill('zzzz');
    await expect(cards(page)).toHaveCount(0);
  });
});

test.describe('Near my place', () => {
  const at = (page, segment) => page.evaluate((seg) => {
    state.textSelection = { anchorIndex: -1, runs: [{ ref: `Chullin 89a.${seg}`, start: 0, end: 1 }] };
  }, segment);

  test('"Here" marks discussions about the passage you are at, and filters to them', async ({ page }) => {
    await open(page);
    await at(page, 2);
    await openPanel(page);
    await expect(page.locator('.live-card', { hasText: 'Can anyone explain the distinction?' }).locator('.live-badge-here')).toHaveText('Here');
    await expect(page.locator('.live-card', { hasText: 'Why does the Gemara start here?' }).locator('.live-badge-here')).toHaveCount(0);
    await page.locator('.live-filter[data-filter="here"]').click();
    await expect(cards(page)).toHaveCount(1);
    await expect(first(page)).toContainText('Can anyone explain the distinction?');
  });

  test('with "Follow my place" on, the list re-orders by itself when you move on; off, it stays', async ({ page }) => {
    await open(page);
    await at(page, 1);
    await openPanel(page);
    await expect(first(page)).toContainText('Why does the Gemara start here?');
    // Nothing touched for a while, and the reader has moved to the second paragraph.
    await page.evaluate(() => { window.DafLive._state.touchedAt = 0; });
    await at(page, 2);
    await expect(first(page)).toContainText('Can anyone explain the distinction?', { timeout: 6000 });

    await page.locator('.live-option', { hasText: 'Follow my place' }).locator('input').uncheck();
    expect(await page.evaluate(() => localStorage.getItem('dafsync.live.followPlace'))).toBe('0');
    await page.evaluate(() => { window.DafLive._state.touchedAt = 0; });
    await at(page, 1);
    await page.waitForTimeout(3500);
    await expect(first(page)).toContainText('Can anyone explain the distinction?');
  });

  test('the list is left alone while the reader is using it', async ({ page }) => {
    await open(page);
    await at(page, 1);
    await openPanel(page);
    await page.locator('.live-search').fill('a'); // touched just now
    await page.locator('.live-search').fill('');
    await at(page, 2);
    await page.waitForTimeout(3500);
    await expect(first(page)).toContainText('Why does the Gemara start here?');
  });

  test('the setting is remembered', async ({ page }) => {
    await open(page);
    await openPanel(page);
    await page.locator('.live-option', { hasText: 'Follow my place' }).locator('input').uncheck();
    await page.reload();
    await expect.poll(() => page.evaluate(() => Boolean(window.DafLive))).toBe(true);
    await openPanel(page);
    await expect(page.locator('.live-option', { hasText: 'Follow my place' }).locator('input')).not.toBeChecked();
  });
});

test.describe('What is new', () => {
  const unread = (rows) => ({ init: (value) => { window.__LIVE_UNREAD__ = value; }, initArg: rows });

  test('each followed discussion shows how many new messages wait, and the button the total', async ({ page }) => {
    await open(page, { ...unread([
      { thread_id: '10000000-0000-4000-8000-000000000002', daf_ref_key: 'Chullin-89a', unread: 3 },
      { thread_id: '10000000-0000-4000-8000-000000000003', daf_ref_key: 'Chullin-90a', unread: 4 },
    ]) });
    await expect(page.locator('.live-toggle-new')).toHaveText('7 new');
    await openPanel(page);
    await expect(page.locator('.live-card', { hasText: 'Can anyone explain the distinction?' }).locator('.live-unread')).toHaveText('3 new');
    await expect(page.locator('.live-card', { hasText: 'Why does the Gemara start here?' }).locator('.live-unread')).toHaveCount(0);
  });

  test('opening a discussion clears its count', async ({ page }) => {
    await open(page, { ...unread([{ thread_id: '10000000-0000-4000-8000-000000000002', daf_ref_key: 'Chullin-89a', unread: 3 }]) });
    await openPanel(page);
    await page.locator('.live-card', { hasText: 'Can anyone explain the distinction?' }).click();
    await expect(page.locator('.live-chat-view')).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__DAFSYNC_TEST_DB__.live_read_state.length)).toBe(1);
    await expect(page.locator('.live-toggle-new')).toBeHidden();
    await page.getByRole('button', { name: 'Back to the discussions' }).click();
    await expect(page.locator('.live-unread')).toHaveCount(0);
  });

  test('without the database function the page falls back to a plain "New" marker', async ({ page }) => {
    await open(page, {
      init: () => { window.__LIVE_UNREAD_MISSING__ = true; },
      mutate: (db) => { db.live_thread_follows = [{ user_id: USERS.ordinary.id, thread_id: '10000000-0000-4000-8000-000000000002' }]; },
    });
    await openPanel(page);
    await expect(page.locator('.live-toggle-new')).toBeHidden();
    await expect(page.locator('.live-card', { hasText: 'Can anyone explain the distinction?' }).locator('.live-unread')).toHaveText('New');
  });

  test('signed out there is nothing to count', async ({ page }) => {
    await open(page, { user: null, ...unread([{ thread_id: 'x', daf_ref_key: 'Chullin-89a', unread: 9 }]) });
    await openPanel(page);
    await expect(page.locator('.live-toggle-new')).toBeHidden();
  });
});

test.describe('Markers on the printed daf', () => {
  const ids = { a: '20000000-0000-4000-8000-00000000000a', b: '20000000-0000-4000-8000-00000000000b', c: '20000000-0000-4000-8000-00000000000c' };
  const thread = (id, ref, start, end, preview) => ({
    id, author_id: USERS.author.id, author_display_name: 'Author Two', daf_ref_key: 'Chullin-91a', segment_ref: ref,
    word_ranges: [{ ref, start, end }], quoted_text: 'תנו רבנן', anchor_segment: Number(ref.split('.')[1]), anchor_word: start,
    preview, message_count: 2, status: 'open', answer_message_id: null, hidden: false,
    created_at: new Date().toISOString(), last_message_at: new Date().toISOString(),
  });
  const seed91 = (db) => {
    db.live_threads = [
      thread(ids.a, 'Chullin 91a.1', 0, 2, 'First question on the opening words'),
      thread(ids.b, 'Chullin 91a.1', 1, 3, 'Second question, same few words'),
      thread(ids.c, 'Chullin 91a.10', 4, 6, 'A question far below'),
    ];
    db.live_messages = db.live_threads.map((t, i) => ({
      id: `mk-${i}`, seq: i + 1, thread_id: t.id, author_id: USERS.author.id, author_display_name: 'Author Two', body: t.preview,
      quoted_message_id: null, created_at: t.created_at, edited_at: null, deleted_at: null, hidden: false,
    }));
  };
  const show = async (page) => {
    await page.evaluate((boxes) => {
      // The test page has no scan image, so give the page a height for the markers to spread over.
      document.getElementById('vilnaPageWrap').style.height = '1200px';
      state.vilnaPageMap = { wordBoxes: boxes, textBlock: null };
      window.DafLive.renderMarkers();
    }, boxes91a);
  };
  const markers = (page) => page.locator('#liveMarkersOverlay .live-marker');

  test('overlapping discussions share one marker with a count; a lone one has none', async ({ page }) => {
    await open(page, { url: '/browse/?ref=Chullin%2091a', mutate: seed91 });
    await expect.poll(() => page.evaluate(() => window.DafLive._state.threads.length)).toBe(3);
    await show(page);
    await expect(markers(page)).toHaveCount(2);
    await expect(page.locator('#liveMarkersOverlay .live-marker-count')).toHaveText('2');
    await expect(markers(page).first()).toHaveAttribute('aria-label', '2 live discussions on these words');
    await expect(markers(page).last()).toHaveAttribute('aria-label', 'A live discussion on these words');
  });

  test('a lone marker opens its discussion; a shared one narrows the list, with a way back', async ({ page }) => {
    await open(page, { url: '/browse/?ref=Chullin%2091a', mutate: seed91 });
    await expect.poll(() => page.evaluate(() => window.DafLive._state.threads.length)).toBe(3);
    await show(page);
    await markers(page).last().click();
    await expect(page.locator('.live-chat-view')).toBeVisible();
    await expect(page.locator('.live-message').first()).toContainText('A question far below');
    await page.getByRole('button', { name: 'Back to the discussions' }).click();
    await markers(page).first().click();
    await expect(page.locator('.live-banner')).toContainText('Showing the 2 discussions');
    await expect(cards(page)).toHaveCount(2);
    await page.getByRole('button', { name: 'Show all' }).click();
    await expect(cards(page)).toHaveCount(3);
  });

  test('markers can be switched off, and stay off', async ({ page }) => {
    await open(page, { url: '/browse/?ref=Chullin%2091a', mutate: seed91 });
    await expect.poll(() => page.evaluate(() => window.DafLive._state.threads.length)).toBe(3);
    await show(page);
    await openPanel(page);
    await page.locator('.live-option', { hasText: 'Markers on the daf' }).locator('input').uncheck();
    await expect(page.locator('#liveMarkersOverlay')).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('dafsync.live.markers'))).toBe('0');
    await page.locator('.live-option', { hasText: 'Markers on the daf' }).locator('input').check();
    await expect(markers(page)).toHaveCount(2);
  });

  test('the layer takes no clicks except on a bubble, and sits among the page overlays', async ({ page }) => {
    await open(page, { url: '/browse/?ref=Chullin%2091a', mutate: seed91 });
    await expect.poll(() => page.evaluate(() => window.DafLive._state.threads.length)).toBe(3);
    await show(page);
    await expect(page.locator('#liveMarkersOverlay')).toHaveCSS('pointer-events', 'none');
    await expect(markers(page).first()).toHaveCSS('pointer-events', 'auto');
    expect(await page.evaluate(() => document.getElementById('liveMarkersOverlay').parentElement.id)).toBe('vilnaPageWrap');
  });

  test('no markers for someone who is not offered the feature, or on a daf with no discussions', async ({ page }) => {
    await open(page, { url: '/browse/?ref=Chullin%2091a', audience: 'admins', mutate: seed91 });
    await page.waitForTimeout(400);
    await show(page);
    await expect(page.locator('#liveMarkersOverlay')).toHaveCount(0);
  });
});

test.describe('The other reading pages', () => {
  for (const [name, url] of [['player', '/player/?ref=Chullin%2089a'], ['watch', '/watch/?ref=Chullin%2089a']]) {
    test(`${name}: the same panel, on the same daf`, async ({ page }) => {
      await open(page, { url });
      await expect(page.locator('.live-toggle')).toBeVisible();
      await openPanel(page);
      await expect(page.locator('.live-title')).toHaveText('Chullin 89a');
      await expect(cards(page)).toHaveCount(2);
      await cards(page).first().click();
      await expect(page.locator('.live-chat-view')).toBeVisible();
      await page.locator('.live-input').fill('From this page');
      await page.locator('.live-send').click();
      await expect(page.locator('.live-message.live-mine')).toHaveCount(1);
      expect((await callsTo(page, 'live_post_message')).length).toBe(1);
    });
  }

  test('player: a recording of another rabbi shares the daf\'s discussions', async ({ page }) => {
    await open(page, { url: '/player/?ref=Chullin%2089a&maggid=bornstein' });
    await openPanel(page);
    await expect(page.locator('.live-title')).toHaveText('Chullin 89a');
    await expect(cards(page)).toHaveCount(2);
  });
});
