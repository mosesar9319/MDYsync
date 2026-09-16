import { test, expect } from '@playwright/test';
import { preparePage, failOnPageError, readTestCalls } from '../support/harness.mjs';
import { sessionFor, USERS } from '../fixtures/dataset.mjs';
import { docxWithBody, paragraphs, makeZip } from '../fixtures/import/make-docx.mjs';

// Importing a .docx or a PDF.
//
// Both are parsed IN THE BROWSER, and since 20260916160000_document_sharing
// the ORIGINAL file is also kept: a second write, to Supabase Storage's
// "documents" bucket, uploads the file the reader chose and records its path
// on the row (see my-notes-data.js's own createDocument). The files handed to
// setInputFiles are real archives built by node:zlib (see make-docx.mjs).
//
// The parsers' own rules are unit-tested in
// tests/functions/note-import-parsers.test.mjs; what is tested here is the
// dialog around them: what the reader sees, what gets stored, what gets
// uploaded, and what happens when a file cannot be read.

async function openImport(page) {
  await page.goto('/notes/');
  await page.click('#mnImportButton');
  await expect(page.locator('#mnImportDialog')).toBeVisible();
}

function docxFile(name, bodyXml) {
  const buffer = docxWithBody(bodyXml);
  return {
    name,
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer,
  };
}

async function storedDocuments(page) {
  return page.evaluate(() => window.__DAFSYNC_TEST_DB__.note_documents.map((d) => ({
    title: d.title, source_kind: d.source_kind,
    original_filename: d.original_filename, full_text: d.full_text,
    visibility: d.visibility, file_path: d.file_path,
  })));
}

async function storageUploads(page) {
  const calls = await readTestCalls(page);
  return calls.filter((c) => c.storage && c.storage.action === 'upload');
}

test.describe('My Notes — importing a .docx', () => {
  test.beforeEach(async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author) });
  });

  test('reads the text out of the file and shows it for review', async ({ page }) => {
    await openImport(page);
    await page.setInputFiles('#mnImportFile',
      docxFile('Chullin shiur.docx', paragraphs('Shechita requires five things.', 'Derasa is the first.')));

    await expect(page.locator('#mnImportText'))
      .toHaveValue('Shechita requires five things.\nDerasa is the first.');
    // The title is taken from the filename, with the extension dropped.
    await expect(page.locator('#mnImportTitle')).toHaveValue('Chullin shiur');
  });

  test('stores the extracted text and records where it came from', async ({ page }) => {
    await openImport(page);
    await page.setInputFiles('#mnImportFile', docxFile('notes.docx', paragraphs('From Word.')));
    await expect(page.locator('#mnImportText')).toHaveValue('From Word.');
    await page.click('#mnImportSubmit');

    await expect(page.locator('#mnImportDialog')).toBeHidden();
    const docs = await storedDocuments(page);
    const saved = docs.find((d) => d.title === 'notes');
    expect(saved).toBeTruthy();
    expect(saved.source_kind).toBe('docx');
    expect(saved.original_filename).toBe('notes.docx');
    expect(saved.full_text).toBe('From Word.');
  });

  test('Hebrew survives the import intact', async ({ page }) => {
    await openImport(page);
    await page.setInputFiles('#mnImportFile',
      docxFile('hebrew.docx', paragraphs('שחיטה צריכה חמשה דברים')));
    await expect(page.locator('#mnImportText')).toHaveValue('שחיטה צריכה חמשה דברים');
  });

  test('editing the extracted text before importing makes it a paste, not a file', async ({ page }) => {
    await openImport(page);
    await page.setInputFiles('#mnImportFile', docxFile('original.docx', paragraphs('The file said this.')));
    await expect(page.locator('#mnImportText')).toHaveValue('The file said this.');

    await page.fill('#mnImportText', 'But I rewrote it entirely.');
    await page.fill('#mnImportTitle', 'Rewritten');
    await page.click('#mnImportSubmit');

    const saved = (await storedDocuments(page)).find((d) => d.title === 'Rewritten');
    // The stored provenance has to match what was actually stored. Claiming
    // this came out of a .docx would be a lie about text the reader typed.
    expect(saved.source_kind).toBe('paste');
    expect(saved.original_filename).toBeNull();
  });

  test('a ZIP that is not a Word document is refused with advice', async ({ page }) => {
    await openImport(page);
    await page.setInputFiles('#mnImportFile', {
      name: 'notes.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: makeZip({ mimetype: 'application/vnd.oasis.opendocument.text' }),
    });

    await expect(page.locator('#mnImportError')).toBeVisible();
    await expect(page.locator('#mnImportError')).toContainText('older .doc');
    // Nothing half-loaded is left behind for the reader to submit by mistake.
    await expect(page.locator('#mnImportText')).toHaveValue('');
  });

  test('a file that is not an archive at all is refused', async ({ page }) => {
    await openImport(page);
    await page.setInputFiles('#mnImportFile', {
      name: 'fake.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: Buffer.from('I am plainly just text.'),
    });
    await expect(page.locator('#mnImportError')).toBeVisible();
    await expect(page.locator('#mnImportText')).toHaveValue('');
  });

  test('a .docx whose text exceeds the document limit is refused after extraction', async ({ page }) => {
    await openImport(page);
    // Well under any file-size guard, but far over the 500 KB text ceiling
    // once extracted -- which is exactly the case a file-size check misses.
    await page.setInputFiles('#mnImportFile',
      docxFile('huge.docx', paragraphs('x'.repeat(600000))));

    await expect(page.locator('#mnImportSize')).toHaveClass(/over/);
    await expect(page.locator('#mnImportSubmit')).toBeDisabled();
  });
});

test.describe('My Notes — importing a PDF', () => {
  test.beforeEach(async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author) });
  });

  // A one-page PDF with a real text layer, written by hand: the objects are
  // few enough to spell out, and it keeps the test free of a PDF-writing
  // dependency. pdf.js is what reads it, exactly as in production.
  function minimalPdf(text) {
    const content = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] '
        + '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    let pdf = '%PDF-1.4\n';
    const offsets = [];
    objects.forEach((body, i) => {
      offsets.push(pdf.length);
      pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
      + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
      + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return Buffer.from(pdf, 'latin1');
  }

  test('reads a PDF text layer and stores it', async ({ page }) => {
    await openImport(page);
    await page.setInputFiles('#mnImportFile', {
      name: 'shiur.pdf', mimeType: 'application/pdf', buffer: minimalPdf('Shechita requires five things.'),
    });

    await expect(page.locator('#mnImportText')).toHaveValue(/Shechita requires five things\./);
    await page.click('#mnImportSubmit');

    const saved = (await storedDocuments(page)).find((d) => d.title === 'shiur');
    expect(saved.source_kind).toBe('pdf');
    expect(saved.original_filename).toBe('shiur.pdf');
    expect(saved.full_text).toContain('Shechita requires five things.');
  });

  test('a PDF with no text layer is refused, never imported empty', async ({ page }) => {
    await openImport(page);
    // A structurally valid PDF whose page draws nothing -- what a scan or a
    // photographed page amounts to once its images are set aside.
    await page.setInputFiles('#mnImportFile', {
      name: 'scan.pdf', mimeType: 'application/pdf', buffer: minimalPdf(''),
    });

    await expect(page.locator('#mnImportError')).toBeVisible();
    await expect(page.locator('#mnImportError')).toContainText(/scan|No text/i);
    await expect(page.locator('#mnImportText')).toHaveValue('');
    // The silent failure this guards against: an empty document imported
    // "successfully", discovered much later with the original long closed.
    expect(await storedDocuments(page)).toHaveLength(3);
  });

  test('a damaged PDF is refused with a readable message', async ({ page }) => {
    await openImport(page);
    await page.setInputFiles('#mnImportFile', {
      name: 'broken.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\nnot really'),
    });
    await expect(page.locator('#mnImportError')).toBeVisible();
    await expect(page.locator('#mnImportText')).toHaveValue('');
  });
});

test.describe('My Notes — keeping the original file', () => {
  test.beforeEach(async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author) });
  });

  test('importing a .docx uploads the original and records its path', async ({ page }) => {
    await openImport(page);
    await page.setInputFiles('#mnImportFile', docxFile('kept.docx', paragraphs('Keep this file.')));
    await page.click('#mnImportSubmit');
    await expect(page.locator('#mnImportDialog')).toBeHidden();

    const uploads = await storageUploads(page);
    expect(uploads).toHaveLength(1);
    expect(uploads[0].storage.bucket).toBe('documents');
    expect(uploads[0].storage.path).toContain('.docx');

    const saved = (await storedDocuments(page)).find((d) => d.title === 'kept');
    // Private by default, same as a pasted import -- nothing about keeping
    // the file changes the starting visibility.
    expect(saved.visibility).toBe('private');
    expect(saved.file_path).toBe(uploads[0].storage.path);
  });

  test('importing a PDF uploads the original too', async ({ page }) => {
    await openImport(page);
    await page.setInputFiles('#mnImportFile', {
      name: 'kept.pdf', mimeType: 'application/pdf',
      buffer: (() => {
        const content = 'BT /F1 24 Tf 72 720 Td (Keep this file.) Tj ET';
        const objects = [
          '<< /Type /Catalog /Pages 2 0 R >>',
          '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
          '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] '
            + '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
          `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
          '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        ];
        let pdf = '%PDF-1.4\n';
        const offsets = [];
        objects.forEach((body, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${body}\nendobj\n`; });
        const xref = pdf.length;
        pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
          + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
          + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
        return Buffer.from(pdf, 'latin1');
      })(),
    });
    await page.click('#mnImportSubmit');
    await expect(page.locator('#mnImportDialog')).toBeHidden();

    const uploads = await storageUploads(page);
    expect(uploads).toHaveLength(1);
    expect(uploads[0].storage.path).toContain('.pdf');
  });

  test('pasted text uploads nothing -- there is no original file to keep', async ({ page }) => {
    await openImport(page);
    await page.fill('#mnImportTitle', 'Just typed');
    await page.fill('#mnImportText', 'No file behind this one.');
    await page.click('#mnImportSubmit');
    await expect(page.locator('#mnImportDialog')).toBeHidden();

    expect(await storageUploads(page)).toHaveLength(0);
    const saved = (await storedDocuments(page)).find((d) => d.title === 'Just typed');
    expect(saved.file_path).toBeNull();
  });

  test('editing the extracted text before importing uploads nothing either -- it is a paste now', async ({ page }) => {
    await openImport(page);
    await page.setInputFiles('#mnImportFile', docxFile('original.docx', paragraphs('The file said this.')));
    // Waited for, not raced: filling over the textarea before the parse
    // finishes would let onImportFileChosen's own write win moments later,
    // silently restoring the extracted text (and, with it, dataset.kind's
    // "from a file" match) after this test's edit -- see the sibling
    // "editing the extracted text ... makes it a paste" test above, which
    // waits the same way.
    await expect(page.locator('#mnImportText')).toHaveValue('The file said this.');
    await page.fill('#mnImportText', 'But I rewrote it entirely.');
    await page.fill('#mnImportTitle', 'Rewritten');
    await page.click('#mnImportSubmit');

    expect(await storageUploads(page)).toHaveLength(0);
    const saved = (await storedDocuments(page)).find((d) => d.title === 'Rewritten');
    expect(saved.file_path).toBeNull();
  });
});

test.describe('My Notes — the import dialog says what it does', () => {
  test('the file input accepts the formats the parsers handle', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author) });
    await openImport(page);

    const accept = await page.locator('#mnImportFile').getAttribute('accept');
    for (const ext of ['.txt', '.md', '.docx', '.pdf']) expect(accept).toContain(ext);
    // A .docx/PDF's original file is kept (see 20260916160000's own header)
    // -- that promise is stated where the reader chooses the file.
    await expect(page.locator('#mnImportDialog .dialog-note')).toContainText('kept alongside the extracted text');
  });
});

test.describe('My Notes — the import dialog fits a phone', () => {
  test('Import stays reachable once a file has filled the paste box', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author) });
    await openImport(page);
    await page.setInputFiles('#mnImportFile',
      docxFile('long.docx', paragraphs(...Array.from({ length: 40 }, (_, i) => `Line ${i}.`))));
    await expect(page.locator('#mnImportText')).not.toHaveValue('');

    // The dialog scrolls, so "reachable" is the real requirement rather than
    // "already on screen" -- this fails if the button ends up in a region
    // nothing can scroll to, which is what an unscrollable overflow would do.
    await page.locator('#mnImportSubmit').scrollIntoViewIfNeeded();
    await expect(page.locator('#mnImportSubmit')).toBeVisible();
    await page.click('#mnImportSubmit');
    await expect(page.locator('#mnImportDialog')).toBeHidden();
  });
});
