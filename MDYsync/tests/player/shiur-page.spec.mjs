import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { preparePage, failOnPageError } from '../support/harness.mjs';
import { shiurPage, shiurimFromCatalog } from '../../netlify/functions/seo-pages.mjs';

// A shiur page (/chullin/89/stefansky/, netlify/functions/seo-pages.mjs) is the
// player's own HTML under its own address and title. The static test server
// doesn't run functions, so the page is built here, from the real
// player/index.html, and served at its own address.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLAYER_HTML = readFileSync(join(ROOT, 'player', 'index.html'), 'utf8');
const [SHIUR] = shiurimFromCatalog({ tractates: { Chullin: [{ daf: 89, regularEn: { videoId: 'abcdefghijk', label: 'Chullin 89', amud: 'a' } }] } });

test('a shiur page turns into the player for that shiur, at the player\'s address', async ({ page }) => {
  const errors = failOnPageError(page);
  const missing = [];
  page.on('response', (r) => { if (r.status() === 404) missing.push(new URL(r.url()).pathname); });
  await preparePage(page, { user: null });
  await page.route('**/chullin/89/stefansky/', (route) => route.fulfill({
    status: 200, contentType: 'text/html; charset=utf-8', body: shiurPage(PLAYER_HTML, SHIUR),
  }));
  await page.goto('/chullin/89/stefansky/');
  // The player takes ?mode=split (Split, unless the reader's account says
  // otherwise) and drops it from the address, as it does on /player/.
  await expect(page).toHaveURL(/\/player\/\?ref=Chullin\+89a$/);
  await expect.poll(() => page.evaluate(() => document.body.dataset.viewerMode)).toBe('split');
  // Scripts and styles written as ../app.js, ../styles.css resolved against
  // /player/, not /chullin/89/stefansky/.
  await expect.poll(() => page.evaluate(() => typeof window.loadDaf)).toBe('function');
  expect(await page.evaluate(() => [...document.styleSheets].some((s) => (s.href || '').endsWith('/styles.css') && s.cssRules.length > 0))).toBe(true);
  await expect(page.locator('#dafTitle')).toContainText('Chullin 89a');
  // What a search engine read stays: this page's title and canonical address.
  expect(await page.title()).toBe('Chullin 89a–89b Daf Yomi Shiur — Rabbi Eli Stefansky | DafSync');
  expect(await page.locator('link[rel=canonical]').getAttribute('href')).toBe('https://dafsync.com/chullin/89/stefansky/');
  // Nothing is asked for under the shiur page's own address (the browser's
  // look-ahead loader fetches the page's files before its first script runs).
  expect(missing).toEqual([]);
  // The one error is the same the plain player gives: the test fixtures have
  // no synced alignment for this daf.
  expect(errors).toEqual(['Error: No segments found.']);
});

