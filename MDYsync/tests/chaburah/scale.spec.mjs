import { test, expect } from '@playwright/test';
import { preparePage, readTestQueries, resetTestQueries } from '../support/harness.mjs';
import { buildDatabase, withHugeThread, USERS, NOTE_IDS } from '../fixtures/dataset.mjs';

// Prompt 7 asks for measurement on 300- and 1,000-reply fixtures BEFORE
// considering virtualization, and for N+1 and excessive-DOM patterns to be
// fixed by what the numbers actually show. These specs are that measurement:
// they assert bounds rather than print numbers, so a regression fails the run
// instead of quietly slowing the page.

// Counts the queries the page actually issues. NOT by watching HTTP: the
// supabase stub is in-page, so no request ever leaves the browser and counting
// network traffic would measure zero and pass regardless. The stub records each
// read instead, which is the only way this assertion means anything.

test.describe('Scale — 320 replies', () => {
  test('renders a bounded page, not every reply', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await page.goto(`/chaburah/thread/?thread=${NOTE_IDS.largeThread}`);
    await expect(page.locator('.ct-reply').first()).toBeVisible();

    // BRANCH_PAGE_SIZE is 10; the other 310 are behind Load more.
    await expect(page.locator('.ct-reply')).toHaveCount(10);

    const nodes = await page.evaluate(() => document.querySelectorAll('*').length);
    // A page that rendered all 320 would be several thousand nodes heavier.
    expect(nodes).toBeLessThan(1200);
  });

  test('paging in more replies does not multiply queries per reply', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await page.goto(`/chaburah/thread/?thread=${NOTE_IDS.largeThread}`);
    await expect(page.locator('.ct-reply').first()).toBeVisible();

    await resetTestQueries(page);
    await page.click('#ctLoadMore');
    await expect(page.locator('.ct-reply')).toHaveCount(20);
    const queries = await readTestQueries(page);

    // One page of branches, one batch of descendants, and the batched
    // profile/reaction/saved lookups -- a constant, not one per reply. Ten more
    // replies appearing must not mean ten more queries.
    expect(queries.length).toBeLessThan(10);
    expect(queries.filter((table) => table === 'comments').length).toBeLessThanOrEqual(2);
  });
});

test.describe('Scale — 1000 replies', () => {
  test('opens promptly and renders a bounded page', async ({ page }) => {
    const { db, rootId } = withHugeThread(buildDatabase());
    await preparePage(page, { user: USERS.ordinary, db });

    const started = Date.now();
    await page.goto(`/chaburah/thread/?thread=${rootId}`);
    await expect(page.locator('.ct-reply').first()).toBeVisible();
    const elapsed = Date.now() - started;

    await expect(page.locator('.ct-reply')).toHaveCount(10);
    const nodes = await page.evaluate(() => document.querySelectorAll('*').length);
    expect(nodes).toBeLessThan(1200);
    // Generous, because CI machines vary; it catches an order-of-magnitude
    // regression, which is what virtualization would be a response to.
    expect(elapsed).toBeLessThan(15000);
  });

  test('the initial load is a constant number of queries, not one per reply', async ({ page }) => {
    const { db, rootId } = withHugeThread(buildDatabase());
    await preparePage(page, { user: USERS.ordinary, db });

    await page.goto(`/chaburah/thread/?thread=${rootId}`);
    await expect(page.locator('.ct-reply').first()).toBeVisible();
    const queries = await readTestQueries(page);

    // A thousand replies must cost the same handful of queries as five.
    expect(queries.length).toBeLessThan(20);
    // And no table may be queried once per reply.
    const perTable = queries.reduce((counts, table) => {
      counts[table] = (counts[table] || 0) + 1;
      return counts;
    }, {});
    Object.entries(perTable).forEach(([table, count]) => {
      expect(count, `${table} was queried ${count} times`).toBeLessThan(6);
    });
  });

  test('search over a thousand replies stays responsive and bounded', async ({ page }) => {
    const { db, rootId } = withHugeThread(buildDatabase());
    await preparePage(page, { user: USERS.ordinary, db });
    await page.goto(`/chaburah/thread/?thread=${rootId}`);
    await expect(page.locator('.ct-reply').first()).toBeVisible();

    await page.fill('#ctSearch', 'Scale reply number 900');
    await expect(page.locator('#ctStatus')).toContainText('in this discussion');
    // The match is found even though its branch was never in the first page.
    await expect(page.locator('.ct-reply.is-search-current')).toContainText('Scale reply number 900');
  });

  test('a thousand-reply thread still marks read only what was seen', async ({ page }) => {
    const { db, rootId } = withHugeThread(buildDatabase());
    await preparePage(page, { user: USERS.ordinary, db });
    await page.goto(`/chaburah/thread/?thread=${rootId}`);
    await expect(page.locator('.ct-reply').first()).toBeVisible();
    await page.waitForTimeout(4500);

    const calls = await page.evaluate(() => window.__DAFSYNC_TEST_CALLS__ || []);
    const write = calls.filter((c) => c.table === 'thread_read_state').pop();
    const sequence = write ? write.rows[0].last_read_sequence : 0;
    // Nowhere near 1000: only the handful actually on screen.
    expect(sequence).toBeLessThan(60);
  });
});
