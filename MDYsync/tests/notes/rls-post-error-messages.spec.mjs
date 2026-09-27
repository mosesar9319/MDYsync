import { test, expect } from '@playwright/test';
import { preparePage, failOnPageError } from '../support/harness.mjs';
import { buildDatabase, sessionFor, USERS } from '../fixtures/dataset.mjs';

// Reported directly: saving a public note (or posting a reply) from an
// account still under can_post_publicly()'s anti-spam gate (see
// supabase/baseline/00_current_production_schema.sql) showed the raw
// Postgres violation -- "new row violates row-level security policy for
// table \"line_notes\"" -- with no indication the note hadn't actually been
// saved, let alone why. notes.js's publicPostErrorMessage() translates that
// into an actionable toast instead, picked between the two guards
// can_post_publicly() actually enforces (account under 24h old vs. the
// 10-posts-per-hour rate limit) using profile.created_at, which auth.js's
// getProfile() already has client-side.
//
// The stub client's control.failures lets a spec force the exact insert
// that would otherwise be gated server-side to fail with that same message,
// without needing a real 24-hour-old or rate-limited account.
const RLS_MESSAGE = 'new row violates row-level security policy for table "line_notes"';

const REF = 'Chullin 89a';
const SEGMENT = 'Chullin 89a.1';

function dbWithProfileAge(hoursOld) {
  const db = buildDatabase();
  const profile = db.profiles.find((p) => p.id === USERS.author.id);
  profile.created_at = new Date(Date.now() - hoursOld * 3600000).toISOString();
  return db;
}

async function openComposerAsPublic(page) {
  await page.evaluate((ref) => {
    state.dafRef = 'Chullin 89a';
    window.DafNotes.open(ref, '');
  }, SEGMENT);
  await expect(page.locator('#noteCompose')).toBeVisible();
  await page.click('.note-privacy-option[data-privacy="live"]');
  await page.fill('#noteBodyInput', 'A note that will fail to save.');
}

test.describe('Public-post RLS violations get a friendly, actionable toast', () => {
  test('an account under 24 hours old is told about the signup-age gate', async ({ page }) => {
    failOnPageError(page);
    const db = dbWithProfileAge(1); // 1 hour old
    await preparePage(page, {
      db,
      session: sessionFor(USERS.author),
      control: { failures: { 'line_notes:insert': { message: RLS_MESSAGE } } },
    });
    await page.goto('/watch/?ref=' + encodeURIComponent(REF));
    await openComposerAsPublic(page);
    await page.click('#saveNoteButton');

    await expect(page.locator('#toast')).toHaveText(
      /New accounts can only post publicly starting 24 hours after signup.*Save this as Private for now/
    );
  });

  test('an established account past 24 hours is told about the rate limit instead', async ({ page }) => {
    failOnPageError(page);
    const db = dbWithProfileAge(24 * 30); // 30 days old
    await preparePage(page, {
      db,
      session: sessionFor(USERS.author),
      control: { failures: { 'line_notes:insert': { message: RLS_MESSAGE } } },
    });
    await page.goto('/watch/?ref=' + encodeURIComponent(REF));
    await openComposerAsPublic(page);
    await page.click('#saveNoteButton');

    await expect(page.locator('#toast')).toHaveText(
      /posting publicly a bit too fast \(the limit is 10 an hour\)/
    );
  });

  test('a private note never hits publicPostErrorMessage -- an unrelated insert failure shows raw', async ({ page }) => {
    failOnPageError(page);
    const db = dbWithProfileAge(1); // would trip the 24h gate if this were public
    await preparePage(page, {
      db,
      session: sessionFor(USERS.author),
      control: { failures: { 'line_notes:insert': { message: 'Some other database error' } } },
    });
    await page.goto('/watch/?ref=' + encodeURIComponent(REF));
    await page.evaluate((ref) => {
      state.dafRef = 'Chullin 89a';
      window.DafNotes.open(ref, '');
    }, SEGMENT);
    await expect(page.locator('#noteCompose')).toBeVisible();
    // Stays on the default Private option -- no click on "live".
    await page.fill('#noteBodyInput', 'A private note that fails for an unrelated reason.');
    await page.click('#saveNoteButton');

    await expect(page.locator('#toast')).toHaveText('Some other database error');
  });

  test('a failed reply gets the same treatment, phrased for a comment (no privacy option to fall back on)', async ({ page }) => {
    failOnPageError(page);
    const db = dbWithProfileAge(1); // 1 hour old
    await preparePage(page, {
      db,
      session: sessionFor(USERS.author),
      control: { failures: { 'comments:insert': { message: 'new row violates row-level security policy for table "comments"' } } },
    });
    await page.goto('/watch/?ref=' + encodeURIComponent(REF));

    // legacySegmentOnly is a public note already on this segment (authored
    // by USERS.author, same as the signed-in reader here), which is what
    // gives #noteList a "Reply" toggle to open in the first place.
    await page.evaluate((ref) => {
      state.dafRef = 'Chullin 89a';
      window.DafNotes.open(ref, '');
    }, SEGMENT);
    await expect(page.locator('#noteCompose')).toBeVisible();

    const noteId = 'a0000000-0000-4000-8000-000000000001'; // NOTE_IDS.legacySegmentOnly
    await page.click(`.reply-toggle-button[data-note-id="${noteId}"][data-parent-id=""]`);
    const composer = page.locator(`.reply-compose[data-note-id="${noteId}"][data-parent-id=""]`);
    await expect(composer).toBeVisible();
    await composer.locator('.reply-body-input').fill('A reply that will fail to post.');
    await composer.locator('.reply-post-button').click();

    await expect(page.locator('#toast')).toHaveText(
      /New accounts can only post publicly starting 24 hours after signup.*Try again once your account is a day old/
    );
  });
});
