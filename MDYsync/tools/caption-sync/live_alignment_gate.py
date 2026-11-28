"""Gates for a finished Mercaz Daf Yomi live recording.

A normal upload is not checked here. A live recording is published only when
the file we downloaded is the same length as YouTube's processed video, and
the burned-in captions were actually read.

Measured on the Bekhorot 39–41 live alignments (results/by-video, October 2026):

  Hebrew 40 (4vSdKjq5P6s)  65 highlight samples, 11/198 segments real (6%)
  Hebrew 41                108/217 real (50%), 461 real words
  Hebrew 39                130/303 real (43%), 502 real words
  English 39–41            123–137 real segments (44–53%), 423–738 real words,
                           and one run logged 4896 highlight samples

The Hebrew 40 file is the one whose caption box locked onto the wrong part
of the picture. Everything else that was actually read sits above 40% real
segments and hundreds of real words. The gates sit in the gap:

  downloaded duration within max(30 seconds, 1% of YouTube's length)
  at least 200 highlight samples (65 fails; the readable runs are far above)
  at least 20% of segments from a real caption match (6% fails; 43% passes)

A miss does not publish a guessed timeline and does not fall back to the
voice engine. The recording stays on the site, unsynced, until the edit.

That wrong box was the usual case, not the odd one: the engine kept the
bright patch of the stream's "starting soon" screen as its caption box, and
11 of the 21 live recordings of 15-27 November 2026 were refused here. The
job now reads the bottom of the picture instead (bottom_region in
caption_ocr_align.py). These gates stay as they are, for a recording whose
captions are not there to read.
"""

from datetime import datetime, timezone

# A finished live file is a few seconds shorter than YouTube's lengthSeconds
# once the container is trimmed (Bekhorot 58a: 4440.27s downloaded, 4450s
# reported). The allowance is the larger of 30 seconds and 1% of the
# YouTube length.
DURATION_TOLERANCE_SECONDS = 30
DURATION_TOLERANCE_RATIO = 0.01
MIN_HIGHLIGHT_SAMPLES = 200
MIN_REAL_SEGMENT_RATIO = 0.20


def duration_allowance(youtube_seconds, floor=DURATION_TOLERANCE_SECONDS, ratio=DURATION_TOLERANCE_RATIO):
    return max(float(floor), abs(float(youtube_seconds)) * float(ratio))


def duration_ok(downloaded_seconds, youtube_seconds, tolerance=None):
    try:
        downloaded = float(downloaded_seconds)
        youtube = float(youtube_seconds)
    except (TypeError, ValueError):
        return False
    if downloaded <= 0 or youtube <= 0:
        return False
    allowed = duration_allowance(youtube) if tolerance is None else float(tolerance)
    return abs(downloaded - youtube) <= allowed


def captions_ok(highlight_samples, real_segments, total_segments,
                min_samples=MIN_HIGHLIGHT_SAMPLES, min_ratio=MIN_REAL_SEGMENT_RATIO):
    try:
        samples = int(highlight_samples)
        real = int(real_segments)
        total = int(total_segments)
    except (TypeError, ValueError):
        return False
    if total <= 0 or real < 0 or samples < 0:
        return False
    return samples >= min_samples and (real / total) >= min_ratio


def outcome_document(outcome, **fields):
    body = {
        'outcome': outcome,
        'at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
    }
    body.update(fields)
    return body
