'use strict';

// "Related discussions" -- duplicate and neighbour suggestions for a thread.
//
// Deliberately NOT an AI feature, and deliberately built first. The redesign
// plan asks for "duplicate/related discussion suggestions using source anchor
// and search signals BEFORE considering fully semantic recommendations", and
// the reason is visible in the data: every note in this system is anchored to
// an exact passage (daf_ref_key + segment_ref, and usually a word range within
// it). Two people asking about the same six words of Chullin 89a is not a
// semantic similarity problem -- it is an equality check on a column that
// already has an index.
//
// So the signals here are, in descending order of trustworthiness:
//
//   1. the same segment_ref                -- the same sentence of the daf
//   2. an overlapping word range within it -- literally the same words
//   3. the same daf_ref_key                -- the same page
//   4. a Postgres full-text match          -- the same words in the discussion
//
// Every query runs through the reader's own supabase-js client, so RLS is the
// visibility boundary: a private note, a moderator-hidden note and a
// soft-deleted note are filtered by the database, not by this file. Nothing
// here can suggest a discussion the reader could not already open.

(function () {
  const { client } = window.DafSyncChabura.core;

  const MAX_SUGGESTIONS = 5;
  const CANDIDATE_LIMIT = 40;      // per query, before scoring
  const MIN_SCORE = 15;            // below this a suggestion is noise
  const DUPLICATE_SCORE = 70;      // at or above, offer it as "possibly the same question"

  const COLUMNS = [
    'id', 'title', 'body', 'category', 'author_display_name',
    'daf_ref_key', 'segment_ref', 'start_word', 'end_word', 'selected_text',
    'created_at', 'last_activity_at',
  ].join(', ');

  // --- Query terms ----------------------------------------------------------

  // Two-letter words, and the handful of English function words that survive
  // the 'simple' text search config (it does no stemming and has no stop-word
  // list, which is why they have to be dropped here instead).
  const STOP_WORDS = new Set([
    'the', 'and', 'for', 'that', 'this', 'with', 'from', 'what', 'why', 'how',
    'does', 'did', 'was', 'are', 'but', 'not', 'you', 'his', 'her', 'its',
    'all', 'any', 'can', 'has', 'had', 'who', 'when', 'where', 'here', 'there',
    'about', 'would', 'could', 'should', 'says', 'said', 'said', 'then', 'than',
  ]);

  // websearch_to_tsquery treats quotes, OR and - as operators. A note body is
  // user-written prose, so anything that could be read as an operator is
  // stripped rather than escaped -- a malformed tsquery raises 42601 and would
  // turn a decorative panel into a visible error.
  function queryTerms(note) {
    const source = [note.title || '', note.selected_text || '', note.body || ''].join(' ');
    const seen = new Set();
    const terms = [];
    // Keeps Hebrew and Latin letters and digits; everything else is a break.
    for (const raw of source.split(/[^\p{L}\p{N}]+/u)) {
      const word = raw.trim();
      if (word.length < 3) continue;
      const lower = word.toLowerCase();
      if (STOP_WORDS.has(lower)) continue;
      if (seen.has(lower)) continue;
      seen.add(lower);
      terms.push(word);
      if (terms.length >= 8) break;
    }
    return terms;
  }

  // --- Scoring --------------------------------------------------------------

  function rangeOverlap(a, b) {
    if (a.start_word == null || a.end_word == null) return 0;
    if (b.start_word == null || b.end_word == null) return 0;
    const start = Math.max(a.start_word, b.start_word);
    const end = Math.min(a.end_word, b.end_word);
    if (end < start) return 0;
    const shared = end - start + 1;
    const smaller = Math.min(a.end_word - a.start_word + 1, b.end_word - b.start_word + 1);
    return smaller > 0 ? shared / smaller : 0;
  }

  // Pure, and exported for the tests. The weights are a product judgement, not
  // a measurement: an exact anchor match is worth more than any amount of
  // wording similarity, because two notes on the same words of the same daf are
  // about the same thing even when they share no vocabulary at all -- which is
  // routine here, where one reader writes in English and another in Hebrew.
  function scoreCandidate(note, candidate, matchedTerms) {
    let score = 0;
    const reasons = [];

    const sameDaf = candidate.daf_ref_key === note.daf_ref_key;
    const sameSegment = sameDaf && candidate.segment_ref === note.segment_ref;

    if (sameSegment) {
      score += 50;
      reasons.push('Same passage');
      const overlap = rangeOverlap(note, candidate);
      if (overlap > 0) {
        score += Math.round(30 * overlap);
        if (overlap >= 0.5) reasons.push('Overlapping words');
      }
    } else if (sameDaf) {
      score += 15;
      reasons.push('Same daf');
    }

    if (matchedTerms > 0) {
      score += 20 + Math.min(matchedTerms - 1, 3) * 5;
      reasons.push('Similar wording');
    }

    if (candidate.category && candidate.category === note.category) score += 5;

    return { score, reasons };
  }

  function rank(note, candidates, textMatchIds) {
    const scored = [];
    for (const candidate of candidates.values()) {
      if (candidate.id === note.id) continue;
      const matchedTerms = textMatchIds.get(candidate.id) || 0;
      const { score, reasons } = scoreCandidate(note, candidate, matchedTerms);
      if (score < MIN_SCORE) continue;
      scored.push({
        note: candidate,
        score,
        reasons,
        possibleDuplicate: score >= DUPLICATE_SCORE,
      });
    }
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Same score: the thread that is still moving is the more useful one.
      return String(b.note.last_activity_at || '').localeCompare(String(a.note.last_activity_at || ''));
    });
    return scored.slice(0, MAX_SUGGESTIONS);
  }

  // --- Reading --------------------------------------------------------------

  async function fetchRelated(note) {
    if (!note || !note.id) return [];

    const candidates = new Map();
    const textMatchIds = new Map();

    const collect = (rows) => {
      (rows || []).forEach((row) => {
        if (row.id === note.id) return;
        if (!candidates.has(row.id)) candidates.set(row.id, row);
      });
    };

    // Anchor queries and the text query run together: they are independent, and
    // a related panel that costs three sequential round trips would be a
    // regression against the "no N+1" rule the feed and thread both hold to.
    const terms = queryTerms(note);

    // Public discussions only, stated explicitly rather than left to RLS. RLS
    // already hides other people's private notes; what it does NOT hide is the
    // reader's OWN private notes, and suggesting "you also wrote this privately"
    // underneath a public thread is a leak waiting to happen the day a reader
    // shares their screen. The predicate is cheap and the ambiguity is not
    // worth keeping.
    const publicOnly = (query) => query
      .eq('is_private', false)
      .eq('hidden', false)
      .is('deleted_at', null)
      .neq('id', note.id)
      .order('last_activity_at', { ascending: false })
      .limit(CANDIDATE_LIMIT);

    const [bySegment, byDaf, byText] = await Promise.all([
      publicOnly(client().from('line_notes').select(COLUMNS).eq('segment_ref', note.segment_ref)),
      publicOnly(client().from('line_notes').select(COLUMNS).eq('daf_ref_key', note.daf_ref_key)),
      terms.length
        ? publicOnly(client().from('line_notes').select(COLUMNS)
            .textSearch('body_tsv', terms.join(' OR '), { type: 'websearch', config: 'simple' }))
        : Promise.resolve({ data: [], error: null }),
    ]);

    // One failing signal must not lose the other two. A related panel is
    // decoration; the thread underneath it is the page.
    if (!bySegment.error) collect(bySegment.data);
    if (!byDaf.error) collect(byDaf.data);
    if (!byText.error) {
      collect(byText.data);
      // How MANY of this note's salient terms a candidate shares, counted here
      // rather than asked of Postgres: ts_rank would need an RPC, and the count
      // is what the weighting actually wants.
      const lowered = terms.map((t) => t.toLowerCase());
      (byText.data || []).forEach((row) => {
        const haystack = `${row.title || ''} ${row.selected_text || ''} ${row.body || ''}`.toLowerCase();
        textMatchIds.set(row.id, lowered.filter((t) => haystack.includes(t)).length);
      });
    }

    return rank(note, candidates, textMatchIds);
  }

  // --- Rendering ------------------------------------------------------------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function excerpt(row) {
    const body = (row.body || '').replace(/\s+/g, ' ').trim();
    if (body.length <= 140) return body;
    return `${body.slice(0, 139).trimEnd()}…`;
  }

  function suggestionCard(item, backQuery) {
    const card = el('li', 'cr-item');

    const link = el('a', 'cr-link');
    link.href = `/chaburah/thread/?thread=${encodeURIComponent(item.note.id)}${backQuery}`;
    link.textContent = item.note.title || excerpt(item.note) || 'Untitled discussion';
    card.appendChild(link);

    const meta = el('p', 'cr-meta');
    const reasons = [...item.reasons];
    if (item.possibleDuplicate) reasons.unshift('Possibly the same question');
    meta.textContent = `${item.note.segment_ref} · ${reasons.join(' · ')}`;
    card.appendChild(meta);

    if (item.note.title && excerpt(item.note)) {
      card.appendChild(el('p', 'cr-excerpt', excerpt(item.note)));
    }
    return card;
  }

  // Renders into `host`, replacing whatever was there. Renders NOTHING at all
  // when there is nothing worth suggesting -- an empty "Related discussions"
  // heading is worse than no heading.
  function renderInto(host, items, options = {}) {
    if (!host) return;
    host.innerHTML = '';
    if (!items || !items.length) {
      host.hidden = true;
      return;
    }
    host.hidden = false;

    const section = el('section', 'cr-panel');
    section.setAttribute('aria-labelledby', 'crHeading');

    const heading = el('h2', 'cr-heading', 'Related discussions');
    heading.id = 'crHeading';
    section.appendChild(heading);

    section.appendChild(el('p', 'cr-note',
      'Found by matching the passage this discussion is anchored to, and the words it uses.'));

    const list = el('ul', 'cr-list');
    const backQuery = options.back ? `&back=${encodeURIComponent(options.back)}` : '';
    items.forEach((item) => list.appendChild(suggestionCard(item, backQuery)));
    section.appendChild(list);

    host.appendChild(section);
  }

  window.DafSyncChabura = window.DafSyncChabura || {};
  window.DafSyncChabura.related = {
    fetchRelated,
    renderInto,
    MAX_SUGGESTIONS,
    DUPLICATE_SCORE,
    // Exported for tests/chaburah/related.spec.mjs: the ranking is the whole
    // feature, and it is pure, so it is tested directly rather than inferred
    // from what happened to render.
    __testing: { queryTerms, rangeOverlap, scoreCandidate, rank, STOP_WORDS },
  };
})();
