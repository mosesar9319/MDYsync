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

// Vilna pages never print "a"/"b" literally anywhere on the page -- the
// header text alone (Masechta name + gematria) can only narrow a match down
// to a DAF, not which of its two amudim (they share one physical page/photo
// anyway). But the header's LAYOUT still tells them apart: amud א prints
// the daf number to the left of the tractate/perek name, amud ב to the
// right (see resolveAmud below) -- a real, confirmed convention, not
// inferred. matchHeader uses this as a second, independent signal on top of
// its own text matching above.

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

// The printed daf number is always followed by punctuation -- a period for
// amud א, a colon for amud ב (e.g. "קא." vs "קא:", the standard Vilna Shas
// convention) -- confirmed directly, across every real and synthetic OCR
// sample collected while building this, tesseract/Vision consistently
// preserve that as trailing ".", "," (a comma misread of a period is
// common), or ":" on the token read as the daf number specifically, while
// unrelated noise tokens (stray margin-annotation fragments, misread
// punctuation elsewhere in the crop) essentially never carry one.
// Restricting the gematria comparison to punctuated tokens when any exist
// is a cheap, targeted way to stop random short noise fragments from ever
// outscoring the real (if imperfectly OCR'd) daf-number token -- confirmed
// directly: this alone fixed a real photo where a stray fragment ("רה", no
// punctuation) was fuzzy-matching a different daf's gematria closely enough
// to trip the minMargin check against the correct match.
//
// The colon case was missing until a real amud-ב photo (Chullin 120b)
// reproduced it live: the daf-number token OCR'd as "קכ:" -- a correct,
// confident read -- but the old period/comma-only regex didn't recognize a
// colon as punctuation at all, so gematriaCandidates fell back to
// "no punctuated tokens found" and filtered the REAL daf-number token OUT
// of consideration entirely, leaving only an unrelated punctuated word
// elsewhere in the header (the credit line's "הוספות.") as the sole
// candidate -- guaranteed to never match any real daf. This wasn't a rare
// edge case: it's the standard punctuation for every amud-ב page, so it was
// failing roughly half of all real photos outright, independent of OCR
// engine or quality.
// Trailing punctuation also has to come OFF before scoring, not just be
// used to pick out the candidate tokens above -- entry.gematria (from
// toGematria) never carries it, so comparing "קכ:" against it directly
// scores the punctuation itself as one more character needing an edit.
// That's not just a lower score, it's actively MISLEADING: dropping the
// colon (1 edit, -> "קכ", the correct daf 120) costs Levenshtein exactly
// the same as SUBSTITUTING it for a real extra letter (1 edit, -> "קכא"
// daf 121, or "קכב" daf 122, both real available dapim) -- so a fully,
// correctly OCR'd short gematria that happens to be a literal prefix of
// longer ones ties all of them at an identical score, and minMargin
// (rightly) refuses to guess among an exact tie. Reproduced live on the
// same Chullin 120b photo the colon fix above addresses: 120/121/122 all
// scored 83.33 before this, a dead tie the punctuation-recognition fix
// alone couldn't break. Stripping it first fixes the comparison at its
// source instead of trying to out-tune minMargin around it.
// A token that is NOTHING BUT punctuation is not a daf-number candidate --
// and, worse, it used to disqualify every real one. The filter below asks
// "does any token end in .,:?", and a bare ":" answers yes, so a crop where
// the OCR engine split the colon off into its own token ("פט" + ":" rather
// than one "פט:") produced a candidate set containing only the colon, which
// strips to the empty string and can never match any daf. Exactly the
// failure the colon-recognition fix above was meant to end, arriving through
// a different door: the real daf-number token is filtered out and the match
// fails outright. Reproduced against the live endpoint on an amud-ב header
// -- identical crops differing only in the daf number's trailing character
// matched at score 83 with "פט." and returned no match at all with "פט:",
// at 480px, 800px and 1200px wide alike.
//
// Dropping these before the "did we find any?" decision is strictly safer
// than the old behaviour in both directions: a punctuation-only token can
// never BE the answer, so it should never be the sole candidate, and when
// the colon does stay attached (the common case in real photos) nothing
// about the existing path changes.
const PUNCTUATION_ONLY = /^[.,:׃'"־-]+$/;

function gematriaCandidates(tokens) {
  const usable = tokens.filter((t) => !PUNCTUATION_ONLY.test(t.text));
  const pool = usable.length ? usable : tokens;
  const punctuated = pool.filter((t) => /[.,:]$/.test(t.text));
  const source = punctuated.length ? punctuated : pool;
  return source.map((t) => ({ ...t, text: t.text.replace(/[.,:]$/, '') }));
}

// Returns which TOKEN scored best against target, not just the score itself
// -- resolveAmud below needs the winning token's own position, not a bare
// number, to compare where the gematria and hebrew matches physically sit
// in the header crop.
function bestMatch(tokens, target) {
  let best = null;
  for (const token of tokens) {
    const score = ratio(token.text, target);
    if (!best || score > best.score) best = { token, score };
  }
  return best || { token: null, score: 0 };
}

function scoreEntry(tokens, gematriaTokens, entry) {
  const hebrewBest = bestMatch(tokens, entry.hebrew);
  const gematriaBest = bestMatch(gematriaTokens, entry.gematria);
  return {
    entry,
    score: (hebrewBest.score + gematriaBest.score) / 2,
    hebrewScore: hebrewBest.score,
    gematriaScore: gematriaBest.score,
    hebrewToken: hebrewBest.token,
    gematriaToken: gematriaBest.token,
  };
}

// A Vilna Shas header prints the daf number on one side and the tractate +
// perek name together on the other -- which side is which is exactly what
// tells amud a from amud b (amud a: daf number to the LEFT of the tractate/
// perek name; amud b: to the RIGHT -- confirmed convention, not inferred).
// This is a DIFFERENT signal from matchHeader's own order-independent
// identification above (see its docstring: which piece the OCR engine
// happened to list first isn't reliable) -- resolveAmud instead compares
// where the two WINNING tokens physically sit in the crop, which the
// engine's scan order never affected in the first place. Perek name itself
// is never matched against any vocabulary (there isn't one) -- it doesn't
// need to be, since it always sits immediately next to the tractate name,
// so the tractate token's own position already stands in for that whole
// side of the header.
function resolveAmud(best) {
  const { hebrewToken, gematriaToken } = best;
  if (!hebrewToken || !gematriaToken) return null;
  if (typeof hebrewToken.x !== 'number' || typeof gematriaToken.x !== 'number') return null;
  // Same OCR token winning both comparisons means there's no real position
  // signal (e.g. only one legible token in the whole crop) -- fail closed
  // rather than report a coin-flip amud with false confidence.
  if (hebrewToken.index === gematriaToken.index) return null;
  return gematriaToken.x < hebrewToken.x ? 'a' : 'b';
}

/**
 * Matches OCR'd header tokens against the vocabulary. `ocrTokens` is an
 * array of {text, x} -- x is each word's horizontal center in the header
 * crop's own pixel space, used only for resolveAmud below; every other
 * comparison here is still purely textual. The physical header has two
 * pieces of text (Masechta name, daf gematria) whose left-to-right scan
 * ORDER in the OCR output isn't something to rely on -- it depends on the
 * specific page's margin layout, which side amud a/b puts each piece on,
 * and how the OCR engine happens to walk the region -- so this matches each
 * vocabulary entry's two pieces against whichever OCR'd token fits best,
 * independent of scan order, rather than assuming a fixed one. (Their
 * physical POSITION, as opposed to scan order, is a separate and reliable
 * signal -- see resolveAmud.)
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
export function matchHeader(ocrTokens, vocabulary, minScore = 55, minMargin = 10) {
  const tokens = ocrTokens
    // y/width/height pass through unchanged (not used by any comparison in
    // this file) purely so a caller that wants to draw a highlight box over
    // the winning hebrewToken/gematriaToken below -- see this function's own
    // return -- has real geometry to draw, not just an x coordinate.
    .map((t, index) => ({
      index, x: t.x, y: t.y, width: t.width, height: t.height,
      text: stripNiqqud(String(t.text || '').trim()),
    }))
    .filter((t) => t.text);
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

  return {
    entry: best.entry,
    score: best.score,
    amud: resolveAmud(best),
    // The two OCR tokens that actually won each half of the match -- null
    // when there was no legible token to win at all (score 0 against every
    // candidate). Exists so a caller can highlight exactly the words it
    // recognized rather than the whole header crop -- see
    // scan-daf-header.mjs's matchedWords, the only current consumer.
    hebrewToken: best.hebrewToken,
    gematriaToken: best.gematriaToken,
    // The per-half scores `score` above is the average of -- NOT redundant
    // with it. `score` alone can clear minScore/minMargin even when only
    // ONE half (almost always the short, easily-confused gematria digit)
    // was actually legible and the other scored low-but-similarly-low
    // across every candidate (so it never got the chance to disqualify a
    // wrong entry via minMargin either). scan-daf-header.mjs's own live
    // scanner uses these to additionally require BOTH halves clear their
    // own floor before ever treating a result as confident enough to
    // navigate on -- a daf number alone is ambiguous across every tractate
    // that happens to be on the same daf, which a bare `score` threshold
    // can't detect. scan-daf-page.mjs does not apply any such check itself
    // (unchanged behavior -- a reader-driven single-shot scan always leaves
    // the align screen up for confirmation either way, so this exact
    // failure mode there is lower-stakes than an unattended auto-navigate).
    hebrewScore: best.hebrewScore,
    gematriaScore: best.gematriaScore,
  };
}
