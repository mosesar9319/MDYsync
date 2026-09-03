import { test, expect } from '@playwright/test';
import { preparePage, failOnPageError } from '../support/harness.mjs';
import { USERS, NOTE_IDS, buildDatabase } from '../fixtures/dataset.mjs';

// The generated-summary panel, and the non-AI related-discussions panel.
//
// What this file can and cannot prove is worth stating, because the difference
// is the whole security argument of Prompt 8:
//
//   * It CAN prove the client behaves — that the panel labels itself, that
//     every point renders its citations, that a withdrawn point shows no text,
//     and above all that every failure path leaves the discussion readable.
//
//   * It CANNOT prove authorization. The supabase stub has no RLS, so "a
//     reader cannot see a hidden summary" and "hiding a reply redacts the
//     points that cited it" are proved in supabase/tests/rls_authorization.sql
//     against a real Postgres, and the model-facing filtering is proved in
//     tests/functions/chabura-summary.test.mjs. This suite would pass either
//     way, which is exactly why those two exist.

const LARGE = `/chaburah/thread/?thread=${NOTE_IDS.largeThread}`;
const SHORT = `/chaburah/thread/?thread=${NOTE_IDS.noReplies}`;
const SUMMARY_ID = 'aa000000-0000-4000-8000-000000000001';

// A stored summary over the first two replies of the large thread, as the
// service role would have written it.
function seedSummary(db, overrides = {}) {
  const replies = db.comments
    .filter((row) => row.note_id === NOTE_IDS.largeThread)
    .sort((a, b) => a.activity_sequence - b.activity_sequence);

  db.thread_summaries = [{
    id: SUMMARY_ID,
    note_id: NOTE_IDS.largeThread,
    scope: 'thread',
    summary_version: 1,
    prompt_version: 'chabura-thread-v1',
    model_id: 'claude-opus-5',
    source_comment_ids: replies.slice(0, 2).map((row) => row.id),
    source_comment_count: 2,
    source_max_sequence: replies[1].activity_sequence,
    generated_at: '2026-09-02T09:30:00.000Z',
    generation_ms: 4200,
    stale: false,
    stale_reason: null,
    hidden: false,
    useful_count: 3,
    not_useful_count: 1,
    ...overrides,
  }];

  db.thread_summary_points_public = [
    {
      id: 'ab000000-0000-4000-8000-000000000001',
      summary_id: SUMMARY_ID,
      position: 0,
      body: 'Participants disagreed about how to read the passage, and the question was left open.',
      source_comment_ids: [replies[0].id, replies[1].id],
      redacted: false,
      moderator_edited: false,
    },
    {
      id: 'ab000000-0000-4000-8000-000000000002',
      summary_id: SUMMARY_ID,
      position: 1,
      body: 'One participant suggested a different reading.',
      source_comment_ids: [replies[1].id],
      redacted: false,
      moderator_edited: false,
    },
  ];
  db.thread_summary_feedback = [];
  return { replies };
}

// The success answer from the Netlify function. Registered after preparePage so
// it takes priority over the harness's catch-all /api/** route.
async function stubSummaryEndpoint(page, body, status = 200) {
  await page.route('**/api/chabura/summary', (route) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }));
}

test.describe('Generated summary — presence and labelling', () => {
  test('a stored summary is labelled, dated, and names its model', async ({ page }) => {
    const db = buildDatabase();
    seedSummary(db);
    await preparePage(page, { user: USERS.ordinary, db });
    await page.goto(LARGE);
    await expect(page.locator('.ct-root')).toBeVisible();

    const panel = page.locator('#ctSummary .cs-panel');
    await expect(panel).toBeVisible();
    // The label is not decoration: a generated paragraph that does not say so
    // is a generated paragraph a reader will quote as somebody's words.
    await expect(panel.locator('.cs-ai-badge')).toHaveText('Generated');
    await expect(panel.locator('.cs-meta')).toContainText('claude-opus-5');
    await expect(panel.locator('.cs-meta')).toContainText('from 2 replies');
    await expect(panel.locator('.cs-meta')).toContainText('2026');
  });

  test('the standing caveat refuses the authority of a ruling', async ({ page }) => {
    const db = buildDatabase();
    seedSummary(db);
    await preparePage(page, { user: USERS.ordinary, db });
    await page.goto(LARGE);

    const caveat = page.locator('#ctSummary .cs-caveat');
    await expect(caveat).toContainText('does not decide anything');
    await expect(caveat).toContainText('ask your rav');
  });

  test('every point carries a link to each reply it came from', async ({ page }) => {
    const db = buildDatabase();
    const { replies } = seedSummary(db);
    await preparePage(page, { user: USERS.ordinary, db });
    await page.goto(LARGE);

    const points = page.locator('#ctSummary .cs-point');
    await expect(points).toHaveCount(2);
    // Two sources on the first point, one on the second — and never zero,
    // which the database itself refuses to store.
    await expect(points.nth(0).locator('.cs-source-link')).toHaveCount(2);
    await expect(points.nth(1).locator('.cs-source-link')).toHaveCount(1);

    const href = await points.nth(1).locator('.cs-source-link').first().getAttribute('href');
    expect(href).toContain(`comment=${replies[1].id}`);
    expect(href).toContain(`thread=${NOTE_IDS.largeThread}`);
  });

  test('a citation for a loaded reply scrolls to it instead of reloading the page', async ({ page }) => {
    const db = buildDatabase();
    const { replies } = seedSummary(db);
    await preparePage(page, { user: USERS.ordinary, db });
    await page.goto(LARGE);
    await expect(page.locator('#ctSummary .cs-panel')).toBeVisible();

    const before = page.url();
    await page.locator('#ctSummary .cs-source-link').first().click();
    await expect(page.locator(`#comment-${replies[0].id}`)).toBeFocused();
    expect(page.url()).toBe(before);
  });
});

test.describe('Generated summary — invalidation and moderation, as the reader sees them', () => {
  test('a withdrawn point shows why it went, and no text at all', async ({ page }) => {
    const db = buildDatabase();
    seedSummary(db);
    // What the redaction trigger leaves behind: no body, no sources.
    db.thread_summary_points_public[0] = {
      ...db.thread_summary_points_public[0],
      body: null,
      source_comment_ids: [],
      redacted: true,
    };
    await preparePage(page, { user: USERS.ordinary, db });
    await page.goto(LARGE);

    const point = page.locator('#ctSummary .cs-point').first();
    await expect(point).toHaveClass(/cs-point-redacted/);
    await expect(point).toContainText('withdrawn because a reply it relied on was removed');
    await expect(point.locator('.cs-source-link')).toHaveCount(0);
    // The second point is untouched: invalidation is per-point, not per-summary.
    await expect(page.locator('#ctSummary .cs-point').nth(1)).not.toHaveClass(/cs-point-redacted/);
  });

  test('a stale summary says so rather than presenting itself as current', async ({ page }) => {
    const db = buildDatabase();
    seedSummary(db, { stale: true, stale_reason: 'source-hidden' });
    await preparePage(page, { user: USERS.ordinary, db });
    await page.goto(LARGE);

    await expect(page.locator('#ctSummary .cs-notice-stale'))
      .toContainText('has changed or been removed since it was written');
  });

  test('a moderator edit is shown as a moderator edit', async ({ page }) => {
    const db = buildDatabase();
    seedSummary(db);
    db.thread_summary_points_public[1] = {
      ...db.thread_summary_points_public[1],
      body: 'Reworded by a moderator.',
      moderator_edited: true,
    };
    await preparePage(page, { user: USERS.ordinary, db });
    await page.goto(LARGE);

    const point = page.locator('#ctSummary .cs-point').nth(1);
    await expect(point).toContainText('Reworded by a moderator.');
    await expect(point.locator('.cs-badge')).toHaveText('edited by a moderator');
  });

  test('only a moderator gets the withdraw and reword controls', async ({ page }) => {
    const db = buildDatabase();
    seedSummary(db);
    await preparePage(page, { user: USERS.ordinary, db });
    await page.goto(LARGE);
    await expect(page.locator('#ctSummary .cs-panel')).toBeVisible();
    await expect(page.locator('#ctSummary .cs-point-tools')).toHaveCount(0);

    const adminDb = buildDatabase();
    seedSummary(adminDb);
    await preparePage(page, { user: USERS.admin, db: adminDb });
    await page.goto(LARGE);
    await expect(page.locator('#ctSummary .cs-point-tools')).toHaveCount(2);
    await expect(page.locator('#ctSummary button', { hasText: 'Hide summary' })).toBeVisible();
  });
});

test.describe('Generated summary — feedback', () => {
  test('useful / not useful is recorded and reflected back', async ({ page }) => {
    const db = buildDatabase();
    seedSummary(db);
    await preparePage(page, { user: USERS.ordinary, db });
    await page.goto(LARGE);
    await expect(page.locator('#ctSummary .cs-panel')).toBeVisible();

    await expect(page.locator('#ctSummary .cs-tally')).toContainText('3 found this useful');
    await page.locator('#ctSummary button', { hasText: 'Useful' }).first().click();
    await expect(page.locator('#ctSummary button[aria-pressed="true"]')).toHaveText('Useful');

    const stored = await page.evaluate(() => window.__DAFSYNC_TEST_DB__.thread_summary_feedback);
    expect(stored).toHaveLength(1);
    expect(stored[0].verdict).toBe('useful');
  });

  test('an anonymous reader gets no feedback or report controls', async ({ page }) => {
    const db = buildDatabase();
    seedSummary(db);
    await preparePage(page, { user: null, db });
    await page.goto(LARGE);
    await expect(page.locator('#ctSummary .cs-panel')).toBeVisible();

    await expect(page.locator('#ctSummary button', { hasText: 'Useful' })).toHaveCount(0);
    await expect(page.locator('#ctSummary button', { hasText: 'Report' })).toHaveCount(0);
  });
});

test.describe('Generated summary — when it is offered at all', () => {
  test('a thread with too few replies is never offered a summary', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await page.goto(SHORT);
    await expect(page.locator('.ct-root')).toBeVisible();
    await expect(page.locator('#ctSummary')).toBeHidden();
  });

  test('an anonymous reader is not offered generation', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto(LARGE);
    await expect(page.locator('.ct-root')).toBeVisible();
    // No stored summary and not signed in: nothing to show and nothing to offer.
    await expect(page.locator('#ctSummary')).toBeHidden();
  });

  test('a signed-in reader on a long thread is offered one', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await page.goto(LARGE);
    await expect(page.locator('#ctSummary')).toBeVisible();
    await expect(page.locator('#ctSummary button')).toHaveText('Summarise this discussion');
  });

  test('generating stores nothing client-side: the panel re-reads what the database has', async ({ page }) => {
    const db = buildDatabase();
    await preparePage(page, { user: USERS.ordinary, db });
    await stubSummaryEndpoint(page, { status: 'ok', mode: 'thread', summaryId: SUMMARY_ID, point_count: 2 });
    await page.goto(LARGE);
    await expect(page.locator('#ctSummary button')).toHaveText('Summarise this discussion');

    // The endpoint reports success, but the database has no rows yet — the
    // panel must show nothing rather than inventing the text it was told about.
    await page.locator('#ctSummary button').click();
    await expect(page.locator('#ctSummary .cs-point')).toHaveCount(0);
  });
});

test.describe('Generated summary — every failure leaves the discussion readable', () => {
  test('an unconfigured deploy hides the feature instead of showing an error', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await stubSummaryEndpoint(page, { error: 'unconfigured' }, 503);
    await page.goto(LARGE);

    await page.locator('#ctSummary button').click();
    await expect(page.locator('#ctSummary .cs-notice-error'))
      .toContainText('not switched on for this site');
    // And the thread itself is untouched.
    await expect(page.locator('article.ct-reply').first()).toBeVisible();
  });

  test('a 404 from the endpoint is reported plainly and blocks nothing', async ({ page }) => {
    // No route stub at all: the harness answers /api/** with 404, which is
    // exactly what a deploy without this function does.
    await preparePage(page, { user: USERS.ordinary });
    await page.goto(LARGE);

    await page.locator('#ctSummary button').click();
    await expect(page.locator('#ctSummary .cs-notice-error')).toContainText('could not be generated');
    await expect(page.locator('#ctSummary .cs-notice-error')).toContainText('discussion below is unaffected');
    await expect(page.locator('article.ct-reply').first()).toBeVisible();
    await expect(page.locator('.ct-composer-input')).toBeVisible();
  });

  test('a summary that cannot be read does not break the page', async ({ page }) => {
    const errors = [];
    failOnPageError(page, errors);
    await preparePage(page, {
      user: USERS.ordinary,
      control: { failures: { 'thread_summaries:select': { message: 'boom', code: 'TEST' } } },
    });
    await page.goto(LARGE);

    await expect(page.locator('article.ct-reply').first()).toBeVisible();
    // Warned in the console, never thrown at the reader.
    expect(errors.filter((line) => !line.includes('summary'))).toEqual([]);
  });
});

test.describe('Catch me up', () => {
  test('is offered only when there are enough unread replies', async ({ page }) => {
    // Reader One has read the deep thread up to sequence 2, leaving fewer than
    // the catch-up threshold unread on the short threads.
    await preparePage(page, { user: USERS.ordinary });
    await page.goto(SHORT);
    await expect(page.locator('.ct-root')).toBeVisible();
    await expect(page.locator('#ctCatchup')).toBeHidden();
  });

  test('a viewer-specific catch-up is shown as unsaved and carries citations', async ({ page }) => {
    const db = buildDatabase();
    const replies = db.comments
      .filter((row) => row.note_id === NOTE_IDS.largeThread)
      .sort((a, b) => a.activity_sequence - b.activity_sequence);
    db.thread_read_state.push({
      user_id: USERS.ordinary.id, note_id: NOTE_IDS.largeThread,
      last_read_sequence: 1, updated_at: new Date().toISOString(),
    });
    await preparePage(page, { user: USERS.ordinary, db });
    await stubSummaryEndpoint(page, {
      status: 'ok',
      mode: 'catchup',
      model_id: 'claude-opus-5',
      generated_at: new Date().toISOString(),
      source_comment_count: 4,
      points: [{ text: 'Four new replies took up the second reading.', source_comment_ids: [replies[2].id] }],
    });
    await page.goto(LARGE);

    const offer = page.locator('#ctCatchup button');
    await expect(offer).toHaveText('Catch me up');
    await offer.click();

    const panel = page.locator('#ctCatchup .cs-panel');
    await expect(panel.locator('.cs-title')).toHaveText('What you missed');
    await expect(panel.locator('.cs-point')).toHaveCount(1);
    await expect(panel.locator('.cs-source-link')).toHaveCount(1);
    // Catch-up is per-viewer state and is never stored, so it carries no
    // feedback controls — there is no shared row to attach an opinion to.
    await expect(panel).toContainText('not saved');
    await expect(panel.locator('button', { hasText: 'Useful' })).toHaveCount(0);
  });
});

test.describe('Related discussions (no AI)', () => {
  test('other discussions on the same passage are suggested, with the reason', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await page.goto(LARGE);
    await expect(page.locator('.ct-root')).toBeVisible();

    const panel = page.locator('#ctRelated .cr-panel');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.cr-heading')).toHaveText('Related discussions');
    const items = panel.locator('.cr-item');
    expect(await items.count()).toBeGreaterThan(0);
    await expect(items.first().locator('.cr-meta')).toContainText('Same passage');
  });

  test('a suggestion never points at the discussion you are already reading', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await page.goto(LARGE);
    await expect(page.locator('#ctRelated .cr-panel')).toBeVisible();

    const hrefs = await page.locator('#ctRelated .cr-link').evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('href')));
    expect(hrefs.length).toBeGreaterThan(0);
    hrefs.forEach((href) => expect(href).not.toContain(NOTE_IDS.largeThread));
  });

  test('a private note is never suggested', async ({ page }) => {
    // The stub has no RLS, so this asserts the ONLY thing the client can be
    // held to here: that nothing on screen names the private canary. The
    // guarantee itself is the database's, and is tested in the SQL suite.
    await preparePage(page, { user: USERS.ordinary });
    await page.goto(LARGE);
    await expect(page.locator('#ctRelated .cr-panel')).toBeVisible();

    const hrefs = await page.locator('#ctRelated .cr-link').evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('href')));
    hrefs.forEach((href) => expect(href).not.toContain(NOTE_IDS.privateNote));
  });

  test('the ranking prefers the same passage over the same daf', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await page.goto(LARGE);
    await expect(page.locator('#ctRelated .cr-panel')).toBeVisible();

    const scored = await page.evaluate(() => {
      const { scoreCandidate } = window.DafSyncChabura.related.__testing;
      const note = { daf_ref_key: 'Chullin-89a', segment_ref: 'Chullin 89a.1', start_word: 3, end_word: 6 };
      return {
        samePassage: scoreCandidate(note, { ...note }, 0).score,
        sameDaf: scoreCandidate(note, { daf_ref_key: 'Chullin-89a', segment_ref: 'Chullin 89a.2' }, 0).score,
        elsewhere: scoreCandidate(note, { daf_ref_key: 'Chullin-90a', segment_ref: 'Chullin 90a.1' }, 3).score,
      };
    });
    expect(scored.samePassage).toBeGreaterThan(scored.sameDaf);
    expect(scored.sameDaf).toBeGreaterThan(0);
    // Wording alone still counts, but never as much as being about the same words.
    expect(scored.elsewhere).toBeLessThan(scored.samePassage);
  });
});
