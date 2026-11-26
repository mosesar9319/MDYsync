import { test, expect } from '@playwright/test';
import { preparePage } from '../support/harness.mjs';
import { CYCLE_LENGTH, dafYomiOfDay, dayNumber } from '../../shared/daf-yomi.mjs';

// The Daf Yomi calendar (calendar/): a month laid out as a wall calendar, the
// daf of each day from the real schedule, and a day that opens beside the
// month (on a phone, as a sheet) with that daf's shiurim. It takes the place
// "Today's Daf" had in the menu.

// A fixed day, so the month and its dapim are the same on every run:
// Monday 23 November 2026, Eruchin 6.
const NOW = new Date(2026, 10, 23, 12, 0, 0);
const TODAY = dafYomiOfDay(dayNumber(2026, 11, 23));

const CATALOG = {
  tractates: {
    Arakhin: [
      { daf: 6, regularEn: { videoId: 'mdy-6', label: 'Daf Yomi Eruchin Daf 6', amud: 'a' }, chazarahEn: { videoId: 'mdy-6c', label: 'Chazarah Eruchin 6', amud: 'a' } },
    ],
  },
  maggidim: {
    bornstein: { tractates: { Arakhin: [{ daf: 6, regularEn: { videoId: 'ldy-6', label: 'Arachin 6', amud: 'a' } }] } },
  },
};

async function open(page, { catalog = CATALOG, address = '/calendar/' } = {}) {
  await preparePage(page);
  await page.clock.install({ time: NOW });
  // `catalog` is the library's answer, or a function giving it at each request
  // (null: the library cannot be reached).
  await page.route('**/api/get-catalog', (route) => {
    const answer = typeof catalog === 'function' ? catalog() : catalog;
    return route.fulfill({ status: answer ? 200 : 500, contentType: 'application/json', body: JSON.stringify(answer || {}) });
  });
  await page.goto(address);
  await expect(page.locator('.cal-cell').first()).toBeVisible();
}

test.describe('Daf Yomi calendar', () => {
  test('a month as a wall calendar: seven days across, today marked with its daf', async ({ page }, info) => {
    await open(page);
    await expect(page.locator('#calTitle')).toHaveText('November 2026');
    await expect(page.locator('#calHebrewMonths')).toHaveText('Cheshvan – Kislev 5787');
    await expect(page.locator('#calWeekdays > span')).toHaveCount(7);
    // Whole weeks, Sunday first: the columns line up under the weekday names.
    await expect(page.locator('.cal-cell')).toHaveCount(35);
    const columns = await page.evaluate(() => {
      const lefts = [...document.querySelectorAll('.cal-cell')].slice(0, 14).map((cell) => Math.round(cell.getBoundingClientRect().left));
      return { week: new Set(lefts.slice(0, 7)).size, same: lefts.slice(0, 7).every((left, i) => left === lefts[i + 7]) };
    });
    expect(columns).toEqual({ week: 7, same: true });
    // Today's square shows the daf the schedule gives for today.
    const cell = page.locator('.cal-cell.is-today');
    await expect(cell).toHaveCount(1);
    // Each day carries its date, the month shortened, beside the Hebrew date.
    await expect(cell.locator('.cal-date')).toHaveText('Nov 23');
    // The Hebrew date, day and month, as a Hebrew calendar writes it.
    await expect(cell.locator('.cal-hdate')).toHaveText('י״ג כסלו');
    await expect(cell.locator('.cal-today-tag')).toHaveText('Today');
    await expect(page.locator('.cal-cell').last().locator('.cal-date')).toHaveText('Dec 5');
    // Neither date runs out of its day, nor into the other.
    const crowded = await page.locator('.cal-cell').evaluateAll((cells) => cells.filter((day) => {
      const box = day.getBoundingClientRect();
      const [date, hebrew] = ['.cal-date', '.cal-hdate'].map((name) => day.querySelector(name).getBoundingClientRect());
      const apart = date.bottom <= hebrew.top + 1 || date.right <= hebrew.left + 0.5 || hebrew.right <= date.left + 0.5;
      return !apart || Math.min(date.left, hebrew.left) < box.left - 0.5 || Math.max(date.right, hebrew.right) > box.right + 0.5;
    }).length);
    expect(crowded).toBe(0);
    await expect(cell.locator('.cal-num')).toHaveText('6');
    await expect(cell.locator('.cal-mas-long')).toHaveText('Eruchin');
    // The day a masechta begins is marked (Eruchin 2, on the 19th).
    await expect(page.locator('.cal-cell[data-day="' + dayNumber(2026, 11, 19) + '"] .cal-flag')).toHaveText('Begins');
    // The first of a Hebrew month stands out (1 Kislev, on the 11th), and the month before it ends on the 10th.
    await expect(page.locator(`.cal-cell[data-day="${dayNumber(2026, 11, 11)}"] .cal-hdate.is-month`)).toHaveText('א׳ כסלו');
    await expect(page.locator(`.cal-cell[data-day="${dayNumber(2026, 11, 10)}"] .cal-hdate`)).toHaveText('ל׳ חשוון');
    // Above the month: today's daf, how far the masechta is, how far Shas is.
    const tiles = page.locator('#calSummary .cal-tile');
    await expect(tiles).toHaveCount(3);
    await expect(tiles.nth(0)).toContainText('Eruchin 6');
    // Where the schedule is, worded so it is not read as the learner's own count.
    await expect(tiles.nth(1)).toContainText('Daf Yomi schedule');
    await expect(tiles.nth(1)).toContainText('Eruchin · day 5 of 33');
    await expect(tiles.nth(1)).toContainText('Siyum on Dec 21');
    await expect(tiles.nth(2)).toContainText('Daf Yomi cycle');
    await expect(tiles.nth(2)).toContainText(`Day ${(TODAY.dayOfCycle + 1).toLocaleString('en-US')} of ${CYCLE_LENGTH.toLocaleString('en-US')}`);
    await expect(tiles.nth(2)).toContainText('Siyum HaShas on June 7, 2027');
    // Nothing runs off the side of the screen.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  });

  test('the reader chooses which dates a day shows: English, Hebrew or both, and it is remembered', async ({ page }) => {
    await open(page);
    const cell = page.locator('.cal-cell.is-today');
    const choice = (name) => page.locator(`#calDates [data-dates="${name}"]`);
    // Both, to begin with.
    await expect(choice('both')).toHaveAttribute('aria-pressed', 'true');
    await expect(cell.locator('.cal-date')).toBeVisible();
    await expect(cell.locator('.cal-hdate')).toBeVisible();

    // Hebrew alone: the month is named by its Hebrew months, the English one under it.
    await choice('hebrew').click();
    await expect(cell.locator('.cal-date')).toBeHidden();
    await expect(cell.locator('.cal-hdate')).toBeVisible();
    await expect(cell.locator('.cal-hdate')).toHaveText('י״ג כסלו');
    await expect(page.locator('#calTitle')).toHaveText('Cheshvan – Kislev 5787');
    await expect(page.locator('#calHebrewMonths')).toHaveText('November 2026');
    await expect(choice('hebrew')).toHaveAttribute('aria-pressed', 'true');
    await expect(choice('both')).toHaveAttribute('aria-pressed', 'false');
    // Kept for the next visit, and as the month turns.
    await page.reload();
    await expect(page.locator('.cal-cell.is-today .cal-date')).toBeHidden();
    await expect(page.locator('#calTitle')).toHaveText('Cheshvan – Kislev 5787');
    await page.locator('#calNext').click();
    await expect(page.locator('#calTitle')).toHaveText('Kislev – Teves 5787');
    await page.locator('#calToday').click();

    // English alone.
    await choice('english').click();
    await expect(cell.locator('.cal-date')).toHaveText('Nov 23');
    await expect(cell.locator('.cal-hdate')).toBeHidden();
    await expect(page.locator('#calTitle')).toHaveText('November 2026');
    await expect(page.locator('#calHebrewMonths')).toBeHidden();

    // And both again.
    await choice('both').click();
    await expect(cell.locator('.cal-date')).toBeVisible();
    await expect(cell.locator('.cal-hdate')).toBeVisible();
    await expect(page.locator('#calHebrewMonths')).toHaveText('Cheshvan – Kislev 5787');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  });

  test('a day opens with its shiurim, each going to the player', async ({ page }, info) => {
    await open(page);
    const panel = page.locator('#calDay');
    // A computer has today's daf open beside the month from the start; a
    // phone shows the month alone until a day is tapped.
    if (info.project.name === 'mobile') await expect(panel).toBeHidden();
    await page.locator('#calSummary [data-go]').click();
    await expect(panel).toBeVisible();
    await expect(panel.locator('.cal-day-when')).toHaveText('Today');
    await expect(panel.locator('.cal-day-date')).toContainText('Monday, November 23');
    await expect(panel.locator('.cal-day-date')).toContainText('13 Kislev 5787');
    await expect(panel.locator('.cal-day-title')).toContainText('Eruchin 6');
    await expect(panel.locator('.cal-day-where')).toContainText('Day 5 of 33 in Eruchin');
    const shiurim = panel.locator('.cal-shiur');
    await expect(shiurim).toHaveCount(3);
    await expect(shiurim.nth(0)).toContainText('R\' Eli Stefansky · English');
    await expect(shiurim.nth(0)).toHaveAttribute('href', '/player/?ref=Arakhin%206a');
    await expect(shiurim.nth(1)).toContainText('Chazarah Daf, English');
    await expect(shiurim.nth(1)).toHaveAttribute('href', '/player/?ref=Arakhin%206a&variant=chazarah');
    await expect(shiurim.nth(2)).toContainText('R\' Sruly Bornstein · English');
    await expect(shiurim.nth(2)).toHaveAttribute('href', '/player/?ref=Arakhin%206a&maggid=bornstein');
    await expect(panel.getByRole('link', { name: 'Open the daf' })).toHaveAttribute('href', '/browse/?ref=Arakhin%206a');
    await expect(panel.getByRole('link', { name: 'About this daf' })).toHaveAttribute('href', '/eruchin/6/');

    // Tomorrow's daf has no shiur yet, and says so.
    if (info.project.name === 'mobile') await panel.locator('#calDayClose').click();
    await page.locator(`.cal-cell[data-day="${dayNumber(2026, 11, 24)}"]`).click();
    await expect(panel.locator('.cal-day-when')).toHaveText('Tomorrow');
    await expect(panel.locator('.cal-day-title')).toContainText('Eruchin 7');
    await expect(panel).toContainText('Its shiurim appear here once they are given.');
    await expect(panel.locator('.cal-shiur')).toHaveCount(0);
    await expect(page.locator('.cal-cell.is-selected .cal-num')).toHaveText('7');
  });

  test('the month turns, a siyum is marked, and Today comes back', async ({ page }, info) => {
    await open(page);
    await page.locator('#calNext').click();
    await expect(page.locator('#calTitle')).toHaveText('December 2026');
    // Eruchin ends at daf 34 on 21 December; Temurah begins the next day.
    const siyum = page.locator(`.cal-cell[data-day="${dayNumber(2026, 12, 21)}"]`);
    await expect(siyum.locator('.cal-num')).toHaveText('34');
    await expect(siyum.locator('.cal-flag-siyum')).toHaveText('Siyum');
    await expect(page.locator(`.cal-cell[data-day="${dayNumber(2026, 12, 22)}"] .cal-mas-long`)).toHaveText('Temurah');
    await expect(page.locator('.cal-cell.is-today')).toHaveCount(0);

    // A masechta the site has no shiurim on (Tamid, March 2027) still has its days.
    for (let i = 0; i < 3; i += 1) await page.locator('#calNext').click();
    await expect(page.locator('#calTitle')).toHaveText('March 2027');
    const tamid = page.locator('.cal-cell:not(.is-outside)', { has: page.locator('.cal-mas-long', { hasText: 'Tamid' }) }).first();
    await tamid.click();
    await expect(page.locator('#calDay')).toContainText('DafSync has no shiurim on this masechta yet.');
    if (info.project.name === 'mobile') await page.locator('#calDayClose').click();

    await page.locator('#calPrev').click();
    await expect(page.locator('#calTitle')).toHaveText('February 2027');
    await page.locator('#calToday').click();
    await expect(page.locator('#calTitle')).toHaveText('November 2026');
    await expect(page.locator('.cal-cell.is-today.is-selected')).toHaveCount(1);
  });

  test('when the library cannot be reached the day says so, and the next tap tries again', async ({ page }, info) => {
    let fail = true;
    await open(page, { catalog: () => (fail ? null : CATALOG) });
    const today = page.locator('.cal-cell.is-today');
    await page.locator(`.cal-cell[data-day="${dayNumber(2026, 11, 22)}"]`).click();
    const panel = page.locator('#calDay');
    await expect(panel).toContainText('The shiurim could not be loaded.');
    fail = false;
    if (info.project.name === 'mobile') await panel.locator('#calDayClose').click();
    await today.click();
    await expect(panel.locator('.cal-shiur')).toHaveCount(3);
  });

  test('in Hebrew: the days, the dapim and the wording', async ({ page }) => {
    await open(page, { address: '/calendar/?lang=he' });
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    const cell = page.locator('.cal-cell.is-today');
    await expect(cell.locator('.cal-mas-long')).toHaveText('ערכין');
    await expect(cell.locator('.cal-num')).toHaveText('ו');
    await expect(cell.locator('.cal-date')).toHaveText('23 בנוב׳');
    await expect(page.locator('#calWeekdays .cal-weekday-long').last()).toHaveText('שבת');
    await expect(page.locator('#calSummary .cal-tile').nth(1)).toContainText('ערכין · יום 5 מתוך 33');
    await expect(page.locator('#calSummary .cal-tile').nth(2)).toContainText('מחזור הדף היומי');
    await expect(page.locator('.cal-eyebrow')).toHaveText('לוח הדף היומי');
    // The Hebrew date in letters, as a Hebrew calendar prints it.
    await expect(page.locator('#calHebrewMonths')).toHaveText('חשוון – כסלו תשפ״ז');
    await page.locator('#calSummary [data-go]').click();
    await expect(page.locator('#calDay .cal-shiur').first()).toContainText('הרב אלי סטפנסקי · אנגלית');
    await expect(page.locator('#calDay .cal-day-date')).toContainText('י״ג כסלו תשפ״ז');
    // The first column is on the right.
    const [first, second] = await page.locator('.cal-cell').evaluateAll((cells) => cells.slice(0, 2).map((c) => c.getBoundingClientRect().left));
    expect(first).toBeGreaterThan(second);
  });
});

test.describe('The calendar in the menu', () => {
  test('on a computer the sidebar opens it, from the home page and from the others', async ({ page }, info) => {
    test.skip(info.project.name === 'mobile', 'desktop layout');
    await preparePage(page, { user: null });
    for (const address of ['/index.html', '/browse/']) {
      await page.goto(address);
      await expect(page.locator('.desktop-navigation a.side-link[href="/calendar/"] span')).toHaveText('Calendar');
    }
    await page.goto('/calendar/');
    await expect(page.locator('.desktop-navigation a.side-link.active span')).toHaveText('Calendar');
  });

  test('on a phone it has its own tab on the bottom bar, on the home page and on the others', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'phone layout');
    await preparePage(page, { user: null });
    for (const address of ['/index.html', '/browse/']) {
      await page.goto(address);
      const tab = page.locator('.mobile-nav a[href="/calendar/"]');
      await expect(tab).toBeVisible();
      await expect(tab).toHaveText('Calendar');
      await expect(tab).not.toHaveClass(/active/);
    }
    await page.locator('.mobile-nav a[href="/calendar/"]').click();
    await expect(page).toHaveURL(/\/calendar\/$/);
    await expect(page.locator('.cal-cell.is-today')).toHaveCount(1);
    await expect(page.locator('.mobile-nav a.active')).toHaveText('Calendar');
  });

  test('on a phone the page sits in the middle of the screen, the same margin either side', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'phone layout');
    await preparePage(page, { user: null });
    for (const width of [412, 390, 360, 320]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/calendar/');
      await expect(page.locator('.cal-cell').first()).toBeVisible();
      const sides = await page.evaluate(() => ['.topbar', '.cal-head', '.cal-summary', '.cal-card'].map((name) => {
        const box = document.querySelector(name).getBoundingClientRect();
        return [Math.round(box.left), Math.round(window.innerWidth - box.right)];
      }));
      for (const [left, right] of sides) {
        expect(left).toBeGreaterThanOrEqual(8);
        expect(Math.abs(left - right)).toBeLessThanOrEqual(1);
      }
      // Nothing inside pokes out past that margin (the month's arrows, on the narrowest phones).
      const furthest = await page.evaluate(() => Math.max(...[...document.querySelectorAll('.cal-nav > *, .cal-tile, .cal-cell, .cal-dates-choice')].map((el) => el.getBoundingClientRect().right)));
      expect(furthest).toBeLessThanOrEqual(width - 8);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
  });

  test('the old "Today’s Daf" address opens the calendar', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/index.html?nav=today');
    await expect(page).toHaveURL(/\/calendar\/$/);
  });
});
