import { test, expect } from '@playwright/test';
import { preparePage } from '../support/harness.mjs';

// "Search in Shas" (shas-search.js) -- the context menu's last item, on top
// of Sefaria's own Talmud Bavli text search (POST /api/search-wrapper on
// www.sefaria.org, confirmed directly against the real endpoint while
// building this). Every ref/excerpt shown comes straight from Sefaria's own
// response; nothing here invents or infers a reference.

// A response shaped exactly like Sefaria's real one (confirmed live): three
// versions of the SAME ref (must dedupe to one), plus a second, distinct ref.
function sefariaSearchFixture() {
  return {
    hits: {
      total: 4102,
      hits: [
        {
          _source: { ref: 'Chullin 89a:1', heRef: 'חולין פט א:א', version_priority: 1, categories: ['Talmud', 'Bavli', 'Seder Kodashim'], path: 'Talmud/Bavli/Seder Kodashim/Chullin' },
          highlight: { exact: ['plain edition <b>ארבעה</b> ראשי שנים'] },
        },
        {
          _source: { ref: 'Chullin 89a:1', heRef: 'חולין פט א:א', version_priority: 0, categories: ['Talmud', 'Bavli', 'Seder Kodashim'], path: 'Talmud/Bavli/Seder Kodashim/Chullin' },
          highlight: { exact: ['vocalized <b>אַרְבָּעָה</b> רָאשֵׁי שָׁנִים'] },
        },
        {
          _source: { ref: 'Chullin 89a:1', heRef: 'חולין פט א:א', version_priority: 2, categories: ['Talmud', 'Bavli', 'Seder Kodashim'], path: 'Talmud/Bavli/Seder Kodashim/Chullin' },
          highlight: { exact: ['community <b>ארבעה</b> ראשי שנים'] },
        },
        {
          _source: { ref: 'Rosh Hashanah 2a:3', heRef: 'ראש השנה ב א:ג', version_priority: 0, categories: ['Talmud', 'Bavli', 'Seder Moed'], path: 'Talmud/Bavli/Seder Moed/Rosh Hashanah' },
          highlight: { exact: ['<b>ארבעה</b> ראשי שנים הם'] },
        },
      ],
    },
  };
}

async function stubSearch(page, body, status = 200) {
  await page.route('**/api/search-wrapper**', (route) => route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  }));
}

test.describe('barePhrase — query cleaning', () => {
  test.beforeEach(async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/browse/');
  });

  test('strips nikud and cantillation, keeps the bare letters', async ({ page }) => {
    const out = await page.evaluate(() => barePhrase('אַרְבָּעָה רָאשֵׁי שָׁנִים'));
    expect(out).toBe('ארבעה ראשי שנים');
  });

  test('punctuation between words becomes a space, not nothing -- words never glue together', async ({ page }) => {
    const out = await page.evaluate(() => barePhrase('מן־הבהמה, הטהורה.'));
    expect(out).toBe('מן הבהמה הטהורה');
  });

  test('collapses repeated whitespace and trims the ends', async ({ page }) => {
    const out = await page.evaluate(() => barePhrase('  ארבעה   ראשי  '));
    expect(out).toBe('ארבעה ראשי');
  });
});

test.describe('sefariaSnippetToSafeHtml — rendering an external snippet safely', () => {
  test.beforeEach(async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/browse/');
  });

  test('Sefaria’s own <b> markers become real, attribute-less <mark> elements', async ({ page }) => {
    const html = await page.evaluate(() => sefariaSnippetToSafeHtml('אבא <b>ארבעה</b> ראשי'));
    expect(html).toBe('אבא <mark class="shas-search-match">ארבעה</mark> ראשי');
  });

  test('anything else in the snippet is escaped, never live markup -- a hostile snippet cannot inject a script', async ({ page }) => {
    const rendered = await page.evaluate((snippet) => {
      const div = document.createElement('div');
      div.innerHTML = sefariaSnippetToSafeHtml(snippet);
      return { html: div.innerHTML, scripts: div.querySelectorAll('script').length, text: div.textContent };
    }, '<script>window.__pwned = true</script> <b>match</b>');
    expect(rendered.scripts).toBe(0);
    expect(rendered.text).toContain('<script>window.__pwned = true</script>');
    expect(rendered.html).toContain('<mark class="shas-search-match">match</mark>');
  });
});

test.describe('dedupeShasHits — one result per ref', () => {
  test.beforeEach(async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/browse/');
  });

  test('collapses several versions of the same ref into the lowest version_priority', async ({ page }) => {
    const refs = await page.evaluate((fixture) => {
      const deduped = dedupeShasHits(fixture.hits.hits);
      return deduped.map((hit) => `${hit._source.ref}#${hit._source.version_priority}`);
    }, sefariaSearchFixture());
    expect(refs).toEqual(['Chullin 89a:1#0', 'Rosh Hashanah 2a:3#0']);
  });
});

test.describe('the Search in Shas dialog', () => {
  test.beforeEach(async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/browse/');
  });

  test('loading, then results — masechta/daf/amud label, excerpt with the match marked, and an honest truncation note', async ({ page }) => {
    await stubSearch(page, sefariaSearchFixture());
    const loadingText = await page.evaluate(async () => {
      const opened = window.ShasSearch.openWith('ארבעה');
      const text = document.getElementById('shasSearchBody').textContent;
      await opened;
      return text;
    });
    expect(loadingText).toContain('Searching');

    const dialog = page.locator('#shasSearchDialog');
    await expect(dialog).toBeVisible();
    const results = page.locator('.shas-search-result');
    await expect(results).toHaveCount(2); // deduped from 4 hits
    await expect(results.nth(0).locator('.shas-search-result-loc')).toHaveText('Chullin 89a');
    await expect(results.nth(0).locator('mark.shas-search-match')).toHaveText('אַרְבָּעָה');
    await expect(results.nth(1).locator('.shas-search-result-loc')).toHaveText('Rosh Hashanah 2a');
    await expect(page.locator('.shas-search-result-note')).toContainText('top 2 of 4102');
  });

  test('empty state', async ({ page }) => {
    await stubSearch(page, { hits: { total: 0, hits: [] } });
    await page.evaluate(() => window.ShasSearch.openWith('שדגכגכ'));
    await expect(page.locator('#shasSearchBody')).toContainText('No matches found in Shas');
  });

  test('error state', async ({ page }) => {
    await stubSearch(page, { error: 'boom' }, 500);
    await page.evaluate(() => window.ShasSearch.openWith('ארבעה'));
    await expect(page.locator('#shasSearchBody')).toContainText('Could not reach');
  });

  test('a stray non-Hebrew selection never reaches the network -- shows a toast instead', async ({ page }) => {
    let searchCalled = false;
    await page.route('**/api/search-wrapper**', (route) => { searchCalled = true; route.fulfill({ status: 200, body: '{}' }); });
    await page.evaluate(() => window.ShasSearch.openWith('123 --- '));
    await expect(page.locator('#toast')).toContainText('No Hebrew text');
    expect(searchCalled).toBe(false);
  });

  // Reported directly: always failing on the live site ("Could not reach
  // Sefaria's search just now") despite working from a plain curl request --
  // the textbook signature of a CORS preflight a browser sends (and curl
  // never does) getting rejected. Confirmed directly against the real
  // endpoint: its OPTIONS response carries access-control-allow-origin but
  // no Access-Control-Allow-Headers/-Methods at all, so a browser refuses
  // the preflight for any POST whose Content-Type isn't one of the three
  // CORS-"simple" values -- application/json is not one of them,
  // text/plain is. The server parses the JSON body identically either way
  // (confirmed directly too), so this is a pure client-side fix: staying
  // out of preflight territory entirely, not asking Sefaria for anything.
  test('the request never triggers a CORS preflight -- Content-Type stays text/plain, not application/json', async ({ page }) => {
    let capturedContentType;
    await page.route('**/api/search-wrapper**', (route) => {
      capturedContentType = route.request().headers()['content-type'];
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ hits: { total: 0, hits: [] } }) });
    });
    await page.evaluate(() => window.ShasSearch.openWith('ארבעה'));
    expect(capturedContentType).toBe('text/plain');
  });
});

test.describe('the context menu — Search in Shas', () => {
  test.beforeEach(async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/browse/');
  });

  test('opens the dialog and searches with the resolved word', async ({ page }) => {
    await stubSearch(page, { hits: { total: 0, hits: [] } });
    await page.evaluate(() => {
      const target = { source: 'vilna', ref: 'Chullin 89a.1', start: 0, end: 0, text: 'ארבעה', segment: null, runs: [{ ref: 'Chullin 89a.1', start: 0, end: 0 }] };
      const item = buildMenuItems(target).find((i) => i.label && i.label.includes('Search') && i.label.includes('Shas'));
      item.onClick();
    });
    await expect(page.locator('#shasSearchDialog')).toBeVisible();
    await expect(page.locator('#shasSearchQuery')).toHaveText('ארבעה');
  });
});

test.describe('opening a result', () => {
  test.beforeEach(async ({ page }) => {
    await preparePage(page, { user: null });
  });

  test('navigates to /browse/?ref=<daf>&hlRef=<segment>, and the destination flashes and scrolls to that exact segment', async ({ page }) => {
    // Overrides the harness's own generic /api/get-results-file stub (a
    // word-boxes fixture, 200 for ANY path) with a 404 for by-ref/ lookups
    // specifically -- fetchServerAlignment (app.js) only checks response.ok,
    // so the harness's default otherwise tricks loadDaf into thinking a
    // real server alignment exists for this ref and diverting into that
    // branch instead of the plain-Sefaria-text one this scenario is about
    // (an ordinary, never-synced Shas ref). Not a real bug in loadDaf --
    // an unsynced ref genuinely 404s there in production.
    await page.route('**/api/get-results-file**by-ref%2F**', (route) => route.fulfill({ status: 404, body: '' }));
    await page.goto('/browse/');
    await stubSearch(page, sefariaSearchFixture());
    await page.evaluate(() => window.ShasSearch.openWith('ארבעה'));
    await expect(page.locator('.shas-search-result').first()).toBeVisible();

    await Promise.all([
      page.waitForURL(/\/browse\/\?.*hlRef=/),
      page.locator('.shas-search-result').first().click(),
    ]);

    const url = new URL(page.url());
    expect(url.searchParams.get('ref')).toBe('Chullin 89a');
    expect(url.searchParams.get('hlRef')).toBe('Chullin 89a:1');
    expect(url.searchParams.get('hlQuery')).toBe('ארבעה');

    // The destination page's own bootstrap (app.js) needs its stubbed
    // /api/sefaria response (see the harness's own Chullin 89a fixture) to
    // resolve before state.segments exists to search for the flash target.
    await expect.poll(() => page.evaluate(() => state.segments?.length || 0)).toBeGreaterThan(0);
    const flashed = page.locator('mark.daf-search-flash');
    await expect(flashed).toHaveCount(1);
    await expect(flashed).toContainText('ארבעה');
    // The flashed segment's own span, not some unrelated one.
    await expect(page.locator('.daf-segment mark.daf-search-flash')).toHaveCount(1);

    // Text view, not the Vilna page -- the whole point of loadDaf's own
    // Sefaria-fallback path is that it works with no Vilna page sync at all.
    await expect(page.locator('.daf-card')).toHaveAttribute('data-daf-view', 'text');

    const banner = page.locator('.shas-search-back-banner');
    await expect(banner).toContainText('ארבעה');
    await Promise.all([
      page.waitForURL((candidate) => !candidate.search.includes('hlRef')),
      banner.locator('.shas-search-back-button').click(),
    ]);
    expect(new URL(page.url()).searchParams.get('hlRef')).toBeNull();
  });
});
