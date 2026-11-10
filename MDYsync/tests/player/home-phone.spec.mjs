import { test, expect } from '@playwright/test';
import { preparePage, failOnPageError } from '../support/harness.mjs';

// The phone home page, laid out like a video app's feed: a slim top bar
// (search behind an icon, a light/dark switch, the account), one row of
// chips, then full-width cards — today's daf first, the Continue learning
// row, then everything newest first, a page at a time. Desktop keeps its
// own layout. The harness's Daf Yomi calendar says today is Chullin 89.

const vid = (n) => `VID${String(n).padStart(8, '0')}`;
const CATALOG = {
  generatedAt: '2026-11-01T00:00:00Z',
  tractates: {
    // 40 dapim of Bekhorot, so the feed has more than one page.
    Bekhorot: Array.from({ length: 40 }, (_, i) => ({
      daf: i + 2,
      regularEn: { videoId: vid(i + 2), label: `Bechoros ${i + 2}`, amud: 'a' },
    })),
    Chullin: [
      {
        daf: 89,
        regularEn: { videoId: 'TODAYen0001', label: 'Chullin 89 today', amud: 'a' },
        regularHe: { videoId: 'TODAYhe0001', label: 'חולין פט', amud: 'a' },
      },
      { daf: 88, chazarahEn: { videoId: 'CHAZ0000088', label: 'Chazarah Chullin 88', amud: 'a' } },
    ],
  },
  maggidim: {
    bornstein: {
      tractates: { Bekhorot: [{ daf: 22, regularEn: { videoId: 'SRULY000022', label: 'Bechoros 22 (Lakewood)', amud: 'a' } }] },
    },
  },
};

const HISTORY = [
  { key: 'ref=Bekhorot+10a', url: '/player/?ref=Bekhorot+10a', ref: 'Bekhorot 10a', videoId: vid(10), time: 600, duration: 2400, updatedAt: 2 },
  { key: 'ref=Bekhorot+3a', url: '/player/?ref=Bekhorot+3a', ref: 'Bekhorot 3a', videoId: vid(3), time: 2395, duration: 2400, updatedAt: 1 },
];

async function open(page, { history = null, theme = null, user = null } = {}) {
  const errors = failOnPageError(page, []);
  await preparePage(page, { user });
  await page.addInitScript(({ history, theme }) => {
    if (history) localStorage.setItem('dafsync.watchHistory', JSON.stringify(history));
    if (theme) localStorage.setItem('dafsync.theme', theme);
  }, { history, theme });
  await page.route('**/api/get-catalog', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CATALOG) }));
  await page.route('**/api/get-results-file?*', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not found."}' }));
  await page.route('https://i.ytimg.com/**', (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"/>' }));
  await page.goto('/index.html');
  await expect(page.locator('#card-grid .shiur-card').first()).toBeVisible();
  return errors;
}

const cards = (page) => page.locator('#card-grid .shiur-card');

// A card goes straight to its video; the player is stubbed so the address
// the card opened can be read.
async function followCard(page, card) {
  let opened = null;
  await page.route('**/player/**', (route) => {
    opened = route.request().url();
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Player</title>' });
  });
  await card.click();
  await expect.poll(() => opened).not.toBeNull();
  return new URL(opened);
}
const chip = (page, id) => page.locator(`#feedChips [data-chip="${id}"]`);

test.describe('Phone home — the feed', () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== 'mobile', 'phone layout'));

  test('the chips are All, Today’s Daf, each maggid, Chazarah, Hebrew and Continue watching', async ({ page }) => {
    const errors = await open(page);
    await expect(page.locator('#feedChips [data-chip]')).toHaveText([
      'All', 'Today’s Daf', 'R’ Eli Stefansky', 'R’ Sruly Bornstein', 'Chazarah', 'Hebrew', 'Continue watching',
    ]);
    await expect(chip(page, 'all')).toHaveClass(/active/);
    // What the chips replace is gone from the phone.
    await expect(page.locator('#filters')).toBeHidden();
    await expect(page.locator('#today-section')).toBeHidden();
    await expect(page.locator('#subfilters')).toBeHidden();
    expect(errors.filter((e) => !/404|Failed to load resource/.test(e))).toEqual([]);
  });

  test('today’s daf comes first, then everything newest first, a page at a time', async ({ page }) => {
    await open(page);
    await expect(cards(page)).toHaveCount(12);
    const first = await cards(page).evaluateAll((nodes) => nodes.slice(0, 4).map((n) => n.querySelector('strong').textContent));
    expect(first.slice(0, 2)).toEqual(['Chullin 89 today', 'חולין פט']);
    await expect(cards(page).nth(0).locator('.thumb-badge')).toHaveText('Today');
    // Then the newest: Bekhorot (after Chullin in the cycle) 41, 40...
    expect(first.slice(2)).toEqual(['Bechoros 41', 'Bechoros 40']);
    // Each card says whose shiur it is, which daf, and the language.
    await expect(cards(page).nth(0).locator('.card-meta-phone')).toHaveText('R’ Eli Stefansky · Chullin 89 · English');
    await expect(cards(page).nth(0).locator('.card-avatar')).toHaveText('ES');
    // Scrolling down adds the rest.
    for (let i = 0; i < 6; i += 1) {
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(150);
    }
    await expect(cards(page)).toHaveCount(44);
  });

  test('the Continue learning row sits after today’s daf and resumes where the reader stopped', async ({ page }) => {
    await open(page, { history: HISTORY });
    const shelf = page.locator('#continueShelf');
    await expect(shelf).toBeVisible();
    // After the two cards of today's daf, before the rest.
    const before = await shelf.evaluate((node) => {
      let count = 0;
      for (let el = node.previousElementSibling; el; el = el.previousElementSibling) if (el.matches('.shiur-card')) count += 1;
      return count;
    });
    expect(before).toBe(2);
    const links = shelf.locator('.continue-card');
    await expect(links).toHaveCount(2);
    await expect(links.first().locator('strong')).toHaveText('Bechoros 10');
    // Opens in Split (the default viewing mode) at the time reached.
    const href = new URL(await links.first().getAttribute('href'), 'http://x');
    expect(href.pathname).toBe('/player/');
    expect(href.searchParams.get('ref')).toBe('Bekhorot 10a');
    expect(href.searchParams.get('mode')).toBe('split');
    expect(href.searchParams.get('t')).toBe('600');
    await expect(links.first().locator('.continue-progress span')).toHaveAttribute('style', 'width:25.0%');
    // A shiur watched to the end starts again from the beginning.
    expect(new URL(await links.nth(1).getAttribute('href'), 'http://x').searchParams.has('t')).toBe(false);
  });

  test('with no watch history there is no Continue learning row', async ({ page }) => {
    await open(page);
    await expect(page.locator('#continueShelf')).toHaveCount(0);
  });

  test('each chip narrows the feed, and only one is on at a time', async ({ page }) => {
    await open(page, { history: HISTORY });
    await chip(page, 'today').click();
    await expect(chip(page, 'today')).toHaveClass(/active/);
    await expect(chip(page, 'all')).not.toHaveClass(/active/);
    await expect(cards(page)).toHaveCount(2);
    await expect(page.locator('#continueShelf')).toHaveCount(0);

    await chip(page, 'maggid:bornstein').click();
    await expect(cards(page)).toHaveCount(1);
    await expect(cards(page).first()).toContainText('Bechoros 22 (Lakewood)');
    await expect(page.locator('#maggidBack')).toBeHidden();

    await chip(page, 'chazarah').click();
    await expect(cards(page)).toHaveCount(1);
    await expect(cards(page).first()).toContainText('Chazarah Chullin 88');

    await chip(page, 'hebrew').click();
    await expect(cards(page)).toHaveCount(1);
    await expect(cards(page).first()).toContainText('חולין פט');

    await chip(page, 'continue').click();
    await expect(page.locator('#card-grid .continue-card.is-wide')).toHaveCount(2);
    await expect(cards(page)).toHaveCount(0);

    await chip(page, 'all').click();
    await expect(cards(page)).toHaveCount(12);
  });

  test('Continue watching with nothing watched says so', async ({ page }) => {
    await open(page);
    await chip(page, 'continue').click();
    await expect(page.locator('#empty-title')).toHaveText('Nothing to continue yet');
  });

  test('the bottom Home tab goes back to All', async ({ page }) => {
    await open(page);
    await chip(page, 'hebrew').click();
    await expect(cards(page)).toHaveCount(1);
    await page.locator('.mobile-nav [data-nav="Home"]').click();
    await expect(chip(page, 'all')).toHaveClass(/active/);
    await expect(cards(page)).toHaveCount(12);
  });

  test('the filters button opens the masechta and sort choices', async ({ page }) => {
    await open(page);
    await page.locator('#chipFilters').click();
    await expect(page.locator('#subfilters')).toBeVisible();
    await page.locator('#tractate-filter').selectOption('Chullin');
    await expect(cards(page)).toHaveCount(3);
    await page.locator('#chipFilters').click();
    await expect(page.locator('#subfilters')).toBeHidden();
  });

  test('search sits behind the search icon', async ({ page }) => {
    await open(page);
    await expect(page.locator('#search')).toBeHidden();
    await page.locator('#searchToggle').click();
    await expect(page.locator('#search')).toBeFocused();
    await expect(page.locator('.mobile-brand')).toBeHidden();
    await page.keyboard.type('Bekhorot 4');
    // Bekhorot 4 and 40-41.
    await expect(cards(page)).toHaveCount(3);
    await expect(page.locator('#section-title')).toBeVisible();
    await page.locator('#searchClose').click();
    await expect(page.locator('#search')).toBeHidden();
    await expect(page.locator('.mobile-brand')).toBeVisible();
    await expect(cards(page)).toHaveCount(12);
  });

  test('a card goes straight to its own video in Split, with no version window', async ({ page }) => {
    await open(page);
    // The Hebrew recording of today's daf: that exact version, not the default English one.
    const url = await followCard(page, cards(page).nth(1));
    expect(url.pathname).toBe('/player/');
    expect(url.searchParams.get('ref')).toBe('Chullin 89a');
    expect(url.searchParams.get('language')).toBe('hebrew');
    expect(url.searchParams.get('mode')).toBe('split');
  });
});

test.describe('Phone home — light and dark', () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== 'mobile', 'phone layout'));

  const bodyColor = (page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  test('the switch turns dark mode on and off, and is remembered', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await open(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    const light = await bodyColor(page);
    await page.locator('#themeToggle').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('#themeToggle')).toHaveAttribute('aria-label', 'Light mode');
    expect(await bodyColor(page)).not.toBe(light);
    expect(await page.evaluate(() => localStorage.getItem('dafsync.theme'))).toBe('dark');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.locator('#themeToggle').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(await bodyColor(page)).toBe(light);
  });

  test('with no choice made it follows the phone’s own setting', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await open(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });
});

test.describe('Desktop home is unchanged', () => {
  test.beforeEach(({}, info) => test.skip(info.project.name === 'mobile', 'desktop layout'));

  test('no chips, top-bar icons or feed extras; the filters and hero stay', async ({ page }) => {
    await open(page, { history: HISTORY });
    await expect(page.locator('#feedChips')).toBeHidden();
    await expect(page.locator('#searchToggle')).toBeHidden();
    await expect(page.locator('#themeToggle')).toBeHidden();
    await expect(page.locator('#search')).toBeVisible();
    await expect(page.locator('#filters')).toBeVisible();
    await expect(page.locator('#subfilters')).toBeVisible();
    await expect(page.locator('#continueShelf')).toHaveCount(0);
    await expect(cards(page)).toHaveCount(44);
    await expect(cards(page).first().locator('.card-avatar')).toBeHidden();
    await expect(cards(page).first().locator('.thumb-badge')).toBeHidden();
  });

  test('a card goes straight to its video; the Today’s Daf banner still offers the versions', async ({ page }) => {
    await open(page);
    await expect(page.locator('#hero-card')).toBeVisible();
    await page.locator('#hero-card').click();
    await expect(page.locator('#modal')).toBeVisible();
    await expect(page.locator('#modal-variant-toggle button')).toHaveText(['English', 'Hebrew']);
    await page.locator('#modal-close').click();
    await expect(page.locator('#modal')).toBeHidden();
    const url = await followCard(page, cards(page).filter({ hasText: 'Chazarah Chullin 88' }));
    expect(url.searchParams.get('ref')).toBe('Chullin 88a');
    expect(url.searchParams.get('variant')).toBe('chazarah');
    await expect(page.locator('#modal')).toBeHidden();
  });

  test('dark mode does not change the desktop page', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await open(page);
    const color = await page.evaluate(() => getComputedStyle(document.querySelector('.shiur-card')).backgroundColor);
    expect(color).toBe('rgb(255, 255, 255)');
  });
});
