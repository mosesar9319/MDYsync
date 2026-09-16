import { test, expect } from '@playwright/test';
import { preparePage, failOnPageError, readTestQueries } from '../support/harness.mjs';
import { sessionFor, USERS } from '../fixtures/dataset.mjs';

// Studio's "New accounts" panel: the most recently registered accounts,
// newest first, via the admin-only-readable profiles_admin_read policy
// (same policy the "User role labels" panel already relies on -- see
// adminListRecentSignups's own header in profile-data.js for why this
// needed no new migration).
//
// What this suite is NOT for: proving a non-admin cannot read profiles --
// that is supabase/tests/rls_authorization.sql's own job, same carve-out as
// studio-profiles.spec.mjs.

async function openStudioAsAdmin(page) {
  await preparePage(page, { session: sessionFor(USERS.admin) });
  await page.goto('/studio/');
  await expect(page.locator('#newAccountsSection')).toBeVisible();
}

test.describe('Studio — new accounts', () => {
  test('loads automatically on open, newest account first', async ({ page }) => {
    failOnPageError(page);
    await openStudioAsAdmin(page);

    const items = page.locator('#newAccountsList .note-item');
    await expect(items).toHaveCount(4);
    await expect(items.first()).toContainText('New Account');
    await expect(items.first()).toContainText('newbie@example.com');
  });

  test('shows each account\'s email and its formatted signup time', async ({ page }) => {
    failOnPageError(page);
    await openStudioAsAdmin(page);

    // Fixture created_at values are fixed relative to 2026-09-02 (see
    // isoMinutesAgo's own header in dataset.mjs), so against the real clock
    // formatNoteTime falls past its "min ago"/"hr ago" branches into its
    // date fallback -- this asserts against that same formatNoteTime output
    // rather than a specific relative-time string.
    const first = page.locator('#newAccountsList .note-item').first();
    await expect(first).toContainText('newbie@example.com');
    const expected = await page.evaluate(() => formatNoteTime('2026-09-02T11:30:00.000Z'));
    await expect(first).toContainText(expected);
  });

  test('Refresh re-queries recent signups', async ({ page }) => {
    failOnPageError(page);
    await openStudioAsAdmin(page);
    await expect(page.locator('#newAccountsList .note-item')).toHaveCount(4);

    await page.click('#refreshNewAccountsButton');
    await expect(page.locator('#newAccountsList .note-item')).toHaveCount(4);

    const queries = await readTestQueries(page);
    const profilesReads = queries.filter((tableName) => tableName === 'profiles');
    expect(profilesReads.length).toBeGreaterThanOrEqual(2);
  });
});
