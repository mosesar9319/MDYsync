#!/usr/bin/env python3
"""Unit tests for caption_ocr_align.py's jump-confirmation gate
(_classify_jump), which decides whether a fresh local caption-box match
commits to the running cursor immediately or gets held for one extra
sample's corroboration -- see JUMP_CONFIRM_WORDS' own comment for the bug
this exists to fix: a single noisy/ambiguous highlighted phrase fuzzy-
matching a repeated formula elsewhere on the page used to yank the cursor
there instantly, and the next good frame yanked it back -- visible in a
published alignment as the highlight jumping forward then snapping
backward.

No cv2/pytesseract dependency -- _classify_jump is pure, so this runs with
only the stdlib: `python3 test_jump_gate.py`.
"""
import unittest

from caption_ocr_align import JUMP_CONFIRM_WORDS, _classify_jump


class ClassifyJumpTests(unittest.TestCase):
    def test_ordinary_forward_progress_commits(self):
        # Normal frame-to-frame reading advance, well under the threshold.
        self.assertEqual(_classify_jump(s=103, cursor=100, pending_s=None), "commit")

    def test_small_backward_reread_commits(self):
        # A small re-read backward is normal and shouldn't need confirmation.
        self.assertEqual(_classify_jump(s=97, cursor=100, pending_s=None), "commit")

    def test_at_threshold_commits(self):
        s = 100 + JUMP_CONFIRM_WORDS
        self.assertEqual(_classify_jump(s=s, cursor=100, pending_s=None), "commit")

    def test_first_big_jump_holds_not_commits(self):
        # A single-frame decoy match far from the cursor (e.g. an ambiguous
        # short highlighted phrase matching a repeated formula elsewhere on
        # the page) must not commit outright anymore.
        s = 100 + JUMP_CONFIRM_WORDS + 1
        self.assertEqual(_classify_jump(s=s, cursor=100, pending_s=None), "hold")

    def test_big_backward_jump_also_holds(self):
        s = 100 - JUMP_CONFIRM_WORDS - 5
        self.assertEqual(_classify_jump(s=s, cursor=100, pending_s=None), "hold")

    def test_second_sample_near_pending_confirms(self):
        # A genuine jump (e.g. the caption box flipping to its next "page")
        # keeps landing near the same new spot on the very next sample too.
        pending_s = 140
        s = 142  # within JUMP_CONFIRM_WORDS of pending_s, still far from cursor
        self.assertEqual(_classify_jump(s=s, cursor=100, pending_s=pending_s), "confirm")

    def test_second_sample_disagreeing_with_pending_holds_again(self):
        # A second, DIFFERENT far-off candidate doesn't corroborate the
        # first -- it's just a new, still-unconfirmed candidate (the caller
        # is expected to discard the stale pending and hold this one instead).
        pending_s = 140
        s = 40  # nowhere near cursor (100) or pending_s (140)
        self.assertEqual(_classify_jump(s=s, cursor=100, pending_s=pending_s), "hold")

    def test_pending_none_never_confirms(self):
        for s in (0, 50, 100, 999):
            self.assertNotEqual(_classify_jump(s=s, cursor=100, pending_s=None), "confirm")


if __name__ == "__main__":
    unittest.main()
