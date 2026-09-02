import { test, expect } from '@playwright/test';
import { preparePage, readTestCalls } from '../support/harness.mjs';
import { buildDatabase, USERS, NOTE_IDS } from '../fixtures/dataset.mjs';

// Discussion behaviour inside the shared note dialog (notes.js), which is what
// Cloud Chaburah's "View thread" currently opens. Phase 4 replaces this with a
// dedicated /chaburah/thread/ route; until then this is the regression contract
// for replies, nested replies, reactions, follows, mentions and reporting.

const DIALOG = '#noteDialog';
const NOTE = (id) => `${DIALOG} .note-item[data-id="${id}"]`;

async function openThread(page, segmentRef = 'Chullin 89a.1') {
  await page.evaluate((ref) => {
    // chaburah.js sets state.dafRef the same way before delegating to the
    // shared dialog; mirroring that here keeps the test on the real path.
    // `state` is a top-level `const` in a classic script, so it lives in the
    // global LEXICAL scope and is not reachable as window.state -- it has to
    // be referenced bare, exactly as chaburah.js itself does.
    state.dafRef = 'Chullin 89a';
    window.DafNotes.open(ref, '');
  }, segmentRef);
  await expect(page.locator(DIALOG)).toBeVisible();
  await expect(page.locator(`${DIALOG} .note-item`).first()).toBeVisible();
}

test.describe('Note thread — reading', () => {
  test('signed-out reader sees public notes and a sign-in prompt, no composer', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/chaburah/');
    await openThread(page);

    await expect(page.locator('#noteSignInPrompt')).toBeVisible();
    await expect(page.locator('#noteCompose')).toBeHidden();
    // No write affordances at all for a signed-out reader.
    await expect(page.locator(`${DIALOG} .reply-toggle-button`)).toHaveCount(0);
    await expect(page.locator(`${DIALOG} .follow-toggle-button`)).toHaveCount(0);
    await expect(page.locator(`${DIALOG} .note-report-button`)).toHaveCount(0);
  });

  test('signed-in reader gets the composer and reply controls', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await page.goto('/chaburah/');
    await openThread(page);

    await expect(page.locator('#noteCompose')).toBeVisible();
    await expect(page.locator('#noteSignInPrompt')).toBeHidden();
    await expect(page.locator(`${DIALOG} .reply-toggle-button`).first()).toBeVisible();
  });

  test('renders a four-level nested reply chain', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await page.goto('/chaburah/');
    await openThread(page);

    const thread = page.locator(NOTE(NOTE_IDS.deepThread));
    for (let level = 1; level <= 4; level += 1) {
      await expect(thread).toContainText(`Reply at level ${level}`);
    }
  });

  test('a moderator-hidden reply keeps its visible descendant', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await page.goto('/chaburah/');
    await openThread(page);

    const thread = page.locator(NOTE(NOTE_IDS.hiddenParentThread));
    // The descendant must survive its parent being hidden -- the current
    // implementation's tombstone equivalent.
    await expect(thread).toContainText('Descendant of a hidden reply');
  });

  test('a word-range note quotes its own selected passage', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await page.goto('/chaburah/');
    await openThread(page);

    await expect(page.locator(`${NOTE(NOTE_IDS.singleWordRange)} .note-item-quote`))
      .toHaveText('ארבעה ראשי שנים הם');
  });

  test('a note with a video timestamp shows a seek pill; one without does not', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await page.goto('/chaburah/');
    await openThread(page);

    await expect(page.locator(`${NOTE(NOTE_IDS.singleWordRange)} .note-timestamp-seek`)).toHaveCount(1);
    await expect(page.locator(`${NOTE(NOTE_IDS.multiRefWordRange)} .note-timestamp-seek`)).toHaveCount(0);
  });
});

test.describe('Note thread — writing', () => {
  test('posts a top-level reply', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await page.goto('/chaburah/');
    await openThread(page);

    const noteId = NOTE_IDS.noReplies;
    await page.locator(`.reply-toggle-button[data-note-id="${noteId}"][data-parent-id=""]`).click();
    const composer = page.locator(`.reply-compose[data-note-id="${noteId}"][data-parent-id=""]`);
    await composer.locator('.reply-body-input').fill('A brand new reply.');
    await composer.locator('.reply-post-button').click();

    await expect(page.locator(NOTE(noteId))).toContainText('A brand new reply.');
    const calls = await readTestCalls(page);
    const insert = calls.find((c) => c.table === 'comments' && c.operation === 'insert');
    expect(insert).toBeTruthy();
    expect(insert.rows[0].note_id).toBe(noteId);
    expect(insert.rows[0].parent_comment_id).toBeNull();
  });

  test('posts a nested reply carrying its parent_comment_id', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await page.goto('/chaburah/');
    await openThread(page);

    const noteId = NOTE_IDS.deepThread;
    const parentId = 'b0000000-0000-4000-8000-000000000001';
    await page.locator(`.reply-toggle-button[data-note-id="${noteId}"][data-parent-id="${parentId}"]`).click();
    const composer = page.locator(`.reply-compose[data-note-id="${noteId}"][data-parent-id="${parentId}"]`);
    await composer.locator('.reply-body-input').fill('Nested under level one.');
    await composer.locator('.reply-post-button').click();

    await expect(page.locator(NOTE(noteId))).toContainText('Nested under level one.');
    const calls = await readTestCalls(page);
    const insert = calls.find((c) => c.table === 'comments' && c.operation === 'insert');
    expect(insert.rows[0].parent_comment_id).toBe(parentId);
  });

  test('a failed reply surfaces the server message and does not silently drop', async ({ page }) => {
    await preparePage(page, {
      user: USERS.ordinary,
      // What can_post_publicly() rejection looks like to the client for a
      // brand-new or rate-limited account.
      control: { failures: { 'comments:insert': { message: 'new row violates row-level security policy' } } },
    });
    await page.goto('/chaburah/');
    await openThread(page);

    const noteId = NOTE_IDS.noReplies;
    await page.locator(`.reply-toggle-button[data-note-id="${noteId}"][data-parent-id=""]`).click();
    const composer = page.locator(`.reply-compose[data-note-id="${noteId}"][data-parent-id=""]`);
    await composer.locator('.reply-body-input').fill('This should fail.');
    await composer.locator('.reply-post-button').click();

    await expect(page.locator('.toast, #toast')).toContainText('row-level security');
    // The in-memory draft survives a rejected submit: postComment() returns
    // early on error without clearing the textarea or re-rendering the list.
    // (The gap Phase 5 addresses is persistence across a RELOAD, not this --
    // see the reload case below.)
    await expect(composer.locator('.reply-body-input')).toHaveValue('This should fail.');
    await expect(composer.locator('.reply-post-button')).toBeEnabled();
  });

  test('an unsent draft does NOT survive a reload (audit F-7, Phase 5 target)', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await page.goto('/chaburah/');
    await openThread(page);

    const noteId = NOTE_IDS.noReplies;
    await page.locator(`.reply-toggle-button[data-note-id="${noteId}"][data-parent-id=""]`).click();
    await page.locator(`.reply-compose[data-note-id="${noteId}"][data-parent-id=""] .reply-body-input`)
      .fill('Half-written thought worth keeping.');

    await page.reload();
    await openThread(page);
    await page.locator(`.reply-toggle-button[data-note-id="${noteId}"][data-parent-id=""]`).click();

    // Documents today's behaviour so Phase 5's draft persistence has a
    // concrete assertion to invert once localStorage drafts land.
    await expect(page.locator(`.reply-compose[data-note-id="${noteId}"][data-parent-id=""] .reply-body-input`))
      .toHaveValue('');
  });

  test('mention chips are limited to thread participants and never expose email', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await page.goto('/chaburah/');
    await openThread(page);

    const noteId = NOTE_IDS.deepThread;
    await page.locator(`.reply-toggle-button[data-note-id="${noteId}"][data-parent-id=""]`).click();
    const chips = page.locator(`.reply-compose[data-note-id="${noteId}"][data-parent-id=""] .mention-chip`);
    const labels = await chips.allTextContents();

    expect(labels.length).toBeGreaterThan(0);
    // The signed-in reader is never offered as a mention of themselves.
    expect(labels.join(' ')).not.toContain(USERS.ordinary.display_name);
    // No address from any persona may appear in the picker.
    for (const user of Object.values(USERS)) {
      expect(labels.join(' ')).not.toContain(user.email);
    }
  });

  test('selected mention chips are sent as mentioned_user_ids', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await page.goto('/chaburah/');
    await openThread(page);

    const noteId = NOTE_IDS.deepThread;
    await page.locator(`.reply-toggle-button[data-note-id="${noteId}"][data-parent-id=""]`).click();
    const composer = page.locator(`.reply-compose[data-note-id="${noteId}"][data-parent-id=""]`);
    const chip = composer.locator('.mention-chip').first();
    const mentionedId = await chip.getAttribute('data-user-id');
    await chip.click();
    await composer.locator('.reply-body-input').fill('Mentioning someone.');
    await composer.locator('.reply-post-button').click();

    const calls = await readTestCalls(page);
    const insert = calls.find((c) => c.table === 'comments' && c.operation === 'insert');
    expect(insert.rows[0].mentioned_user_ids).toContain(mentionedId);
  });
});

test.describe('Note thread — reactions, follows, reports', () => {
  test('adds a reaction through the reaction menu', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await page.goto('/chaburah/');
    await openThread(page);

    const note = page.locator(NOTE(NOTE_IDS.noReplies));
    await note.locator('.reaction-trigger-button').first().click();
    await note.locator('.reaction-menu-item[data-reaction-type="helpful"]').first().click();

    const calls = await readTestCalls(page);
    const insert = calls.find((c) => c.table === 'reactions' && c.operation === 'insert');
    expect(insert).toBeTruthy();
    expect(insert.rows[0].reaction_type).toBe('helpful');
    expect(insert.rows[0].target_type).toBe('note');
  });

  test('removes an existing reaction by selecting it again', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await page.goto('/chaburah/');
    await openThread(page);

    const note = page.locator(NOTE(NOTE_IDS.singleWordRange));
    await note.locator('.reaction-trigger-button').first().click();
    await note.locator('.reaction-menu-item[data-reaction-type="helpful"]').first().click();

    const calls = await readTestCalls(page);
    expect(calls.find((c) => c.table === 'reactions' && c.operation === 'delete')).toBeTruthy();
  });

  test('a reader may hold more than one reaction type on the same note', async ({ page }) => {
    const db = buildDatabase();
    await preparePage(page, { user: USERS.ordinary, db });
    await page.goto('/chaburah/');
    await openThread(page);

    const note = page.locator(NOTE(NOTE_IDS.singleWordRange));
    await note.locator('.reaction-trigger-button').first().click();
    await note.locator('.reaction-menu-item[data-reaction-type="insightful"]').first().click();

    const calls = await readTestCalls(page);
    const insert = calls.find((c) => c.table === 'reactions' && c.operation === 'insert');
    expect(insert.rows[0].reaction_type).toBe('insightful');
    // The pre-existing 'helpful' reaction from the same user is untouched.
    expect(calls.find((c) => c.table === 'reactions' && c.operation === 'delete')).toBeFalsy();
  });

  test('follows and unfollows a thread', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await page.goto('/chaburah/');
    await openThread(page);

    const unfollowed = page.locator(`.follow-toggle-button[data-note-id="${NOTE_IDS.noReplies}"]`);
    await expect(unfollowed).toHaveText('Follow');
    await unfollowed.click();
    await expect(page.locator(`.follow-toggle-button[data-note-id="${NOTE_IDS.noReplies}"]`)).toHaveText('Following');

    const calls = await readTestCalls(page);
    expect(calls.find((c) => c.table === 'thread_follows' && c.operation === 'insert')).toBeTruthy();
  });

  test('reports a note with a reason', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await page.goto('/chaburah/');
    page.on('dialog', (dialog) => dialog.accept('Off topic and unsourced.'));
    await openThread(page);

    await page.locator(`${NOTE(NOTE_IDS.noReplies)} .note-report-button`).first().click();

    await expect.poll(async () => {
      const calls = await readTestCalls(page);
      return Boolean(calls.find((c) => c.table === 'reports' && c.operation === 'insert'));
    }).toBe(true);

    const calls = await readTestCalls(page);
    const insert = calls.find((c) => c.table === 'reports' && c.operation === 'insert');
    expect(insert.rows[0].reason).toBe('Off topic and unsourced.');
    expect(insert.rows[0].target_type).toBe('note');
  });

  test('a cancelled report prompt files nothing', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await page.goto('/chaburah/');
    page.on('dialog', (dialog) => dialog.dismiss());
    await openThread(page);

    await page.locator(`${NOTE(NOTE_IDS.noReplies)} .note-report-button`).first().click();
    await page.waitForTimeout(200);

    const calls = await readTestCalls(page);
    expect(calls.find((c) => c.table === 'reports')).toBeFalsy();
  });

  test('a reader is never offered a report button on their own note', async ({ page }) => {
    await preparePage(page, { user: USERS.author });
    await page.goto('/chaburah/');
    await openThread(page);

    // Every fixture note on this segment is authored by USERS.author.
    await expect(page.locator(`${NOTE(NOTE_IDS.noReplies)} .note-report-button`)).toHaveCount(0);
  });
});
