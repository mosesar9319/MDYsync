import { test, expect } from '@playwright/test';
import { preparePage, failOnPageError } from '../support/harness.mjs';
import { buildDatabase, sessionFor, USERS, NOTE_IDS } from '../fixtures/dataset.mjs';

// My Notes (/notes/): the signed-in reader's own notes from every daf, in one
// list. Until this page existed a note was only reachable from the daf it was
// attached to, so the library view itself is the whole feature -- these specs
// therefore care most about (a) that it shows the reader's OWN notes and
// nobody else's, private ones included, and (b) that "open on the daf"
// actually points at the right daf.

const CARD = '.cc-card';
const FEED = '#mnFeed';

async function waitForCards(page) {
  await expect(page.locator(CARD).first()).toBeVisible();
}

async function cardIds(page) {
  return page.locator(CARD).evaluateAll((cards) => cards.map((card) => card.dataset.id));
}

// Same desktop-rail vs mobile-sheet duality the Cloud Chabura specs handle:
// driving only the rail control would pass on desktop and fail below 900px for
// a reason that is not a defect.
async function selectFilter(page, railId, sheetId, value) {
  const rail = page.locator(`#${railId}`);
  if (await rail.isVisible()) {
    await rail.selectOption(value);
    return;
  }
  await page.click('#mnOpenFilters');
  await page.selectOption(`#${sheetId}`, value);
  await page.click('#mnCloseFilters');
}

test.describe('My Notes — access', () => {
  test('signed out, it asks for sign-in instead of showing an empty library', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { user: null });
    await page.goto('/notes/');

    await expect(page.locator('.cc-empty h3')).toHaveText('Sign in to see your notes');
    await expect(page.locator(CARD)).toHaveCount(0);
  });

  test('signed in, it lists the reader’s own notes and nobody else’s', async ({ page }) => {
    failOnPageError(page);
    const db = buildDatabase();
    // One note that belongs to a DIFFERENT account. line_notes_author_read_own
    // is what scopes this server-side; the point here is that the page asks
    // for its own rows rather than relying on the public-feed filters.
    db.line_notes.push({
      ...db.line_notes[0],
      id: 'b0000000-0000-4000-8000-0000000000ff',
      author_id: USERS.ordinary.id,
      author_display_name: USERS.ordinary.display_name,
      body: 'Someone else’s note.',
    });

    await preparePage(page, { db, session: sessionFor(USERS.author) });
    await page.goto('/notes/');
    await waitForCards(page);

    const ids = await cardIds(page);
    expect(ids).not.toContain('b0000000-0000-4000-8000-0000000000ff');
    expect(ids).toContain(NOTE_IDS.singleWordRange);
    await expect(page.locator(FEED)).not.toContainText('Someone else’s note.');
  });

  test('a private note appears, marked private', async ({ page }) => {
    failOnPageError(page);
    const db = buildDatabase();
    const priv = db.line_notes.find((row) => row.id === NOTE_IDS.privateNote);
    // The fixture's private note belongs to whoever buildDatabase assigned it;
    // this spec is about the owner seeing it, so sign in as that owner.
    await preparePage(page, { db, session: sessionFor({ id: priv.author_id, email: 'owner@example.com' }) });
    await page.goto('/notes/');
    await waitForCards(page);

    const card = page.locator(`${CARD}[data-id="${NOTE_IDS.privateNote}"]`);
    await expect(card).toBeVisible();
    await expect(card.locator('.cc-chip-private')).toHaveText('Private');
  });
});

test.describe('My Notes — jump to the daf', () => {
  test('links to the daf the note is on', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author) });
    await page.goto('/notes/');
    await waitForCards(page);

    const card = page.locator(`${CARD}[data-id="${NOTE_IDS.singleWordRange}"]`);
    await expect(card.locator('.cc-card-title a')).toHaveAttribute('href', '/browse/?ref=Chullin%2089a');
  });

  // The regression this guards: daf_ref_key is built by app.js's refKey(),
  // which prefixes the variant and language ("Hebrew-Chazarah-Daf-Chullin-89a").
  // Passing that through to ?ref= verbatim produces a ref no daf lookup can
  // resolve. A note taken against the Hebrew Chazarah recording is still a
  // note on Chullin 89a.
  test('strips the variant/language prefix from a prefixed daf_ref_key', async ({ page }) => {
    failOnPageError(page);
    const db = buildDatabase();
    db.line_notes.push({
      ...db.line_notes[0],
      id: 'b0000000-0000-4000-8000-0000000000aa',
      author_id: USERS.author.id,
      daf_ref_key: 'Hebrew-Chazarah-Daf-Chullin-89a',
      body: 'Note taken on the Hebrew Chazarah Daf.',
      created_at: '2026-09-02T11:00:00.000Z',
      last_activity_at: '2026-09-02T11:00:00.000Z',
    });

    await preparePage(page, { db, session: sessionFor(USERS.author) });
    await page.goto('/notes/');
    await waitForCards(page);

    const card = page.locator(`${CARD}[data-id="b0000000-0000-4000-8000-0000000000aa"]`);
    await expect(card.locator('.cc-card-title a')).toHaveAttribute('href', '/browse/?ref=Chullin%2089a');
    // ...while the chip still says which recording it came from, so two notes
    // on the same daf from different shiurim stay distinguishable.
    await expect(card.locator('.cc-chip-daf')).toContainText('Chazarah Daf');
    await expect(card.locator('.cc-chip-daf')).toContainText('Hebrew');
  });

  // A slugified tractate can contain hyphens of its own, so the decoder cannot
  // split on the first one.
  test('handles a hyphenated tractate name', async ({ page }) => {
    failOnPageError(page);
    const db = buildDatabase();
    db.line_notes.push({
      ...db.line_notes[0],
      id: 'b0000000-0000-4000-8000-0000000000bb',
      author_id: USERS.author.id,
      daf_ref_key: 'Bava-Kamma-12b',
      body: 'Note on a two-word masechta.',
      created_at: '2026-09-02T11:30:00.000Z',
      last_activity_at: '2026-09-02T11:30:00.000Z',
    });

    await preparePage(page, { db, session: sessionFor(USERS.author) });
    await page.goto('/notes/');
    await waitForCards(page);

    const card = page.locator(`${CARD}[data-id="b0000000-0000-4000-8000-0000000000bb"]`);
    await expect(card.locator('.cc-card-title a')).toHaveAttribute('href', '/browse/?ref=Bava%20Kamma%2012b');
    await expect(card.locator('.cc-chip-daf')).toHaveText('Bava Kamma 12b');
  });
});

test.describe('My Notes — filtering', () => {
  test('filters by category', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author) });
    await page.goto('/notes/');
    await waitForCards(page);

    await selectFilter(page, 'mnCategory', 'mnCategorySheet', 'insight');
    await expect(page.locator(`${CARD}[data-id="${NOTE_IDS.singleWordRange}"]`)).toBeVisible();
    await expect(page.locator(`${CARD}[data-id="${NOTE_IDS.legacySegmentOnly}"]`)).toHaveCount(0);
  });

  test('filters to private notes only', async ({ page }) => {
    failOnPageError(page);
    const db = buildDatabase();
    const priv = db.line_notes.find((row) => row.id === NOTE_IDS.privateNote);
    await preparePage(page, { db, session: sessionFor({ id: priv.author_id, email: 'owner@example.com' }) });
    await page.goto('/notes/');
    await waitForCards(page);

    await selectFilter(page, 'mnVisibility', 'mnVisibilitySheet', 'private');
    const ids = await cardIds(page);
    expect(ids).toContain(NOTE_IDS.privateNote);
    const shared = await page.locator('.cc-chip-shared').count();
    expect(shared).toBe(0);
  });

  test('an over-narrow filter says so, and offers a way back', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author) });
    await page.goto('/notes/');
    await waitForCards(page);

    await page.fill('#mnSearch', 'zzzznotarealwordanywhere');
    await expect(page.locator('.cc-empty h3')).toHaveText('No notes match these filters');
    await page.click('.cc-empty .cc-btn');
    await waitForCards(page);
  });

  test('filter state survives a reload', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author) });
    await page.goto('/notes/');
    await waitForCards(page);

    await selectFilter(page, 'mnCategory', 'mnCategorySheet', 'insight');
    await expect(page).toHaveURL(/category=insight/);

    await page.reload();
    await waitForCards(page);
    await expect(page.locator(`${CARD}[data-id="${NOTE_IDS.legacySegmentOnly}"]`)).toHaveCount(0);
  });
});

test.describe('My Notes — empty library', () => {
  test('a brand new account is told how to start, not shown an error', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.brandNew) });
    await page.goto('/notes/');

    await expect(page.locator('.cc-empty h3')).toHaveText('No notes yet');
    await expect(page.locator(CARD)).toHaveCount(0);
  });
});
