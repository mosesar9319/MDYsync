import { test, expect } from '@playwright/test';
import { preparePage, failOnPageError } from '../support/harness.mjs';
import { sessionFor, USERS } from '../fixtures/dataset.mjs';

// Kuntras Builder, slice 1: the shell -- a library of kuntrasim, and a tree
// editor of sections and freeform entries. Everything here is private; no
// public content, sharing, or citing another table's content exists yet
// (see supabase/migrations/20260915200000_kuntras_builder.sql's own header
// for why those are later slices).
//
// What this suite is NOT for: proving another account cannot read or write
// a reader's kuntras. That is supabase/tests/rls_authorization.sql, run
// against a real Postgres with real anon/authenticated roles -- this stub
// has no RLS and answers every query as a trusted caller, so it can only
// prove the CLIENT behaves, never that the server would refuse anything.

async function openLibrary(page) {
  await page.goto('/kuntras/');
  await expect(page.locator('#knFeed')).toBeVisible();
}

async function createKuntras(page, title) {
  page.once('dialog', (d) => d.accept(title));
  await page.click('#knNewButton');
  await expect(page.locator('#knBuilder')).toBeVisible();
  await expect(page.locator('#knBuilderTitle')).toHaveText(title);
}

async function addEntry(page, { via = '#knAddRootEntry', title = '', body }) {
  await page.click(via);
  await expect(page.locator('#knEntryDialog')).toBeVisible();
  if (title) await page.fill('#knEntryTitle', title);
  await page.fill('#knEntryBody', body);
  await page.click('#knEntrySubmit');
  await expect(page.locator('#knEntryDialog')).toBeHidden();
}

test.describe('Kuntras Builder — library', () => {
  test('signed out, offers sign-in rather than an empty list', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: null });
    await openLibrary(page);
    await expect(page.locator('#knFeed')).toContainText('Sign in');
  });

  test('signed in with none yet, offers to start one', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author) });
    await openLibrary(page);
    await expect(page.locator('#knFeed')).toContainText('No kuntrasim yet');
  });

  test('creating one opens the builder immediately, and lists it back on the library', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author) });
    await openLibrary(page);
    await createKuntras(page, 'Chullin sichas');

    await page.click('#knBackButton');
    await expect(page.locator('#knLibrary')).toBeVisible();
    const card = page.locator('.cc-card');
    await expect(card).toHaveCount(1);
    await expect(card.locator('.cc-card-title')).toHaveText('Chullin sichas');
    await expect(card.locator('.cc-chip-private')).toHaveText('Private');
  });

  test('a blank title is not created', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author) });
    await openLibrary(page);
    page.once('dialog', (d) => d.accept('   '));
    await page.click('#knNewButton');
    await expect(page.locator('#knBuilder')).toBeHidden();
    await expect(page.locator('#knFeed')).toContainText('No kuntrasim yet');
  });

  test('cancelling the title prompt creates nothing', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author) });
    await openLibrary(page);
    page.once('dialog', (d) => d.dismiss());
    await page.click('#knNewButton');
    await expect(page.locator('#knBuilder')).toBeHidden();
  });

  test('renaming the kuntras updates both the builder title and the card', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author) });
    await openLibrary(page);
    await createKuntras(page, 'Original title');

    page.once('dialog', (d) => d.accept('Renamed title'));
    await page.click('#knRenameButton');
    await expect(page.locator('#knBuilderTitle')).toHaveText('Renamed title');

    await page.click('#knBackButton');
    await expect(page.locator('.cc-card-title')).toHaveText('Renamed title');
  });

  test('deleting the open kuntras returns to an empty library', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author) });
    await openLibrary(page);
    await createKuntras(page, 'To be deleted');

    page.once('dialog', (d) => d.accept());
    await page.click('#knDeleteButton');
    await expect(page.locator('#knLibrary')).toBeVisible();
    await expect(page.locator('#knFeed')).toContainText('No kuntrasim yet');
  });
});

test.describe('Kuntras Builder — the tree', () => {
  test.beforeEach(async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author) });
    await openLibrary(page);
    await createKuntras(page, 'Chullin sichas');
  });

  test('a root-level entry renders even with no section at all', async ({ page }) => {
    await addEntry(page, { title: 'Opening thought', body: 'A note at the very top.' });
    await expect(page.locator('.kn-entry-title')).toHaveText('Opening thought');
    await expect(page.locator('.kn-entry-body')).toHaveText('A note at the very top.');
    // Nothing here belongs to any section -- there must be no section node
    // at all yet.
    await expect(page.locator('.kn-section')).toHaveCount(0);
  });

  test('a root section, a nested subsection, and an entry inside the nested one', async ({ page }) => {
    page.once('dialog', (d) => d.accept('Perek HaZoreah'));
    await page.click('#knAddRootSection');
    await expect(page.locator('.kn-section-title')).toHaveText('Perek HaZoreah');

    page.once('dialog', (d) => d.accept('Shechita'));
    await page.click('.kn-section >> text=+ Subsection');
    await expect(page.locator('.kn-section-title')).toHaveCount(2);

    // The entry button on the NESTED section, not the root one -- the
    // second "+ Entry" in document order, since the nested section renders
    // inside the root section's own body.
    await page.locator('.kn-section .kn-section .kn-section-actions >> text=+ Entry').click();
    await page.fill('#knEntryBody', 'Buried two levels deep.');
    await page.click('#knEntrySubmit');

    const nested = page.locator('.kn-section .kn-section');
    await expect(nested.locator('.kn-entry-body')).toHaveText('Buried two levels deep.');
    // And it must NOT also appear as a root-level entry -- #knTree's OWN
    // level, not the nested section's own (renderLevel wraps entries in a
    // .kn-level at every depth, so an unscoped '.kn-level > .kn-entry' would
    // match the nested one too and pass on a false premise).
    await expect(page.locator('#knTree > .kn-level > .kn-entry')).toHaveCount(0);
  });

  test('renaming a section updates it in place without touching its children', async ({ page }) => {
    page.once('dialog', (d) => d.accept('Original name'));
    await page.click('#knAddRootSection');
    await addEntry(page, { via: '.kn-section-actions >> text=+ Entry', body: 'Stays put.' });

    page.once('dialog', (d) => d.accept('Renamed'));
    await page.click('.kn-section-actions >> text=Rename');
    await expect(page.locator('.kn-section-title')).toHaveText('Renamed');
    await expect(page.locator('.kn-entry-body')).toHaveText('Stays put.');
  });

  test('editing an entry changes its stored text, not just what is on screen', async ({ page }) => {
    await addEntry(page, { title: 'First', body: 'Before the edit.' });
    await page.click('.kn-entry-actions >> text=Edit');
    await expect(page.locator('#knEntryDialogTitle')).toHaveText('Edit entry');
    await expect(page.locator('#knEntryBody')).toHaveValue('Before the edit.');
    await page.fill('#knEntryBody', 'After the edit.');
    await page.click('#knEntrySubmit');

    await expect(page.locator('.kn-entry-body')).toHaveText('After the edit.');
    // Editing must not have created a SECOND entry.
    await expect(page.locator('.kn-entry')).toHaveCount(1);
  });

  test('deleting an entry removes only that entry', async ({ page }) => {
    await addEntry(page, { title: 'Keep', body: 'Stays.' });
    await addEntry(page, { title: 'Remove', body: 'Goes.' });
    await expect(page.locator('.kn-entry')).toHaveCount(2);

    page.once('dialog', (d) => d.accept());
    await page.locator('.kn-entry', { hasText: 'Remove' }).locator('text=Delete').click();
    await expect(page.locator('.kn-entry')).toHaveCount(1);
    await expect(page.locator('.kn-entry-title')).toHaveText('Keep');
  });

  test('deleting a section warns how much it takes with it, and removes all of it', async ({ page }) => {
    page.once('dialog', (d) => d.accept('Perek HaZoreah'));
    await page.click('#knAddRootSection');
    await addEntry(page, { via: '.kn-section-actions >> text=+ Entry', body: 'Inside the section.' });
    page.once('dialog', (d) => d.accept('Shechita'));
    await page.click('.kn-section >> text=+ Subsection');

    let confirmMessage = '';
    page.once('dialog', (d) => { confirmMessage = d.message(); d.accept(); });
    await page.click('.kn-section-actions >> text=Delete');
    expect(confirmMessage).toContain('1 nested section');
    expect(confirmMessage).toContain('1 entry');

    await expect(page.locator('.kn-section')).toHaveCount(0);
    await expect(page.locator('.kn-entry')).toHaveCount(0);
  });

  test('reordering two root entries persists to a fresh fetch, not just the DOM', async ({ page }) => {
    await addEntry(page, { title: 'First', body: 'A.' });
    await addEntry(page, { title: 'Second', body: 'B.' });
    await expect(page.locator('.kn-entry-title')).toHaveText(['First', 'Second']);

    // Move "Second" up past "First".
    await page.locator('.kn-entry', { hasText: 'Second' }).locator('[aria-label="Move up"]').click();
    await expect(page.locator('.kn-entry-title')).toHaveText(['Second', 'First']);

    // Leave the builder and come back -- a real page.reload() would re-run
    // this harness's addInitScript and reseed the whole fixture database,
    // discarding everything the test just created, so it proves nothing
    // here. Going back to the library and reopening the same kuntras still
    // forces two fresh round trips (fetchMyKuntrasim, then
    // fetchKuntrasTree), which is what actually proves reorderEntries wrote
    // position for every sibling rather than the order only ever having
    // lived in the DOM this whole time.
    await page.click('#knBackButton');
    await page.click('.cc-card-title a');
    await expect(page.locator('.kn-entry-title')).toHaveText(['Second', 'First']);
  });

  test('the first entry cannot move up, and the last cannot move down', async ({ page }) => {
    await addEntry(page, { title: 'Only one', body: 'Alone.' });
    await expect(page.locator('[aria-label="Move up"]')).toBeDisabled();
    await expect(page.locator('[aria-label="Move down"]')).toBeDisabled();
  });

  test('the textarea itself refuses to hold more than 2000 characters', async ({ page }) => {
    // maxlength on #knEntryBody is the actual enforcement -- unlike the
    // import dialog's paste box (byte-length, so it CANNOT use maxlength;
    // see MAX_DOCUMENT_BYTES), a kuntras entry mirrors line_notes.body's
    // plain character cap, which maxlength expresses directly. That means
    // .fill() with 2001 characters is clamped by the browser before the
    // counter ever sees a number over 2000 -- there is no "over" state to
    // reach through typing, so this proves the cap holds rather than
    // asserting a state that cannot occur.
    await page.click('#knAddRootEntry');
    await page.fill('#knEntryBody', 'x'.repeat(2001));
    await expect(page.locator('#knEntryBody')).toHaveValue('x'.repeat(2000));
    await expect(page.locator('#knEntrySize')).toHaveText('2000 of 2000 characters');
    await expect(page.locator('#knEntrySize')).not.toHaveClass(/over/);
  });
});

test.describe('Kuntras Builder — separate kuntrasim stay separate', () => {
  test('an entry added in one kuntras does not appear in another', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author) });
    await openLibrary(page);
    await createKuntras(page, 'First kuntras');
    await addEntry(page, { title: 'Only here', body: 'Belongs to the first.' });
    await page.click('#knBackButton');

    await createKuntras(page, 'Second kuntras');
    await expect(page.locator('.kn-entry')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('Only here');
  });
});
