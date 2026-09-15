import { test, expect } from '@playwright/test';
import { preparePage, failOnPageError, readTestCalls } from '../support/harness.mjs';
import { buildDatabase, sessionFor, USERS, DOCUMENT_IDS, NOTE_IDS } from '../fixtures/dataset.mjs';

// Kuntras Builder, slice 2: quoting the reader's OWN line_notes note or
// note_documents excerpt into an entry, via 20260915210000's kind/
// source_note_id/source_document_id columns.
//
// What this suite is NOT for: proving another account's note or document
// cannot be cited, or that a cascade-cleared citation normalizes an entry
// back to freeform. Both are supabase/tests/rls_authorization.sql, run
// against a real Postgres with the real trigger -- this stub has no
// triggers, so it can only prove the CLIENT asks for and sends the right
// things, never that the server would refuse anything.

const DOC_TITLE = 'Chullin notes 5785';

async function openLibrary(page) {
  await page.goto('/kuntras/');
  await expect(page.locator('#knFeed')).toBeVisible();
}

async function createKuntras(page, title) {
  page.once('dialog', (d) => d.accept(title));
  await page.click('#knNewButton');
  await expect(page.locator('#knBuilder')).toBeVisible();
}

async function openAddEntry(page) {
  await page.click('#knAddRootEntry');
  await expect(page.locator('#knEntryDialog')).toBeVisible();
}

async function openQuotePicker(page) {
  await page.click('#knCiteButton');
  await expect(page.locator('#knQuoteDialog')).toBeVisible();
}

// Selects a character range inside the document pane -- mirrors
// note-citation.spec.mjs's own selectInPassage exactly, since it drives the
// same "Use selection" contract (a real Selection API range, not a
// synthetic drag).
async function selectInPassage(page, start, end) {
  await page.evaluate(({ start, end }) => {
    const pre = document.getElementById('knQuoteDocText');
    const range = document.createRange();
    range.setStart(pre.firstChild, start);
    range.setEnd(pre.firstChild, end);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }, { start, end });
}

async function lastCall(page, table, operation) {
  const calls = await readTestCalls(page);
  const matches = calls.filter((c) => c.table === table && c.operation === operation);
  expect(matches.length).toBeGreaterThan(0);
  return matches[matches.length - 1].rows[0];
}

test.describe('Kuntras Builder — quoting a note', () => {
  test.beforeEach(async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author) });
    await openLibrary(page);
    await createKuntras(page, 'Chullin sichas');
    await openAddEntry(page);
  });

  test('the picker offers only the reader’s own notes', async ({ page }) => {
    await openQuotePicker(page);
    await expect(page.locator('#knQuoteTabNotes')).toHaveClass(/active/);
    await expect(page.locator('.note-cite-doc-title').first()).toContainText('your note on');
    // The fixture also seeds a note privately owned by a different account
    // (NOTE_IDS.privateNote); it must not appear here.
    await expect(page.locator('#knQuoteNotesList')).not.toContainText('PRIVATE-CANARY');
  });

  test('search narrows the list', async ({ page }) => {
    await openQuotePicker(page);
    const before = await page.locator('#knQuoteNotesList .note-cite-doc').count();
    expect(before).toBeGreaterThan(1);

    await page.fill('#knQuoteNotesSearch', 'Shechita');
    await expect(page.locator('#knQuoteNotesList .note-cite-doc')).toHaveCount(1);
    await expect(page.locator('#knQuoteNotesList')).toContainText('CITED-EXCERPT');
  });

  test('choosing a note copies its body into the entry and shows the source', async ({ page }) => {
    await openQuotePicker(page);
    await page.click(`#knQuoteNotesList .note-cite-doc >> text=CITED-EXCERPT`);

    await expect(page.locator('#knQuoteDialog')).toBeHidden();
    await expect(page.locator('#knEntryBody')).toHaveValue('CITED-EXCERPT Shechita requires five things.');
    await expect(page.locator('#knCiteCurrent')).toBeVisible();
    await expect(page.locator('#knCiteCurrentLabel')).toContainText('your note on Chullin 89a');

    await page.click('#knEntrySubmit');
    await expect(page.locator('#knEntryDialog')).toBeHidden();
    const row = await lastCall(page, 'kuntras_entries', 'insert');
    expect(row.kind).toBe('note');
    expect(row.source_note_id).toBe(NOTE_IDS.citesDocument);
    expect(row.source_document_id).toBeNull();
  });

  test('the × drops the source without touching the copied text', async ({ page }) => {
    await openQuotePicker(page);
    await page.click(`#knQuoteNotesList .note-cite-doc >> text=CITED-EXCERPT`);
    await expect(page.locator('#knCiteCurrent')).toBeVisible();

    await page.click('#knCiteClear');
    await expect(page.locator('#knCiteCurrent')).toBeHidden();
    await expect(page.locator('#knEntryBody')).toHaveValue('CITED-EXCERPT Shechita requires five things.');

    await page.click('#knEntrySubmit');
    const row = await lastCall(page, 'kuntras_entries', 'insert');
    expect(row.kind).toBe('freeform');
    expect(row.source_note_id).toBeNull();
  });
});

test.describe('Kuntras Builder — quoting a document', () => {
  test.beforeEach(async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author) });
    await openLibrary(page);
    await createKuntras(page, 'Chullin sichas');
    await openAddEntry(page);
    await openQuotePicker(page);
    await page.click('#knQuoteTabDocuments');
  });

  test('the documents tab lists only the reader’s own documents', async ({ page }) => {
    const ids = await page.locator('#knQuoteDocList .note-cite-doc').evaluateAll((els) => els.map((e) => e.textContent));
    expect(ids.join(' ')).toContain(DOC_TITLE);
    expect(ids.join(' ')).toContain('Berachos notebook');
    await expect(page.locator('#knQuoteDocList')).not.toContainText('Someone else');
  });

  test('opening a document shows its text, and Back returns to the list', async ({ page }) => {
    await page.click(`#knQuoteDocList .note-cite-doc >> text=${DOC_TITLE}`);
    await expect(page.locator('#knQuoteDocTitle')).toHaveText(DOC_TITLE);
    await expect(page.locator('#knQuoteDocText')).toContainText('sugya of derasa');
    await expect(page.locator('#knQuoteDocBrowse')).toBeHidden();

    await page.click('#knQuoteDocBack');
    await expect(page.locator('#knQuoteDocBrowse')).toBeVisible();
    await expect(page.locator('#knQuoteDocPassage')).toBeHidden();
  });

  test('Use selection is disabled until something is actually selected, then inserts the passage', async ({ page }) => {
    await page.click(`#knQuoteDocList .note-cite-doc >> text=${DOC_TITLE}`);
    await expect(page.locator('#knQuoteDocUse')).toBeDisabled();

    await selectInPassage(page, 0, 30);
    await expect(page.locator('#knQuoteDocUse')).toBeEnabled();
    await page.click('#knQuoteDocUse');

    await expect(page.locator('#knQuoteDialog')).toBeHidden();
    await expect(page.locator('#knEntryBody')).toHaveValue('Shechita requires five things.');
    await expect(page.locator('#knCiteCurrentLabel')).toHaveText(DOC_TITLE);

    await page.click('#knEntrySubmit');
    const row = await lastCall(page, 'kuntras_entries', 'insert');
    expect(row.kind).toBe('document');
    expect(row.source_document_id).toBe(DOCUMENT_IDS.chullin);
    expect(row.source_note_id).toBeNull();
  });

  test('an over-long selection is refused with the shortfall stated', async ({ page }) => {
    await page.click(`#knQuoteDocList .note-cite-doc >> text=${DOC_TITLE}`);
    await page.fill('#knEntryBody', 'y'.repeat(1990));
    await selectInPassage(page, 0, 30);
    await expect(page.locator('#knQuoteDocUse')).toBeDisabled();
    await expect(page.locator('#knQuoteDocHint')).toContainText('will fit');
  });
});

test.describe('Kuntras Builder — editing a previously-cited entry', () => {
  test('reopening it restores the citation chip', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author) });
    await openLibrary(page);
    await createKuntras(page, 'Chullin sichas');
    await openAddEntry(page);
    await openQuotePicker(page);
    await page.click('#knQuoteTabDocuments');
    await page.click(`#knQuoteDocList .note-cite-doc >> text=${DOC_TITLE}`);
    await selectInPassage(page, 0, 30);
    await page.click('#knQuoteDocUse');
    await page.click('#knEntrySubmit');
    await expect(page.locator('#knEntryDialog')).toBeHidden();

    await page.click('.kn-entry-actions >> text=Edit');
    await expect(page.locator('#knEntryDialog')).toBeVisible();
    await expect(page.locator('#knCiteCurrent')).toBeVisible();
    await expect(page.locator('#knCiteCurrentLabel')).toHaveText(DOC_TITLE);
  });
});
