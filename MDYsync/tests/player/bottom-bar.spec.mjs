import { test, expect } from '@playwright/test';
import { preparePage } from '../support/harness.mjs';

// The phone's bottom bar: five tabs with short names that fit side by side
// (Today's Daf is a chip at the top of the phone home page instead). The
// desktop sidebar keeps every tab with its full name.

const PHONE_TABS = ['Home', 'Daf', 'Chaburah', 'Maggidim', 'Scan'];
const FULL_NAMES = ['Home', 'Interactive Daf', 'Cloud Chaburah', 'Maggidei Shiurim', 'Daf Scan'];
const SIDEBAR = ['Home', 'Today’s Daf', 'Interactive Daf', 'Cloud Chaburah', 'Maggidei Shiurim', 'Daf Scan'];

for (const [page_, url] of [['home page', '/index.html'], ['Interactive Daf', '/browse/'], ['Cloud Chaburah', '/chaburah/']]) {
  test.describe(`Bottom bar — ${page_}`, () => {
    test('on a phone: five short tabs that fit, each named in full for screen readers', async ({ page }, info) => {
      test.skip(info.project.name !== 'mobile', 'phone layout');
      await preparePage(page, { user: null });
      for (const width of [412, 360]) {
        await page.setViewportSize({ width, height: 860 });
        await page.goto(url);
        const tabs = page.locator('.mobile-nav > a, .mobile-nav > button');
        await expect(tabs).toHaveText(PHONE_TABS);
        for (const [index, name] of FULL_NAMES.entries()) {
          await expect(tabs.nth(index)).toHaveAttribute('aria-label', name);
        }
        // Nothing hidden off the edge.
        const fits = await page.locator('.mobile-nav').evaluate((nav) => nav.scrollWidth <= nav.clientWidth);
        expect(fits).toBe(true);
      }
    });

    test('on a computer: the sidebar keeps every tab and its full name', async ({ page }, info) => {
      test.skip(info.project.name === 'mobile', 'desktop layout');
      await preparePage(page, { user: null });
      await page.goto(url);
      await expect(page.locator('.desktop-navigation .side-link span')).toHaveText(SIDEBAR);
      await expect(page.locator('.mobile-nav')).toBeHidden();
    });
  });
}
