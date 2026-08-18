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
  - The dominant bug, found after the above two were already fixed and
    the highlight was *still* landing away from the intended word on
    nearly every page: shas.org's PDF is a print sheet with bleed margin
    (MediaBox 842x1191pt) around the actual visible page (CropBox
    643.575x992.575pt) -- confirmed byte-identical across every sampled
    tractate/daf, a fixed property of the template. `pdftoppm` (below)
    rasterizes the MediaBox by default; the browser's pdf.js renders only
    the CropBox. Word positions were being stored as fractions of the
    MediaBox render, then applied as percentages of the browser's smaller
    CropBox-sized canvas -- both renders share the same top-left origin,
    so this doesn't shift anything, but it uniformly compresses every
    box toward the top-left corner, worse the further right/down a word
    actually is. See CROPBOX_WIDTH_FRAC/CROPBOX_HEIGHT_FRAC below.

Example:
    python3 page_ocr_align.py --tractate Chullin --daf 86 --amud a \
        --out-dir out/
"""

import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.request

import cv2
import pytesseract
from google.auth.transport.requests import Request as GoogleAuthRequest
from google.oauth2 import service_account
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

# shas.org's Daf PDF template renders a print sheet with bleed margin (the
# MediaBox, 842x1191pt) around the actual visible page (the CropBox,
# 643.575x992.575pt) -- confirmed byte-identical across every sampled
# tractate/daf, so this is a fixed property of the template, not something
# that varies per page. `pdftoppm` (used below, with no -cropbox flag)
# rasterizes the full MediaBox, which is what BAND_X0_FRAC/BAND_X1_FRAC
# above are calibrated against and OCR reads fine. But the browser's pdf.js
# renders only the CropBox -- a real single-viewport render was measured at
# 639x985px for a page whose MediaBox render was 1755x2482px, and
# 985/639=1.542 matches the CropBox's own aspect ratio (992.575/643.575=
# 1.542), not the MediaBox's (1191/842=1.414).
#
# Every word position below was being stored as a fraction of the full
# MediaBox-rendered image, then applied as a percentage of the browser's
# smaller CropBox-sized canvas. Since both renders share the same top-left
# origin (confirmed: identical content at the same absolute pixel offset in
# both), this doesn't shift anything -- it uniformly *compresses* every
# fraction toward the top-left, worse for words further right/down the
# page. That's a systematic error on every single word on every page, not
# an occasional one -- unlike the rare cross-column contamination this
# pipeline was already known to have, this is the dominant reason the
# Vilna page highlight was landing away from the intended word so often.
CROPBOX_WIDTH_FRAC = 643.575 / 842.0
CROPBOX_HEIGHT_FRAC = 992.575 / 1191.0


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


def get_google_vision_access_token(credentials_json):
    """Exchanges a service-account JSON key for a short-lived OAuth2 access
    token, for orgs whose policy disallows plain API keys ("API Keys are
    Disallowed ... use Application Default Credentials (ADC) instead" --
    ADC's own recommended alternative). A service account is the ADC path
    every non-interactive script actually uses, so this is not a workaround
    for that policy, it's the thing the policy is steering callers toward.
    """
    info = json.loads(credentials_json)
    creds = service_account.Credentials.from_service_account_info(
        info, scopes=['https://www.googleapis.com/auth/cloud-platform']
    )
    creds.refresh(GoogleAuthRequest())
    return creds.token


def ocr_band_words_google_vision(page_png, api_key=None, credentials_json=None):
    """Same job as ocr_band_words above (a list of candidate words with real
    pixel positions), but reading the whole page through Google Cloud
    Vision's DOCUMENT_TEXT_DETECTION instead of a Tesseract pass restricted
    to the fixed BAND_X0_FRAC/BAND_X1_FRAC crop.

    Accepts either a plain API key (simplest, but blocked outright on some
    orgs' Cloud projects) or a service-account credentials JSON (works
    under that same policy, since it IS the ADC path); exactly one of the
    two is expected to be set by the caller.

    Deliberately does NOT restrict itself to that band, or to any other
    fixed region: real pages don't hold Gemara to one constant column width
    (see the accuracy report this replaced -- some pages run narrow while
    flanked by Rashi/Tosefet-Rashi, then widen once that commentary runs
    out for the rest of the page), so any fixed spatial crop reintroduces
    exactly the bug that motivated moving off Tesseract in the first place.
    Every word Vision finds on the page -- Gemara, Rashi, Tosefet Rashi, the
    marginal reference columns, all of it -- gets passed to
    align_words_to_canon unfiltered; that function's global alignment
    against the *known* canonical Gemara word list is what separates real
    Gemara words from everything else, the same way it already absorbs
    stray OCR misreads today. Confirmed directly (a hand-transcribed real
    page, checked word-for-word against Sefaria): Vision-class OCR reads
    this typeface at ~95%+ accuracy with zero genuine misreads in the
    sample -- every discrepancy was either a printed abbreviation (see
    align_words_to_canon's own fuzzy-match tolerance) or content the sample
    simply didn't cover, not a wrong letter.
    """
    if not api_key and not credentials_json:
        raise RuntimeError('ocr_band_words_google_vision needs either api_key or credentials_json.')

    with open(page_png, 'rb') as f:
        image_bytes = f.read()
    payload = {
        'requests': [{
            'image': {'content': base64.b64encode(image_bytes).decode('ascii')},
            'features': [{'type': 'DOCUMENT_TEXT_DETECTION'}],
            'imageContext': {'languageHints': ['he']},
        }],
    }
    headers = {'Content-Type': 'application/json'}
    if credentials_json:
        url = 'https://vision.googleapis.com/v1/images:annotate'
        headers['Authorization'] = f'Bearer {get_google_vision_access_token(credentials_json)}'
    else:
        url = f'https://vision.googleapis.com/v1/images:annotate?key={api_key}'
    req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'), headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            data = json.loads(r.read())
    except urllib.error.HTTPError as e:
        detail = e.read().decode('utf-8', errors='replace')
        raise RuntimeError(f'Google Vision request failed ({e.code}): {detail}') from e

    resp = data['responses'][0]
    if 'error' in resp:
        raise RuntimeError(f"Google Vision error: {resp['error'].get('message')}")

    img = cv2.imread(page_png)
    h, w = img.shape[:2]

    full = resp.get('fullTextAnnotation')
    if not full:
        return [], w, h  # a blank/unreadable page is a real (if rare) outcome, not an error

    words = []
    for page in full['pages']:
        for block in page['blocks']:
            for para in block['paragraphs']:
                for word in para['words']:
                    text = ''.join(s['text'] for s in word['symbols'])
                    n = normalize_word(text)
                    if not n:
                        continue
                    verts = word['boundingBox']['vertices']
                    xs = [v.get('x', 0) for v in verts]
                    ys = [v.get('y', 0) for v in verts]
                    x0, x1 = min(xs), max(xs)
                    y0, y1 = min(ys), max(ys)
                    words.append({
                        'text': text,
                        'norm': n,
                        'x': x0,
                        'y': y0,
                        'w': x1 - x0,
                        'h': y1 - y0,
                    })
    return words, w, h


def load_abbreviations():
    """Loads the Talmudic-abbreviation dictionary: the curated starter list
    shipped at shared/abbreviations.json, plus anything the manual trace
    tool (studio/trace.html) has since discovered and saved to
    abbreviation-additions.json on the results branch -- so a page traced
    by hand improves every future automated sync too, not just itself.
    Never lets a missing/unreachable dictionary block a sync: an OCR run
    with no abbreviation handling is strictly better than no OCR run.
    """
    entries = []
    starter_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'shared', 'abbreviations.json')
    try:
        with open(starter_path, encoding='utf-8') as f:
            entries.extend(json.load(f).get('entries', []))
    except (OSError, json.JSONDecodeError):
        pass
    try:
        url = 'https://raw.githubusercontent.com/mosesar9319/MDYsync/results/abbreviation-additions.json'
        with urllib.request.urlopen(url, timeout=15) as r:
            additions = json.loads(r.read())
        if isinstance(additions, list):
            entries.extend(additions)
    except Exception:
        pass  # no additions yet (a 404) is the normal, expected case
    return {'entries': entries}


def recover_abbreviations(canon, words, pairs, dictionary):
    """Second pass, run AFTER plain 1:1 alignment: for any run of canonical
    words a known phrase (תנו רבנן -> ת"ר) could explain that came out of
    that alignment completely unmatched, checks for a nearby unmatched OCR
    word reading as the abbreviation's own printed form and, if found,
    credits all of the phrase's canonical words to it.

    Deliberately a second pass over what plain alignment already settled,
    not a preprocessing step that forces every textual occurrence of a
    phrase to only match its abbreviated form -- confirmed directly on a
    real page that printers don't abbreviate a phrase every time it
    appears (of 5 real occurrences of two phrases on one page, only 1 was
    actually set abbreviated; an earlier version of this that forced all 5
    to only accept the short form broke the other 4, which were spelled
    out in full and would otherwise have matched fine on their own -- net
    coverage went DOWN, not up). Only ever adds matches on top of what
    plain alignment already found, so unlike that version this can't make
    coverage worse.

    "Nearby" means bounded by the OCR-index of the nearest already-matched
    canonical word on each side of the gap -- alignment pairs are
    monotonic in both sequences, so the OCR word standing in for an
    unmatched run of canonical words, if it exists at all, has to sit
    somewhere between those two neighbors.
    """
    entries = sorted(
        (
            ([normalize_word(w) for w in e['phrase']], normalize_word(e.get('abbr') or ''))
            for e in dictionary.get('entries', [])
        ),
        key=lambda e: -len(e[0]),
    )
    entries = [(phrase, abbr) for phrase, abbr in entries if abbr and len(phrase) >= 2]
    if not entries:
        return []

    matched_canon = {canon_i for _, canon_i, _ in pairs}
    matched_ocr = {ocr_i for ocr_i, _, _ in pairs}
    by_canon = sorted(pairs, key=lambda p: p[1])

    def ocr_bracket(i0, i1):
        prev_ocr, next_ocr = -1, len(words)
        for ocr_i, canon_i, _ in by_canon:
            if canon_i < i0 and ocr_i > prev_ocr:
                prev_ocr = ocr_i
            if canon_i >= i1:
                next_ocr = ocr_i
                break
        return prev_ocr, next_ocr

    extra = []
    i = 0
    while i < len(canon):
        found = False
        for phrase_norms, abbr_norm in entries:
            n = len(phrase_norms)
            span = range(i, i + n)
            if i + n > len(canon) or any(j in matched_canon for j in span):
                continue
            if [c.norm for c in canon[i:i + n]] != phrase_norms:
                continue
            prev_ocr, next_ocr = ocr_bracket(i, i + n)
            best = None
            for ocr_i in range(prev_ocr + 1, next_ocr):
                if ocr_i in matched_ocr:
                    continue
                score = fuzz.ratio(words[ocr_i]['norm'], abbr_norm)
                if score >= MATCH_THRESHOLD and (best is None or score > best[1]):
                    best = (ocr_i, score)
            if best:
                ocr_i, score = best
                matched_ocr.add(ocr_i)
                for j in span:
                    extra.append((ocr_i, j, score))
                    matched_canon.add(j)
                i += n
                found = True
                break
        if not found:
            i += 1
    return extra


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


def compute_text_block(words, page_w, page_h, crop_w, crop_h, padding_lines=0.5, left_right_px=None):
    """The Gemara column's own bounding box on THIS page, as fractions of
    the full (CropBox-equivalent) page.

    Horizontally: by default (left_right_px=None) the same fixed
    BAND_X0_FRAC/BAND_X1_FRAC crop every page uses (a property of shas.org's
    fixed PDF template, not this specific page -- but expressed as a
    fraction of the MediaBox-rendered PNG's own width, same as ocr_band_words
    uses it, so it's rescaled here to a CropBox-equivalent fraction the same
    way word positions themselves are below). That fixed band is only valid
    for the Tesseract path above, which was itself restricted to it --
    real pages don't hold Gemara to one constant width (it often widens
    once flanking commentary runs out), so the google-vision path instead
    passes left_right_px explicitly, computed from where its *aligned*
    words actually landed on this specific page.

    Vertically: always the real extent of the words actually OCR'd on this
    page (every page has a different number of lines, so this can't be a
    fixed constant the way a fixed-template horizontal band could be).

    padding_lines pads the vertical extent by a fraction of the median
    line's own height, so the box doesn't clip the first/last line's
    ascenders/descenders right at the boundary.

    This is what word positions get normalized against instead of the whole
    page (see build_word_boxes) -- the fix for a real, confirmed bug: two
    different physical printings of a Vilna-paginated page can have
    different outer margins even though the typeset content itself is
    identical, so a word position stored as a fraction of the WHOLE page
    silently assumes the reader's own physical book has the exact same
    margins as this reference PDF. Fractions of the text block itself carry
    no such assumption -- see shared/text-block-detect.mjs, the client/
    server counterpart that measures a photographed page's OWN text block
    the same way instead of trusting this reference's margins to transfer.
    """
    if not words:
        return None
    tops = sorted(w['y'] for w in words)
    bottoms = sorted(w['y'] + w['h'] for w in words)
    heights = sorted(w['h'] for w in words)
    median_h = heights[len(heights) // 2]
    pad = median_h * padding_lines
    # Clamped to crop_h, not page_h -- a stray OCR'd word in the bleed
    # margin outside the CropBox (rare, but the MediaBox render OCR runs
    # against does include that margin) would otherwise push this past 1.0
    # once divided by crop_h below, which every consumer assumes is a valid
    # 0..1 page fraction.
    top_px = max(0.0, tops[0] - pad)
    bottom_px = min(crop_h, bottoms[-1] + pad)
    if left_right_px is not None:
        left_px, right_px = left_right_px
        left_frac, right_frac = left_px / crop_w, right_px / crop_w
    else:
        left_frac, right_frac = (BAND_X0_FRAC * page_w) / crop_w, (BAND_X1_FRAC * page_w) / crop_w
    return {
        'left': left_frac,
        'top': top_px / crop_h,
        'right': right_frac,
        'bottom': bottom_px / crop_h,
    }


def build_word_boxes(canon, words, pairs, crop_w, crop_h):
    """One box per aligned canonical word, taken directly from its matched
    OCR word's real bounding box (no chunk-distribution approximation
    needed now that alignment is word-for-word). `pairs` can include
    recover_abbreviations's extra matches alongside align_words_to_canon's
    own -- both are plain (ocr_index, canon_index, score) triples over the
    same canon/words lists, so they merge here with no special handling.

    Deliberately UNCHANGED otherwise, still fractions of the whole
    (CropBox-equivalent) page, not the text block computed above -- the
    Vilna-page view (renderVilnaWordBoxes in app.js) positions these as CSS
    percentages directly against the full canonical page image, so changing
    what these fractions mean would break that consumer too. Only
    scan-daf-page.mjs needs text-block-relative positions (to project onto
    a photographed page whose margins may not match this reference's), and
    it derives them itself at request time from these page-fractions plus
    the textBlock field below -- see this function's own caller.
    """
    out = []
    for ocr_i, canon_i, score in pairs:
        w = words[ocr_i]
        c = canon[canon_i]
        out.append({
            'ref': c.ref,
            'wordIndex': c.word_index,
            'x': w['x'] / crop_w,
            'y': w['y'] / crop_h,
            'w': w['w'] / crop_w,
            'h': w['h'] / crop_h,
        })
    return out


def process_page(tractate, daf, amud, out_dir, cache_dir=None, engine=None,
                  google_vision_api_key=None, google_vision_credentials_json=None):
    os.makedirs(out_dir, exist_ok=True)
    pdf_path = os.path.join(out_dir, 'page.pdf')
    fetch_page_pdf(tractate, daf, amud, pdf_path)
    png_path = pdf_to_png(pdf_path, os.path.join(out_dir, 'page'))

    ref = f'{tractate} {daf}{amud}'
    canon, segments = load_canonical([ref], cache_dir=cache_dir or out_dir)
    print(f'Canonical text: {len(segments)} segments, {len(canon)} words')

    abbreviations = load_abbreviations()

    # Auto-picks the better engine the moment a credential is available,
    # without needing every caller updated to ask for it explicitly -- the
    # same "upgrade transparently when the ingredient shows up" shape as
    # trigger-page-ocr-job.mjs already using whichever of two variant
    # prefixes applies. Falls back to Tesseract (no credential required) so
    # this keeps working for anyone who hasn't set up Vision yet. A service
    # account takes priority when both are somehow set, since that's the
    # credential type that still works under an org policy disallowing
    # plain API keys.
    if engine is None:
        engine = 'google-vision' if (google_vision_api_key or google_vision_credentials_json) else 'tesseract'

    if engine == 'google-vision':
        if not google_vision_api_key and not google_vision_credentials_json:
            raise RuntimeError(
                'The google-vision engine needs GOOGLE_VISION_API_KEY or '
                'GOOGLE_VISION_CREDENTIALS_JSON.'
            )
        words, page_w, page_h = ocr_band_words_google_vision(
            png_path, api_key=google_vision_api_key, credentials_json=google_vision_credentials_json
        )
        print(f'Google Vision: {len(words)} words detected on the whole page')
    else:
        words, page_w, page_h = ocr_band_words(png_path)
        print(f'Tesseract: {len(words)} words in the fixed Gemara band')

    # page_w/page_h are the full MediaBox-rendered PNG's own dimensions --
    # OCR extraction is calibrated against those and works fine, but word
    # positions must be stored relative to the CropBox-equivalent size,
    # which is what the browser's canvas actually represents (see
    # CROPBOX_WIDTH_FRAC/CROPBOX_HEIGHT_FRAC above).
    crop_w = page_w * CROPBOX_WIDTH_FRAC
    crop_h = page_h * CROPBOX_HEIGHT_FRAC

    pairs = align_words_to_canon(canon, words)
    recovered = recover_abbreviations(canon, words, pairs, abbreviations)
    if recovered:
        occurrences = len({ocr_i for ocr_i, _, _ in recovered})
        print(f'Abbreviations: recovered {len(recovered)} canonical words via '
              f'{occurrences} printed abbreviation{"s" if occurrences != 1 else ""}')
        pairs = pairs + recovered
    boxes = build_word_boxes(canon, words, pairs, crop_w, crop_h)
    covered = len(boxes)
    print(f'Aligned {covered}/{len(canon)} words ({covered / max(1, len(canon)):.0%} coverage)')

    # TEMPORARY diagnostic (remove once the abbreviation-gap investigation
    # is done): show exactly which canonical words are still unmatched,
    # with surrounding context, so gaps can be attributed to a real cause
    # (missing abbreviation entry, genuine OCR miss, etc) instead of
    # guessed at from the coverage percentage alone.
    matched_canon_i = {canon_i for _, canon_i, _ in pairs}
    gap_runs = []
    run = []
    for i in range(len(canon)):
        if i not in matched_canon_i:
            run.append(i)
        elif run:
            gap_runs.append(run)
            run = []
    if run:
        gap_runs.append(run)
    print(f'Unmatched: {len(canon) - covered} words in {len(gap_runs)} gap run(s)')
    for run in gap_runs:
        lo, hi = run[0], run[-1]
        ctx_lo, ctx_hi = max(0, lo - 3), min(len(canon), hi + 4)
        ctx = ' '.join(canon[k].text if k in run else f'[{canon[k].text}]' for k in range(ctx_lo, ctx_hi))
        print(f'  gap @ {lo}-{hi}: ...{ctx}...')

    if engine == 'google-vision':
        # Vision read the WHOLE page (every column), not a pre-cropped
        # band, so the text block -- unlike Tesseract's fixed-band one --
        # has to be measured from just the words that actually aligned to
        # real Gemara text, not every word Vision found (which would span
        # the full page width/height across every commentary column too).
        matched = [words[ocr_i] for ocr_i, _, _ in pairs] or words
        left_right_px = (min(w['x'] for w in matched), max(w['x'] + w['w'] for w in matched))
        text_block = compute_text_block(matched, page_w, page_h, crop_w, crop_h, left_right_px=left_right_px)
    else:
        text_block = compute_text_block(words, page_w, page_h, crop_w, crop_h)

    result = {
        # v2: adds textBlock (see compute_text_block) -- wordBoxes/pageWidth/
        # pageHeight are unchanged from v1, so anything only reading those
        # still works against a v2 file without modification; only
        # scan-daf-page.mjs actually needs the new field.
        'schema': 'dafsync-pagemap-v2',
        'tractate': tractate,
        'daf': daf,
        'amud': amud,
        'engine': engine,
        'pageWidth': crop_w,
        'pageHeight': crop_h,
        'textBlock': text_block,
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
    p.add_argument('--engine', choices=['tesseract', 'google-vision'], default=None,
                    help='Defaults to google-vision when GOOGLE_VISION_API_KEY or '
                         'GOOGLE_VISION_CREDENTIALS_JSON is set, else tesseract.')
    args = p.parse_args()
    try:
        process_page(
            args.tractate, args.daf, args.amud, args.out_dir,
            engine=args.engine,
            google_vision_api_key=os.environ.get('GOOGLE_VISION_API_KEY'),
            google_vision_credentials_json=os.environ.get('GOOGLE_VISION_CREDENTIALS_JSON'),
        )
    except Exception as e:
        print(f'ERROR: {e}', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
