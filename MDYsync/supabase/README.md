# Supabase schema, migrations and authorization tests

This directory holds the project's SQL: a runnable replica of the current
production schema, the migrations that change it, and the authorization tests
that prove the permission rules actually hold.

## Why this exists

The Playwright suite (`../tests/`) replaces supabase-js with an in-memory stub
that answers every query as a fully trusted caller and has **no RLS**. It
proves the UI behaves; it can say nothing about whether the database would
permit the same operation.

That gap is not theoretical. It is exactly why a total outage shipped
unnoticed: from 2026-09-01 until the `20260902183000` hotfix, **every attempt
to post a reply failed in production** with `42P17: infinite recursion detected
in policy for relation "comments"`, and the browser tests stayed green
throughout because they never touched a real database. See that migration's
header for the full story.

So authorization is tested here instead, against a real Postgres, as the real
`anon` / `authenticated` roles, including calling `SECURITY DEFINER` functions
directly the way a caller bypassing the UI would.

## Layout

| Path | What it is |
|---|---|
| `baseline/00_current_production_schema.sql` | Runnable replica of production's `public` schema as of 2026-09-02: tables, constraints, RLS, functions, triggers, indexes, grants. A test fixture, not a dump — see its header for the two deliberate differences. |
| `baseline/01_seed_representative_data.sql` | Personas and the awkward shapes (deep chain, hidden-with-visible-descendant, private canary) the migrations must handle. Mirrors `../tests/fixtures/dataset.mjs`. |
| `migrations/*.sql` | Forward migrations, applied in filename order. |
| `migrations/*.down.sql` | Rollbacks, where one exists. |
| `tests/rls_authorization.sql` | The adversarial suite. 49 checks. |
| `run-tests.sh` | Applies baseline + seed + every migration, then runs the suite. |

## Running locally

Needs a Postgres 16 you can create databases on. To start a throwaway one:

```bash
PGD=/var/tmp/dafsync-pg
mkdir -p "$PGD" && chown postgres:postgres "$PGD" && chmod 700 "$PGD"
su postgres -c "/usr/lib/postgresql/16/bin/initdb -D $PGD -A trust -U postgres"
su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D $PGD -o '-p 5433 -k /tmp' -l $PGD/server.log start"
```

Then:

```bash
cd MDYsync
./supabase/run-tests.sh
```

It drops and recreates a scratch `dafsync_test` database each run. It never
connects to Supabase. Override `PGHOST` / `PGPORT` / `PGUSER` / `DB` if needed.

Expected tail of a good run:

```
NOTICE:  ALL AUTHORIZATION TESTS PASSED
```

Any failed check raises and aborts the run.

## Migration status

| Migration | Applied to production? |
|---|---|
| `20260902180000_tighten_grants_and_feed_index` | **Yes** — applied 2026-09-02. |
| `20260902183000_fix_comments_insert_policy_recursion` | **Yes** — applied 2026-09-02, ending the reply outage. Verified against production afterwards: top-level and nested replies both accepted, spoofed `author_id` still rejected with 42501. All verification inserts ran inside rolled-back transactions; `comments` still holds exactly its original 2 rows. |
| `20260902190000_cloud_chabura_thread_foundation` | **Not yet.** Draft for review. |

The 24 migrations before `20260902180000` were applied via the Supabase
dashboard/MCP with no SQL under version control, which is why the baseline had
to be reconstructed from `pg_catalog` rather than replayed. Everything from
here on should land as a file in `migrations/` first.

## Conventions

- Never write a policy on a table that queries that same table — Postgres
  expands it recursively and aborts. Go through a `SECURITY DEFINER` helper
  (see `comment_is_in_note`).
- Every `SECURITY DEFINER` function sets an explicit `search_path`.
- Never grant `EXECUTE` to `PUBLIC`; grant to the specific role that needs it.
- Derived columns (`depth`, `root_comment_id`, `activity_sequence`) are set by
  triggers and never trusted from the client. There are tests asserting that a
  client-supplied value is overridden.
- Add the test alongside the migration. A rule with no check in
  `rls_authorization.sql` is a rule nothing is holding you to.
