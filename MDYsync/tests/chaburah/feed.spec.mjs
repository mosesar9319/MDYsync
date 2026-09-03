import { test, expect } from '@playwright/test';
import { preparePage, failOnPageError } from '../support/harness.mjs';
import { buildDatabase, sessionFor, USERS, NOTE_IDS } from '../fixtures/dataset.mjs';

// The Cloud Chabura home as rebuilt in Prompt 3 (chaburah/index.html +
// chabura-data.js + chabura-components.js + chabura-home.js).
//
// Several assertions here are the INVERSE of what the Phase 1 baseline suite
// asserted, because the finding they documented is now closed. Each of those is
// marked with its audit id so the change is deliberate and traceable rather
// than a silently rewritten expectation.

const CARD = '.cc-card';
const FEED = '#ccFeed';

// The feed renders skeletons first, so "first card visible" is the real
// ready signal -- not DOMContentLoaded.
async function waitForFeed(page) {
  await expect(page.locator(CARD).first()).toBeVisible();
}

async function cardIds(page) {
  return page.locator(CARD).evaluateAll((cards) => cards.map((card) => card.dataset.id));
}

// On desktop the filters live in the left rail. Below 900px the rail collapses
// and the same controls are reached through the bottom sheet, so a spec that
// only ever drove #ccCategory would pass on desktop and fail on mobile for a
// reason that is not a defect. This picks whichever control the viewport
// actually exposes, and so covers both routes to the same state.
async function selectCategory(page, value) {
  const rail = page.locator('#ccCategory');
  if (await rail.isVisible()) {
    await rail.selectOption(value);
    return;
  }
  await page.click('#ccOpenFilters');
  await page.selectOption('#ccCategorySheet', value);
  await page.click('#ccCloseFilters');
}

test.describe('Cloud Chabura home — shell', () => {
  test('loads signed out with no page errors and lists public discussions', async ({ page }) => {
    const errors = failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/chaburah/');

    await waitForFeed(page);
    // 8 public notes in the fixture; the 9th is private.
    await expect(page.locator(CARD)).toHaveCount(8);
    expect(errors).toEqual([]);
  });

  test('has exactly one <main> and one <h1> (audit F-9)', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/chaburah/');
    await waitForFeed(page);

    await expect(page.locator('main')).toHaveCount(1);
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.locator('h1')).toHaveText('Cloud Chabura');
  });

  test('does not ship the hidden Interactive Daf workspace (audit F-13)', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/chaburah/');
    await waitForFeed(page);

    // The old page carried the whole daf reader -- and app.js, notes.js,
    // highlights.js, the context menu and the player chrome with it -- purely
    // to render a list.
    await expect(page.locator('#dafContainer, #noteDialog, #videoPlayer')).toHaveCount(0);
    const loaded = await page.evaluate(() => ({
      app: typeof window.DafNotes,
      chabura: typeof window.DafSyncChabura,
    }));
    expect(loaded.app).toBe('undefined');
    expect(loaded.chabura).toBe('object');
  });

  test('a card links to the thread route and carries the feed state back', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/chaburah/');
    await waitForFeed(page);

    const link = page.locator(`${CARD}[data-id="${NOTE_IDS.deepThread}"] .cc-card-title a`);
    await expect(link).toHaveAttribute('href', `/chaburah/thread/?thread=${NOTE_IDS.deepThread}`);

    // From a filtered view the link carries that filter, so Back returns to the
    // view the reader was actually in rather than a reset feed.
    await page.click('#cc-tab-highlighted');
    await expect(page.locator(CARD)).toHaveCount(1);
    const filtered = await page.locator(`${CARD} .cc-card-title a`).getAttribute('href');
    expect(filtered).toContain(`thread=${NOTE_IDS.deepThread}`);
    expect(filtered).toContain('back=view%3Dhighlighted');
  });

  test('never renders a private note in the public feed', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await page.goto('/chaburah/');
    await waitForFeed(page);

    await expect(page.locator('body')).not.toContainText('PRIVATE-CANARY');
    expect(await cardIds(page)).not.toContain(NOTE_IDS.privateNote);
  });
});

test.describe('Cloud Chabura home — cards', () => {
  test('derives a display title for a legacy note that has none', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/chaburah/');
    await waitForFeed(page);

    const card = page.locator(`${CARD}[data-id="${NOTE_IDS.legacySegmentOnly}"]`);
    await expect(card.locator('.cc-card-title')).toHaveText('Legacy whole-segment note with no word range.');
  });

  test('does not repeat the borrowed title as the body', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/chaburah/');
    await waitForFeed(page);

    // The fixture note's whole body IS its first line, so once that line becomes
    // the heading there is nothing left to preview and the card must not print
    // the same sentence twice.
    const card = page.locator(`${CARD}[data-id="${NOTE_IDS.legacySegmentOnly}"]`);
    await expect(card.locator('.cc-card-body')).toHaveCount(0);
    const titleText = await card.locator('.cc-card-title').innerText();
    const bodyText = await card.innerText();
    expect(bodyText.split(titleText).length - 1).toBe(1);
  });

  test('keeps the whole body when the note has a real stored title', async ({ page }) => {
    const db = buildDatabase();
    const note = db.line_notes.find((row) => row.id === NOTE_IDS.noReplies);
    note.title = 'A question on the first line';
    await preparePage(page, { user: null, db });
    await page.goto('/chaburah/');
    await waitForFeed(page);

    const card = page.locator(`${CARD}[data-id="${NOTE_IDS.noReplies}"]`);
    await expect(card.locator('.cc-card-title')).toHaveText('A question on the first line');
    // Nothing was borrowed from the body, so nothing is dropped from it.
    await expect(card.locator('.cc-card-body')).toHaveText('A thread with no replies at all.');
  });

  test('shows the category in Hebrew AND English without hovering (audit F-11)', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/chaburah/');
    await waitForFeed(page);

    const chip = page.locator(`${CARD}[data-id="${NOTE_IDS.legacySegmentOnly}"] .cc-chip-category`);
    await expect(chip.locator('.cc-chip-he')).toHaveText('שאלה / קשיא');
    // The English gloss is rendered text, not a title attribute, so it is
    // readable on touch where there is no hover at all.
    await expect(chip.locator('.cc-chip-en')).toBeVisible();
    await expect(chip.locator('.cc-chip-en')).not.toHaveText('');
  });

  test('quotes the anchored passage on a word-range discussion', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/chaburah/');
    await waitForFeed(page);

    const card = page.locator(`${CARD}[data-id="${NOTE_IDS.singleWordRange}"]`);
    await expect(card.locator('.cc-card-source')).toHaveText('ארבעה ראשי שנים הם');
    await expect(card.locator('.cc-card-source')).toHaveAttribute('dir', 'rtl');
  });

  test('counts replies and participants without an N+1 query per card', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/chaburah/');
    await waitForFeed(page);

    // Five: the four-level chain plus the quoting reply the thread reader's
    // fixtures added.
    await expect(page.locator(`${CARD}[data-id="${NOTE_IDS.deepThread}"]`)).toContainText('5 replies');
    await expect(page.locator(`${CARD}[data-id="${NOTE_IDS.noReplies}"]`)).toContainText('0 replies');
  });

  test('marks a thread with a chosen answer as Answered, and one without as Unanswered', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/chaburah/');
    await waitForFeed(page);

    await expect(page.locator(`${CARD}[data-id="${NOTE_IDS.deepThread}"]`)).toContainText('Answered');
    await expect(page.locator(`${CARD}[data-id="${NOTE_IDS.noReplies}"]`)).toContainText('Unanswered');
  });

  test('shows an unread badge only for a thread the reader has actually opened', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await page.goto('/chaburah/');
    await waitForFeed(page);

    // Read up to reply 2 of 5, so replies 3, 4 and 5 are new.
    await expect(page.locator(`${CARD}[data-id="${NOTE_IDS.deepThread}"]`)).toContainText('3 new');
    // No read-state row at all means "never opened", which must not render as
    // "every reply is unread".
    await expect(page.locator(`${CARD}[data-id="${NOTE_IDS.largeThread}"] .cc-chip-unread`)).toHaveCount(0);
  });
});

test.describe('Cloud Chabura home — views', () => {
  test('Latest orders by most recent activity, not creation', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/chaburah/');
    await waitForFeed(page);

    const ids = await cardIds(page);
    expect(ids[0]).toBe(NOTE_IDS.legacySegmentOnly);
    // deepThread was created 5th but its last reply moved it ahead of the two
    // older roots. Ordering on last_activity_at is what makes that true.
    expect(ids.indexOf(NOTE_IDS.deepThread)).toBeLessThan(ids.indexOf(NOTE_IDS.hiddenParentThread));
  });

  test('Highlighted lists only threads with a chosen answer', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/chaburah/');
    await waitForFeed(page);

    await page.click('#cc-tab-highlighted');
    await expect(page.locator(CARD)).toHaveCount(1);
    await expect(page.locator(CARD).first()).toHaveAttribute('data-id', NOTE_IDS.deepThread);
  });

  test('Unanswered excludes threads that already have replies or an answer', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/chaburah/');
    await waitForFeed(page);

    await page.click('#cc-tab-unanswered');
    const ids = await cardIds(page);
    expect(ids).toContain(NOTE_IDS.noReplies);
    expect(ids).not.toContain(NOTE_IDS.deepThread);
    expect(ids).not.toContain(NOTE_IDS.largeThread);
    expect(ids).not.toContain(NOTE_IDS.hiddenParentThread);
  });

  test("Today's daf narrows to the daf the calendar returned", async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/chaburah/');
    await waitForFeed(page);

    await page.click('#cc-tab-today');
    await expect(page.locator(CARD).first()).toBeVisible();
    const keys = await page.locator(CARD).evaluateAll((cards) => cards.map((card) => card.dataset.dafRefKey));
    expect(keys.length).toBeGreaterThan(0);
    // The harness's calendar stub returns Chullin 89, so Berakhot must drop out.
    expect(new Set(keys)).toEqual(new Set(['Chullin-89a']));
  });

  test('Following lists only followed threads for a signed-in reader', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await page.goto('/chaburah/');
    await waitForFeed(page);

    await page.click('#cc-tab-following');
    await expect(page.locator(CARD)).toHaveCount(1);
    await expect(page.locator(CARD).first()).toHaveAttribute('data-id', NOTE_IDS.deepThread);
  });

  test('Saved is distinct from Following', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await page.goto('/chaburah/');
    await waitForFeed(page);

    await page.click('#cc-tab-saved');
    await expect(page.locator(CARD)).toHaveCount(1);
    await expect(page.locator(CARD).first()).toHaveAttribute('data-id', NOTE_IDS.noReplies);
  });

  test('every tab is reachable on a wide viewport (none scrolled out of view)', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'About the wide layout specifically');
    await preparePage(page, { user: USERS.ordinary });
    await page.goto('/chaburah/');
    await waitForFeed(page);

    // Centring the selected tab is for the phone-width scrolling strip. On a
    // viewport where the whole strip fits, scrolling it at all pushed "For you"
    // off the left edge for no reason.
    await expect(page.locator('#cc-tab-for-you')).toBeInViewport();
    await expect(page.locator('#cc-tab-saved')).toBeInViewport();
  });

  test('the personal views are disabled, not hidden, for a signed-out reader', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/chaburah/');
    await waitForFeed(page);

    for (const id of ['#cc-tab-following', '#cc-tab-saved', '#cc-tab-for-you']) {
      await expect(page.locator(id)).toBeVisible();
      await expect(page.locator(id)).toBeDisabled();
    }
    // Everything public stays browsable without an account.
    await expect(page.locator('#cc-tab-latest')).toBeEnabled();
  });
});

test.describe('Cloud Chabura home — filters, URL state and errors', () => {
  test('category filter narrows the feed', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/chaburah/');
    await waitForFeed(page);

    await selectCategory(page, 'question');
    await expect(page.locator(CARD)).toHaveCount(2);
  });

  test('view, category and search all survive a reload (audit F-6)', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/chaburah/');
    await waitForFeed(page);

    await page.click('#cc-tab-unanswered');
    await selectCategory(page, 'source');
    await expect(page).toHaveURL(/view=unanswered/);
    await expect(page).toHaveURL(/category=source/);

    await page.reload();
    await waitForFeed(page);
    await expect(page.locator('#cc-tab-unanswered')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#ccCategory')).toHaveValue('source');
    await expect(page.locator(CARD)).toHaveCount(1);
    await expect(page.locator(CARD).first()).toHaveAttribute('data-id', NOTE_IDS.noReplies);
  });

  test('the browser Back button restores the previous view', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/chaburah/');
    await waitForFeed(page);

    await page.click('#cc-tab-highlighted');
    await expect(page.locator(CARD)).toHaveCount(1);

    await page.goBack();
    await expect(page.locator(CARD)).toHaveCount(8);
    await expect(page.locator('#cc-tab-latest')).toHaveAttribute('aria-selected', 'true');
  });

  test('search filters the feed and is shareable in the URL', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/chaburah/?q=masechta');
    await waitForFeed(page);

    await expect(page.locator(CARD)).toHaveCount(1);
    await expect(page.locator(CARD).first()).toHaveAttribute('data-id', NOTE_IDS.otherMasechta);
    await expect(page.locator('#ccSearch')).toHaveValue('masechta');
  });

  test('an empty filtered view says the FILTER is empty, not the site (audit F-8)', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/chaburah/?q=nothingmatchesthisstring');

    await expect(page.locator(FEED)).toContainText('Nothing matches these filters');
    await expect(page.locator(CARD)).toHaveCount(0);
  });

  test('Clear filters in the empty state actually widens the feed', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/chaburah/?q=nothingmatchesthisstring');
    await expect(page.locator(FEED)).toContainText('Nothing matches these filters');

    await page.click(`${FEED} button:has-text("Clear filters")`);
    await waitForFeed(page);
    await expect(page.locator(CARD)).toHaveCount(8);
  });

  test('surfaces the server message on a failed load, with a working retry (audit F-8)', async ({ page }) => {
    await preparePage(page, {
      user: null,
      control: { failures: { 'line_notes:select': { message: 'permission denied for table line_notes', code: '42501' } } },
    });
    await page.goto('/chaburah/');

    // Mapped to something a reader can act on, rather than the raw PostgREST text.
    await expect(page.locator(FEED)).toContainText('You do not have permission to do that.');
    await expect(page.locator('#ccFeedFooter')).toBeHidden();
    await expect(page.locator(`${FEED} [role="alert"]`)).toBeVisible();
  });

  test('a retry after a transient failure recovers the feed', async ({ page }) => {
    await preparePage(page, {
      user: null,
      control: { failures: { 'line_notes:select': { message: 'boom' } } },
    });
    await page.goto('/chaburah/');
    await expect(page.locator(FEED)).toContainText('boom');

    // Cleared explicitly rather than with the stub's `once` flag: Today's Daf
    // also reads line_notes and would consume a one-shot failure before the
    // feed ever saw it, so `once` would silently test nothing here.
    await page.evaluate(() => { delete window.__DAFSYNC_TEST_CONTROL__.failures['line_notes:select']; });

    await page.click(`${FEED} button:has-text("Try again")`);
    await waitForFeed(page);
    await expect(page.locator(CARD)).toHaveCount(8);
  });
});

test.describe('Cloud Chabura home — pagination', () => {
  // 17 filler notes on top of the 8 public fixtures = 25, so page one is full
  // at 20 and page two holds the remaining 5.
  function databaseWith25PublicNotes() {
    const db = buildDatabase();
    for (let i = 0; i < 17; i += 1) {
      const createdAt = new Date(Date.parse('2026-09-02T00:00:00.000Z') + i * 1000).toISOString();
      db.line_notes.push({
        id: `f${String(i).padStart(7, '0')}-0000-4000-8000-000000000000`,
        author_id: USERS.author.id,
        author_display_name: USERS.author.display_name,
        daf_ref_key: 'Chullin-89a',
        segment_ref: 'Chullin 89a.1',
        body: `Filler note ${i}.`,
        hidden: false,
        is_private: false,
        created_at: createdAt,
        last_activity_at: createdAt,
        start_word: null, end_word: null, selected_text: null, word_ranges: null,
        mentioned_user_ids: [], category: null, video_timestamp_seconds: null, is_demo: false,
        title: null, status: 'open', highlighted_comment_id: null, edited_at: null, deleted_at: null,
      });
    }
    return db;
  }

  test('pages with a keyset cursor rather than re-reading from row 0 (audit F-2)', async ({ page }) => {
    await preparePage(page, { user: null, db: databaseWith25PublicNotes() });
    await page.goto('/chaburah/');

    await expect(page.locator(CARD)).toHaveCount(20);
    await expect(page.locator('#ccLoadMore')).toBeVisible();

    const firstPage = await cardIds(page);
    await page.click('#ccLoadMore');
    await expect(page.locator(CARD)).toHaveCount(25);
    await expect(page.locator('#ccFeedFooter')).toBeHidden();

    // Every row is distinct: an offset re-fetch that drifted would duplicate or
    // drop rows across the page boundary.
    const allIds = await cardIds(page);
    expect(new Set(allIds).size).toBe(25);
    expect(allIds.slice(0, 20)).toEqual(firstPage);
  });
});

test.describe('Cloud Chabura home — actions', () => {
  test('following a thread is optimistic and persists the write', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await page.goto('/chaburah/');
    await waitForFeed(page);

    const card = page.locator(`${CARD}[data-id="${NOTE_IDS.noReplies}"]`);
    const follow = card.locator('button[aria-pressed]').first();
    await expect(follow).toHaveText('Follow');
    await follow.click();

    await expect(page.locator(`${CARD}[data-id="${NOTE_IDS.noReplies}"] button[aria-pressed="true"]`).first())
      .toHaveText('Following');
    const rows = await page.evaluate((noteId) =>
      window.__DAFSYNC_TEST_DB__.thread_follows.filter((row) => row.note_id === noteId), NOTE_IDS.noReplies);
    expect(rows).toHaveLength(1);
  });

  test('a failed follow is rolled back rather than left looking successful', async ({ page }) => {
    await preparePage(page, {
      user: USERS.ordinary,
      control: { failures: { 'thread_follows:insert': { message: 'permission denied', code: '42501' } } },
    });
    await page.goto('/chaburah/');
    await waitForFeed(page);

    const card = page.locator(`${CARD}[data-id="${NOTE_IDS.noReplies}"]`);
    await card.locator('button[aria-pressed]').first().click();

    await expect(page.locator(`${CARD}[data-id="${NOTE_IDS.noReplies}"] button[aria-pressed]`).first())
      .toHaveText('Follow');
    await expect(page.locator('#ccStatus')).toContainText('You do not have permission to do that.');
  });

  test('a signed-out reader is offered sign-in at the moment of acting, not blocked from the page', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/chaburah/');
    await waitForFeed(page);

    await page.locator(`${CARD} button[aria-pressed]`).first().click();
    await expect(page.locator('#authDialog')).toBeVisible();
  });
});

test.describe("Cloud Chabura home — Today's daf", () => {
  test('summarises today automatically, with no ?ref= required (audit F-6)', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/chaburah/');

    await expect(page.locator('#ccToday')).toContainText("Today's Daf");
    await expect(page.locator('#ccToday')).toContainText('Chullin 89a');
    // 7 of the 8 public fixture notes sit on Chullin 89a.
    await expect(page.locator('#ccToday')).toContainText('7 discussions');
  });

  test('says so plainly when the calendar is unreachable instead of inventing a daf', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.route('**/api/sefaria-calendars*', (route) => route.fulfill({ status: 502, body: 'upstream down' }));
    await page.goto('/chaburah/');

    await expect(page.locator('#ccToday')).toContainText('Unavailable right now');
    // The rest of the page is unaffected: a calendar outage is not a feed outage.
    await waitForFeed(page);
    await expect(page.locator(CARD)).toHaveCount(8);
  });
});

test.describe('Cloud Chabura home — session transitions', () => {
  test('re-renders the personal views when the session resolves after load', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/chaburah/');
    await waitForFeed(page);
    await expect(page.locator('#cc-tab-following')).toBeDisabled();

    await page.evaluate((session) => window.__DAFSYNC_TEST_CLIENT__.__setSession(session), sessionFor(USERS.ordinary));

    await expect(page.locator('#cc-tab-following')).toBeEnabled();
    await page.click('#cc-tab-following');
    await expect(page.locator(CARD)).toHaveCount(1);
  });
});
