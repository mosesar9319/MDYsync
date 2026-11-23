// The Daf Yomi tracker's ears: keeps what a signed-in learner hears of each
// shiur, for the calendar (calendar/) to show which dapim are done, which are
// part done and up to which line.
//
// While a shiur plays, the stretches of the recording actually heard are
// noted -- playing through counts, jumping with the seek bar does not -- and
// saved to the learner's own `learning` row for that shiur every little
// while, with the words of the daf those stretches cover (worked out by
// shared/daf-progress.mjs from the shiur's sync). What was heard earlier, on
// this device or another, is added to rather than replaced.
//
// Nothing is kept for a visitor who is not signed in.
//
// A classic deferred script after app.js, sharing its top-level bindings
// (state, parseDafRef, getCurrentTime, getDuration, isPaused) the way
// account-features.js does.
'use strict';

(() => {
  const TICK_MS = 1000;
  const SAVE_MS = 20000;
  // Less than this heard of a shiur is a look, not learning.
  const WORTH_SAVING_SECONDS = 20;
  // A row holds at most this many separate stretches.
  const MOST_RANGES = 240;

  let progress = null;
  import('/shared/daf-progress.mjs').then((module) => { progress = module; }).catch(() => { /* no tracking this visit */ });

  // The shiur being followed:
  //   { key, tractate, daf, maggid, variant, language, user,
  //     ranges (this visit's stretches), run (the stretch being heard now),
  //     at, wall (the last time seen, and when), segments, duration,
  //     earlier (what the row already held; null until read), finishedAt,
  //     dirty, savedAt }
  let now = null;

  const auth = () => window.DafSyncAuth;
  const userId = () => auth()?.getUser?.()?.id || null;

  // Which shiur is on: its maggid, language, kind and daf. The amud the page
  // was opened at does not matter -- a shiur on daf 6 is one shiur.
  function shiurOn() {
    if (!state.dafRef) return null;
    const parsed = parseDafRef(state.dafRef);
    if (!parsed) return null;
    const maggid = parsed.maggid || 'default';
    const variant = parsed.variant === 'chazarah' ? 'chazarah' : 'regular';
    const language = parsed.language === 'he' ? 'he' : 'en';
    return { key: `${maggid}:${language}:${variant}:${parsed.tractate}:${parsed.daf}`, tractate: parsed.tractate, daf: parsed.daf, maggid, variant, language };
  }

  // The lines of this shiur's sync, with plain refs ("Arakhin 6a:3"). A list
  // still on screen from the daf before (the next one is loading) is not this
  // shiur's: a shiur reads its own daf and at most the dapim beside it.
  function linesOf(shiur) {
    const lines = [];
    for (const segment of state.segments || []) {
      const parsed = segment && parseDafRef(segment.ref);
      const n = /[:.](\d+)$/.exec(String(segment?.ref || ''));
      if (!parsed || !n || parsed.tractate !== shiur.tractate || Math.abs(parsed.daf - shiur.daf) > 1) continue;
      lines.push({ ref: `${parsed.tractate} ${parsed.daf}${parsed.amud}:${n[1]}`, start: segment.start, end: segment.end, w0: segment.w0, w1: segment.w1, estimated: Boolean(segment.estimated) });
    }
    return lines;
  }

  function begin(shiur, user) {
    now = { ...shiur, user, ranges: [], run: null, at: null, wall: 0, segments: [], duration: 0, earlier: null, finishedAt: null, dirty: false, savedAt: Date.now() };
    const mine = now;
    auth().client.from('learning').select('ranges, finished_at')
      .eq('user_id', user).eq('shiur_key', shiur.key).maybeSingle()
      .then(({ data, error }) => {
        if (error) return;                    // stays unread: nothing is saved over a row that could not be read
        mine.earlier = Array.isArray(data?.ranges) ? data.ranges : [];
        mine.finishedAt = data?.finished_at || null;
      }, () => {});
  }

  function tick() {
    const user = userId();
    const shiur = user ? shiurOn() : null;
    if (!shiur) { save(); now = null; return; }
    if (!now || now.key !== shiur.key || now.user !== user) { save(); begin(shiur, user); }

    const time = Number(getCurrentTime());
    if (isPaused() || !Number.isFinite(time)) {
      if (now.run) save();
      now.run = null;
      now.at = null;
      return;
    }
    now.segments = linesOf(shiur);
    now.duration = Number(getDuration()) || now.duration;
    // Playing on from where it was -- not a jump with the seek bar. The page
    // may have slept between two looks (a phone with its screen off), so how
    // far the shiur may have moved goes by the clock on the wall.
    const waited = (performance.now() - now.wall) / 1000;
    const moved = now.at === null ? null : time - now.at;
    const playedOn = moved !== null && moved >= -0.5 && moved <= waited * 3.2 + 1.5;
    if (now.run && playedOn) {
      now.run[1] = Math.max(now.run[1], time);
    } else {
      now.run = [time, time];
      now.ranges.push(now.run);
    }
    if (moved !== 0) now.dirty = true;
    now.at = time;
    now.wall = performance.now();
    if (Date.now() - now.savedAt >= SAVE_MS) save();
  }

  function save() {
    const shiur = now;
    if (!shiur || !shiur.dirty || !progress || shiur.earlier === null || userId() !== shiur.user) return;
    let ranges = progress.mergeRanges([...shiur.earlier, ...shiur.ranges], 0.75);
    const heardSeconds = ranges.reduce((sum, [from, to]) => sum + (to - from), 0);
    if (heardSeconds < WORTH_SAVING_SECONDS) return;
    // Many short stretches are joined, the nearest first, until they fit.
    for (let gap = 2; ranges.length > MOST_RANGES; gap *= 2) ranges = progress.mergeRanges(ranges, gap);
    ranges = ranges.map(([from, to]) => [Math.round(from * 10) / 10, Math.round(to * 10) / 10]);

    const coverage = progress.shiurCoverage(shiur.segments, ranges);
    const finished = coverage.synced ? coverage.finished : progress.heardMostOf(ranges, shiur.duration);
    if (finished && !shiur.finishedAt) shiur.finishedAt = new Date().toISOString();
    shiur.dirty = false;
    shiur.savedAt = Date.now();
    auth().client.from('learning').upsert({
      user_id: shiur.user,
      shiur_key: shiur.key,
      tractate: shiur.tractate,
      daf: shiur.daf,
      maggid: shiur.maggid,
      variant: shiur.variant,
      language: shiur.language,
      position_seconds: shiur.at ?? ranges[ranges.length - 1][1],
      duration_seconds: shiur.duration || null,
      ranges,
      heard: coverage.heard,
      reads: coverage.reads,
      words: coverage.words,
      finished,
      finished_at: finished ? shiur.finishedAt : null,
      manual: false,
      updated_at: new Date().toISOString(),
    }).then(({ error }) => {
      if (error) { shiur.dirty = true; console.error('Could not save what was learned.', error); }
    }, () => { shiur.dirty = true; });
  }

  setInterval(tick, TICK_MS);
  window.addEventListener('pagehide', save);
  document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });
  // For the tests, and for anything that wants the row written now.
  window.dafLearningTracker = { tick, save, shiur: () => now };
})();
