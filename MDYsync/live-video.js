// Live Follow's video-link helpers, kept free of the DOM and of the network so
// Node can test them (tests/functions/live-video.test.mjs).
//
//   parseVideoLink     what a pasted link is: a YouTube video, a direct media
//                      file, or something Live Follow can't play.
//   wordsToSegments    a word-timed transcript (ElevenLabs' batch output) cut
//                      into phrases at the pauses.
//   alignSegments      those phrases placed on the daf, one after another, by
//                      the very tracker the microphone modes use -> a timeline
//                      of "at this second the reading is at these words".
//   positionAt         the timeline looked up by the video's playhead, so
//                      seeking forwards or back just works.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LiveVideo = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com']);
  const MEDIA_EXTENSIONS = /\.(mp4|m4v|webm|mov|mp3|m4a|aac|wav|ogg|oga|opus|flac)$/i;
  const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

  // "90", "90s", "1m30s", "1h2m3s" -> seconds; anything else -> 0.
  function parseStartTime(value) {
    if (!value) return 0;
    if (/^\d+$/.test(value)) return Number(value);
    const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i.exec(value);
    if (!m || (!m[1] && !m[2] && !m[3])) return 0;
    return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
  }

  function parseVideoLink(input) {
    let text = String(input ?? '').trim();
    if (!text) return null;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = `https://${text}`;
    let url;
    try { url = new URL(text); } catch { return null; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const host = url.hostname.toLowerCase();

    let id = null;
    if (host === 'youtu.be') {
      id = url.pathname.split('/')[1] || null;
    } else if (YOUTUBE_HOSTS.has(host)) {
      id = url.searchParams.get('v');
      if (!id) {
        const m = /^\/(?:embed|shorts|live|v)\/([^/?#]+)/.exec(url.pathname);
        id = m ? m[1] : null;
      }
    }
    if (id !== null || host === 'youtu.be' || YOUTUBE_HOSTS.has(host)) {
      if (!id || !VIDEO_ID.test(id)) return null;
      return {
        kind: 'youtube',
        id,
        // The canonical form: what is sent for transcription and what is shown.
        url: `https://www.youtube.com/watch?v=${id}`,
        startSeconds: parseStartTime(url.searchParams.get('t') || url.searchParams.get('start')),
      };
    }
    if (url.protocol === 'https:' && MEDIA_EXTENSIONS.test(url.pathname)) {
      return { kind: 'media', url: url.toString(), startSeconds: 0 };
    }
    return null;
  }

  // A pause this long ends a phrase; so do this many words, or this many
  // seconds -- the same order of size as the realtime model's own commits.
  const GAP_SECONDS = 0.7;
  const MAX_WORDS = 14;
  const MAX_SECONDS = 9;

  // words: [{ text, start, end }] in seconds, in order.
  function wordsToSegments(words, options = {}) {
    const gap = options.gapSeconds ?? GAP_SECONDS;
    const maxWords = options.maxWords ?? MAX_WORDS;
    const maxSeconds = options.maxSeconds ?? MAX_SECONDS;
    const segments = [];
    let current = null;
    const close = () => {
      if (current) segments.push({ start: current.start, end: current.end, text: current.words.join(' ') });
      current = null;
    };
    for (const word of words) {
      const text = String(word.text ?? '').trim();
      if (!text || !Number.isFinite(word.start)) continue;
      const end = Number.isFinite(word.end) ? word.end : word.start;
      if (current && (word.start - current.end >= gap || current.words.length >= maxWords || end - current.start > maxSeconds)) close();
      if (!current) current = { start: word.start, end, words: [] };
      current.words.push(text);
      current.end = Math.max(current.end, end);
    }
    close();
    return segments;
  }

  // Places each phrase on the daf the way live-follow.js's handleCommitted does --
  // cleanTranscript, Hebrew runs, tracker.step -- so a phrase that places
  // live places here too. `startIndex` (a tapped word) locks the tracker
  // there first. Entries:
  //   { start, end, text, state: 'read',      s, e, phon, char }  placed
  //   { start, end, text, state: 'explain' }  no Hebrew: English explanation
  //   { start, end, text, state: 'unplaced' } Hebrew the daf couldn't take
  //   { start, end, text, state: 'hold' }     a lone fragment: says nothing
  function alignSegments(LM, canon, segments, options = {}) {
    const tracker = options.tracker || LM.createTracker(canon, { eagerRelocalize: true });
    if (options.startIndex !== undefined && options.startIndex !== null) tracker.anchor(options.startIndex);
    const listTokens = options.listTokens || [];
    let runCounter = options.runCounter || 0;
    const timeline = [];
    for (const segment of segments) {
      const heard = LM.cleanTranscript(segment.text, listTokens, options.leakMinRun);
      const allRuns = LM.splitHebrewRuns(heard).flatMap((run) => LM.chunkRun(run));
      const runs = allRuns.filter((run) => run.length >= LM.PLACEABLE_RUN_MIN_WORDS);
      const latinWords = heard.split(/\s+/).filter((token) => /[A-Za-z]/.test(token)).length;
      const bareFragment = !runs.length && allRuns.length > 0 && latinWords < 2;
      let placed = null;
      for (const run of runs) {
        const result = tracker.step(run, runCounter);
        runCounter += 1;
        if (result.kind === 'local' || result.kind === 'confirmed' || result.kind === 'jump') placed = result.match;
      }
      const entry = { start: segment.start, end: segment.end, text: segment.text };
      if (placed) {
        Object.assign(entry, {
          state: 'read', s: placed.s, e: placed.e, phon: +placed.phonScore.toFixed(1), char: +placed.charScore.toFixed(1),
        });
      } else if (bareFragment) {
        entry.state = 'hold';
      } else if (!runs.length) {
        entry.state = 'explain';
      } else {
        entry.state = 'unplaced';
      }
      timeline.push(entry);
    }
    return { timeline, tracker, runCounter };
  }

  // The latest entry that has started by time t: index into the timeline, or
  // -1 before the first.
  function indexAt(timeline, t) {
    let lo = 0;
    let hi = timeline.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (timeline[mid].start <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return found;
  }

  // Where the reading is at time t: the current phrase's state, and the words
  // the highlight should be on -- the latest placed phrase at or before t, so
  // it holds through English explanation exactly as the live modes do.
  // `unplacedRun` counts the consecutive Hebrew-but-unplaced phrases just
  // before t, which is what the "tap the word" hint hangs off.
  function positionAt(timeline, t) {
    const i = indexAt(timeline, t);
    if (i < 0) return { state: 'before', placement: null, index: -1, unplacedRun: 0 };
    let effective = timeline[i].state;
    let k = i;
    while (effective === 'hold' && k > 0) { k -= 1; effective = timeline[k].state; }
    let placement = null;
    for (let j = i; j >= 0; j -= 1) {
      if (timeline[j].state === 'read') { placement = { s: timeline[j].s, e: timeline[j].e, phon: timeline[j].phon, char: timeline[j].char, index: j }; break; }
    }
    let unplacedRun = 0;
    for (let j = i; j >= 0 && (timeline[j].state === 'unplaced' || timeline[j].state === 'hold'); j -= 1) {
      if (timeline[j].state === 'unplaced') unplacedRun += 1;
    }
    return { state: effective === 'hold' ? 'before' : effective, placement, index: i, unplacedRun };
  }

  return { parseVideoLink, parseStartTime, wordsToSegments, alignSegments, indexAt, positionAt, GAP_SECONDS, MAX_WORDS, MAX_SECONDS };
}));
