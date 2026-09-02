# Cloud Chabura Phase 2 — migration, rollout and backfill plan

**Status:**
- `20260902183000` (reply hotfix) — **APPLIED to production 2026-09-02**, with
  the owner's approval. The outage described below is over. Section 1 is kept
  as the incident record.
- `20260902190000` (Phase 2 foundation) — **still awaiting approval.** Not
  applied.

---

## 1. `20260902183000` — hotfix: replies were broken in production (RESOLVED)

### What is wrong

Every `INSERT` into `public.comments` by the `authenticated` role fails with:

```
42P17: infinite recursion detected in policy for relation "comments"
```

Reading replies works. Posting any reply — top-level or nested — does not.

### Why

The `comments_insert` policy's `WITH CHECK` queries `comments` from inside a
policy *on* `comments`:

```sql
and ((parent_comment_id is null) or exists (
  select 1 from public.comments p
  where p.id = comments.parent_comment_id and p.note_id = comments.note_id))
```

Postgres expands that recursively and aborts. It is detected when the statement
is **planned**, so the `parent_comment_id is null` branch does not save
top-level replies — they fail too.

### Evidence

- Reproduced against production read-only: an `EXPLAIN` of a top-level reply
  insert as `authenticated`, inside a rolled-back transaction, returns 42P17.
  Nothing was written.
- Reproduced locally against the schema replica, and fixed there.
- Introduced by `20260901103135_comments_nested_replies` on 2026-09-01.
- Consistent with the data: `comments` holds exactly two rows, both stamped
  with the `20260901145415_seed_demo_notes` migration time, i.e. inserted as
  `postgres` with RLS bypassed. No reply appears to have ever been posted
  successfully by a real user.

### The fix

Move the parent lookup into a `SECURITY DEFINER` helper
(`comment_is_in_note`), so the policy no longer references `comments`
directly. The authorization rule is unchanged — same conditions, same
outcomes.

### Verification performed

| Case | Before | After |
|---|---|---|
| Top-level reply, established account | rejected (42P17) | **accepted** |
| Nested reply, established account | rejected (42P17) | **accepted** |
| Parent in a different thread | rejected | rejected |
| Reply to a private note | rejected | rejected |
| Reply to a moderator-hidden note | rejected | rejected |
| Reply with a spoofed `author_id` | rejected | rejected |
| Reply from an account < 24h old | rejected | rejected |

### Rollout — done

1. ✅ Applied to production 2026-09-02.
2. ✅ Verified against production immediately afterwards, each check inside a
   rolled-back transaction so nothing was written:
   - top-level reply → **accepted** (was 42P17)
   - nested reply → **accepted** (was 42P17)
   - reply with a spoofed `author_id` → still **rejected**, 42501
   - `comments` still holds exactly its original 2 rows; no verification rows
     leaked into the table.
3. No client change was needed; no data migration; no downtime.

**Still worth doing:** post one real reply through the live UI. The checks
above prove the database accepts the write; they do not exercise the browser
path end to end.

### Rollback

Restore the previous policy definition. That reinstates the outage, so the
only reason to do it is if the helper itself misbehaves — in which case
dropping the parent clause entirely is the safer fallback, since
`comments_derive_hierarchy` (Phase 2) enforces the same rule from a trigger.

---

## 2. `20260902190000` — Phase 2 thread foundation

Additive and backwards compatible. Every new column is nullable or defaulted;
no existing column changes type or nullability; current clients keep working
untouched before any new UI ships.

### What it adds

**`profiles`** — `avatar_path`, `role_label`, plus a read-only
`public_profiles` view exposing only `id`, `display_name`, `avatar_path`,
`role_label`. Chosen over a separate `community_profiles` table (the original
plan's shape) because that would need syncing and could drift; this also
finally provides the public identity lookup whose absence currently forces the
participants-only mention rule.

**`line_notes`** — `title`, `status` (`open`/`resolved`/`locked`),
`highlighted_comment_id`, `edited_at`, `deleted_at`, `last_activity_at`.

**`comments`** — `root_comment_id`, `depth`, `activity_sequence`, `edited_at`,
`deleted_at`, `quoted_comment_id`, `quoted_excerpt`.

**New tables** — `thread_read_state` (per-viewer unread position),
`bookmarks`. Both owner-only under RLS.

**Integrity, enforced server-side** — parent must be in the same thread;
replies cannot be re-parented (the only way to form a cycle); `depth` and
`root_comment_id` are derived by trigger and any client-supplied value is
discarded; a highlighted answer must be a live reply on the same thread and is
cleared automatically if that reply is hidden or deleted; read state never
moves backwards; a soft delete redacts the body in the database rather than
relying on the client to hide it.

### Scope decisions taken with the project owner

- **No cached `reply_count`/`participant_count`.** Counting on read is instant
  at the current corpus (3 notes, 2 replies) and cannot drift or mishandle
  hidden/deleted replies. Revisit only if threads actually get large.
- **No `branch_follows` yet.** Whole-thread following already works. To add it
  later: a `(user_id, note_id, root_comment_id)` table with owner-only RLS,
  an insert check that the branch is publicly visible, and a clause in
  `notify_on_comment_insert` that notifies branch followers when
  `new.root_comment_id` matches. It needs no change to anything in this
  migration.

### One deliberate deviation from the written plan

The plan says "cap stored reply depth at four". **This migration does not.**
`MAX_REPLY_DEPTH = 4` in `notes.js` caps *indentation*, not storage — its own
comment says replies "stay logically threaded ... no matter how deep a
conversation actually goes". A hard cap of four would start rejecting replies
the live system accepts today: a product change, not a schema detail. The
constraint is set to 64 purely as an abuse ceiling. Change
`comments_depth_check` to `<= 3` if a real cap is wanted.

### Backfill

Runs inside the migration, before any `NOT NULL` is enforced:

1. `root_comment_id` / `depth` — recursive walk from each top-level comment.
   Verified on a six-level chain: depths 0–5, one shared root, and a second
   top-level branch correctly getting its own root.
2. `activity_sequence` — assigned in `created_at` order (not insertion order),
   then an owned sequence is set to start above the highest value. Verified
   that ordering follows `created_at`.
3. `last_activity_at` — recomputed as `greatest(note.created_at, latest reply
   created_at)`. The column defaults to `now()`, which would otherwise flatten
   feed ordering across every existing row. `line_notes_before_update` is
   disabled for this one statement so a data migration does not stamp
   `updated_at` on every note as if a user had edited it.

Legacy rows are never blocked or destroyed: notes without titles keep
rendering, and every pre-existing anchor shape (whole-segment, single range,
multi-ref `word_ranges`) is untouched.

### Verification performed

- Applies cleanly to the schema replica, both empty and seeded.
- Backfill results checked by query, not assumed.
- The full 49-check authorization suite passes afterwards.
- The rollback was executed: new columns and tables removed, the reply hotfix
  preserved, seeded data intact, replies still postable.

### Rollout

1. Apply the `20260902183000` hotfix first and confirm replies work.
2. Take a backup / note the point-in-time restore target.
3. Apply `20260902190000`.
4. Re-run `supabase/run-tests.sh` against the replica; spot-check production
   with the read-only queries in the migration's backfill section.
5. No client change ships with this. The new columns are inert until Phase 3
   builds UI against them.

### Rollback

`20260902190000_cloud_chabura_thread_foundation.down.sql`, tested.

**Data loss on rollback**, stated plainly: `thread_read_state` and `bookmarks`
are dropped; titles, statuses, highlighted answers and quote links go with
their columns; and author soft-deletes are **not** recoverable, because the
redaction trigger overwrote the original body at delete time. If any of that
has been used in anger, restore from a backup instead.

### Known follow-ups, not in this migration

- Server-side mention eligibility is still weaker than the client rule
  (audit F-14): `validate_mentions()` only checks "≤5 mentions, each user
  exists", not "is a participant in this thread". Worth closing when the
  mention UI is next touched.
- Leaked-password protection is still disabled in Supabase Auth. No MCP tool
  exposes Auth provider settings; it needs a dashboard toggle.
