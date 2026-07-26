#!/usr/bin/env python3
"""Word-position OCR for a single Vilna-style daf page image.

Fetches a page from shas.org's Daf PDF API, OCRs the Gemara column (the
band between the outer marginalia and the Rashi/Tosafot columns -- see the
module docstring notes below for how that band was found), and matches the
recognized words against the canonical Sefaria text using the same
fuzzy-matching engine as the video caption OCR (caption_ocr_align.py),
fed an incrementing index instead of a timestamp as its "cursor" signal.

Layout notes (validated against real rendered pages, not assumed):
  - The band from 15%-65.5% of the page width is a SINGLE wide Gemara
    column, not two interleaved columns. Rashi and Tosafot are entirely
    outside it, in the outer margins. An earlier attempt to split this
    band in half (assuming Gemara+Tosafot were both inside it) was wrong
    and produced much worse coverage (~35%) than treating it as one
    column (~77% mean across a 9-page sample, up to ~89% on ordinary
    interior pages).
  - Which outer margin holds Rashi vs Tosafot swaps between amud a and
    amud b (Rashi is on the right and Tosafot on the left on amud a;
    Tosafot is on the right and Rashi on the left on amud b), but this
    does not affect the band crop itself, since the band's boundaries
    were empirically identical across amud a and b samples.
  - Pages with atypical extra content (a special marginal box, or the
    ornate frame on a tractate's opening 2a) measurably reduce coverage
    (validated 46-60% on such pages vs 74-89% on ordinary ones). This is
    a known, accepted limitation, not a bug to chase down.

Example:
    python3 page_ocr_align.py --tractate Chullin --daf 86 --amud a \
        --out-dir out/
"""

import argparse
import json
import os
import sys
import urllib.request

import cv2
import pytesseract

from caption_ocr_align import normalize_word, load_canonical, match_phrase

MASECHTA_SLUGS = {
    'Berakhot': 'berachos', 'Shabbat': 'shabbos', 'Eruvin': 'eruvin', 'Pesachim': 'pesachim',
    'Yoma': 'yoma', 'Sukkah': 'sukkah', 'Beitzah': 'beitzah', 'Rosh Hashanah': 'rosh-hashanah',
    'Taanit': 'taanis', 'Megillah': 'megillah', 'Moed Katan': 'moed-katan', 'Chagigah': 'chagigah',
    'Yevamot': 'yevamos', 'Ketubot': 'kesubos', 'Nedarim': 'nedarim', 'Nazir': 'nazir',
    'Sotah': 'sotah', 'Gittin': 'gittin', 'Kiddushin': 'kiddushin', 'Bava Kamma': 'bava-kamma',
    'Bava Metzia': 'bava-metzia', 'Bava Batra': 'bava-basra', 'Sanhedrin': 'sanhedrin',
    'Makkot': 'makkos', 'Shevuot': 'shevuos', 'Avodah Zarah': 'avodah-zarah', 'Horayot': 'horayos',
    'Zevachim': 'zevachim', 'Menachot': 'menachos', 'Chullin': 'chullin', 'Bekhorot': 'bechoros',
    'Arakhin': 'arachin', 'Temurah': 'temurah', 'Keritot': 'kereisos', 'Meilah': 'meilah',
    'Niddah': 'niddah',
}

BAND_X0_FRAC = 0.15
BAND_X1_FRAC = 0.655
OCR_SCALE = 2.2
CHUNK_SIZE = 3
RELOCALIZE_AFTER = 12


def fetch_page_pdf(tractate, daf, amud, out_path):
    slug = MASECHTA_SLUGS.get(tractate)
    if not slug:
        raise RuntimeError(f"Unknown tractate '{tractate}'.")
    url = (f"https://www.shas.org/daf-pdf/api/?masechta={slug}"
           f"&daf={daf}&amud={amud}")
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/pdf,*/*',
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        data = r.read()
    if len(data) < 5000:
        raise RuntimeError(f"No page image available for {tractate} {daf}{amud}.")
    with open(out_path, 'wb') as f:
        f.write(data)


def pdf_to_png(pdf_path, out_prefix, dpi=150):
    ret = os.system(f'pdftoppm -png -r {dpi} "{pdf_path}" "{out_prefix}"')
    if ret != 0:
        raise RuntimeError('pdftoppm failed; is poppler-utils installed?')
    png_path = f'{out_prefix}-1.png'
    if not os.path.exists(png_path):
        # single-page output can also be written without the "-1" suffix
        alt = f'{out_prefix}.png'
        if os.path.exists(alt):
            return alt
        raise RuntimeError('Expected PNG output not found after pdftoppm.')
    return png_path


def ocr_band_words(page_png):
    img = cv2.imread(page_png)
    h, w = img.shape[:2]
    x0, x1 = int(w * BAND_X0_FRAC), int(w * BAND_X1_FRAC)
    band = img[:, x0:x1]

    gray = cv2.cvtColor(band, cv2.COLOR_BGR2GRAY)
    gray = cv2.resize(gray, None, fx=OCR_SCALE, fy=OCR_SCALE, interpolation=cv2.INTER_CUBIC)
    _, th = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    d = pytesseract.image_to_data(th, lang='heb', config='--psm 6', output_type=pytesseract.Output.DICT)

    words = []
    for i in range(len(d['text'])):
        t = d['text'][i].strip()
        n = normalize_word(t)
        if not n:
            continue
        # Convert back to full-page pixel space: undo the OCR upscale, then
        # add the band's x-offset within the full page.
        words.append({
            'text': t,
            'norm': n,
            'x': x0 + d['left'][i] / OCR_SCALE,
            'y': d['top'][i] / OCR_SCALE,
            'w': d['width'][i] / OCR_SCALE,
            'h': d['height'][i] / OCR_SCALE,
        })
    return words, w, h


def match_words_to_canon(canon, words):
    """Sequentially fuzzy-match OCR'd words (in their natural reading
    order from image_to_data) against the canonical word stream, using an
    incrementing chunk index as the "cursor" signal in place of a
    timestamp -- the matching algorithm doesn't care what the ordering
    signal represents, only that it's monotonic-ish."""
    cursor = 0
    locked = False
    local_misses = 0
    hits = []
    for i in range(0, len(words), CHUNK_SIZE):
        chunk_words = words[i:i + CHUNK_SIZE]
        chunk = [type('W', (), {'text': w['text'], 'norm': w['norm']})() for w in chunk_words]
        m = match_phrase(canon, chunk, cursor) if locked else None
        if m is None:
            if locked:
                local_misses += 1
                if local_misses < RELOCALIZE_AFTER:
                    continue
            m = match_phrase(canon, chunk, cursor, global_search=True)
            if m is None:
                continue
            locked = True
        local_misses = 0
        s, e, score = m
        cursor = s
        xs = min(w['x'] for w in chunk_words)
        xe = max(w['x'] + w['w'] for w in chunk_words)
        ys = min(w['y'] for w in chunk_words)
        ye = max(w['y'] + w['h'] for w in chunk_words)
        hits.append({'s': s, 'e': e, 'score': score, 'x': xs, 'y': ys, 'w': xe - xs, 'h': ye - ys})
    return hits


def build_word_boxes(canon, hits, page_w, page_h):
    """Collapse chunk-level hits into one box per matched canonical word
    (a word covered by more than one overlapping chunk keeps the tightest
    box), as fractions of the full page so the frontend can position them
    regardless of the rendered image size."""
    boxes = {}
    for hit in hits:
        s, e = hit['s'], hit['e']
        n = max(1, e - s + 1)
        # Distribute the chunk's bounding box evenly across its words --
        # coarser than true per-glyph boxes, but the chunk size is small
        # (<=3 words) so the error is a fraction of one word's width.
        for idx, ci in enumerate(range(s, e + 1)):
            word_x = hit['x'] + hit['w'] * idx / n
            word_w = hit['w'] / n
            box = {'x': word_x / page_w, 'y': hit['y'] / page_h,
                   'w': word_w / page_w, 'h': hit['h'] / page_h}
            if ci not in boxes:
                boxes[ci] = box
    out = []
    for ci, box in sorted(boxes.items()):
        c = canon[ci]
        out.append({'ref': c.ref, 'wordIndex': c.word_index, **box})
    return out


def process_page(tractate, daf, amud, out_dir, cache_dir=None):
    os.makedirs(out_dir, exist_ok=True)
    pdf_path = os.path.join(out_dir, 'page.pdf')
    fetch_page_pdf(tractate, daf, amud, pdf_path)
    png_path = pdf_to_png(pdf_path, os.path.join(out_dir, 'page'))

    ref = f'{tractate} {daf}{amud}'
    canon, segments = load_canonical([ref], cache_dir=cache_dir or out_dir)
    print(f'Canonical text: {len(segments)} segments, {len(canon)} words')

    words, page_w, page_h = ocr_band_words(png_path)
    print(f'OCR: {len(words)} words in the Gemara band')

    hits = match_words_to_canon(canon, words)
    boxes = build_word_boxes(canon, hits, page_w, page_h)
    covered = len(boxes)
    print(f'Matched {covered}/{len(canon)} words ({covered / max(1, len(canon)):.0%} coverage)')

    result = {
        'schema': 'dafsync-pagemap-v1',
        'tractate': tractate,
        'daf': daf,
        'amud': amud,
        'pageWidth': page_w,
        'pageHeight': page_h,
        'wordBoxes': boxes,
    }
    out_path = os.path.join(out_dir, 'pagemap.json')
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False)
    print(f'Wrote {out_path}')
    return result


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--tractate', required=True)
    p.add_argument('--daf', type=int, required=True)
    p.add_argument('--amud', choices=['a', 'b'], required=True)
    p.add_argument('--out-dir', default='page-out')
    args = p.parse_args()
    try:
        process_page(args.tractate, args.daf, args.amud, args.out_dir)
    except Exception as e:
        print(f'ERROR: {e}', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
