"""Local companion server for DafSync Caption Sync.

While the desktop app is running, this serves a small HTTP API on
127.0.0.1 only (never reachable from other machines) so the DafSync
website can hand it a local video file and get back the same alignment
JSON the app's own GUI produces — without the user needing to manually
export/import a file.

Security model:
  - Binds to 127.0.0.1 only (loopback) — nothing outside this machine can
    ever reach it, regardless of firewall/network configuration.
  - Only responds with CORS headers (and therefore is only readable by
    browser JS) for an explicit allow-list of origins: the real DafSync
    website and localhost, for local development. Any other page that
    tries to call it from a browser is blocked by the browser's own CORS
    enforcement, since no Access-Control-Allow-Origin header is sent back.
  - Read-only outward: it never returns anything about the filesystem
    beyond the job's own output, and every job is isolated to its own
    temp directory.
"""

import json
import os
import re
import shutil
import tempfile
import threading
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 8765

# The real DafSync website (confirmed via the connected Netlify project)
# plus localhost, for running the site locally during development.
ALLOWED_ORIGINS = {
    "https://mdysync.netlify.app",
    "https://main--mdysync.netlify.app",
    "http://localhost:8080",
    "http://127.0.0.1:8080",
}

APP_VERSION = "0.3.0"


class JobRegistry:
    """Thread-safe in-memory job store. Jobs disappear when the app closes;
    nothing here is meant to persist."""

    def __init__(self):
        self._lock = threading.Lock()
        self._jobs = {}

    def has_active_job(self):
        with self._lock:
            return any(job["status"] == "processing"
                       for job in self._jobs.values())

    def create(self):
        job_id = uuid.uuid4().hex
        with self._lock:
            self._jobs[job_id] = {
                "status": "processing",
                "progress": 0.0,
                "log": [],
                "result": None,
                "error": None,
            }
        return job_id

    def update(self, job_id, **fields):
        with self._lock:
            if job_id in self._jobs:
                self._jobs[job_id].update(fields)

    def append_log(self, job_id, line):
        with self._lock:
            job = self._jobs.get(job_id)
            if job is not None:
                job["log"].append(line)
                # keep only the most recent lines; the GUI log has the rest
                if len(job["log"]) > 200:
                    job["log"] = job["log"][-200:]

    def get(self, job_id):
        with self._lock:
            job = self._jobs.get(job_id)
            return dict(job) if job is not None else None


def _parse_multipart(body: bytes, content_type: str):
    """Minimal multipart/form-data parser for exactly the shape this app's
    own website sends: one 'video' file field and one 'refs' text field.
    Avoids depending on the deprecated stdlib cgi module or a third-party
    package that would need bundling."""
    m = re.search(r'boundary="?([^";]+)"?', content_type)
    if not m:
        raise ValueError("Missing multipart boundary")
    boundary = ("--" + m.group(1)).encode()
    parts = body.split(boundary)
    fields = {}
    files = {}
    for part in parts:
        part = part.strip(b"\r\n")
        if not part or part == b"--":
            continue
        if b"\r\n\r\n" not in part:
            continue
        header_blob, content = part.split(b"\r\n\r\n", 1)
        content = content.rstrip(b"\r\n")
        headers = header_blob.decode("utf-8", errors="replace")
        name_match = re.search(r'name="([^"]+)"', headers)
        if not name_match:
            continue
        field_name = name_match.group(1)
        filename_match = re.search(r'filename="([^"]*)"', headers)
        if filename_match:
            files[field_name] = {
                "filename": filename_match.group(1),
                "content": content,
            }
        else:
            fields[field_name] = content.decode("utf-8", errors="replace")
    return fields, files


def make_handler(registry: JobRegistry, gui_queue, engine):
    process_video, build_outputs = engine

    class Handler(BaseHTTPRequestHandler):
        server_version = "DafSyncLocal/1.0"

        def log_message(self, fmt, *args):
            pass  # keep the app's own console/log quiet

        def _origin(self):
            return self.headers.get("Origin", "")

        def _drain(self):
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length:
                    self.rfile.read(length)
            except (OSError, ValueError):
                pass

        def _cors_headers(self):
            origin = self._origin()
            if origin in ALLOWED_ORIGINS:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Content-Type")

        def _send_json(self, status, payload):
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self._cors_headers()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self):
            self.send_response(204)
            self._cors_headers()
            self.end_headers()

        def do_GET(self):
            if self.path == "/dafsync/status":
                self._send_json(200, {
                    "status": "ready",
                    "app": "DafSyncCaptionSync",
                    "version": APP_VERSION,
                })
                return
            m = re.match(r"^/dafsync/jobs/([0-9a-f]{32})$", self.path)
            if m:
                job = registry.get(m.group(1))
                if job is None:
                    self._send_json(404, {"error": "Unknown job id."})
                else:
                    self._send_json(200, job)
                return
            self._send_json(404, {"error": "Not found."})

        def do_POST(self):
            if self.path != "/dafsync/jobs":
                self._drain()
                self._send_json(404, {"error": "Not found."})
                return
            if self._origin() not in ALLOWED_ORIGINS:
                # Drain the body before responding: closing the socket while
                # the client is still mid-upload causes a broken-pipe error
                # on their end instead of a clean 403 response.
                self._drain()
                self._send_json(403, {"error": "Origin not permitted."})
                return
            if registry.has_active_job():
                self._drain()
                self._send_json(
                    409, {"error": "Another sync is already running in "
                                   "this app. Wait for it to finish."})
                return

            try:
                length = int(self.headers.get("Content-Length", "0"))
                body = self.rfile.read(length)
                fields, files = _parse_multipart(
                    body, self.headers.get("Content-Type", ""))
                if "video" not in files:
                    self._send_json(400, {"error": "Missing video file."})
                    return
                refs = json.loads(fields.get("refs", "[]"))
                if not isinstance(refs, list) or not refs:
                    self._send_json(400, {"error": "Missing readings list."})
                    return
            except Exception as exc:
                self._send_json(400, {"error": f"Bad request: {exc}"})
                return

            job_id = registry.create()
            video_info = files["video"]
            work_dir = tempfile.mkdtemp(prefix="dafsync-web-")
            video_path = os.path.join(
                work_dir, video_info["filename"] or "video.mp4")
            with open(video_path, "wb") as fh:
                fh.write(video_info["content"])

            thread = threading.Thread(
                target=_run_job,
                args=(job_id, video_path, refs, work_dir, registry,
                      gui_queue, process_video, build_outputs),
                daemon=True)
            thread.start()
            self._send_json(202, {"jobId": job_id})

    return Handler


def _run_job(job_id, video_path, refs, work_dir, registry, gui_queue,
             process_video, build_outputs):
    try:
        if gui_queue is not None:
            gui_queue.put(("log", f"[web] Starting sync for {', '.join(refs)}"))

        def progress(frac):
            registry.update(job_id, progress=frac)
            if gui_queue is not None:
                gui_queue.put(("progress", frac))

        def on_line(line):
            registry.append_log(job_id, line)
            if gui_queue is not None:
                gui_queue.put(("log", f"[web] {line}"))

        import contextlib

        class _Writer:
            def write(self, text):
                if text.strip():
                    on_line(text.rstrip("\n"))

            def flush(self):
                pass

        with contextlib.redirect_stdout(_Writer()), \
                contextlib.redirect_stderr(_Writer()):
            canon, segments, events, duration = process_video(
                video_path, refs, out_dir=work_dir, progress=progress)
            if not events:
                raise RuntimeError(
                    "No highlighted caption text could be matched. Check "
                    "that the video shows the caption box and that the "
                    "readings cover this lecture.")
            alignment, word_map = build_outputs(
                canon, segments, events, duration, video_path, refs)

        registry.update(job_id, status="done", progress=1.0,
                        result={"alignment": alignment, "wordmap": word_map})
        if gui_queue is not None:
            gui_queue.put(("progress", 1.0))
            gui_queue.put(("log", "[web] Done — result sent back to the website."))
    except Exception as exc:
        registry.update(job_id, status="error", error=str(exc))
        if gui_queue is not None:
            gui_queue.put(("log", f"[web] Failed: {traceback.format_exc(limit=3)}"))
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


def start_server(gui_queue, process_video, build_outputs):
    """Start the local server in a background thread. Returns the server
    instance, or None if the port could not be bound (most likely because
    another instance of this app is already running and serving it —
    in that case this process simply doesn't start its own)."""
    registry = JobRegistry()
    handler = make_handler(registry, gui_queue, (process_video, build_outputs))
    try:
        server = ThreadingHTTPServer(("127.0.0.1", PORT), handler)
    except OSError:
        return None
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server
