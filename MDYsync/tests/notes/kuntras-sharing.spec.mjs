import { test, expect } from '@playwright/test';
import { preparePage, failOnPageError } from '../support/harness.mjs';
import { buildDatabase, sessionFor, USERS } from '../fixtures/dataset.mjs';

// Kuntras Builder, slice 4: sharing -- private, an unlisted link, or fully
// public in a browsable listing. See 20260916100000's own header for why
// unlisted and public are identical for READ access and differ only in
// whether a listing query returns them.
//
// What this suite is NOT for: proving a private kuntras is actually
// unreadable by anon or a stranger. This stub has no RLS at all -- it
// returns whatever fetchKuntrasTree's query asks for regardless of who is
// asking, since the real access control lives entirely in Postgres (see
// supabase/tests/rls_authorization.sql's own slice 4 section, which proves
// exactly that against a real database with the real policies). What this
// suite proves instead is that the CLIENT renders correctly once given a
// row -- read-only chrome for a shared link, full editing for the owner,
// the right rows in the right listings.
//
// A published kuntras is seeded directly into the fixture database rather
// than created live and then navigated to: a ?k= link is a real <a href>,
// and following one is a real page navigation, which reruns this stub's own
// addInitScript and resets its in-page database to whatever was seeded --
// see kuntras.spec.mjs's own note on page.reload() for the same root cause.

const KUN_ID = 'f9000000-0000-4000-8000-000000000001';
const ENTRY_ID = 'f9000000-0000-4000-8000-000000000002';
const TITLE = 'My shared sichas';
const ENTRY_BODY = 'A thought worth sharing.';

function databaseWithPublished(visibility, overrides = {}) {
  const db = buildDatabase();
  db.kuntrasim = db.kuntrasim || [];
  db.kuntras_entries = db.kuntras_entries || [];
  db.kuntrasim.push({
    id: KUN_ID, owner_id: USERS.author.id, title: TITLE, visibility,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), deleted_at: null,
    ...overrides,
  });
  db.kuntras_entries.push({
    id: ENTRY_ID, kuntras_id: KUN_ID, section_id: null, kind: 'freeform', title: null,
    body: ENTRY_BODY, position: 0,
    source_note_id: null, source_document_id: null, source_chaburah_note_id: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
  return db;
}

test.describe('Kuntras Builder — opening a shared link', () => {
  test('an anonymous visitor can read an unlisted kuntras, read-only', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: null, db: databaseWithPublished('unlisted') });
    await page.goto(`/kuntras/?k=${KUN_ID}`);
    await expect(page.locator('#knBuilder')).toBeVisible();

    await expect(page.locator('#knBuilderTitle')).toHaveText(TITLE);
    await expect(page.locator('#knTree')).toContainText(ENTRY_BODY);

    await expect(page.locator('#knAddRootSection')).toBeHidden();
    await expect(page.locator('#knAddRootEntry')).toBeHidden();
    await expect(page.locator('#knRenameButton')).toBeHidden();
    await expect(page.locator('#knDeleteButton')).toBeHidden();
    await expect(page.locator('#knShareButton')).toBeHidden();
    // No per-entry Edit/Delete or move buttons either -- the whole point of
    // read-only is that a visitor cannot reach any mutation at all.
    await expect(page.locator('.kn-entry-actions')).toHaveCount(0);
    await expect(page.locator('.kn-move-buttons')).toHaveCount(0);
  });

  test('a signed-in stranger reads the same unlisted link just as well -- it is not owner-scoped', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.ordinary), db: databaseWithPublished('unlisted') });
    await page.goto(`/kuntras/?k=${KUN_ID}`);
    await expect(page.locator('#knBuilderTitle')).toHaveText(TITLE);
    await expect(page.locator('#knShareButton')).toBeHidden();
  });

  test('a fully public kuntras is reachable by its link too, not only via the listing', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: null, db: databaseWithPublished('public') });
    await page.goto(`/kuntras/?k=${KUN_ID}`);
    await expect(page.locator('#knBuilderTitle')).toHaveText(TITLE);
  });

  test('an id that does not exist says so, rather than hanging or erroring', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: null, db: buildDatabase() });
    await page.goto('/kuntras/?k=00000000-0000-4000-8000-000000000000');
    await expect(page.locator('#knBuilder')).toBeVisible();
    await expect(page.locator('#knTree')).toContainText('not available');
  });
});

test.describe('Kuntras Builder — public browse listing', () => {
  test('lists a public kuntras for a signed-out visitor', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: null, db: databaseWithPublished('public') });
    await page.goto('/kuntras/');
    await expect(page.locator('#knPublicFeed')).toContainText(TITLE);
  });

  test('never lists an unlisted kuntras -- that is the entire distinction between the two', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: null, db: databaseWithPublished('unlisted') });
    await page.goto('/kuntras/');
    await expect(page.locator('#knPublicFeed')).toBeVisible();
    await expect(page.locator('#knPublicFeed')).not.toContainText(TITLE);
  });

  test('never lists a private kuntras', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: null, db: databaseWithPublished('private') });
    await page.goto('/kuntras/');
    await expect(page.locator('#knPublicFeed')).not.toContainText(TITLE);
  });

  test('search narrows the public listing by title', async ({ page }) => {
    failOnPageError(page);
    const db = databaseWithPublished('public');
    db.kuntrasim.push({
      id: 'f9000000-0000-4000-8000-000000000099', owner_id: USERS.ordinary.id,
      title: 'A completely different pamphlet', visibility: 'public',
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(), deleted_at: null,
    });
    await preparePage(page, { session: null, db });
    await page.goto('/kuntras/');
    await expect(page.locator('#knPublicFeed .cc-card')).toHaveCount(2);

    await page.fill('#knPublicSearch', 'shared sichas');
    await expect(page.locator('#knPublicFeed .cc-card')).toHaveCount(1);
    await expect(page.locator('#knPublicFeed')).toContainText(TITLE);
  });

  test('a card links straight to the read-only view', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: null, db: databaseWithPublished('public') });
    await page.goto('/kuntras/');
    await expect(page.locator('#knPublicFeed')).toContainText(TITLE);
    const href = await page.locator('#knPublicFeed .cc-card a').getAttribute('href');
    expect(href).toBe(`?k=${KUN_ID}`);
  });
});

test.describe('Kuntras Builder — the owner\'s own Sharing control', () => {
  test('opening your own kuntras the normal way always shows full editing, whatever its visibility', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author), db: databaseWithPublished('public') });
    await page.goto('/kuntras/');
    // Scoped to #knFeed -- see "the library card itself shows the current
    // visibility" above on why a public kuntras appears twice on this page.
    await page.click(`#knFeed .cc-card[data-id="${KUN_ID}"] a`);
    await expect(page.locator('#knBuilder')).toBeVisible();
    await expect(page.locator('#knAddRootEntry')).toBeVisible();
    await expect(page.locator('#knShareButton')).toBeVisible();
  });

  test('the library card itself shows the current visibility', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author), db: databaseWithPublished('public') });
    await page.goto('/kuntras/');
    // Scoped to #knFeed ("my kuntrasim"), not just any .cc-card with this
    // id -- a kuntras that is both mine and public renders TWICE on this
    // very page (once here, once again down in #knPublicFeed, same as any
    // public content is still shown to its own author elsewhere on the
    // site), so the bare selector is ambiguous.
    await expect(page.locator(`#knFeed .cc-card[data-id="${KUN_ID}"]`)).toContainText('Public');
  });

  test('the Sharing dialog reflects the current visibility and shows a working link', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author), db: databaseWithPublished('unlisted') });
    await page.goto('/kuntras/');
    await page.click(`.cc-card[data-id="${KUN_ID}"] a`);
    await page.click('#knShareButton');
    await expect(page.locator('#knShareDialog')).toBeVisible();

    await expect(page.locator('input[name="knShareVisibility"][value="unlisted"]')).toBeChecked();
    await expect(page.locator('#knShareLinkRow')).toBeVisible();
    await expect(page.locator('#knShareLinkInput')).toHaveValue(new RegExp(`\\?k=${KUN_ID}$`));
  });

  test('a freshly created kuntras starts private, with the link row hidden', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author) });
    await page.goto('/kuntras/');
    await expect(page.locator('#knFeed')).toBeVisible();
    page.once('dialog', (d) => d.accept('Brand new kuntras'));
    await page.click('#knNewButton');
    await expect(page.locator('#knBuilder')).toBeVisible();

    await page.click('#knShareButton');
    await expect(page.locator('input[name="knShareVisibility"][value="private"]')).toBeChecked();
    await expect(page.locator('#knShareLinkRow')).toBeHidden();
  });

  test('switching to unlisted reveals the link, and it persists to a fresh fetch', async ({ page }) => {
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author), db: databaseWithPublished('private') });
    await page.goto('/kuntras/');
    await page.click(`.cc-card[data-id="${KUN_ID}"] a`);
    await page.click('#knShareButton');
    await page.check('input[name="knShareVisibility"][value="unlisted"]');
    await expect(page.locator('#knShareLinkRow')).toBeVisible();
    await expect(page.locator('#knShareLinkInput')).toHaveValue(new RegExp(`\\?k=${KUN_ID}$`));

    // Verified through a fresh fetch, not DOM trust -- the same convention
    // kuntras.spec.mjs's own reordering test already established.
    await page.click('#knShareClose');
    await page.click('#knBackButton');
    await expect(page.locator(`.cc-card[data-id="${KUN_ID}"]`)).toContainText('Unlisted');
  });

  test('copying the link puts the exact ?k= URL on the clipboard', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.author), db: databaseWithPublished('public') });
    await page.goto('/kuntras/');
    await page.click(`.cc-card[data-id="${KUN_ID}"] a`);
    await page.click('#knShareButton');
    await page.click('#knShareCopyButton');
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain(`?k=${KUN_ID}`);
    await expect(page.locator('#knShareCopyStatus')).toContainText('Copied');
  });

  test('a stranger opening this same kuntras through the front door (not a ?k= link) never reaches it -- there is no other door', async ({ page }) => {
    // Not a meaningful client-side assertion beyond "the owner's library
    // never shows someone else's kuntras" -- already covered by
    // fetchMyKuntrasim being scoped to owner_id, and by
    // rls_authorization.sql's own "another reader cannot see the kuntras at
    // all" check. Included here only to document that a stranger's ONLY
    // path to this kuntras is the ?k= link, which the tests above already
    // exercise in full.
    failOnPageError(page);
    await preparePage(page, { session: sessionFor(USERS.ordinary), db: databaseWithPublished('public') });
    await page.goto('/kuntras/');
    await expect(page.locator('#knFeed')).toContainText('No kuntrasim yet');
  });
});
