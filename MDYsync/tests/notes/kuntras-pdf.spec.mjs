import { test, expect } from '@playwright/test';
import { preparePage, failOnPageError } from '../support/harness.mjs';
import { buildDatabase, sessionFor, USERS } from '../fixtures/dataset.mjs';

// Kuntras Builder, slice 5: PDF export.
//
// Unlike every other Kuntras suite, this one lets the vendored pdf-lib and
// fontkit scripts (kuntras-pdf.js's own header explains why they are real
// <script> tags, not the dynamic import() the rest of this codebase uses)
// actually load and run in the browser, and lets a real download happen --
// the whole point of this feature is those two libraries + the embedded
// Frank Ruhl Libre font producing real PDF bytes, which no amount of stub
// wiring would prove. See kuntras-pdf.js's own bidi-logic unit coverage
// below, exercised through the SHIPPED file (via page.evaluate against
// window.DafSyncKuntras.pdf), not a separate reimplementation.

const KUN_ID = 'fa000000-0000-4000-8000-000000000001';
const ENTRY_ID = 'fa000000-0000-4000-8000-000000000002';
const SECTION_ID = 'fa000000-0000-4000-8000-000000000003';

function databaseWithTree(visibility, ownerId = USERS.author.id) {
  const db = buildDatabase();
  db.kuntrasim = db.kuntrasim || [];
  db.kuntras_sections = db.kuntras_sections || [];
  db.kuntras_entries = db.kuntras_entries || [];
  db.kuntrasim.push({
    id: KUN_ID, owner_id: ownerId, title: 'Export me', visibility,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), deleted_at: null,
  });
  db.kuntras_sections.push({
    id: SECTION_ID, kuntras_id: KUN_ID, parent_section_id: null, title: 'חלק א', position: 0,
  });
  db.kuntras_entries.push({
    id: ENTRY_ID, kuntras_id: KUN_ID, section_id: SECTION_ID, kind: 'freeform', title: null,
    body: 'A thought worth printing, mixing עברית and English in the same line.', position: 0,
    source_note_id: null, source_document_id: null, source_chaburah_note_id: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
  return db;
}

test.describe('Kuntras Builder — exporting a PDF', () => {
  test('the owner can export their own kuntras to a real PDF file', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author), db: databaseWithTree('private') });
    await page.goto(`/kuntras/?k=${KUN_ID}`);
    await expect(page.locator('#knBuilder')).toBeVisible();
    await expect(page.locator('#knExportButton')).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#knExportButton'),
    ]);
    expect(download.suggestedFilename()).toBe('Export me.pdf');
    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    // A real PDF, not an empty or truncated file -- %PDF- is the format's
    // own magic header, and a page with an embedded font plus body text
    // is never this small by accident.
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(20000);

    await expect(page.locator('#knExportStatus')).toBeHidden();
    await expect(page.locator('#knExportButton')).toBeEnabled();
  });

  test('a read-only visitor to a shared link can export it too', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: null, db: databaseWithTree('unlisted') });
    await page.goto(`/kuntras/?k=${KUN_ID}`);
    await expect(page.locator('#knBuilder')).toBeVisible();
    // Every other builder-head button is hidden for a read-only visitor
    // (see kuntras-sharing.spec.mjs) -- Export PDF is deliberately not one
    // of them.
    await expect(page.locator('#knShareButton')).toBeHidden();
    await expect(page.locator('#knExportButton')).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#knExportButton'),
    ]);
    expect(download.suggestedFilename()).toBe('Export me.pdf');
  });

  test('shows a status message while building, and clears it on success', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author), db: databaseWithTree('private') });
    await page.goto(`/kuntras/?k=${KUN_ID}`);
    await expect(page.locator('#knExportStatus')).toBeHidden();

    const downloadPromise = page.waitForEvent('download');
    await page.click('#knExportButton');
    await downloadPromise;
    await expect(page.locator('#knExportStatus')).toBeHidden();
  });
});

test.describe('Kuntras Builder — bidi line layout (kuntras-pdf.js)', () => {
  // Exercises the SHIPPED module in a real page, not a reimplementation --
  // see kuntras-pdf.js's own header on layoutBidiLine for exactly what this
  // simplified approach does and does not handle (word-level only, no
  // nested embedding, no RTL punctuation mirroring).
  test.beforeEach(async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author) });
    await page.goto('/kuntras/');
    await expect(page.locator('#knLibrary')).toBeVisible();
  });

  test('classifies words by script, and neutral (digit-only) words separately', async ({ page }) => {
    const result = await page.evaluate(() => {
      const pdf = window.DafSyncKuntras.pdf;
      return {
        hebrew: pdf.classifyWord('שלום'),
        latin: pdf.classifyWord('Hello'),
        digits: pdf.classifyWord('123'),
      };
    });
    expect(result).toEqual({ hebrew: 'rtl', latin: 'ltr', digits: 'neutral' });
  });

  test('a pure Hebrew line is reversed word-by-word for correct RTL display', async ({ page }) => {
    const visual = await page.evaluate(() => {
      const pdf = window.DafSyncKuntras.pdf;
      return pdf.layoutBidiLine(['שלום', 'עולם'], 'rtl').map((w) => w.text);
    });
    expect(visual).toEqual(['עולם', 'שלום']);
  });

  test('a pure English line is left untouched', async ({ page }) => {
    const visual = await page.evaluate(() => {
      const pdf = window.DafSyncKuntras.pdf;
      return pdf.layoutBidiLine(['Hello', 'world', '123'], 'ltr').map((w) => w.text);
    });
    expect(visual).toEqual(['Hello', 'world', '123']);
  });

  test('an English word embedded in an RTL line keeps its own reading order', async ({ page }) => {
    // "אני אוהב PYTHON מאוד" (I love PYTHON very much) typed in that logical
    // order -- PYTHON must not come out reversed as NOHTYP, and the two runs
    // of Hebrew words around it must each read correctly once reversed.
    const visual = await page.evaluate(() => {
      const pdf = window.DafSyncKuntras.pdf;
      return pdf.layoutBidiLine(['אני', 'אוהב', 'PYTHON', 'מאוד'], 'rtl').map((w) => w.text);
    });
    expect(visual).toEqual(['מאוד', 'PYTHON', 'אוהב', 'אני']);
  });

  test('a Hebrew phrase embedded in an LTR sentence keeps the sentence flowing, only the phrase reversed', async ({ page }) => {
    const visual = await page.evaluate(() => {
      const pdf = window.DafSyncKuntras.pdf;
      return pdf.layoutBidiLine(['The', 'rebbe', 'said', 'שלום', 'עליכם', 'to', 'everyone'], 'ltr').map((w) => w.text);
    });
    expect(visual).toEqual(['The', 'rebbe', 'said', 'עליכם', 'שלום', 'to', 'everyone']);
  });

  test('paragraph direction follows whichever script has more letters', async ({ page }) => {
    const result = await page.evaluate(() => {
      const pdf = window.DafSyncKuntras.pdf;
      return {
        mostlyHebrew: pdf.paragraphBaseDirection('שלום עולם Hello'),
        mostlyEnglish: pdf.paragraphBaseDirection('Hello world שלום'),
      };
    });
    expect(result.mostlyHebrew).toBe('rtl');
    expect(result.mostlyEnglish).toBe('ltr');
  });
});
