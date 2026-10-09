'use strict';

// Live Follow's phrase matcher -- a JavaScript port of the deterministic
// matching core of tools/caption-sync/voice_align.py (match_phrase_dual,
// match_runs' lock/relocalize/confirm state machine, hebrew_script_runs,
// build_keyterm_list) and the normalize_word/load_canonical pieces it
// borrows from caption_ocr_align.py. Pure functions, no DOM: loaded as a
// plain <script> by the Interactive Daf page's live follow (live-follow.js; exposed as window.LiveMatcher) and require()d
// directly by tests/functions/live-matcher.test.mjs.
//
// Ported line-for-line rather than re-derived, so the two implementations
// can't quietly disagree: tests/fixtures/live-matcher-parity.json holds
// results computed by the real Python code (regenerate it with
// tools/caption-sync/gen_live_matcher_parity.py whenever the Python matcher
// changes), and the test suite also reads voice_align.py's constants
// straight out of its source and fails if they drift from the copies here.
//
// Deliberately NOT ported: LLM rescue and refine_matches' retrospective
// gap-filling (V1 measures how far deterministic matching alone gets live),
// and the >2s word-gap run split (realtime transcripts arrive without
// per-word timestamps; each VAD-committed utterance is treated as its own
// run boundary instead -- see splitHebrewRuns).
//
// Live-only additions, both opt-in so matchRuns() keeps exact batch parity:
//   - eagerRelocalize: batch only searches globally after RELOCALIZE_AFTER
//     (12) consecutive local misses, fine offline but far too slow for a
//     maggid shiur saying "let's go back four lines" live. With this on, a
//     local miss while locked also tries a global search -- but a far match
//     is only ever held as pending, and committed only when the next run
//     corroborates it, the same two-agreeing-matches rule batch uses for
//     any fresh lock. A one-off decoy elsewhere in the daf still can't move
//     the highlight.
//   - chunkRun: realtime has no gap-based run splitting, so one committed
//     utterance can be a long stretch of continuous reading; splitting it
//     into short consecutive chunks lets the highlight advance through it,
//     and bounds the cost of each search.
//   - createPreview: follows the reading from PARTIAL transcripts with its
//     own cursor, so the highlight keeps pace between (and through) commits
//     instead of waiting for ElevenLabs to commit an utterance -- measured
//     against the real API on a continuous reading, commit-driven
//     highlighting trailed the voice by a median 9s; the preview brings it
//     to under a second. Display-only: it never moves the tracker.
//   - Decisive jumps: batch only trusts a far match once a second phrase
//     agrees; live also trusts ONE phrase of 6+ words that matches well and
//     is clearly the best place on the whole daf (a phrase that repeats on
//     the daf is not). That is what lets a fresh session lock from its first
//     phrase, and a reading that resumes beyond the +60-word window be
//     followed at once instead of a whole utterance later.
//   - tracker.anchor(): the reader points at the word being read.
//   - cleanTranscript: strips what the speech service hallucinates when the
//     audio goes quiet -- a recitation of the keyterm list it was given, or a
//     word stuck on repeat -- before any matching sees it.
//   - Lone words are never placed (PLACEABLE_RUN_MIN_WORDS) and previews need
//     3+ words: ElevenLabs writes Hebrew terms spoken inside English
//     ("Gemara") in Hebrew letters, and one word matches somewhere beside
//     almost any cursor.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LiveMatcher = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // --- Constants mirrored from voice_align.py (checked by the test suite) --
  const BACK_WINDOW = 15;
  const FWD_WINDOW = 60;
  const MIN_SCORE = 60;
  const MIN_SCORE_GLOBAL = 72;
  const MIN_SCORE_SINGLE = 85;
  const CHAR_FLOOR = 55;
  const RELOCALIZE_AFTER = 12;
  const PHONETIC_CLASSES = [['A', 'אעה'], ['Y', 'וי'], ['K', 'כחק'], ['T', 'תט']];
  const COMMON_GEMARA_TERMS = [
    'תא שמע', 'איתמר', 'תניא', 'מתניתין', 'גמרא', 'אמר מר', 'מאי טעמא',
    'והתניא', 'אמר רבא', 'אמר אביי', 'בעי מיניה', 'איבעיא להו',
  ];
  const KEYTERM_STOPWORDS = new Set([
    'של', 'את', 'על', 'אל', 'כי', 'לא', 'הוא', 'היא', 'זה', 'מה',
    'לו', 'בו', 'כן', 'עד', 'גם', 'רק', 'כל', 'יש', 'אין', 'אם',
  ]);

  // --- Live-only constants ---------------------------------------------------
  // Short enough that a long utterance advances the highlight several times
  // and a global search stays a few tens of milliseconds even on a full daf;
  // long enough to stay well clear of the lone-word ambiguity
  // MIN_SCORE_SINGLE exists for.
  const LIVE_MAX_RUN_WORDS = 10;
  // Live only: a committed run shorter than this is never placed. Batch will
  // place a single word (MIN_SCORE_SINGLE), but live, a lone Hebrew word is
  // usually a term inside English speech -- or a one-word fragment of a
  // reading the voice detector split -- and placing it moves the tracker's
  // position to wherever that word happens to occur next to the cursor.
  const PLACEABLE_RUN_MIN_WORDS = 2;
  // In a mostly-English sentence, a run of Hebrew shorter than this is a TERM
  // the speaker dropped in ("הלכה", "מחוסר זמן"), not a reading of the daf: it is
  // never placed. Measured on a real 51-minute English shiur: 115 of the 170
  // placements were such terms, matched to wherever the same words occur on the
  // daf (one pair of words 15 times), and they moved the highlight around.
  const ENGLISH_CONTEXT_MIN_RUN_WORDS = 4;
  // To move a locked position FAR (beyond MAX_SINGLE_JUMP_WORDS) on two agreeing
  // phrases, each must be at least this long, and they must be different phrases:
  // two short terms, or the same words said twice, are not evidence of a move.
  const FAR_CONFIRM_MIN_WORDS = 4;
  const PROVISIONAL_TAIL_WORDS = 6;
  // ElevenLabs' realtime limits (batch Scribe allows far more).
  const REALTIME_MAX_KEYTERMS = 50;
  const REALTIME_MAX_KEYTERM_CHARS = 20;

  const phoneticTable = new Map();
  for (const [symbol, letters] of PHONETIC_CLASSES) {
    for (const ch of letters) phoneticTable.set(ch, symbol);
  }

  // caption_ocr_align.normalize_word: NFKD, strip nikud/taamim/maqaf
  // (U+0591-U+05C7), then anything that isn't a Hebrew base letter.
  function normalizeWord(word) {
    return String(word || '')
      .normalize('NFKD')
      .replace(/[֑-ׇ]/g, '')
      .replace(/[^א-ת]/g, '');
  }

  function phonetic(norm) {
    let out = '';
    for (const ch of norm) out += phoneticTable.get(ch) || ch;
    return out;
  }

  // rapidfuzz's fuzz.ratio: Indel normalized similarity * 100, computed
  // with the same floating-point operations so scores match bit-for-bit.
  let lcsPrev = new Uint16Array(64);
  let lcsCurr = new Uint16Array(64);
  function lcsLength(a, b) {
    if (a.length < b.length) { const t = a; a = b; b = t; }
    const n = b.length;
    if (!n) return 0;
    if (lcsPrev.length < n + 1) {
      lcsPrev = new Uint16Array(n + 1);
      lcsCurr = new Uint16Array(n + 1);
    }
    let prev = lcsPrev;
    let curr = lcsCurr;
    prev.fill(0, 0, n + 1);
    curr[0] = 0;
    for (let i = 0; i < a.length; i += 1) {
      const ca = a.charCodeAt(i);
      for (let j = 1; j <= n; j += 1) {
        if (ca === b.charCodeAt(j - 1)) curr[j] = prev[j - 1] + 1;
        else curr[j] = prev[j] > curr[j - 1] ? prev[j] : curr[j - 1];
      }
      const t = prev; prev = curr; curr = t;
    }
    return prev[n];
  }

  function ratio(a, b) {
    const lensum = a.length + b.length;
    if (!lensum) return 100;
    const dist = lensum - 2 * lcsLength(a, b);
    return (1 - dist / lensum) * 100;
  }

  // match_phrase_dual iterates `for size in {k - 1, k, k + 1}` -- a Python
  // set, so on an exact score tie between two window sizes the winner is
  // whichever CPython's hash table yields first, not the smallest. For
  // these (at most three, consecutive, small, non-negative) ints that is
  // ascending order of (value & 7): no collisions are possible in the
  // 8-slot initial table. e.g. k=8 iterates 8, 9, 7.
  function pythonSizeOrder(k) {
    const sizes = [...new Set([Math.max(1, k - 1), k, k + 1])];
    return sizes.sort((x, y) => (x & 7) - (y & 7));
  }

  // One segment's whitespace tokens, exactly as load_canonical splits them.
  // Exported so a page rendering the daf walks the very same tokens, and its
  // Nth Hebrew-bearing token is always canon word N.
  function segmentTokens(he) {
    return String(he || '').replace(/<[^>]+>/g, '').split(/\s+/).filter(Boolean);
  }

  // caption_ocr_align.load_canonical's word-building half, over segments
  // already fetched: [{ ref, he }]. Keeps every word with a non-empty
  // normalized form, plus prefix offsets so any window's concatenated
  // string is an O(1) slice instead of a fresh join per candidate.
  function buildCanon(segments) {
    const words = [];
    segments.forEach((segment, segIndex) => {
      segmentTokens(segment.he).forEach((text, wordIndex) => {
        const norm = normalizeWord(text);
        if (norm) words.push({ ref: segment.ref, segIndex, wordIndex, text, norm, phon: phonetic(norm) });
      });
    });
    const normOffsets = new Int32Array(words.length + 1);
    const phonOffsets = new Int32Array(words.length + 1);
    words.forEach((w, i) => {
      normOffsets[i + 1] = normOffsets[i] + w.norm.length;
      phonOffsets[i + 1] = phonOffsets[i] + w.phon.length;
    });
    const normConcat = words.map((w) => w.norm).join('');
    const phonConcat = words.map((w) => w.phon).join('');
    return {
      words,
      length: words.length,
      normSlice: (s, e) => normConcat.slice(normOffsets[s], normOffsets[e]),
      phonSlice: (s, e) => phonConcat.slice(phonOffsets[s], phonOffsets[e]),
    };
  }

  // voice_align.match_phrase_dual. Returns { s, e, phonScore, charScore }
  // (inclusive word indices) or null.
  function matchPhraseDual(canon, hlNorm, hlPhon, cursor, options = {}) {
    const phonPhrase = hlPhon.join('');
    if (!phonPhrase) return null;
    const k = hlPhon.length;
    const globalSearch = Boolean(options.global);
    const window = options.window || null;
    let lo;
    let hi;
    if (window) {
      [lo, hi] = window;
      if (hi <= lo) return null;
    } else if (globalSearch) {
      if (k < 2) return null;
      lo = 0;
      hi = canon.length;
    } else {
      lo = Math.max(0, cursor - BACK_WINDOW);
      hi = Math.min(canon.length, cursor + FWD_WINDOW);
    }
    let best = null;
    for (const size of pythonSizeOrder(k)) {
      const end = Math.max(lo, hi - size + 1);
      for (let s = lo; s < end; s += 1) {
        let score = ratio(phonPhrase, canon.phonSlice(s, s + size));
        if (!globalSearch && !window) score -= Math.abs(s - cursor) * 0.15;
        if (best === null || score > best.score) best = { s, e: s + size - 1, score };
      }
    }
    if (best === null) return null;
    let floor;
    if (window) floor = k === 1 ? MIN_SCORE_SINGLE : MIN_SCORE;
    else floor = globalSearch ? MIN_SCORE_GLOBAL : (k === 1 ? MIN_SCORE_SINGLE : MIN_SCORE);
    if (best.score < floor) return null;
    const charScore = ratio(hlNorm.join(''), canon.normSlice(best.s, best.e + 1));
    if (charScore < CHAR_FLOOR) return null;
    return { s: best.s, e: best.e, phonScore: best.score, charScore };
  }

  // voice_align.hebrew_script_runs, minus the timestamp-gap split (see the
  // header comment): a run breaks on any token with no Hebrew letters in it
  // (English explanation, numbers, standalone punctuation).
  function splitHebrewRuns(text) {
    const runs = [];
    let current = [];
    for (const token of String(text || '').split(/\s+/).filter(Boolean)) {
      const norm = normalizeWord(token);
      if (!norm) {
        if (current.length) { runs.push(current); current = []; }
        continue;
      }
      current.push({ text: token, norm, phon: phonetic(norm) });
    }
    if (current.length) runs.push(current);
    return runs;
  }

  const hasHebrew = (token) => /[\u0590-\u05FF]/.test(token);
  const hasLatin = (token) => /[A-Za-z]/.test(token);

  // Whether a stretch of speech is mostly English: more Latin-letter words than
  // Hebrew-letter ones. Hebrew in such speech is mostly terms and names.
  function englishDominant(text) {
    const tokens = String(text || '').split(/\s+/).filter(Boolean);
    return tokens.filter(hasLatin).length > tokens.filter(hasHebrew).length;
  }

  // The runs of a transcript the tracker may be asked to place. `allRuns` is
  // every Hebrew run (chunked), for telling a bare fragment from explanation;
  // `runs` drops the lone words, and, inside English, the runs too short to be
  // a reading (ENGLISH_CONTEXT_MIN_RUN_WORDS). Judged on the run as spoken,
  // before it is chunked, so a long reading is never mistaken for terms.
  function placeableRuns(heard) {
    const hebrewRuns = splitHebrewRuns(heard);
    const english = englishDominant(heard);
    const allRuns = hebrewRuns.flatMap((run) => chunkRun(run));
    const runs = hebrewRuns
      .filter((run) => !english || run.length >= ENGLISH_CONTEXT_MIN_RUN_WORDS)
      .flatMap((run) => chunkRun(run))
      .filter((run) => run.length >= PLACEABLE_RUN_MIN_WORDS);
    return { allRuns, runs };
  }

  // Evenly sized consecutive chunks of at most maxWords -- 13 words become
  // 7 + 6, never 10 + a lone, unplaceable 3rd-class single word.
  function chunkRun(run, maxWords = LIVE_MAX_RUN_WORDS) {
    if (run.length <= maxWords) return [run];
    const count = Math.ceil(run.length / maxWords);
    const chunks = [];
    let start = 0;
    for (let i = 0; i < count; i += 1) {
      const size = Math.floor(run.length / count) + (i < run.length % count ? 1 : 0);
      chunks.push(run.slice(start, start + size));
      start += size;
    }
    return chunks;
  }

  // Live-only. Speech-to-text told to expect a list of terms (keyterms) will,
  // when the audio is silent or unclear, sometimes just recite that list --
  // seen against the real API at the end of a reading: the whole 50-term list,
  // in order, ~50 words long. Worse than noise: the daf-derived terms are
  // sampled IN DAF ORDER, so consecutive chunks of the recitation land at
  // increasing positions on the daf -- exactly the evidence that makes the
  // tracker trust a placement -- and the highlight jumped to an unrelated
  // spot. Two other hallucinations come with the same silence: a word
  // stuck on repeat ("איננו, איננו, איננו, ..."). Both are stripped from the
  // transcript, before any matching, by cleanTranscript.
  //
  // A stretch of speech that is consecutive entries of the keyterm list (in
  // list order, LEAK_MIN_RUN words or more) is a recitation: genuine reading
  // virtually never produces it, since the daf-derived terms are sampled
  // far apart. (The fixed Gemara terms are adjacent in the list, so a short
  // real "אמר רבא אמר אביי" is below the bar by design.)
  const LEAK_MIN_RUN = 5;
  const REPEAT_MIN_RUN = 3;
  // The batch list is DENSE: up to 400 terms, which on one daf is nearly every
  // distinct word of it, in daf order. Reading the daf then easily gives five
  // consecutive list entries -- 4 of 100 real batch transcripts had genuine
  // reading cut away ("דתניא שמנו מותר וישראל קדושים נהגו בו אסור" became
  // "· · · · · · בו אסור") -- so against that list only a long stretch, which
  // real reading (full of the short words the list leaves out) does not
  // produce but a recitation of the list does, counts.
  const LEAK_MIN_RUN_BATCH = 12;

  // The flattened, normalized words of the keyterm list, in the order they
  // were sent to the service.
  function keytermTokens(keyterms) {
    return keyterms.flatMap((term) => String(term).split(/\s+/).map(normalizeWord).filter(Boolean));
  }

  // Replaces hallucinated tokens with '·' (no Hebrew letters, so
  // splitHebrewRuns ends the run there instead of joining across the gap).
  function cleanTranscript(text, listTokens, leakMinRun = LEAK_MIN_RUN) {
    const tokens = String(text || '').split(/\s+/).filter(Boolean);
    const norms = tokens.map(normalizeWord);
    const drop = new Array(tokens.length).fill(false);
    for (let i = 0; i < tokens.length; i += 1) {
      if (!norms[i]) continue;
      let run = 1; // the same word repeated
      while (i + run < tokens.length && norms[i + run] === norms[i]) run += 1;
      if (run >= REPEAT_MIN_RUN) for (let k = 0; k < run; k += 1) drop[i + k] = true;
      for (let p = 0; p < listTokens.length; p += 1) { // a stretch of the keyterm list
        if (listTokens[p] !== norms[i]) continue;
        let n = 0;
        while (i + n < tokens.length && p + n < listTokens.length && norms[i + n] === listTokens[p + n]) n += 1;
        if (n >= leakMinRun) for (let k = 0; k < n; k += 1) drop[i + k] = true;
      }
    }
    return tokens.map((token, i) => (drop[i] ? '·' : token)).join(' ');
  }

  // Live-only. A match near the cursor can be trusted on little evidence --
  // that's the whole idea of tracking -- but a match FAR from it moves the
  // tracker, and a garbled phrase will match something somewhere. Found in a
  // real session (phone microphone, Chullin 91a): the 2-word garble
  // "שופך שמעון" (for "סופג שמונים") matched a single word 33 words ahead
  // and dragged the cursor there; the next phrase then matched a verbatim
  // repeat of that sentence beside the wrong cursor instead of the right one,
  // and the reader had to tap to recover. Another, 3 words at +12, hid the
  // correct next phrase for 8 seconds. Every legitimate large move in the
  // same session was a longer phrase with decent scores (7 words, +14, after
  // a garbled phrase was skipped). So: beyond LOCAL_JUMP_WORDS, a local match
  // needs real evidence to be believed on its own (strongLocal), and
  // otherwise is held until a later phrase carries on from it -- while a
  // later phrase that lands back near the old cursor (the decoy case) drops it.
  const LOCAL_JUMP_WORDS = 10;
  const STRONG_LOCAL_MIN_WORDS = 5;
  const STRONG_LOCAL_PHON = 75;
  const STRONG_LOCAL_ANY_PHON = 88;
  function strongLocal(match, wordCount) {
    return (wordCount >= STRONG_LOCAL_MIN_WORDS && match.phonScore >= STRONG_LOCAL_PHON)
      || match.phonScore >= STRONG_LOCAL_ANY_PHON;
  }

  // Live-only. In batch, a match far from the cursor is only trusted once a
  // second, different phrase agrees with it -- the guard against a short
  // phrase that happens to resemble some other spot on a repetitive daf. That
  // costs a full extra utterance (seconds) every time the reading resumes
  // beyond the +60-word window, during which the highlight sits still. The
  // same evidence is available from ONE long phrase: if it matches one place
  // well AND no other place on the daf comes close, there is nothing for a
  // second phrase to rule out. matchGlobalWithMargin is the whole-daf search
  // plus that "nothing else comes close" measurement (the phonetic score gap
  // to the best window that doesn't overlap the winner).
  //
  // Thresholds calibrated on noisy simulations (letter confusions, dropped
  // letters, dropped words at up to 45% of words corrupted) and on real
  // ElevenLabs transcripts of a synthetic shiur: 94% of true phrases pass,
  // while 0 of 300 random Hebrew-script phrases and 0 wrong-place matches did.
  // A phrase that genuinely repeats elsewhere on the daf (margin ~0) fails
  // and falls back to the two-match rule, as it should.
  const DECISIVE_MIN_WORDS = 6;
  const DECISIVE_MIN_PHON = 80;
  const DECISIVE_MIN_CHAR = 65;
  const DECISIVE_MIN_MARGIN = 10;
  // The farthest ONE phrase may move a locked position, however clean or
  // decisive it looks. Reading goes on from where it was, or resumes a few lines
  // later: tens of words, no more. A match farther off is a different part of
  // the amud, another amud, or a parallel passage -- and in real use one such
  // phrase jumped the highlight a whole amud and straight back. Beyond this
  // distance a locked tracker holds the candidate and follows it only once a
  // second, agreeing phrase arrives (the same rule batch uses for any fresh
  // lock), so a one-off decoy can never move it and a genuine move costs one
  // phrase. Applies to both ways a single phrase can move a locked tracker:
  // a match inside the search window (needsCorroboration) and a whole-daf
  // match outside it. Not applied when there is no position to compare with (a
  // fresh session, or after the lock was lost): a decisive phrase may land
  // anywhere then.
  const MAX_SINGLE_JUMP_WORDS = 40;

  // Whether a match near the cursor must wait for a second phrase: always when
  // it is beyond MAX_SINGLE_JUMP_WORDS, and between LOCAL_JUMP_WORDS and that
  // unless its own evidence is strong.
  function needsCorroboration(match, cursor, wordCount) {
    const distance = Math.abs(match.s - cursor);
    return distance > MAX_SINGLE_JUMP_WORDS || (distance > LOCAL_JUMP_WORDS && !strongLocal(match, wordCount));
  }

  function matchGlobalWithMargin(canon, hlNorm, hlPhon) {
    const best = matchPhraseDual(canon, hlNorm, hlPhon, 0, { global: true });
    if (!best) return null;
    const phonPhrase = hlPhon.join('');
    const k = hlPhon.length;
    let runnerUp = 0;
    for (const size of pythonSizeOrder(k)) {
      const end = canon.length - size + 1;
      for (let s = 0; s < end; s += 1) {
        if (s <= best.e && s + size - 1 >= best.s) continue; // overlaps the winner
        const score = ratio(phonPhrase, canon.phonSlice(s, s + size));
        if (score > runnerUp) runnerUp = score;
      }
    }
    return { ...best, margin: best.phonScore - runnerUp };
  }

  function isDecisive(match, wordCount) {
    return Boolean(match)
      && wordCount >= DECISIVE_MIN_WORDS
      && match.phonScore >= DECISIVE_MIN_PHON
      && match.charScore >= DECISIVE_MIN_CHAR
      && match.margin >= DECISIVE_MIN_MARGIN;
  }

  // voice_align.match_runs' per-run body as a reusable stepper. step()
  // returns one of:
  //   { kind: 'local', match }      -- placed near the cursor (locked)
  //   { kind: 'confirmed', match, pending } -- a fresh lock (or, live, a
  //                                    jump) corroborated by two agreeing
  //                                    global matches; `pending` is the
  //                                    earlier one, now trusted too
  //   { kind: 'jump', match }       -- (eagerRelocalize only) one long phrase
  //                                    that is clearly the best match on the
  //                                    whole daf, trusted without a second
  //                                    phrase; also how a fresh session locks
  //                                    from its very first phrase
  //   { kind: 'pending', match }    -- a first global candidate, held
  //   { kind: 'miss', unlocked }    -- nothing placed (unlocked: true when
  //                                    this miss is what lost the lock)
  // Whether `run` (of `words` words, text `key`) can corroborate the earlier
  // candidate `earlier` for a far move: both substantial, and not the same words.
  function corroborates(earlier, words, key) {
    return earlier.key !== key
      && (earlier.words || 0) >= FAR_CONFIRM_MIN_WORDS
      && words >= FAR_CONFIRM_MIN_WORDS;
  }

  // The same, for a move held out of the search window: different words always;
  // and, only when it is beyond the jump limit, both substantial.
  function confirmsHeld(held, cursor, words, key) {
    if (held.key === key) return false;
    return Math.abs(held.s - cursor) <= MAX_SINGLE_JUMP_WORDS || corroborates(held, words, key);
  }

  function createTracker(canon, options = {}) {
    const eager = Boolean(options.eagerRelocalize);
    const st = { cursor: 0, locked: false, localMisses: 0, pending: null, held: null };

    function step(run, idx) {
      const hlNorm = run.map((w) => w.norm);
      const hlPhon = run.map((w) => w.phon);
      const key = hlNorm.join(' ');
      let unlocked = false;
      const wasLocked = st.locked;
      let heldBefore = null; // a far move held by the previous phrase, if any
      if (st.locked) {
        const held = st.held;
        heldBefore = held;
        st.held = null;
        const m = matchPhraseDual(canon, hlNorm, hlPhon, st.cursor);
        if (m && eager && needsCorroboration(m, st.cursor, run.length)) {
          const local = { ...m, source: 'deterministic-local' };
          // Carrying on from the held spot (the next phrase starts about where
          // it ended) is the corroboration -- from a different, substantial
          // phrase (see FAR_CONFIRM_MIN_WORDS), not the same words said again.
          if (held && m.s >= held.s - 3 && m.s <= held.e + 12 && confirmsHeld(held, st.cursor, run.length, key)) {
            st.cursor = m.s;
            st.localMisses = 0;
            st.pending = null;
            return { kind: 'confirmed', match: local, pending: { match: held, idx: held.idx } };
          }
          st.held = { ...m, source: 'deterministic-local', idx, words: run.length, key };
          return { kind: 'pending', match: local, held: true };
        }
        if (m) {
          st.cursor = m.s;
          st.localMisses = 0;
          st.pending = null; // always already null in batch mode; see eagerRelocalize
          return { kind: 'local', match: { ...m, source: 'deterministic-local' } };
        }
        st.localMisses += 1;
        if (st.localMisses >= RELOCALIZE_AFTER) {
          st.locked = false;
          unlocked = true;
        } else if (!eager) {
          return { kind: 'miss', unlocked: false };
        }
      }
      const m = eager
        ? matchGlobalWithMargin(canon, hlNorm, hlPhon)
        : matchPhraseDual(canon, hlNorm, hlPhon, st.cursor, { global: true });
      if (!m) {
        st.pending = null; // an unmatched run in between breaks any pending candidate
        return { kind: 'miss', unlocked };
      }
      const match = { ...m, source: 'deterministic-global' };
      const tooFarForOnePhrase = wasLocked && Math.abs(m.s - st.cursor) > MAX_SINGLE_JUMP_WORDS;
      if (eager && isDecisive(m, run.length) && !tooFarForOnePhrase) {
        st.cursor = m.s;
        st.locked = true;
        st.localMisses = 0;
        st.pending = null;
        return { kind: 'jump', match };
      }
      // A far move held last phrase counts as the first of the two agreeing
      // phrases even when this one falls outside the search window around the
      // old position (the reading has moved on from the held spot).
      const pending = st.pending || (heldBefore ? { match: heldBefore, idx: heldBefore.idx, words: heldBefore.words, key: heldBefore.key } : null);
      // A move beyond the jump limit from a locked position needs two substantial,
      // different phrases; short terms, or one phrase said twice, cannot do it.
      const farMove = wasLocked && Math.abs(m.s - st.cursor) > MAX_SINGLE_JUMP_WORDS;
      const corroborated = !eager || !pending || (pending.key !== key && (!farMove || corroborates(pending, run.length, key)));
      if (pending && corroborated && m.s >= pending.match.s && m.s - pending.match.s <= FWD_WINDOW) {
        st.cursor = m.s;
        st.locked = true;
        st.localMisses = 0;
        st.pending = null;
        return { kind: 'confirmed', match, pending };
      }
      st.pending = { match, idx, words: run.length, key };
      return { kind: 'pending', match, unlocked };
    }

    // The reader pointing at the word being read: take it as the position
    // outright, locked, with nothing pending. Live Follow's whole job is
    // working out where the reading is; a person who can see the daf and
    // hear the room just knows. Whatever is said next is matched around it
    // (BACK_WINDOW before, FWD_WINDOW after), so a tap a few words off is fine.
    function anchor(index) {
      st.cursor = Math.max(0, Math.min(canon.length - 1, index));
      st.locked = true;
      st.localMisses = 0;
      st.pending = null;
      st.held = null;
    }

    return {
      step,
      anchor,
      get cursor() { return st.cursor; },
      get locked() { return st.locked; },
      get pending() { return st.pending; },
    };
  }

  // Live-only, no batch counterpart: follows a reading from PARTIAL
  // transcripts, so the highlight keeps pace without waiting for the
  // utterance to commit. It has a cursor of its own, deliberately separate
  // from the tracker's: in a long continuous reading nothing commits until
  // the next pause, and a preview anchored to the last confirmed spot would
  // fall off the end of its +60-word search window and go blind. This
  // cursor moves with every placed partial, and snaps back to the tracker's
  // confirmed position (reset) whenever an utterance commits.
  //
  // Never touches the tracker; nothing it finds is trusted for the
  // lock/confirm rules, only displayed. update() takes the Hebrew tail of
  // the latest partial and returns a match to preview, or null.
  const PREVIEW_MIN_GLOBAL_WORDS = 4;
  // A preview needs at least this many words even right beside the cursor.
  // ElevenLabs writes Hebrew terms spoken inside English ("Gemara", "Rashi")
  // in Hebrew letters, and a lone word like that matches somewhere near
  // almost any cursor -- which would flash the highlight (and, for the
  // tracker's own matching, drag the position) in the middle of an English
  // explanation. Measured: it did, 1.2s before any Hebrew was spoken.
  const PREVIEW_MIN_WORDS = 3;
  const PREVIEW_LOST_AFTER = 3;
  // The text for a word arrives ~0.75s after it is spoken and updates about
  // once a second (measured against the real API), so even a perfectly
  // placed preview sits roughly a second behind the voice. update() also
  // returns a `lead`: how many words past the match to widen the highlight,
  // so it covers what is being said NOW instead of only what has been
  // transcribed. It scales with the measured reading pace (a fixed count
  // would under-cover a fast reader and over-run a slow one): LEAD_SECONDS
  // worth of words, capped, and zero until there is enough progress to
  // measure a pace from. Deliberately short of the full delay -- a highlight
  // that runs ahead of the voice is worse than one that trails it a little.
  const PREVIEW_LEAD_SECONDS = 0.8;
  const PREVIEW_MAX_LEAD = 3;
  const PREVIEW_PACE_WINDOW = 5; // seconds of recent progress the pace is measured over
  function createPreview(canon, tracker) {
    // lastGood: where the preview last placed a partial. It is what a far
    // candidate is measured from -- the preview never makes a far move on
    // partial text (see update), however decisive: partials are short and noisy,
    // and only the tracker's own rules, on committed text, move far.
    const st = { cursor: null, lastGood: null, candidate: null, misses: 0, progress: [] };

    // Words per second over the recent window, from successive placements
    // (nowSeconds is any monotonic clock, in seconds). A jump back, or a
    // long gap, starts the measurement over.
    function notePlacement(match, now) {
      if (now === undefined) return 0;
      const last = st.progress[st.progress.length - 1];
      if (last && (match.e < last.e || now - last.t > PREVIEW_PACE_WINDOW)) st.progress = [];
      st.progress.push({ t: now, e: match.e });
      while (st.progress.length > 2 && now - st.progress[0].t > PREVIEW_PACE_WINDOW) st.progress.shift();
      const first = st.progress[0];
      const span = now - first.t;
      if (span < 1 || match.e <= first.e) return 0;
      return Math.min(PREVIEW_MAX_LEAD, Math.round(((match.e - first.e) / span) * PREVIEW_LEAD_SECONDS));
    }
    const withLead = (m, now) => ({ ...m, lead: notePlacement(m, now) });
    const anchor = () => (st.cursor !== null ? st.cursor : (tracker.locked ? tracker.cursor : null));

    function update(run, now) {
      if (run.length < PREVIEW_MIN_WORDS) return null;
      const hlNorm = run.map((w) => w.norm);
      const hlPhon = run.map((w) => w.phon);
      const from = anchor();
      if (from !== null) {
        let m = matchPhraseDual(canon, hlNorm, hlPhon, from);
        // The same rule as the tracker's: not on weak evidence, not far away.
        if (m && needsCorroboration(m, from, run.length)) m = null;
        if (m) {
          st.cursor = m.s;
          st.lastGood = m.s;
          st.misses = 0;
          st.candidate = null;
          return withLead(m, now);
        }
        st.misses += 1;
        // Lost the thread (the speaker went back, or off into something that
        // isn't the daf): stop leaning on a stale cursor and look afresh.
        if (st.misses >= PREVIEW_LOST_AFTER) st.cursor = null;
      }
      // No usable anchor: a whole-daf search, trusted only once two partials
      // in a row agree -- the same rule that guards a fresh lock. Needs a few
      // words, since a short phrase matches somewhere in a repetitive sugya
      // too easily.
      if (run.length < PREVIEW_MIN_GLOBAL_WORDS) return null;
      const g = matchGlobalWithMargin(canon, hlNorm, hlPhon);
      if (!g) {
        st.candidate = null;
        return null;
      }
      // Far from the last place: not on partial text. (Nothing to compare with
      // -- a fresh session -- and a whole-daf search is allowed as before.)
      const reference = st.lastGood !== null ? st.lastGood : (tracker.locked ? tracker.cursor : null);
      if (reference !== null && Math.abs(g.s - reference) > MAX_SINGLE_JUMP_WORDS) {
        st.candidate = null;
        return null;
      }
      if (isDecisive(g, run.length)) {
        st.cursor = g.s;
        st.lastGood = g.s;
        st.misses = 0;
        st.candidate = null;
        return withLead(g, now);
      }
      // Agreement needs NEW words to have arrived: the same tail re-sent
      // while the speaker pauses is one observation, not two (in batch, the
      // two matches are always different phrases).
      const key = hlNorm.join(' ');
      const previous = st.candidate;
      st.candidate = { ...g, key };
      if (previous && previous.key !== key && g.s >= previous.s && g.s - previous.s <= FWD_WINDOW) {
        st.cursor = g.s;
        st.lastGood = g.s;
        st.misses = 0;
        st.candidate = null;
        return withLead(g, now);
      }
      return null;
    }

    return {
      update,
      reset() { st.cursor = null; st.lastGood = null; st.candidate = null; st.misses = 0; st.progress = []; },
      get cursor() { return st.cursor; },
    };
  }

  // voice_align.match_runs without LLM rescue: one forward sweep, one entry
  // per run, { s, e, score, source } or null. Exists for batch parity
  // testing; Live Follow itself drives createTracker() directly.
  function matchRuns(canon, runs) {
    const tracker = createTracker(canon);
    const out = runs.map(() => null);
    const record = (m) => ({ s: m.s, e: m.e, score: m.phonScore, source: m.source });
    runs.forEach((run, idx) => {
      const result = tracker.step(run, idx);
      if (result.kind === 'local') out[idx] = record(result.match);
      else if (result.kind === 'confirmed') {
        out[result.pending.idx] = record(result.pending.match);
        out[idx] = record(result.match);
      }
    });
    return out;
  }

  // voice_align.build_keyterm_list.
  function buildKeytermList(canon, maxTerms = 50) {
    const seen = new Set();
    const distinctive = [];
    for (const w of canon.words) {
      const n = w.norm;
      if (n.length < 3 || KEYTERM_STOPWORDS.has(n) || seen.has(n)) continue;
      seen.add(n);
      distinctive.push(n);
    }
    let sample = [];
    if (distinctive.length) {
      const stepSize = Math.max(1, Math.floor(distinctive.length / maxTerms));
      sample = distinctive.filter((_, i) => i % stepSize === 0).slice(0, maxTerms);
    }
    return COMMON_GEMARA_TERMS.concat(sample);
  }

  // build_keyterm_list sized for ElevenLabs realtime's hard 50-term /
  // 20-character caps (batch passes max_terms=400). Deduplicated too, which
  // batch doesn't bother with: a sampled single word repeating one of
  // COMMON_GEMARA_TERMS wastes a slot that matters far more out of 50.
  function buildRealtimeKeyterms(canon) {
    const budget = REALTIME_MAX_KEYTERMS - COMMON_GEMARA_TERMS.length;
    const terms = [];
    for (const term of buildKeytermList(canon, budget)) {
      if (term.length <= REALTIME_MAX_KEYTERM_CHARS && !terms.includes(term)) terms.push(term);
    }
    return terms.slice(0, REALTIME_MAX_KEYTERMS);
  }

  return {
    BACK_WINDOW,
    FWD_WINDOW,
    MIN_SCORE,
    MIN_SCORE_GLOBAL,
    MIN_SCORE_SINGLE,
    CHAR_FLOOR,
    RELOCALIZE_AFTER,
    PHONETIC_CLASSES,
    COMMON_GEMARA_TERMS,
    KEYTERM_STOPWORDS,
    LIVE_MAX_RUN_WORDS,
    PROVISIONAL_TAIL_WORDS,
    PLACEABLE_RUN_MIN_WORDS,
    ENGLISH_CONTEXT_MIN_RUN_WORDS,
    FAR_CONFIRM_MIN_WORDS,
    englishDominant,
    placeableRuns,
    MAX_SINGLE_JUMP_WORDS,
    strongLocal,
    REALTIME_MAX_KEYTERMS,
    normalizeWord,
    phonetic,
    ratio,
    segmentTokens,
    buildCanon,
    matchPhraseDual,
    splitHebrewRuns,
    chunkRun,
    createTracker,
    createPreview,
    matchGlobalWithMargin,
    isDecisive,
    matchRuns,
    buildKeytermList,
    buildRealtimeKeyterms,
    keytermTokens,
    cleanTranscript,
    LEAK_MIN_RUN,
    LEAK_MIN_RUN_BATCH,
  };
});
