import { test, expect } from '@playwright/test';
import { preparePage, failOnPageError } from '../support/harness.mjs';

// The home page lists every followed maggid's videos side by side, and the
// Maggidei Shiurim tab has a page for each maggid (R' Eli Stefansky, and
// R' Sruly Bernstein of Lakewood Daf Yomi).

const CATALOG = {
  generatedAt: '2026-10-10T00:00:00Z',
  tractates: {
    Bekhorot: [
      { daf: 2, regularEn: { videoId: 'CNu3Ba5XCao', label: "Daf Yomi Bechoros Daf 2 by R' Eli Stefansky", amud: 'a' } },
      { daf: 3, regularEn: { videoId: 'MDYMDYMDY03', label: "Daf Yomi Bechoros Daf 3 by R' Eli Stefansky", amud: 'a' } },
    ],
  },
  maggidim: {
    bernstein: {
      tractates: {
        Bekhorot: [
          { daf: 2, regularEn: { videoId: 'Zsy7oDUP6Pw', label: 'Bechoros 2', amud: 'a', testShiur: true } },
          { daf: 22, regularEn: { videoId: 'g7VSmqB8Xlk', label: 'Bechoros 22', amud: 'a' } },
        ],
        Chullin: [{ daf: 100, regularEn: { videoId: 'chulin10001', label: 'Chulin 100', amud: 'a' } }],
      },
    },
  },
};
const OTHER_SHIURIM = {
  maggid: 'bernstein',
  videos: [
    { videoId: 'g7VSmqB8Xlk', title: 'Bechoros 22', tractate: 'Bekhorot', daf: 22 },
    { videoId: 'FvMHzatB_9Y', title: 'Not All of Our Sages Were Created Equally', published: '2026-09-28T10:00:00+00:00' },
    { videoId: 'ScTAD7eUnO8', title: 'Rebbi Yehoshua the Shadlan Part 2' },
  ],
};

async function open(page, { query = '', catalog = CATALOG } = {}) {
  const errors = failOnPageError(page, []);
  await preparePage(page);
  await page.route('**/api/get-catalog', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(catalog) }));
  await page.route('**/api/get-results-file?*', (route) => {
    const path = new URL(route.request().url()).searchParams.get('path');
    if (path === 'maggidim/bernstein.json') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(OTHER_SHIURIM) });
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not found."}' });
  });
  await page.goto(`/index.html${query}`);
  return errors;
}

const cards = (page) => page.locator('#card-grid .shiur-card');

test.describe('Home page — every maggid side by side', () => {
  test('a daf both maggidim have shows two cards, each saying whose it is', async ({ page }) => {
    const errors = await open(page);
    await expect(cards(page)).toHaveCount(5);
    const text = await cards(page).allInnerTexts();
    const forDaf2 = text.filter((t) => /Bekhorot 2 /.test(t));
    expect(forDaf2).toHaveLength(2);
    expect(forDaf2.some((t) => t.includes('R’ Sruly Bernstein'))).toBe(true);
    expect(forDaf2.some((t) => t.includes("R' Eli Stefansky"))).toBe(true);
    // The default maggid's card is as it always was: no maggid tag on it.
    expect(forDaf2.find((t) => t.includes("R' Eli Stefansky"))).not.toContain('Sruly');
    expect(errors.filter((e) => !/404|Failed to load resource/.test(e))).toEqual([]);
  });

  test('the section counts dapim, not videos, across both', async ({ page }) => {
    await open(page);
    await expect(page.locator('#section-eyebrow')).toHaveText('4 DAPIM AVAILABLE');
  });

  test('the masechta filter offers a tractate only one maggid has', async ({ page }) => {
    await open(page);
    await expect(page.locator('#tractate-filter option')).toHaveText(['All', 'Chullin', 'Bekhorot']);
    await page.locator('#tractate-filter').selectOption('Chullin');
    await expect(cards(page)).toHaveCount(1);
    await expect(cards(page).first()).toContainText('Chulin 100');
  });

  test('a card opens the player on that maggid\'s recording', async ({ page }) => {
    await open(page);
    await cards(page).filter({ hasText: 'Bechoros 22' }).click();
    await expect(page.locator('#modal-teacher')).toHaveText('R’ Sruly Bernstein · Bekhorot 22 · English');
    const href = await page.locator('#modal-watch-link').getAttribute('href');
    const params = new URL(href, 'http://x').searchParams;
    expect(params.get('ref')).toBe('Bekhorot 22a');
    expect(params.get('maggid')).toBe('bernstein');
  });

  test('the default maggid\'s link carries no maggid, as before', async ({ page }) => {
    await open(page);
    await cards(page).filter({ hasText: 'Stefansky' }).first().click();
    const href = await page.locator('#modal-watch-link').getAttribute('href');
    expect(new URL(href, 'http://x').searchParams.has('maggid')).toBe(false);
  });
});

test.describe('Maggidei Shiurim tab', () => {
  test('lists R’ Eli Stefansky and R’ Sruly Bernstein', async ({ page }) => {
    await open(page, { query: '?nav=maggidei' });
    const names = page.locator('#maggidCards .maggid-card strong');
    await expect(names).toHaveText(['R’ Eli Stefansky', 'R’ Sruly Bernstein']);
    await expect(page.locator('#maggidCards .maggid-card').nth(1)).toContainText('Lakewood Daf Yomi');
  });

  test('his page shows only his dapim, the rest of his shiurim, and a way back', async ({ page }) => {
    await open(page, { query: '?nav=maggidei' });
    await page.locator('#maggidCards [data-maggid="bernstein"]').click();
    await expect(page.locator('#section-title')).toHaveText('R’ Sruly Bernstein');
    await expect(page.locator('#section-eyebrow')).toHaveText('3 DAPIM AVAILABLE');
    await expect(cards(page)).toHaveCount(3);
    for (const text of await cards(page).allInnerTexts()) expect(text).toContain('R’ Sruly Bernstein');
    // What his channel posts that isn't a daf: listed under the dapim, linking to YouTube.
    await expect(page.locator('#maggidOtherTitle')).toHaveText('More shiurim from R’ Sruly Bernstein');
    const others = page.locator('#maggidOtherList a');
    await expect(others).toHaveCount(2);
    await expect(others.first()).toContainText('Not All of Our Sages Were Created Equally');
    await expect(others.first()).toHaveAttribute('href', 'https://www.youtube.com/watch?v=FvMHzatB_9Y');
    await expect(page.locator('#maggidOtherList')).not.toContainText('Bechoros 22'); // already a card
    // Back to the list of maggidim.
    await page.locator('#maggidBack').click();
    await expect(page.locator('#maggidCards')).toBeVisible();
    await expect(page.locator('#maggidOther')).toBeHidden();
  });

  test('R’ Eli Stefansky\'s page shows only his, and the Home tab shows everyone\'s again', async ({ page }) => {
    await open(page, { query: '?nav=maggidei' });
    await page.locator('#maggidCards [data-maggid="stefansky"]').click();
    await expect(cards(page)).toHaveCount(2);
    await expect(page.locator('#maggidOther')).toBeHidden();
    await page.locator('[data-nav="Home"]:visible').first().click();
    await expect(cards(page)).toHaveCount(5);
    await expect(page.locator('#maggidBack')).toBeHidden();
  });
});
