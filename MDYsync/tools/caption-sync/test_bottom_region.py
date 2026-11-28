#!/usr/bin/env python3
"""Tests for where caption_ocr_align.py reads a channel video's captions
(bottom_region, and --crop's "bottom").

The bug these pin: the caption box used to be whatever bright patch the
first frame had, kept for the whole video. A finished live recording opens
on the stream's "starting soon" screen, whose bright patch is not where the
caption strip later appears, so the captions were hardly read (12-1,045
highlight samples a recording, against 1,400-4,600 on a normal upload) and
half the live recordings were refused by the caption gate.

The frames are drawn here, at the sizes and places the job logs and the
recordings' own frames show (720p): the opening screen's bright window at
x=670-1204 down to y=586, the caption strip at x=271-1081, y=602-712, with
its highlighted line at about y=665-690.

Run: `python3 test_bottom_region.py` (needs numpy and opencv, as the engine
does).
"""
import unittest

import numpy as np

from caption_ocr_align import auto_detect_box, bottom_region, parse_crop

DARK = (90, 60, 20)
WHITE = (235, 235, 235)


def opening_screen():
    """The "starting soon" screen: a bright window on a dark backdrop."""
    frame = np.full((720, 1280, 3), DARK, np.uint8)
    frame[300:586, 670:1204] = WHITE
    return frame


# The highlighted line of the caption strip, as (x0, y0, x1, y1).
HIGHLIGHTED_LINE = (271, 665, 1081, 690)


def holds(box, area):
    x, y, w, h = box
    x0, y0, x1, y1 = area
    return x <= x0 and y <= y0 and x + w >= x1 and y + h >= y1


class BottomRegionTests(unittest.TestCase):
    def test_it_is_the_bottom_two_fifths_full_width(self):
        self.assertEqual(bottom_region(np.zeros((720, 1280, 3), np.uint8)), (0, 432, 1280, 288))
        self.assertEqual(bottom_region(np.zeros((1080, 1920, 3), np.uint8)), (0, 648, 1920, 432))
        self.assertEqual(bottom_region(np.zeros((360, 640, 3), np.uint8)), (0, 216, 640, 144))

    def test_it_is_the_box_a_normal_upload_gets_from_its_title_card(self):
        # A normal upload opens on a bright card: the first-frame search
        # answers with the whole bottom of the frame. Reading that region
        # outright changes nothing for those videos.
        card = np.full((720, 1280, 3), WHITE, np.uint8)
        self.assertEqual(auto_detect_box(card), bottom_region(card))

    def test_a_live_recordings_opening_screen_gives_a_box_without_the_captions(self):
        # What the job logged for live recordings: x=670 y=432 w=534 h=154.
        box = auto_detect_box(opening_screen())
        self.assertEqual(box, (670, 432, 534, 154))
        self.assertFalse(holds(box, HIGHLIGHTED_LINE))

    def test_the_bottom_region_holds_the_captions_whatever_the_video_opens_on(self):
        self.assertTrue(holds(bottom_region(opening_screen()), HIGHLIGHTED_LINE))


class ParseCropTests(unittest.TestCase):
    def test_nothing_means_search(self):
        self.assertIsNone(parse_crop(None))
        self.assertIsNone(parse_crop(''))

    def test_bottom(self):
        self.assertEqual(parse_crop('bottom'), 'bottom')
        self.assertEqual(parse_crop(' Bottom '), 'bottom')

    def test_a_box(self):
        self.assertEqual(parse_crop('0,432,1280,288'), (0, 432, 1280, 288))

    def test_a_box_needs_four_numbers(self):
        with self.assertRaises(ValueError):
            parse_crop('0,432,1280')


if __name__ == '__main__':
    unittest.main()
