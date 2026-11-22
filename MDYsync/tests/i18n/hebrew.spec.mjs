import { test, expect } from '@playwright/test';
import { preparePage } from '../support/harness.mjs';

// i18n.js: the language a page opens in, and the Hebrew written over the
// page's English. English must be exactly as it was: no direction set other
// than left to right, no Hebrew files fetched.

test.describe('Language', () => {
  test('English by default: left to right, and nothing Hebrew is fetched', async ({ page }) => {
    const asked = [];
    page.on('request', (request) => asked.push(new URL(request.url()).pathname));
    await preparePage(page, { user: null });
    await page.goto('/index.html');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.locator('html')).not.toHaveClass(/i18n-loading/);
    expect(asked.filter((p) => /i18n-he|rtl\.css/.test(p))).toEqual([]);
    await expect(page.getByText('Sign in').first()).toBeAttached();
  });

  test('a browser set to Hebrew still opens in English until it is turned on', async ({ browser }) => {
    const context = await browser.newContext({ locale: 'he-IL' });
    const page = await context.newPage();
    await preparePage(page, { user: null });
    await page.goto('/index.html');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await context.close();
  });

  test('?lang=he: right to left, Hebrew words, and remembered; ?lang=en goes back', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/index.html?lang=he');
    const html = page.locator('html');
    await expect(html).toHaveAttribute('lang', 'he');
    await expect(html).toHaveAttribute('dir', 'rtl');
    await expect(html).toHaveClass(/lang-he/);
    await expect(html).not.toHaveClass(/i18n-loading/);
    await expect(page.locator('body')).toBeVisible();
    // Text, an attribute, and text a script writes after the page has opened.
    expect(await page.evaluate(() => {
      const box = document.createElement('div');
      box.innerHTML = '<button aria-label="Clear search">Sign in</button><small>12 dapim</small>'
        + '<p lang="he">Sign in</p><p translate="no">Sign in</p><span>Bechoros has 12 dapim</span>';
      document.body.appendChild(box);
      return new Promise((resolve) => setTimeout(() => resolve({
        button: box.querySelector('button').textContent,
        label: box.querySelector('button').getAttribute('aria-label'),
        count: box.querySelector('small').textContent,
        gemara: box.querySelector('[lang="he"]').textContent,
        kept: box.querySelector('[translate="no"]').textContent,
        sentence: box.querySelector('span').textContent,
      }), 50));
    })).toEqual({
      button: 'התחברות', label: 'ניקוי החיפוש', count: '12 דפים',
      gemara: 'Sign in', kept: 'Sign in', sentence: 'Bechoros has 12 dapim',
    });
    // A script changing a text after the fact is followed too.
    expect(await page.evaluate(() => {
      const el = document.createElement('b');
      el.textContent = 'x';
      document.body.appendChild(el);
      el.firstChild.nodeValue = 'Sign out';
      return new Promise((resolve) => setTimeout(() => resolve(el.textContent), 50));
    })).toBe('התנתקות');
    expect(await page.evaluate(() => [window.DafSyncI18n.t('Sign in'), window.DafSyncI18n.t('Not in the dictionary')]))
      .toEqual(['התחברות', 'Not in the dictionary']);

    // The name of the site is never translated, though "Daf" and "Sync" are words of their own.
    await expect(page.locator('.brand-name').first()).toHaveText('DafSync');

    // The choice is kept for the next page.
    await page.goto('/index.html');
    await expect(html).toHaveAttribute('dir', 'rtl');
    await page.goto('/index.html?lang=en');
    await expect(html).toHaveAttribute('dir', 'ltr');
    await page.goto('/index.html');
    await expect(html).toHaveAttribute('lang', 'en');
  });

  test('the page is shown even when the Hebrew files never arrive', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.route(/\/(i18n-he\.js|rtl\.css)/, () => { /* never answered */ });
    await page.goto('/index.html?lang=he', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('html')).not.toHaveClass(/i18n-loading/, { timeout: 5000 });
    await expect(page.locator('body')).toBeVisible();
  });

  test('every page people open loads the language first', async ({ request }) => {
    for (const path of ['/index.html', '/player/index.html', '/browse/index.html', '/chaburah/index.html',
      '/chaburah/thread/index.html', '/notes/index.html', '/profile/index.html', '/kuntras/index.html',
      '/live/index.html', '/watch/index.html']) {
      const html = await (await request.get(path)).text();
      const head = html.slice(0, html.indexOf('</head>'));
      const first = head.indexOf('<script');
      expect(head.slice(first, first + 40), path).toContain('src="/i18n.js');
    }
  });
});
