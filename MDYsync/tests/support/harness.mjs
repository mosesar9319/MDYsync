// Shared Playwright setup for the DafSync regression suite.
//
// Every test goes through preparePage() before navigating. It does three
// things, all of which exist so a test run can never touch production:
//   1. Serves tests/fixtures/supabase-stub.js in place of the vendored
//      supabase-js, so no request ever reaches the real Supabase project.
//   2. Seeds the in-page fixture database and session before any page script
//      runs (addInitScript runs before <script> tags execute).
//   3. Fulfils the site's own /api/* Netlify Function routes locally, since
//      the static test server does not run functions and an unstubbed call
//      would otherwise hit the live deployment.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildDatabase, sessionFor } from '../fixtures/dataset.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STUB_SOURCE = readFileSync(join(HERE, '..', 'fixtures', 'supabase-stub.js'), 'utf8');

// Minimal, deterministic stand-ins for the Netlify Functions the reading pages
// call on load. Real function behaviour is out of scope for a client-side
// regression suite; what matters is that the page gets a well-formed answer
// instead of a network error that would mask a real UI defect.
const API_RESPONSES = {
  '/api/list-synced-dapim': { Chullin: { 89: ['a', 'b'] } },
  '/api/get-catalog': { videos: [] },
  // fetchSefariaParagraphs() builds each paragraph's ref as
  // `${data.sectionRef}.${index + 1}` -- a DOT, which is why segment_ref values
  // in this project look like "Chullin 89a.1" and not "Chullin 89a:1".
  // sectionRef must therefore be present or every word-range lookup misses.
  '/api/sefaria': {
    ref: 'Chullin 89a',
    sectionRef: 'Chullin 89a',
    heRef: 'חולין פט א',
    he: [
      'תנו רבנן ארבעה ראשי שנים הם באחד בניסן ראש השנה למלכים ולרגלים ובאחד באלול',
      'ראש השנה למעשר בהמה רבי אלעזר ורבי שמעון אומרים באחד בתשרי',
    ],
    text: [
      'The Sages taught: There are four new years.',
      'The new year for animal tithe; Rabbi Elazar and Rabbi Shimon say: On the first of Tishrei.',
    ],
  },
  // The Today's Daf lookup (app.js's fetchTodaysDafRef, index.html's
  // loadTodaysDaf) goes through this dedicated proxy function rather than
  // calling www.sefaria.org directly -- audit finding F-4, closed by
  // netlify/functions/sefaria-calendars.mjs. Stubbed here so the suite stays
  // deterministic and offline.
  // The Cloud Chabura thread reader fetches this daf's word boxes to run the
  // anchor-drift heuristic (notes-format.js anchorMayHaveShifted). The fixture
  // note NOTE_IDS.singleWordRange claims words 3..6 of Chullin 89a.1, and this
  // map supplies exactly four boxes for that span -- so the default answer is
  // "no drift". A spec that wants the warning removes a box.
  '/api/get-results-file': {
    wordBoxes: [
      { ref: 'Chullin 89a.1', wordIndex: 3, x: 0.8, y: 0.1, w: 0.05, h: 0.02 },
      { ref: 'Chullin 89a.1', wordIndex: 4, x: 0.7, y: 0.1, w: 0.05, h: 0.02 },
      { ref: 'Chullin 89a.1', wordIndex: 5, x: 0.6, y: 0.1, w: 0.05, h: 0.02 },
      { ref: 'Chullin 89a.1', wordIndex: 6, x: 0.5, y: 0.1, w: 0.05, h: 0.02 },
      { ref: 'Chullin 89a.1', wordIndex: 8, x: 0.4, y: 0.1, w: 0.05, h: 0.02 },
      { ref: 'Chullin 89a.1', wordIndex: 9, x: 0.3, y: 0.1, w: 0.05, h: 0.02 },
      { ref: 'Chullin 89a.1', wordIndex: 10, x: 0.2, y: 0.1, w: 0.05, h: 0.02 },
      { ref: 'Chullin 89a.1', wordIndex: 11, x: 0.1, y: 0.1, w: 0.05, h: 0.02 },
      { ref: 'Chullin 89a.2', wordIndex: 0, x: 0.8, y: 0.2, w: 0.05, h: 0.02 },
      { ref: 'Chullin 89a.2', wordIndex: 1, x: 0.7, y: 0.2, w: 0.05, h: 0.02 },
      { ref: 'Chullin 89a.2', wordIndex: 2, x: 0.6, y: 0.2, w: 0.05, h: 0.02 },
    ],
  },
  '/api/sefaria-calendars': {
    calendar_items: [
      { category: 'Talmud', title: { en: 'Daf Yomi' }, displayValue: { en: 'Chullin 89' } },
    ],
  },
};

export async function preparePage(page, options = {}) {
  const db = options.db || buildDatabase();
  const session = options.session !== undefined ? options.session : sessionFor(options.user || null);
  const control = options.control || {};

  await page.route('**/vendor/supabase-js.min.js', (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: STUB_SOURCE })
  );

  // Google Fonts (and any other third-party asset) must not be reached from a
  // test run: it makes the suite non-deterministic, slow, and noisy in the
  // console-error assertions. Fulfilled empty rather than aborted so the page
  // sees a successful-but-empty stylesheet and falls back to its own font stack.
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' })
  );

  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = API_RESPONSES[path];
    if (body === undefined) {
      // 404 rather than a hang, and loud enough to notice in a trace if a new
      // API call appears that this harness has not been taught about.
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"unstubbed api route"}' });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  await page.addInitScript(
    ({ dbJson, sessionJson, controlJson }) => {
      window.__DAFSYNC_TEST_DB__ = JSON.parse(dbJson);
      window.__DAFSYNC_TEST_SESSION__ = JSON.parse(sessionJson);
      window.__DAFSYNC_TEST_CONTROL__ = JSON.parse(controlJson);
      window.__DAFSYNC_TEST_CALLS__ = [];
      window.__DAFSYNC_TEST_QUERIES__ = [];
    },
    { dbJson: JSON.stringify(db), sessionJson: JSON.stringify(session), controlJson: JSON.stringify(control) }
  );

  return { db, session, control };
}

// Fails a test on any uncaught page error. Called by specs that assert a page
// loads cleanly; kept opt-in so a spec deliberately exercising a failure path
// can choose not to use it.
export function failOnPageError(page, errors = []) {
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push('console.error: ' + message.text());
  });
  return errors;
}

export async function readTestCalls(page) {
  return page.evaluate(() => window.__DAFSYNC_TEST_CALLS__ || []);
}

// Every read the page issued, as table names in order. Used by the scale specs
// to measure query counts: the supabase stub is in-page, so counting HTTP
// requests measures nothing at all.
export async function readTestQueries(page) {
  return page.evaluate(() => window.__DAFSYNC_TEST_QUERIES__ || []);
}

export async function resetTestQueries(page) {
  await page.evaluate(() => { window.__DAFSYNC_TEST_QUERIES__ = []; });
}
