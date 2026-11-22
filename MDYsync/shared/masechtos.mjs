// Every masechta of the Bavli: its Sefaria name (what refs, the catalog and
// talmud_index.json use), its address on dafsync.com ("bechoros", the
// Ashkenazi spelling most Daf Yomi shiurim say it in -- also what shas.org's
// daf PDFs are filed under), its Hebrew name and its first and last daf.
// Dependency-free: imported by Netlify functions, tools and the tests.

export const MASECHTOS = [
  { name: "Berakhot", slug: "berachos", hebrew: "ברכות", startDaf: 2, endDaf: 64, endSide: "a" },
  { name: "Shabbat", slug: "shabbos", hebrew: "שבת", startDaf: 2, endDaf: 157, endSide: "b" },
  { name: "Eruvin", slug: "eruvin", hebrew: "עירובין", startDaf: 2, endDaf: 105, endSide: "a" },
  { name: "Pesachim", slug: "pesachim", hebrew: "פסחים", startDaf: 2, endDaf: 121, endSide: "b" },
  { name: "Yoma", slug: "yoma", hebrew: "יומא", startDaf: 2, endDaf: 88, endSide: "a" },
  { name: "Sukkah", slug: "sukkah", hebrew: "סוכה", startDaf: 2, endDaf: 56, endSide: "b" },
  { name: "Beitzah", slug: "beitzah", hebrew: "ביצה", startDaf: 2, endDaf: 40, endSide: "b" },
  { name: "Rosh Hashanah", slug: "rosh-hashanah", hebrew: "ראש השנה", startDaf: 2, endDaf: 35, endSide: "a" },
  { name: "Taanit", slug: "taanis", hebrew: "תענית", startDaf: 2, endDaf: 31, endSide: "a" },
  { name: "Megillah", slug: "megillah", hebrew: "מגילה", startDaf: 2, endDaf: 32, endSide: "a" },
  { name: "Moed Katan", slug: "moed-katan", hebrew: "מועד קטן", startDaf: 2, endDaf: 29, endSide: "a" },
  { name: "Chagigah", slug: "chagigah", hebrew: "חגיגה", startDaf: 2, endDaf: 27, endSide: "a" },
  { name: "Yevamot", slug: "yevamos", hebrew: "יבמות", startDaf: 2, endDaf: 122, endSide: "b" },
  { name: "Ketubot", slug: "kesubos", hebrew: "כתובות", startDaf: 2, endDaf: 112, endSide: "b" },
  { name: "Nedarim", slug: "nedarim", hebrew: "נדרים", startDaf: 2, endDaf: 91, endSide: "b" },
  { name: "Nazir", slug: "nazir", hebrew: "נזיר", startDaf: 2, endDaf: 66, endSide: "b" },
  { name: "Sotah", slug: "sotah", hebrew: "סוטה", startDaf: 2, endDaf: 49, endSide: "b" },
  { name: "Gittin", slug: "gittin", hebrew: "גיטין", startDaf: 2, endDaf: 90, endSide: "b" },
  { name: "Kiddushin", slug: "kiddushin", hebrew: "קידושין", startDaf: 2, endDaf: 82, endSide: "b" },
  { name: "Bava Kamma", slug: "bava-kamma", hebrew: "בבא קמא", startDaf: 2, endDaf: 119, endSide: "b" },
  { name: "Bava Metzia", slug: "bava-metzia", hebrew: "בבא מציעא", startDaf: 2, endDaf: 119, endSide: "a" },
  { name: "Bava Batra", slug: "bava-basra", hebrew: "בבא בתרא", startDaf: 2, endDaf: 176, endSide: "b" },
  { name: "Sanhedrin", slug: "sanhedrin", hebrew: "סנהדרין", startDaf: 2, endDaf: 113, endSide: "b" },
  { name: "Makkot", slug: "makkos", hebrew: "מכות", startDaf: 2, endDaf: 24, endSide: "b" },
  { name: "Shevuot", slug: "shevuos", hebrew: "שבועות", startDaf: 2, endDaf: 49, endSide: "b" },
  { name: "Avodah Zarah", slug: "avodah-zarah", hebrew: "עבודה זרה", startDaf: 2, endDaf: 76, endSide: "b" },
  { name: "Horayot", slug: "horayos", hebrew: "הוריות", startDaf: 2, endDaf: 14, endSide: "a" },
  { name: "Zevachim", slug: "zevachim", hebrew: "זבחים", startDaf: 2, endDaf: 120, endSide: "b" },
  { name: "Menachot", slug: "menachos", hebrew: "מנחות", startDaf: 2, endDaf: 110, endSide: "a" },
  { name: "Chullin", slug: "chullin", hebrew: "חולין", startDaf: 2, endDaf: 142, endSide: "a" },
  { name: "Bekhorot", slug: "bechoros", hebrew: "בכורות", startDaf: 2, endDaf: 61, endSide: "a" },
  // "Eruchin", as Lakewood Daf Yomi and most Daf Yomi shiurim say it; shas.org
  // files its daf pages under "arachin" (shasSlug), and dafsync.com/arachin/
  // goes on to /eruchin/ (netlify.toml).
  { name: "Arakhin", slug: "eruchin", shasSlug: "arachin", hebrew: "ערכין", startDaf: 2, endDaf: 34, endSide: "a" },
  { name: "Temurah", slug: "temurah", hebrew: "תמורה", startDaf: 2, endDaf: 34, endSide: "a" },
  { name: "Keritot", slug: "kereisos", hebrew: "כריתות", startDaf: 2, endDaf: 28, endSide: "b" },
  { name: "Meilah", slug: "meilah", hebrew: "מעילה", startDaf: 2, endDaf: 22, endSide: "a" },
  { name: "Niddah", slug: "niddah", hebrew: "נדה", startDaf: 2, endDaf: 73, endSide: "a" },];

const BY_NAME = new Map(MASECHTOS.map((m) => [m.name, m]));
const BY_SLUG = new Map(MASECHTOS.map((m) => [m.slug, m]));

// Sefaria name -> the slug shas.org files its daf pages under (daf-page.mjs):
// dafsync.com's own address slug, except where a masechta has its own shasSlug.
export const MASECHTA_SLUGS = Object.fromEntries(MASECHTOS.map((m) => [m.name, m.shasSlug || m.slug]));

export function masechtaByName(name) {
  return BY_NAME.get(name) || null;
}

export function masechtaBySlug(slug) {
  return BY_SLUG.get(String(slug || '').toLowerCase()) || null;
}

// "bava-basra" -> "Bava Basra": the name as the address spells it.
export function displayName(masechta) {
  return masechta.slug.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// Spellings people search a masechta by that neither its Sefaria name nor its
// address gives: Ashkenazi ones that drop a vowel, and the Sephardi "H".
const MORE_SPELLINGS = {
  Arakhin: ['Erchin', 'Erkhin'],
  Chullin: ['Chulin', 'Hullin'],
  Keritot: ['Krisos'],
  Meilah: ["Me'ilah"],
  Temurah: ['Temura'],
  Niddah: ['Nidah'],
};

// The other ways people spell it in a search: Sefaria's ("Bekhorot"), the
// modern Israeli one ("Bechorot"), an older address's ("Arachin") and the
// ones above, leaving out any that equal the display name.
export function otherSpellings(masechta) {
  const shown = displayName(masechta);
  const israeli = masechta.name.replace(/kh/g, 'ch').replace(/Kh/g, 'Ch');
  const older = masechta.shasSlug ? displayName({ slug: masechta.shasSlug }) : null;
  return [...new Set([masechta.name, israeli, older, ...(MORE_SPELLINGS[masechta.name] || [])].filter(Boolean))]
    .filter((s) => s !== shown);
}

// The amudim a daf has: "58a–58b", or "34a" for a masechta's last daf when
// it ends on the first side.
export function amudRange(masechta, daf) {
  return daf === masechta.endDaf && masechta.endSide === 'a' ? `${daf}a` : `${daf}a–${daf}b`;
}

// Hebrew numerals as a daf is numbered: 58 -> נח, 15 -> טו, 16 -> טז.
const ONES = ['', 'א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט'];
const TENS = ['', 'י', 'כ', 'ל', 'מ', 'נ', 'ס', 'ע', 'פ', 'צ'];
const HUNDREDS = ['', 'ק', 'ר', 'ש', 'ת'];
export function hebrewNumeral(n) {
  let rest = Number(n);
  if (!Number.isInteger(rest) || rest <= 0 || rest >= 500) return String(n);
  let out = HUNDREDS[Math.floor(rest / 100)];
  rest %= 100;
  if (rest === 15) return `${out}טו`;
  if (rest === 16) return `${out}טז`;
  return out + TENS[Math.floor(rest / 10)] + ONES[rest % 10];
}
