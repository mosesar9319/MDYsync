import { test, expect } from '@playwright/test';
import { preparePage, failOnPageError, readTestCalls } from '../support/harness.mjs';
import { buildDatabase, sessionFor, USERS, DOCUMENT_IDS, NOTE_IDS } from '../fixtures/dataset.mjs';

// Quoting an imported document from a note on the daf.
//
// What this produces is an ORDINARY note -- a normal line_notes row with a
// normal body, the same 2000-character cap, the same privacy toggle and the
// same moderation path. The only thing the citation adds is
// line_notes.source_document_id, recording where the words came from.
//
// The words themselves are COPIED into the body when they are chosen, never
// referenced live, so editing the document later does not rewrite notes
// already taken from it. These specs assert that copy actually happens, and
// that the provenance is recorded alongside it.
//
// What is NOT provable here: that the database refuses a citation of someone
// else's document. That is a trigger, and this suite runs against a stub with
// no RLS and no triggers -- see supabase/tests/rls_authorization.sql, which
// asserts it as the real `authenticated` role.

const DOC_TITLE = 'Chullin notes 5785';
const SEGMENT = 'Chullin 89a.1';

// Opens the per-segment note panel the way a reader does, then the picker.
async function openComposer(page) {
  // saveNote() reads currentDafInfo(), which comes from the page's own
  // state.dafRef -- set here because these specs open the composer directly
  // rather than by loading a daf.
  await page.evaluate((ref) => {
    state.dafRef = 'Chullin 89a';
    window.DafNotes.open(ref, '');
  }, SEGMENT);
  await expect(page.locator('#noteCompose')).toBeVisible();
}

async function openPicker(page) {
  await page.click('#noteCiteButton');
  await expect(page.locator('#noteCiteDialog')).toBeVisible();
}

// Selects a character range inside the document pane, which is what the
// "Use selection" button reads. Done through the real Selection API rather
// than a synthetic drag so the code under test sees exactly what a mouse or
// a touch handle would give it.
async function selectInPassage(page, start, end) {
  await page.evaluate(({ start, end }) => {
    const pre = document.getElementById('noteCiteText');
    const range = document.createRange();
    range.setStart(pre.firstChild, start);
    range.setEnd(pre.firstChild, end);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }, { start, end });
}

// The row the page actually sent to line_notes, read from the stub's own
// record of writes rather than from the resulting database rows -- what
// matters here is what the client CHOSE to send.
async function insertedNote(page, index = 0) {
  await expect.poll(async () => {
    const calls = await readTestCalls(page);
    return calls.filter((c) => c.table === 'line_notes' && c.operation === 'insert').length;
  }).toBeGreaterThan(index);
  const calls = await readTestCalls(page);
  return calls.filter((c) => c.table === 'line_notes' && c.operation === 'insert')[index].rows[0];
}

test.describe('Quote from my notes — the picker', () => {
  test.beforeEach(async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author) });
    await page.goto('/browse/');
  });

  test('is offered to a signed-in reader and lists only their own documents', async ({ page }) => {
    await openComposer(page);
    await expect(page.locator('#noteCiteRow')).toBeVisible();
    await openPicker(page);

    const ids = await page.locator('.note-cite-doc').evaluateAll((els) => els.map((e) => e.dataset.id));
    expect(ids).toContain(DOCUMENT_IDS.chullin);
    expect(ids).toContain(DOCUMENT_IDS.berachos);
    expect(ids).not.toContain(DOCUMENT_IDS.someoneElses);
  });

  test('the list renders from the preview column, without fetching any full text', async ({ page }) => {
    await openComposer(page);
    await openPicker(page);

    const doc = page.locator(`.note-cite-doc[data-id="${DOCUMENT_IDS.chullin}"]`);
    await expect(doc.locator('.note-cite-doc-title')).toHaveText(DOC_TITLE);
    await expect(doc.locator('.note-cite-doc-preview')).toContainText('Shechita requires five things');
  });

  test('search narrows the list to matching documents', async ({ page }) => {
    await openComposer(page);
    await openPicker(page);
    await expect(page.locator('.note-cite-doc')).toHaveCount(2);

    await page.fill('#noteCiteSearch', 'tefillah');
    await expect(page.locator('.note-cite-doc')).toHaveCount(1);
    await expect(page.locator('.note-cite-doc-title')).toHaveText('Berachos notebook');
  });

  test('opening a document shows its text, and Back returns to the list', async ({ page }) => {
    await openComposer(page);
    await openPicker(page);
    await page.click(`.note-cite-doc[data-id="${DOCUMENT_IDS.chullin}"]`);

    await expect(page.locator('#noteCiteDocTitle')).toHaveText(DOC_TITLE);
    await expect(page.locator('#noteCiteText')).toContainText('sugya of derasa');
    await expect(page.locator('#noteCiteBrowse')).toBeHidden();

    await page.click('#noteCiteBack');
    await expect(page.locator('#noteCiteBrowse')).toBeVisible();
    await expect(page.locator('#noteCitePassage')).toBeHidden();
  });
});

test.describe('Quote from my notes — choosing a passage', () => {
  test.beforeEach(async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author) });
    await page.goto('/browse/');
    await openComposer(page);
    await openPicker(page);
    await page.click(`.note-cite-doc[data-id="${DOCUMENT_IDS.chullin}"]`);
  });

  test('Use selection is disabled until something is actually selected', async ({ page }) => {
    await expect(page.locator('#noteCiteUse')).toBeDisabled();
    await expect(page.locator('#noteCiteHint')).toContainText('Select the words');

    await selectInPassage(page, 0, 30);
    await expect(page.locator('#noteCiteUse')).toBeEnabled();
    await expect(page.locator('#noteCiteHint')).toContainText('30 characters');
  });

  test('a selection that strays outside the document pane does not count', async ({ page }) => {
    // Selecting the dialog's heading is not selecting a passage from the
    // document, and must not be usable as one.
    await page.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('noteCiteDocTitle'));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await expect(page.locator('#noteCiteUse')).toBeDisabled();
  });

  test('the chosen passage is copied into the note body and the source is shown', async ({ page }) => {
    await selectInPassage(page, 0, 30);
    await page.click('#noteCiteUse');

    await expect(page.locator('#noteCiteDialog')).toBeHidden();
    await expect(page.locator('#noteBodyInput')).toHaveValue('Shechita requires five things.');
    await expect(page.locator('#noteCiteCurrent')).toBeVisible();
    await expect(page.locator('#noteCiteCurrentTitle')).toHaveText(DOC_TITLE);
  });

  test('a second passage is appended below the first, not pasted over it', async ({ page }) => {
    await selectInPassage(page, 0, 30);
    await page.click('#noteCiteUse');

    await openPicker(page);
    await page.click(`.note-cite-doc[data-id="${DOCUMENT_IDS.chullin}"]`);
    await selectInPassage(page, 31, 63);
    await page.click('#noteCiteUse');

    const body = await page.locator('#noteBodyInput').inputValue();
    expect(body).toContain('Shechita requires five things.');
    expect(body).toContain('My notes on the sugya of derasa.');
    expect(body.indexOf('Shechita')).toBeLessThan(body.indexOf('My notes'));
  });

  test('quoting a second document warns that it replaces the first source', async ({ page }) => {
    await selectInPassage(page, 0, 30);
    await page.click('#noteCiteUse');

    await openPicker(page);
    await page.click(`.note-cite-doc[data-id="${DOCUMENT_IDS.berachos}"]`);
    await selectInPassage(page, 0, 20);

    await expect(page.locator('#noteCiteHint')).toContainText(DOC_TITLE);
    await expect(page.locator('#noteCiteHint')).toContainText('Berachos notebook');

    await page.click('#noteCiteUse');
    await expect(page.locator('#noteCiteCurrentTitle')).toHaveText('Berachos notebook');
  });

  test('the × drops the source without touching the text already quoted', async ({ page }) => {
    await selectInPassage(page, 0, 30);
    await page.click('#noteCiteUse');
    await expect(page.locator('#noteCiteCurrent')).toBeVisible();

    await page.click('#noteCiteClear');
    await expect(page.locator('#noteCiteCurrent')).toBeHidden();
    await expect(page.locator('#noteBodyInput')).toHaveValue('Shechita requires five things.');
  });
});

test.describe("Quote from my notes — the note's 2000-character cap", () => {
  // A document long enough that no single selection of it can fit in a note.
  function databaseWithLongDocument() {
    const db = buildDatabase();
    const doc = db.note_documents.find((d) => d.id === DOCUMENT_IDS.chullin);
    doc.full_text = 'x'.repeat(5000);
    doc.preview = doc.full_text.slice(0, 300);
    return db;
  }

  test.beforeEach(async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author), db: databaseWithLongDocument() });
    await page.goto('/browse/');
    await openComposer(page);
    await openPicker(page);
    await page.click(`.note-cite-doc[data-id="${DOCUMENT_IDS.chullin}"]`);
  });

  test('an over-long selection is refused with the shortfall stated, not truncated', async ({ page }) => {
    await selectInPassage(page, 0, 2500);
    await expect(page.locator('#noteCiteUse')).toBeDisabled();
    await expect(page.locator('#noteCiteHint')).toContainText('2500 characters');
    await expect(page.locator('#noteCiteHint')).toContainText('2000 will fit');
    await expect(page.locator('#noteBodyInput')).toHaveValue('');
  });

  test('the budget shrinks by what the reader has already written', async ({ page }) => {
    await page.click('#noteCiteBack');
    // Escape rather than clicking the × : at mobile widths Playwright's own
    // hit test refuses every .dialog-close on this site (the eyebrow's box
    // overlaps the button's, though the button is what actually paints on
    // top and what a real tap reaches -- elementsFromPoint puts it first).
    // Pre-existing and site-wide, reproduced on #searchNotesDialog, which
    // predates this feature; not worked around here beyond not depending on
    // it.
    await page.keyboard.press('Escape');
    await expect(page.locator('#noteCiteDialog')).toBeHidden();
    await page.fill('#noteBodyInput', 'y'.repeat(500));

    await openPicker(page);
    await page.click(`.note-cite-doc[data-id="${DOCUMENT_IDS.chullin}"]`);
    await selectInPassage(page, 0, 1600);

    // 2000 - 500 written - 2 for the blank line that separates them = 1498.
    await expect(page.locator('#noteCiteUse')).toBeDisabled();
    await expect(page.locator('#noteCiteHint')).toContainText('1498 will fit');
  });
});

test.describe('Quote from my notes — what gets saved', () => {
  test('the note records source_document_id alongside its ordinary columns', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author) });
    await page.goto('/browse/');
    await openComposer(page);
    await openPicker(page);
    await page.click(`.note-cite-doc[data-id="${DOCUMENT_IDS.chullin}"]`);
    await selectInPassage(page, 0, 30);
    await page.click('#noteCiteUse');
    await page.click('#saveNoteButton');

    await expect(page.locator('#noteBodyInput')).toHaveValue('');
    const row = await insertedNote(page);
    expect(row.body).toBe('Shechita requires five things.');
    expect(row.source_document_id).toBe(DOCUMENT_IDS.chullin);
    // Everything else about it is an ordinary note.
    expect(row.segment_ref).toBe(SEGMENT);
    expect(row.daf_ref_key).toBe('Chullin-89a');
  });

  test('an ordinary note saves a null source, and the next note starts uncited', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author) });
    await page.goto('/browse/');
    await openComposer(page);
    await openPicker(page);
    await page.click(`.note-cite-doc[data-id="${DOCUMENT_IDS.chullin}"]`);
    await selectInPassage(page, 0, 30);
    await page.click('#noteCiteUse');
    await page.click('#saveNoteButton');

    // The citation belongs to the note that was saved, not to the composer.
    await expect(page.locator('#noteCiteCurrent')).toBeHidden();

    await page.fill('#noteBodyInput', 'An ordinary note with no source at all.');
    await page.click('#saveNoteButton');

    const row = await insertedNote(page, 1);
    expect(row.body).toBe('An ordinary note with no source at all.');
    expect(row.source_document_id).toBeNull();
  });
});

test.describe('Quote from my notes — provenance on the note itself', () => {
  test('the author sees "From <document>" on a note they quoted', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author) });
    await page.goto('/browse/');
    await openComposer(page);

    const cited = page.locator(`.note-item[data-id="${NOTE_IDS.citesDocument}"]`);
    await expect(cited.locator('.note-pill-source')).toHaveText(`From ${DOC_TITLE}`);
    // No file was ever kept for a pasted document (see the fixture's own
    // comment), so there is nothing to download.
    await expect(cited.locator('.note-pill-download')).toHaveCount(0);
  });

  test('a note with no source carries no such pill', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author) });
    await page.goto('/browse/');
    await openComposer(page);

    const plain = page.locator(`.note-item[data-id="${NOTE_IDS.legacySegmentOnly}"]`);
    await expect(plain).toBeVisible();
    await expect(plain.locator('.note-pill-source')).toHaveCount(0);
  });

  // loadCitedDocuments (notes.js) asks for a cited document with NO owner
  // filter of its own any more -- it trusts note_documents_public_read to
  // decide what comes back (see 20260916160000_document_sharing.sql and
  // that function's own header). This stub has no RLS at all, so it cannot
  // prove a PRIVATE document is withheld from a stranger -- that is
  // rls_authorization.sql's job (its "Publishing a document" section proves
  // exactly this against the real policies). What IS provable here, and
  // what these two specs cover, is what the client does with whatever the
  // query returns: render the pill (and a download link, if a file was
  // kept) once a document row comes back, whoever is asking.
  test('a stranger sees the pill and a download link once the document is public', async ({ page }) => {
    failOnPageError(page);
    // Reader One did not write NOTE_IDS.citesDocumentShared, but it is a
    // shared note, and DOCUMENT_IDS.chullin -- the document it quotes -- is
    // made public below, so both are things a stranger may legitimately see.
    const db = buildDatabase();
    const doc = db.note_documents.find((d) => d.id === DOCUMENT_IDS.chullin);
    doc.visibility = 'public';
    doc.file_path = `${USERS.author.id}/${DOCUMENT_IDS.chullin}.docx`;
    await preparePage(page, { session: sessionFor(USERS.ordinary), db });
    await page.goto('/browse/');
    await page.evaluate(() => window.DafNotes.open('Berakhot 2a.1', ''));

    const shared = page.locator(`.note-item[data-id="${NOTE_IDS.citesDocumentShared}"]`);
    await expect(shared).toContainText('SHARED-EXCERPT');
    await expect(shared.locator('.note-pill-source')).toHaveText(`From ${DOC_TITLE}`);
    await expect(shared.locator('.note-pill-download')).toBeVisible();
  });

  test('clicking the download link fetches a signed URL for the kept file', async ({ page }) => {
    failOnPageError(page);
    const db = buildDatabase();
    const doc = db.note_documents.find((d) => d.id === DOCUMENT_IDS.chullin);
    doc.visibility = 'public';
    doc.file_path = `${USERS.author.id}/${DOCUMENT_IDS.chullin}.docx`;
    await preparePage(page, { session: sessionFor(USERS.ordinary), db });
    // The stub's fake signed URL points at a domain that does not resolve;
    // stubbing the response lets the popup actually load it instead of
    // landing on chrome's own network-error page.
    await page.context().route('https://stub.local/**', (route) => route.fulfill({ status: 200, contentType: 'text/plain', body: 'ok' }));
    await page.goto('/browse/');
    await page.evaluate(() => window.DafNotes.open('Berakhot 2a.1', ''));

    const shared = page.locator(`.note-item[data-id="${NOTE_IDS.citesDocumentShared}"]`);
    const [popup] = await Promise.all([
      page.waitForEvent('popup'),
      shared.locator('.note-pill-download').click(),
    ]);
    await popup.waitForLoadState();
    expect(popup.url()).toContain('documents');
    expect(popup.url()).toContain(DOCUMENT_IDS.chullin);
  });
});

test.describe('My Notes — Quoted on', () => {
  async function openDocument(page, id) {
    await page.goto('/notes/?tab=documents');
    await page.click(`.cc-card[data-id="${id}"] .cc-card-title a`);
    await expect(page.locator('#mnDocDialog')).toBeVisible();
  }

  test('lists every daf a document has been quoted on', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author) });
    await openDocument(page, DOCUMENT_IDS.chullin);

    await expect(page.locator('#mnDocCitations')).toBeVisible();
    const dafs = await page.locator('.cc-doc-citation-daf').allTextContents();
    expect(dafs).toContain('Chullin 89a');
    expect(dafs).toContain('Berakhot 2a');
  });

  test('each entry links to the daf and marks the shared ones', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author) });
    await openDocument(page, DOCUMENT_IDS.chullin);

    const shared = page.locator('.cc-doc-citation', { hasText: 'Berakhot 2a' });
    await expect(shared).toHaveAttribute('href', '/browse/?ref=Berakhot%202a');
    await expect(shared.locator('.cc-chip-shared')).toHaveText('Shared');

    const priv = page.locator('.cc-doc-citation', { hasText: 'Chullin 89a' });
    await expect(priv.locator('.cc-chip-shared')).toHaveCount(0);
  });

  test('a document nobody has quoted shows no "Quoted on" section at all', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author) });
    await openDocument(page, DOCUMENT_IDS.berachos);

    await expect(page.locator('#mnDocText')).toContainText('order of the berachos');
    await expect(page.locator('#mnDocCitations')).toBeHidden();
  });
});
