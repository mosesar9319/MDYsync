// Notes on the calendar (calendar.js), for a signed-in learner:
//
//   * his own note on a day -- a line or a page, kept in the `calendar_notes`
//     table, one row per learner per day;
//   * the notes he has written on that day's daf, private and public, on the
//     Interactive Daf and in Cloud Chaburah (`line_notes`): listed with the
//     day, each a link to where it lives.

const auth = () => window.DafSyncAuth;
const me = () => auth()?.getUser?.()?.id || null;

let owner = null;
let days = null;                    // Promise<Map<"2026-11-23", body>>
let byTractate = new Map();         // tractate -> Promise<Map<daf, rows>>

function forLearner() {
  const id = me();
  if (id !== owner) {
    owner = id;
    days = null;
    byTractate = new Map();
  }
  return id;
}

const two = (n) => String(n).padStart(2, '0');
// A day as the table keeps it: { year, month, day } -> "2026-11-23".
export const isoOfDate = (date) => `${date.year}-${two(date.month)}-${two(date.day)}`;

// The learner's day notes: Map<"2026-11-23", text>. Empty when signed out.
export function dayNotes() {
  const id = forLearner();
  if (!id) return Promise.resolve(new Map());
  if (!days) {
    days = auth().client.from('calendar_notes').select('day, body').eq('user_id', id)
      .then(({ data, error }) => {
        if (error) throw error;
        return new Map((data || []).filter((row) => row.body).map((row) => [String(row.day).slice(0, 10), row.body]));
      })
      .catch(() => { days = null; return new Map(); });
  }
  return days;
}

// Keeps a day's note (an empty one is taken away). True when it was saved.
export async function saveDayNote(iso, text) {
  const id = forLearner();
  if (!id) return false;
  const body = String(text || '').trim().slice(0, 4000);
  const { error } = body
    ? await auth().client.from('calendar_notes').upsert({ user_id: id, day: iso, body, updated_at: new Date().toISOString() })
    : await auth().client.from('calendar_notes').delete().eq('user_id', id).eq('day', iso);
  if (error) return false;
  const notes = await dayNotes();
  if (body) notes.set(iso, body); else notes.delete(iso);
  return true;
}

// A note's daf from its key ("Hebrew-Arakhin-6a" -> 6); the same pattern
// my-notes-data.js reads keys with.
const KEY = /^(?:Voice-)?(?:Hebrew-)?(?:Chazarah-Daf-)?(.+)-(\d+)([ab])$/;

// The notes the learner wrote on a masechta's dapim: Map<daf, [{ id, title,
// text, isPrivate, url }]>, the newest first. Empty when signed out.
export function dafNotes(tractate) {
  const id = forLearner();
  if (!id) return Promise.resolve(new Map());
  if (!byTractate.has(tractate)) {
    const slug = tractate.replace(/\s+/g, '-');
    byTractate.set(tractate, auth().client.from('line_notes')
      .select('id, daf_ref_key, title, body, is_private, created_at')
      .eq('author_id', id).is('deleted_at', null).ilike('daf_ref_key', `%${slug}-%`)
      .order('created_at', { ascending: false }).limit(500)
      .then(({ data, error }) => {
        if (error) throw error;
        const byDaf = new Map();
        for (const row of data || []) {
          const key = KEY.exec(String(row.daf_ref_key || ''));
          if (!key || key[1] !== slug) continue;
          const daf = Number(key[2]);
          const text = String(row.body || '').replace(/\s+/g, ' ').trim();
          const list = byDaf.get(daf) || [];
          list.push({
            id: row.id,
            title: String(row.title || '').trim(),
            text,
            isPrivate: Boolean(row.is_private),
            // A public note is a discussion in Cloud Chaburah; a private one
            // lives on its line of the daf.
            url: row.is_private ? `/browse/?ref=${encodeURIComponent(`${tractate} ${daf}${key[3]}`)}` : `/chaburah/thread/?thread=${encodeURIComponent(row.id)}`,
          });
          byDaf.set(daf, list);
        }
        return byDaf;
      })
      .catch(() => { byTractate.delete(tractate); return new Map(); }));
  }
  return byTractate.get(tractate);
}
