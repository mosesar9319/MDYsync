import { test, expect } from '@playwright/test';
import { preparePage, failOnPageError } from '../support/harness.mjs';

// Reported directly: opening a Bekhorot video crashed the whole player page
// with "Cannot read properties of undefined (reading 'endDaf')".
//
// Root cause (as first diagnosed against this branch's own, since-stale
// copy of app.js): a hardcoded SITE_ACTIVE_TRACTATES allowlist restricted
// the reader-facing daf reference picker (#dafTractateSelect) to a single
// tractate, out of sync with index.html's own homepage allowlist. Loading
// any daf calls syncDafPickerFromRef (from loadAlignmentData), which sets
// #dafTractateSelect's value to the loaded ref's tractate; a <select>'s
// value setter silently clears to "" for a value with no matching <option>,
// and refreshDafPickerAmud() read syncState.talmudByName[''] (undefined)
// with no guard, crashing on entry.endDaf inside amudimForDaf.
//
// By the time this was merged with main, main had independently removed
// SITE_ACTIVE_TRACTATES entirely as part of its own "Masechta picker"
// feature -- every tractate in talmud_index.json is now offered
// unconditionally, so the mismatch this bug depended on can no longer
// happen for any real tractate. refreshDafPickerAmud()'s own guard against
// a missing entry survives the merge regardless, as a real hardening: the
// same crash shape is still reachable for any STRAY tractate name that
// doesn't match talmud_index.json's entries at all (a typo'd ref, a page
// that hasn't finished loadTalmudIndex()'s fetch yet), the same way every
// other reader of syncState.talmudByName in this file already guards.
test.describe('The reader-facing daf picker never crashes on an unrecognized tractate', () => {
  test('loading a Bekhorot daf does not crash the player page', async ({ page }) => {
    const errors = failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Bekhorot%202a');
    // syncDafPickerFromRef (called from loadAlignmentData) is what actually
    // crashed -- give its whole chain (loadDaf -> loadAlignmentData ->
    // renderDaf -> ...) time to fully settle rather than asserting on a
    // specific state.dafRef value, which this suite's flat Sefaria/alignment
    // stubs don't parametrize by ref.
    await expect(page.locator('#dafTractateSelect')).toBeAttached();
    await page.waitForTimeout(500);
    expect(errors.filter((e) => e.includes('endDaf'))).toEqual([]);
  });

  test('a stray tractate name #dafTractateSelect has no option for degrades quietly instead of crashing', async ({ page }) => {
    const errors = failOnPageError(page);
    await preparePage(page, { user: null });
    // Not a real tractate name -- talmud_index.json has no entry for it, so
    // syncState.talmudByName['Not A Real Tractate'] is genuinely undefined,
    // the one shape of mismatch that survives main's own removal of
    // SITE_ACTIVE_TRACTATES.
    await page.goto('/player/?ref=Not%20A%20Real%20Tractate%202a');
    await expect(page.locator('#dafTractateSelect')).toBeAttached();
    await page.waitForTimeout(500);
    expect(errors.filter((e) => e.includes('endDaf'))).toEqual([]);
  });
});
