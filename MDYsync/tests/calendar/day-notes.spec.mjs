import { test, expect } from '@playwright/test';
import { preparePage } from '../support/harness.mjs';
import { buildDatabase, USERS } from '../fixtures/dataset.mjs';
import { dayNumber } from '../../shared/daf-yomi.mjs';

// Notes on the calendar: a signed-in learner's own note on a day, and the
// notes he wrote on that day's daf, each a link to where it lives.

// Monday 23 November 2026, Eruchin 6.
const NOW = new Date(2026, 10, 23, 12, 0, 0);
const lineNote = (more) => ({
  author_id: USERS.ordinary.id, author_display_name: USERS.ordinary.display_name, hidden: false, deleted_at: null,
  title: null, category: 'insight', created_at: '2026-11-23T08:00:00Z', updated_at: '2026-11-23T08:00:00Z', ...more,
});

async function open(page, { user = USERS.ordinary } = {}) {
  const db = buildDatabase();
  db.calendar_notes = [
    { user_id: USERS.ordinary.id, day: '2026-11-22', body: 'Learned with Dovid after Maariv.' },
    // Another learner's note is his own.
    { user_id: USERS.author.id, day: '2026-11-24', body: 'OTHER-ACCOUNT-CANARY' },
  ];
  db.line_notes.push(
    lineNote({ id: 'c0000000-0000-4000-8000-000000000001', daf_ref_key: 'Arakhin-6a', segment_ref: 'Arakhin 6a.3', body: 'Why does the Gemara bring this case here?', is_private: true }),
    lineNote({ id: 'c0000000-0000-4000-8000-000000000002', daf_ref_key: 'Arakhin-6b', segment_ref: 'Arakhin 6b.2', title: 'Tosafos on the second answer', body: 'See Tosafos.', is_private: false, created_at: '2026-11-23T09:00:00Z' }),
    // On another daf, deleted, or someone else's: not listed under daf 6.
    lineNote({ id: 'c0000000-0000-4000-8000-000000000003', daf_ref_key: 'Arakhin-26a', segment_ref: 'Arakhin 26a.1', body: 'A note on daf 26.', is_private: true }),
    lineNote({ id: 'c0000000-0000-4000-8000-000000000004', daf_ref_key: 'Arakhin-6a', segment_ref: 'Arakhin 6a.1', body: 'A deleted note.', is_private: true, deleted_at: '2026-11-23T10:00:00Z' }),
    lineNote({ id: 'c0000000-0000-4000-8000-000000000005', daf_ref_key: 'Arakhin-6a', segment_ref: 'Arakhin 6a.1', body: 'Somebody else wrote this.', author_id: USERS.author.id }),
  );
  await preparePage(page, { user, db });
  await page.clock.install({ time: NOW });
  await page.route('**/api/get-catalog', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tractates: { Arakhin: [] } }) }));
  await page.goto('/calendar/');
  await expect(page.locator('.cal-cell').first()).toBeVisible();
}
const cell = (page, month, day) => page.locator(`.cal-cell[data-day="${dayNumber(2026, month, day)}"]`);
const openDay = async (page, info, month, day) => {
  if (info.project.name === 'mobile' && await page.locator('#calDayClose').isVisible()) await page.locator('#calDayClose').click();
  await cell(page, month, day).click();
};
const rows = (page) => page.evaluate(() => window.__DAFSYNC_TEST_DB__.calendar_notes.map((row) => [row.user_id.slice(0, 4), row.day, row.body]));

test.describe('Notes on the calendar', () => {
  test('a day with a note, or with notes on its daf, has a folded corner', async ({ page }) => {
    await open(page);
    await expect(cell(page, 11, 22)).toHaveClass(/has-note/);       // his note on the day
    await expect(cell(page, 11, 23)).toHaveClass(/has-note/);       // his notes on Eruchin 6
    await expect(page.locator('.cal-cell.has-note')).toHaveCount(2);
    // Not the day another learner wrote on.
    await expect(cell(page, 11, 24)).not.toHaveClass(/has-note/);
    await expect(page.locator('#calLegend')).toContainText('Has a note');
  });

  test('a note is written on a day, changed, and taken away', async ({ page }, info) => {
    await open(page);
    await openDay(page, info, 11, 22);
    const box = page.locator('#calNote');
    await expect(box).toHaveValue('Learned with Dovid after Maariv.');

    // A new note on another day keeps itself when the box is left.
    await openDay(page, info, 11, 25);
    await expect(box).toHaveValue('');
    await box.fill('Siyum at the shul on Sunday.');
    await box.blur();
    await expect(page.locator('#calNoteStatus')).toHaveText('Saved');
    await expect(cell(page, 11, 25)).toHaveClass(/has-note/);
    expect(await rows(page)).toContainEqual(['1111', '2026-11-25', 'Siyum at the shul on Sunday.']);
    // It is there when the day is opened again.
    await openDay(page, info, 11, 22);
    await openDay(page, info, 11, 25);
    await expect(box).toHaveValue('Siyum at the shul on Sunday.');

    // Changed: still one row for the day.
    await box.fill('Siyum moved to Monday.');
    await box.blur();
    await expect(page.locator('#calNoteStatus')).toHaveText('Saved');
    expect((await rows(page)).filter((row) => row[1] === '2026-11-25')).toEqual([['1111', '2026-11-25', 'Siyum moved to Monday.']]);

    // Emptied: the note and the folded corner go. The other learner's row is untouched.
    await box.fill('');
    await box.blur();
    await expect(cell(page, 11, 25)).not.toHaveClass(/has-note/);
    expect(await rows(page)).toEqual([['1111', '2026-11-22', 'Learned with Dovid after Maariv.'], ['2222', '2026-11-24', 'OTHER-ACCOUNT-CANARY']]);
  });

  test('the notes he wrote on the day’s daf are listed, each going to where it lives', async ({ page }, info) => {
    await open(page);
    await openDay(page, info, 11, 23);
    const notes = page.locator('#calDay .cal-note-link');
    await expect(notes).toHaveCount(2);
    // The newest first. A public note is a discussion in Cloud Chaburah; a private one is on its line of the daf.
    await expect(notes.nth(0)).toContainText('Public');
    await expect(notes.nth(0)).toContainText('Tosafos on the second answer');
    await expect(notes.nth(0)).toHaveAttribute('href', '/chaburah/thread/?thread=c0000000-0000-4000-8000-000000000002');
    await expect(notes.nth(1)).toContainText('Private');
    await expect(notes.nth(1)).toContainText('Why does the Gemara bring this case here?');
    await expect(notes.nth(1)).toHaveAttribute('href', '/browse/?ref=Arakhin%206a');
    await expect(page.locator('#calDay')).not.toContainText('Somebody else wrote this.');
    await expect(page.locator('#calDay')).not.toContainText('A deleted note.');
    await expect(page.locator('#calDay').getByRole('link', { name: 'All my notes on this masechta' })).toHaveAttribute('href', '/notes/?tractate=Arakhin');
    // A daf with none says so, and offers the way to write one.
    await openDay(page, info, 11, 24);
    await expect(page.locator('#calDay')).toContainText('You have not written a note on this daf.');
    await expect(page.locator('#calDay').getByRole('link', { name: 'Write a note on the daf' })).toHaveAttribute('href', '/browse/?ref=Arakhin%207a');
  });

  test('signed out: no notes, and an invitation to sign in', async ({ page }, info) => {
    await open(page, { user: null });
    await expect(page.locator('.cal-cell.has-note')).toHaveCount(0);
    await openDay(page, info, 11, 22);
    await expect(page.locator('#calNote')).toHaveCount(0);
    await expect(page.locator('#calDay')).not.toContainText('Learned with Dovid');
    await page.locator('#calNoteSignIn').click();
    await expect(page.locator('#authDialog')).toBeVisible();
  });
});
