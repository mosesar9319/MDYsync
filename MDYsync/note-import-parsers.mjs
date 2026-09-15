// Turning a .docx or a PDF into plain text, entirely in the browser.
//
// WHY THERE IS NO FILE STORAGE HERE. note_documents keeps extracted TEXT and
// nothing else -- the paste/.txt/.md tiers store no file, and that migration's
// own comment promises "no file is stored anywhere". Adding .docx and PDF does
// not change that: the bytes are read, the text is pulled out, and the file
// itself is never uploaded. That means no storage bucket, no upload endpoint,
// no retention question, and no new server-side attack surface for a feature
// whose whole output is a string.
//
// An ES module rather than a classic script (the rest of /notes/ is classic)
// because pdf.js is an ES module and this has to `import` it anyway; the page
// reaches this through one dynamic import(), so nothing loads until a reader
// actually picks one of these formats.

// pdf.js is already vendored for the Vilna page renderer. The local copy is
// used rather than app.js's CDN path: /notes/ has no reason to depend on
// jsdelivr being reachable, and the file is already being served.
const PDFJS_URL = '/vendor/pdf.min.mjs';
const PDF_WORKER_URL = '/vendor/pdf.worker.min.mjs';

let pdfLibPromise = null;
function loadPdfJs() {
  if (!pdfLibPromise) {
    pdfLibPromise = import(PDFJS_URL).then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = PDF_WORKER_URL;
      return lib;
    });
  }
  return pdfLibPromise;
}

export class ImportParseError extends Error {}

// --- ZIP ---------------------------------------------------------------
//
// A .docx is a ZIP archive; the text lives in one entry inside it. Rather
// than vendor a general-purpose ZIP library for that, this reads the two
// structures actually needed -- the end-of-central-directory record and the
// central directory -- and inflates the one entry asked for. Browsers do the
// actual decompression through DecompressionStream('deflate-raw'), so there
// is no inflate implementation here to get wrong.

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const MAX_COMMENT = 0xffff;

// The EOCD sits at the very end, unless the archive carries a trailing
// comment -- so it is searched for backwards over the largest a comment can
// be, rather than assumed to be at a fixed offset.
function findEndOfCentralDirectory(view) {
  const minimum = 22;
  const from = Math.max(0, view.byteLength - MAX_COMMENT - minimum);
  for (let at = view.byteLength - minimum; at >= from; at -= 1) {
    if (view.getUint32(at, true) === EOCD_SIGNATURE) return at;
  }
  throw new ImportParseError('This file is not a valid .docx (no ZIP directory found).');
}

// Returns { name -> { offset, compressedSize, method } } for every entry.
function readCentralDirectory(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(view);
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);

  const entries = new Map();
  const decoder = new TextDecoder('utf-8');
  for (let i = 0; i < count; i += 1) {
    if (at + 46 > bytes.byteLength || view.getUint32(at, true) !== CENTRAL_SIGNATURE) {
      throw new ImportParseError('This .docx appears to be damaged (bad ZIP directory).');
    }
    const method = view.getUint16(at + 10, true);
    const compressedSize = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localHeaderOffset = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    entries.set(name, { method, compressedSize, localHeaderOffset });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

// The local header repeats the name and extra fields with their OWN lengths,
// which need not match the central directory's -- so the data offset is
// computed from the local header, never from the central entry.
function entryDataOffset(view, localHeaderOffset) {
  const nameLength = view.getUint16(localHeaderOffset + 26, true);
  const extraLength = view.getUint16(localHeaderOffset + 28, true);
  return localHeaderOffset + 30 + nameLength + extraLength;
}

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readZipEntry(bytes, name) {
  const entries = readCentralDirectory(bytes);
  const entry = entries.get(name);
  if (!entry) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const start = entryDataOffset(view, entry.localHeaderOffset);
  const raw = bytes.subarray(start, start + entry.compressedSize);
  // 0 = stored, 8 = deflate. Word writes deflate; a few tools write stored
  // for tiny parts, and both are cheap to support.
  if (entry.method === 0) return raw;
  if (entry.method === 8) return inflateRaw(raw);
  throw new ImportParseError(`This .docx uses an unsupported compression method (${entry.method}).`);
}

// --- .docx -------------------------------------------------------------

const DOCX_MAIN_PART = 'word/document.xml';

// Pulls the readable text out of WordprocessingML.
//
// Deliberately NOT an XML DOM parse: the whole output is a plain string, and
// the three structures that matter for reading it back are all expressible as
// text rules. <w:p> ends a paragraph, <w:tab/> and <w:br/> are whitespace, and
// <w:t> holds the characters. Everything else -- styling, revision marks,
// bookmarks, proofing state -- is markup this feature has no use for.
export function docxXmlToText(xml) {
  let text = xml
    // Instruction text and deleted (tracked-change) runs are not part of what
    // the document says; dropping them before anything else stops their
    // contents being collected by the <w:t> pass below.
    .replace(/<w:instrText[\s\S]*?<\/w:instrText>/g, '')
    .replace(/<w:delText[\s\S]*?<\/w:delText>/g, '')
    .replace(/<w:tab\b[^>]*\/?>/g, '\t')
    .replace(/<w:br\b[^>]*\/?>/g, '\n')
    .replace(/<w:cr\b[^>]*\/?>/g, '\n')
    // A table cell that ends without a following paragraph break still needs
    // separating from the next cell's text.
    .replace(/<\/w:tc>/g, '\t')
    .replace(/<\/w:p>/g, '\n');

  // Only <w:t> carries characters. Collecting these rather than stripping all
  // tags means attribute values and non-text parts can never leak into the
  // output.
  let out = '';
  const runs = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|([\t\n]+)/g;
  let match;
  while ((match = runs.exec(text)) !== null) {
    out += match[1] !== undefined ? match[1] : match[2];
  }

  return decodeXmlEntities(out)
    // Word emits a tab or newline per structural element, which stacks up
    // into long runs of blank lines on a document with any styling.
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeXmlEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, entity) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X'
        ? parseInt(entity.slice(2), 16)
        : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    return named[entity] !== undefined ? named[entity] : whole;
  });
}

export async function parseDocx(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const part = await readZipEntry(bytes, DOCX_MAIN_PART).catch((error) => {
    if (error instanceof ImportParseError) throw error;
    throw new ImportParseError('This .docx could not be read. It may be damaged.');
  });
  if (!part) {
    // A .doc renamed to .docx, or an .odt, lands here: a readable ZIP with no
    // WordprocessingML in it.
    throw new ImportParseError(
      'This does not look like a Word .docx file. If it is an older .doc, open it in Word and save it as .docx.'
    );
  }
  return docxXmlToText(new TextDecoder('utf-8').decode(part));
}

// --- PDF ---------------------------------------------------------------

// Joins one page's text items. pdf.js hands back positioned fragments, not
// lines, so `hasEOL` is what says where a line actually ended -- without it
// every page collapses into one unbroken paragraph.
export function pdfItemsToText(items) {
  let out = '';
  for (const item of items) {
    if (typeof item.str === 'string') out += item.str;
    if (item.hasEOL) out += '\n';
  }
  return out;
}

export async function parsePdf(arrayBuffer, { onProgress } = {}) {
  const lib = await loadPdfJs();
  let pdf;
  try {
    pdf = await lib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
  } catch (error) {
    // pdf.js names this case specifically, and it is the one a reader can
    // actually do something about.
    if (error && error.name === 'PasswordException') {
      throw new ImportParseError('This PDF is password-protected. Remove the password and try again.');
    }
    throw new ImportParseError('This PDF could not be read. It may be damaged.');
  }

  const pages = [];
  for (let number = 1; number <= pdf.numPages; number += 1) {
    const page = await pdf.getPage(number);
    const content = await page.getTextContent();
    pages.push(pdfItemsToText(content.items));
    // Released as we go: a long PDF otherwise holds every page's operator
    // list in memory at once.
    page.cleanup();
    if (onProgress) onProgress(number, pdf.numPages);
  }

  const text = pages.join('\n\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  // A scanned PDF is a stack of images with no text layer, and extracting
  // from one yields nothing at all. Saying so is the whole point: importing
  // an empty document "successfully" is the worst outcome here, because the
  // reader finds out much later, with the original file long since closed.
  if (!text) {
    throw new ImportParseError(
      pdf.numPages === 1
        ? 'No text could be read from this PDF. If it is a scan or a photograph, it holds pictures rather than text, so there is nothing to import.'
        : `No text could be read from any of this PDF's ${pdf.numPages} pages. If it is a scan, it holds pictures rather than text, so there is nothing to import.`
    );
  }
  return text;
}

// --- Dispatch ----------------------------------------------------------

// The source_kind the database will be told about, derived from the filename.
// Kept here beside the parsers so a new format cannot be given a UI path
// without also being given a stored kind.
export function sourceKindForFilename(name) {
  const lower = String(name || '').toLowerCase();
  if (lower.endsWith('.docx')) return 'docx';
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'md';
  return 'txt';
}

export const BINARY_KINDS = new Set(['docx', 'pdf']);

export async function extractText(file, { onProgress } = {}) {
  const kind = sourceKindForFilename(file.name);
  if (kind === 'docx') return parseDocx(await file.arrayBuffer());
  if (kind === 'pdf') return parsePdf(await file.arrayBuffer(), { onProgress });
  return file.text();
}
