// The Daf Yomi calendar (calendar/index.html).
//
// A month as a wall calendar shows it -- Sunday to Shabbos across, a daf on
// every day with its date ("Nov 23") and its Hebrew date -- from the real schedule (shared/
// daf-yomi.mjs). A band along the top of each day tells one masechta from the
// next; the day a masechta begins and the day of its siyum are marked. A day
// opens beside the month (on a phone, as a sheet from the bottom, the month
// still in view behind it) with that daf's shiurim.
//
// The wording is written in English here; i18n.js puts it into Hebrew (i18n-
// he.js has each sentence). Dates and daf names are made in the reader's
// language directly.

import { CYCLE_LENGTH, dafYomiOfDay, dateOfDay, dayNumber, localDayNumber, masechtaDays } from '/shared/daf-yomi.mjs';
import { hebrewNumeral } from '/shared/masechtos.mjs';

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
    const classes = ['cal-cell'];
    if (day < first || day > last) classes.push('is-outside');
    if (day === today) classes.push('is-today');
    if (day === view.selected) classes.push('is-selected');
    if (daf) classes.push(`mas-${daf.masechtaIndex % 6}`);
    const flag = daf?.last ? '<span class="cal-flag cal-flag-siyum">Siyum</span>' : (daf?.first ? '<span class="cal-flag">Begins</span>' : '');
    const said = `${LONG_DATE.format(asDate(day))}: ${daf ? dafTitle(daf) : ''}`;
    return `<button type="button" class="${classes.join(' ')}" role="gridcell" data-day="${day}" aria-label="${escapeHtml(said)}" aria-pressed="${day === view.selected}">
      <span class="cal-cell-top">
        <span class="cal-date" translate="no">${SHORT_DATE.format(asDate(day))}</span>
        ${hebrew.day === 1
          ? `<span class="cal-hdate is-month" translate="no"><span class="cal-hdate-name">${escapeHtml(hebrew.month)}</span><span class="cal-hdate-day" lang="he" dir="rtl">${hebrewDayLetters(1)}</span></span>`
          : `<span class="cal-hdate" lang="he" dir="rtl" translate="no">${hebrewDayLetters(hebrew.day)}</span>`}
      </span>
      ${label ? `<span class="cal-daf" translate="no"><span class="cal-mas"><span class="cal-mas-long">${escapeHtml(label.name)}</span><span class="cal-mas-short">${escapeHtml(label.short)}</span></span><span class="cal-num">${label.number}</span></span>` : '<span class="cal-daf"></span>'}
      <span class="cal-cell-foot">${day === today ? '<span class="cal-today-tag">Today</span>' : flag}</span>
    </button>`;
  }).join('');
}

// --- Above the month: today's daf, the masechta, Shas ------------------------------

function renderSummary() {
  const daf = dafYomiOfDay(today);
  if (!daf) return;
  const span = masechtaDays(today, daf.masechtaIndex);
  const label = dafLabel(daf);
  const cycleEnd = today + (CYCLE_LENGTH - 1 - daf.dayOfCycle);
  const count = new Intl.NumberFormat(HE ? 'he' : 'en-US');
  $('calSummary').innerHTML = `<button type="button" class="cal-tile cal-tile-today" data-go="${today}">
      <span class="cal-tile-label">Today’s Daf</span>
      <strong translate="no">${escapeHtml(dafTitle(daf))}</strong>
      <span class="cal-tile-note">See today’s shiurim</span>
    </button>
    <div class="cal-tile">
      <span class="cal-tile-label" translate="no">${escapeHtml(label.name)}</span>
      <strong>Daf ${daf.position + 1} of ${daf.masechta.dapim}</strong>
      <span class="cal-bar"><span style="width:${Math.round(((daf.position + 1) / daf.masechta.dapim) * 100)}%"></span></span>
      <span class="cal-tile-note">Siyum on ${SHORT_DATE.format(asDate(span.last))}</span>
    </div>
    <div class="cal-tile">
      <span class="cal-tile-label">Shas</span>
      <strong>Daf ${count.format(daf.dayOfCycle + 1)} of ${count.format(CYCLE_LENGTH)}</strong>
      <span class="cal-bar"><span style="width:${(((daf.dayOfCycle + 1) / CYCLE_LENGTH) * 100).toFixed(1)}%"></span></span>
      <span class="cal-tile-note">Siyum HaShas on ${FULL_DATE.format(asDate(cycleEnd))}</span>
    </div>`;
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
  ['regularEn', 'English', ''], ['regularHe', 'Hebrew', '&language=hebrew'],
  ['chazarahEn', 'Chazarah Daf, English', '&variant=chazarah'], ['chazarahHe', 'Chazarah Daf, Hebrew', '&variant=chazarah&language=hebrew'],
];

// The shiurim the library has for a daf: [{ who, kind, title, url }], or null
// when the library could not be reached.
async function shiurimFor(daf) {
  const catalog = await getCatalog();
  if (!catalog) return null;
  const sources = [['default', catalog.tractates, ''], ...Object.entries(catalog.maggidim || {}).map(([id, entry]) => [id, entry?.tractates, `&maggid=${id}`])];
  const out = [];
  for (const [id, tractates, extra] of sources) {
    const row = (tractates?.[daf.masechta.name] || []).find((r) => Number(r.daf) === daf.daf);
    if (!row) continue;
    for (const [key, kind, query] of KINDS) {
      if (!row[key]?.videoId) continue;
      out.push({ who: MAGGID_NAMES[id] || id, kind, title: row[key].label || '', url: `/player/?ref=${encodeURIComponent(`${daf.masechta.name} ${daf.daf}${row[key].amud || 'a'}`)}${query}${extra}` });
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

  let list;
  if (shiurim === null) {
    list = '<div class="cal-section"><p class="cal-quiet">The shiurim could not be loaded. Check your connection and tap the day again.</p></div>';
  } else if (shiurim.length) {
    list = `<div class="cal-section"><h3>Shiurim</h3><div class="cal-shiurim">${shiurim.map((shiur) => `<a class="cal-shiur" href="${shiur.url}">
        <span class="cal-shiur-play" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg></span>
        <span class="cal-shiur-text"><strong><span>${escapeHtml(shiur.who)}</span> · <span>${escapeHtml(shiur.kind)}</span></strong>
          <span translate="no"><bdi>${escapeHtml(shiur.title)}</bdi></span></span>
      </a>`).join('')}</div></div>`;
  } else if (!daf.masechta.onSite) {
    list = '<div class="cal-section"><p class="cal-quiet">DafSync has no shiurim on this masechta yet.</p></div>';
  } else {
    list = `<div class="cal-section"><p class="cal-quiet">${day > today ? 'Its shiurim appear here once they are given.' : 'No shiur is linked to this daf yet.'}</p></div>`;
  }
  const ref = encodeURIComponent(`${daf.masechta.name} ${daf.daf}a`);
  const actions = daf.masechta.onSite ? `<div class="cal-actions">
      <a class="cal-secondary" href="/browse/?ref=${ref}">Open the daf</a>
      ${shiurim?.length ? `<a class="cal-secondary" href="/${daf.masechta.slug}/${daf.daf}/">About this daf</a>` : ''}
    </div>` : '';
  panel.querySelector('.cal-day-body').innerHTML = `${list}${actions}`;
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
}

function moveMonth(by) {
  const moved = new Date(Date.UTC(view.year, view.month - 1 + by, 1));
  view.year = moved.getUTCFullYear();
  view.month = moved.getUTCMonth() + 1;
  renderMonth();
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
