# Cloud Chabura — WCAG 2.2 AA review

Covers `/chaburah/` (the feed) and `/chaburah/thread/` (the thread reader), as
built through Prompt 7. Prompt 7's acceptance criterion is a **documented**
checklist with its remaining exceptions, so this records what was checked, how,
and what is still open — not a claim that the pages are accessible.

**Reviewed:** 2026-09-03, against `main` at the Prompt 7 branch point.

## How each item was checked

| Method | What it can and cannot establish |
|---|---|
| `tests/chaburah/a11y.spec.mjs` | 13 automated checks × 2 viewports. Catches structural and attribute-level regressions. Cannot judge whether a name *reads well*, or how a screen reader actually narrates a thread. |
| Reading the rendered DOM | Element semantics, roles, relationships. |
| Manual keyboard walkthrough | Real focus order and traps, in this sandbox's Chromium only. |
| **Not done** | No screen reader was run. No automated contrast measurement. Both are listed as exceptions below rather than implied. |

## Checklist

| Criterion | Status | Evidence / note |
|---|---|---|
| **Semantic posts** | Pass | Root post and each reply are `<article>` with an `aria-label` naming the author and nesting level, so a screen-reader user gets the level the indentation conveys visually. Tested. |
| **Headings** | Pass | One `<h1>` per page; no level is skipped. Tested on both pages. |
| **Buttons vs links** | Pass | Anything that navigates is an `<a>` with an `href` (card titles, permalinks, previews); anything that acts is a `<button type="button">`. |
| **Accessible names** | Pass | No visible button lacks text, `aria-label` or `title`. Tested. |
| **Form labels** | Pass | Every visible input, select and textarea has a label, `aria-label` or placeholder. Tested. |
| **Focus states** | Pass | `:focus-visible` outlines on replies, menu items, report categories and composer fields. Menus return focus to their trigger on Escape. |
| **Dialogs** | Pass | Native `<dialog>` with `showModal()` for confirm, report and shortcuts — focus trapping and Escape come from the platform rather than a reimplementation. |
| **Menus** | Pass | `role="menu"` with `menuitem` / `menuitemcheckbox` children; arrow keys, Home/End, Escape; focus restored to the trigger. |
| **Tabs** | Pass | Feed views are `role="tab"` in a `role="tablist"` with `aria-selected`. |
| **Live announcements** | Pass | `#ctStatus` / `#ccStatus` are `role="status" aria-live="polite"` for load results, search counts and jumps. Errors use `role="alert"`. Tested. |
| **RTL excerpts** | Pass | Source passages and Hebrew category terms carry `dir="rtl"` and `lang="he"`. Tested. |
| **Reduced motion** | Pass | `prefers-reduced-motion` removes the permalink flash and smooth scrolling; the permalink is then marked with a static outline instead. Tested. |
| **200% zoom** | Pass | At a 640px-equivalent viewport the document does not scroll horizontally. Tested. |
| **Touch targets (2.5.8)** | Pass, with a stated exception | Every non-inline target is ≥24×24. See below. |
| **Target size on phones** | Pass | Reactions, branch toggles, tabs, composer buttons and the back link are ≥34px on mobile; most are 40–44px. |
| **Contrast** | **Not verified** | See exceptions. |
| **Screen reader** | **Not verified** | See exceptions. |

## The touch-target exception, stated plainly

WCAG 2.2 §2.5.8 exempts a target that is *"in a sentence or its size is
otherwise constrained by the line-height of non-target text."* Two links here
rely on that exception:

- the **"Replying to *name*"** backlink, which sits inside its sentence;
- inline links inside a reply body, which sit in the author's prose.

Both are ~15px tall and both are genuinely inline. The automated check honours
the exception rather than reporting a violation the criterion does not make.

Two links that *looked* exempt but are not, and were therefore fixed:

- **`.ct-back`** ("← Back to Cloud Chabura") was 22px tall. It is standalone
  navigation, not text in a sentence, so the exception does not apply. Now ≥24px,
  and 44px on phones.
- **The quote attribution link** ("*name* wrote") was 14px tall and is the entire
  line of the quote header — nothing non-target constrains it. Now ≥24px.

## Remaining exceptions

1. **No screen reader was run.** The automated checks verify that names, roles,
   states and live regions *exist and are correct*; they cannot tell you whether
   a four-level thread is comprehensible when narrated. NVDA or VoiceOver on the
   thread reader is the obvious next check, and it is not something this
   environment can do.
2. **Contrast is not measured.** The Editorial Blue tokens were chosen to look
   like they clear AA, but no automated contrast pass has been run over the
   rendered pages. `--cc-muted` on `--cc-surface` is the pairing most likely to
   be marginal, and it is used for timestamps, counts and preview descriptions.
3. **High-contrast / forced-colors mode is untested.** No `forced-colors` media
   query is defined; chips and state colours may lose meaning there, since
   several states are distinguished by background colour plus text.
4. **`/browse/` is out of scope and has a known defect.** Audit finding F-15:
   at 412px the note sidebar's report and delete controls sit off the physical
   screen. Pre-existing, pinned by a test, not addressed by this phase.
5. **The automated suite runs one engine.** Chromium via Playwright. Firefox and
   WebKit are untested, and `<dialog>` focus behaviour in particular differs
   between engines.

## What would close them

Running axe-core (or similar) in the Playwright suite would cover contrast and a
broad set of rule checks mechanically, and is the single highest-value addition.
It was not added here because pulling in a scanner is a dependency decision for
the repo owner rather than something to slip into a hardening PR.
