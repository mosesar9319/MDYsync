#!/usr/bin/env python3
"""DafSync Caption Sync — desktop app.

A small GUI around caption_ocr_align.py: pick a lecture video, enter the
Sefaria refs it covers, and get an alignment JSON (with a word-level
timeline) ready to import into DafSync Studio.

Run from source:  python3 gui_app.py
Packaged builds (PyInstaller) bundle Python, OpenCV, and Tesseract with the
Hebrew language data, so nothing needs to be installed separately.
"""

import os
import queue
import re
import sys
import threading
import traceback
import contextlib
import tkinter as tk
from tkinter import filedialog, messagebox, ttk


def app_dir():
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


# Point pytesseract at the bundled Tesseract before the engine imports it.
_bundled_tess = os.path.join(app_dir(), "tesseract", "tesseract.exe")
if os.path.exists(_bundled_tess):
    os.environ["TESSDATA_PREFIX"] = os.path.join(
        app_dir(), "tesseract", "tessdata")
    import pytesseract
    pytesseract.pytesseract.tesseract_cmd = _bundled_tess

import json

from caption_ocr_align import build_outputs, process_video


def parse_refs(raw):
    """Accept 'Chullin 80b, Chullin 81a' (or newline/semicolon separated)
    and return Sefaria API refs like ['Chullin.80b', 'Chullin.81a'].

    Drops a stray word "daf" (e.g. someone typing "Chullin Daf 84"), which
    isn't part of Sefaria's reference syntax — the format is just the
    tractate, the page number, and a/b for the amud (side of the page).
    """
    refs = []
    for part in re.split(r"[,;\n]+", raw):
        part = part.strip()
        part = re.sub(r"(?i)\bdaf\b", "", part).strip()
        part = re.sub(r"\s+", " ", part)
        if part:
            refs.append(re.sub(r"\s+", ".", part))
    return refs


class QueueWriter:
    def __init__(self, q):
        self.q = q

    def write(self, text):
        if text.strip():
            self.q.put(("log", text.rstrip("\n")))

    def flush(self):
        pass


class App:
    def __init__(self, root):
        self.root = root
        root.title("DafSync Caption Sync")
        root.geometry("680x520")
        root.minsize(560, 420)

        self.q = queue.Queue()
        self.worker = None
        self.out_paths = None

        pad = {"padx": 10, "pady": 4}
        frame = ttk.Frame(root)
        frame.pack(fill="both", expand=True)

        ttk.Label(frame, text="Lecture video file:").grid(
            row=0, column=0, sticky="w", **pad)
        self.video_var = tk.StringVar()
        ttk.Entry(frame, textvariable=self.video_var).grid(
            row=1, column=0, sticky="ew", **pad)
        ttk.Button(frame, text="Browse…", command=self.pick_video).grid(
            row=1, column=1, **pad)

        ttk.Label(
            frame,
            text="Daf covered (Sefaria refs, in order — e.g. "
                 "Chullin 80b, Chullin 81a):").grid(
            row=2, column=0, sticky="w", **pad)
        self.refs_var = tk.StringVar()
        ttk.Entry(frame, textvariable=self.refs_var).grid(
            row=3, column=0, columnspan=2, sticky="ew", **pad)

        ttk.Label(frame, text="Output folder:").grid(
            row=4, column=0, sticky="w", **pad)
        self.out_var = tk.StringVar()
        ttk.Entry(frame, textvariable=self.out_var).grid(
            row=5, column=0, sticky="ew", **pad)
        ttk.Button(frame, text="Browse…", command=self.pick_out).grid(
            row=5, column=1, **pad)

        self.run_btn = ttk.Button(frame, text="Sync", command=self.run)
        self.run_btn.grid(row=6, column=0, columnspan=2, pady=10)

        self.progress = ttk.Progressbar(frame, maximum=1.0)
        self.progress.grid(row=7, column=0, columnspan=2, sticky="ew", **pad)

        self.log = tk.Text(frame, height=12, state="disabled", wrap="word")
        self.log.grid(row=8, column=0, columnspan=2, sticky="nsew", **pad)

        self.open_btn = ttk.Button(
            frame, text="Open output folder", command=self.open_out,
            state="disabled")
        self.open_btn.grid(row=9, column=0, columnspan=2, pady=(0, 10))

        frame.columnconfigure(0, weight=1)
        frame.rowconfigure(8, weight=1)

        root.after(150, self.poll_queue)

    # ------------------------------------------------------------------ UI

    def pick_video(self):
        path = filedialog.askopenfilename(
            title="Choose the lecture video",
            filetypes=[("Video files", "*.mp4 *.webm *.mkv *.mov *.avi"),
                       ("All files", "*.*")])
        if path:
            self.video_var.set(path)
            if not self.out_var.get():
                self.out_var.set(os.path.join(
                    os.path.dirname(path), "dafsync-output"))

    def pick_out(self):
        path = filedialog.askdirectory(title="Choose the output folder")
        if path:
            self.out_var.set(path)

    def log_line(self, text):
        self.log.configure(state="normal")
        self.log.insert("end", text + "\n")
        self.log.see("end")
        self.log.configure(state="disabled")

    def open_out(self):
        out = self.out_var.get()
        if os.path.isdir(out):
            if sys.platform == "win32":
                os.startfile(out)  # noqa: S606 - opening the user's own folder
            else:
                import subprocess
                subprocess.Popen(["xdg-open", out])

    # -------------------------------------------------------------- worker

    def run(self):
        video = self.video_var.get().strip()
        refs = parse_refs(self.refs_var.get())
        out = self.out_var.get().strip()
        if not os.path.isfile(video):
            messagebox.showerror("DafSync", "Choose a video file first.")
            return
        if not refs:
            messagebox.showerror(
                "DafSync",
                "Enter the daf the lecture covers, e.g. Chullin 80b.")
            return
        if not out:
            out = os.path.join(os.path.dirname(video), "dafsync-output")
            self.out_var.set(out)

        self.run_btn.configure(state="disabled")
        self.open_btn.configure(state="disabled")
        self.progress.configure(value=0)
        self.out_paths = None
        self.worker = threading.Thread(
            target=self.work, args=(video, refs, out), daemon=True)
        self.worker.start()

    def work(self, video, refs, out):
        writer = QueueWriter(self.q)
        try:
            os.makedirs(out, exist_ok=True)
            with contextlib.redirect_stdout(writer), \
                    contextlib.redirect_stderr(writer):
                canon, segments, events, duration = process_video(
                    video, refs, out_dir=out,
                    progress=lambda f: self.q.put(("progress", f)))
                if not events:
                    raise RuntimeError(
                        "No highlighted caption text could be matched. "
                        "Check that the video shows the caption box and "
                        "that the refs cover this lecture.")
                alignment, word_map = build_outputs(
                    canon, segments, events, duration, video, refs)
            a_path = os.path.join(out, "alignment.json")
            w_path = os.path.join(out, "wordmap.json")
            with open(a_path, "w", encoding="utf-8") as fh:
                json.dump(alignment, fh, ensure_ascii=False, indent=2)
            with open(w_path, "w", encoding="utf-8") as fh:
                json.dump(word_map, fh, ensure_ascii=False, indent=2)
            self.q.put(("done", (a_path, len(alignment["segments"]),
                                 len(alignment["wordTimeline"]))))
        except Exception as exc:  # surface everything to the log window
            self.q.put(("log", traceback.format_exc(limit=3)))
            self.q.put(("error", str(exc)))

    def poll_queue(self):
        try:
            while True:
                kind, payload = self.q.get_nowait()
                if kind == "log":
                    self.log_line(payload)
                elif kind == "progress":
                    self.progress.configure(value=payload)
                elif kind == "done":
                    path, nseg, nwords = payload
                    self.progress.configure(value=1.0)
                    self.log_line(
                        f"Done — {nseg} segments, {nwords} word spans.")
                    self.log_line(f"Alignment saved to: {path}")
                    self.log_line(
                        "Import this file in DafSync Studio with "
                        "“Import alignment”.")
                    self.run_btn.configure(state="normal")
                    self.open_btn.configure(state="normal")
                elif kind == "error":
                    self.log_line(f"Failed: {payload}")
                    self.run_btn.configure(state="normal")
                    messagebox.showerror("DafSync", payload)
        except queue.Empty:
            pass
        self.root.after(150, self.poll_queue)


def main():
    root = tk.Tk()
    try:
        ttk.Style().theme_use("clam")
    except tk.TclError:
        pass
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
