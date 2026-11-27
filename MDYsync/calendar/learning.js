// What the signed-in learner has learned, for the calendar (calendar.js).
//
// Reads the learner's own rows of the `learning` table (written by
// learning-tracker.js while a shiur plays), works each daf out from them
// (shared/daf-progress.mjs), marks a daf as learned by hand, and finds where
// in which shiur an outstanding stretch is read, and which printed line of
// the daf it starts on.

import { dafProgress, parseAmud, placeOf } from '/shared/daf-progress.mjs';

const COLUMNS = 'shiur_key,tractate,daf,maggid,variant,language,position_seconds,duration_seconds,heard,reads,words,finished,finished_at,manual,created_at,updated_at';
const DAY_MS = 86400000;

const auth = () => window.DafSyncAuth;
export const learnerId = () => auth()?.getUser?.()?.id || null;

// The learner's rows, read once: Map<tractate, rows>. A learner who keeps at
// it has a few thousand rows over a cycle, so they are read a thousand at a
// time (the most the server gives in one answer).
let owner = null;
let everything = null;
const PAGE = 1000;

function forLearner() {
  const id = learnerId();
  if (id !== owner) {
    owner = id;
    everything = null;
  }
  return id;
}

function allRows() {
  const id = forLearner();
  if (!id) return Promise.resolve(new Map());
  if (!everything) {
    everything = (async () => {
      const byTractate = new Map();
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await auth().client.from('learning').select(COLUMNS).eq('user_id', id)
          .order('created_at', { ascending: true }).range(from, from + PAGE - 1);
        if (error) throw error;
        for (const row of data || []) {
          if (!byTractate.has(row.tractate)) byTractate.set(row.tractate, []);
          byTractate.get(row.tractate).push(row);
        }
        if (!data || data.length < PAGE) return byTractate;
      }
    })().catch(() => { everything = null; return new Map(); });
  }
  return everything;
}

const rowsOf = async (tractate) => (await allRows()).get(tractate) || [];

// The day the learner's tracking began (a day number), or null when nothing
// has been kept yet. Days before it are not "missed".
export async function trackingSince() {
  let first = null;
  for (const rows of (await allRows()).values()) {
    for (const row of rows) {
      const at = row.created_at ? new Date(row.created_at) : null;
      if (at && !Number.isNaN(at.getTime()) && (!first || at < first)) first = at;
    }
  }
  return first ? Math.round(Date.UTC(first.getFullYear(), first.getMonth(), first.getDate()) / DAY_MS) : null;
}

// How many dapim the learner has finished, masechta by masechta and in all.
//
//   cycle   the masechtos of the Daf Yomi cycle: [{ name, startDaf, endDaf }]
//
// A daf counts once it is done by the rule (shared/daf-progress.mjs): a shiur
// heard to its end, or marked by hand. A daf part learned does not add to
// the count; how much of it is learned is kept apart (`part`, in dapim), for
// a lighter stretch on a bar.
//
// Returns { masechtos: [{ done: Set<daf>, part }], done, part }, the
// masechtos in the order given.
export async function learnedDapim(cycle) {
  const rows = await allRows();
  let done = 0;
  let part = 0;
  const masechtos = cycle.map((masechta) => {
    const records = rows.get(masechta.name) || [];
    const finished = new Set();
    let partly = 0;
    // Only a daf with a shiur of its own, or a mark, can be done or begun.
    const dapim = new Set(records.map((row) => Number(row.daf)).filter((daf) => daf >= masechta.startDaf && daf <= masechta.endDaf));
    for (const daf of dapim) {
      const progress = dafProgress({ tractate: masechta.name, daf, records });
      if (progress.status === 'done') finished.add(daf);
      else if (progress.status !== 'none') partly += Math.max(0, Math.min(1, progress.percent || 0));
    }
    done += finished.size;
    part += partly;
    return { done: finished, part: partly };
  });
  return { masechtos, done, part };
}

// The learner's progress on a daf ({ tractate, daf }), with the rows it came from.
export async function progressOf(tractate, daf) {
  const records = await rowsOf(tractate);
  return { ...dafProgress({ tractate, daf, records }), records };
}

// Marks a daf as learned by hand, or takes the mark off.
export async function setMarked(tractate, daf, marked) {
  const id = forLearner();
  if (!id) return false;
  const key = `manual:${tractate}:${daf}`;
  const now = new Date().toISOString();
  const { error } = marked
    ? await auth().client.from('learning').upsert({ user_id: id, shiur_key: key, tractate, daf, maggid: 'manual', manual: true, finished: true, finished_at: now, updated_at: now })
    : await auth().client.from('learning').delete().eq('user_id', id).eq('shiur_key', key);
  if (error) return false;
  everything = null;
  return true;
}

// --- Where an outstanding stretch is read ------------------------------------------

const files = new Map();
function getJson(url) {
  if (!files.has(url)) {
    files.set(url, fetch(url)
      .then((response) => { if (!response.ok) throw new Error(String(response.status)); return response.json(); })
      .catch(() => { files.delete(url); return null; }));
  }
  return files.get(url);
}
const resultsFile = (path) => getJson(`/api/get-results-file?path=${encodeURIComponent(path)}&optional=1`);

// A shiur's sync: the same file names the player reads (app.js refKey), the
// caption sync first, then the voice one.
async function syncOf({ tractate, daf, maggid, variant, language }) {
  const name = `${maggid === 'bornstein' ? 'Bornstein-' : ''}${language === 'he' ? 'Hebrew-' : ''}${variant === 'chazarah' ? 'Chazarah-Daf-' : ''}${tractate.replace(/\s+/g, '-')}-${daf}a`;
  for (const prefix of ['', 'Voice-']) {
    const file = await resultsFile(`by-ref/${prefix}${name}.json`);
    if (file?.segments?.length) return file;
  }
  return null;
}

export function playerUrl({ tractate, daf, maggid, variant, language }, time) {
  const query = `${variant === 'chazarah' ? '&variant=chazarah' : ''}${language === 'he' ? '&language=hebrew' : ''}${maggid && maggid !== 'default' ? `&maggid=${maggid}` : ''}`;
  return `/player/?ref=${encodeURIComponent(`${tractate} ${daf}a`)}${query}${time > 3 ? `&t=${Math.floor(time)}` : ''}`;
}

// When, in a shiur's sync, the maggid reads the stretch `from`..`to` of
// `amud` -- the first of its words that he reads: seconds, or null when he
// reads none of it.
function timeOfWord(file, amud, from, to, counts) {
  let best = null;
  for (const segment of file.segments) {
    if (segment.estimated || !Number.isFinite(Number(segment.start))) continue;
    const ref = String(segment.ref || '').replace(/\s*\([^)]*\)/g, '');
    const colon = ref.lastIndexOf(':');
    if (colon < 0 || ref.slice(0, colon) !== amud) continue;
    const n = Number(ref.slice(colon + 1));
    let at = 0;
    for (let i = 0; i < n - 1; i += 1) at += counts[i] || 0;
    if (at + Number(segment.w1) < from || at + Number(segment.w0) > to) continue;   // before the stretch, or after it
    if (!best || at + Number(segment.w0) < best.at) best = { at: at + Number(segment.w0), time: Number(segment.start) };
  }
  return best ? best.time : null;
}

// Where to go to learn a stretch of a daf that is still outstanding.
//
//   progress   progressOf()'s answer for the daf
//   shiurim    the shiurim the library has on this daf and on the next one:
//              [{ tractate, daf, maggid, variant, language }]
//
// Tries, in turn, the shiurim on this daf the learner has begun (to carry on
// where he is), the next daf's shiurim he heard (whose opening may read the
// end of this one), then the rest. Returns { url, shiur } or null.
export async function whereToLearn(tractate, daf, progress, shiurim) {
  const gap = progress.gaps[0];
  if (!gap) return null;
  const counts = progress.records.reduce((best, record) => {
    const list = record.words?.[gap.amud];
    return Array.isArray(list) && list.length > best.length ? list : best;
  }, []);
  const same = (a, b) => a.tractate === b.tractate && Number(a.daf) === Number(b.daf) && (a.maggid || 'default') === (b.maggid || 'default')
    && (a.variant || 'regular') === (b.variant || 'regular') && (a.language || 'en') === (b.language || 'en');
  const reads = (record) => { const span = record.reads?.[gap.amud]; return Array.isArray(span) && span[0] <= gap.to && span[1] >= gap.from; };
  const heard = progress.records.filter((record) => !record.manual && reads(record) && [daf, daf + 1].includes(Number(record.daf)));
  heard.sort((a, b) => (Number(a.daf) - Number(b.daf)) || (Number(a.finished) - Number(b.finished)));
  const others = shiurim.filter((shiur) => !progress.records.some((record) => !record.manual && same(record, shiur)));
  for (const shiur of [...heard, ...others].slice(0, 5)) {
    const file = await syncOf({ tractate: shiur.tractate, daf: Number(shiur.daf), maggid: shiur.maggid || 'default', variant: shiur.variant || 'regular', language: shiur.language || 'en' });
    if (!file) continue;
    const time = timeOfWord(file, gap.amud, gap.from, gap.to, counts);
    if (time === null) continue;
    return { url: playerUrl(shiur, Math.max(0, time - 2)), shiur };
  }
  return null;
}

// --- The printed line ----------------------------------------------------------------

// The line of the printed page a word is on (1 at the top), from the page's
// map of where every word is printed; null when the page has no map.
export async function printedLine(amud, offset, counts) {
  const parsed = parseAmud(amud);
  const place = placeOf(counts, offset);
  if (!parsed || !place) return null;
  const page = await resultsFile(`pages/${parsed.tractate.replace(/\s+/g, '-')}-${parsed.daf}${parsed.amud}.json`);
  const boxes = page?.wordBoxes;
  if (!Array.isArray(boxes) || !boxes.length) return null;
  const word = boxes.find((box) => box.ref === `${amud}:${place.n}` && box.wordIndex === place.w)
    || boxes.find((box) => box.ref === `${amud}:${place.n}` && box.wordIndex > place.w);
  if (!word) return null;
  // Words on one printed line share a height on the page: count the lines above.
  const tops = [...new Set(boxes.map((box) => box.y))].sort((a, b) => a - b);
  const height = boxes.reduce((sum, box) => sum + box.h, 0) / boxes.length;
  let line = 1;
  let last = tops[0];
  for (const top of tops) {
    if (top > word.y + height * 0.4) break;
    if (top - last > height * 0.6) line += 1;
    last = top;
  }
  return line;
}
