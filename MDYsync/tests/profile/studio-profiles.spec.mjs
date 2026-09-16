import { test, expect } from '@playwright/test';
import { preparePage, failOnPageError, readTestCalls } from '../support/harness.mjs';
import { sessionFor, USERS } from '../fixtures/dataset.mjs';

// Studio's "User role labels" panel: search profiles by display name, set
// (or clear) role_label through the admin-only set_profile_role_label RPC.
//
// What this suite is NOT for: proving a non-admin cannot call the RPC, or
// that profiles_admin_read is really admin-only -- that is
// supabase/tests/rls_authorization.sql's own job (see its "11. Profile
// self-service" section). This stub answers every query as a trusted
// caller and has no RLS (see tests/README.md); it proves the CLIENT wires
// search and the RPC call correctly, nothing about who is allowed to.

async function openStudioAsAdmin(page) {
  await preparePage(page, { session: sessionFor(USERS.admin) });
  await page.goto('/studio/');
  await expect(page.locator('#profilesSection')).toBeVisible();
}

test.describe('Studio — user role labels', () => {
  test('prompts to search before showing anything', async ({ page }) => {
    failOnPageError(page);
    await openStudioAsAdmin(page);
    await expect(page.locator('#profilesList')).toContainText('Search for a user to label');
  });

  test('searching by display name lists a match, with its current label prefilled', async ({ page }) => {
    failOnPageError(page);
    await openStudioAsAdmin(page);
    await page.fill('#profilesSearch', 'Admin');
    await expect(page.locator('#profilesList .note-item')).toHaveCount(1);
    await expect(page.locator('#profilesList')).toContainText('Admin Four');
    await expect(page.locator('#profilesList')).toContainText('admin@example.com');
    await expect(page.locator('.role-label-input')).toHaveValue('Moderator');
  });

  test('a search matching nobody says so', async ({ page }) => {
    failOnPageError(page);
    await openStudioAsAdmin(page);
    await page.fill('#profilesSearch', 'Nobody Matches This At All');
    await expect(page.locator('#profilesList')).toContainText('No profile matches that');
  });

  test('saving a label calls the RPC with the right user id and value', async ({ page }) => {
    failOnPageError(page);
    await openStudioAsAdmin(page);
    await page.fill('#profilesSearch', 'Reader One');
    await expect(page.locator('.role-label-input')).toHaveValue('');
    await page.fill('.role-label-input', 'Chavrusa Coordinator');
    await page.click('.role-label-save');

    const calls = await readTestCalls(page);
    const rpcCall = calls.find((c) => c.rpc === 'set_profile_role_label');
    expect(rpcCall).toBeTruthy();
    expect(rpcCall.params).toEqual({
      p_user_id: '11111111-1111-4111-8111-111111111111',
      p_role_label: 'Chavrusa Coordinator',
    });
  });

  test('clearing a label (blank + save) sends null, not an empty string', async ({ page }) => {
    failOnPageError(page);
    await openStudioAsAdmin(page);
    await page.fill('#profilesSearch', 'Admin');
    await page.fill('.role-label-input', '');
    await page.click('.role-label-save');

    const calls = await readTestCalls(page);
    const rpcCall = calls.filter((c) => c.rpc === 'set_profile_role_label').pop();
    expect(rpcCall.params.p_role_label).toBeNull();
  });
});
