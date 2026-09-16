import { test, expect } from '@playwright/test';
import { preparePage, failOnPageError, readTestCalls } from '../support/harness.mjs';
import { buildDatabase, sessionFor, USERS } from '../fixtures/dataset.mjs';

// /profile/: the signed-in reader's own display name and avatar, plus a
// "how this appears in Cloud Chaburah" preview.
//
// What this suite is NOT for: proving a stranger cannot write another
// account's profiles row, or that role_label is admin-only. Those are
// supabase/tests/rls_authorization.sql's own job (see its "11. Profile
// self-service" section) -- this stub has no RLS and answers every query as
// a trusted caller (see tests/README.md). What this proves is that the
// CLIENT calls the right thing with the right payload, renders the result,
// and degrades sensibly (a validation error, a missing avatar falling back
// to initials).
//
// The 1x1 PNG below is a real, valid image so the browser's `new Image()`
// actually fires `onload` -- a fake/garbage buffer would only ever fire
// `onerror`, which is not the path most of this suite needs to exercise.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64');

async function openProfile(page, options = {}) {
  await preparePage(page, options);
  await page.goto('/profile/');
}

test.describe('Profile page — signed out', () => {
  test('offers sign-in rather than a form', async ({ page }) => {
    failOnPageError(page);
    await openProfile(page, { session: null });
    await expect(page.locator('#pfSignedOut')).toBeVisible();
    await expect(page.locator('#pfProfile')).toBeHidden();
  });
});

test.describe('Profile page — display name', () => {
  test('pre-fills the current display name, and shows initials with no avatar set', async ({ page }) => {
    failOnPageError(page);
    await openProfile(page, { session: sessionFor(USERS.author) });
    await expect(page.locator('#pfProfile')).toBeVisible();
    await expect(page.locator('#pfDisplayName')).toHaveValue(USERS.author.display_name);
    // "Author Two" -> "AT", matching chabura-thread-view.js's own initials().
    await expect(page.locator('#pfAvatarPreview')).toHaveText('AT');
    await expect(page.locator('#pfAvatarPreview img')).toHaveCount(0);
  });

  test('a blank name is refused before any request is made', async ({ page }) => {
    failOnPageError(page);
    await openProfile(page, { session: sessionFor(USERS.author) });
    await page.fill('#pfDisplayName', '   ');
    await page.click('#pfSaveButton');
    await expect(page.locator('#pfError')).toContainText('Enter a display name');
    const calls = await readTestCalls(page);
    expect(calls.some((c) => c.table === 'profiles' && c.operation === 'update')).toBe(false);
  });

  test('an over-long name is refused client-side', async ({ page }) => {
    failOnPageError(page);
    await openProfile(page, { session: sessionFor(USERS.author) });
    // maxlength="80" on the input itself already stops a reader from TYPING
    // past the limit -- setting .value directly bypasses that, the same way
    // a pasted or programmatically-set value could, which is exactly the
    // scenario this defensive check (mirroring kuntras.js's own entry-body
    // one) exists for.
    await page.evaluate(() => {
      const input = document.getElementById('pfDisplayName');
      input.value = 'x'.repeat(81);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.click('#pfSaveButton');
    await expect(page.locator('#pfError')).toContainText('81 characters');
  });

  test('saving persists to the backing row and updates the preview', async ({ page }) => {
    failOnPageError(page);
    await openProfile(page, { session: sessionFor(USERS.author) });
    await page.fill('#pfDisplayName', 'Renamed Author');
    await page.click('#pfSaveButton');
    await expect(page.locator('#pfSaveStatus')).toHaveText('Saved.');
    await expect(page.locator('#pfPreviewName')).toHaveText('Renamed Author');

    const stored = await page.evaluate(() =>
      window.__DAFSYNC_TEST_DB__.profiles.find((p) => p.id === '22222222-2222-4222-8222-222222222222').display_name);
    expect(stored).toBe('Renamed Author');
  });

  test('a role_label already set by an admin shows read-only, with no way to edit it here', async ({ page }) => {
    failOnPageError(page);
    // The default fixture only labels the admin persona -- sign in as that
    // one to see the read-only line render.
    await openProfile(page, { session: sessionFor(USERS.admin) });
    await expect(page.locator('#pfRoleLabelNote')).toContainText('Moderator');
    await expect(page.locator('#pfRoleLabelNote')).toContainText('assigned by an admin');
    await expect(page.locator('#pfPreviewRole')).toHaveText('Moderator');
    // The only input in the whole form is the display name -- there is no
    // way to edit role_label here at all; the only path is Studio (see
    // studio-profiles.spec.mjs).
    await expect(page.locator('#pfForm input')).toHaveCount(1);
  });
});

test.describe('Profile page — avatar', () => {
  test('choosing a photo enables the crop canvas and the save button', async ({ page }) => {
    failOnPageError(page);
    await openProfile(page, { session: sessionFor(USERS.author) });
    await page.click('#pfChangeAvatarButton');
    await expect(page.locator('#pfAvatarDialog')).toBeVisible();
    await expect(page.locator('#pfAvatarSave')).toBeDisabled();

    await page.setInputFiles('#pfAvatarFile', { name: 'photo.png', mimeType: 'image/png', buffer: TINY_PNG });
    await expect(page.locator('#pfCropWrap')).toBeVisible();
    await expect(page.locator('#pfAvatarSave')).toBeEnabled();
    await expect(page.locator('#pfCropZoom')).toBeEnabled();
  });

  test('saving uploads to the avatars bucket and writes avatar_path', async ({ page }) => {
    failOnPageError(page);
    await openProfile(page, { session: sessionFor(USERS.author) });
    await page.click('#pfChangeAvatarButton');
    await page.setInputFiles('#pfAvatarFile', { name: 'photo.png', mimeType: 'image/png', buffer: TINY_PNG });
    await expect(page.locator('#pfAvatarSave')).toBeEnabled();
    await page.click('#pfAvatarSave');
    await expect(page.locator('#pfAvatarDialog')).toBeHidden();

    // The upload actually reached the stub's Storage surface, under this
    // user's own folder (matching avatars_owner_write's own {uid}/... path
    // convention -- see 20260916140000's own header).
    const storageKeys = await page.evaluate(() => Object.keys(window.__DAFSYNC_TEST_STORAGE__ || {}));
    expect(storageKeys.some((key) => key.startsWith('avatars/22222222-2222-4222-8222-222222222222/'))).toBe(true);

    // And the profile row's avatar_path was updated to a URL under that
    // same path -- the actual write profile-data.js's uploadAvatar makes
    // after the upload succeeds.
    const avatarPath = await page.evaluate(() =>
      window.__DAFSYNC_TEST_DB__.profiles.find((p) => p.id === '22222222-2222-4222-8222-222222222222').avatar_path);
    expect(avatarPath).toContain('avatars/22222222-2222-4222-8222-222222222222/');

    // The preview now points an <img> at it -- whether that URL actually
    // loads is Storage's own job, out of this stub's scope (see its header).
    await expect(page.locator('#pfAvatarPreview img')).toHaveAttribute('src', avatarPath);
  });

  test('panning and zooming do not error, and the canvas still saves', async ({ page }) => {
    failOnPageError(page);
    await openProfile(page, { session: sessionFor(USERS.author) });
    await page.click('#pfChangeAvatarButton');
    await page.setInputFiles('#pfAvatarFile', { name: 'photo.png', mimeType: 'image/png', buffer: TINY_PNG });
    await expect(page.locator('#pfCropWrap')).toBeVisible();

    const canvas = page.locator('#pfCropCanvas');
    const box = await canvas.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2 + 10);
    await page.mouse.up();

    await page.fill('#pfCropZoom', String(Number(await page.locator('#pfCropZoom').getAttribute('max'))));
    await page.locator('#pfCropZoom').dispatchEvent('input');

    await page.click('#pfAvatarSave');
    await expect(page.locator('#pfAvatarDialog')).toBeHidden();
  });
});
