import { test, expect } from '@playwright/test';
import { preparePage, failOnPageError, readTestCalls } from '../support/harness.mjs';
import { buildDatabase, sessionFor, USERS } from '../fixtures/dataset.mjs';

// Documents (My Notes' imported-file library), sharing slice: private, an
// unlisted link, or fully public in a browsable listing -- the same
// private/unlisted/public model Kuntras Builder already established (see
// kuntras-sharing.spec.mjs, which this file mirrors closely), now extended
// to note_documents by 20260916160000_document_sharing.sql.
//
// What this suite is NOT for: proving a private document is actually
// unreadable by anon or a stranger. This stub has no RLS at all -- see
// note-citation.spec.mjs's own header on the same point, and
// supabase/tests/rls_authorization.sql's "Publishing a document" section,
// which proves that against a real database with the real policies. What
// this suite proves instead is that the CLIENT renders correctly once given
// a row: read-only chrome for a shared link, full editing for the owner, the
// right rows in the right listings, and a working download for a document
// that kept its original file.

const DOC_ID = 'f8000000-0000-4000-8000-000000000001';
const TITLE = 'My shared notebook';
const TEXT = 'A passage worth sharing with anyone who has the link.';

function databaseWithPublished(visibility, overrides = {}) {
  const db = buildDatabase();
  db.note_documents.push({
    id: DOC_ID,
    owner_id: USERS.author.id,
    title: TITLE,
    source_kind: 'docx',
    original_filename: 'notebook.docx',
    full_text: TEXT,
    preview: TEXT,
    visibility,
    file_path: `${USERS.author.id}/${DOC_ID}.docx`,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    deleted_at: null,
    ...overrides,
  });
  return db;
}

test.describe('Documents — opening a shared link', () => {
  test('an anonymous visitor can read an unlisted document, read-only', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: null, db: databaseWithPublished('unlisted') });
    await page.goto(`/notes/?doc=${DOC_ID}`);
    await expect(page.locator('#mnDocDialog')).toBeVisible();

    await expect(page.locator('#mnDocTitle')).toHaveText(TITLE);
    await expect(page.locator('#mnDocText')).toContainText(TEXT);

    await expect(page.locator('#mnDocShare')).toBeHidden();
    await expect(page.locator('#mnDocRename')).toBeHidden();
    await expect(page.locator('#mnDocDelete')).toBeHidden();
    // The download button is NOT part of the editing chrome -- a reader may
    // download a file they cannot edit.
    await expect(page.locator('#mnDocDownload')).toBeVisible();
  });

  test('a signed-in stranger reads the same unlisted link just as well -- it is not owner-scoped', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.ordinary), db: databaseWithPublished('unlisted') });
    await page.goto(`/notes/?doc=${DOC_ID}`);
    await expect(page.locator('#mnDocTitle')).toHaveText(TITLE);
    await expect(page.locator('#mnDocShare')).toBeHidden();
  });

  test('a fully public document is reachable by its link too, not only via the listing', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: null, db: databaseWithPublished('public') });
    await page.goto(`/notes/?doc=${DOC_ID}`);
    await expect(page.locator('#mnDocTitle')).toHaveText(TITLE);
  });

  test('an id that does not exist says so, rather than opening an empty dialog', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: null, db: buildDatabase() });
    await page.goto('/notes/?doc=00000000-0000-4000-8000-000000000000');
    await expect(page.locator('#mnDocDialog')).toBeHidden();
    await expect(page.locator('#mnStatus')).toContainText('not available');
  });

  test('the reader\'s own OWN document opened via its own link is read-only too', async ({ page }) => {
    // Deliberate: openSharedDocument never checks who owns the row, so even
    // the author sees read-only chrome through a ?doc= link -- editing only
    // happens through their own library (see openDocument).
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author), db: databaseWithPublished('public') });
    await page.goto(`/notes/?doc=${DOC_ID}`);
    await expect(page.locator('#mnDocTitle')).toHaveText(TITLE);
    await expect(page.locator('#mnDocShare')).toBeHidden();
    await expect(page.locator('#mnDocRename')).toBeHidden();
  });
});

test.describe('Documents — public browse listing', () => {
  test('lists a public document for a signed-out visitor', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: null, db: databaseWithPublished('public') });
    await page.goto('/notes/');
    await page.click('#mn-tab-documents');
    await expect(page.locator('#mnPublicDocsFeed')).toContainText(TITLE);
  });

  test('never lists an unlisted document -- that is the entire distinction between the two', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: null, db: databaseWithPublished('unlisted') });
    await page.goto('/notes/');
    await page.click('#mn-tab-documents');
    await expect(page.locator('#mnPublicDocsFeed')).toBeVisible();
    await expect(page.locator('#mnPublicDocsFeed')).not.toContainText(TITLE);
  });

  test('never lists a private document', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: null, db: databaseWithPublished('private') });
    await page.goto('/notes/');
    await page.click('#mn-tab-documents');
    await expect(page.locator('#mnPublicDocsFeed')).not.toContainText(TITLE);
  });

  test('search narrows the public listing by title', async ({ page }) => {
    failOnPageError(page);
    const db = databaseWithPublished('public');
    db.note_documents.push({
      id: 'f8000000-0000-4000-8000-000000000099',
      owner_id: USERS.ordinary.id,
      title: 'A completely different notebook',
      source_kind: 'paste',
      original_filename: null,
      full_text: 'Nothing to do with the other one.',
      preview: 'Nothing to do with the other one.',
      visibility: 'public',
      file_path: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      deleted_at: null,
    });
    await preparePage(page, { session: null, db });
    await page.goto('/notes/');
    await page.click('#mn-tab-documents');
    await expect(page.locator('#mnPublicDocsFeed .cc-card')).toHaveCount(2);

    await page.fill('#mnPublicDocsSearch', 'shared notebook');
    await expect(page.locator('#mnPublicDocsFeed .cc-card')).toHaveCount(1);
    await expect(page.locator('#mnPublicDocsFeed')).toContainText(TITLE);
  });

  test('a card links straight to the read-only view', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: null, db: databaseWithPublished('public') });
    await page.goto('/notes/');
    await page.click('#mn-tab-documents');
    await expect(page.locator('#mnPublicDocsFeed')).toContainText(TITLE);
    const href = await page.locator('#mnPublicDocsFeed .cc-card a').getAttribute('href');
    expect(href).toBe(`?doc=${DOC_ID}`);
  });

  test('the section is hidden on the Notes tab', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author), db: databaseWithPublished('public') });
    await page.goto('/notes/');
    await expect(page.locator('#mnPublicDocsSection')).toBeHidden();
  });
});

test.describe("Documents — the owner's own Sharing control", () => {
  test('opening your own document the normal way always shows full editing, whatever its visibility', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author), db: databaseWithPublished('public') });
    await page.goto('/notes/?tab=documents');
    // Scoped to #mnFeed -- see "the library card itself shows the current
    // visibility" below on why a document that is both mine and public
    // renders TWICE on this page.
    await page.click(`#mnFeed .cc-card[data-id="${DOC_ID}"] .cc-card-title a`);
    await expect(page.locator('#mnDocDialog')).toBeVisible();
    await expect(page.locator('#mnDocShare')).toBeVisible();
    await expect(page.locator('#mnDocRename')).toBeVisible();
    await expect(page.locator('#mnDocDelete')).toBeVisible();
  });

  test('the library card itself shows the current visibility', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author), db: databaseWithPublished('public') });
    await page.goto('/notes/?tab=documents');
    // Scoped to #mnFeed ("my documents"), not just any .cc-card with this id
    // -- a document that is both mine and public renders TWICE on this very
    // page (once here, once again down in #mnPublicDocsFeed, same as any
    // public content is still shown to its own author elsewhere on the
    // site), so the bare selector is ambiguous.
    await expect(page.locator(`#mnFeed .cc-card[data-id="${DOC_ID}"]`)).toContainText('Public');
  });

  test('the Sharing dialog reflects the current visibility and shows a working link', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author), db: databaseWithPublished('unlisted') });
    await page.goto('/notes/?tab=documents');
    await page.click(`.cc-card[data-id="${DOC_ID}"] .cc-card-title a`);
    await page.click('#mnDocShare');
    await expect(page.locator('#mnDocShareDialog')).toBeVisible();

    await expect(page.locator('input[name="mnDocShareVisibility"][value="unlisted"]')).toBeChecked();
    await expect(page.locator('#mnDocShareLinkRow')).toBeVisible();
    await expect(page.locator('#mnDocShareLinkInput')).toHaveValue(new RegExp(`\\?doc=${DOC_ID}$`));
  });

  test('a freshly imported document starts private, with the link row hidden', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author) });
    await page.goto('/notes/?tab=documents');
    await page.click('#mnImportButton');
    await page.fill('#mnImportTitle', 'Brand new document');
    await page.fill('#mnImportText', 'Fresh text.');
    await page.click('#mnImportSubmit');
    await expect(page.locator('#mnImportDialog')).toBeHidden();

    const card = page.locator('.cc-card', { hasText: 'Brand new document' });
    await card.locator('.cc-card-title a').click();
    await page.click('#mnDocShare');
    await expect(page.locator('input[name="mnDocShareVisibility"][value="private"]')).toBeChecked();
    await expect(page.locator('#mnDocShareLinkRow')).toBeHidden();
  });

  test('switching to unlisted reveals the link, and it persists to a fresh fetch', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author), db: databaseWithPublished('private') });
    await page.goto('/notes/?tab=documents');
    await page.click(`.cc-card[data-id="${DOC_ID}"] .cc-card-title a`);
    await page.click('#mnDocShare');
    await page.check('input[name="mnDocShareVisibility"][value="unlisted"]');
    await expect(page.locator('#mnDocShareLinkRow')).toBeVisible();
    await expect(page.locator('#mnDocShareLinkInput')).toHaveValue(new RegExp(`\\?doc=${DOC_ID}$`));

    // Verified through a fresh fetch, not DOM trust.
    await page.click('#mnDocShareClose');
    await page.click('#mnDocClose');
    await expect(page.locator(`.cc-card[data-id="${DOC_ID}"]`)).toContainText('Unlisted');
  });

  test('copying the link puts the exact ?doc= URL on the clipboard', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author), db: databaseWithPublished('public') });
    await page.goto('/notes/?tab=documents');
    await page.click(`#mnFeed .cc-card[data-id="${DOC_ID}"] .cc-card-title a`);
    await page.click('#mnDocShare');
    await page.click('#mnDocShareCopyButton');
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain(`?doc=${DOC_ID}`);
    await expect(page.locator('#mnDocShareCopyStatus')).toContainText('Copied');
  });
});

test.describe('Documents — downloading the kept original', () => {
  test('the Download button is hidden when no file was ever kept', async ({ page }) => {
    failOnPageError(page);
    // DOCUMENT_IDS.chullin in the shared fixture is a pasted document --
    // nothing was ever uploaded for it.
    await preparePage(page, { session: sessionFor(USERS.author) });
    await page.goto('/notes/?tab=documents');
    await page.locator('.cc-card[data-kind="document"] .cc-card-title a').first().click();
    await expect(page.locator('#mnDocDialog')).toBeVisible();
    await expect(page.locator('#mnDocDownload')).toBeHidden();
  });

  test('clicking Download fetches a signed URL for the kept file', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author), db: databaseWithPublished('private') });
    // The stub's fake signed URL points at a domain that does not resolve;
    // stubbing the response lets the popup actually load it instead of
    // ending up on chrome's own network-error page, whose URL this test
    // must not assert against instead of the real one.
    await page.context().route('https://stub.local/**', (route) => route.fulfill({ status: 200, contentType: 'text/plain', body: 'ok' }));
    await page.goto('/notes/?tab=documents');
    await page.click(`.cc-card[data-id="${DOC_ID}"] .cc-card-title a`);
    await expect(page.locator('#mnDocDownload')).toBeVisible();

    const [popup] = await Promise.all([
      page.waitForEvent('popup'),
      page.click('#mnDocDownload'),
    ]);
    await popup.waitForLoadState();
    expect(popup.url()).toContain('documents');
    expect(popup.url()).toContain(DOC_ID);

    const calls = await readTestCalls(page);
    const signed = calls.filter((c) => c.storage && c.storage.action === 'createSignedUrl');
    expect(signed).toHaveLength(1);
    expect(signed[0].storage.bucket).toBe('documents');
  });
});
