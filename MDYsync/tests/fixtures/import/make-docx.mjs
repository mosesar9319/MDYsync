// Builds real .docx files in memory for the parser tests.
//
// A .docx is a ZIP of XML parts, so these are genuine archives written by
// Node's own zlib -- not a mock of one. That is the point: the ZIP reader in
// note-import-parsers.mjs is the thing under test, and a hand-rolled fake
// would only prove it agrees with itself.

import { deflateRawSync, crc32 } from 'node:zlib';

function dosTime() {
  // Fixed rather than "now", so a fixture's bytes are the same on every run.
  return { time: 0, date: 0x2821 }; // 2020-01-01
}

// method: 8 = deflate, 0 = stored. Both appear in real .docx files.
export function makeZip(files, { method = 8 } = {}) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const { time, date } = dosTime();

  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name, 'utf8');
    const raw = Buffer.from(content, 'utf8');
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBytes, body);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt16LE(0, 30);
    entry.writeUInt16LE(0, 32);
    entry.writeUInt16LE(0, 34);
    entry.writeUInt16LE(0, 36);
    entry.writeUInt32LE(0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);

    offset += local.length + nameBytes.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, eocd]);
}

// A ZIP carrying a trailing comment, so the end-of-central-directory record
// is NOT at a fixed offset from the end.
export function makeZipWithComment(files, comment) {
  const base = makeZip(files);
  const commentBytes = Buffer.from(comment, 'utf8');
  const out = Buffer.concat([base, commentBytes]);
  out.writeUInt16LE(commentBytes.length, base.length - 2);
  return out;
}

export function paragraphs(...texts) {
  return texts.map((t) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`).join('');
}

export function docxWithBody(bodyXml, options) {
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${bodyXml}</w:body></w:document>`;
  return makeZip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
    '_rels/.rels': '<?xml version="1.0"?><Relationships/>',
    'word/document.xml': document,
  }, options);
}
