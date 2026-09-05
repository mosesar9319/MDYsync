# DafSync regression tests

Playwright is this repo's test runner as of the Cloud Chabura Phase 1 baseline.
Before this there was none: changes were verified with throwaway scripts that
left no coverage behind, so every refactor started from zero confidence.

## Running

```bash
cd MDYsync
npm install                 # first time only
npx playwright install chromium   # only if Chromium is not already provisioned
npm test                    # both projects (desktop + mobile)
npm run test:desktop
npm run test:mobile
npm run test:ui             # interactive runner
```

`npm test` starts its own static server (`tests/static-server.mjs`, zero
dependencies) on port 8941 and shuts it down afterwards. Set `PORT` to change it.
No build step, no Netlify CLI, and no network access is required.

## What these tests do and do not prove

**They cover client behaviour**: rendering, feed views and pagination, reply and
reaction and follow and report flows, mention eligibility, error and empty
states, and the Select Text word-range engine.

**They do NOT prove authorization.** `tests/fixtures/supabase-stub.js` replaces
the vendored supabase-js with an in-memory PostgREST-shaped fake, and it answers
every query as a fully trusted caller. It has no Row Level Security. A green run
says the UI behaves; it says nothing about whether the database would actually
permit the same operation.

Authorization must be proven separately, against the real database, exercising
`anon`, ordinary `authenticated`, author, and admin roles — including direct
`/rest/v1/rpc/...` calls that bypass the UI entirely. That is Phase 2 work and
belongs in SQL, not here.

## Layout

| Path | Purpose |
|---|---|
| `playwright.config.mjs` (repo root of `MDYsync/`) | Projects (`desktop` 1440×900, `mobile` Pixel 7), web server, timeouts |
| `tests/static-server.mjs` | Zero-dependency static server rooted at `MDYsync/`, matching `netlify.toml`'s publish dir |
| `tests/support/harness.mjs` | `preparePage()` — stub injection, fixture seeding, `/api/*` and font route stubbing |
| `tests/fixtures/supabase-stub.js` | In-memory supabase-js replacement (served in place of the vendored file) |
| `tests/fixtures/dataset.mjs` | Personas and the fixture database |
| `tests/chaburah/feed.spec.mjs` | Cloud Chabura home (`/chaburah/`): views, filters, URL state, pagination, cards, actions, Today's Daf |
| `tests/chaburah/thread.spec.mjs` | Note dialog on `/browse/`: replies, nesting, reactions, follows, mentions, reports, signed-out |
| `tests/functions/link-preview.test.mjs` | SSRF defences on the link-preview fetcher — run with `npm run test:functions` (node --test), NOT Playwright: nothing in that suite can reach a Netlify function |
| `tests/chaburah/scale.spec.mjs` | Query counts and DOM size at 320 and 1,000 replies |
| `tests/chaburah/a11y.spec.mjs` | WCAG 2.2 AA checks that can be made mechanical; see `docs/ACCESSIBILITY.md` for what they cannot cover |
| `tests/chaburah/thread-reader.spec.mjs` | Cloud Chabura thread reader (`/chaburah/thread/`): source context, reply tree, permalinks, composer, answers, edit/delete, outline, search, keyboard, scale, mobile |
| `tests/chaburah/summary.spec.mjs` | Generated summaries and related discussions: labelling, citations, withdrawn points, catch-up, and every failure path leaving the thread readable |
| `tests/functions/chabura-summary.test.mjs` | What the summary function lets reach a model, and when it generates at all — run with `npm run test:functions`, for the same reason as the link-preview tests |
| `tests/notes/select-text.spec.mjs` | Reading order, multi-ref selection runs, saved `word_ranges` payload |
| `tests/player/controls-autohide.spec.mjs` | The player's control bar auto-hide, from the reader's side: it must not fade out from under a pointer resting on it (which swallowed the press and was reported three times as "the 1x button does nothing"), must not fade behind an open speed menu, must still hide once the pointer leaves, and must not be pinned open by a touch |
| `tests/player/speed.spec.mjs` | The video player's playback-speed control: its whole pill is pressable (hit-tested per point, chevron included — the rest of this file drives the `<select>` programmatically and so cannot see an unpressable control), and the chosen rate survives a new video/daf load instead of `HTMLMediaElement.load()`'s silent reset to 1x going unnoticed |
| `tests/player/scan-highlight.spec.mjs` | DafScan's "word being spoken right now" highlight is a merged blue bar (matching the Vilna page and video overlay), not the old per-word yellow box; its click-to-jump targets are one region per phrase (matching the Vilna page's own click regions), not one oversized box per word |

## Writing a test

```js
import { test, expect } from '@playwright/test';
import { preparePage } from '../support/harness.mjs';
import { USERS } from '../fixtures/dataset.mjs';

test('example', async ({ page }) => {
  await preparePage(page, { user: USERS.ordinary });  // or { user: null } for signed out
  await page.goto('/chaburah/');
  await expect(page.locator('.cc-card').first()).toBeVisible();
});
```

`preparePage` options:

- `user` — a persona from `USERS`, or `null` for signed out.
- `db` — a database from `buildDatabase()`, mutated first if a test needs extra rows.
- `control.failures` — inject a server error, keyed `"table:operation"`
  (e.g. `{ 'comments:insert': { message: '...' } }`), to exercise failure paths.
- `control.rpc` — handlers for `client.rpc(name, params)`.

Assert what was written with `readTestCalls(page)`, which returns every insert,
update, delete and rpc the page issued.

## Gotchas worth knowing before you debug one

- **`state` is not `window.state`.** `app.js` declares `const state` at the top
  level of a classic script, so it is a global *lexical* binding. Inside
  `page.evaluate` reference it bare (`state.dafRef`), never `window.state`.
- **Segment refs use a dot, not a colon**: `Chullin 89a.1`. They are built as
  `` `${data.sectionRef}.${index + 1}` `` in `fetchSefariaParagraphs`.
- **Hebrew word boxes run right to left.** In a page-map fixture, word index 0
  is the *rightmost* box in its row (`vilnaReadingOrder` sorts `y` ascending then
  `x` descending). Laying a fixture out left-to-right silently inverts every
  reading-order expectation.
- **Third-party requests are stubbed, not merely blocked.** If a new `/api/...`
  call appears, add it to `API_RESPONSES` in the harness; unstubbed routes return
  404 on purpose so they show up rather than hanging.
- **The note dialog lives on `/browse/`, not `/chaburah/`.** Since Prompt 3 the
  Cloud Chabura home no longer loads `app.js` or `notes.js` at all, so a spec that
  drives `window.DafNotes` has to open a reading page.
- **`.order()` chains are tie-breakers, not passes.** The stub applies every
  `.order()` in one comparator, matching PostgREST. Sorting once per call (which
  it used to do) lets the last call win outright and silently breaks
  `(last_activity_at desc, id desc)` keyset ordering.
- **`.or()` takes a comma-separated LIST**, not one condition. The stub splits at
  the top level, parses `and(...)`/`or(...)` groups, and *throws* on a leaf that
  still contains a comma or a paren — because swallowing the remainder into the
  comparison value makes a broken filter look like a passing test. That is exactly
  how a mis-parsed keyset cursor first let its own boundary row through twice.

- **The stub models a few server-side derivations, and only a few.** A comment
  insert comes back with `root_comment_id`, `depth` and `activity_sequence`
  filled in, and a soft delete redacts the body -- because the thread reader
  reads those straight off the row it just wrote, and without them a spec
  asserting nesting would pass on a lie. They MIRROR the triggers in
  `20260902190000_cloud_chabura_thread_foundation.sql`; they do not prove them.
  That proof is `supabase/tests/rls_authorization.sql`, against a real Postgres.
- **The stub enforces the `comments` primary key.** Added because a feature
  depends on it: the thread composer sends a client-generated id so a retry
  after a timeout collides (23505) rather than posting a second reply. Without
  the constraint modelled, that safety net could not be tested at all.
- **Query counts are measured from the stub, not the network.** The stub is
  in-page, so no request leaves the browser and counting HTTP traffic would
  measure zero and pass regardless. `readTestQueries(page)` returns the reads the
  stub actually served, which is the only way a "no N+1" assertion means
  anything.
- **A scripted interaction cannot see a control that has become unreachable.**
  `selectOption`, `.click()` on a locator, and setting `.value` all act on the
  element directly: they neither wait where a reader waits nor hit-test where a
  reader presses. The player's control bar auto-hides on a timer, so a control
  can be gone by the time anyone actually presses it -- a defect a whole spec
  file for that control stayed green through twice. When the question is "can a
  reader work this?", drive `page.mouse` at real coordinates, wait the real
  delay, and assert on `document.elementFromPoint` / `document.activeElement`.
- **Never assert authorization here.** The stub answers every query as a trusted
  caller. A spec that "proves" a private thread is hidden is proving nothing --
  remove the row from the fixture to model what RLS returns, and put the real
  question in the SQL suite.

### Query operators the stub supports

`eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `is`, `not(col, op, value)`,
`ilike`, `textSearch` (over `body` + `selected_text`, not a real tsvector),
`or(expression)`, `order`
(chained), `limit`, `single`, `maybeSingle`, and the `insert` / `upsert` /
`update` / `delete` mutations. `upsert` keys on whichever of `user_id`,
`ref_key`, `variant`, `note_id`, `target_type`, `target_id` the payload carries. Anything else is unimplemented — add it rather than working around it,
and make it throw on input it cannot represent.
