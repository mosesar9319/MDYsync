import { test, expect } from '@playwright/test';
import { preparePage } from '../support/harness.mjs';

// Reported directly: the "now playing" highlight visibly jumped back several
// lines a moment after a daf loaded and started playing, then snapped back
// to the right place shortly after on its own.
//
// Root cause: fillMissingDafText() (app.js) runs in the background after the
// daf's own alignment has already loaded and playback may already be under
// way -- it fetches Sefaria's full paragraph list, and for any paragraph the
// published alignment never covered, inserts an "estimated" placeholder
// segment with an INTERPOLATED start time (paragraph-position based, not a
// real timestamp), then re-sorts state.segments by start. That reorder
// shifts every existing segment's array index. The old code responded by
// calling a plain renderDaf(), which force-recomputes state.activeIndex from
// getCurrentTime() via findSegmentAt -- and a freshly-interpolated
// placeholder's guessed start time can easily outrank the segment that's
// actually playing, at least until the next ordinary playback tick corrects
// it (updateActiveSegment's own never-move-backward guard only protects
// ordinary ticks, not this forced recompute).
//
// The fix: capture the actual active segment (by reference, not index)
// before fillMissingDafText reorders the array, find that same segment's new
// position afterward, and skip the forced time-based recompute entirely
// (renderDaf({ forceActiveSegment: false })) when it was found -- the reader
// stays on the exact segment they were already correctly on, regardless of
// how the newly-added placeholder's guessed timing compares.
//
// The /api/sefaria stub (tests/support/harness.mjs) always returns exactly
// two paragraphs for Chullin 89a -- 89a.1 and 89a.2 -- which is what makes
// this reproducible offline: seeding state.segments with 89a.2 alone (no
// 89a.1 coverage) forces fillMissingDafText to insert a placeholder for
// 89a.1, which sorts BEFORE 89a.2 and shifts its array index from 0 to 1.

async function seedMissingParagraphScenario(page) {
  await page.evaluate(() => {
    state.segments = [
      { ref: 'Chullin 89a.2', start: 100, end: 110, he: 'seg2', en: 'seg2', w0: null, w1: null },
    ];
    state.activeIndex = 0;
    state.dafRef = 'Chullin 89a';
  });
}

test.describe('fillMissingDafText does not knock the highlight off the actually-playing segment', () => {
  test('the active segment survives the reindex when the fix is applied (forceActiveSegment: false)', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/watch/?ref=Chullin%2089a');
    await seedMissingParagraphScenario(page);

    const result = await page.evaluate(async () => {
      const activeBefore = state.segments[state.activeIndex];
      const added = await fillMissingDafText('Chullin 89a');
      const preservedIndex = activeBefore ? state.segments.indexOf(activeBefore) : -1;
      if (preservedIndex !== -1) state.activeIndex = preservedIndex;
      renderDaf({ forceActiveSegment: preservedIndex === -1 });
      return {
        added,
        segmentCount: state.segments.length,
        activeIndex: state.activeIndex,
        activeRef: state.segments[state.activeIndex]?.ref,
        firstRef: state.segments[0]?.ref,
      };
    });

    expect(result.added).toBe(true);
    // The placeholder for the missing 89a.1 sorts before the real 89a.2
    // segment (its interpolated start is earlier), shifting the real
    // segment from index 0 to index 1 -- exactly the reindex this fix has
    // to survive.
    expect(result.segmentCount).toBe(2);
    expect(result.firstRef).toBe('Chullin 89a.1');
    expect(result.activeIndex).toBe(1);
    expect(result.activeRef).toBe('Chullin 89a.2');
  });

  test('without the fix (plain renderDaf), a forced recompute derails to whatever "now" resolves to', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/watch/?ref=Chullin%2089a');
    await seedMissingParagraphScenario(page);

    const result = await page.evaluate(async () => {
      // A real YouTube seek can leave getCurrentTime() reporting a stale
      // value for a stretch (see vilna-tap-highlight.spec.mjs for the same
      // async-seek gap) -- here it stands in for ANY reason "now" briefly
      // disagrees with the segment the reader is actually correctly
      // following, which a forced, unconditional recompute has no way to
      // tell apart from a genuine jump.
      state.playerType = 'youtube';
      state.youtubeReady = true;
      state.youtubePlayer = { getCurrentTime: () => 0, getDuration: () => 1000 };

      await fillMissingDafText('Chullin 89a');
      renderDaf(); // old behavior: always force-recomputes from "now"

      return {
        activeIndex: state.activeIndex,
        activeRef: state.segments[state.activeIndex]?.ref,
      };
    });

    // getCurrentTime() reporting 0 sends the forced recompute all the way
    // back to the very first segment -- the newly-inserted placeholder --
    // stranding the reader on 89a.1 even though they were correctly on
    // 89a.2 a moment before. This is exactly the class of regression the
    // fix (the test above) exists to prevent.
    expect(result.activeRef).toBe('Chullin 89a.1');
    expect(result.activeIndex).toBe(0);
  });
});
