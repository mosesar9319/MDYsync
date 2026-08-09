import { ratio } from './fuzzy-match.mjs';

// A Vilna-Shas page header prints from a small, fixed vocabulary -- the
// Masechta's Hebrew name and the daf number in Hebrew numerals (gematria).
// scan-daf-page.mjs OCRs just that small header region of a camera photo
// and fuzzy-matches the result against this closed vocabulary, rather than
// against saved reference *images* of headers (which would be sensitive to
// each publisher's own header artwork/font -- see the module's own
// docstring-style comment for why this approach was chosen over that).
//
// Hebrew names match how each tractate is actually printed on a Vilna Shas
// page header, not necessarily Sefaria's own transliterated ref slug (see
// MASECHTA_SLUGS in trigger-page-ocr-job.mjs/daf-page.mjs, which this keys
// share -- both English keys must stay in sync across all three files).
export const MASECHTA_HEBREW = {
  'Berakhot': 'ברכות', 'Shabbat': 'שבת', 'Eruvin': 'עירובין', 'Pesachim': 'פסחים',
  'Yoma': 'יומא', 'Sukkah': 'סוכה', 'Beitzah': 'ביצה', 'Rosh Hashanah': 'ראש השנה',
  'Taanit': 'תענית', 'Megillah': 'מגילה', 'Moed Katan': 'מועד קטן', 'Chagigah': 'חגיגה',
  'Yevamot': 'יבמות', 'Ketubot': 'כתובות', 'Nedarim': 'נדרים', 'Nazir': 'נזיר',
  'Sotah': 'סוטה', 'Gittin': 'גיטין', 'Kiddushin': 'קידושין', 'Bava Kamma': 'בבא קמא',
  'Bava Metzia': 'בבא מציעא', 'Bava Batra': 'בבא בתרא', 'Sanhedrin': 'סנהדרין',
  'Makkot': 'מכות', 'Shevuot': 'שבועות', 'Avodah Zarah': 'עבודה זרה', 'Horayot': 'הוריות',
  'Zevachim': 'זבחים', 'Menachot': 'מנחות', 'Chullin': 'חולין', 'Bekhorot': 'בכורות',
  'Arakhin': 'ערכין', 'Temurah': 'תמורה', 'Keritot': 'כריתות', 'Meilah': 'מעילה',
  'Niddah': 'נדה',
};

const ONES = ['', 'א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט'];
const TENS = ['', 'י', 'כ', 'ל', 'מ', 'נ', 'ס', 'ע', 'פ', 'צ'];
const HUNDREDS = ['', 'ק', 'ר', 'ש', 'ת'];

// 15 and 16 are traditionally written טו/טז instead of the literal יה/יו,
// since those spell out one of God's names -- every printed daf header
// follows this convention, so a literal-gematria conversion would never
// match a real page.
const SPECIAL_TEENS = { 15: 'טו', 16: 'טז' };

/** Converts a daf number (2-400ish) to its printed Hebrew-numeral form. */
export function toGematria(n) {
  if (!Number.isInteger(n) || n < 1) return '';
  if (SPECIAL_TEENS[n]) return SPECIAL_TEENS[n];
  const hundreds = Math.floor(n / 100);
  const tens = Math.floor((n % 100) / 10);
  const ones = n % 10;
  return HUNDREDS[hundreds] + TENS[tens] + ONES[ones];
}

/**
 * The full matchable vocabulary: every available (tractate, daf) pair's
 * Hebrew name and gematria daf-number as flat strings, ready for
 * fuzzy-matching an OCR'd header crop against.
 *
 * Deliberately NOT built from a hardcoded per-tractate daf-count table --
 * exactly how many dapim each tractate spans (Vilna pagination starts at 2,
 * not 1, and every tractate ends at a different, not-entirely-uniformly-
 * documented number) is exactly the kind of fact worth getting from an
 * authoritative source rather than a number typed into this file from
 * memory. There's also a more correct source available anyway: the scan
 * feature can only usefully recognize a daf it already has precomputed word
 * boxes for (see results/pages/*.json, built by build-page-cache.yml), so
 * the vocabulary is exactly "the dapim we've actually pre-generated data
 * for" -- pass in that discovered list (e.g. from listing the results
 * branch's pages/ directory) as `availableDapim`, an array of
 * {tractate, daf} pairs.
 */
export function buildHeaderVocabulary(availableDapim) {
  return availableDapim
    .filter((d) => MASECHTA_HEBREW[d.tractate])
    .map((d) => ({
      tractate: d.tractate,
      daf: d.daf,
      hebrew: MASECHTA_HEBREW[d.tractate],
      gematria: toGematria(d.daf),
    }));
}

// Amud isn't determined by the header at all -- Vilna pages don't print
// "a"/"b" anywhere on the page itself, only the daf number, so the header
// can only narrow a match down to a daf (both amudim share one physical
// page/photo anyway). Whichever amud is actually being read has to come
// from elsewhere (the reader picking it, or defaulting to 'a').

/**
 * Matches OCR'd header text against the vocabulary. The physical header
 * has two pieces of text (Masechta name, daf gematria) whose left-to-right
 * scan order in the OCR output isn't something to rely on -- it depends on
 * the specific page's margin layout, which side amud a/b puts each piece
 * on, and how tesseract happens to walk the region -- so this matches each
 * vocabulary entry's two pieces against whichever OCR'd token fits best,
 * independent of order, rather than assuming a fixed order.
 */
export function matchHeader(ocrText, vocabulary, minScore = 55) {
  const tokens = ocrText.split(/\s+/).map((t) => t.trim()).filter(Boolean);
  if (!tokens.length || !vocabulary.length) return null;

  let best = null;
  for (const entry of vocabulary) {
    const hebrewScore = Math.max(...tokens.map((t) => ratio(t, entry.hebrew)));
    const gematriaScore = Math.max(...tokens.map((t) => ratio(t, entry.gematria)));
    const score = (hebrewScore + gematriaScore) / 2;
    if (!best || score > best.score) best = { entry, score, hebrewScore, gematriaScore };
  }
  if (!best || best.score < minScore) return null;
  return best;
}
