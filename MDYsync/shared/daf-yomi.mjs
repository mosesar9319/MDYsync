// The Daf Yomi schedule: which daf is learned on which day.
//
// One cycle is 2,711 dapim, a daf a day, in the order of Shas. It is the
// Bavli's masechtos (masechtos.mjs) with four additions the cycle learns that
// the site has no shiur pages for: Shekalim (the Yerushalmi's, after
// Pesachim), and Kinnim, Tamid and Middos, which are printed after Meilah and
// carry on its page numbers (Meilah ends on 22, Kinnim is 23-25, Tamid 26-33,
// Middos 34-37).
//
// The 14th cycle began on 5 January 2020 (Berachos 2) and ends on 7 June 2027
// (Niddah 73); the 15th begins the next day. Days are counted as calendar
// days (UTC day numbers), so daylight saving never moves one.
// Dependency-free but for masechtos.mjs: the calendar page imports it in the
// browser, and the tests check it against the published calendar.

import { MASECHTOS, displayName } from './masechtos.mjs';

const DAY = 86400000;
export const CYCLE_START = { cycle: 14, day: Date.UTC(2020, 0, 5) / DAY };

// Not on the site: learned in the cycle, with no shiur pages here.
const ADDITIONS = {
  Pesachim: [{ name: 'Shekalim', display: 'Shekalim', hebrew: 'שקלים', startDaf: 2, endDaf: 22 }],
  Meilah: [
    { name: 'Kinnim', display: 'Kinnim', hebrew: 'קינים', startDaf: 23, endDaf: 25 },
    { name: 'Tamid', display: 'Tamid', hebrew: 'תמיד', startDaf: 26, endDaf: 33 },
    { name: 'Middot', display: 'Middos', hebrew: 'מדות', startDaf: 34, endDaf: 37 },
  ],
};

// Each masechta of the cycle, in order, with the day of the cycle it begins on.
export const CYCLE = (() => {
  const list = [];
  let first = 0;
  const add = (entry) => {
    const dapim = entry.endDaf - entry.startDaf + 1;
    list.push({ ...entry, dapim, first });
    first += dapim;
  };
  for (const masechta of MASECHTOS) {
    add({ name: masechta.name, display: displayName(masechta), hebrew: masechta.hebrew, slug: masechta.slug, startDaf: masechta.startDaf, endDaf: masechta.endDaf, onSite: true });
    for (const extra of ADDITIONS[masechta.name] || []) add({ ...extra, slug: null, onSite: false });
  }
  return list;
})();

export const CYCLE_LENGTH = CYCLE.reduce((sum, m) => sum + m.dapim, 0);

// A calendar date as a day number (days since 1 January 1970, no time of day).
export function dayNumber(year, month, day) {
  return Math.round(Date.UTC(year, month - 1, day) / DAY);
}

// The day number of a Date, by the reader's own calendar (their local date).
export function localDayNumber(date = new Date()) {
  return dayNumber(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

export function dateOfDay(day) {
  const date = new Date(day * DAY);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), weekday: date.getUTCDay() };
}

// The daf of a day: its masechta, the daf's number, where it falls in the
// masechta and the cycle. Null before the 14th cycle.
export function dafYomiOfDay(day) {
  const since = day - CYCLE_START.day;
  if (!Number.isFinite(since) || since < 0) return null;
  const cycle = CYCLE_START.cycle + Math.floor(since / CYCLE_LENGTH);
  const dayOfCycle = since % CYCLE_LENGTH;
  const index = CYCLE.findIndex((m) => dayOfCycle < m.first + m.dapim);
  const masechta = CYCLE[index];
  const position = dayOfCycle - masechta.first;
  return {
    cycle,
    dayOfCycle,
    masechta,
    masechtaIndex: index,
    daf: masechta.startDaf + position,
    position,                                // 0 for the masechta's first daf
    first: position === 0,
    last: position === masechta.dapim - 1,    // the day of its siyum
    lastOfCycle: dayOfCycle === CYCLE_LENGTH - 1,
  };
}

export function dafYomiOn(year, month, day) {
  return dafYomiOfDay(dayNumber(year, month, day));
}

// The days a masechta is learned in the cycle a given day belongs to.
export function masechtaDays(day, masechtaIndex) {
  const since = day - CYCLE_START.day;
  const cycleStart = CYCLE_START.day + Math.floor(since / CYCLE_LENGTH) * CYCLE_LENGTH;
  const masechta = CYCLE[masechtaIndex];
  return { first: cycleStart + masechta.first, last: cycleStart + masechta.first + masechta.dapim - 1 };
}
