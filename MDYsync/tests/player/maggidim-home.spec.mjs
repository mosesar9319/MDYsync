import { test, expect } from '@playwright/test';
import { parseRoute, playerUrl } from '../../netlify/functions/seo-pages.mjs';
import { preparePage, failOnPageError } from '../support/harness.mjs';

// The home page lists every followed maggid's videos side by side, and the
// Maggidei Shiurim tab has a page for each maggid (R' Eli Stefansky, and
// R' Sruly Bornstein of Lakewood Daf Yomi).

const CATALOG = {
  generatedAt: '2026-10-10T00:00:00Z',
  tractates: {
    Bekhorot: [
      { daf: 2, regularEn: { videoId: 'CNu3Ba5XCao', label: "Daf Yomi Bechoros Daf 2 by R' Eli Stefansky", amud: 'a' } },
      { daf: 3, regularEn: { videoId: 'MDYMDYMDY03', label: "Daf Yomi Bechoros Daf 3 by R' Eli Stefansky", amud: 'a' } },
    ],
  },
  maggidim: {
    bornstein: {
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
  maggid: 'bornstein',
  videos: [
    { videoId: 'g7VSmqB8Xlk', title: 'Bechoros 22', tractate: 'Bekhorot', daf: 22 },
    { videoId: 'FvMHzatB_9Y', title: 'Not All of Our Sages Were Created Equally', published: '2026-09-28T10:00:00+00:00' },
    { videoId: 'ScTAD7eUnO8', title: 'Rebbi Yehoshua the Shadlan Part 2' },
  ],
};

async function open(page, { query = '', catalog = CATALOG, ...options } = {}) {
  const errors = failOnPageError(page, []);
  await preparePage(page, options);
  await page.route('**/api/get-catalog', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(catalog) }));
  await page.route('**/api/get-results-file?*', (route) => {
    const path = new URL(route.request().url()).searchParams.get('path');
    if (path === 'maggidim/bornstein.json') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(OTHER_SHIURIM) });
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not found."}' });
  });
  await page.goto(`/index.html${query}`);
  return errors;
}

const cards = (page) => page.locator('#card-grid .shiur-card');

// A card goes straight to its video. The player itself is stubbed so the
// address the card opened can be read before the player tidies it up.
async function followCard(page, card) {
  // A card links to the shiur's own page (/chullin/100/stefansky/,
  // netlify/functions/seo-pages.mjs), which hands over to the player; a
  // livestream links to the player directly. Either way, the player address
  // it ends up on is what is checked.
  let opened = null;
  const done = { status: 200, contentType: 'text/html', body: '<!doctype html><title>Player</title>' };
  await page.route('**/player/**', (route) => {
    opened = route.request().url();
    return route.fulfill(done);
  });
  await page.route((url) => parseRoute(url.pathname)?.kind === 'shiur', (route) => {
    const url = new URL(route.request().url());
    const shiur = { ...parseRoute(url.pathname), amud: 'a' };
    opened = new URL(playerUrl(shiur), url.origin).href;
    return route.fulfill(done);
  });
  await card.click();
  await expect.poll(() => opened).not.toBeNull();
  return new URL(opened);
}

test.describe('Home page — every maggid side by side', () => {
  test('a Hebrew edit does not hide the English livestream of the same daf', async ({ page }) => {
    const catalog = {
      tractates: {
        Bekhorot: [
          {
            daf: 58,
            regularEn: { videoId: 'T70KGQVCsCw', label: 'Daf Yomi Bechoros Daf 58 by R’ Eli Stefansky (unedited)', amud: 'a', liveBroadcast: true },
            regularHe: { videoId: 'cTWsuqpiNUA', label: 'מרכז דף יומי - בכורות דף נח', amud: 'a' },
          },
        ],
      },
    };
    await open(page, { catalog });
    await expect(cards(page)).toHaveCount(2);
    const text = await cards(page).allInnerTexts();
    expect(text.some((t) => t.includes('T70') || t.includes('unedited') || t.includes('Bechoros Daf 58'))).toBe(true);
    expect(text.some((t) => t.includes('בכורות') || t.includes('Hebrew'))).toBe(true);
  });
  test('a daf both maggidim have shows two cards, each saying whose it is', async ({ page }) => {
    const errors = await open(page);
    await expect(cards(page)).toHaveCount(5);
    const text = await cards(page).allInnerTexts();
    const forDaf2 = text.filter((t) => /Bekhorot 2 /.test(t));
    expect(forDaf2).toHaveLength(2);
    expect(forDaf2.some((t) => t.includes('R’ Sruly Bornstein'))).toBe(true);
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
    // On a phone the filters sit behind the button at the end of the chips.
    if (await page.locator('#chipFilters').isVisible()) await page.locator('#chipFilters').click();
    await page.locator('#tractate-filter').selectOption('Chullin');
    await expect(cards(page)).toHaveCount(1);
    await expect(cards(page).first()).toContainText('Chulin 100');
  });

  test('a card opens the player on that maggid\'s recording', async ({ page }) => {
    await open(page);
    const params = (await followCard(page, cards(page).filter({ hasText: 'Bechoros 22' }))).searchParams;
    expect(params.get('ref')).toBe('Bekhorot 22a');
    expect(params.get('maggid')).toBe('bornstein');
  });

  test('the default maggid\'s link carries no maggid, as before', async ({ page }) => {
    await open(page);
    const url = await followCard(page, cards(page).filter({ hasText: 'Stefansky' }).first());
    expect(url.searchParams.has('maggid')).toBe(false);
  });
});

// A shiur opened from the home page starts in Split view, unless the reader
// chose another on their account page. The card links to the shiur's own page,
// which opens the player with ?mode=split; the player itself then puts the
// account's own choice first (app.js decideViewerMode), so the link no longer
// carries it.
test.describe('Home page — the viewing mode a shiur opens in', () => {
  const card = (page) => cards(page).filter({ hasText: 'Stefansky' }).first();
  const modeOf = async (page) => (await followCard(page, card(page))).searchParams.get('mode');
  test('Split view for everyone by default, signed in or not', async ({ page }) => {
    await open(page);
    expect(await modeOf(page)).toBe('split');
  });
  test('the reader\'s own choice is left to the player, not written into the link', async ({ page }) => {
    await open(page, { session: { user: { id: '11111111-1111-4111-8111-111111111111', email: 'r@example.com', user_metadata: { default_view_mode: 'video-on-daf' } }, access_token: 't' } });
    const href = await card(page).getAttribute('href');
    expect(href).toMatch(/^\/[a-z-]+\/\d+\/stefansky\/$/);
  });
});

test.describe('Maggidei Shiurim tab', () => {
  test('lists R’ Eli Stefansky and R’ Sruly Bornstein', async ({ page }) => {
    await open(page, { query: '?nav=maggidei' });
    const names = page.locator('#maggidCards .maggid-card strong');
    await expect(names).toHaveText(['R’ Eli Stefansky', 'R’ Sruly Bornstein']);
    await expect(page.locator('#maggidCards .maggid-card').nth(1)).toContainText('Lakewood Daf Yomi');
  });

  test('his page shows only his dapim, the rest of his shiurim, and a way back', async ({ page }) => {
    await open(page, { query: '?nav=maggidei' });
    await page.locator('#maggidCards [data-maggid="bornstein"]').click();
    await expect(page.locator('#section-title')).toHaveText('R’ Sruly Bornstein');
    await expect(page.locator('#section-eyebrow')).toHaveText('3 DAPIM AVAILABLE');
    await expect(cards(page)).toHaveCount(3);
    for (const text of await cards(page).allInnerTexts()) expect(text).toContain('R’ Sruly Bornstein');
    // What his channel posts that isn't a daf: listed under the dapim, linking to YouTube.
    await expect(page.locator('#maggidOtherTitle')).toHaveText('More shiurim from R’ Sruly Bornstein');
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
