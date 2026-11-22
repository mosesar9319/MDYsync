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

  test('a browser set to Hebrew opens in Hebrew; one set to English, or a reader who chose English, does not', async ({ browser }) => {
    const hebrew = await browser.newContext({ locale: 'he-IL' });
    const page = await hebrew.newPage();
    await preparePage(page, { user: null });
    await page.goto('/index.html');
    await expect(page.locator('html')).toHaveAttribute('lang', 'he');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    // The reader's own choice wins over the browser's language.
    await page.goto('/index.html?lang=en');
    await page.goto('/index.html');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await hebrew.close();
    const english = await browser.newContext({ locale: 'en-US' });
    const other = await english.newPage();
    await preparePage(other, { user: null });
    await other.goto('/index.html');
    await expect(other.locator('html')).toHaveAttribute('lang', 'en');
    await english.close();
  });

  test('the switch on the home page goes to the other language and stays there', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/index.html');
    const toggle = page.locator('#langToggle');
    await expect(toggle).toHaveText('עב');
    await toggle.click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'he');
    await expect(page.locator('#langToggle')).toHaveText('EN');
    await expect(page.locator('#today-eyebrow')).toContainText('•');
    expect(await page.locator('#today-eyebrow').textContent()).toMatch(/[\u0590-\u05FF]/);
    await page.locator('#langToggle').click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  });

  test('a page script that keeps writing its English back cannot freeze the page', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/index.html?lang=he');
    const result = await page.evaluate(() => new Promise((resolve) => {
      const el = document.createElement('span');
      document.body.appendChild(el);
      // Writes "Sign in" again whenever it says anything else.
      new MutationObserver(() => { if (el.textContent !== 'Sign in') el.textContent = 'Sign in'; })
        .observe(el, { childList: true, characterData: true, subtree: true });
      el.textContent = 'Sign in';
      setTimeout(() => resolve(el.textContent), 300);
    }));
    expect(['Sign in', 'התחברות']).toContain(result);
    await expect(page.locator('body')).toBeVisible();
  });

  test('a daf is named in Hebrew, alone or inside a sentence; dates are the Hebrew calendar\'s', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/index.html?lang=he');
    expect(await page.evaluate(() => {
      const I = window.DafSyncI18n;
      return [I.t('Bekhorot 58a'), I.t('Eruchin 5'), I.t('Loading Chullin 89b…'), I.refName('Bekhorot 58b (Chazarah Daf)'), I.gematria(12), I.gematria(5787)];
    })).toEqual(['בכורות נח ע״א', 'ערכין ה', 'טוען את חולין פט ע״ב…', 'בכורות נח ע״ב (חזרה)', 'י״ב', 'תשפ״ז']);
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

  test('the page is shown, in English words, when the Hebrew files cannot be fetched', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.route(/\/(i18n-he\.js|rtl\.css)/, (route) => route.abort());
    await page.goto('/index.html?lang=he', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('html')).not.toHaveClass(/i18n-loading/, { timeout: 5000 });
    await expect(page.locator('body')).toBeVisible();
  });

  test('installed in Hebrew, the app is the same app with Hebrew shortcuts, opening on /he/', async ({ page, request }) => {
    await preparePage(page, { user: null });
    await page.goto('/index.html?lang=he');
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest-he.webmanifest');
    const english = JSON.parse(await (await request.get('/manifest.webmanifest')).text());
    const hebrew = JSON.parse(await (await request.get('/manifest-he.webmanifest')).text());
    expect(hebrew.id).toBe(english.id);
    expect(hebrew.icons).toEqual(english.icons);
    expect(hebrew.name).toBe('DafSync');
    expect([hebrew.lang, hebrew.dir, hebrew.start_url]).toEqual(['he', 'rtl', '/he/']);
    expect(hebrew.shortcuts.map((s) => s.name)).toEqual(['הדף היומי', 'הדף האינטראקטיבי', 'החבורה בענן']);
    expect(hebrew.shortcuts.length).toBe(english.shortcuts.length);
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
