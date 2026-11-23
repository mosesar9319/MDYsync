// The Daf Yomi calendar (calendar/index.html).
//
// A month as a wall calendar shows it -- Sunday to Shabbos across, a daf on
// every day with its Hebrew date -- from the real schedule (shared/
// daf-yomi.mjs). A band along the top of each day tells one masechta from the
// next; the day a masechta begins and the day of its siyum are marked. A day
// opens beside the month (on a phone, as a sheet from the bottom, the month
// still in view behind it) with that daf's shiurim.
//
// For a signed-in learner it is also the tracker: each day shows what he has
// learned of its daf (learning.js works it out from the shiurim he heard),
// and the day says which line he is up to, or which words are outstanding,
// with one button back to that spot in a shiur.
//
// The wording is written in English here; i18n.js puts it into Hebrew (i18n-
// he.js has each sentence). Dates and daf names are made in the reader's
// language directly.

import { CYCLE_LENGTH, dafYomiOfDay, dateOfDay, dayNumber, localDayNumber, masechtaDays } from '/shared/daf-yomi.mjs';
import { hebrewNumeral } from '/shared/masechtos.mjs';
import { learnerId, playerUrl, printedLine, progressOf, setMarked, trackingSince, whereToLearn } from './learning.js';

const $ = (id) => document.getElementById(id);
const HE = document.documentElement.lang === 'he';
const DAY_MS = 86400000;
const today = localDayNumber();

const view = (() => {
  const now = dateOfDay(today);
  return { year: now.year, month: now.month, selected: today };
})();

// --- Dates -------------------------------------------------------------------

const asDate = (day) => new Date(day * DAY_MS);
const fmt = (options, locale = HE ? 'he' : 'en-US') => new Intl.DateTimeFormat(locale, { timeZone: 'UTC', ...options });
const MONTH_TITLE = fmt({ month: 'long', year: 'numeric' });
const LONG_DATE = fmt({ weekday: 'long', month: 'long', day: 'numeric' });
const SHORT_DATE = fmt({ month: 'short', day: 'numeric' });
const FULL_DATE = fmt({ month: 'long', day: 'numeric', year: 'numeric' });
const HEBREW_PARTS = new Intl.DateTimeFormat(HE ? 'he-u-ca-hebrew' : 'en-u-ca-hebrew', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' });

// The months as the site's readers say them.
const MONTH_SPELLING = { Tishri: 'Tishrei', Heshvan: 'Cheshvan', Tevet: 'Teves', Tamuz: 'Tammuz' };

// 13 -> י״ג, 6 -> ו׳: a number in letters, as a calendar prints it.
const gershayim = (letters) => (letters.length > 1 ? `${letters.slice(0, -1)}״${letters.slice(-1)}` : `${letters}׳`);
const hebrewDayLetters = (n) => gershayim(hebrewNumeral(n));
// 5787 -> תשפ״ז (the thousands are left unsaid).
function hebrewYearLetters(year) {
  let rest = Number(year) % 1000;
  let letters = '';
  while (rest >= 400) { letters += 'ת'; rest -= 400; }
  if (rest) letters += hebrewNumeral(rest);
  return letters ? gershayim(letters) : String(year);
}

// The Hebrew date of a day. In Hebrew the day and the year are in letters
// (י״ג כסלו תשפ״ז); in English, in figures (13 Kislev 5787).
function hebrewDate(day) {
  const parts = Object.fromEntries(HEBREW_PARTS.formatToParts(asDate(day)).map((p) => [p.type, p.value]));
  const number = Number(parts.day) || parts.day;
  const month = MONTH_SPELLING[parts.month] || parts.month;
  const year = HE ? hebrewYearLetters(parts.year) : parts.year;
  return { day: number, month, year, full: `${HE ? hebrewDayLetters(number) : number} ${month} ${year}` };
}

const WEEKDAYS = HE
  ? ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת']
  : ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Shabbos'];
const WEEKDAYS_SHORT = HE ? ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'] : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Shab'];

// --- The daf of a day, as it is shown -----------------------------------------

// Names too long for a phone's day square.
const SHORT_NAMES = {
  'Rosh Hashanah': 'R. Hashanah', 'Moed Katan': 'M. Katan', 'Bava Kamma': 'B. Kamma', 'Bava Metzia': 'B. Metzia',
  'Bava Basra': 'B. Basra', 'Avodah Zarah': 'A. Zarah', Sanhedrin: 'Sanhed.',
};

function dafLabel(daf) {
  if (HE) return { name: daf.masechta.hebrew, short: daf.masechta.hebrew, number: hebrewNumeral(daf.daf) };
  return { name: daf.masechta.display, short: SHORT_NAMES[daf.masechta.display] || daf.masechta.display, number: String(daf.daf) };
}
const dafTitle = (daf) => { const label = dafLabel(daf); return `${label.name} ${label.number}`; };

// --- What the learner has learned ---------------------------------------------
//
// A day's state, for a signed-in learner:
//   done     the daf is learned (a shiur heard to its end, or marked by hand)
//   gap      a shiur was finished, and a few words are still outstanding
//   partial  part of the daf is learned: the line he is up to
//   missed   the day has passed with nothing learned
//   none     nothing to show (not signed in, a day to come, or before he began)
const learned = new Map();          // day -> progressOf()'s answer
let since = null;                   // the day his tracking began
let loading = 0;

function stateOf(day) {
  const progress = learned.get(day);
  if (progress && progress.status !== 'none') return progress.status;
  if (learnerId() && since !== null && day < today && day >= since) return 'missed';
  return 'none';
}
const STATE_WORD = { done: 'Done', gap: 'Almost', partial: 'In progress', missed: 'Missed', none: '' };
const share = (day) => { const progress = learned.get(day); return progress ? Math.max(0, Math.min(1, progress.percent || 0)) : 0; };

// The ring: a track, an arc for how much is learned, a tick when done.
function ring(state, fraction, size = 18) {
  const r = size / 2 - 2;
  const around = 2 * Math.PI * r;
  const check = state === 'done'
    ? `<path class="cal-ring-check" d="M${size * 0.3} ${size * 0.52} l${size * 0.14} ${size * 0.14} l${size * 0.27} -${size * 0.29}" />` : '';
  return `<svg class="cal-ring" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">
    <circle class="cal-ring-track" cx="${size / 2}" cy="${size / 2}" r="${r}" />
    <circle class="cal-ring-fill" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-dasharray="${(around * fraction).toFixed(2)} ${around.toFixed(2)}" transform="rotate(-90 ${size / 2} ${size / 2})" />
    ${check}
  </svg>`;
}

// Reads what the learner has learned of every daf in view, and of the weeks
// behind today (for what is outstanding), then draws it.
async function loadLearning() {
  const turn = ++loading;
  if (!learnerId()) {
    learned.clear();
    since = null;
    renderMonth(); renderSummary(); renderDay();
    return;
  }
  const days = new Set(monthDays().days);
  for (let day = today - 45; day <= today; day += 1) days.add(day);
  const began = await trackingSince();
  const found = await Promise.all([...days].map(async (day) => {
    const daf = dafYomiOfDay(day);
    return [day, daf ? await progressOf(daf.masechta.name, daf.daf) : null];
  }));
  if (turn !== loading) return;
  since = began;
  for (const [day, progress] of found) { if (progress) learned.set(day, progress); else learned.delete(day); }
  renderMonth(); renderSummary(); renderDay();
}

// A word of the page's own, in the reader's language, where it is put into
// a longer text by hand (i18n.js translates whole texts on its own).
const say = (english) => (window.DafSyncI18n?.t ? window.DafSyncI18n.t(english) : english);
const either = (english, hebrew) => (HE ? hebrew : english);

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// --- The month -------------------------------------------------------------------

function monthDays() {
  const first = dayNumber(view.year, view.month, 1);
  const start = first - dateOfDay(first).weekday;                 // the Sunday on or before the 1st
  const last = dayNumber(view.year, view.month + 1, 0);
  const end = last + (6 - dateOfDay(last).weekday);               // the Shabbos on or after the last
  const days = [];
  for (let day = start; day <= end; day += 1) days.push(day);
  return { days, first, last };
}

function renderMonth() {
  const { days, first, last } = monthDays();
  $('calTitle').textContent = MONTH_TITLE.format(asDate(first));
  const from = hebrewDate(first);
  const to = hebrewDate(last);
  $('calHebrewMonths').textContent = from.month === to.month ? `${from.month} ${to.year}` : `${from.month} – ${to.month} ${to.year}`;
  $('calWeekdays').innerHTML = WEEKDAYS.map((name, i) => `<span><span class="cal-weekday-long">${name}</span><span class="cal-weekday-short">${WEEKDAYS_SHORT[i]}</span></span>`).join('');

  $('calGrid').innerHTML = days.map((day) => {
    const date = dateOfDay(day);
    const daf = dafYomiOfDay(day);
    const hebrew = hebrewDate(day);
    const label = daf ? dafLabel(daf) : null;
    const state = stateOf(day);
    const classes = ['cal-cell', `is-${state}`];
    if (day < first || day > last) classes.push('is-outside');
    if (day === today) classes.push('is-today');
    if (day === view.selected) classes.push('is-selected');
    if (daf) classes.push(`mas-${daf.masechtaIndex % 6}`);
    const flag = daf?.last ? '<span class="cal-flag cal-flag-siyum">Siyum</span>' : (daf?.first ? '<span class="cal-flag">Begins</span>' : '');
    const status = state === 'none' ? ''
      : `<span class="cal-status">${ring(state, share(day))}<span class="cal-status-word">${state === 'partial' ? `<span translate="no">${Math.round(share(day) * 100)}%</span>` : STATE_WORD[state]}</span></span>`;
    const said = `${LONG_DATE.format(asDate(day))}: ${daf ? dafTitle(daf) : ''}${state === 'none' ? '' : `, ${say(STATE_WORD[state])}`}`;
    return `<button type="button" class="${classes.join(' ')}" role="gridcell" data-day="${day}" aria-label="${escapeHtml(said)}" aria-pressed="${day === view.selected}">
      <span class="cal-cell-top">
        <span class="cal-date">${date.day}</span>
        ${day === today ? '<span class="cal-today-tag">Today</span>' : ''}
        ${hebrew.day === 1
          ? `<span class="cal-hdate is-month" translate="no"><span class="cal-hdate-name">${escapeHtml(hebrew.month)}</span><span class="cal-hdate-day" lang="he" dir="rtl">${hebrewDayLetters(1)}</span></span>`
          : `<span class="cal-hdate" lang="he" dir="rtl" translate="no">${hebrewDayLetters(hebrew.day)}</span>`}
      </span>
      ${label ? `<span class="cal-daf" translate="no"><span class="cal-mas"><span class="cal-mas-long">${escapeHtml(label.name)}</span><span class="cal-mas-short">${escapeHtml(label.short)}</span></span><span class="cal-num">${label.number}</span></span>` : '<span class="cal-daf"></span>'}
      <span class="cal-cell-foot">${status}${flag}</span>
    </button>`;
  }).join('');
  renderLegend();
}

function renderLegend() {
  const items = learnerId() ? [['done', 'Done', 1], ['partial', 'In progress', 0.5], ['gap', 'A few words left', 0.93], ['missed', 'Missed', 0]] : [];
  $('calLegend').innerHTML = items.map(([state, word, fraction]) => `<span class="cal-legend-item is-${state}">${ring(state, fraction, 16)}<span>${word}</span></span>`).join('');
}

// --- Above the month: today's daf, the masechta, Shas -- or what is outstanding ------

function renderSummary() {
  const daf = dafYomiOfDay(today);
  if (!daf) return;
  const span = masechtaDays(today, daf.masechtaIndex);
  const label = dafLabel(daf);
  const cycleEnd = today + (CYCLE_LENGTH - 1 - daf.dayOfCycle);
  const count = new Intl.NumberFormat(HE ? 'he' : 'en-US');
  const tracking = Boolean(learnerId()) && since !== null;
  const todayState = stateOf(today);
  const todayNote = !tracking || todayState === 'none' ? 'See today’s shiurim'
    : todayState === 'done' ? 'Done'
      : `<span translate="no">${either(`You are ${Math.round(share(today) * 100)}% through. Carry on`, `למדת ${Math.round(share(today) * 100)}%. להמשיך`)}</span>`;
  const todayTile = `<button type="button" class="cal-tile cal-tile-today" data-go="${today}">
      <span class="cal-tile-label">Today’s Daf</span>
      <strong translate="no">${escapeHtml(dafTitle(daf))}</strong>
      <span class="cal-tile-note">${todayNote}</span>
    </button>`;
  const masechtaTile = `<div class="cal-tile">
      <span class="cal-tile-label" translate="no">${escapeHtml(label.name)}</span>
      <strong>Daf ${daf.position + 1} of ${daf.masechta.dapim}</strong>
      <span class="cal-bar"><span style="width:${Math.round(((daf.position + 1) / daf.masechta.dapim) * 100)}%"></span></span>
      <span class="cal-tile-note">Siyum on ${SHORT_DATE.format(asDate(span.last))}</span>
    </div>`;
  const shasTile = `<div class="cal-tile">
      <span class="cal-tile-label">Shas</span>
      <strong>Daf ${count.format(daf.dayOfCycle + 1)} of ${count.format(CYCLE_LENGTH)}</strong>
      <span class="cal-bar"><span style="width:${(((daf.dayOfCycle + 1) / CYCLE_LENGTH) * 100).toFixed(1)}%"></span></span>
      <span class="cal-tile-note">Siyum HaShas on ${FULL_DATE.format(asDate(cycleEnd))}</span>
    </div>`;

  if (!tracking) {
    const invite = learnerId()
      ? '<p class="cal-invite">The calendar fills itself in as you learn: every shiur you hear on DafSync is counted, line by line.</p>'
      : '<p class="cal-invite"><button type="button" class="cal-invite-link" id="calSignIn">Sign in</button> <span>and the calendar keeps track of the dapim you learn, line by line.</span></p>';
    $('calSummary').innerHTML = `${todayTile}${masechtaTile}${shasTile}${invite}`;
    $('calSignIn')?.addEventListener('click', () => document.getElementById('signInButton')?.click());
    return;
  }

  // What is outstanding in the weeks behind today, and how many dapim in a
  // row were learned up to yesterday (a daf with words left still counts).
  const outstanding = [];
  let streak = 0;
  let unbroken = true;
  for (let day = today - 1; day >= Math.max(since, today - 45); day -= 1) {
    const state = stateOf(day);
    if (state === 'gap' || state === 'partial' || state === 'missed') outstanding.push(day);
    if (state === 'missed' || state === 'none') unbroken = false;
    else if (unbroken) streak += 1;
  }
  if (todayState !== 'none' && todayState !== 'missed') streak += 1;
  const oldest = outstanding[outstanding.length - 1];
  const catchUp = outstanding.length
    ? `<button type="button" class="cal-tile cal-tile-catchup" data-go="${oldest}">
        <span class="cal-tile-label">To catch up</span>
        <strong translate="no">${either(`${outstanding.length} ${outstanding.length === 1 ? 'daf' : 'dapim'} not finished`, outstanding.length === 1 ? 'דף אחד לא הושלם' : `${outstanding.length} דפים לא הושלמו`)}</strong>
        <span class="cal-tile-note">Start with the earliest</span>
      </button>`
    : '<div class="cal-tile"><span class="cal-tile-label">Up to date</span><strong>Nothing outstanding</strong><span class="cal-tile-note">Every daf so far is done.</span></div>';
  $('calSummary').innerHTML = `${todayTile}${catchUp}
    <div class="cal-tile">
      <span class="cal-tile-label">In a row</span>
      <strong translate="no">${either(`${streak} ${streak === 1 ? 'daf' : 'dapim'}`, streak === 1 ? 'דף אחד' : `${streak} דפים`)}</strong>
      <span class="cal-tile-note">Dapim learned one after the other</span>
    </div>${masechtaTile}`;
}

// --- A day ---------------------------------------------------------------------------

// The library's catalog, fetched once. A fetch that failed (the connection
// dropped) is not remembered: the next day opened tries again.
let catalogRequest = null;
function getCatalog() {
  if (!catalogRequest) {
    catalogRequest = fetch('/api/get-catalog')
      .then((response) => { if (!response.ok) throw new Error(String(response.status)); return response.json(); })
      .catch(() => { catalogRequest = null; return null; });
  }
  return catalogRequest;
}

const MAGGID_NAMES = { default: "R' Eli Stefansky", bornstein: "R' Sruly Bornstein" };
const KINDS = [
  ['regularEn', 'English', 'regular', 'en'], ['regularHe', 'Hebrew', 'regular', 'he'],
  ['chazarahEn', 'Chazarah Daf, English', 'chazarah', 'en'], ['chazarahHe', 'Chazarah Daf, Hebrew', 'chazarah', 'he'],
];

// The shiurim the library has for a daf: [{ who, kind, title, url, tractate,
// daf, maggid, variant, language }], or null when the library could not be
// reached.
async function shiurimFor(daf) {
  const catalog = await getCatalog();
  if (!catalog) return null;
  const sources = [['default', catalog.tractates], ...Object.entries(catalog.maggidim || {}).map(([id, entry]) => [id, entry?.tractates])];
  const out = [];
  for (const [id, tractates] of sources) {
    const row = (tractates?.[daf.masechta.name] || []).find((r) => Number(r.daf) === daf.daf);
    if (!row) continue;
    for (const [key, kind, variant, language] of KINDS) {
      if (!row[key]?.videoId) continue;
      const shiur = { tractate: daf.masechta.name, daf: daf.daf, maggid: id, variant, language };
      out.push({ ...shiur, who: MAGGID_NAMES[id] || id, kind, title: row[key].label || '', url: playerUrl(shiur) });
    }
  }
  return out;
}

async function renderDay() {
  const day = view.selected;
  const panel = $('calDay');
  const daf = dafYomiOfDay(day);
  if (!daf) { panel.innerHTML = ''; return; }
  const hebrew = hebrewDate(day);
  const label = dafLabel(daf);
  const when = day === today ? '<span class="cal-day-when">Today</span>' : (day === today + 1 ? '<span class="cal-day-when">Tomorrow</span>' : '');
  panel.className = `cal-day is-open mas-${daf.masechtaIndex % 6}`;
  panel.innerHTML = `<button type="button" class="cal-day-close" id="calDayClose" aria-label="Close">×</button>
    <div class="cal-day-date">${when}<span translate="no">${LONG_DATE.format(asDate(day))} <span class="cal-day-hdate">· ${escapeHtml(hebrew.full)}</span></span></div>
    <h2 class="cal-day-title" translate="no">${escapeHtml(label.name)} <span>${label.number}</span>${HE ? '' : `<span class="cal-day-he" lang="he" dir="rtl">${escapeHtml(daf.masechta.hebrew)} ${hebrewNumeral(daf.daf)}</span>`}</h2>
    <div class="cal-day-where"><span>Daf ${daf.position + 1} of ${daf.masechta.dapim}</span>${daf.first ? ' · <strong class="cal-day-mark">Begins</strong>' : ''}${daf.last ? ' · <strong class="cal-day-mark is-siyum">Siyum</strong>' : ''}</div>
    <div class="cal-day-body"><p class="cal-day-loading">Loading this daf…</p></div>`;
  $('calDayClose').addEventListener('click', closeDay);

  const shiurim = daf.masechta.onSite ? await shiurimFor(daf) : [];
  if (view.selected !== day) return;                       // another day was chosen meanwhile
  const progress = learned.get(day) || null;
  const state = stateOf(day);
  const heardOf = (shiur) => progress?.records.find((record) => !record.manual && Number(record.daf) === daf.daf && record.maggid === shiur.maggid
    && (record.variant || 'regular') === shiur.variant && (record.language || 'en') === shiur.language);

  let list;
  if (shiurim === null) {
    list = '<div class="cal-section"><p class="cal-quiet">The shiurim could not be loaded. Check your connection and tap the day again.</p></div>';
  } else if (shiurim.length) {
    list = `<div class="cal-section"><h3>Shiurim</h3><div class="cal-shiurim">${shiurim.map((shiur) => {
      const record = heardOf(shiur);
      const part = record && record.duration_seconds > 0 ? Math.min(1, record.position_seconds / record.duration_seconds) : 0;
      const mark = !record ? '' : (record.finished
        ? '<span class="cal-shiur-heard">Heard to the end</span>'
        : `<span class="cal-bar" title="${Math.round(part * 100)}%"><span style="width:${Math.round(part * 100)}%"></span></span>`);
      return `<a class="cal-shiur${record?.finished ? ' is-heard' : ''}" href="${shiur.url}">
        <span class="cal-shiur-play" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg></span>
        <span class="cal-shiur-text"><strong><span>${escapeHtml(shiur.who)}</span> · <span>${escapeHtml(shiur.kind)}</span></strong>
          <span translate="no"><bdi>${escapeHtml(shiur.title)}</bdi></span></span>
        ${mark}
      </a>`;
    }).join('')}</div></div>`;
  } else if (!daf.masechta.onSite) {
    list = '<div class="cal-section"><p class="cal-quiet">DafSync has no shiurim on this masechta yet.</p></div>';
  } else {
    list = `<div class="cal-section"><p class="cal-quiet">${day > today ? 'Its shiurim appear here once they are given.' : 'No shiur is linked to this daf yet.'}</p></div>`;
  }

  // What the learner has learned of this daf.
  const amudWord = (amud) => either(`amud ${amud.slice(-1)}`, `עמוד ${amud.slice(-1) === 'a' ? 'א' : 'ב'}`);
  const words = (n) => either(`${n} ${n === 1 ? 'word' : 'words'}`, n === 1 ? 'מילה אחת' : `${n} מילים`);
  const gap = progress?.gaps[0] || null;
  let card = '';
  if (state === 'done') {
    const note = progress.manual ? 'Marked as learned.'
      : progress.tail ? `<span translate="no">${either(`The last ${words(progress.tail.count)} of the daf are read at the start of the next shiur.`, `${words(progress.tail.count)} אחרונות של הדף נקראות בתחילת השיעור הבא.`)}</span>`
        : 'Learned to the end.';
    card = `<div class="cal-state is-done"><span class="cal-state-ring">${ring('done', 1, 40)}</span><div><strong>Done</strong><span>${note}</span></div></div>`;
  } else if (state === 'gap' || state === 'partial') {
    const title = state === 'gap' ? either(`${words(progress.outstanding)} still to learn`, `נותרו ${words(progress.outstanding)} ללמוד`)
      : either(`In progress · ${Math.round(progress.percent * 100)}%`, `באמצע · ${Math.round(progress.percent * 100)}%`);
    const where = gap ? either(`${state === 'gap' ? 'On' : 'Up to'} ${amudWord(gap.amud)}`, `${state === 'gap' ? 'ב' : 'עד '}${amudWord(gap.amud)}`)
      : either(`${Math.round(progress.percent * 100)}% of the shiur heard`, `נשמעו ${Math.round(progress.percent * 100)}% מהשיעור`);
    card = `<div class="cal-state is-${state}"><span class="cal-state-ring">${ring(state, progress.percent, 40)}</span><div translate="no"><strong>${title}</strong><span id="calWhere">${where}</span></div></div>
      <div id="calGo"></div>`;
  } else if (state === 'missed') {
    card = `<div class="cal-state is-missed"><span class="cal-state-ring">${ring('missed', 0, 40)}</span><div><strong>Not learned yet</strong><span>${shiurim?.length ? 'Pick a shiur below to learn it.' : 'Mark it below once you have learned it.'}</span></div></div>`;
  }

  // The daf as two strips, amud a and amud b: learned, outstanding, and the
  // end a finished shiur left for the next one.
  let map = '';
  if (progress?.known && (state === 'gap' || state === 'partial' || (state === 'done' && progress.tail))) {
    const sizeOf = (amud) => progress.records.reduce((best, record) => Math.max(best, (record.words?.[amud] || []).reduce((sum, n) => sum + n, 0)), 0);
    const strip = (letter) => {
      const amud = `${daf.masechta.name} ${daf.daf}${letter}`;
      const size = sizeOf(amud) || 1;
      const piece = (from, count, kind) => `<span class="cal-map-piece is-${kind}" style="inset-inline-start:${((from / size) * 100).toFixed(2)}%;width:${Math.max(1.2, (count / size) * 100).toFixed(2)}%"></span>`;
      const pieces = progress.gaps.filter((g) => g.amud === amud).map((g) => piece(g.from, g.count, 'gap'));
      if (progress.tail?.amud === amud) pieces.push(piece(progress.tail.from, progress.tail.count, 'later'));
      return `<div class="cal-map-row"><span class="cal-map-amud" translate="no">${escapeHtml(either(`Amud ${letter}`, `עמוד ${letter === 'a' ? 'א' : 'ב'}`))}</span><span class="cal-map-bar is-strip">${pieces.join('')}</span></div>`;
    };
    map = `<div class="cal-section"><h3>The daf</h3><div class="cal-map">${strip('a')}${strip('b')}</div>
      <div class="cal-map-key"><span class="is-heard">Learned</span>${progress.gaps.length ? '<span class="is-gap">Still to learn</span>' : ''}${progress.tail ? '<span class="is-later">In the next shiur</span>' : ''}</div></div>`;
  }

  const ref = encodeURIComponent(`${daf.masechta.name} ${daf.daf}a`);
  const canMark = Boolean(learnerId()) && day <= today && (state !== 'done' || progress?.manual);
  const actions = `<div class="cal-actions">
      ${daf.masechta.onSite ? `<a class="cal-secondary" href="/browse/?ref=${ref}">Open the daf</a>` : ''}
      ${shiurim?.length ? `<a class="cal-secondary" href="/${daf.masechta.slug}/${daf.daf}/">About this daf</a>` : ''}
      ${canMark ? `<button type="button" class="cal-secondary" id="calMark">${progress?.manual ? 'Remove my mark' : 'Mark as learned'}</button>` : ''}
    </div>`;
  panel.querySelector('.cal-day-body').innerHTML = `${card}${map}${list}${actions}`;
  panel.classList.add(`is-${state}`);

  $('calMark')?.addEventListener('click', async (event) => {
    event.currentTarget.disabled = true;
    await setMarked(daf.masechta.name, daf.daf, !progress?.manual);
    loadLearning();
  });

  // The way back in: the printed line the outstanding stretch starts on, and
  // the shiur that reads it, at that moment.
  if (!gap || !$('calGo')) return;
  const counts = progress.records.reduce((best, record) => {
    const listOf = record.words?.[gap.amud];
    return Array.isArray(listOf) && listOf.length > best.length ? listOf : best;
  }, []);
  const next = dafYomiOfDay(day + 1);
  const nearby = [...(shiurim || []), ...((next?.masechta.name === daf.masechta.name && next.masechta.onSite ? await shiurimFor(next) : null) || [])];
  const [line, target] = await Promise.all([printedLine(gap.amud, gap.from, counts), whereToLearn(daf.masechta.name, daf.daf, progress, nearby)]);
  if (view.selected !== day || !$('calGo')) return;
  if (line) {
    $('calWhere').textContent = either(`${state === 'gap' ? 'On' : 'Up to'} ${amudWord(gap.amud)}, line ${line}`, `${state === 'gap' ? 'ב' : 'עד '}${amudWord(gap.amud)}, שורה ${line}`);
  }
  const unfinished = progress.records.find((record) => !record.manual && Number(record.daf) === daf.daf && !record.finished && record.position_seconds > 0);
  const url = target?.url || (state === 'partial' && unfinished ? playerUrl(unfinished, unfinished.position_seconds) : null);
  if (!url) return;
  const goLabel = state === 'gap' ? either(`Learn the ${words(progress.outstanding)}`, `ללמוד את ${words(progress.outstanding)}`)
    : line ? either(`Continue from line ${line}`, `להמשיך משורה ${line}`) : either('Continue where you stopped', 'להמשיך מהמקום שבו עצרת');
  const who = target ? MAGGID_NAMES[target.shiur.maggid || 'default'] || '' : '';
  $('calGo').innerHTML = `<a class="cal-primary" href="${url}"><span translate="no">${escapeHtml(goLabel)}</span>${who ? `<span class="cal-primary-who">${escapeHtml(who)}</span>` : ''}</a>`;
}

function closeDay() {
  $('calDay').classList.remove('is-open');
  document.body.classList.remove('cal-sheet-open');
}

function selectDay(day, { open = true } = {}) {
  view.selected = day;
  const date = dateOfDay(day);
  view.year = date.year;
  view.month = date.month;
  renderMonth();
  renderDay();
  if (open) document.body.classList.add('cal-sheet-open');
  if (learnerId() && !learned.has(monthDays().days[0])) loadLearning();
}

function moveMonth(by) {
  const moved = new Date(Date.UTC(view.year, view.month - 1 + by, 1));
  view.year = moved.getUTCFullYear();
  view.month = moved.getUTCMonth() + 1;
  renderMonth();
  if (learnerId()) loadLearning();
}

// --- Wiring ----------------------------------------------------------------------------

$('calGrid').addEventListener('click', (event) => {
  const cell = event.target.closest('.cal-cell');
  if (cell) selectDay(Number(cell.dataset.day));
});
$('calSummary').addEventListener('click', (event) => {
  const tile = event.target.closest('[data-go]');
  if (tile) selectDay(Number(tile.dataset.go));
});
$('calPrev').addEventListener('click', () => moveMonth(-1));
$('calNext').addEventListener('click', () => moveMonth(1));
$('calToday').addEventListener('click', () => selectDay(today));
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeDay(); });

renderMonth();
renderSummary();
// On a computer today's daf is open beside the month from the start; a phone
// shows the month alone until a day is tapped.
renderDay();
if (window.matchMedia('(max-width: 900px)').matches) closeDay();
// Signing in, or out, changes what every day shows.
window.DafSyncAuth?.onChange(() => loadLearning());
