import { test, expect } from '@playwright/test';
import { preparePage, failOnPageError } from '../support/harness.mjs';
import { buildDatabase, sessionFor, USERS } from '../fixtures/dataset.mjs';

// Importing typed notes into My Notes (/notes/?tab=documents).
//
// An imported document is NOT a note: line_notes.daf_ref_key and segment_ref
// are both NOT NULL, so a note is by construction a note ON a passage, while
// an import has no passage until it is attached to one. Hence its own table,
// its own tab, and these specs.
//
// Plain text only for now (paste/.txt/.md) -- that tier needs no parser, no
// upload endpoint and no file storage, so none of that is exercised here
// because none of it exists yet.

const CARD = '.cc-card';
const DOC_ID = 'f0000000-0000-4000-8000-000000000001';
const OTHER_ACCOUNT_DOC = 'f0000000-0000-4000-8000-000000000003';

async function openDocumentsTab(page) {
  await page.click('#mn-tab-documents');
  await expect(page.locator(CARD).first()).toBeVisible();
}

test.describe('My Notes — Documents tab', () => {
  test('lists the reader’s own documents and nobody else’s', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author) });
    await page.goto('/notes/');
    await openDocumentsTab(page);

    const ids = await page.locator(CARD).evaluateAll((cards) => cards.map((c) => c.dataset.id));
    expect(ids).toContain(DOC_ID);
    expect(ids).not.toContain(OTHER_ACCOUNT_DOC);
  });

  test('shows the preview without fetching the document body', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author) });
    await page.goto('/notes/');
    await openDocumentsTab(page);

    const card = page.locator(`${CARD}[data-id="${DOC_ID}"]`);
    await expect(card.locator('.cc-card-body')).toContainText('Shechita requires five things');
    await expect(card.locator('.cc-chip-private')).toHaveText('Private');
  });

  // The note filters describe a daf, a category and whether a note is shared.
  // None of that exists for a document, so showing them would be dead UI.
  //
  // Which control carries those filters depends on the viewport: the left rail
  // on desktop, the Filters button on mobile (the rail is CSS-hidden below
  // 900px). Asserting on the rail alone would fail on mobile for a reason that
  // is not a defect, so this checks whichever one the viewport exposes.
  test('hides the note-only filters on this tab', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author) });
    await page.goto('/notes/');
    await expect(page.locator(CARD).first()).toBeVisible();

    const rail = page.locator('#mnFilterRail');
    const filters = (await rail.isVisible()) ? rail : page.locator('#mnMobileFilterBar');
    await expect(filters).toBeVisible();

    await openDocumentsTab(page);
    await expect(filters).toBeHidden();
  });

  test('the tab survives a reload', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author) });
    await page.goto('/notes/');
    await openDocumentsTab(page);
    await expect(page).toHaveURL(/tab=documents/);

    await page.reload();
    await expect(page.locator('#mn-tab-documents')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator(`${CARD}[data-id="${DOC_ID}"]`)).toBeVisible();
  });
});

test.describe('My Notes — importing', () => {
  test('pasting text creates a document and lands on the Documents tab', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author) });
    await page.goto('/notes/');
    await expect(page.locator(CARD).first()).toBeVisible();

    await page.click('#mnImportButton');
    await page.fill('#mnImportTitle', 'Pesachim chaburah');
    await page.fill('#mnImportText', 'A long line of my own notes about bedikas chametz.');
    await page.click('#mnImportSubmit');

    await expect(page.locator('#mn-tab-documents')).toHaveAttribute('aria-selected', 'true');
    const newCard = page.locator(CARD).filter({ hasText: 'Pesachim chaburah' });
    await expect(newCard).toBeVisible();
    // The preview is a generated column, so it must be present on a freshly
    // imported document too -- not only on a seeded fixture row.
    await expect(newCard.locator('.cc-card-body')).toContainText('bedikas chametz');
  });

  test('refuses an over-size import rather than truncating it', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author) });
    await page.goto('/notes/');
    await page.click('#mnImportButton');

    await page.fill('#mnImportTitle', 'Far too much');
    // Comfortably past the 512000-byte ceiling.
    await page.locator('#mnImportText').evaluate((el) => {
      el.value = 'x'.repeat(520000);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await expect(page.locator('#mnImportSize')).toHaveClass(/over/);
    await expect(page.locator('#mnImportSubmit')).toBeDisabled();
  });

  // Bytes, not characters: a Hebrew character costs two bytes in UTF-8 and the
  // database constraint counts bytes, so a character-based check here would
  // wave through an import the server then rejects.
  test('measures the limit in bytes, so Hebrew counts double', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author) });
    await page.goto('/notes/');
    await page.click('#mnImportButton');

    // 300,000 Hebrew characters: well under any character-based limit, and
    // 600,000 bytes, so over the real one.
    await page.locator('#mnImportText').evaluate((el) => {
      el.value = 'א'.repeat(300000);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await expect(page.locator('#mnImportSubmit')).toBeDisabled();
    await expect(page.locator('#mnImportSize')).toHaveClass(/over/);
  });

  test('an import with no title is refused', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author) });
    await page.goto('/notes/');
    await page.click('#mnImportButton');

    // novalidate is not set, so the browser's own required-field check fires
    // first; filling whitespace gets past that to the app's own check.
    await page.fill('#mnImportTitle', '   ');
    await page.fill('#mnImportText', 'Some text.');
    await page.click('#mnImportSubmit');

    await expect(page.locator('#mnImportError')).toContainText('title');
  });
});

test.describe('My Notes — reading a document', () => {
  test('opens the full text, which the list never fetched', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author) });
    await page.goto('/notes/');
    await openDocumentsTab(page);

    await page.locator(`${CARD}[data-id="${DOC_ID}"] .cc-card-title a`).click();
    await expect(page.locator('#mnDocDialog')).toBeVisible();
    await expect(page.locator('#mnDocTitle')).toHaveText('Chullin notes 5785');
    await expect(page.locator('#mnDocText')).toContainText('sugya of derasa');
  });

  // An imported document is arbitrary text the reader supplied. It is rendered
  // with textContent into a <pre>, so markup in it stays text.
  test('renders document text as text, never as markup', async ({ page }) => {
    failOnPageError(page);
    const db = buildDatabase();
    db.note_documents.push({
      id: 'f0000000-0000-4000-8000-0000000000ff',
      owner_id: USERS.author.id,
      title: 'Has markup in it',
      source_kind: 'paste',
      original_filename: null,
      full_text: 'before <img src=x onerror="window.__xss=1"> after',
      preview: 'before <img src=x onerror="window.__xss=1"> after',
      created_at: '2026-09-02T11:00:00.000Z',
      updated_at: '2026-09-02T11:00:00.000Z',
      deleted_at: null,
    });

    await preparePage(page, { db, session: sessionFor(USERS.author) });
    await page.goto('/notes/?tab=documents');
    await page.locator(`${CARD}[data-id="f0000000-0000-4000-8000-0000000000ff"] .cc-card-title a`).click();

    await expect(page.locator('#mnDocText')).toContainText('onerror');
    expect(await page.locator('#mnDocText img').count()).toBe(0);
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  });

  test('deleting a document removes it from the list', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author) });
    await page.goto('/notes/?tab=documents');
    await expect(page.locator(`${CARD}[data-id="${DOC_ID}"]`)).toBeVisible();

    page.on('dialog', (dialog) => dialog.accept());
    await page.locator(`${CARD}[data-id="${DOC_ID}"] .cc-card-title a`).click();
    await page.click('#mnDocDelete');

    await expect(page.locator(`${CARD}[data-id="${DOC_ID}"]`)).toHaveCount(0);
  });
});

test.describe('My Notes — searching documents', () => {
  test('search covers the text inside a document', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author) });
    await page.goto('/notes/?tab=documents');
    await expect(page.locator(CARD).first()).toBeVisible();

    // "tefillah" appears only in the Berachos document's body, never in a
    // title -- so matching it proves the search reaches document text.
    await page.fill('#mnSearch', 'tefillah');
    await expect(page.locator(CARD)).toHaveCount(1);
    await expect(page.locator(CARD).first()).toContainText('Berachos notebook');
  });

  test('a search with no matches says so', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author) });
    await page.goto('/notes/?tab=documents');
    await expect(page.locator(CARD).first()).toBeVisible();

    await page.fill('#mnSearch', 'zzzznotarealwordanywhere');
    await expect(page.locator('.cc-empty h3')).toHaveText('No documents match that search');
  });
});

test.describe('My Notes — signed out', () => {
  test('offers no way to import', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/notes/?tab=documents');

    await expect(page.locator('.cc-empty h3')).toHaveText('Sign in to see your notes');
    await expect(page.locator('#mnImportButton')).toBeHidden();
  });
});
