// The Daf Yomi calendar (calendar/index.html).
//
// A month as a wall calendar shows it -- Sunday to Shabbos across, a daf on
// every day -- and, for a signed-in learner, how each daf stands: done, in
// progress (and the line he is up to), a few words still outstanding, or
// missed. A day opens beside the month (on a phone, as a sheet from the
// bottom) with that daf's shiurim and where to carry on from.
//
// THIS IS THE DESIGN PREVIEW. The schedule is the real one (shared/
// daf-yomi.mjs) and so are the shiurim and the lines of the daf (the site's
// own sync files); how much of each daf was learned is SAMPLE data, made up
// in sampleProgress() below. Nothing is saved.

import { dafYomiOfDay, dateOfDay, dayNumber, localDayNumber, masechtaDays } from '/shared/daf-yomi.mjs';
import { hebrewNumeral } from '/shared/masechtos.mjs';

const $ = (id) => document.getElementById(id);
const HE = document.documentElement.lang === 'he';
const DAY_MS = 86400000;
const today = localDayNumber();

const view = (() => {
  const now = dateOfDay(today);
  return { year: now.year, month: now.month, selected: today, signedIn: true };
})();

// --- Dates -------------------------------------------------------------------

const asDate = (day) => new Date(day * DAY_MS);
const fmt = (options, locale = HE ? 'he' : 'en-US') => new Intl.DateTimeFormat(locale, { timeZone: 'UTC', ...options });
const MONTH_TITLE = fmt({ month: 'long', year: 'numeric' });
const LONG_DATE = fmt({ weekday: 'long', month: 'long', day: 'numeric' });
const SHORT_DATE = fmt({ month: 'short', day: 'numeric' });
const HEBREW_PARTS = new Intl.DateTimeFormat(HE ? 'he-u-ca-hebrew' : 'en-u-ca-hebrew', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' });

// The months as the site's readers say them.
const MONTH_SPELLING = { Tishri: 'Tishrei', Heshvan: 'Cheshvan', Tevet: 'Teves', Tamuz: 'Tammuz' };

function hebrewDate(day) {
  const parts = Object.fromEntries(HEBREW_PARTS.formatToParts(asDate(day)).map((p) => [p.type, p.value]));
  return { day: Number(parts.day) || parts.day, month: MONTH_SPELLING[parts.month] || parts.month, year: parts.year };
}

// 13 -> י״ג, 6 -> ו׳: the day of the Hebrew month as a calendar prints it.
function hebrewDayLetters(n) {
  const letters = hebrewNumeral(n);
  return letters.length > 1 ? `${letters.slice(0, -1)}״${letters.slice(-1)}` : `${letters}׳`;
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

// --- SAMPLE progress (the design preview only) --------------------------------
//
// What the tracker will work out from the shiurim a learner really heard. The
// states, by the rule agreed for "done":
//   done     he finished a shiur of the daf. Where that shiur stopped short of
//            the daf's end, the rest is "to be continued", not held against him.
//   gap      done, until the next day's shiur (another maggid's, say) began
//            later than the first one stopped: the words between are still
//            outstanding.
//   partial  he stopped partway through a shiur: the line he is up to.
//   missed   the day passed with nothing learned.
//   marked   he marked the daf as learned himself (from a sefer, another shiur).
const TRACKING_SINCE = today - 68;

function sampleProgress(day) {
  if (!view.signedIn) return { state: 'none' };
  if (day > today) return { state: 'future' };
  if (day < TRACKING_SINCE) return { state: 'before' };
  const ago = today - day;
  if (ago === 0) return { state: 'partial', fraction: 0.42, today: true };
  if (ago === 1) return { state: 'gap', fraction: 0.97 };
  if (ago === 4) return { state: 'partial', fraction: 0.63 };
  if (ago === 6) return { state: 'missed', fraction: 0 };
  if (ago === 9) return { state: 'marked', fraction: 1 };
  if (ago === 15) return { state: 'missed', fraction: 0 };
  if (ago === 13) return { state: 'partial', fraction: 0.71 };
  return { state: 'done', fraction: 1 };
}

const STATE_WORD = {
  done: 'Done', marked: 'Done', gap: 'Almost', partial: 'In progress', missed: 'Missed', future: '', before: '', none: '',
};
const isOutstanding = (state) => ['gap', 'partial', 'missed'].includes(state);

// --- Small pieces --------------------------------------------------------------

function ring(progress, size = 18) {
  const r = size / 2 - 2;
  const around = 2 * Math.PI * r;
  const fraction = Math.max(0, Math.min(1, progress.fraction ?? 0));
  const check = progress.state === 'done' || progress.state === 'marked'
    ? `<path class="cal-ring-check" d="M${size * 0.3} ${size * 0.52} l${size * 0.14} ${size * 0.14} l${size * 0.27} -${size * 0.29}" />` : '';
  return `<svg class="cal-ring" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">
    <circle class="cal-ring-track" cx="${size / 2}" cy="${size / 2}" r="${r}" />
    <circle class="cal-ring-fill" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-dasharray="${(around * fraction).toFixed(2)} ${around.toFixed(2)}" transform="rotate(-90 ${size / 2} ${size / 2})" />
    ${check}
  </svg>`;
}

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
    const progress = sampleProgress(day);
    const label = daf ? dafLabel(daf) : null;
    const classes = ['cal-cell', `is-${progress.state}`];
    if (day < first || day > last) classes.push('is-outside');
    if (day === today) classes.push('is-today');
    if (day === view.selected) classes.push('is-selected');
    if (date.weekday === 6) classes.push('is-shabbos');
    if (daf) classes.push(`mas-${daf.masechtaIndex % 6}`);
    const flag = daf?.last ? '<span class="cal-flag cal-flag-siyum">Siyum</span>' : (daf?.first ? '<span class="cal-flag">Begins</span>' : '');
    const status = STATE_WORD[progress.state]
      ? `<span class="cal-status">${ring(progress)}<span class="cal-status-word">${progress.state === 'partial' ? `${Math.round(progress.fraction * 100)}%` : STATE_WORD[progress.state]}</span></span>`
      : '<span class="cal-status"></span>';
    const said = `${LONG_DATE.format(asDate(day))}: ${daf ? dafTitle(daf) : ''}${STATE_WORD[progress.state] ? `, ${STATE_WORD[progress.state]}` : ''}`;
    return `<button type="button" class="${classes.join(' ')}" role="gridcell" data-day="${day}" aria-label="${escapeHtml(said)}" aria-pressed="${day === view.selected}">
      <span class="cal-cell-top">
        <span class="cal-date">${date.day}</span>
        ${day === today ? '<span class="cal-today-tag">Today</span>' : flag}
        <span class="cal-hdate" lang="he" dir="rtl">${hebrew.day === 1 ? escapeHtml(hebrew.month) : hebrewDayLetters(hebrew.day)}</span>
      </span>
      ${label ? `<span class="cal-daf" translate="no"><span class="cal-mas"><span class="cal-mas-long">${escapeHtml(label.name)}</span><span class="cal-mas-short">${escapeHtml(label.short)}</span></span><span class="cal-num">${label.number}</span></span>` : '<span class="cal-daf"></span>'}
      <span class="cal-cell-foot">${status}</span>
    </button>`;
  }).join('');

  renderLegend();
  renderSummary();
}

function renderLegend() {
  const items = view.signedIn
    ? [['done', 'Done'], ['partial', 'In progress'], ['gap', 'A few words left'], ['missed', 'Missed']]
    : [];
  $('calLegend').innerHTML = items.map(([state, word]) => `<span class="cal-legend-item is-${state}">${ring({ state, fraction: state === 'done' ? 1 : state === 'gap' ? 0.93 : state === 'partial' ? 0.5 : 0 }, 16)}<span>${word}</span></span>`).join('')
    + '<span class="cal-legend-item cal-legend-note">Tap a day for its shiurim.</span>';
}

// --- What you are up to (above the month) -----------------------------------------

function renderSummary() {
  const daf = dafYomiOfDay(today);
  const span = masechtaDays(today, daf.masechtaIndex);
  const siyum = SHORT_DATE.format(asDate(span.last));
  const label = dafLabel(daf);
  const masechtaTile = `<div class="cal-tile">
      <span class="cal-tile-label">${escapeHtml(label.name)}</span>
      <strong>Daf ${daf.position + 1} of ${daf.masechta.dapim}</strong>
      <span class="cal-bar"><span style="width:${Math.round(((daf.position + 1) / daf.masechta.dapim) * 100)}%"></span></span>
      <span class="cal-tile-note">Siyum on ${siyum}</span>
    </div>`;
  const todayTile = `<button type="button" class="cal-tile cal-tile-today" data-go="${today}">
      <span class="cal-tile-label">Today's daf</span>
      <strong translate="no">${escapeHtml(dafTitle(daf))}</strong>
      <span class="cal-tile-note">${view.signedIn ? 'You are 42% through. Carry on' : 'See today\'s shiurim'} <span aria-hidden="true">›</span></span>
    </button>`;
  if (!view.signedIn) {
    $('calSummary').innerHTML = `${todayTile}${masechtaTile}
      <div class="cal-tile cal-tile-invite">
        <span class="cal-tile-label">Keep track</span>
        <strong>Sign in and the calendar fills itself in</strong>
        <span class="cal-tile-note">Every shiur you hear on DafSync is counted, line by line.</span>
      </div>`;
    return;
  }
  const outstanding = [];
  let streak = 0;
  let counting = true;
  for (let day = today - 1; day >= TRACKING_SINCE; day -= 1) {
    const state = sampleProgress(day).state;
    if (isOutstanding(state)) outstanding.push(day);
    // A day he learned on counts for the streak even if a few words are left.
    if (state === 'missed') counting = false;
    else if (counting) streak += 1;
  }
  const oldest = outstanding[outstanding.length - 1];
  const catchUp = outstanding.length
    ? `<button type="button" class="cal-tile cal-tile-catchup" data-go="${oldest}">
        <span class="cal-tile-label">To catch up</span>
        <strong>${outstanding.length} ${outstanding.length === 1 ? 'daf' : 'dapim'} not finished</strong>
        <span class="cal-tile-note">One extra a day and you are caught up in ${outstanding.length} days <span aria-hidden="true">›</span></span>
      </button>`
    : `<div class="cal-tile"><span class="cal-tile-label">Up to date</span><strong>Nothing outstanding</strong><span class="cal-tile-note">Every daf so far is done.</span></div>`;
  $('calSummary').innerHTML = `${todayTile}${catchUp}
    <div class="cal-tile">
      <span class="cal-tile-label">Streak</span>
      <strong>${streak} ${streak === 1 ? 'day' : 'days'} in a row</strong>
      <span class="cal-tile-note">Finish today's daf to make it ${streak + 1}.</span>
    </div>${masechtaTile}`;
}

// --- A day ---------------------------------------------------------------------------

const cache = new Map();
// Each file is fetched once. One that could not be fetched (the connection
// dropped) is not remembered as missing: the next look tries again.
function getJson(url) {
  if (!cache.has(url)) {
    cache.set(url, fetch(url)
      .then((response) => { if (!response.ok) throw new Error(String(response.status)); return response.json(); })
      .catch(() => { cache.delete(url); return null; }));
  }
  return cache.get(url);
}
// The site's line-by-line sync of a daf's shiur: MDY's, else R' Bornstein's.
const SYNC_KEYS = [['', ''], ['Voice-', ''], ['Voice-Bornstein-', '&maggid=bornstein'], ['Bornstein-', '&maggid=bornstein']];
async function syncFile(name, daf) {
  for (const [prefix, query] of SYNC_KEYS) {
    const file = await getJson(`/api/get-results-file?path=${encodeURIComponent(`by-ref/${prefix}${name.replace(/ /g, '-')}-${daf}a.json`)}&optional=1`);
    if (file?.segments?.length) return { ...file, query };
  }
  return null;
}

const MAGGID_NAMES = { default: "R' Eli Stefansky", bornstein: "R' Sruly Bornstein" };
const KINDS = [
  ['regularEn', 'English', ''], ['regularHe', 'Hebrew', '&language=hebrew'],
  ['chazarahEn', 'Chazarah, English', '&variant=chazarah'], ['chazarahHe', 'Chazarah, Hebrew', '&variant=chazarah&language=hebrew'],
];

// The shiurim the library has for a daf: [{ who, kind, title, url }].
async function shiurimFor(daf) {
  const catalog = await getJson('/api/get-catalog');
  if (!catalog) return [];
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

// The lines of the daf, in order, from the site's sync of this day's shiur and
// of the next day's (which is where a daf's last lines are usually read).
async function dafLines(daf) {
  if (!daf.masechta.onSite) return null;
  const [mine, next] = await Promise.all([syncFile(daf.masechta.name, daf.daf), daf.last ? null : syncFile(daf.masechta.name, daf.daf + 1)]);
  if (!mine?.segments?.length) return null;
  const lines = new Map();
  const take = (file, from) => {
    for (const segment of file?.segments || []) {
      const match = new RegExp(`^${daf.masechta.name} ${daf.daf}([ab])[:.](\\d+)$`).exec(segment.ref || '');
      if (!match || !Number.isInteger(segment.w0)) continue;
      const key = `${match[1]}:${match[2]}:${segment.w0}`;
      if (lines.has(key)) continue;
      lines.set(key, {
        amud: match[1], paragraph: Number(match[2]), w0: segment.w0, words: Math.max(1, (segment.w1 ?? segment.w0) - segment.w0 + 1),
        text: segment.he || '', start: Number(segment.start) || 0, from,
      });
    }
  };
  take(mine, 'today');
  take(next, 'next');
  const sorted = [...lines.values()].sort((x, y) => x.amud.localeCompare(y.amud) || x.paragraph - y.paragraph || x.w0 - y.w0);
  // The next shiur's lines count as "read in the next shiur" only past where
  // this day's shiur stops; before that they are lines of this shiur's stretch.
  let end = -1;
  sorted.forEach((line, index) => { if (line.from === 'today') end = index; });
  sorted.forEach((line, index) => { if (index < end) line.from = 'today'; });
  sorted.query = mine.query || '';
  return sorted;
}

// Sample: which of the daf's lines were heard, for the day's state.
function sampleHeard(lines, progress) {
  const mine = lines.filter((line) => line.from === 'today');
  const upTo = Math.floor(mine.length * (progress.fraction ?? 0));
  const lastMine = mine[mine.length - 1];
  const marked = lines.map((line) => {
    if (progress.state === 'done' || progress.state === 'marked') return { ...line, mark: 'heard' };
    if (progress.state === 'missed') return { ...line, mark: 'open' };
    if (progress.state === 'gap') return { ...line, mark: line === lastMine ? 'gap' : 'heard' };
    const index = mine.indexOf(line);
    if (index >= 0) return { ...line, mark: index < upTo ? 'heard' : 'open' };
    return { ...line, mark: 'later' };            // read in the next shiur: not yet due
  });
  marked.query = lines.query || '';
  return marked;
}

// Lines next to each other that stand alike, as one stretch: [{ mark, words }].
function runs(lines) {
  const out = [];
  for (const line of lines) {
    const last = out[out.length - 1];
    if (last && last.mark === line.mark) last.words += line.words;
    else out.push({ mark: line.mark, words: line.words });
  }
  return out;
}

// The printed line a word of the daf is on, counted down the Gemara's column
// of the Vilna page: the site knows where every word is printed (the page's
// word map), and words at one height are one line. { line, of } or null.
async function printedLine(daf, line) {
  const map = await getJson(`/api/get-results-file?path=${encodeURIComponent(`pages/${daf.masechta.name.replace(/ /g, '-')}-${daf.daf}${line.amud}.json`)}&optional=1`);
  const boxes = (map?.wordBoxes || []).filter((box) => Number.isFinite(box.y) && Number.isFinite(box.h));
  if (!boxes.length) return null;
  const rows = [];
  for (const box of [...boxes].sort((a, b) => a.y - b.y)) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(box.y - row.y) < box.h * 0.6) { row.boxes.push(box); row.y = (row.y * (row.boxes.length - 1) + box.y) / row.boxes.length; }
    else rows.push({ y: box.y, boxes: [box] });
  }
  const wanted = `${daf.masechta.name} ${daf.daf}${line.amud}:${line.paragraph}`;
  const index = rows.findIndex((row) => row.boxes.some((box) => box.ref === wanted && box.wordIndex === line.w0));
  return index < 0 ? null : { line: index + 1, of: rows.length };
}

function dafMap(lines) {
  const row = (amud) => {
    const mine = lines.filter((line) => line.amud === amud);
    if (!mine.length) return '';
    return `<div class="cal-map-row"><span class="cal-map-amud" translate="no">${amud === 'a' ? (HE ? 'ע״א' : 'Amud a') : (HE ? 'ע״ב' : 'Amud b')}</span>
      <span class="cal-map-bar">${runs(mine).map((run) => `<span class="cal-map-line is-${run.mark}" style="flex-grow:${run.words}"></span>`).join('')}</span></div>`;
  };
  return `<div class="cal-map" aria-hidden="true">${row('a')}${row('b')}</div>`;
}

async function renderDay() {
  const day = view.selected;
  const panel = $('calDay');
  const daf = dafYomiOfDay(day);
  if (!daf) { panel.innerHTML = ''; return; }
  const progress = sampleProgress(day);
  const hebrew = hebrewDate(day);
  const label = dafLabel(daf);
  const head = `<button type="button" class="cal-day-close" id="calDayClose" aria-label="Close">×</button>
    <div class="cal-day-date">${LONG_DATE.format(asDate(day))} <span class="cal-day-hdate">· ${hebrew.day} ${escapeHtml(hebrew.month)} ${hebrew.year}</span></div>
    <h2 class="cal-day-title" translate="no">${escapeHtml(label.name)} <span>${label.number}</span>${HE ? '' : `<span class="cal-day-he" lang="he" dir="rtl">${escapeHtml(daf.masechta.hebrew)} ${hebrewNumeral(daf.daf)}</span>`}</h2>
    <div class="cal-day-where">Daf ${daf.position + 1} of ${daf.masechta.dapim} in ${escapeHtml(label.name)}${daf.last ? ' · <strong>Siyum</strong>' : ''}</div>`;
  panel.className = `cal-day is-open is-${progress.state} mas-${daf.masechtaIndex % 6}`;
  panel.innerHTML = `${head}<div class="cal-day-body"><p class="cal-day-loading">Loading this daf…</p></div>`;
  $('calDayClose').addEventListener('click', closeDay);

  const [lines, shiurim] = await Promise.all([dafLines(daf), daf.masechta.onSite ? shiurimFor(daf) : []]);
  if (view.selected !== day) return;                       // another day was chosen meanwhile
  const heard = lines && view.signedIn && !['future', 'before'].includes(progress.state) ? sampleHeard(lines, progress) : null;
  const playerUrl = `/player/?ref=${encodeURIComponent(`${daf.masechta.name} ${daf.daf}a`)}${heard?.query || ''}`;

  let status = '';
  if (view.signedIn) {
    const openLine = heard?.find((line) => line.mark === 'open' || line.mark === 'gap');
    const printed = openLine ? await printedLine(daf, openLine) : null;
    if (view.selected !== day) return;
    const amudWord = openLine ? `amud ${openLine.amud}` : '';
    const where = printed ? `line ${printed.line} of ${amudWord}` : amudWord;
    const jump = openLine ? `${playerUrl}&t=${Math.max(0, Math.floor(openLine.start))}` : playerUrl;
    const quote = openLine?.text ? `<span class="cal-quote" lang="he" dir="rtl" translate="no">${escapeHtml(openLine.text)}…</span>` : '';
    if (progress.state === 'done') {
      status = `<div class="cal-state"><span class="cal-state-ring">${ring(progress, 44)}</span><div><strong>Done</strong><span>You heard this daf through.</span></div></div>`;
    } else if (progress.state === 'marked') {
      status = `<div class="cal-state"><span class="cal-state-ring">${ring(progress, 44)}</span><div><strong>Done</strong><span>You marked it as learned.</span></div></div>`;
    } else if (progress.state === 'gap') {
      const words = openLine?.words || 8;
      status = `<div class="cal-state"><span class="cal-state-ring">${ring(progress, 44)}</span><div><strong>${words} words still to hear</strong><span>The shiur you finished stopped before the end of the daf, and the next shiur you heard began ${words} words further on${printed ? ` (line ${printed.line} of ${amudWord})` : ''}.</span></div></div>
        <a class="cal-primary" href="${jump}">Hear the ${words} words${quote}</a>`;
    } else if (progress.state === 'partial') {
      status = `<div class="cal-state"><span class="cal-state-ring">${ring(progress, 44)}</span><div><strong>${Math.round(progress.fraction * 100)}% heard</strong><span>${openLine ? `You are up to ${where}.` : 'You stopped partway through the shiur.'}</span></div></div>
        <a class="cal-primary" href="${jump}">${printed ? `Continue from line ${printed.line}` : (openLine ? 'Continue from here' : 'Continue the shiur')}${quote}</a>`;
    } else if (progress.state === 'missed') {
      status = `<div class="cal-state"><span class="cal-state-ring">${ring(progress, 44)}</span><div><strong>Not learned yet</strong><span>Nothing heard on this daf.</span></div></div>
        <a class="cal-primary" href="${playerUrl}">Start this daf</a>`;
    } else if (progress.state === 'future') {
      status = `<div class="cal-state is-plain"><div><strong>${day === today + 1 ? 'Tomorrow' : 'Coming up'}</strong><span>${daf.masechta.onSite ? 'Shiurim appear here as they are published.' : ''}</span></div></div>`;
    } else {
      status = '<div class="cal-state is-plain"><div><strong>Before you began tracking</strong><span>Mark it as learned if you did it.</span></div></div>';
    }
  }

  const map = heard ? `<div class="cal-section"><h3>The daf, line by line</h3>${dafMap(heard)}
      <div class="cal-map-key"><span class="is-heard">Heard</span><span class="is-open">Not yet</span>${heard.some((l) => l.mark === 'gap') ? '<span class="is-gap">Outstanding</span>' : ''}${heard.some((l) => l.mark === 'later') ? '<span class="is-later">Read in the next shiur</span>' : ''}</div></div>`
    : (view.signedIn && daf.masechta.onSite && !['future', 'before'].includes(progress.state)
      ? '<div class="cal-section"><p class="cal-quiet">This daf\'s shiur is not synced line by line yet, so it is tracked by how much of the shiur you heard.</p></div>' : '');

  const list = shiurim.length
    ? `<div class="cal-section"><h3>Shiurim</h3><div class="cal-shiurim">${shiurim.map((shiur, index) => {
      const part = view.signedIn && !['future', 'before', 'missed'].includes(progress.state) && index === 0 ? Math.round((progress.fraction ?? 0) * 100) : 0;
      return `<a class="cal-shiur" href="${shiur.url}">
        <span class="cal-shiur-play" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg></span>
        <span class="cal-shiur-text"><strong translate="no">${escapeHtml(shiur.who)} · ${escapeHtml(shiur.kind)}</strong>
          <span>${view.signedIn ? (part >= 100 ? 'Heard through' : part > 0 ? `${part}% heard` : 'Not started') : escapeHtml(shiur.title)}</span></span>
        ${view.signedIn && part > 0 ? `<span class="cal-bar"><span style="width:${Math.min(100, part)}%"></span></span>` : ''}
      </a>`;
    }).join('')}</div></div>`
    : `<div class="cal-section"><p class="cal-quiet">${daf.masechta.onSite ? (day > today ? 'No shiur published for this daf yet.' : 'No shiur linked for this daf yet.') : `DafSync has no shiurim on ${escapeHtml(label.name)} yet.`}</p></div>`;

  const actions = `<div class="cal-actions">
      ${view.signedIn && day <= today && !['done', 'marked'].includes(progress.state) ? '<button type="button" class="cal-secondary" data-sample>Mark as learned</button>' : ''}
      ${view.signedIn && progress.state === 'marked' ? '<button type="button" class="cal-secondary" data-sample>Unmark</button>' : ''}
      ${daf.masechta.onSite ? `<a class="cal-secondary" href="/browse/?ref=${encodeURIComponent(`${daf.masechta.name} ${daf.daf}a`)}">Open the daf</a>` : ''}
      ${!view.signedIn ? '<button type="button" class="cal-secondary" data-signin>Sign in to keep track</button>' : ''}
    </div>`;

  panel.querySelector('.cal-day-body').innerHTML = `${status}${map}${list}${actions}`;
  panel.querySelectorAll('[data-sample]').forEach((button) => button.addEventListener('click', () => {
    button.textContent = 'Sample data: nothing is saved in the preview';
    button.disabled = true;
  }));
  panel.querySelector('[data-signin]')?.addEventListener('click', () => $('signInButton')?.click());
}

function closeDay() {
  $('calDay').classList.remove('is-open');
  document.body.classList.remove('cal-sheet-open');
}

function selectDay(day, { open = true } = {}) {
  view.selected = day;
  const date = dateOfDay(day);
  if (date.year !== view.year || date.month !== view.month) {
    view.year = date.year;
    view.month = date.month;
  }
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
document.querySelectorAll('[data-preview]').forEach((button) => button.addEventListener('click', () => {
  view.signedIn = button.dataset.preview === 'in';
  document.querySelectorAll('[data-preview]').forEach((other) => other.setAttribute('aria-pressed', String(other === button)));
  document.body.classList.toggle('cal-signed-out', !view.signedIn);
  renderMonth();
  renderDay();
}));
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeDay(); });

renderMonth();
// On a computer today's daf is open beside the month from the start; a phone
// shows the month alone until a day is tapped.
renderDay();
if (window.matchMedia('(max-width: 900px)').matches) closeDay();
