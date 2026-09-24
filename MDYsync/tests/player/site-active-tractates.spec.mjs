import { test, expect } from '@playwright/test';
import { preparePage, failOnPageError } from '../support/harness.mjs';

// Reported directly: opening a Bekhorot video (right after it was added to
// index.html's SITE_TRACTATES, the homepage's own video-grid allowlist)
// crashed the whole player page with "Cannot read properties of undefined
// (reading 'endDaf')".
//
// Root cause: app.js keeps a SEPARATE allowlist, SITE_ACTIVE_TRACTATES,
// gating the reader-facing daf reference picker (#dafTractateSelect) --
// Bekhorot was added to the homepage's list but not this one. Loading any
// daf calls syncDafPickerFromRef (from loadAlignmentData), which sets
// #dafTractateSelect's value to the loaded ref's tractate; a <select>'s
// value setter silently clears to "" for a value with no matching <option>
// (Bekhorot wasn't one, since SITE_ACTIVE_TRACTATES only listed Chullin),
// and refreshDafPickerAmud() read syncState.talmudByName[''] (undefined)
// with no guard, crashing on entry.endDaf inside amudimForDaf.
//
// Fixed two ways: SITE_ACTIVE_TRACTATES now includes Bekhorot (matching
// index.html's own list), and refreshDafPickerAmud() guards against a
// missing entry the same way refreshDafPickerOptions() already did --
// the next tractate someone forgets to add to one of these two lists
// should degrade gracefully, not crash the page outright.
test.describe('The reader-facing daf picker survives a tractate outside SITE_ACTIVE_TRACTATES', () => {
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

  // The crash's own guard (refreshDafPickerAmud now returns early on a
  // missing entry, same as refreshDafPickerOptions already did) covers any
  // FUTURE mismatch between this file's SITE_ACTIVE_TRACTATES and
  // index.html's own SITE_TRACTATES too -- a tractate present in one list
  // but not the other degrades to the picker quietly not tracking it,
  // rather than crashing the page outright.
  test('a tractate outside SITE_ACTIVE_TRACTATES degrades quietly instead of crashing', async ({ page }) => {
    const errors = failOnPageError(page);
    await preparePage(page, { user: null });
    // Menachot is a real tractate (present in talmud_index.json, so
    // syncState.talmudByName['Menachot'] exists) but deliberately not in
    // SITE_ACTIVE_TRACTATES -- the same shape of mismatch that crashed on
    // Bekhorot before it was added there.
    await page.goto('/player/?ref=Menachot%202a');
    await expect(page.locator('#dafTractateSelect')).toBeAttached();
    await page.waitForTimeout(500);
    expect(errors.filter((e) => e.includes('endDaf'))).toEqual([]);
  });
});
