# Cloud Chabura redesign — Phase 1 baseline audit

**Date:** 2026-09-02
**Branch:** `claude/chullin-89-sync-hold-pm1aqf` (cut from `origin/main` @ `91be7d6`)
**Scope:** Prompt 1 of `DAFSYNC_CLOUD_CHABURA_CLAUDE_HANDOFF_20260902.md` —
inspection, measurement and regression baseline. **No Cloud Chabura UI redesign.**
Updated in a follow-on commit to also close four independent, low-risk items this
audit itself identified as needing no redesign (§7 recommendation 3) — those four
DO include a small, reviewed production schema change (grants + one index; see
§2.4/§2.5), applied via a committed migration, not a UI prototype shortcut.

Everything below was verified by direct inspection of the live database and the
current working tree on the date above. Where this audit contradicts an earlier
document, this audit is the newer observation — but re-verify before Phase 2,
because the live schema remains the only source of truth (see F-1).

---

## 1. What changed in this phase

| Added | Why |
|---|---|
| `@playwright/test` as a devDependency, `playwright.config.mjs`, `npm test` | The repo had **no test runner at all**. The handoff's Prompt 1 says to use "the repo's chosen runner"; there wasn't one, so this phase chooses and commits Playwright. |
| `tests/` — 41 specs × 2 projects (desktop + mobile) = **82 passing tests** | Persistent regression coverage for the feed, the note/reply thread, and the Select Text engine. |
| `tests/static-server.mjs` | Zero-dependency static server so `npm test` needs no network and no extra package. |
| `docs/baseline/*.png` | Desktop, narrow-desktop and mobile screenshots of today's `/chaburah/`. |
| `supabase/migrations/20260902180000_tighten_grants_and_feed_index.sql` | First committed migration (audit F-1). Tightens function grants, adds the feed's missing index — see §2.4/§2.5. |
| `netlify/functions/sefaria-calendars.mjs` | Closes F-4: proxies the Today's Daf calendar lookup instead of calling `sefaria.org` directly from the browser. |
| This document | The written audit. |

Nothing in `app.js`, `notes.js`, `chaburah.js`, `styles.css` or any page was modified.

---

## 2. Live Supabase schema (verified 2026-09-02)

Project `cyexvsymuivvvhvpeber` (`MDYsync`), Postgres 17.6, region `us-east-2`.

### 2.1 Tables and row counts

RLS is **enabled on all 12 tables**. Row counts matter for Phase 2 sizing:

| Table | Rows | Notes |
|---|---:|---|
| `profiles` | 4 | `id`, `email`, `display_name`, `is_admin`, `created_at` |
| `line_notes` | **3** | root discussions |
| `comments` | **2** | replies |
| `reactions` | 4 | |
| `thread_follows` | 5 | |
| `notifications` | 2 | |
| `highlights` | 3 | |
| `reports` | **0** | |
| `progress` | 33 | |
| `preferences` | 1 | |
| `favorites` | 0 | |
| `series` | 0 | unused |

> **This is the single most important number in this audit.** The production
> Cloud Chaburah corpus is **3 root notes and 2 replies across 4 accounts**. Every
> scale-driven requirement in the redesign plan — keyset pagination, branch
> virtualization, 1,000-reply fixtures, cached counters, realtime fan-out, AI
> catch-up summaries — is being designed against traffic that does not exist yet.
> That does not make the plan wrong, but it should change the *order* of work.
> See §6.1.

### 2.2 Column facts that constrain the plan

- `line_notes.segment_ref` values are **`Chullin 2a.1`** — a **dot**, not a colon.
  Built in `fetchSefariaParagraphs` as `` `${data.sectionRef}.${index + 1}` ``.
  Any fixture, migration or parser assuming `:` is wrong.
- `line_notes.word_ranges jsonb` and `highlights.word_ranges jsonb` exist, both
  CHECKed to be a non-empty JSON array when present.
- `line_notes` has **no** `title`, `status`, `edited_at`, `deleted_at`,
  `last_activity_at`, `highlighted_comment_id`, `reply_count` or
  `participant_count`. `comments` has **no** `root_comment_id`, `depth`,
  `activity_sequence`, `edited_at`, `deleted_at`, `quoted_comment_id`.
  All of those are Phase 2 additions, exactly as the plan assumes.
- `body` on both tables is CHECKed to 1–2000 characters.
- `category` is an 18-value CHECK on `line_notes` only.
- `reactions` has a UNIQUE index on `(user_id, target_type, target_id, reaction_type)`
  — which is what permits one user to hold several reaction types on one target.

### 2.3 RLS policies

Verified via `pg_policies`. Summary of the load-bearing ones:

- `line_notes`: `public_read` (`NOT hidden AND NOT is_private`), `author_read_own`,
  `admin_read` (`is_admin() AND NOT is_private` — admins cannot read private notes),
  `insert` (`auth.uid() = author_id AND (is_private OR can_post_publicly())`),
  `update`/`delete` (author or admin).
- `comments`: same shape, and `comments_insert`'s `WITH CHECK` additionally requires
  the parent note to be public and not hidden, and any `parent_comment_id` to belong
  to the **same note** (cross-thread parents are already impossible).
- `reactions`, `thread_follows`: insert requires the target note to be public and
  not hidden; reads are owner-only or public-target-only.
- `reports`: reporter-only read, `is_admin()` read. Never publicly visible.
- `profiles`: `profiles_select_own` **only** — there is no public profile read at
  all today. This is why mentions are limited to thread participants (§4.4).

### 2.4 Functions, triggers, grants — and the security question the prior handoff left open

All 10 `public` functions are `SECURITY DEFINER` **and all 10 set `search_path=public`**.

The previous handoff flagged as unresolved whether the three admin RPCs actually
re-check admin status internally, or merely rely on the UI hiding the button.
**Resolved: they do enforce it.** Verified source:

```sql
-- resolve_report / set_note_hidden / set_comment_hidden all begin with:
if not public.is_admin() then
  raise exception 'only admins can ...' using errcode = '42501';
end if;
```

`is_admin()` reads `profiles.is_admin` for `auth.uid()` and `coalesce(..., false)`,
so an anonymous caller (where `auth.uid()` is NULL) is rejected.

Supporting facts:

- `anon` and `authenticated` **do** hold EXECUTE on those three RPCs (directly, and
  on the other seven via `PUBLIC`), so they are reachable at `/rest/v1/rpc/<name>`.
  The internal `is_admin()` check is therefore the *only* thing stopping them — and
  it is present and correct.
- `has_schema_privilege('anon'|'authenticated','public','CREATE')` is **false** for
  both, so `search_path=public` cannot be subverted by an attacker creating a
  shadowing object in `public`.

**Conclusion: the "Public Can Execute SECURITY DEFINER Function" advisory was real
but not exploitable.** Not a live vulnerability — but defence-in-depth was free, so
**this is now fixed**: `supabase/migrations/20260902180000_tighten_grants_and_feed_index.sql`
revokes `PUBLIC` execute on the five trigger-only functions and narrows the three
admin RPCs to `authenticated` only (dropping `anon`). `is_admin()`/`can_post_publicly()`
are deliberately left alone — see the migration's own header for why revoking those
would break RLS. Re-run `get_advisors` confirms the five trigger-function warnings
are gone; the remaining ones are exactly the ones left in place on purpose, plus the
item below.

Still open, and **not** fixable from here: **leaked-password protection is
disabled** in Supabase Auth. No Supabase MCP tool exposes Auth provider settings —
this needs a one-click dashboard toggle (Authentication → Policies → Leaked
Password Protection).

Triggers: `line_notes_before_update` → `line_notes_guard_hidden` (silently reverts a
non-admin's attempt to change `hidden`, and stamps `updated_at`);
`{line_notes,comments}_validate_mentions` → `validate_mentions` (max 5 mentions,
each must exist in `auth.users`); `{line_notes,comments}_notify_after_insert`.

### 2.5 Indexes

Existing: `line_notes` on `author_id`, `body_tsv` (GIN), `category`, `daf_ref_key`,
`segment_ref`; `comments` on `author_id`, `body_tsv` (GIN), `note_id`,
`parent_comment_id`; `reactions` on target + the UNIQUE key; `notifications` on
`(user_id, created_at)`; `reports` on `status` and target.

**Gap, now fixed:** every Cloud Chaburah view orders by `created_at desc` and there
was no `created_at` index on `line_notes`. Free at 3 rows, but the first thing that
would have hurt.
`supabase/migrations/20260902180000_tighten_grants_and_feed_index.sql` adds
`line_notes_public_feed_idx`, a partial index on `(created_at desc) where not hidden
and not is_private` — matching `chaburahBaseQuery`'s exact predicate. Phase 2's
`last_activity_at` column should replace rather than duplicate this; drop it there.

---

## 3. Client architecture as it exists today

### 3.1 `/chaburah/` is the browse page with a feed bolted on

`chaburah/index.html` is 1,160 lines and carries `<body data-page="browse">`. It has
**two `<main>` elements**:

| Line | Element | Contents |
|---|---|---|
| 505 | `<main hidden>` | The **entire Interactive Daf workspace** — setup strip, video frame, daf card, phrase editor. 318 DOM elements. Never visible. |
| 873 | `<main class="chaburah-main">` | The actual Cloud Chaburah UI. **27 lines.** |

The hidden `<main>` exists so that `app.js`, `player-chrome.js`, `daf-context-menu.js`
and `highlights.js` find the element IDs they expect, and so `window.DafNotes.open()`
has a `#noteDialog` to show. It is scaffolding, not content.

Because `data-page="browse"` sets `state.browseMode = true`, the page also runs
app.js's browse boot path, which fires two network requests for UI nobody can see:

- `/api/list-synced-dapim` (`ensureSyncedDapimLoaded`, app.js:7371)
- `https://www.sefaria.org/api/calendars` (`fetchTodaysDafRef`, app.js:1334) —
  **called directly, not through the `/api/sefaria` proxy** that every other
  Sefaria read in the codebase uses.

### 3.2 Script load order (load-bearing)

```
vendor/supabase-js.min.js → auth.js → app.js → account-features.js → notes.js
→ highlights.js → daf-context-menu.js → player-chrome.js → chaburah.js
→ nav.js → collapse.js
```

`chaburah.js` must load after `notes.js` and `app.js` because it consumes their
globals directly (§3.4).

### 3.3 DOM contract of the current feed

| ID / class | Role |
|---|---|
| `#chaburahViewSwitch` | container of `button[data-view]` — `latest`, `this-daf`, `this-masechta`, `following`, `most-helpful`, `unanswered` |
| `#chaburahCategoryFilter` | `<select>`, populated from `CATEGORY_TYPES` |
| `#chaburahFeedList` | feed container |
| `#chaburahLoadMoreButton` | pagination |
| `.chaburah-card[data-id][data-segment-ref][data-daf-ref-key]` | one card |
| `.chaburah-view-thread` | opens `#noteDialog` via `window.DafNotes.open` |

Styling is only 16 lines (`styles.css` 1699–1714) plus `watch-theme.css`'s palette.

### 3.4 Coupling — the thing Phase 3 must plan for

`chaburah.js` (244 lines) depends on **un-namespaced globals owned by other files**:

- From `notes.js`: `renderFormattedBody`, `renderTimestampPill`, `categoryByKey`,
  `CATEGORY_TYPES`, `formatNoteTime`, `demoPillHtml`, and `window.DafNotes.open`.
- From `app.js`: `state` (it **mutates `state.dafRef`** before opening a thread),
  `escapeHtml`, `parseDafRef`, `refKey`, `$`.
- From `auth.js`: `window.DafSyncAuth`.

Only `DafNotes` and `DafNotesComposer` are namespaced; everything else is a bare
global. Note also that `const state` is a top-level `const` in a classic script, so
it is a global **lexical** binding and is **not** reachable as `window.state`.

---

## 4. Baseline measurements

Captured against the local static server with the fixture dataset, signed in.

| View | Load | Requests | DOM nodes | Hidden-`main` nodes | `<main>` | `<h1>` | Horizontal overflow |
|---|---:|---:|---:|---:|---:|---:|---|
| `/chaburah/` desktop 1440 | 695 ms | 22 | 996 | 318 (32%) | 2 | 2 | none |
| `/chaburah/` desktop 1100 | 666 ms | 22 | 996 | 318 | 2 | 2 | none |
| `/chaburah/` mobile (Pixel 7) | 686 ms | 22 | 996 | 318 | 2 | 2 | none |
| Thread open, **320-reply** fixture | 666 ms | 22 | **11,069** | 318 | 2 | 2 | none |

Screenshots: `docs/baseline/chaburah-{desktop,desktop-narrow,mobile,thread-desktop,thread-mobile}.png`.

The 11,069-node figure is the concrete evidence behind the plan's "do not render
thousands of replies into the DOM at once": the current dialog renders **every**
reply of a thread in one pass, with no pagination or collapsing.

---

## 5. Findings

Ordered by how much they should influence Phase 2/3, not by severity alone.

**F-1 — No SQL under version control.** 24 migrations were applied live via the
dashboard/MCP; none are in the repo. The live database is the only source of truth.
*Action:* Phase 2 must create `MDYsync/supabase/migrations/` and, ideally,
retro-document the existing 24 so schema history stops living only in Supabase.

**F-2 — The feed re-fetches from row 0 on every "Load more."**
`loadChaburahPagedView` requests `chaburahOffset + PAGE_SIZE + 1` rows and slices
locally. Page 5 fetches 101 rows to display 20. Compounding with F-3.
*Action:* keyset pagination in Phase 3, as the plan already specifies.

**F-3 — Ranked views scan and rank client-side.** `most-helpful` and `unanswered`
pull the newest 200 public notes (`CHABURAH_RANK_SCAN_LIMIT`), then count reactions
/ comments in the browser. Notes outside that window can never rank, and both views
silently never paginate (`hasMore` is not computed for them). Honest and documented
in the source, but it is a correctness ceiling, not just a performance one.

**F-4 — FIXED — `fetchTodaysDafRef()` called sefaria.org directly** (app.js:1334),
bypassing any Netlify proxy — and so did an independent second copy in
`index.html`'s inline `loadTodaysDaf()` (the home page's "Today's Daf" hero), not
caught until this fix was underway. It ran on `/chaburah/` for a picker the page
never shows. This mattered for Phase 3 because the plan's Today's Daf panel is
specified to use "the same current-day source already used by DafSync" — which was
this unproxied call.
*Fixed in this phase*: added `netlify/functions/sefaria-calendars.mjs`
(`/api/sefaria-calendars`), mirroring `sefaria.mjs`'s pattern but for the calendar
endpoint, which `sefaria.mjs` itself can't serve (it's hard-tied to the
`/api/v3/texts/<ref>` shape). Both call sites now try the proxy first and fall back
to a direct Sefaria call on failure — the same pattern `fetchSefariaParagraphs`
already used. Verified via Playwright: both `index.html` and `browse/` now issue
only the proxied request, zero direct `sefaria.org` calls, zero console errors.

**F-5 — No request-generation guard.** `renderChaburahFeed()` has no
`AbortController` or request-sequence check, and is additionally wired to
`DafSyncAuth.onChange`. Rapid tab switching, or a sign-in landing mid-flight, can let
a slower earlier response overwrite a newer one. The plan already requires
stale-response protection; this confirms it is a real defect today, not a hypothetical.

**F-6 — Feed state is not in the URL.** Only `?ref=` is read. View, category and
scroll position are lost on back/forward and cannot be shared. Plan §5 requires this.

**F-7 — Drafts do not survive a reload.** An unsent reply *does* survive a rejected
submit (postComment returns early without clearing the textarea — better than
assumed), but nothing is persisted, so a refresh or navigation loses it. Both
behaviours are now locked in by tests so Phase 5 can invert the second one
deliberately.

**F-8 — Generic error handling.** Every feed failure renders the same
"Could not load the feed."; the caught error is discarded entirely (not even logged),
and there is no retry affordance.

**F-9 — Two `<main>` landmarks and two `<h1>`s per page.** The hidden workspace
carries its own. `hidden` keeps the second `<main>` out of the accessibility tree,
so this is a structural/maintenance problem more than an active a11y failure — but
the plan's §13 ("one logical `h1` per page") cannot be satisfied while the page is
built this way.

**F-10 — Note body text is the lowest-contrast element on every card.** Author name
renders bolder and darker than the note's own content (see
`docs/baseline/chaburah-desktop.png`). This inverts the plan's §7 hierarchy — source
and substance before identity — and is a likely WCAG 2.2 AA contrast failure that
should be measured properly in Phase 3.

**F-11 — Category pills are Hebrew-only with English in a `title` attribute.**
Hover-only disclosure fails the plan's own a11y rule; on touch there is no way to
learn what a pill means.

**F-12 — Mobile header consumes ~270 px before any content.** "How it works",
"Back to library", "Notes", the bell and the account email each wrap onto their own
row at 412 px, and a second card's header re-wraps badly when a timestamp pill is
present. Directly at odds with the plan's requirement that Today's Daf be prominent
near the top on mobile.

**F-13 — `/chaburah/` ships the whole Interactive Daf shell and all 11 scripts**
(including `app.js`, ~409 KB, plus `player-chrome.js`, `highlights.js`,
`daf-context-menu.js`) to render a 20-item list, and fires two needless requests
(§3.1). This is the strongest technical argument for the plan's dedicated-page
refactor.

**F-14 — Server-side mention validation is weaker than the client rule.**
`validate_mentions()` enforces only "≤5 mentions" and "each user exists in
`auth.users`". The "participants in this thread only" rule is **client-side only**
(`getMentionableForNote`). A crafted request could mention any known user id. Impact
today is low (a notification row), but the plan's Prompt 5 asserts "server validation
remains authoritative" — that is not true yet, and Phase 2 should make it so.

---

## 6. Conflicts between the proposed architecture and the current code

These are the items the handoff's Prompt 1 task 8 asks for — resolve them before
writing Phase 2/3 code.

### 6.1 Sequencing versus actual scale (the one to decide first)

With 3 notes and 2 replies live (§2.1), a large part of the MVP list is
infrastructure for load that does not exist. Recommend an explicit **go/no-go
checkpoint after Phase 2 (MVP beta)** rather than treating all 8 phases as
pre-approved, and defer within the MVP: realtime, cached counters
(`reply_count`/`participant_count`), branch-level pagination and virtualization.
Keep in the MVP the things that are cheap now and expensive to retrofit: the
`activity_sequence` ordering key, `root_comment_id`/`depth`, soft-delete columns,
and keyset-friendly indexes. Build the *schema* for scale; do not build the *UI* for
scale until there is traffic.

### 6.2 `community_profiles` duplicates `profiles`

The plan proposes a new `community_profiles` table. `profiles` already holds
`display_name`; the only genuinely new fields are `avatar_path` and `role_label`. A
second table needs a sync trigger and can drift.
**Recommended instead:** add `avatar_path` and `role_label` to `profiles`, and expose
a public-safe **view** (or a narrow `SECURITY INVOKER` function) selecting only
`id`, `display_name`, `avatar_path`, `role_label`. Same guarantee that `email` and
`is_admin` never go public, one less table, no sync path. This also finally provides
the public identity lookup whose absence currently forces the participant-only
mention rule (§2.3).

### 6.3 `activity_sequence` needs to be an identity/sequence column

The plan writes `activity_sequence bigint generated ...`, which reads as a
`GENERATED ALWAYS AS (<expr>)` computed column. Unread tracking needs a **monotonic
insert-order key**, i.e. `generated always as identity` (or a `bigserial`). Pin this
in the migration; a computed column cannot do the job.

### 6.4 The namespacing goal conflicts with the existing dependency direction

The plan says to use one `window.DafSyncChabura` namespace. But today the dependency
runs *from* `chaburah.js` *into* `notes.js`'s bare globals (§3.4). A new namespaced
module cannot consume those without either (a) duplicating the render helpers, which
guarantees drift, or (b) extracting them from `notes.js` first — which means editing
`notes.js`, a file the plan otherwise wants left alone.
**Recommendation:** do (b), narrowly — move `CATEGORY_TYPES`, `categoryByKey`,
`formatNoteTime`, `renderFormattedBody`, `renderTimestampPill`, `demoPillHtml` into a
small shared `notes-format.js` loaded before both, re-exporting them under one
namespace. It is a mechanical change, it is covered by the tests committed in this
phase, and it should happen in Phase 3 *before* the new UI is written on top.

### 6.5 Editorial Blue is a re-accent, not a dark→light inversion

The plan describes Cloud Chabura moving to "a lighter, scholarly, editorial surface
than the current dark player chrome." `/chaburah/` already loads `watch-theme.css`
after `styles.css`, so **it already renders light** (`--bg: #ffffff`, gold accent
`#ba8422`). The actual change is gold → blue `#2f6ea5` plus restructuring. This is
lower-risk than the plan implies — worth knowing so the change is not over-scoped —
but it also means a page-scoped `.cloud-chabura` token block will sit on top of two
existing palettes; make sure the third layer overrides cleanly rather than partially.

### 6.6 Two fixtures the plan asks for cannot exist yet

The plan's minimum fixture list includes "thread with a highlighted answer and a
later-hidden answer" and "unread activity before/inside collapsed branches". Neither
`highlighted_comment_id` nor any read-state table exists today, so those fixtures are
**deliberately absent** from `tests/fixtures/dataset.mjs` rather than faked. Add them
in the same phase that adds the columns.

### 6.7 The test suite cannot prove authorization

`tests/fixtures/supabase-stub.js` answers every query as a trusted caller and has no
RLS. This is stated prominently in `tests/README.md` and in the stub's own header, and
it must stay true: Phase 2's adversarial RLS/RPC tests belong in SQL against the real
database, exercising `anon`, ordinary `authenticated`, author and admin. A green
`npm test` says the UI behaves; it says nothing about permissions.

---

## 7. Recommended next steps

1. **Decide §6.1** — confirm the post-Phase-2 checkpoint and the deferral list before
   any migration is written.
2. **Phase 2 adjustments:** adopt §6.2 (`profiles` + public view instead of
   `community_profiles`), §6.3 (identity column), and close **F-14** (server-side
   mention eligibility) while touching that area anyway.
3. ~~**Cheap wins that need no redesign**~~ — **done**, in
   `supabase/migrations/20260902180000_tighten_grants_and_feed_index.sql` +
   `netlify/functions/sefaria-calendars.mjs`: revoked `PUBLIC` execute on the five
   trigger-only functions, narrowed the three admin RPCs to `authenticated` only,
   added the `line_notes` partial ordering index (§2.5), and closed **F-4** (proxied
   both the app.js and index.html Today's Daf lookups). **Still open, manual-only**:
   enabling leaked-password protection in Supabase Auth — no MCP tool exposes Auth
   provider settings; this needs a one-click dashboard toggle
   (Authentication → Policies → Leaked Password Protection).
4. **Phase 3 prerequisite:** do the `notes-format.js` extraction (§6.4) *before*
   building the new hub, with the committed tests as the safety net.
5. Re-run `npm test` at the start of Phase 2 to confirm this baseline still holds.
