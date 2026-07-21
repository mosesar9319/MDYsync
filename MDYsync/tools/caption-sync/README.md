# Caption-box OCR alignment

Some Daf Yomi lecture videos (for example the Mercava "Nothing But The Daf"
shiurim) burn a caption box into the bottom of the frame showing the daf text,
with the words the lecturer is currently reading highlighted in yellow.

`caption_ocr_align.py` turns that on-screen highlight into a DafSync
alignment: it reads the video, OCRs the caption box, tracks the yellow
highlight, matches the highlighted words to the canonical Sefaria text, and
writes a `dafsync-alignment-v2` JSON — including a word-level timeline — that
DafSync Studio imports directly. During playback the player then highlights
the exact words being spoken on the daf, not just the active segment.

## How it works

1. **Frame sampling** — the video is sampled at ~3 fps.
2. **Caption box detection** — the white caption strip is auto-detected in
   the bottom of the frame (or passed explicitly with `--crop x,y,w,h`).
   Frames where a player UI overlay covers the strip are skipped.
3. **OCR caching** — the caption text only changes when the video flips to
   the next portion of the daf, so the crop is hashed with the yellow
   highlight masked out and Tesseract (`heb`) runs once per caption "page",
   returning word bounding boxes in right-to-left reading order.
4. **Highlight detection** — an HSV mask finds the yellow band; OCR words
   whose boxes overlap it are the words currently being spoken.
5. **Canonical matching** — highlighted words are stripped of nikud and
   fuzzy-matched (rapidfuzz) against the Sefaria text of the given refs.
   Matching is monotonic-biased with a small back-window for re-reads. The
   first confident multi-word match localizes the position globally, and the
   matcher re-localizes if it loses track for several seconds.
6. **Output** — consecutive samples collapse into a word-span timeline;
   segment start/end times are derived from it.

## Usage

```bash
pip install opencv-python-headless pytesseract rapidfuzz
# plus the tesseract binary with Hebrew: apt install tesseract-ocr tesseract-ocr-heb

python3 caption_ocr_align.py lecture.mp4 \
    --refs Chullin.80b Chullin.81a \
    --out-dir out --debug
```

- `--refs` — Sefaria refs covering the lecture, in reading order.
- `--crop x,y,w,h` — caption box position; omitted = auto-detect.
- `--sample-fps` — sampling rate (default 3).

Outputs in `--out-dir`:

- `alignment.json` — importable in DafSync Studio via **Import alignment**.
  Contains `segments` (segment-level start/end) plus `wordTimeline`
  entries `{start, end, ref, w0, w1}` giving the active word range
  (whitespace-token indices within the segment's Hebrew text).
- `wordmap.json` — the raw word-span timeline with OCR confidence scores,
  useful for review tooling.

## Player support

When an imported alignment carries a `wordTimeline`, the player renders each
segment's Hebrew as individual word spans and highlights the active word
range (`.daf-word.word-active`) on every time update, mirroring the yellow
sweep from the source video onto the digital daf.

## Validated against

A screen recording of the end of Chullin 80b (Mercava caption style,
1560×720). The pipeline auto-detected the box, survived a playback-speed UI
overlay mid-clip, tracked the caption growing from 2 to 4 text lines, and
produced a monotonic Chullin 80b:5–11 timeline with typical match scores of
90–100. Spot-checked frames at t=100s and t=130s matched the on-screen
highlight exactly.

## Known limitations

- Single highlighted words are matched conservatively (they are ambiguous);
  brief single-word highlights may be skipped rather than misplaced.
- The refs must cover the lecture's text; excursions to Rashi/Tosafos or
  other dapim are not in the canonical stream and produce no matches while
  on screen (the previous highlight simply persists).
- Yellow-highlight HSV thresholds and the white-strip detector are tuned to
  the Mercava caption style; other channels may need adjusted thresholds.
