#!/usr/bin/env python3
"""Word-position OCR for a single Vilna-style daf page image.

Fetches a page from shas.org's Daf PDF API, OCRs the Gemara column (the
band between the outer marginalia and the Rashi/Tosafot columns -- see the
module docstring notes below for how that band was found), and aligns the
recognized words against the canonical Sefaria text with a global sequence
alignment (Needleman-Wunsch), the same word indices the video caption
engine (caption_ocr_align.py) uses for its wordTimeline -- so a video's
synced timestamps land on the same canonical words here.

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
  - Word matching went through two iterations. A greedy, cursor-based
    fuzzy match (walk the OCR'd words, track a position in the canonical
    text, search near it) reached ~35-60% coverage but was prone to
    compounding errors: one chunk matching the wrong spot (easy with
    recurring phrases like "amar leih") dragged every later chunk's
    search window along with it. Replacing it with a global sequence
    alignment (align_words_to_canon below) between the whole OCR'd word
    list and the whole canonical word list at once raised coverage to
    ~86-93% on the same pages, since a global alignment can't drift the
    way a greedy walk can -- validated with drawn word-box overlays, not
    just the coverage number, before replacing the old approach.

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
from rapidfuzz import fuzz

from caption_ocr_align import normalize_word, load_canonical

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
MATCH_THRESHOLD = 60
GAP_PENALTY = -2


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


def align_words_to_canon(canon, words):
    """Globally align the OCR'd word sequence against the canonical word
    sequence (Needleman-Wunsch), instead of greedily fuzzy-matching small
    windows with a moving cursor.

    The greedy/windowed approach used earlier tracked a "cursor" position
    and searched near it for each small chunk of OCR'd words -- but one
    chunk matching the wrong spot (easy with recurring Talmudic phrases
    like "amar leih" or "ta shema") would drag the cursor along, causing
    every later chunk to search near the wrong position too, compounding
    the error. A global alignment considers the whole OCR sequence and
    the whole canonical sequence jointly and finds the best-scoring
    correspondence between them as a whole, which structurally can't drift
    the way a greedy walk can (validated: this raised match coverage from
    ~35-60% to ~86-93% on the same sample pages, with visibly correct word
    positions, not just a higher score).

    Returns a list of (ocr_index, canon_index, score) triples for aligned
    pairs scoring at or above MATCH_THRESHOLD.
    """
    a = [w['norm'] for w in words]
    b = [c.norm for c in canon]
    n, m = len(a), len(b)

    dp = [[0.0] * (m + 1) for _ in range(n + 1)]
    ptr = [[None] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        dp[i][0] = dp[i - 1][0] + GAP_PENALTY
        ptr[i][0] = 'U'
    for j in range(1, m + 1):
        dp[0][j] = dp[0][j - 1] + GAP_PENALTY
        ptr[0][j] = 'L'

    for i in range(1, n + 1):
        row = dp[i]
        prev_row = dp[i - 1]
        ptr_row = ptr[i]
        ai = a[i - 1]
        for j in range(1, m + 1):
            # Substitution score: scaled so a perfect match clearly beats
            # taking two gaps instead (2 * GAP_PENALTY), and a poor match
            # is worse than gapping both words out.
            sub = fuzz.ratio(ai, b[j - 1]) / 100.0 * 4 - 1
            diag = prev_row[j - 1] + sub
            up = prev_row[j] + GAP_PENALTY      # OCR word unmatched (noise/misread)
            left = row[j - 1] + GAP_PENALTY      # canonical word unmatched (OCR missed it)
            if diag >= up and diag >= left:
                row[j] = diag
                ptr_row[j] = 'D'
            elif up >= left:
                row[j] = up
                ptr_row[j] = 'U'
            else:
                row[j] = left
                ptr_row[j] = 'L'

    i, j = n, m
    pairs = []
    while i > 0 and j > 0:
        d = ptr[i][j]
        if d == 'D':
            score = fuzz.ratio(a[i - 1], b[j - 1])
            if score >= MATCH_THRESHOLD:
                pairs.append((i - 1, j - 1, score))
            i -= 1
            j -= 1
        elif d == 'U':
            i -= 1
        else:
            j -= 1
    pairs.reverse()
    return pairs


def build_word_boxes(canon, words, pairs, page_w, page_h):
    """One box per aligned canonical word, taken directly from its
    matched OCR word's real bounding box (no chunk-distribution
    approximation needed now that alignment is word-for-word)."""
    out = []
    for ocr_i, canon_i, score in pairs:
        w = words[ocr_i]
        c = canon[canon_i]
        out.append({
            'ref': c.ref,
            'wordIndex': c.word_index,
            'x': w['x'] / page_w,
            'y': w['y'] / page_h,
            'w': w['w'] / page_w,
            'h': w['h'] / page_h,
        })
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

    pairs = align_words_to_canon(canon, words)
    boxes = build_word_boxes(canon, words, pairs, page_w, page_h)
    covered = len(boxes)
    print(f'Aligned {covered}/{len(canon)} words ({covered / max(1, len(canon)):.0%} coverage)')

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
