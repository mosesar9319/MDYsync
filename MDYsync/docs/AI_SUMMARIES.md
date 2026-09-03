# Cloud Chabura — generated summaries

Covers the Prompt 8 layer: the thread summary, "catch me up", and the related
discussions panel. Written to be read before the feature is switched on, since
nothing here runs until somebody sets a provider key.

**Status: built, tested, and OFF.** No `ANTHROPIC_API_KEY` is set on the
DafSync Netlify site, and the schema migration
(`supabase/migrations/20260903120000_chabura_thread_summaries.sql`) has **not
been applied to production** — same rule every Cloud Chabura migration has
followed. Until both happen, `/api/chabura/summary` answers `503 unconfigured`
and the panel stays hidden. That is a supported state, not a broken one.

---

## What is and is not AI here

| Feature | AI? | Works without a provider key? |
|---|---|---|
| Related discussions | **No.** Passage anchor + Postgres full-text | Yes — this ships working today |
| Thread summary | Yes | No — panel stays hidden |
| Catch me up | Yes | No — panel stays hidden |

The related-discussions panel was built first and deliberately: every note in
this system is anchored to an exact passage (`daf_ref_key` + `segment_ref`, and
usually a word range inside it). Two people asking about the same six words of
Chullin 89a is an equality check on an indexed column, not a semantic
similarity problem. The plan's own instruction — "using source anchor and search
signals **before** considering fully semantic recommendations" — is the right
call, and the ranking weights say so: an exact anchor match outscores any amount
of wording overlap, because two notes on the same words are about the same thing
even when they share no vocabulary — routine here, where one reader writes in
English and another in Hebrew.

---

## Where the boundary is

The browser never holds the provider key and is never trusted about what a
thread contains. It sends an id. `netlify/functions/chabura-summary.mjs`
re-reads the discussion itself.

It reads with **the caller's own Supabase token**, not a service key, so
row-level security is the visibility boundary for the read exactly as it is in
the browser. The service key appears once, at the end, to write
`thread_summaries` — a table the browser is not granted at all.

What never reaches the model:

- hidden replies, soft-deleted replies, and the `[deleted]` tombstone text
- anything from a private, hidden or deleted thread — the whole request is
  refused with `403 not-public`, including for the thread's own author
- email addresses or any profile column beyond the display name already shown
  on every rendered reply
- comment UUIDs — replies are labelled `[1]`, `[2]`, and the numbers are mapped
  back to ids on the way out (`tests/functions/chabura-summary.test.mjs`
  asserts no id appears in a prompt)

The filter is applied twice: once as a query predicate, once in JavaScript over
the rows that came back. A filter that exists only in a query string is one
PostgREST quirk away from not existing at all.

**Attachments:** the plan's "unapproved attachment contents" has no counterpart
in this system — there is no attachment feature. Reply bodies are the only
user content, and link previews are fetched separately, server-side, and are
never included in a prompt.

---

## Traceability

Every point cites the replies it came from, and this is enforced in three
places rather than trusted once:

1. **The prompt** tells the model a point it cannot cite must not be written.
2. **The function** drops any point whose citations do not resolve to replies
   that were actually sent (`validatePoints`). A model that invents `[99]`
   loses the point, and a summary with no surviving points returns
   `502 no-citable-points` rather than publishing an unsourced claim.
3. **The database** refuses to store it:
   `source_comment_ids uuid[] NOT NULL CHECK (cardinality BETWEEN 1 AND 12)`.

The third is the one that matters, because it is the only layer a future bug
cannot walk past.

---

## Not a ruling

The system prompt forbids stating or implying a halachic ruling, a practical
decision, or that a question is settled; it requires disagreement to be
described as disagreement and open questions to be left open; and it forbids
adding anything not present in the replies supplied.

The panel carries a standing caveat under every summary:

> Generated from the replies below. It describes what participants said and does
> not decide anything — for a ruling, ask your rav.

and the report dialog's first category is **"Reads like a ruling or a
decision"**, because that is the failure this feature must never be allowed to
normalise.

The panel is also styled apart from every participant's words — its own ground,
a dashed edge, an uppercase "Generated" badge, and points that are never styled
like reply bodies. A generated paragraph that looks like a reply is a generated
paragraph somebody will quote as if a person wrote it.

---

## Invalidation

Moderation wins retroactively, at the database, through triggers on `comments`:

| What happened | Effect |
|---|---|
| A cited reply is hidden | Every point citing it is redacted; the summary is marked stale |
| A cited reply is soft-deleted | Same |
| A cited reply is hard-deleted | Same — there is no foreign key through a `uuid[]`, so the delete trigger *is* the cascade |
| A cited reply is edited | Summary marked stale (the reply is still readable; the summary may no longer describe it fairly) |
| The thread goes private, hidden or deleted | Its summaries are **deleted**, not merely hidden |

A redacted point keeps its row so the summary keeps its shape and the reader is
told a point was withdrawn — but `thread_summary_points_public` serves `null`
for its body and an empty array for its sources, and the base table is granted
to nobody. There is no path by which a browser reads the text of a withdrawn
point.

All of this is tested in `supabase/tests/rls_authorization.sql` against a real
Postgres as the real `anon` / `authenticated` roles.

---

## Catch-up is never cached

Catch-up output is viewer-specific: it is computed from the replies after that
reader's `thread_read_state.last_read_sequence`, returned with
`Cache-Control: private, no-store`, and written nowhere. `thread_summaries` has
`CHECK (scope = 'thread')` so a later change cannot quietly start storing
per-viewer text in a publicly readable table.

Because there is no shared row, catch-up carries no feedback controls — there is
nothing for an opinion to attach to.

---

## Thresholds, and why each one is there

Defined in `netlify/functions/chabura-summary.mjs`; the client duplicates two of
them only to decide whether to show a button, and the server is the enforcement.

| Constant | Value | Reasoning |
|---|---|---|
| `MIN_REPLIES_FOR_SUMMARY` | 8 | Below this, reading the thread *is* the summary. Paying a model to compress six replies is theatre. |
| `REGENERATE_AFTER_REPLIES` | 10 | New replies before a fresh summary is worth paying for. Under it, the stored summary is served with a "the discussion has moved on" notice. |
| `MIN_REGENERATE_INTERVAL_MS` | 10 min | Applies even to an explicit **Regenerate** click. That button is one any reader can hold down, so it is a cost anyone can run up. |
| `MIN_CATCHUP_REPLIES` | 3 | Under three new replies, reading them is quicker than waiting for a summary of them. |
| `MAX_SOURCE_REPLIES` | 300 | Hard ceiling on what one request can cost. The **newest** 300 are kept. |
| `MAX_BODY_CHARS` | 1200 | Per reply, before truncation. `comments.body` is capped at 2000 by the schema, so this bites on long replies only. |
| `MAX_POINTS` | 8 | A summary longer than this is not a summary. |
| `CATCHUP_COOLDOWN_MS` | 60 s | Per-user, **per serverless instance** — a speed bump, not a limit; see below. |

**Generation happens only** when there is no summary, the stored one has been
invalidated, ≥10 new replies have arrived, or somebody explicitly asks — and
never on page load. Loading a thread reads the cached rows and nothing else.

### The one weak control, stated plainly

`CATCHUP_COOLDOWN_MS` is enforced in an in-memory `Map` inside the function.
Serverless instances are not shared, so a determined caller spreading requests
across instances is not stopped by it. It is a speed bump. The real cost control
on catch-up is that it is only offered to a signed-in reader who actually has
unread replies on a thread they are reading. If catch-up ever needs a real
limit, it belongs in the database — a per-user counter table, checked by the
same service-role write path that stores summaries.

---

## Cost and latency — what is measured and what is not

Honest answer first: **no request has ever been sent.** No provider credential
is available to this project or to the environment this was built in, so real
latency and real cost are **unmeasured**. Publishing an invented number would be
worse than publishing none.

What *is* measured, from the committed fixtures
(`node --input-type=module` against `tests/fixtures/dataset.mjs`):

| Thread | Replies sent | System prompt | User prompt |
|---|---|---|---|
| `deepThread` (8 replies, 5 eligible) | 5 | 1,058 chars | 307 chars |
| `largeThread` (320 replies) | 300 (the cap) | 1,058 chars | 12,237 chars |
| Worst case (300 replies each at the 1,200-char truncation cap) | 300 | 1,058 chars | 366,889 chars |

Output is bounded by `max_tokens: 2000` and, in practice, by `MAX_POINTS = 8`
points of one or two sentences each — on the order of 200–600 output tokens.

To turn that into money, take the current per-million input and output prices
for `claude-opus-5` from Anthropic's pricing page and compute:

```
cost per generation ≈ (input_tokens / 1e6) × input_rate
                    + (output_tokens / 1e6) × output_rate
```

A rough token count is characters ÷ 4 for English and rather worse for Hebrew,
which is why the function records the **real** counts: `thread_summaries` stores
`input_tokens`, `output_tokens` and `generation_ms` on every row. After a
handful of real generations, this table answers itself:

```sql
select count(*),
       avg(input_tokens)::int, avg(output_tokens)::int,
       avg(generation_ms)::int, max(generation_ms)
from public.thread_summaries;
```

**This section should be replaced with those numbers once the feature has run
for real.** It is written to be replaced.

### What the thresholds imply about volume

At the current corpus — 3 notes and 2 replies in production — **no thread is
long enough to be summarised at all**. The feature costs nothing until a
discussion reaches 8 replies. Even then, a thread that stays busy generates at
most one summary per 10 new replies, floored at one per 10 minutes.

---

## Failure behaviour

Every failure path ends with the discussion readable. The panels load *after*
the thread is on screen and are never awaited.

| What went wrong | What the reader sees |
|---|---|
| No provider key (`503 unconfigured`) | "Summaries are not switched on for this site." The panel then stays out of the way. |
| Function not deployed (404) | "The summary could not be generated. The discussion below is unaffected." |
| Not signed in | No offer at all — generating costs money, so it is not an anonymous action |
| Thread too short | No panel |
| Cooldown (`429`) | "This was summarised very recently. Try again in a few minutes." |
| Model returned nothing citable (`502`) | "Nothing could be summarised without misrepresenting the discussion." |
| The summary rows cannot be read | Console warning only; no panel, no error shown to the reader |

Upstream error text is never echoed — a PostgREST or provider message can carry
internal hostnames, row contents and key prefixes. Same rule as
`netlify/functions/link-preview.mjs`.

---

## Turning it on

1. Review and apply `supabase/migrations/20260903120000_chabura_thread_summaries.sql`
   (rollback: the matching `.down.sql`; both verified against a local Postgres 16
   replica — see `supabase/README.md`).
2. Set on the Netlify site: `ANTHROPIC_API_KEY`, `SUPABASE_URL`,
   `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.
   The service-role key is what lets the function write the summary cache; it
   must be a **site environment variable**, never anything the browser can read.
3. Generate one summary on one real thread, then fill in the cost and latency
   table above from `thread_summaries`.

The migration also widens two `reports` constraints so a reader can report a
summary as a summary, rather than filing a complaint about a generated
paragraph against whichever participant it quoted. The moderation queue in
`notes.js` understands the new type and links to the thread, where a moderator
can withdraw a single point or hide the summary outright.

---

## What is tested, and where

| Question | Proved by |
|---|---|
| Can a hidden or deleted reply reach the model? | `tests/functions/chabura-summary.test.mjs` (27 checks) |
| Is an uncited point ever published? | Same file, plus the database's own `CHECK` |
| Does moderating a reply redact the points that cited it? | `supabase/tests/rls_authorization.sql` (133 checks, real Postgres, real roles) |
| Can a browser read a redacted point's text, or write a summary? | Same file |
| Does the panel label itself, cite, and degrade? | `tests/chaburah/summary.spec.mjs` (23 checks × 2 viewports) |

The split is deliberate. The Playwright suite runs against an in-memory
supabase stub with **no RLS**, so it would pass whether or not the permission
rules hold — which is why every authorization claim above is proved against a
real Postgres instead.
