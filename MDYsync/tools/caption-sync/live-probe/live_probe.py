#!/usr/bin/env python3
"""Test only: can the caption engine follow a shiur WHILE it streams?

Nothing here is used by the site. It answers three questions on a real live
stream, and writes what it saw to a report:

  1. Can a runner read the stream as it airs? It asks yt-dlp for the live
     HLS playlist, then polls that playlist and fetches each new piece
     (about five seconds of video) as YouTube publishes it.
  2. How far behind the broadcast does the caption read run? Each piece
     carries the wall-clock time YouTube ingested it
     (EXT-X-PROGRAM-DATE-TIME). The lag is "now" minus that time, measured
     after the piece has been fetched, OCRed and matched.
  3. Does the matcher lock onto the daf from live frames? The frame steps
     are the engine's own functions (caption_ocr_align.py). Only the
     little state machine that strings them together is copied from
     process_video(), because that function wants a finished file.

It also records what a viewer's clock would need: the playlist's
ingestion times against the piece numbers, so the stream's "second zero"
can be compared with what the embedded player reports
(getMediaReferenceTime() - getCurrentTime()).

Signed media addresses are never written to the log or the report.
"""

import argparse
import http.cookiejar
import json
import os
import re
import statistics
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from urllib.parse import urljoin

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))


def log(message):
    print(f"[{datetime.now(timezone.utc).strftime('%H:%M:%S')}] {message}", flush=True)


# ---------------------------------------------------------------------------
# Playlist
# ---------------------------------------------------------------------------

_SQ = re.compile(r"/sq/(\d+)/")
_ADDRESS = re.compile(r"https?://\S+|URI=\"[^\"]*\"")


def redact(text):
    """Media addresses are signed for this runner. Keep them out of anything
    that is printed or saved."""
    return _ADDRESS.sub("<address>", str(text))


def parse_iso(value):
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    # 2026-11-29T05:12:03.123+00:00 -- Python accepts this form directly.
    return datetime.fromisoformat(text).timestamp()


def parse_playlist(text):
    """-> (header tags, [{sq, duration, pdt, url}]). pdt is epoch seconds of
    the piece's first frame, or None when the playlist carries no
    EXT-X-PROGRAM-DATE-TIME."""
    tags, pieces = [], []
    media_sequence = None
    duration = None
    pdt = None
    running_pdt = None
    index = 0
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#EXT-X-MEDIA-SEQUENCE:"):
            media_sequence = int(line.split(":", 1)[1])
            tags.append(line)
        elif line.startswith("#EXTINF:"):
            duration = float(line.split(":", 1)[1].split(",")[0])
        elif line.startswith("#EXT-X-PROGRAM-DATE-TIME:"):
            pdt = parse_iso(line.split(":", 1)[1])
            running_pdt = pdt
        elif line.startswith("#"):
            if not line.startswith("#EXT-X-MAP"):
                tags.append(redact(line)[:200])
        else:
            found = _SQ.search(line)
            sq = int(found.group(1)) if found else (
                media_sequence + index if media_sequence is not None else index)
            start = pdt if pdt is not None else running_pdt
            pieces.append({"sq": sq, "duration": duration, "pdt": start, "url": line})
            if running_pdt is not None and duration:
                running_pdt = (start if start is not None else running_pdt) + duration
            pdt = None
            index += 1
    return tags, pieces


def pick_format(info):
    """The live HLS rendition the caption job would want: H.264, at most
    720 lines, the tallest there is."""
    candidates = []
    for fmt in info.get("formats") or []:
        protocol = str(fmt.get("protocol") or "")
        if not protocol.startswith("m3u8"):
            continue
        vcodec = str(fmt.get("vcodec") or "none")
        if vcodec == "none":
            continue
        height = fmt.get("height") or 0
        candidates.append((vcodec.startswith("avc1"), height <= 720, height if height <= 720 else -height, fmt))
    if not candidates:
        return None
    candidates.sort(key=lambda row: row[:3])
    return candidates[-1][3]


def describe_formats(info):
    rows = []
    for fmt in info.get("formats") or []:
        rows.append({
            "id": fmt.get("format_id"), "protocol": fmt.get("protocol"),
            "vcodec": fmt.get("vcodec"), "acodec": fmt.get("acodec"),
            "height": fmt.get("height"), "fps": fmt.get("fps"),
        })
    return rows


# ---------------------------------------------------------------------------
# The engine's frame loop, one frame at a time
# ---------------------------------------------------------------------------

class FrameTracker:
    """process_video()'s loop body, fed one sampled frame at a time. Kept in
    step with that function by hand: this is a test, and the real build
    should make the two share one piece of code."""

    def __init__(self, coa, canon):
        self.coa = coa
        self.canon = canon
        self.crop = None
        self.cursor = 0
        self.locked = False
        self.local_misses = 0
        self.pending = None
        self.sig = None
        self.words = None
        self.counts = {"frames": 0, "noBox": 0, "boxHidden": 0, "noWords": 0, "noHighlight": 0,
                       "highlight": 0, "committed": 0, "held": 0, "relocalized": 0, "ocrRuns": 0}

    def feed(self, frame, t):
        """-> list of (t, start, end, score, heard) committed by this frame."""
        coa, counts = self.coa, self.counts
        counts["frames"] += 1
        if self.crop is None:
            self.crop = coa.auto_detect_box(frame)
            if self.crop is None:
                counts["noBox"] += 1
                return []
            log(f"Caption box found at x={self.crop[0]} y={self.crop[1]} w={self.crop[2]} h={self.crop[3]}")
        x, y, w, h = self.crop
        box = frame[y:y + h, x:x + w]
        if not coa.box_is_visible(box):
            counts["boxHidden"] += 1
            return []
        sig = coa.text_signature(box)
        if sig != self.sig:
            self.words = coa.ocr_caption(box)
            self.sig = sig
            counts["ocrRuns"] += 1
        if not self.words:
            counts["noWords"] += 1
            return []
        hl = coa.highlighted_words(box, self.words)
        if not hl:
            counts["noHighlight"] += 1
            return []
        counts["highlight"] += 1
        heard = " ".join(word.text for word in hl)
        out = []
        m = coa.match_phrase(self.canon, hl, self.cursor) if self.locked else None
        committed = False
        if m is not None:
            s, e, score = m
            pending_s = self.pending[1] if self.pending is not None else None
            verdict = coa._classify_jump(s, self.cursor, pending_s)
            if verdict == "commit":
                self.cursor = s
                out.append((t, s, e, round(score, 1), heard))
                self.pending = None
                committed = True
            elif verdict == "confirm":
                out.append(self.pending)
                out.append((t, s, e, round(score, 1), heard))
                self.cursor = s
                self.pending = None
                committed = True
            else:
                self.pending = (t, s, e, round(score, 1), heard)
                counts["held"] += 1
        else:
            self.pending = None
        if committed:
            self.local_misses = 0
            counts["committed"] += len(out)
            return out
        if self.locked:
            self.local_misses += 1
            if self.local_misses < coa.RELOCALIZE_AFTER:
                return []
        m = coa.match_phrase(self.canon, hl, self.cursor, global_search=True)
        if m is None:
            return []
        self.locked = True
        self.local_misses = 0
        self.pending = None
        s, e, score = m
        self.cursor = s
        counts["relocalized"] += 1
        counts["committed"] += 1
        return [(t, s, e, round(score, 1), heard)]


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

def summarize(values):
    if not values:
        return None
    ordered = sorted(values)
    pick = lambda q: ordered[min(len(ordered) - 1, int(q * len(ordered)))]
    return {"n": len(ordered), "min": round(ordered[0], 2), "median": round(statistics.median(ordered), 2),
            "p90": round(pick(0.9), 2), "max": round(ordered[-1], 2)}


def ffprobe_start(path):
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=start_time,duration",
             "-of", "json", path], capture_output=True, text=True, timeout=30).stdout
        fmt = json.loads(out).get("format", {})
        return float(fmt.get("start_time")), float(fmt.get("duration"))
    except Exception:
        return None, None


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--info", required=True, help="yt-dlp -J output for the stream")
    parser.add_argument("--cookies", default=None, help="cookies.txt, sent with playlist and media requests")
    parser.add_argument("--refs-json", required=True)
    parser.add_argument("--minutes", type=float, default=12.0)
    parser.add_argument("--sample-fps", type=float, default=3.0)
    parser.add_argument("--out-dir", default="probe-out")
    args = parser.parse_args()

    os.makedirs(args.out_dir, exist_ok=True)
    frames_dir = os.path.join(args.out_dir, "frames")
    os.makedirs(frames_dir, exist_ok=True)
    report = {"startedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"), "outcome": "started"}
    report_path = os.path.join(args.out_dir, "report.json")

    def save():
        with open(report_path, "w", encoding="utf-8") as handle:
            json.dump(report, handle, ensure_ascii=False, indent=2)

    info = json.load(open(args.info, encoding="utf-8"))
    report["video"] = {key: info.get(key) for key in (
        "id", "title", "is_live", "was_live", "live_status", "release_timestamp", "timestamp", "duration")}
    report["formats"] = describe_formats(info)
    log(f"Video {info.get('id')}: live_status={info.get('live_status')} release_timestamp={info.get('release_timestamp')}")
    fmt = pick_format(info)
    if fmt is None:
        report["outcome"] = "no-hls-format"
        save()
        log("yt-dlp listed no HLS rendition with video. Formats: " + json.dumps(report["formats"]))
        return 0
    report["format"] = {key: fmt.get(key) for key in ("format_id", "protocol", "vcodec", "height", "width", "fps")}
    log(f"Reading format {fmt.get('format_id')} ({fmt.get('height')}p {fmt.get('vcodec')}, {fmt.get('protocol')})")
    if info.get("live_status") != "is_live":
        report["outcome"] = "not-live"
        save()
        log("The video is not on the air. Setup worked this far; nothing more to measure.")
        return 0

    session = requests.Session()
    session.headers.update(fmt.get("http_headers") or {})
    if args.cookies and os.path.exists(args.cookies):
        jar = http.cookiejar.MozillaCookieJar(args.cookies)
        try:
            jar.load(ignore_discard=True, ignore_expires=True)
            session.cookies = jar
        except Exception as error:
            log(f"Cookies file could not be read ({type(error).__name__}); going on without it.")

    refs = json.loads(args.refs_json)
    tracker = None
    canon = []
    try:
        import cv2
        import caption_ocr_align as coa
        canon, segments = coa.load_canonical(refs, args.out_dir)
        log(f"Daf text: {len(segments)} segments, {len(canon)} words for {refs}")
        tracker = FrameTracker(coa, canon)
    except Exception as error:
        report["engineError"] = redact(f"{type(error).__name__}: {error}")[:300]
        log(f"The engine could not be set up ({report['engineError']}). Reading the stream anyway.")
        cv2 = None

    playlist_url = fmt["url"]
    deadline = time.time() + args.minutes * 60
    seen = set()
    pieces_log, events, lags, fetch_seconds, work_seconds, publish_gaps = [], [], [], [], [], []
    playlist_errors = 0
    piece_errors = 0
    first_tags = None
    first_playlist = True
    last_frame_saved = 0.0
    polls = 0

    while time.time() < deadline:
        polls += 1
        try:
            response = session.get(playlist_url, timeout=15)
            status = response.status_code
            text = response.text if status == 200 else ""
        except Exception as error:
            status, text = f"{type(error).__name__}", ""
        if status != 200:
            playlist_errors += 1
            log(f"Playlist request failed: {status}")
            if playlist_errors >= 20:
                break
            time.sleep(3)
            continue
        tags, pieces = parse_playlist(text)
        if first_tags is None:
            first_tags = tags
            report["playlistTags"] = tags
            report["playlistHasProgramDateTime"] = any(p["pdt"] is not None for p in pieces)
            report["playlistPieces"] = len(pieces)
            log(f"Playlist: {len(pieces)} pieces listed, program-date-time "
                f"{'present' if report['playlistHasProgramDateTime'] else 'ABSENT'}; tags {tags[:8]}")
        if first_playlist:
            # Start at the live edge, as a viewer who has just opened the page
            # would: everything already listed but the newest two pieces is
            # history.
            for old in pieces[:-2]:
                seen.add(old["sq"])
            first_playlist = False
        fresh = [p for p in pieces if p["sq"] not in seen]
        for piece in fresh:
            seen.add(piece["sq"])
            noticed = time.time()
            row = {"sq": piece["sq"], "duration": piece["duration"], "pdt": piece["pdt"],
                   "noticedAt": round(noticed, 2)}
            if piece["pdt"] is not None and piece["duration"]:
                # A piece cannot be published before its last frame exists.
                row["noticedAfterPieceEnd"] = round(noticed - (piece["pdt"] + piece["duration"]), 2)
                publish_gaps.append(row["noticedAfterPieceEnd"])
            started = time.time()
            path = None
            try:
                media = session.get(urljoin(playlist_url, piece["url"]), timeout=30)
                if media.status_code != 200:
                    raise RuntimeError(f"HTTP {media.status_code}")
                handle = tempfile.NamedTemporaryFile(suffix=".ts", delete=False, dir=args.out_dir)
                handle.write(media.content)
                handle.close()
                path = handle.name
                row["bytes"] = len(media.content)
            except Exception as error:
                piece_errors += 1
                row["error"] = redact(f"{type(error).__name__}: {error}")[:120]
                pieces_log.append(row)
                log(f"Piece {piece['sq']} could not be fetched: {row['error']}")
                continue
            row["fetchSeconds"] = round(time.time() - started, 2)
            fetch_seconds.append(row["fetchSeconds"])

            if len(pieces_log) < 6:
                row["ptsStart"], row["ptsDuration"] = ffprobe_start(path)

            work_started = time.time()
            piece_events = 0
            if cv2 is not None and tracker is not None:
                capture = cv2.VideoCapture(path)
                fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
                step = max(1, round(fps / args.sample_fps))
                index = 0
                decoded = 0
                while True:
                    if not capture.grab():
                        break
                    if index % step:
                        index += 1
                        continue
                    ok, frame = capture.retrieve()
                    index += 1
                    if not ok:
                        break
                    decoded += 1
                    offset = (index - 1) / fps
                    frame_time = (piece["pdt"] + offset) if piece["pdt"] is not None else None
                    try:
                        committed = tracker.feed(frame, frame_time if frame_time is not None else noticed + offset)
                    except Exception as error:
                        report.setdefault("frameErrors", []).append(redact(f"{type(error).__name__}: {error}")[:160])
                        committed = []
                    now = time.time()
                    for (t, s, e, score, heard) in committed:
                        piece_events += 1
                        lag = (now - t) if piece["pdt"] is not None else None
                        if lag is not None:
                            lags.append(lag)
                        events.append({"frameTime": round(t, 2), "emittedAt": round(now, 2),
                                       "lag": round(lag, 2) if lag is not None else None,
                                       "w0": s, "w1": e, "score": score,
                                       "ref": canon[s].ref if s < len(canon) else None,
                                       "heard": heard,
                                       "daf": " ".join(c.text for c in canon[s:e + 1])})
                    if now - last_frame_saved > 45 and frame_time is not None:
                        stamp = datetime.fromtimestamp(frame_time, timezone.utc).strftime("%H%M%S")
                        name = f"sq{piece['sq']}-pdt{stamp}"
                        cv2.imwrite(os.path.join(frames_dir, name + ".jpg"), frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
                        if tracker.crop is not None:
                            x, y, w, h = tracker.crop
                            cv2.imwrite(os.path.join(frames_dir, name + "-caption.png"), frame[y:y + h, x:x + w])
                        last_frame_saved = now
                capture.release()
                row["fps"] = round(fps, 2)
                row["sampledFrames"] = decoded
            row["workSeconds"] = round(time.time() - work_started, 2)
            work_seconds.append(row["workSeconds"])
            row["events"] = piece_events
            if piece["pdt"] is not None:
                row["doneBehindFirstFrame"] = round(time.time() - piece["pdt"], 2)
            pieces_log.append(row)
            try:
                os.unlink(path)
            except OSError:
                pass
            if len(pieces_log) % 12 == 1:
                log(f"piece {piece['sq']}: fetched in {row['fetchSeconds']}s, read in {row['workSeconds']}s, "
                    f"{piece_events} matches, finished {row.get('doneBehindFirstFrame')}s after its first frame aired; "
                    f"tracker {tracker.counts if tracker else None}")
            report.update({"pieces": pieces_log, "events": events})
            save()
        time.sleep(1.5)

    # The stream's own "second zero": a piece's ingestion time minus the
    # stream time its number stands for. Constant if the two are one clock.
    zero_estimates = []
    durations = [p["duration"] for p in pieces_log if p.get("duration")]
    typical = statistics.median(durations) if durations else None
    if typical:
        for p in pieces_log:
            if p.get("pdt") is not None:
                zero_estimates.append(p["pdt"] - p["sq"] * typical)
    pts_zero = [p["pdt"] - p["ptsStart"] for p in pieces_log
                if p.get("pdt") is not None and p.get("ptsStart") is not None]

    report.update({
        "outcome": "read" if pieces_log and piece_errors < len(pieces_log) else "could-not-read",
        "finishedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "polls": polls,
        "playlistErrors": playlist_errors,
        "pieceErrors": piece_errors,
        "piecesRead": len([p for p in pieces_log if "error" not in p]),
        "typicalPieceSeconds": typical,
        "noticedAfterPieceEnd": summarize(publish_gaps),
        "fetchSeconds": summarize(fetch_seconds),
        "workSecondsPerPiece": summarize(work_seconds),
        "matchLagSeconds": summarize(lags),
        "tracker": tracker.counts if tracker else None,
        "captionBox": list(tracker.crop) if tracker and tracker.crop is not None else None,
        "locked": bool(tracker and tracker.locked),
        "streamZeroFromPieceNumbers": summarize(zero_estimates),
        "streamZeroFromPts": summarize(pts_zero),
        "pieces": pieces_log,
        "events": events,
    })
    save()

    log("---- summary ----")
    for key in ("outcome", "piecesRead", "pieceErrors", "playlistErrors", "typicalPieceSeconds",
                "noticedAfterPieceEnd", "fetchSeconds", "workSecondsPerPiece", "matchLagSeconds",
                "tracker", "captionBox", "locked", "streamZeroFromPieceNumbers", "streamZeroFromPts"):
        log(f"{key}: {json.dumps(report.get(key), ensure_ascii=False)}")
    log(f"release_timestamp (YouTube's start time): {info.get('release_timestamp')}")
    for event in events[:5] + events[-5:]:
        log(f"  match at {event['frameTime']} (+{event['lag']}s): [{event['w0']}-{event['w1']}] {event['score']} {event['daf']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
