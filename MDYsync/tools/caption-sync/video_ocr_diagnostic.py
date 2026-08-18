#!/usr/bin/env python3
"""One-off diagnostic (not a shipped feature): compares Tesseract vs Google
Vision on real caption-box crops from a real Daf Yomi shiur video, to check
whether swapping the video-caption OCR engine (caption_ocr_align.py's
ocr_caption) over to Vision the way page_ocr_align.py's page mapper already
was would actually help, or whether the caption box's cleaner rendered font
(unlike the page mapper's centuries-old scanned print typeface) means
Tesseract is already good enough there.

Downloads a real video segment, samples frames the same way
caption_ocr_align.py's process_video does (auto-detect the caption box,
dedupe by text_signature so only genuinely distinct captions get OCR'd),
runs both engines on each distinct caption, and prints them side by side
plus saves the crops as an artifact so a human (or a second read) can check
against the actual printed words.
"""
import base64
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

import cv2

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from caption_ocr_align import auto_detect_box, box_is_visible, text_signature, ocr_caption
from page_ocr_align import get_google_vision_access_token

VIDEO_URL = os.environ.get('VIDEO_URL') or 'https://www.youtube.com/watch?v=OFNumwQ8tnU'
START = os.environ.get('CLIP_START') or '300'
DURATION = os.environ.get('CLIP_DURATION') or '90'
OUT_DIR = 'video-ocr-out'
MAX_SAMPLES = int(os.environ.get('MAX_SAMPLES', '25'))


def download_clip():
    os.makedirs(OUT_DIR, exist_ok=True)
    out_path = os.path.join(OUT_DIR, 'clip.mp4')
    cmd = [
        'yt-dlp', '-f', 'best[height<=480]',
        '--downloader', 'ffmpeg',
        '--downloader-args', f'ffmpeg_i:-ss {START} -t {DURATION}',
        '-o', out_path, VIDEO_URL,
    ]
    print('Running:', ' '.join(cmd))
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    print(r.stdout[-3000:])
    print(r.stderr[-3000:])
    if r.returncode != 0 or not os.path.exists(out_path):
        raise RuntimeError(f'yt-dlp failed (exit {r.returncode})')
    return out_path


def ocr_crop_google_vision(crop_bgr, credentials_json):
    ok, buf = cv2.imencode('.png', crop_bgr)
    if not ok:
        return ''
    token = get_google_vision_access_token(credentials_json)
    payload = {
        'requests': [{
            'image': {'content': base64.b64encode(buf.tobytes()).decode('ascii')},
            'features': [{'type': 'DOCUMENT_TEXT_DETECTION'}],
            'imageContext': {'languageHints': ['he']},
        }],
    }
    req = urllib.request.Request(
        'https://vision.googleapis.com/v1/images:annotate',
        data=json.dumps(payload).encode('utf-8'),
        headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {token}'},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read())
    except urllib.error.HTTPError as e:
        return f'ERROR: {e.read().decode("utf-8", errors="replace")}'
    resp = data['responses'][0]
    full = resp.get('fullTextAnnotation')
    if not full:
        return ''
    return full.get('text', '').replace('\n', ' ').strip()


def main():
    clip_path = download_clip()
    credentials_json = os.environ.get('GOOGLE_VISION_CREDENTIALS_JSON')
    if not credentials_json:
        print('WARNING: no GOOGLE_VISION_CREDENTIALS_JSON, skipping Vision comparison')

    cap = cv2.VideoCapture(clip_path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    nframes = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    print(f'Clip: {nframes} frames @ {fps:.2f}fps')

    step = max(1, round(fps / 3.0))
    crop = None
    sig, cached_words = None, None
    frame_idx = 0
    sample_idx = 0
    os.makedirs(os.path.join(OUT_DIR, 'frames'), exist_ok=True)
    results = []

    while sample_idx < MAX_SAMPLES:
        ok = cap.grab()
        if not ok:
            break
        if frame_idx % step:
            frame_idx += 1
            continue
        ok, frame = cap.retrieve()
        frame_idx += 1
        if not ok:
            break

        if crop is None:
            crop = auto_detect_box(frame)
            if crop is None:
                continue
            print(f'Auto-detected caption box: {crop}')
        x, y, w, h = crop
        box = frame[y:y + h, x:x + w]
        if not box_is_visible(box):
            continue

        s = text_signature(box)
        if s == sig:
            continue
        sig = s
        sample_idx += 1

        tesseract_words = ocr_caption(box)
        tesseract_text = ' '.join(w.text for w in tesseract_words)

        vision_text = ''
        if credentials_json:
            vision_text = ocr_crop_google_vision(box, credentials_json)

        frame_path = os.path.join(OUT_DIR, 'frames', f'sample_{sample_idx:03d}.png')
        cv2.imwrite(frame_path, box)
        t = frame_idx / fps
        print(f'--- sample {sample_idx} @ t={t:.1f}s ---')
        print(f'  tesseract: {tesseract_text}')
        print(f'  vision:    {vision_text}')
        results.append({'t': t, 'tesseract': tesseract_text, 'vision': vision_text, 'frame': frame_path})

    with open(os.path.join(OUT_DIR, 'results.json'), 'w', encoding='utf-8') as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    print(f'\nWrote {len(results)} samples to {OUT_DIR}/results.json')


if __name__ == '__main__':
    main()
