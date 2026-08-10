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

// Tesseract occasionally hallucinates a stray niqqud/cantillation mark onto
// otherwise-correct Hebrew text (confirmed directly on a real photo: a
// clean "קא" came out "קאָ" -- a phantom kamatz, U+05B8, that isn't on the
// printed page at all, Vilna Shas headers are unvocalized). Neither this
// project's Hebrew vocabulary strings (MASECHTA_HEBREW, toGematria's
// output) nor a real header ever intentionally contains one, so stripping
// the whole Unicode niqqud/cantillation block before comparing only ever
// removes OCR noise, never real signal.
function stripNiqqud(s) {
  return s.replace(/[\u0591-\u05C7]/g, '');
}

// The printed daf number is always followed by a period (e.g. "קא.") --
// confirmed directly, across every real and synthetic OCR sample collected
// while building this, tesseract consistently preserves that as a trailing
// "." or "," (comma misreads of a period are common) on the token it reads
// as the daf number specifically, while unrelated noise tokens (stray
// margin-annotation fragments, misread punctuation elsewhere in the crop)
// essentially never carry one. Restricting the gematria comparison to
// punctuated tokens when any exist is a cheap, targeted way to stop random
// short noise fragments from ever outscoring the real (if imperfectly
// OCR'd) daf-number token -- confirmed directly: this alone fixed a real
// photo where a stray fragment ("רה", no punctuation) was fuzzy-matching a
// different daf's gematria closely enough to trip the minMargin check
// against the correct match.
function gematriaCandidates(tokens) {
  const punctuated = tokens.filter((t) => /[.,]$/.test(t));
  return punctuated.length ? punctuated : tokens;
}

function scoreEntry(tokens, gematriaTokens, entry) {
  const hebrewScore = Math.max(...tokens.map((t) => ratio(t, entry.hebrew)));
  const gematriaScore = Math.max(...gematriaTokens.map((t) => ratio(t, entry.gematria)));
  return { entry, score: (hebrewScore + gematriaScore) / 2, hebrewScore, gematriaScore };
}

/**
 * Matches OCR'd header text against the vocabulary. The physical header
 * has two pieces of text (Masechta name, daf gematria) whose left-to-right
 * scan order in the OCR output isn't something to rely on -- it depends on
 * the specific page's margin layout, which side amud a/b puts each piece
 * on, and how tesseract happens to walk the region -- so this matches each
 * vocabulary entry's two pieces against whichever OCR'd token fits best,
 * independent of order, rather than assuming a fixed order.
 *
 * minMargin guards against a specific, confirmed failure mode: many
 * gematria values are literal prefixes of each other (100's "ק" is the
 * first letter of 101's "קא", 110's "קי" of 111's "קיא", etc.), so an OCR
 * misread that drops just the LAST letter of the real value doesn't
 * produce noise -- it produces an exact, confident-looking match for a
 * different, real, available daf. Reproduced directly: OCR of a real photo
 * losing "קא"'s trailing א left "ק" (100) and "קא" (101) in an exact score
 * tie. minScore alone can't catch this (a tied wrong guess clears it just
 * as easily as the right one would) -- only checking that the winner
 * actually stands apart from the next different candidate can. Failing
 * closed on a near-tie is deliberate: guessing wrong here silently
 * mis-projects every word position onto the wrong page, worse than
 * returning "couldn't identify" and letting the reader retry the scan.
 */
export function matchHeader(ocrText, vocabulary, minScore = 55, minMargin = 10) {
  const tokens = ocrText.split(/\s+/).map((t) => stripNiqqud(t.trim())).filter(Boolean);
  if (!tokens.length || !vocabulary.length) return null;
  const gematriaTokens = gematriaCandidates(tokens);

  let best = null;
  for (const entry of vocabulary) {
    const scored = scoreEntry(tokens, gematriaTokens, entry);
    if (!best || scored.score > best.score) best = scored;
  }
  if (!best || best.score < minScore) return null;

  // The next-best candidate that isn't just the other amud of the same daf
  // (identical hebrew + gematria -- not a meaningfully different guess).
  let runnerUp = null;
  for (const entry of vocabulary) {
    if (entry.tractate === best.entry.tractate && entry.daf === best.entry.daf) continue;
    const scored = scoreEntry(tokens, gematriaTokens, entry);
    if (!runnerUp || scored.score > runnerUp.score) runnerUp = scored;
  }
  if (runnerUp && best.score - runnerUp.score < minMargin) return null;

  return best;
}
