import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { preparePage } from '../support/harness.mjs';

// The site as an app: installable, and pages already opened open again with
// no connection. The service worker is blocked for every other test
// (playwright.config.mjs), because page.route() does not see what it fetches.
test.use({ serviceWorkers: 'allow' });

async function controlled(page) {
  await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 15000 });
}

// "No connection" has to be real for the worker: Playwright's offline switch
// does not reach what a service worker fetches. So this test has a site of its
// own (the same static server, on its own port) and takes it away.
const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'static-server.mjs');

async function startSite(port) {
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/offline.html`);
      if (response.ok) return child;
    } catch { /* not listening yet */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill();
  throw new Error(`the test site did not start on port ${port}`);
}

async function stopSite(child) {
  await new Promise((resolve) => { child.once('exit', resolve); child.kill(); });
}

test('a page opened before opens again with no connection; one never opened says so', async ({ page, context }, testInfo) => {
  test.setTimeout(60000);
  const port = 8990 + testInfo.parallelIndex;
  const site = `http://127.0.0.1:${port}`;
  let server = await startSite(port);
  try {
    // Nothing leaves this machine: the real sign-in service is never reached.
    await context.route(/supabase\.co|youtube\.com|sefaria\.org|jsdelivr\.net/, (route) => route.abort());
    await preparePage(page, { user: null });
    await page.goto(`${site}/index.html`);
    await controlled(page);
    // Once more now that the worker is in charge, so it keeps the page and its files.
    await page.reload();
    await expect(page).toHaveTitle(/DafSync/);
    await page.waitForFunction(async () => {
      const pages = await caches.open('dafsync-pages-v1');
      const files = await caches.open('dafsync-files-v1');
      return (await pages.keys()).some((request) => new URL(request.url).pathname === '/index.html')
        && (await files.keys()).some((request) => new URL(request.url).pathname === '/auth.js');
    }, null, { timeout: 15000 });

    await stopSite(server);
    server = null;
    await page.reload();
    await expect(page).toHaveTitle(/DafSync — Daf Yomi Shiurim/);
    await expect(page.locator('h1')).toHaveText('Today’s Daf');
    // Its own scripts ran from the saved copies: the page is laid out, not bare HTML.
    expect(await page.evaluate(() => typeof window.DafSyncAuth)).toBe('object');

    // The same page under another query is the same page.
    await page.goto(`${site}/index.html?maggid=bornstein`);
    await expect(page).toHaveTitle(/DafSync — Daf Yomi Shiurim/);

    // A page never opened on this device: the offline page, not the browser's error.
    await page.goto(`${site}/kuntras/index.html`);
    await expect(page).toHaveTitle('DafSync — No connection');
    await expect(page.locator('h1')).toHaveText('No connection');
    await expect(page.locator('a[href="/"]')).toBeVisible();

    // The connection is back: the page asked for loads.
    server = await startSite(port);
    await page.goto(`${site}/kuntras/index.html`);
    await expect(page).toHaveTitle(/Kuntras/);
  } finally {
    if (server) await stopSite(server);
  }
});

test('the browser is told the site is an app: manifest, icons, colour', async ({ page, request }) => {
  await preparePage(page, { user: null });
  await page.goto('/index.html');
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toBe('/manifest.webmanifest');
  const response = await request.get(href);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('application/manifest+json');
  const manifest = await response.json();
  expect(manifest.display).toBe('standalone');
  for (const icon of manifest.icons) {
    const picture = await request.get(icon.src);
    expect(picture.status(), icon.src).toBe(200);
  }
  expect((await request.get('/sw.js')).status()).toBe(200);
  expect((await request.get('/offline.html')).status()).toBe(200);
});

test.describe('the Install bar on the home page', () => {
  async function offerInstall(page) {
    return page.evaluate(() => {
      const event = new Event('beforeinstallprompt', { cancelable: true });
      window.__prompted = 0;
      event.prompt = () => { window.__prompted += 1; };
      event.userChoice = Promise.resolve({ outcome: 'accepted' });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    });
  }

  test('appears when the browser says the site can be installed, and opens its dialog', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/index.html');
    await expect(page.locator('#installBar')).toHaveCount(0);
    expect(await offerInstall(page)).toBe(true);
    await expect(page.locator('#installBar')).toBeVisible();
    await expect(page.locator('#installBar')).toContainText('Add DafSync to your home screen.');
    // It sits clear of the phone's bottom bar and inside the screen.
    const box = await page.locator('#installBar').boundingBox();
    const viewport = page.viewportSize();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    const nav = page.locator('.mobile-nav');
    if (await nav.isVisible()) {
      const navBox = await nav.boundingBox();
      expect(box.y + box.height).toBeLessThanOrEqual(navBox.y);
    }
    await page.click('#installBarGo');
    expect(await page.evaluate(() => window.__prompted)).toBe(1);
    await expect(page.locator('#installBar')).toHaveCount(0);
  });

  test('"not now" is remembered', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/index.html');
    await offerInstall(page);
    await page.click('#installBarDismiss');
    await expect(page.locator('#installBar')).toHaveCount(0);
    await page.reload();
    await offerInstall(page);
    await expect(page.locator('#installBar')).toHaveCount(0);
  });

  test('is not offered on other pages', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/chaburah/index.html');
    await offerInstall(page);
    await expect(page.locator('#installBar')).toHaveCount(0);
  });
});
