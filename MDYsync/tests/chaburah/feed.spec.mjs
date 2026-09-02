import { test, expect } from '@playwright/test';
import { preparePage, failOnPageError } from '../support/harness.mjs';
import { buildDatabase, sessionFor, USERS, NOTE_IDS } from '../fixtures/dataset.mjs';

// Baseline coverage for the Cloud Chaburah feed as it exists today
// (chaburah.js + chaburah/index.html). These assertions describe CURRENT
// behaviour so the Phase 3 rewrite has something to regress against; where
// current behaviour is a known defect it is asserted and cross-referenced to
// the audit rather than quietly accepted as correct.

const CARD = '.chaburah-card';

test.describe('Cloud Chaburah feed', () => {
  test('loads signed out with no page errors and lists public notes', async ({ page }) => {
    const errors = failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/chaburah/');

    await expect(page.locator(CARD).first()).toBeVisible();
    const count = await page.locator(CARD).count();
    // 8 public notes in the fixture; the 9th is private.
    expect(count).toBe(8);
    expect(errors).toEqual([]);
  });

  test('never renders a private note in the public feed', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await page.goto('/chaburah/');
    await expect(page.locator(CARD).first()).toBeVisible();

    await expect(page.locator('body')).not.toContainText('PRIVATE-CANARY');
    const ids = await page.locator(CARD).evaluateAll((cards) => cards.map((c) => c.dataset.id));
    expect(ids).not.toContain(NOTE_IDS.privateNote);
  });

  test('orders the Latest view newest first', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/chaburah/');
    await expect(page.locator(CARD).first()).toBeVisible();

    const ids = await page.locator(CARD).evaluateAll((cards) => cards.map((c) => c.dataset.id));
    // legacySegmentOnly is the most recent public note in the fixture.
    expect(ids[0]).toBe(NOTE_IDS.legacySegmentOnly);
  });

  test('category filter narrows the feed', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/chaburah/');
    await expect(page.locator(CARD).first()).toBeVisible();

    await page.selectOption('#chaburahCategoryFilter', 'question');
    await expect(page.locator(CARD)).toHaveCount(2);
  });

  test('Following prompts a signed-out reader to sign in', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/chaburah/');
    await expect(page.locator(CARD).first()).toBeVisible();

    await page.click('#chaburahViewSwitch button[data-view="following"]');
    await expect(page.locator('#chaburahFeedList')).toContainText('Sign in to see notes');
    await expect(page.locator('#chaburahLoadMoreButton')).toBeHidden();
  });

  test('Following lists only followed threads for a signed-in reader', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await page.goto('/chaburah/');
    await expect(page.locator(CARD).first()).toBeVisible();

    await page.click('#chaburahViewSwitch button[data-view="following"]');
    await expect(page.locator(CARD)).toHaveCount(1);
    await expect(page.locator(CARD).first()).toHaveAttribute('data-id', NOTE_IDS.deepThread);
  });

  test('This daf without a ?ref= explains what to do instead of showing nothing', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/chaburah/');
    await expect(page.locator(CARD).first()).toBeVisible();

    await page.click('#chaburahViewSwitch button[data-view="this-daf"]');
    await expect(page.locator('#chaburahFeedList')).toContainText('Open a daf first');
  });

  test('This daf with a ?ref= narrows to that daf', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/chaburah/?ref=Chullin%2089a');
    await expect(page.locator(CARD).first()).toBeVisible();

    await page.click('#chaburahViewSwitch button[data-view="this-daf"]');
    const keys = await page.locator(CARD).evaluateAll((cards) => cards.map((c) => c.dataset.dafRefKey));
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys)).toEqual(new Set(['Chullin-89a']));
  });

  test('Most helpful ranks by reaction count and shows the count', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/chaburah/');
    await expect(page.locator(CARD).first()).toBeVisible();

    await page.click('#chaburahViewSwitch button[data-view="most-helpful"]');
    // Only the two reacted-to notes qualify; the 2-reaction one ranks first.
    await expect(page.locator(CARD)).toHaveCount(2);
    await expect(page.locator(CARD).first()).toHaveAttribute('data-id', NOTE_IDS.singleWordRange);
    await expect(page.locator(CARD).first()).toContainText('2 reactions');
  });

  test('Unanswered excludes notes that already have replies', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/chaburah/');
    await expect(page.locator(CARD).first()).toBeVisible();

    await page.click('#chaburahViewSwitch button[data-view="unanswered"]');
    const ids = await page.locator(CARD).evaluateAll((cards) => cards.map((c) => c.dataset.id));
    expect(ids).toContain(NOTE_IDS.noReplies);
    expect(ids).not.toContain(NOTE_IDS.deepThread);
    expect(ids).not.toContain(NOTE_IDS.largeThread);
  });

  test('surfaces a load failure instead of an empty feed', async ({ page }) => {
    await preparePage(page, {
      user: null,
      control: { failures: { 'line_notes:select': { message: 'boom' } } },
    });
    await page.goto('/chaburah/');

    await expect(page.locator('#chaburahFeedList')).toContainText('Could not load the feed.');
    await expect(page.locator('#chaburahLoadMoreButton')).toBeHidden();
  });

  test('paginates with Load more', async ({ page }) => {
    const db = buildDatabase();
    // 25 public notes -> one full page of 20 plus a second page.
    for (let i = 0; i < 17; i += 1) {
      db.line_notes.push({
        id: `f${String(i).padStart(7, '0')}-0000-4000-8000-000000000000`,
        author_id: USERS.author.id,
        author_display_name: USERS.author.display_name,
        daf_ref_key: 'Chullin-89a',
        segment_ref: 'Chullin 89a.1',
        body: `Filler note ${i}.`,
        hidden: false,
        is_private: false,
        created_at: new Date(Date.parse('2026-09-02T00:00:00.000Z') + i * 1000).toISOString(),
        start_word: null, end_word: null, selected_text: null, word_ranges: null,
        mentioned_user_ids: [], category: null, video_timestamp_seconds: null, is_demo: false,
      });
    }
    await preparePage(page, { user: null, db });
    await page.goto('/chaburah/');

    await expect(page.locator(CARD)).toHaveCount(20);
    await expect(page.locator('#chaburahLoadMoreButton')).toBeVisible();
    await page.click('#chaburahLoadMoreButton');
    await expect(page.locator(CARD)).toHaveCount(25);
    await expect(page.locator('#chaburahLoadMoreButton')).toBeHidden();
  });

  test('View thread opens the shared note dialog', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await page.goto('/chaburah/');
    await expect(page.locator(CARD).first()).toBeVisible();

    await page.locator(CARD).first().locator('.chaburah-view-thread').click();
    await expect(page.locator('#noteDialog')).toBeVisible();
  });
});

test.describe('Cloud Chaburah feed — signed-in transitions', () => {
  test('re-renders when the session resolves after load', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/chaburah/');
    await expect(page.locator(CARD).first()).toBeVisible();

    await page.click('#chaburahViewSwitch button[data-view="following"]');
    await expect(page.locator('#chaburahFeedList')).toContainText('Sign in to see notes');

    await page.evaluate((session) => window.__DAFSYNC_TEST_CLIENT__.__setSession(session), sessionFor(USERS.ordinary));
    await expect(page.locator(CARD)).toHaveCount(1);
  });
});
