// What a learner has learned of a daf, worked out from the shiurim he heard.
//
// The player keeps, for each shiur a signed-in learner listens to, the
// stretches of the recording he heard (learning-tracker.js). A synced shiur's
// file says which words of the daf are read when, so those stretches become
// words of the daf (shiurCoverage). The calendar then asks, for a daf, what
// all the shiurim he heard add up to (dafProgress).
//
// The rule, as the site's owner set it:
//
//   * What counts is the shiur. A daf whose shiur was heard to its end is
//     done -- even when that shiur stopped twenty words short of the end of
//     amud b, as a maggid shiur who runs out of time does. He will read those
//     words at the start of tomorrow's shiur.
//   * Tomorrow settles it. Once anything past that point has been heard, the
//     words nobody read to him are owed: a learner who goes on with another
//     maggid, whose shiur opens at the last twelve words, has eight words of
//     yesterday's daf outstanding, and the daf says so.
//   * Words a maggid skips, or that the sync could not place, inside a stretch
//     the learner listened through are not held against him. Only what no
//     shiur he heard covers is a gap.
//   * Hearing the end of a daf only because the next day's shiur opens with it
//     does not make that daf "started".
//
// Words are counted the way the sync counts them: a segment's ref
// ("Arakhin 6b:13") is a paragraph of the amud and w0..w1 its words. An
// "offset" here is a word's place in its amud, counted from the amud's first
// word. Runs in the browser and under Node (tests).

const AMUD_PATTERN = /^(.+) (\d+)([ab])$/;

export const amudKey = (tractate, daf, amud) => `${tractate} ${daf}${amud}`;

export function parseAmud(key) {
  const match = AMUD_PATTERN.exec(String(key || ''));
  return match ? { tractate: match[1], daf: Number(match[2]), amud: match[3], order: Number(match[2]) * 2 + (match[3] === 'b' ? 1 : 0) } : null;
}

// "Arakhin 6b:13" -> { amud: "Arakhin 6b", n: 13 }. A shiur's kind is sometimes
// written into its refs ("Chullin 98b (Chazarah Daf):1"); the daf is the same.
function parseSegmentRef(ref) {
  const text = String(ref || '').replace(/\s*\([^)]*\)/g, '');
  const colon = text.lastIndexOf(':');
  if (colon < 0) return null;
  const n = Number(text.slice(colon + 1));
  const amud = text.slice(0, colon);
  return Number.isInteger(n) && n >= 1 && parseAmud(amud) ? { amud, n } : null;
}

// --- Stretches of time or of words: [from, to] pairs, kept sorted and apart ----

// `gap` is how far apart two stretches may be and still be one (0 for whole
// numbers that touch: [3,5] and [6,9]).
export function mergeRanges(ranges, gap = 0) {
  const sorted = (ranges || [])
    .filter((r) => Array.isArray(r) && Number.isFinite(r[0]) && Number.isFinite(r[1]) && r[1] >= r[0])
    .map((r) => [r[0], r[1]])
    .sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const range of sorted) {
    const last = out[out.length - 1];
    if (last && range[0] <= last[1] + gap) last[1] = Math.max(last[1], range[1]);
    else out.push(range);
  }
  return out;
}

const mergeWords = (ranges) => mergeRanges(ranges, 1);
const countWords = (ranges) => ranges.reduce((sum, [from, to]) => sum + (to - from + 1), 0);

function overlap(ranges, from, to) {
  let sum = 0;
  for (const [a, b] of ranges) {
    if (b <= from) continue;
    if (a >= to) break;
    sum += Math.min(b, to) - Math.max(a, from);
  }
  return sum;
}

// --- A shiur ---------------------------------------------------------------------

// How many words each paragraph of each amud has, as far as this shiur's file
// shows: { "Arakhin 6b": [17, 12, ...] }. A sync file lists every word of the
// amudim it covers (the ones it could not place are marked estimated).
export function wordCounts(segments) {
  const counts = {};
  for (const segment of segments || []) {
    const at = parseSegmentRef(segment?.ref);
    const last = Number(segment?.w1);
    if (!at || !Number.isInteger(last) || last < 0) continue;
    const list = counts[at.amud] || (counts[at.amud] = []);
    while (list.length < at.n) list.push(0);
    list[at.n - 1] = Math.max(list[at.n - 1], last + 1);
  }
  return counts;
}

const total = (counts) => (counts || []).reduce((sum, n) => sum + n, 0);

// The offset of paragraph n's word w.
function offsetOf(counts, n, w) {
  let offset = 0;
  for (let i = 0; i < n - 1; i += 1) offset += counts[i] || 0;
  return offset + w;
}

// The other way: an offset -> { n, w } (the paragraph and the word in it).
export function placeOf(counts, offset) {
  let rest = offset;
  for (let i = 0; i < (counts || []).length; i += 1) {
    if (rest < counts[i]) return { n: i + 1, w: rest };
    rest -= counts[i];
  }
  return null;
}

// What of the daf a learner heard in one shiur.
//
//   segments  the shiur's sync file: { ref, start, end, w0, w1, estimated? }
//   ranges    the stretches of the recording he heard, in seconds
//
// Returns { synced, words, reads, heard, finished }:
//   words     wordCounts(segments), for the amudim the shiur reads
//   reads     { amud: [from, to] } the stretch of each amud the maggid reads
//   heard     { amud: [[from, to], ...] } the words the learner heard
//   finished  he heard the last line the maggid reads (not the announcements
//             after it)
//
// Only lines the sync really placed say where the maggid is. A line it
// could not place (estimated) has a made-up time; it counts as heard when
// the learner listened from the placed line before it through to the one
// after -- and likewise words the maggid skipped between the two.
export function shiurCoverage(segments, ranges) {
  const heardTime = mergeRanges(ranges, 0.75);
  const counts = wordCounts(segments);
  const lines = [];
  for (const segment of segments || []) {
    if (!segment || segment.estimated) continue;
    const at = parseSegmentRef(segment.ref);
    const start = Number(segment.start);
    const w0 = Number(segment.w0);
    const w1 = Number(segment.w1);
    if (!at || !Number.isFinite(start) || !Number.isInteger(w0) || !Number.isInteger(w1) || w1 < w0) continue;
    const end = Number.isFinite(Number(segment.end)) ? Math.max(Number(segment.end), start) : start;
    lines.push({ amud: at.amud, order: parseAmud(at.amud).order, from: offsetOf(counts[at.amud], at.n, w0), to: offsetOf(counts[at.amud], at.n, w1), start, end });
  }
  if (!lines.length) return { synced: false, words: {}, reads: {}, heard: {}, finished: false };
  lines.sort((a, b) => a.start - b.start);

  const reads = {};
  for (const line of lines) {
    const span = reads[line.amud] || (reads[line.amud] = [line.from, line.to]);
    span[0] = Math.min(span[0], line.from);
    span[1] = Math.max(span[1], line.to);
  }

  // A line is heard when the learner was listening for its turn: from when
  // it starts until the next placed line does.
  const heardLine = lines.map((line, i) => {
    const until = i + 1 < lines.length ? Math.max(lines[i + 1].start, line.start + 0.5) : Math.max(line.end, line.start + 2);
    const turn = until - line.start;
    return overlap(heardTime, line.start, until) >= Math.min(turn * 0.5, 2);
  });

  const amudim = Object.keys(counts).filter((key) => parseAmud(key)).sort((a, b) => parseAmud(a).order - parseAmud(b).order);
  const heard = {};
  const add = (amud, from, to) => { if (to >= from) (heard[amud] || (heard[amud] = [])).push([from, to]); };
  lines.forEach((line, i) => {
    if (!heardLine[i]) return;
    add(line.amud, line.from, line.to);
    const next = lines[i + 1];
    if (!next || !heardLine[i + 1]) return;
    // Listened from this line through to the next: what lies between them on
    // the daf was either said or skipped by the maggid.
    if (next.order === line.order) {
      if (next.from > line.to + 1) add(line.amud, line.to + 1, next.from - 1);
    } else if (next.order > line.order) {
      add(line.amud, line.to + 1, total(counts[line.amud]) - 1);
      for (const amud of amudim) {
        const order = parseAmud(amud).order;
        if (order > line.order && order < next.order) add(amud, 0, total(counts[amud]) - 1);
      }
      add(next.amud, 0, next.from - 1);
    }
  });
  for (const amud of Object.keys(heard)) heard[amud] = mergeWords(heard[amud]);

  const words = {};
  for (const amud of Object.keys(reads)) words[amud] = counts[amud];
  return { synced: true, words, reads, heard, finished: heardLine[heardLine.length - 1] };
}

// For a shiur with no sync: heard to its end when nearly all of it was heard.
export function heardMostOf(ranges, duration) {
  if (!(duration > 0)) return false;
  return overlap(mergeRanges(ranges, 0.75), 0, duration) >= duration * 0.85;
}

// --- A daf -----------------------------------------------------------------------

// A finished shiur with this little outstanding is "a few words left"; with
// more than this the daf is simply in progress.
const FEW_WORDS = 60;
const FEW_SHARE = 0.15;

// What a learner has learned of a daf.
//
//   tractate, daf   the daf ("Arakhin", 6)
//   records         everything he has in this masechta: rows of the `learning`
//                   table ({ tractate, daf, maggid, variant, language, heard,
//                   reads, words, finished, manual, position_seconds,
//                   duration_seconds }). A record's own tractate and daf are
//                   the shiur's; its heard/reads/words may reach into the
//                   dapim on either side.
//
// Returns {
//   status        'none' | 'partial' | 'gap' | 'done'
//   manual        marked as learned by hand
//   started       he heard some of this daf in a shiur on this daf
//   known         the daf's words are known (a synced shiur was heard)
//   total         words on the daf (0 when not known)
//   learned       words heard, or allowed for now (the tail)
//   outstanding   words in gaps
//   percent       0..1
//   gaps          [{ amud, from, to, count, n, w }] stretches still to learn,
//                 in order (n: the paragraph the stretch starts in, w: the
//                 word in it)
//   tail          { amud, from, count } the words after the last line a
//                 finished shiur read, allowed for now -- or null
//   shiurim       the shiurim on this daf he heard, the furthest first
// }
export function dafProgress({ tractate, daf, records }) {
  const keys = [amudKey(tractate, daf, 'a'), amudKey(tractate, daf, 'b')];
  const next = [amudKey(tractate, daf + 1, 'a'), amudKey(tractate, daf + 1, 'b')];
  const all = (records || []).filter((record) => record && record.tractate === tractate);
  const own = all.filter((record) => Number(record.daf) === Number(daf));
  const manual = own.some((record) => record.manual);
  const shiurim = own.filter((record) => !record.manual);

  // The daf's words: the fullest account any shiur gives of each amud.
  const counts = keys.map((key) => all.reduce((best, record) => {
    const list = record.words?.[key];
    return Array.isArray(list) && total(list) > total(best) ? list : best;
  }, []));
  const sizes = counts.map(total);
  const size = sizes[0] + sizes[1];
  const known = sizes[0] > 0 && sizes[1] > 0;
  // A word's place on the daf as one run of numbers: amud a, then amud b.
  const base = [0, sizes[0]];

  const onDaf = (record, field) => {
    const out = [];
    keys.forEach((key, i) => {
      const value = record[field]?.[key];
      if (!Array.isArray(value)) return;
      const list = Array.isArray(value[0]) ? value : [value];
      for (const [from, to] of list) {
        if (Number.isFinite(from) && Number.isFinite(to)) out.push([base[i] + Math.max(0, from), base[i] + Math.min(to, sizes[i] - 1)]);
      }
    });
    return out;
  };

  const heardOwn = shiurim.some((record) => keys.some((key) => record.heard?.[key]?.length));
  const heardUnsynced = shiurim.some((record) => !Object.keys(record.reads || {}).length && Number(record.position_seconds) > 0);
  const started = manual || heardOwn || heardUnsynced;
  const finished = shiurim.filter((record) => record.finished);
  const describe = (record) => ({
    key: record.shiur_key, maggid: record.maggid || 'default', variant: record.variant || 'regular', language: record.language || 'en',
    finished: Boolean(record.finished), position: Number(record.position_seconds) || 0, duration: Number(record.duration_seconds) || 0,
    words: countWords(mergeWords(onDaf(record, 'heard'))),
  });
  const result = {
    status: 'none', manual, started, known, total: known ? size : 0, learned: 0, outstanding: 0, percent: 0, gaps: [], tail: null,
    shiurim: shiurim.map(describe).sort((a, b) => Number(b.finished) - Number(a.finished) || b.words - a.words || b.position - a.position),
  };
  if (manual) return { ...result, status: 'done', learned: result.total, percent: 1 };
  if (!started) return result;

  if (!known) {
    // No synced shiur to count words by: go by the shiur itself.
    if (finished.length) return { ...result, status: 'done', percent: 1 };
    const share = Math.max(0, ...shiurim.map((record) => (record.duration_seconds > 0 ? Math.min(1, record.position_seconds / record.duration_seconds) : 0)));
    return { ...result, status: 'partial', percent: share };
  }

  const heard = mergeWords(all.flatMap((record) => onDaf(record, 'heard')));
  let wanted = [[0, size - 1]];

  // The tail: after the last line a finished shiur on this daf read. Allowed
  // while nothing past that line has been heard, on this daf or the next.
  let tail = null;
  if (finished.length) {
    const reach = Math.max(-1, ...finished.map((record) => {
      if (next.some((key) => record.reads?.[key])) return size - 1;   // it read on into the next daf
      return Math.max(-1, ...onDaf(record, 'reads').map(([, to]) => to));
    }));
    if (reach >= 0 && reach < size - 1) {
      const beyondHere = heard.some(([, to]) => to > reach);
      const beyondNext = all.some((record) => next.some((key) => record.heard?.[key]?.length));
      if (!beyondHere && !beyondNext) {
        const i = reach + 1 >= base[1] ? 1 : 0;
        tail = { amud: keys[i], from: reach + 1 - base[i], count: size - 1 - reach };
        wanted = [[0, reach]];
      }
    }
  }

  // What is wanted and not heard.
  const missing = [];
  for (const [from, to] of wanted) {
    let at = from;
    for (const [a, b] of heard) {
      if (b < at) continue;
      if (a > to) break;
      if (a > at) missing.push([at, a - 1]);
      at = Math.max(at, b + 1);
    }
    if (at <= to) missing.push([at, to]);
  }
  // Shown amud by amud.
  const gaps = [];
  for (const [from, to] of missing) {
    keys.forEach((key, i) => {
      const a = Math.max(from, base[i]);
      const b = Math.min(to, base[i] + sizes[i] - 1);
      if (b < a) return;
      const place = placeOf(counts[i], a - base[i]) || { n: 1, w: 0 };
      gaps.push({ amud: key, from: a - base[i], to: b - base[i], count: b - a + 1, n: place.n, w: place.w });
    });
  }
  const outstanding = countWords(missing);
  const few = outstanding <= Math.max(FEW_WORDS, size * FEW_SHARE);
  return {
    ...result,
    status: !outstanding ? 'done' : (finished.length && few ? 'gap' : 'partial'),
    learned: size - outstanding,
    outstanding,
    percent: (size - outstanding) / size,
    gaps,
    tail,
  };
}
