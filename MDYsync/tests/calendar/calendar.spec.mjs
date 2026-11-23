import { test, expect } from '@playwright/test';
import { preparePage } from '../support/harness.mjs';
import { dafYomiOfDay, localDayNumber } from '../../shared/daf-yomi.mjs';

// The Daf Yomi calendar's design preview (calendar/): a month laid out as a
// wall calendar, the daf of each day from the real schedule, and a day that
// opens beside the month (on a phone, as a sheet). Progress is sample data.

async function open(page) {
  await preparePage(page);
  await page.goto('/calendar/');
  await expect(page.locator('.cal-cell').first()).toBeVisible();
}

test.describe('Daf Yomi calendar (design preview)', () => {
  test('a month as a wall calendar: seven days across, today marked with its daf', async ({ page }) => {
    await open(page);
    await expect(page.locator('#calWeekdays > span')).toHaveCount(7);
    const cells = await page.locator('.cal-cell').count();
    expect(cells % 7).toBe(0);
    expect(cells).toBeGreaterThanOrEqual(28);
    // Whole weeks, Sunday first: the columns line up under the weekday names.
    const columns = await page.evaluate(() => {
      const lefts = [...document.querySelectorAll('.cal-cell')].slice(0, 14).map((cell) => Math.round(cell.getBoundingClientRect().left));
      return { week: new Set(lefts.slice(0, 7)).size, same: lefts.slice(0, 7).every((left, i) => left === lefts[i + 7]) };
    });
    expect(columns).toEqual({ week: 7, same: true });
    // Today's square shows the daf the schedule gives for today.
    const today = dafYomiOfDay(await page.evaluate(() => {
      const now = new Date();
      return Math.round(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86400000);
    }));
    const cell = page.locator('.cal-cell.is-today');
    await expect(cell).toHaveCount(1);
    await expect(cell.locator('.cal-num')).toHaveText(String(today.daf));
    await expect(cell.locator('.cal-mas-long')).toHaveText(today.masechta.display);
    expect(localDayNumber()).toBeGreaterThan(0);
    // Nothing runs off the side of the screen.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  });

  test('a day opens with its daf; the month turns; a signed-out visitor sees the plain calendar', async ({ page }) => {
    await open(page);
    const yesterday = page.locator('.cal-cell.is-gap').first();
    await yesterday.click();
    const panel = page.locator('#calDay');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.cal-day-title')).toContainText(await yesterday.locator('.cal-num').innerText());
    // The agreed rule's "almost" state: a finished shiur, a few words outstanding.
    await expect(panel.locator('.cal-state strong')).toContainText('words still to hear');

    const title = await page.locator('#calTitle').innerText();
    await page.locator('#calNext').click();
    await expect(page.locator('#calTitle')).not.toHaveText(title);
    await page.locator('#calToday').click();
    await expect(page.locator('#calTitle')).toHaveText(title);
    await expect(page.locator('.cal-cell.is-today')).toHaveCount(1);

    // Signed out: the schedule alone, no progress on any day.
    await page.evaluate(() => document.querySelector('[data-preview="out"]').click());
    await expect(page.locator('.cal-cell .cal-ring')).toHaveCount(0);
    await expect(page.locator('#calSummary')).toContainText('Sign in');
  });
});
