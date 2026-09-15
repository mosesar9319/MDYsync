import { test, expect } from '@playwright/test';
import { preparePage, failOnPageError, readTestCalls } from '../support/harness.mjs';
import { buildDatabase, sessionFor, USERS, DOCUMENT_IDS, NOTE_IDS } from '../fixtures/dataset.mjs';

// Kuntras Builder, slices 2 and 3: quoting the reader's OWN line_notes note
// or note_documents excerpt (slice 2, kind/source_note_id/
// source_document_id), or any PUBLIC Cloud Chaburah discussion regardless of
// who wrote it (slice 3, kind='chaburah'/source_chaburah_note_id), into an
// entry.
//
// What this suite is NOT for: proving another account's note or document
// cannot be cited, that a private or hidden discussion cannot be quoted via
// the chaburah path, or that a cascade-cleared citation normalizes an entry
// back to freeform. All three are supabase/tests/rls_authorization.sql, run
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
    // Filling the entry body while #knQuoteDialog is still stacked on top of
    // #knEntryDialog is unreliable at mobile widths -- the same pre-existing
    // stacked-dialog quirk note-citation.spec.mjs's own budget test works
    // around by closing first. Escape, fill, then reopen the picker.
    await page.keyboard.press('Escape');
    await expect(page.locator('#knQuoteDialog')).toBeHidden();
    await page.fill('#knEntryBody', 'y'.repeat(1990));

    await openQuotePicker(page);
    await page.click('#knQuoteTabDocuments');
    await page.click(`#knQuoteDocList .note-cite-doc >> text=${DOC_TITLE}`);
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

// Slice 3: quoting a public Cloud Chaburah discussion, written by anyone --
// unlike the notes/documents tabs above, this one is NOT scoped to the
// signed-in reader's own content. A fresh public note owned by a DIFFERENT
// account is the whole point of the fixture below: it proves the tab lists
// something the reader did not write, which none of the existing seeded
// notes (all owned by USERS.author, the account these specs sign in as)
// could prove on their own.

const CHABURAH_PUBLIC_ID = 'f6000000-0000-4000-8000-000000000001';
const CHABURAH_HIDDEN_ID = 'f6000000-0000-4000-8000-000000000002';

function databaseWithChaburahFixtures() {
  const db = buildDatabase();
  const base = {
    daf_ref_key: 'Chullin-89a', segment_ref: 'Chullin 89a.1',
    author_id: USERS.ordinary.id, author_display_name: USERS.ordinary.display_name,
    hidden: false, is_private: false, category: null, created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(), start_word: null, end_word: null, selected_text: null,
    word_ranges: null, mentioned_user_ids: [], video_timestamp_seconds: null, is_demo: false,
    title: null, status: 'open', highlighted_comment_id: null, edited_at: null, deleted_at: null,
    last_activity_at: new Date().toISOString(), source_document_id: null,
  };
  db.line_notes.push(
    { ...base, id: CHABURAH_PUBLIC_ID, body: 'CHABURAH-CANARY a public discussion worth quoting.' },
    { ...base, id: CHABURAH_HIDDEN_ID, body: 'A note a moderator has since hidden.', hidden: true },
  );
  return db;
}

test.describe('Kuntras Builder — quoting a public Cloud Chaburah discussion', () => {
  test.beforeEach(async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author), db: databaseWithChaburahFixtures() });
    await openLibrary(page);
    await createKuntras(page, 'Chullin sichas');
    await openAddEntry(page);
    await openQuotePicker(page);
    await page.click('#knQuoteTabChaburah');
  });

  test('lists a discussion written by someone else, but not a private or hidden one', async ({ page }) => {
    await expect(page.locator('#knQuoteChaburahList')).toContainText('CHABURAH-CANARY');
    await expect(page.locator('#knQuoteChaburahList')).not.toContainText('PRIVATE-CANARY');
    await expect(page.locator('#knQuoteChaburahList')).not.toContainText('moderator has since hidden');
  });

  test('search narrows the list', async ({ page }) => {
    const before = await page.locator('#knQuoteChaburahList .note-cite-doc').count();
    expect(before).toBeGreaterThan(1);

    await page.fill('#knQuoteChaburahSearch', 'CHABURAH-CANARY');
    await expect(page.locator('#knQuoteChaburahList .note-cite-doc')).toHaveCount(1);
  });

  test('choosing a discussion copies its body in and records the source', async ({ page }) => {
    await page.click(`#knQuoteChaburahList .note-cite-doc >> text=CHABURAH-CANARY`);

    await expect(page.locator('#knQuoteDialog')).toBeHidden();
    await expect(page.locator('#knEntryBody')).toHaveValue('CHABURAH-CANARY a public discussion worth quoting.');
    await expect(page.locator('#knCiteCurrent')).toBeVisible();
    await expect(page.locator('#knCiteCurrentLabel')).toContainText(USERS.ordinary.display_name);

    await page.click('#knEntrySubmit');
    const row = await lastCall(page, 'kuntras_entries', 'insert');
    expect(row.kind).toBe('chaburah');
    expect(row.source_chaburah_note_id).toBe(CHABURAH_PUBLIC_ID);
    expect(row.source_note_id).toBeNull();
    expect(row.source_document_id).toBeNull();
  });

  test('reopening a previously-cited entry restores the chip', async ({ page }) => {
    await page.click(`#knQuoteChaburahList .note-cite-doc >> text=CHABURAH-CANARY`);
    await page.click('#knEntrySubmit');
    await expect(page.locator('#knEntryDialog')).toBeHidden();

    await page.click('.kn-entry-actions >> text=Edit');
    await expect(page.locator('#knEntryDialog')).toBeVisible();
    await expect(page.locator('#knCiteCurrent')).toBeVisible();
    await expect(page.locator('#knCiteCurrentLabel')).toContainText(USERS.ordinary.display_name);
  });
});
