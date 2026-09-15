import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  docxXmlToText, parseDocx, pdfItemsToText, sourceKindForFilename, ImportParseError,
} from '../../note-import-parsers.mjs';
import { docxWithBody, paragraphs, makeZip, makeZipWithComment } from '../fixtures/import/make-docx.mjs';

// These run against REAL ZIP archives built by node:zlib, not mocks: the ZIP
// reader is the thing most likely to be subtly wrong, and a fake archive
// would only prove it agrees with itself.

test('.docx — paragraphs become lines, in document order', async () => {
  const buf = docxWithBody(paragraphs('First line.', 'Second line.', 'Third line.'));
  assert.equal(await parseDocx(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)),
    'First line.\nSecond line.\nThird line.');
});

test('.docx — Hebrew survives the round trip', async () => {
  const buf = docxWithBody(paragraphs('שחיטה צריכה חמשה דברים', 'דרסה ושהייה'));
  const text = await parseDocx(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
  assert.equal(text, 'שחיטה צריכה חמשה דברים\nדרסה ושהייה');
});

test('.docx — a stored (uncompressed) entry reads the same as a deflated one', async () => {
  const body = paragraphs('Stored, not deflated.');
  const deflated = docxWithBody(body, { method: 8 });
  const stored = docxWithBody(body, { method: 0 });
  const read = (b) => parseDocx(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
  assert.equal(await read(stored), await read(deflated));
});

test('.docx — a trailing ZIP comment does not hide the directory', async () => {
  const document = `<w:document xmlns:w="x"><w:body>${paragraphs('Found anyway.')}</w:body></w:document>`;
  const buf = makeZipWithComment({ 'word/document.xml': document }, 'a trailing comment '.repeat(50));
  assert.equal(await parseDocx(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)),
    'Found anyway.');
});

test('.docx — a ZIP without WordprocessingML is refused with advice, not parsed', async () => {
  const buf = makeZip({ 'mimetype': 'application/vnd.oasis.opendocument.text' });
  await assert.rejects(
    () => parseDocx(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)),
    (error) => error instanceof ImportParseError && /older \.doc/.test(error.message)
  );
});

test('.docx — a file that is not a ZIP at all is refused', async () => {
  const buf = Buffer.from('This is a plain text file pretending to be a docx.');
  await assert.rejects(
    () => parseDocx(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)),
    (error) => error instanceof ImportParseError
  );
});

// --- The XML → text rules, tested directly -----------------------------

test('tabs, breaks and table cells become whitespace rather than vanishing', () => {
  const xml = '<w:p><w:r><w:t>A</w:t><w:tab/><w:t>B</w:t><w:br/><w:t>C</w:t></w:r></w:p>';
  assert.equal(docxXmlToText(xml), 'A\tB\nC');
});

test('a table row keeps its cells apart', () => {
  const xml = '<w:tbl><w:tr>'
    + '<w:tc><w:p><w:r><w:t>Daf</w:t></w:r></w:p></w:tc>'
    + '<w:tc><w:p><w:r><w:t>Topic</w:t></w:r></w:p></w:tc>'
    + '</w:tr></w:tbl>';
    assert.match(docxXmlToText(xml), /Daf\s+Topic/);
});

test('text deleted by tracked changes is not part of what the document says', () => {
  const xml = '<w:p><w:r><w:t>Kept.</w:t></w:r>'
    + '<w:del><w:r><w:delText>Removed.</w:delText></w:r></w:del></w:p>';
  const text = docxXmlToText(xml);
  assert.match(text, /Kept\./);
  assert.doesNotMatch(text, /Removed\./);
});

test('field instructions (a TOC, a page ref) are not mistaken for prose', () => {
  const xml = '<w:p><w:r><w:instrText> TOC \\o "1-3" </w:instrText></w:r>'
    + '<w:r><w:t>Real text.</w:t></w:r></w:p>';
  assert.equal(docxXmlToText(xml), 'Real text.');
});

test('markup never leaks into the output, attributes included', () => {
  const xml = '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'
    + '<w:bookmarkStart w:id="0" w:name="SECRET_BOOKMARK"/>'
    + '<w:r><w:rPr><w:b/></w:rPr><w:t>Only this.</w:t></w:r></w:p>';
  const text = docxXmlToText(xml);
  assert.equal(text, 'Only this.');
  assert.doesNotMatch(text, /Heading1|SECRET_BOOKMARK|w:/);
});

test('XML entities are decoded, including numeric and hex forms', () => {
  const xml = '<w:p><w:r><w:t>R&#39;&#x27; Akiva &amp; Rabbi Meir &lt;here&gt;</w:t></w:r></w:p>';
  assert.equal(docxXmlToText(xml), "R'' Akiva & Rabbi Meir <here>");
});

test('xml:space preserved runs keep their spacing', () => {
  const xml = '<w:p><w:r><w:t xml:space="preserve">Rabbi </w:t>'
    + '<w:t xml:space="preserve">Akiva</w:t></w:r></w:p>';
  assert.equal(docxXmlToText(xml), 'Rabbi Akiva');
});

test('heavy styling does not produce a wall of blank lines', () => {
  const xml = Array.from({ length: 5 }, () => '<w:p/>').join('')
    + paragraphs('After the empties.');
  assert.equal(docxXmlToText(xml), 'After the empties.');
});

// --- PDF ---------------------------------------------------------------
//
// pdf.js itself is not re-tested here; what is testable without a browser is
// the join, which is where the line breaks are decided.

test('PDF fragments are joined, and hasEOL is what ends a line', () => {
  const items = [
    { str: 'Shechita ', hasEOL: false },
    { str: 'requires', hasEOL: true },
    { str: 'five things.', hasEOL: true },
  ];
  assert.equal(pdfItemsToText(items), 'Shechita requires\nfive things.\n');
});

test('PDF items without a string (marked content) are skipped, not stringified', () => {
  const items = [{ type: 'beginMarkedContent' }, { str: 'Text.', hasEOL: true }];
  assert.equal(pdfItemsToText(items), 'Text.\n');
});

// --- Dispatch ----------------------------------------------------------

test('the stored source_kind is decided by extension, case-insensitively', () => {
  assert.equal(sourceKindForFilename('Notes.DOCX'), 'docx');
  assert.equal(sourceKindForFilename('scan.pdf'), 'pdf');
  assert.equal(sourceKindForFilename('notes.md'), 'md');
  assert.equal(sourceKindForFilename('notes.markdown'), 'md');
  assert.equal(sourceKindForFilename('notes.txt'), 'txt');
  // Anything unrecognised is read as plain text rather than refused outright.
  assert.equal(sourceKindForFilename('notes'), 'txt');
  // A name that merely CONTAINS the extension is not that format.
  assert.equal(sourceKindForFilename('about-pdf-files.txt'), 'txt');
});
