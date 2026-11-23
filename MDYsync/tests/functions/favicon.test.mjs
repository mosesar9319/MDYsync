import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Google shows a site's icon beside its results only when the home page names
// one that is square, in a size that is a multiple of 48. The logo's own file
// (assets/dafsync-mark.png, 608x489) is not square, which is why results
// showed a plain globe: these are the square ones made from it.

const root = new URL('../../', import.meta.url).pathname;
const pngSize = (file) => {
  const bytes = readFileSync(join(root, file));
  assert.equal(bytes.toString('latin1', 1, 4), 'PNG', `${file} is a PNG`);
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
};

test('the PNG icons are square, in multiples of 48', () => {
  for (const [file, size] of [['favicon-96.png', 96], ['favicon-192.png', 192]]) {
    assert.deepEqual(pngSize(file), [size, size]);
    assert.equal(size % 48, 0);
  }
});

test('favicon.ico holds a 48x48 picture (and the small ones a browser tab uses)', () => {
  const bytes = readFileSync(join(root, 'favicon.ico'));
  assert.equal(bytes.readUInt16LE(0), 0);
  assert.equal(bytes.readUInt16LE(2), 1, 'an icon file');
  const count = bytes.readUInt16LE(4);
  const sizes = [];
  for (let i = 0; i < count; i += 1) sizes.push(`${bytes[6 + i * 16] || 256}x${bytes[7 + i * 16] || 256}`);
  assert.deepEqual(sizes.sort(), ['16x16', '32x32', '48x48']);
});

test('every page names the square icons, and none names the logo file as its icon', () => {
  const pages = [];
  const walk = (dir) => {
    for (const name of readdirSync(join(root, dir))) {
      if (['node_modules', 'tests', 'supabase', '.netlify', 'docs'].includes(name)) continue;
      const path = join(dir, name);
      if (statSync(join(root, path)).isDirectory()) walk(path);
      else if (name.endsWith('.html')) pages.push(path);
    }
  };
  walk('.');
  assert.ok(pages.includes('index.html'));
  for (const page of pages) {
    const html = readFileSync(join(root, page), 'utf8');
    assert.match(html, /<link rel="icon" href="\/favicon\.ico" sizes="16x16 32x32 48x48">/, page);
    assert.match(html, /<link rel="icon" type="image\/png" sizes="96x96" href="\/favicon-96\.png">/, page);
    assert.match(html, /<link rel="icon" type="image\/png" sizes="192x192" href="\/favicon-192\.png">/, page);
    assert.doesNotMatch(html, /rel="icon"[^>]*dafsync-mark/, page);
  }
});

test('the pages made for search engines name them too', async () => {
  const { masechtaPage } = await import('../../netlify/functions/seo-pages.mjs');
  assert.equal(typeof masechtaPage, 'function');
  const source = readFileSync(join(root, 'netlify/functions/seo-pages.mjs'), 'utf8');
  assert.match(source, /<link rel="icon" href="\/favicon\.ico" sizes="16x16 32x32 48x48">/);
  assert.doesNotMatch(source, /rel="icon"[^>]*dafsync-mark/);
});
