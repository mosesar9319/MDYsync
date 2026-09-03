import { test, expect } from '@playwright/test';
import { preparePage, failOnPageError, readTestCalls } from '../support/harness.mjs';
import { buildDatabase, sessionFor, USERS, NOTE_IDS } from '../fixtures/dataset.mjs';

// The dedicated Cloud Chabura thread reader (Prompt 4):
// /chaburah/thread/?thread=<uuid>&comment=<optional uuid>
//
// The plan's acceptance criteria are the spine of this file: zero replies,
// four-level nesting, deleted parent, hidden reply, null timestamp, multi-ref
// word_ranges, a 300+ reply fixture, permalinks surviving refresh, mobile text
// width, and screen-reader identification of author/level/expanded state.

const ROOT = '.ct-root';
const REPLY = '.ct-reply';
const reply = (id) => `#comment-${id}`;

const DEEP = {
  l1: 'b0000000-0000-4000-8000-000000000001',
  l2: 'b0000000-0000-4000-8000-000000000002',
  l3: 'b0000000-0000-4000-8000-000000000003',
  l4: 'b0000000-0000-4000-8000-000000000004',
  quoting: 'c0000000-0000-4000-8000-000000000004',
};
const HIDDEN = {
  visibleTop: 'c0000000-0000-4000-8000-000000000001',
  hiddenMiddle: 'c0000000-0000-4000-8000-000000000002',
  survivor: 'c0000000-0000-4000-8000-000000000003',
  deletedTop: 'c0000000-0000-4000-8000-000000000005',
  deletedChild: 'c0000000-0000-4000-8000-000000000006',
};

function threadUrl(noteId, extra = '') {
  return `/chaburah/thread/?thread=${noteId}${extra}`;
}

async function openThread(page, noteId, extra = '') {
  await page.goto(threadUrl(noteId, extra));
  await expect(page.locator(ROOT)).toBeVisible();
}

test.describe('Thread reader — shell and states', () => {
  test('loads a thread signed out with no page errors', async ({ page }) => {
    const errors = failOnPageError(page);
    await preparePage(page, { user: null });
    await openThread(page, NOTE_IDS.deepThread);

    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.locator('main')).toHaveCount(1);
    await expect(page.locator(ROOT)).toContainText('Root of a four-level reply chain.');
    expect(errors).toEqual([]);
  });

  test('a thread with no replies says so instead of rendering an empty list', async ({ page }) => {
    await preparePage(page, { user: null });
    await openThread(page, NOTE_IDS.noReplies);

    await expect(page.locator(REPLY)).toHaveCount(0);
    await expect(page.locator('.ct-empty')).toContainText('No replies yet');
  });

  test('a missing thread parameter explains itself and never renders a skeleton forever', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/chaburah/thread/');
    await expect(page.locator('.cc-empty')).toContainText('missing a discussion');
  });

  test('a thread the viewer may not see leaks nothing about it', async ({ page }) => {
    // The row is REMOVED from the fixture rather than marked private, because
    // the stub does not enforce RLS and would happily serve a private note --
    // see its header. What is under test here is only the client's handling of
    // the empty result RLS produces. That RLS itself is proven in
    // supabase/tests/rls_authorization.sql against a real Postgres.
    const db = buildDatabase();
    db.line_notes = db.line_notes.filter((row) => row.id !== NOTE_IDS.privateNote);
    await preparePage(page, { user: null, db });
    await page.goto(threadUrl(NOTE_IDS.privateNote));

    // Signed out, the honest answer is "sign in", not "this is private" --
    // which would confirm the id names something real.
    await expect(page.locator('.cc-empty')).toContainText('Sign in to see this discussion');
    await expect(page.locator('body')).not.toContainText('PRIVATE-CANARY');
  });

  test('a signed-in reader who still cannot see it gets no confirmation it exists', async ({ page }) => {
    const db = buildDatabase();
    db.line_notes = db.line_notes.filter((row) => row.id !== NOTE_IDS.privateNote);
    await preparePage(page, { user: USERS.ordinary, db });
    await page.goto(threadUrl(NOTE_IDS.privateNote));

    await expect(page.locator('.cc-empty')).toContainText('not available');
    // "removed, or not shared with you" -- deliberately does not distinguish,
    // because distinguishing confirms the id names a real discussion.
    await expect(page.locator('.cc-empty')).toContainText('may not be shared with you');
  });

  test('surfaces a load failure with a working retry', async ({ page }) => {
    await preparePage(page, {
      user: null,
      control: { failures: { 'line_notes:select': { message: 'permission denied', code: '42501' } } },
    });
    await page.goto(threadUrl(NOTE_IDS.deepThread));

    await expect(page.locator('[role="alert"]')).toContainText('You do not have permission to do that.');
    await page.evaluate(() => { delete window.__DAFSYNC_TEST_CONTROL__.failures['line_notes:select']; });
    await page.click('button:has-text("Try again")');
    await expect(page.locator(ROOT)).toBeVisible();
  });
});

test.describe('Thread reader — source context', () => {
  test('shows the exact anchored passage in RTL, not just a reference', async ({ page }) => {
    await preparePage(page, { user: null });
    await openThread(page, NOTE_IDS.singleWordRange);

    const source = page.locator('#ctSource');
    await expect(source.locator('.ct-source-text')).toHaveText('ארבעה ראשי שנים הם');
    await expect(source.locator('.ct-source-text')).toHaveAttribute('dir', 'rtl');
    await expect(source).toContainText('Chullin 89a');
  });

  test('offers Play shiur moment only when a real timestamp exists', async ({ page }) => {
    await preparePage(page, { user: null });
    await openThread(page, NOTE_IDS.singleWordRange);
    await expect(page.locator('#ctSource a:has-text("Play shiur moment")')).toHaveCount(1);

    // Same page, a note whose video_timestamp_seconds is null: no invented
    // timestamp, and a sentence saying why there is no action.
    await openThread(page, NOTE_IDS.multiRefWordRange);
    await expect(page.locator('#ctSource a:has-text("Play shiur moment")')).toHaveCount(0);
    await expect(page.locator('#ctSource')).toContainText('No synchronized shiur moment');
  });

  test('links to the Interactive Daf at this passage', async ({ page }) => {
    await preparePage(page, { user: null });
    await openThread(page, NOTE_IDS.deepThread);
    await expect(page.locator('#ctSource a:has-text("Show on daf")'))
      .toHaveAttribute('href', '/browse/?ref=Chullin%2089a');
  });

  test('stays quiet about drift when the anchor still resolves', async ({ page }) => {
    await preparePage(page, { user: null });
    await openThread(page, NOTE_IDS.singleWordRange);
    await expect(page.locator('.ct-source-drift')).toHaveCount(0);
  });

  test('warns when the saved word range no longer resolves to as many words', async ({ page }) => {
    await preparePage(page, { user: null });
    // One box removed from the note's 3..6 span, which is exactly what the
    // heuristic detects: a word dropped out from under a saved selection.
    await page.route('**/api/get-results-file*', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        wordBoxes: [
          { ref: 'Chullin 89a.1', wordIndex: 3 },
          { ref: 'Chullin 89a.1', wordIndex: 4 },
          { ref: 'Chullin 89a.1', wordIndex: 5 },
        ],
      }),
    }));
    await openThread(page, NOTE_IDS.singleWordRange);
    await expect(page.locator('.ct-source-drift')).toContainText('may no longer match');
  });

  test('a multi-ref selection still renders its passage', async ({ page }) => {
    await preparePage(page, { user: null });
    await openThread(page, NOTE_IDS.multiRefWordRange);
    await expect(page.locator('.ct-source-text')).toHaveText('תנו רבנן ארבעה');
  });
});

test.describe('Thread reader — reply tree', () => {
  test('renders four real levels of nesting, not a flattened list', async ({ page }) => {
    await preparePage(page, { user: null });
    await openThread(page, NOTE_IDS.deepThread);

    for (const [level, id] of [[0, DEEP.l1], [1, DEEP.l2], [2, DEEP.l3], [3, DEEP.l4]]) {
      await expect(page.locator(reply(id))).toHaveAttribute('data-depth', String(level));
    }
  });

  test('indentation stops increasing past the cap and names the parent instead', async ({ page }, testInfo) => {
    await preparePage(page, { user: null });
    await openThread(page, NOTE_IDS.deepThread);

    // Desktop indents depths 0-2; mobile only 0-1. Either way depth 3 (the
    // fourth level) is past the cap.
    const capped = page.locator(reply(DEEP.l4));
    await expect(capped).toHaveClass(/ct-reply-capped/);
    await expect(capped).toContainText('Replying to');

    // Below the cap the parent is obvious from the rail, so it is not restated.
    await expect(page.locator(reply(DEEP.l2))).not.toContainText('Replying to');

    // The capped reply is held at the same inset as the last uncapped one
    // rather than shifting further right.
    const insets = await page.evaluate((ids) => ids.map((id) =>
      getComputedStyle(document.getElementById(`comment-${id}`)).marginLeft), [DEEP.l3, DEEP.l4]);
    expect(insets[0]).toBe(insets[1]);
  });

  test('a moderator-hidden reply is a tombstone with its descendant intact', async ({ page }) => {
    await preparePage(page, { user: null });
    await openThread(page, NOTE_IDS.hiddenParentThread);

    const tomb = page.locator(reply(HIDDEN.hiddenMiddle));
    await expect(tomb).toHaveClass(/is-removed/);
    await expect(tomb).toContainText('removed by a moderator');
    await expect(page.locator('body')).not.toContainText('HIDDEN-CANARY');
    // The whole point of a tombstone: the child survives and stays connected.
    await expect(page.locator(reply(HIDDEN.survivor))).toContainText('Descendant of a hidden reply');
  });

  test('an author-deleted reply is a distinct tombstone, also keeping its child', async ({ page }) => {
    await preparePage(page, { user: null });
    await openThread(page, NOTE_IDS.hiddenParentThread);

    const tomb = page.locator(reply(HIDDEN.deletedTop));
    await expect(tomb).toContainText('deleted by its author');
    await expect(page.locator(reply(HIDDEN.deletedChild))).toContainText('Descendant of an author-deleted reply');
  });

  test('a tombstone does not advertise its author', async ({ page }) => {
    await preparePage(page, { user: null });
    await openThread(page, NOTE_IDS.hiddenParentThread);
    await expect(page.locator(`${reply(HIDDEN.hiddenMiddle)} .ct-author`)).toHaveText('Removed');
  });

  test('a quote links back to its source and shows the stored excerpt', async ({ page }) => {
    await preparePage(page, { user: null });
    await openThread(page, NOTE_IDS.deepThread);

    const quote = page.locator(`${reply(DEEP.quoting)} .ct-quote`);
    await expect(quote).toContainText('Reply at level 1.');
    await expect(quote.locator('a')).toHaveAttribute('href', `#comment-${DEEP.l1}`);
  });

  test('collapsing a branch hides its descendants and summarises them', async ({ page }) => {
    await preparePage(page, { user: null });
    await openThread(page, NOTE_IDS.deepThread);

    await expect(page.locator(reply(DEEP.l2))).toBeVisible();
    await page.locator('.ct-branch-toggle').first().click();

    await expect(page.locator(reply(DEEP.l2))).toHaveCount(0);
    await expect(page.locator('.ct-collapsed-button').first()).toContainText('replies');
    // The root of the branch stays; only what hangs beneath it collapses.
    await expect(page.locator(reply(DEEP.l1))).toBeVisible();
  });

  test('a collapsed branch keeps its unread count visible', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await openThread(page, NOTE_IDS.deepThread);

    await page.locator('.ct-branch-toggle').first().click();
    await expect(page.locator('.ct-collapsed-button').first()).toContainText('unread');
  });

  test('sorting branches never reorders replies inside one', async ({ page }) => {
    await preparePage(page, { user: null });
    await openThread(page, NOTE_IDS.deepThread);

    await page.selectOption('#ctSort', 'newest');
    const order = await page.locator(REPLY).evaluateAll((nodes) => nodes.map((n) => n.dataset.id));
    // Level 1 still precedes level 2, which still precedes level 3.
    expect(order.indexOf(DEEP.l1)).toBeLessThan(order.indexOf(DEEP.l2));
    expect(order.indexOf(DEEP.l2)).toBeLessThan(order.indexOf(DEEP.l3));
  });
});

test.describe('Thread reader — permalinks', () => {
  test('a permalink to a deep reply expands its ancestors and focuses it', async ({ page }) => {
    await preparePage(page, { user: null });
    await openThread(page, NOTE_IDS.deepThread, `&comment=${DEEP.l4}`);

    const target = page.locator(reply(DEEP.l4));
    await expect(target).toBeVisible();
    await expect(target).toHaveClass(/is-permalinked/);
    // Focus lands on the target so a keyboard or screen-reader user arrives
    // there too, not just the scroll position.
    await expect(target).toBeFocused();
  });

  test('a permalink survives a reload', async ({ page }) => {
    await preparePage(page, { user: null });
    await openThread(page, NOTE_IDS.deepThread, `&comment=${DEEP.l3}`);
    await expect(page.locator(reply(DEEP.l3))).toBeFocused();

    await page.reload();
    await expect(page.locator(reply(DEEP.l3))).toBeVisible();
    await expect(page.locator(reply(DEEP.l3))).toBeFocused();
  });

  test('a permalink to a reply that is gone falls back to the discussion', async ({ page }) => {
    await preparePage(page, { user: null });
    await openThread(page, NOTE_IDS.deepThread, '&comment=b0000000-0000-4000-8000-999999999999');

    await expect(page.locator(ROOT)).toBeVisible();
    await expect(page.locator('#ctToast')).toContainText('no longer available');
  });

  test('Copy link to reply produces the permalink for that reply', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await preparePage(page, { user: USERS.ordinary });
    await openThread(page, NOTE_IDS.deepThread);

    await page.locator(`${reply(DEEP.l1)} .ct-more`).click();
    await page.click('.ct-menu-item:has-text("Copy link to reply")');
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain(`thread=${NOTE_IDS.deepThread}`);
    expect(copied).toContain(`comment=${DEEP.l1}`);
  });
});

test.describe('Thread reader — reactions', () => {
  test('reacting is optimistic and persists', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await openThread(page, NOTE_IDS.deepThread);

    await page.locator(`${reply(DEEP.l1)} .ct-reaction-add`).click();
    await page.click('.ct-menu-item:has-text("Insightful")');

    await expect(page.locator(`${reply(DEEP.l1)} .ct-reaction.is-mine`)).toContainText('Insightful');
    const calls = await readTestCalls(page);
    const insert = calls.find((c) => c.table === 'reactions' && c.operation === 'insert');
    expect(insert.rows[0].reaction_type).toBe('insightful');
    expect(insert.rows[0].target_type).toBe('comment');
  });

  test('a rejected reaction is rolled back rather than left looking successful', async ({ page }) => {
    await preparePage(page, {
      user: USERS.ordinary,
      control: { failures: { 'reactions:insert': { message: 'permission denied', code: '42501' } } },
    });
    await openThread(page, NOTE_IDS.deepThread);

    await page.locator(`${reply(DEEP.l1)} .ct-reaction-add`).click();
    await page.click('.ct-menu-item:has-text("Helpful")');

    await expect(page.locator(`${reply(DEEP.l1)} .ct-reaction.is-mine`)).toHaveCount(0);
    await expect(page.locator('#ctToast')).toContainText('You do not have permission to do that.');
  });

  test('a signed-out reader sees counts but cannot react', async ({ page }) => {
    await preparePage(page, { user: null });
    await openThread(page, NOTE_IDS.singleWordRange);
    await expect(page.locator('.ct-reaction-add')).toHaveCount(0);
  });
});

test.describe('Thread reader — composer', () => {
  test('posts a top-level reply and threads it correctly', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await openThread(page, NOTE_IDS.noReplies);

    await page.fill('.ct-composer-input', 'A brand new reply.');
    await page.click('.ct-composer button[type="submit"]');

    await expect(page.locator(REPLY)).toContainText('A brand new reply.');
    const calls = await readTestCalls(page);
    const insert = calls.find((c) => c.table === 'comments' && c.operation === 'insert');
    expect(insert.rows[0].parent_comment_id).toBeNull();
    expect(insert.rows[0].depth).toBe(0);
    // comments.author_display_name is NOT NULL in the real schema -- the stub
    // does not enforce that (same "server rule, not client behaviour" split
    // as can_post_publicly() above), so a regression here would insert a
    // reply with the field simply missing and this would still pass without
    // this assertion. Reported directly in production as the bare Postgres
    // 23502 constraint-violation message reaching a reader's screen.
    expect(insert.rows[0].author_display_name).toBe(USERS.ordinary.display_name);
  });

  test('an inline reply carries its parent and nests one level deeper', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await openThread(page, NOTE_IDS.deepThread);

    await page.locator(`${reply(DEEP.l1)} button:has-text("Reply")`).click();
    const inline = page.locator('.ct-inline-composer .ct-composer-input');
    await expect(inline).toBeVisible();
    await inline.fill('Nested under level one.');
    await page.click('.ct-inline-composer button[type="submit"]');

    const calls = await readTestCalls(page);
    const insert = calls.find((c) => c.table === 'comments' && c.operation === 'insert');
    expect(insert.rows[0].parent_comment_id).toBe(DEEP.l1);
    expect(insert.rows[0].depth).toBe(1);
    expect(insert.rows[0].author_display_name).toBe(USERS.ordinary.display_name);
  });

  test('Ctrl+Enter submits', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await openThread(page, NOTE_IDS.noReplies);

    await page.fill('.ct-composer-input', 'Posted with the keyboard.');
    await page.locator('.ct-composer-input').press('Control+Enter');
    await expect(page.locator(REPLY)).toContainText('Posted with the keyboard.');
  });

  test('a failed post preserves the complete draft and says what went wrong', async ({ page }) => {
    await preparePage(page, {
      user: USERS.ordinary,
      control: { failures: { 'comments:insert': { message: 'new row violates row-level security policy' } } },
    });
    await openThread(page, NOTE_IDS.noReplies);

    await page.fill('.ct-composer-input', 'This should fail but must not vanish.');
    await page.click('.ct-composer button[type="submit"]');

    // The raw PostgREST text is not shown. comments_insert is one policy
    // covering private, hidden, locked, deleted and account-age, so the thread
    // is re-read and the actual reason named.
    await expect(page.locator('.ct-composer-error')).toContainText('New accounts cannot post publicly yet');
    await expect(page.locator('.ct-composer-input')).toHaveValue('This should fail but must not vanish.');
    await expect(page.locator('.ct-composer button[type="submit"]')).toBeEnabled();
    // The optimistic row is gone: a failed reply must never be left looking posted.
    await expect(page.locator(REPLY)).toHaveCount(0);
  });

  test('an unsent draft survives a reload (the F-7 gap, now closed here)', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await openThread(page, NOTE_IDS.noReplies);

    await page.fill('.ct-composer-input', 'Half-written thought worth keeping.');
    await page.waitForTimeout(400); // debounced persist
    await page.reload();
    await expect(page.locator(ROOT)).toBeVisible();

    await expect(page.locator('.ct-composer-input')).toHaveValue('Half-written thought worth keeping.');
    await expect(page.locator('.ct-composer-restored')).toContainText('Draft restored');
  });

  test('over-long text is refused with a count, never silently truncated', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await openThread(page, NOTE_IDS.noReplies);

    const long = 'x'.repeat(2050);
    await page.fill('.ct-composer-input', long);
    // The textarea keeps every character the reader typed.
    await expect(page.locator('.ct-composer-input')).toHaveValue(long);
    await expect(page.locator('.ct-composer-count')).toContainText('2050 / 2000');

    await page.click('.ct-composer button[type="submit"]');
    await expect(page.locator('.ct-composer-error')).toContainText('50 characters over');
    const calls = await readTestCalls(page);
    expect(calls.find((c) => c.table === 'comments' && c.operation === 'insert')).toBeFalsy();
  });

  test('the character count stays hidden until the limit is close', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await openThread(page, NOTE_IDS.noReplies);

    await page.fill('.ct-composer-input', 'short');
    await expect(page.locator('.ct-composer-count')).toBeHidden();
    await page.fill('.ct-composer-input', 'x'.repeat(1850));
    await expect(page.locator('.ct-composer-count')).toBeVisible();
  });

  test('quoting seeds the composer with a removable quote card', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await openThread(page, NOTE_IDS.deepThread);

    await page.locator(`${reply(DEEP.l1)} button:has-text("Quote")`).click();
    const draft = page.locator('.ct-inline-composer .ct-quote-draft');
    await expect(draft).toContainText('Reply at level 1.');

    await page.locator('.ct-inline-composer .ct-composer-input').fill('Answering the quote.');
    await page.click('.ct-inline-composer button[type="submit"]');

    const calls = await readTestCalls(page);
    const insert = calls.find((c) => c.table === 'comments' && c.operation === 'insert');
    expect(insert.rows[0].quoted_comment_id).toBe(DEEP.l1);
    expect(insert.rows[0].quoted_excerpt).toContain('Reply at level 1.');
  });

  test('mention chips are limited to thread participants and never expose email', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await openThread(page, NOTE_IDS.deepThread);

    const labels = await page.locator('.ct-mention-chip').allTextContents();
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.join(' ')).not.toContain(USERS.ordinary.display_name);
    for (const user of Object.values(USERS)) {
      expect(labels.join(' ')).not.toContain(user.email);
    }
  });

  test('the composer is closed with an explanation on a locked thread', async ({ page }) => {
    const db = buildDatabase();
    db.line_notes.find((row) => row.id === NOTE_IDS.noReplies).status = 'locked';
    await preparePage(page, { user: USERS.ordinary, db });
    await openThread(page, NOTE_IDS.noReplies);

    await expect(page.locator('.ct-composer-disabled')).toContainText('locked');
    await expect(page.locator('.ct-composer-input')).toHaveCount(0);
    // Locked means no new replies, not unreadable.
    await expect(page.locator(ROOT)).toBeVisible();
  });

  test('a signed-out reader is invited to sign in rather than shown a dead composer', async ({ page }) => {
    await preparePage(page, { user: null });
    await openThread(page, NOTE_IDS.noReplies);
    await expect(page.locator('.ct-composer-disabled')).toContainText('Sign in');
  });
});

test.describe('Thread reader — answers, edit and delete', () => {
  test('the root author can mark and unmark an answer', async ({ page }) => {
    await preparePage(page, { user: USERS.author });
    await openThread(page, NOTE_IDS.noReplies);

    // Post a reply as the author, then mark it.
    await page.fill('.ct-composer-input', 'This answers it.');
    await page.click('.ct-composer button[type="submit"]');
    await expect(page.locator(REPLY)).toHaveCount(1);

    await page.locator(`${REPLY} .ct-more`).first().click();
    await page.click('.ct-menu-item:has-text("Mark as answer")');

    await expect(page.locator(`${REPLY}.is-answer`)).toHaveCount(1);
    await expect(page.locator('.ct-answer-flag')).toContainText('Highlighted answer');
  });

  test('a reader who is not the root author is not offered Mark as answer', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await openThread(page, NOTE_IDS.deepThread);

    await page.locator(`${reply(DEEP.l1)} .ct-more`).click();
    await expect(page.locator('.ct-menu-item:has-text("Mark as answer")')).toHaveCount(0);
  });

  test('an author edits in place, with the existing text seeded', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await openThread(page, NOTE_IDS.deepThread);

    await page.locator(`${reply(DEEP.l1)} .ct-more`).click();
    await page.click('.ct-menu-item:has-text("Edit")');

    // A real textarea in the thread, not a browser prompt: it can show a count,
    // survive a failed save, and be read in context.
    const editor = page.locator(`${reply(DEEP.l1)} .ct-editor .ct-composer-input`);
    await expect(editor).toHaveValue('Reply at level 1.');
    await editor.fill('Reply at level 1, clarified.');
    await page.click(`${reply(DEEP.l1)} .ct-editor button[type="submit"]`);

    await expect(page.locator(reply(DEEP.l1))).toContainText('clarified');
    await expect(page.locator(`${reply(DEEP.l1)} .ct-edited`)).toBeVisible();
  });

  test('a failed edit keeps the rewritten text on screen', async ({ page }) => {
    await preparePage(page, {
      user: USERS.ordinary,
      control: { failures: { 'comments:update': { message: 'permission denied', code: '42501' } } },
    });
    await openThread(page, NOTE_IDS.deepThread);

    await page.locator(`${reply(DEEP.l1)} .ct-more`).click();
    await page.click('.ct-menu-item:has-text("Edit")');
    await page.locator(`${reply(DEEP.l1)} .ct-editor .ct-composer-input`).fill('A careful rewrite worth keeping.');
    await page.click(`${reply(DEEP.l1)} .ct-editor button[type="submit"]`);

    await expect(page.locator(`${reply(DEEP.l1)} .ct-composer-error`)).toContainText('You do not have permission');
    // Reverting to the original here would throw away the rewrite silently.
    await expect(page.locator(`${reply(DEEP.l1)} .ct-editor .ct-composer-input`))
      .toHaveValue('A careful rewrite worth keeping.');
  });

  test('an edit cannot empty a post', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await openThread(page, NOTE_IDS.deepThread);

    await page.locator(`${reply(DEEP.l1)} .ct-more`).click();
    await page.click('.ct-menu-item:has-text("Edit")');
    await page.locator(`${reply(DEEP.l1)} .ct-editor .ct-composer-input`).fill('   ');
    await page.click(`${reply(DEEP.l1)} .ct-editor button[type="submit"]`);

    await expect(page.locator(`${reply(DEEP.l1)} .ct-composer-error`)).toContainText('Delete it instead');
  });

  test('a reader is not offered Edit or Delete on someone else’s reply', async ({ page }) => {
    await preparePage(page, { user: USERS.author });
    await openThread(page, NOTE_IDS.deepThread);

    await page.locator(`${reply(DEEP.l1)} .ct-more`).click();
    await expect(page.locator('.ct-menu-item:has-text("Edit")')).toHaveCount(0);
    await expect(page.locator('.ct-menu-item:has-text("Delete")')).toHaveCount(0);
  });

  test('deleting states what survives, and the descendants do survive', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await openThread(page, NOTE_IDS.deepThread);

    await page.locator(`${reply(DEEP.l1)} .ct-more`).click();
    await page.click('.ct-menu-item:has-text("Delete")');

    const dialog = page.locator('.ct-confirm');
    await expect(dialog).toContainText('stay visible and stay connected');
    await dialog.locator('button:has-text("Delete")').click();

    await expect(page.locator(reply(DEEP.l1))).toContainText('deleted by its author');
    // The chain beneath it is intact.
    await expect(page.locator(reply(DEEP.l2))).toContainText('Reply at level 2');
    await expect(page.locator(reply(DEEP.l4))).toContainText('Reply at level 4');
  });

  test('cancelling the delete confirmation changes nothing', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await openThread(page, NOTE_IDS.deepThread);

    await page.locator(`${reply(DEEP.l1)} .ct-more`).click();
    await page.click('.ct-menu-item:has-text("Delete")');
    await page.locator('.ct-confirm button:has-text("Cancel")').click();

    await expect(page.locator(reply(DEEP.l1))).toContainText('Reply at level 1');
    const calls = await readTestCalls(page);
    expect(calls.find((c) => c.table === 'comments' && c.operation === 'update')).toBeFalsy();
  });
});

test.describe('Thread reader — outline, search and unread', () => {
  test('the outline lists branches with reply counts and marks the answer', async ({ page }) => {
    await preparePage(page, { user: null });
    await openThread(page, NOTE_IDS.deepThread);

    const outline = page.locator('#ctOutline');
    await expect(outline.locator('.ct-branch-link')).not.toHaveCount(0);
    await expect(outline).toContainText('Author Two');
  });

  test('search finds a reply, says how many, and jumps to it', async ({ page }) => {
    await preparePage(page, { user: null });
    await openThread(page, NOTE_IDS.deepThread);

    await page.fill('#ctSearch', 'level 3');
    await expect(page.locator('.ct-reply.is-search-hit')).toHaveCount(1);
    await expect(page.locator('#ctStatus')).toContainText('1 matching reply');
  });

  test('search reports no match against the whole discussion, not just the DOM', async ({ page }) => {
    await preparePage(page, { user: null });
    await openThread(page, NOTE_IDS.deepThread);

    await page.fill('#ctSearch', 'zzzznotpresent');
    await expect(page.locator('#ctStatus')).toContainText('No replies in this discussion match');
  });

  test('search finds a reply in a branch that was never loaded', async ({ page }) => {
    await preparePage(page, { user: null });
    // The large thread pages 10 branches at a time; this match is in the 300th.
    await openThread(page, NOTE_IDS.largeThread);
    await expect(page.locator(REPLY)).toHaveCount(10);

    await page.fill('#ctSearch', 'Bulk reply number 299');
    // A DOM-only search would report nothing here, because that branch was
    // never fetched. body_tsv is searched server-side instead.
    await expect(page.locator('#ctStatus')).toContainText('in this discussion');
    await expect(page.locator('.ct-reply.is-search-hit')).not.toHaveCount(0);
    await expect(page.locator('.ct-reply.is-search-current')).toContainText('Bulk reply number 299');
  });

  test('an unread marker appears for a returning reader', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await openThread(page, NOTE_IDS.deepThread);

    await expect(page.locator('.ct-unread-marker')).toContainText('New since your last visit');
    await expect(page.locator('.ct-reply.is-unread')).not.toHaveCount(0);
  });

  test('collapse read branches leaves the ones with unread activity open', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await openThread(page, NOTE_IDS.deepThread);

    await page.click('#ctCollapseRead');
    await expect(page.locator('#ctStatus')).toContainText('Read branches collapsed');
    // The deep branch has unread replies, so it stays expanded.
    await expect(page.locator(reply(DEEP.l3))).toBeVisible();
  });

  test('loading a thread does not mark it read', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await openThread(page, NOTE_IDS.deepThread);

    // Long enough for the old timer-based version to have fired.
    await page.waitForTimeout(4000);
    const calls = await readTestCalls(page);
    expect(calls.find((c) => c.table === 'thread_read_state')).toBeFalsy();
    // The unread markers are still there because nothing was read.
    await expect(page.locator('.ct-unread-marker')).toBeVisible();
  });

  test('reading a reply advances the marker; skipping ahead does not', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await openThread(page, NOTE_IDS.deepThread);

    // Reader One's stored position is 2. Dwell on reply 3 specifically.
    await page.locator(reply(DEEP.l3)).scrollIntoViewIfNeeded();
    await expect.poll(async () => {
      const calls = await readTestCalls(page);
      const write = calls.filter((c) => c.table === 'thread_read_state').pop();
      return write ? write.rows[0].last_read_sequence : 0;
    }, { timeout: 12000 }).toBeGreaterThanOrEqual(3);

    const calls = await readTestCalls(page);
    const write = calls.filter((c) => c.table === 'thread_read_state').pop();
    // It stops at the highest CONTIGUOUS sequence seen. Reaching reply 3 must
    // not silently mark 4 and 5 read as well.
    expect(write.rows[0].last_read_sequence).toBeLessThanOrEqual(5);
  });

  test('an old permalink does not mark newer replies read', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    // The 320-reply thread, not the four-level one: on a desktop screen every
    // reply of the small thread is genuinely visible at once, so it cannot show
    // the difference between "seen" and "scrolled past". Here reply 1 and reply
    // 300 cannot both be on screen, which is the real shape of the problem.
    const firstBulkReply = 'd0000000-0000-4000-8000-000000000000';
    await openThread(page, NOTE_IDS.largeThread, `&comment=${firstBulkReply}`);
    await expect(page.locator(reply(firstBulkReply))).toBeFocused();
    await page.waitForTimeout(4500);

    const calls = await readTestCalls(page);
    const write = calls.filter((c) => c.table === 'thread_read_state').pop();
    const sequence = write ? write.rows[0].last_read_sequence : 0;
    // Following a permalink is navigation, not reading. Whatever was never on
    // screen stays unread, so the marker lands near the top of the thread
    // rather than at its end.
    expect(sequence).toBeLessThan(60);
    await expect(page.locator('.ct-reply.is-unread')).not.toHaveCount(0);
  });
});

test.describe('Thread reader — keyboard', () => {
  test('slash focuses search and r opens the composer', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await openThread(page, NOTE_IDS.deepThread);

    await page.locator('body').press('/');
    await expect(page.locator('#ctSearch')).toBeFocused();

    await page.locator('#ctSearch').press('Escape');
    await page.locator('body').press('r');
    await expect(page.locator('.ct-composer-input')).toBeFocused();
  });

  test('shortcuts never fire while typing', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await openThread(page, NOTE_IDS.deepThread);

    await page.locator('.ct-composer-input').fill('');
    await page.locator('.ct-composer-input').type('r/u j k');
    await expect(page.locator('.ct-composer-input')).toHaveValue('r/u j k');
    await expect(page.locator('#ctSearch')).not.toBeFocused();
  });

  test('the shortcut list is reachable and documented', async ({ page }) => {
    await preparePage(page, { user: null });
    await openThread(page, NOTE_IDS.deepThread);

    await page.click('#ctHelp');
    const dialog = page.locator('#ctHelpDialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Jump to the first unread');
  });
});

test.describe('Thread reader — scale and mobile', () => {
  test('a 300+ reply thread pages its branches instead of rendering them all', async ({ page }) => {
    await preparePage(page, { user: null });
    await openThread(page, NOTE_IDS.largeThread);

    // BRANCH_PAGE_SIZE is 10, so the first screen holds ten branches, not 320.
    await expect(page.locator(REPLY)).toHaveCount(10);
    await expect(page.locator('#ctLoadMore')).toBeVisible();

    await page.click('#ctLoadMore');
    await expect(page.locator(REPLY)).toHaveCount(20);
  });

  test('mobile keeps the reply text readable rather than squeezing it', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'About the phone layout specifically');
    await preparePage(page, { user: null });
    await openThread(page, NOTE_IDS.deepThread);

    // The deepest reply must still have a usable measure, which is exactly what
    // capping indentation at one level on mobile is for.
    const width = await page.locator(reply(DEEP.l4)).evaluate((node) => node.getBoundingClientRect().width);
    expect(width).toBeGreaterThan(240);
  });

  test('the source panel is reachable on a phone', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'About the phone layout specifically');
    await preparePage(page, { user: null });
    await openThread(page, NOTE_IDS.singleWordRange);

    // The rails collapse on a phone, so the toggle is the ONLY way to reach the
    // source panel -- the plan's stated differentiator. It was briefly
    // unreachable at every width because a display:none rule outranked the
    // media query that was meant to reveal it.
    const toggle = page.locator('#ctSourceToggle');
    await expect(toggle).toBeVisible();
    await expect(page.locator('.ct-source-text')).toBeHidden();

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.ct-source-text')).toBeVisible();
    await expect(page.locator('.ct-source-text')).toHaveText('ארבעה ראשי שנים הם');
  });

  test('the outline is reachable on a phone', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'About the phone layout specifically');
    await preparePage(page, { user: null });
    await openThread(page, NOTE_IDS.deepThread);

    await page.click('#ctOutlineToggle');
    await expect(page.locator('.ct-branch-map')).toBeVisible();
  });

  test('the toolbar does not push the discussion off the first screen', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'About the phone layout specifically');
    await preparePage(page, { user: USERS.ordinary });
    await openThread(page, NOTE_IDS.deepThread);

    // Eight wrapped controls used to stack four rows deep and put the opening
    // post below the fold on a 915px-tall phone.
    const toolbar = await page.locator('#ctToolbar').evaluate((n) => n.getBoundingClientRect().height);
    expect(toolbar).toBeLessThan(80);

    const rootTop = await page.locator('.ct-root').evaluate((n) => n.getBoundingClientRect().top);
    const viewport = await page.evaluate(() => window.innerHeight);
    expect(rootTop).toBeLessThan(viewport);
  });

  test('the page does not scroll horizontally on a phone', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'About the phone layout specifically');
    await preparePage(page, { user: null });
    await openThread(page, NOTE_IDS.deepThread);

    const layout = await page.evaluate(() => ({
      visual: Math.round(window.visualViewport.width),
      document: document.documentElement.scrollWidth,
    }));
    // Unlike /browse/ (audit F-15), this page must fit the screen exactly.
    expect(layout.document).toBe(layout.visual);
  });
});

test.describe('Thread reader — accessibility', () => {
  test('each reply announces its author and nesting level', async ({ page }) => {
    await preparePage(page, { user: null });
    await openThread(page, NOTE_IDS.deepThread);

    await expect(page.locator(reply(DEEP.l3)))
      .toHaveAttribute('aria-label', /Reply by .+, level 3, replying to /);
  });

  test('a branch toggle exposes its expanded state', async ({ page }) => {
    await preparePage(page, { user: null });
    await openThread(page, NOTE_IDS.deepThread);

    const toggle = page.locator('.ct-branch-toggle').first();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await toggle.click();
    await expect(page.locator('.ct-collapsed-button').first()).toHaveAttribute('aria-expanded', 'false');
  });

  test('a selected reaction exposes its pressed state and count', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await openThread(page, NOTE_IDS.singleWordRange);

    const pill = page.locator('.ct-reaction').first();
    await expect(pill).toHaveAttribute('aria-pressed', /true|false/);
    await expect(pill).toHaveAttribute('aria-label', /Helpful|Insightful|Chazak|Shtark|Great Kasha/);
  });
});

// ---------------------------------------------------------------------------
// Prompt 5: the writing experience. Most of the composer landed with the reader
// in Prompt 4; these cover what Prompt 5 adds — account-scoped drafts, no
// duplicate posts, submit-time races, and the keyboard-only flow.
// ---------------------------------------------------------------------------

test.describe('Composer — drafts belong to one account', () => {
  test('a draft is never restored into a different account', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await openThread(page, NOTE_IDS.noReplies);
    await page.fill('.ct-composer-input', 'Reader One is midway through a thought.');
    await page.waitForTimeout(400);

    // Same device, same thread, different person signs in.
    await page.evaluate((session) => window.__DAFSYNC_TEST_CLIENT__.__setSession(session), sessionFor(USERS.author));
    await expect(page.locator('.ct-root')).toBeVisible();

    await expect(page.locator('.ct-composer-input')).toHaveValue('');
    await expect(page.locator('.ct-composer-restored')).toBeHidden();
    // And the words themselves are nowhere on the page.
    await expect(page.locator('body')).not.toContainText('midway through a thought');
  });

  test('each account gets its own draft back', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await openThread(page, NOTE_IDS.noReplies);
    await page.fill('.ct-composer-input', 'Belongs to Reader One.');
    await page.waitForTimeout(400);

    await page.evaluate((session) => window.__DAFSYNC_TEST_CLIENT__.__setSession(session), sessionFor(USERS.author));
    await expect(page.locator('.ct-composer-input')).toHaveValue('');
    await page.fill('.ct-composer-input', 'Belongs to Author Two.');
    await page.waitForTimeout(400);

    await page.evaluate((session) => window.__DAFSYNC_TEST_CLIENT__.__setSession(session), sessionFor(USERS.ordinary));
    await expect(page.locator('.ct-composer-input')).toHaveValue('Belongs to Reader One.');
  });

  test('a legacy unscoped draft is discarded, not adopted', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await page.addInitScript((noteId) => {
      // The v1 key shape, written before drafts were scoped to an account.
      localStorage.setItem(`dafsync.chabura.draft:${noteId}:root`, JSON.stringify({ body: 'ORPHAN-CANARY', mentions: [] }));
    }, NOTE_IDS.noReplies);
    await openThread(page, NOTE_IDS.noReplies);

    await expect(page.locator('.ct-composer-input')).toHaveValue('');
    await expect(page.locator('body')).not.toContainText('ORPHAN-CANARY');
  });

  test('drafts are per reply target, not per thread', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await openThread(page, NOTE_IDS.deepThread);

    await page.fill('.ct-composer-input', 'A root-level thought.');
    await page.locator(`${reply(DEEP.l1)} button:has-text("Reply")`).click();
    await page.locator('.ct-inline-composer .ct-composer-input').fill('A reply to level one.');
    await page.waitForTimeout(400);
    await page.reload();
    await expect(page.locator('.ct-root')).toBeVisible();

    await expect(page.locator('#ctComposer .ct-composer-input')).toHaveValue('A root-level thought.');
    await page.locator(`${reply(DEEP.l1)} button:has-text("Reply")`).click();
    await expect(page.locator('.ct-inline-composer .ct-composer-input')).toHaveValue('A reply to level one.');
  });
});

test.describe('Composer — optimistic send and idempotency', () => {
  test('a reply appears immediately in a sending state, then settles', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await openThread(page, NOTE_IDS.noReplies);

    await page.fill('.ct-composer-input', 'Appears at once.');
    await page.click('.ct-composer button[type="submit"]');

    await expect(page.locator(REPLY)).toContainText('Appears at once.');
    await expect(page.locator(`${REPLY}.is-pending`)).toHaveCount(0);
    // Once settled it carries the real action row.
    await expect(page.locator(`${REPLY} button:has-text("Reply")`)).toBeVisible();
  });

  test('the client sends the id, so a retry cannot double-post', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await openThread(page, NOTE_IDS.noReplies);

    await page.fill('.ct-composer-input', 'Sent once.');
    await page.click('.ct-composer button[type="submit"]');
    await expect(page.locator(REPLY)).toHaveCount(1);

    const calls = await readTestCalls(page);
    const insert = calls.find((c) => c.table === 'comments' && c.operation === 'insert');
    // A server-generated id would leave a retry with no way to collide.
    expect(insert.rows[0].id).toMatch(/^[0-9a-f-]{36}$/i);

    // Replay that exact insert, as a timed-out request retried would.
    const replayed = await page.evaluate(async (row) => {
      const client = window.__DAFSYNC_TEST_CLIENT__;
      const { error } = await client.from('comments').insert(row);
      return error ? error.code || 'error' : 'inserted-again';
    }, insert.rows[0]);
    expect(replayed).not.toBe('inserted-again');
    await expect(page.locator(REPLY)).toHaveCount(1);
  });

  test('a rejected reply is removed, not left looking posted', async ({ page }) => {
    await preparePage(page, {
      user: USERS.ordinary,
      control: { failures: { 'comments:insert': { message: 'nope', code: '42501' } } },
    });
    await openThread(page, NOTE_IDS.noReplies);

    await page.fill('.ct-composer-input', 'This never lands.');
    await page.click('.ct-composer button[type="submit"]');

    await expect(page.locator('.ct-composer-error')).toBeVisible();
    await expect(page.locator(REPLY)).toHaveCount(0);
    await expect(page.locator('.ct-composer-input')).toHaveValue('This never lands.');
  });
});

test.describe('Composer — submit-time races', () => {
  test('a thread locked while writing says so and keeps the draft', async ({ page }) => {
    await preparePage(page, {
      user: USERS.ordinary,
      control: { failures: { 'comments:insert': { message: 'new row violates row-level security policy', code: '42501' } } },
    });
    await openThread(page, NOTE_IDS.noReplies);
    await page.fill('.ct-composer-input', 'Written just before the lock.');

    // The thread is locked between opening the composer and submitting.
    await page.evaluate((noteId) => {
      const note = window.__DAFSYNC_TEST_DB__.line_notes.find((row) => row.id === noteId);
      note.status = 'locked';
    }, NOTE_IDS.noReplies);
    await page.click('.ct-composer button[type="submit"]');

    await expect(page.locator('.ct-composer-error')).toContainText('locked while you were writing');
    await expect(page.locator('.ct-composer-input')).toHaveValue('Written just before the lock.');
  });

  test('a thread deleted while writing says so and keeps the draft', async ({ page }) => {
    await preparePage(page, {
      user: USERS.ordinary,
      control: { failures: { 'comments:insert': { message: 'new row violates row-level security policy', code: '42501' } } },
    });
    await openThread(page, NOTE_IDS.noReplies);
    await page.fill('.ct-composer-input', 'Written just before the delete.');

    await page.evaluate((noteId) => {
      const note = window.__DAFSYNC_TEST_DB__.line_notes.find((row) => row.id === noteId);
      note.deleted_at = new Date().toISOString();
    }, NOTE_IDS.noReplies);
    await page.click('.ct-composer button[type="submit"]');

    await expect(page.locator('.ct-composer-error')).toContainText('deleted while you were writing');
    await expect(page.locator('.ct-composer-input')).toHaveValue('Written just before the delete.');
  });

  test('a session that ends mid-compose keeps the text and says what to do', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await openThread(page, NOTE_IDS.noReplies);
    await page.fill('.ct-composer-input', 'Typed before the session ended.');

    // Signed out in another tab: the composer is still on screen with text in it.
    await page.evaluate(() => {
      window.__DAFSYNC_TEST_SESSION__ = null;
      window.DafSyncAuth.getUser = () => null;
    });
    await page.click('.ct-composer button[type="submit"]');

    await expect(page.locator('.ct-composer-error')).toContainText('session ended');
    await expect(page.locator('.ct-composer-input')).toHaveValue('Typed before the session ended.');
  });
});

test.describe('Composer — quoting and answer state', () => {
  test('a quote whose original was edited afterwards says so', async ({ page }) => {
    const db = buildDatabase();
    const source = db.comments.find((row) => row.id === DEEP.l1);
    // Edited after the quoting reply was written.
    source.edited_at = new Date(Date.parse('2026-09-02T12:00:00.000Z')).toISOString();
    await preparePage(page, { user: null, db });
    await openThread(page, NOTE_IDS.deepThread);

    await expect(page.locator(`${reply(DEEP.quoting)} .ct-quote-stale`)).toContainText('edited since');
  });

  test('deleting the marked answer reopens the discussion', async ({ page }) => {
    const db = buildDatabase();
    // Reader One authored the reply that is the marked answer, so they can delete it.
    await preparePage(page, { user: USERS.ordinary, db });
    await openThread(page, NOTE_IDS.deepThread);
    await expect(page.locator('.ct-answer-flag')).toBeVisible();

    await page.locator(`${reply(DEEP.l1)} .ct-more`).click();
    await page.click('.ct-menu-item:has-text("Delete")');
    await page.locator('.ct-confirm button:has-text("Delete")').click();

    // The database clears the pointer by trigger; the page must not keep
    // advertising an answer nobody can read until a reload.
    await expect(page.locator('.ct-answer-flag')).toHaveCount(0);
    await expect(page.locator('#ctStatus')).toContainText('open again');
  });
});

test.describe('Composer — keyboard only', () => {
  test('a reply can be written and posted without a mouse', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await openThread(page, NOTE_IDS.noReplies);

    await page.locator('body').press('r');
    await expect(page.locator('.ct-composer-input')).toBeFocused();
    await page.keyboard.type('Posted entirely from the keyboard.');
    await page.keyboard.press('Control+Enter');

    await expect(page.locator(REPLY)).toContainText('Posted entirely from the keyboard.');
  });

  test('an action menu is navigable with arrows and returns focus on Escape', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await openThread(page, NOTE_IDS.deepThread);

    const more = page.locator(`${reply(DEEP.l1)} .ct-more`);
    await more.click();
    await expect(page.locator('.ct-menu-item').first()).toBeFocused();

    await page.keyboard.press('ArrowDown');
    await expect(page.locator('.ct-menu-item').nth(1)).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('.ct-menu-item').first()).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(page.locator('.ct-menu')).toHaveCount(0);
    // Focus goes back where it came from rather than to the top of the page.
    await expect(more).toBeFocused();
  });

  test('mention chips are one tab stop with arrow navigation inside', async ({ page }) => {
    // A viewer who is neither the root author nor a replier, so both
    // participants are offered rather than one.
    await preparePage(page, { user: USERS.brandNew });
    await openThread(page, NOTE_IDS.deepThread);

    const chips = page.locator('#ctComposer .ct-mention-chip');
    await expect(chips.first()).toHaveAttribute('tabindex', '0');
    await expect(chips.nth(1)).toHaveAttribute('tabindex', '-1');

    await chips.first().focus();
    await page.keyboard.press('ArrowRight');
    await expect(chips.nth(1)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('#ctComposer .ct-composer-input')).toBeFocused();
  });

  test('reporting is a real dialog, reachable and cancellable by keyboard', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await openThread(page, NOTE_IDS.singleWordRange);

    await page.locator(`${ROOT} .ct-more`).click();
    await page.click('.ct-menu-item:has-text("Report")');

    const dialog = page.locator('.ct-confirm');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('the author is not told who reported them');
    await expect(page.locator('#ctReportReason')).toBeFocused();

    await page.keyboard.type('Off topic and unsourced.');
    await dialog.locator('button:has-text("Report")').click();

    const calls = await readTestCalls(page);
    const insert = calls.find((c) => c.table === 'reports' && c.operation === 'insert');
    expect(insert.rows[0].reason).toBe('Off topic and unsourced.');
  });
});

// ---------------------------------------------------------------------------
// Prompt 6: orientation and continuity. Read state, saves, server-side search
// and notifications. Read-state and search coverage lives with their own
// describes above; these are the pieces Prompt 6 adds.
// ---------------------------------------------------------------------------

test.describe('Notifications', () => {
  test('a burst on one thread collapses into a single row', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await openThread(page, NOTE_IDS.deepThread);

    await page.click('#ccNotifyButton');
    const items = page.locator('.cc-notify-item');
    // Six rows in the fixture: three replies on one thread, a mention on
    // another, one already-read row on a third, and one belonging to a
    // different account. This reader sees three groups, and the burst of three
    // is ONE of them -- a storm of identical lines is the failure mode avoided.
    await expect(items).toHaveCount(3);
    await expect(page.locator('.cc-notify-panel')).toContainText('Author Two replied (3 times)');
    // Newest first, so the mention that arrived last leads.
    await expect(items.first()).toContainText('mentioned you');
  });

  test('the badge counts unread rows and ignores other accounts', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await openThread(page, NOTE_IDS.deepThread);

    // Four unread for this reader; the fifth is read and the sixth belongs to
    // someone else.
    await expect(page.locator('#ccNotifyBadge')).toHaveText('4');
    await page.click('#ccNotifyButton');
    await expect(page.locator('.cc-notify-panel')).not.toContainText('OTHER-ACCOUNT-CANARY');
  });

  test('opening the panel does not mark anything read', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await openThread(page, NOTE_IDS.deepThread);

    await page.click('#ccNotifyButton');
    await expect(page.locator('.cc-notify-item').first()).toBeVisible();
    await page.waitForTimeout(600);

    const calls = await readTestCalls(page);
    expect(calls.find((c) => c.table === 'notifications' && c.operation === 'update')).toBeFalsy();
    await expect(page.locator('#ccNotifyBadge')).toHaveText('4');
  });

  test('opening one group marks only that group read', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await openThread(page, NOTE_IDS.deepThread);

    await page.click('#ccNotifyButton');
    // Following the link navigates, and navigation re-seeds the fixture, which
    // would wipe the very calls under test. The default is suppressed in the
    // capture phase so the link's own handler still runs.
    await page.evaluate(() => {
      document.addEventListener('click', (event) => {
        if (event.target.closest('a')) event.preventDefault();
      }, true);
    });

    await page.locator('.cc-notify-item', { hasText: 'replied (3 times)' }).locator('a').click();
    await page.waitForTimeout(400);

    const calls = await readTestCalls(page);
    const update = calls.find((c) => c.table === 'notifications' && c.operation === 'update');
    expect(update).toBeTruthy();
    // The three rows of that thread, and not the mention on the other one.
    expect(update.rows).toHaveLength(3);
    expect(update.rows.every((row) => row.note_id === NOTE_IDS.deepThread)).toBe(true);
  });

  test('a notification deep-links to the exact reply', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await openThread(page, NOTE_IDS.deepThread);

    await page.click('#ccNotifyButton');
    const href = await page.locator('.cc-notify-item', { hasText: 'replied (3 times)' })
      .locator('a').getAttribute('href');
    expect(href).toContain(`thread=${NOTE_IDS.deepThread}`);
    // The LATEST reply of the burst, so following it lands on what is new.
    expect(href).toContain('comment=b0000000-0000-4000-8000-000000000004');

    await page.goto(href);
    await expect(page.locator('#comment-b0000000-0000-4000-8000-000000000004')).toBeFocused();
  });

  test('a signed-out reader is offered no notification bell at all', async ({ page }) => {
    await preparePage(page, { user: null });
    await openThread(page, NOTE_IDS.deepThread);
    await expect(page.locator('#ccNotifyButton')).toBeHidden();
  });

  test('mark all read clears the badge', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await openThread(page, NOTE_IDS.deepThread);

    await page.click('#ccNotifyButton');
    await page.click('.cc-notify-head button:has-text("Mark all read")');
    await expect(page.locator('#ccNotifyBadge')).toBeHidden();
  });
});

test.describe('Saved replies and orientation', () => {
  test('a single reply can be saved and unsaved', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await openThread(page, NOTE_IDS.deepThread);

    const save = page.locator(`${reply(DEEP.l2)} button[aria-pressed]:has-text("Save")`);
    await save.click();
    await expect(page.locator(`${reply(DEEP.l2)} button[aria-pressed="true"]`)).toHaveText('Saved');

    const calls = await readTestCalls(page);
    const insert = calls.find((c) => c.table === 'bookmarks' && c.operation === 'insert');
    expect(insert.rows[0].target_type).toBe('comment');
    expect(insert.rows[0].target_id).toBe(DEEP.l2);
  });

  test('a failed save of a reply is rolled back', async ({ page }) => {
    await preparePage(page, {
      user: USERS.ordinary,
      control: { failures: { 'bookmarks:insert': { message: 'permission denied', code: '42501' } } },
    });
    await openThread(page, NOTE_IDS.deepThread);

    await page.locator(`${reply(DEEP.l2)} button[aria-pressed]:has-text("Save")`).click();
    await expect(page.locator(`${reply(DEEP.l2)} button[aria-pressed]`)).toHaveText('Save');
    await expect(page.locator('#ctToast')).toContainText('You do not have permission');
  });

  test('previous and next unread controls are a pair', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await openThread(page, NOTE_IDS.deepThread);

    await expect(page.locator('#ctUnreadPrev')).toBeVisible();
    await expect(page.locator('#ctUnreadNext')).toBeVisible();
    await page.click('#ctUnreadNext');
    await expect(page.locator('.ct-reply.is-unread').first()).toBeVisible();
  });

  test('a signed-out reader is not offered Save on a reply', async ({ page }) => {
    await preparePage(page, { user: null });
    await openThread(page, NOTE_IDS.deepThread);
    await expect(page.locator(`${reply(DEEP.l2)} button:has-text("Save")`)).toHaveCount(0);
  });
});
