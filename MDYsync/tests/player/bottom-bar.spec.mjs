import { test, expect } from '@playwright/test';
import { preparePage } from '../support/harness.mjs';

// The phone's bottom bar: five tabs, each with its full name -- two short
// lines where it needs them -- side by side without crowding (the calendar is a
// chip at the top of the phone home page instead). The desktop sidebar keeps
// every tab with its full name too.

const FULL_NAMES = ['Home', 'Interactive Daf', 'Cloud Chaburah', 'Maggidei Shiur', 'Daf Scan'];
const PHONE_TABS = FULL_NAMES;
const SIDEBAR = ['Home', 'Calendar', 'Interactive Daf', 'Cloud Chaburah', 'Maggidei Shiur', 'Daf Scan'];

for (const [page_, url] of [['home page', '/index.html'], ['Interactive Daf', '/browse/'], ['Cloud Chaburah', '/chaburah/']]) {
  test.describe(`Bottom bar — ${page_}`, () => {
    test('on a phone: five tabs with their full names, that fit and do not touch', async ({ page }, info) => {
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
        // No name runs into the next one, and none takes more than two lines.
        const labels = await page.locator('.mobile-nav > a > span, .mobile-nav > button > span').evaluateAll((spans) => spans.map((span) => {
          const r = span.getBoundingClientRect();
          return { left: r.left, right: r.right, lines: Math.round(r.height / parseFloat(getComputedStyle(span).lineHeight)) };
        }));
        for (let i = 1; i < labels.length; i += 1) expect(labels[i].left).toBeGreaterThanOrEqual(labels[i - 1].right + 4);
        for (const label of labels) expect(label.lines).toBeLessThanOrEqual(2);
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
