'use strict';

// "Search in Shas" -- the daf context menu's last item (see daf-context-menu.js,
// which calls window.ShasSearch.openWith(text) the same way it already calls
// window.DafNotesSearch.openWith(text) for "Search this in Cloud Chaburah").
// Searches Sefaria's own Talmud Bavli text index directly (no DafSync server
// involved, no local corpus of our own) and shows every match it returns --
// masechta, daf, amud, and an excerpt with the match marked, taken straight
// from Sefaria's own highlighted snippet. Opening a result navigates to
// /browse/?ref=<daf>&hlRef=<segment>&hlQuery=<query> (a real page load, not
// an in-page swap -- browse/watch/player are separate static pages and a
// result can point anywhere in Shas, not just whatever daf is open now);
// the second half of this file runs on load there, highlighting the matched
// segment and offering a "Back to results" banner that just calls
// history.back() -- the origin tab's dialog (or, on a same-tab open, the
// bfcache'd previous page) is what actually gets the reader back to their
// results, not any state this file tries to serialize across the navigation.
//
// Classic deferred script sharing app.js's top-level bindings ($. escapeHtml,
// parseDafRef, loadDaf, seekToSegment, switchDafView, state), same as
// notes.js/highlights.js/daf-context-menu.js.

const SHAS_SEARCH_ENDPOINT = 'https://www.sefaria.org/api/search-wrapper';
const SHAS_SEARCH_SIZE = 40;

// Hebrew words on the daf carry nikud and cantillation, and a multiword
// selection can carry ordinary punctuation (a maqaf, a colon) between
// them -- none of that should keep an otherwise-exact phrase from matching.
// Unlike daf-context-menu.js's own bareHebrewWord (one word, no spaces kept),
// this has to preserve word boundaries: stripped punctuation becomes a
// space, not nothing, so "מן־הבהמה" (maqaf, no surrounding space) still
// searches as two words rather than one glued-together non-word. Sefaria's
// own "exact" field analyzer is already nikud-insensitive (confirmed
// directly: querying without nikud matches vocalized text fine) -- this is
// belt and braces for the punctuation half specifically, and for any
// analyzer behavior this file doesn't control.
function barePhrase(text) {
  return String(text || '')
    // Hebrew punctuation (maqaf, paseq, sof pasuk, nun hafukha) sits in the
    // SAME Unicode block as nikud/cantillation points -- unlike those, it
    // separates words rather than decorating a letter, so it has to become
    // a space here, BEFORE the nikud strip below removes it to nothing and
    // glues its two neighboring words together (e.g. a maqaf-joined
    // "מן־הבהמה" silently becoming the one non-word "מןהבהמה").
    .replace(/[־׀׃׆]/g, ' ')
    .replace(/[֑-ׇ]/g, '')
    .replace(/[^א-ת\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Sefaria's own highlighted snippet is plain text with literal <b>...</b>
// around the match -- everything else in it is untrusted external content.
// Escaped whole, then only the ESCAPED form of Sefaria's own tags (never
// anything a malicious response could inject as raw markup) is turned back
// into real, attribute-less <mark> elements. This is the only markup this
// function will ever emit from external input.
function sefariaSnippetToSafeHtml(snippet) {
  return escapeHtml(snippet)
    .replace(/&lt;b&gt;/g, '<mark class="shas-search-match">')
    .replace(/&lt;\/b&gt;/g, '</mark>');
}

// One result per unique ref -- Sefaria indexes each ref once per version, so
// the same passage otherwise shows up two or three times over (a plain
// Aramaic edition, a vocalized one, a community translation...). Keeps
// whichever hit has the LOWEST version_priority (0 is Sefaria's own most-
// preferred edition, consistently the vocalized one in practice, which also
// gives noticeably cleaner sentence-scoped snippets than the unvocalized
// editions' single run-on fragment).
function dedupeShasHits(hits) {
  const byRef = new Map();
  for (const hit of hits) {
    const ref = hit._source?.ref;
    if (!ref) continue;
    const priority = Number.isFinite(hit._source?.version_priority) ? hit._source.version_priority : Infinity;
    const existing = byRef.get(ref);
    if (!existing || priority < existing.priority) byRef.set(ref, { hit, priority });
  }
  return [...byRef.values()].map((entry) => entry.hit);
}

async function searchShas(query) {
  const response = await fetch(SHAS_SEARCH_ENDPOINT, {
    method: 'POST',
    // text/plain, not application/json -- reported directly as always
    // failing on the live site despite working from a plain curl request.
    // curl never preflights; a browser does, for any POST carrying a
    // Content-Type outside the three CORS-"simple" values (text/plain,
    // multipart/form-data, application/x-www-form-urlencoded), and
    // confirmed directly against the real endpoint: its OPTIONS response
    // carries access-control-allow-origin but no Access-Control-Allow-
    // Headers/-Methods at all, so the browser refuses the preflight and
    // never sends the real POST. text/plain keeps this a "simple" request
    // (no preflight at all), and the server parses the JSON body exactly
    // the same regardless of what Content-Type it's declared under
    // (confirmed directly too -- identical results with text/plain, with
    // no header at all, and with application/json).
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({
      query,
      type: 'text',
      field: 'exact',
      exact: true,
      size: SHAS_SEARCH_SIZE,
      sort_method: 'score',
      sort_fields: ['pagesheetrank'],
      filters: ['Talmud/Bavli'],
      filter_fields: ['path'],
      source_proj: ['ref', 'heRef', 'categories', 'path', 'version_priority'],
    }),
  });
  if (!response.ok) throw new Error(`Sefaria search returned ${response.status}`);
  const data = await response.json();
  const rawHits = data?.hits?.hits || [];
  const total = Number(data?.hits?.total) || rawHits.length;
  return { hits: dedupeShasHits(rawHits), total };
}

// {tractate, daf, amud} + the "masechta daf-amud" label this app already
// uses everywhere else, from Sefaria's own ref -- never invented, never
// guessed at a different granularity than what Sefaria actually returned.
function shasResultLocation(sefariaRef) {
  const parsed = typeof parseDafRef === 'function' ? parseDafRef(sefariaRef) : null;
  if (!parsed) return null;
  return { ...parsed, label: `${parsed.tractate} ${parsed.daf}${parsed.amud}` };
}

function renderShasResultsBody(body, resultsState) {
  const { status, query, hits, total } = resultsState;
  if (status === 'loading') {
    body.innerHTML = '<p class="field-note">Searching…</p>';
    return;
  }
  if (status === 'error') {
    body.innerHTML = '<p class="field-note">Could not reach Sefaria’s search just now.</p>';
    return;
  }
  if (!hits.length) {
    body.innerHTML = `<p class="field-note">No matches found in Shas for “${escapeHtml(query)}”.</p>`;
    return;
  }
  const rows = hits.map((hit) => {
    const location = shasResultLocation(hit._source.ref);
    if (!location) return '';
    const snippet = hit.highlight?.exact?.[0] || '';
    return `
      <button type="button" class="shas-search-result" data-ref="${escapeHtml(hit._source.ref)}">
        <span class="shas-search-result-loc">${escapeHtml(location.label)}</span>
        <span class="shas-search-result-excerpt" dir="rtl" lang="he">${sefariaSnippetToSafeHtml(snippet)}</span>
      </button>`;
  }).join('');
  const truncated = total > hits.length
    ? `<p class="shas-search-result-note">Showing the top ${hits.length} of ${total} matches -- try a more specific phrase to narrow it down.</p>`
    : '';
  body.innerHTML = `<div class="shas-search-results">${rows}</div>${truncated}`;
}

// Segment ref that should carry the "you searched for this" flash on the
// destination daf (see applyFlashToSegmentSpan, hooked into buildSegmentSpan
// in app.js the same way DafHighlights.applyToSegmentSpan already is) --
// module-level like textSelectionDragging in app.js, a transient render
// input rather than saved state.
let shasFlashRef = null;

// Called from buildSegmentSpan for every segment span as it's built --
// wraps the WHOLE flashed segment's text, not just the searched word/phrase
// within it: Sefaria's search resolves to a segment (a printed line's worth
// of text), not a word-level offset inside it, so that is the most precise
// span this can honestly claim to be "the matched location," the same
// resolution updateVilnaOverlay's own segment-level fallback already uses
// when a segment has no finer word boundary.
function applyFlashToSegmentSpan(span, segment) {
  if (!shasFlashRef || segment.ref !== shasFlashRef) return;
  const textNode = [...span.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.nodeValue.trim());
  if (!textNode) return;
  const mark = document.createElement('mark');
  mark.className = 'daf-search-flash';
  mark.textContent = textNode.nodeValue;
  span.replaceChild(mark, textNode);
}

function shasSearchDialogEls() {
  return {
    dialog: document.getElementById('shasSearchDialog'),
    query: document.getElementById('shasSearchQuery'),
    body: document.getElementById('shasSearchBody'),
  };
}

function openShasResult(sefariaRef) {
  const loc = shasResultLocation(sefariaRef);
  if (!loc) return;
  const dafRef = `${loc.tractate} ${loc.daf}${loc.amud}`;
  // Sefaria's own colon segment numbering ("Chullin 70b:3") is the exact
  // same 1-based position loadDaf's own Sefaria-fallback dot numbering
  // ("Chullin 70b.3") already uses -- both just mean "the Nth text block in
  // this section" -- see fetchSefariaParagraphs's own ref-building comment.
  // The daf-level ref goes in the picker-facing ?ref=; the full segment ref
  // (still colon-form -- see the destination-side handler below, which
  // converts it) goes in hlRef so the destination knows exactly which
  // segment to flash once it loads.
  const url = new URL('/browse/', window.location.origin);
  url.searchParams.set('ref', dafRef);
  url.searchParams.set('hlRef', sefariaRef);
  const query = document.getElementById('shasSearchQuery')?.textContent || '';
  if (query) url.searchParams.set('hlQuery', query);
  window.location.href = url.toString();
}

function initShasSearch() {
  const { dialog, query, body } = shasSearchDialogEls();
  if (dialog) {
    document.getElementById('closeShasSearchDialog')?.addEventListener('click', () => dialog.close());
    body?.addEventListener('click', (event) => {
      const button = event.target.closest('.shas-search-result');
      if (button) openShasResult(button.dataset.ref);
    });

    // Entry point for the daf's own right-click menu ("Search in Shas") --
    // see daf-context-menu.js's buildMenuItems.
    window.ShasSearch = {
      async openWith(text) {
        const trimmed = barePhrase(text);
        if (!trimmed) {
          showToast('No Hebrew text to search for here.', 'error');
          return;
        }
        if (query) query.textContent = trimmed;
        if (!dialog.open) dialog.showModal();
        renderShasResultsBody(body, { status: 'loading', query: trimmed, hits: [] });
        try {
          const { hits, total } = await searchShas(trimmed);
          // A newer search (the reader re-opened the menu and searched
          // something else while this one was in flight) superseded this
          // one -- its own call already rendered, and rendering this
          // stale result over it would flash the wrong query back on screen.
          if (query?.textContent !== trimmed) return;
          renderShasResultsBody(body, { status: 'done', query: trimmed, hits, total });
        } catch {
          if (query?.textContent !== trimmed) return;
          renderShasResultsBody(body, { status: 'error', query: trimmed, hits: [] });
        }
      },
      applyFlashToSegmentSpan,
    };
  }

  // --- Destination side: ?hlRef=/?hlQuery= from an opened search result ---
  const params = new URLSearchParams(location.search);
  const hlRef = params.get('hlRef');
  if (!hlRef || typeof loadDaf !== 'function') return;
  const loc = shasResultLocation(hlRef);
  if (!loc) return;
  const dafRef = `${loc.tractate} ${loc.daf}${loc.amud}`;
  // loadDaf, not onDafPickerChanged's own (video-gated) call to it -- the
  // Daf browser otherwise never fetches a daf's plain text at all unless it
  // already has a synced video for it (see onDafPickerChanged), which most
  // of Shas does not; loadDaf's own Sefaria-fallback path is what actually
  // guarantees real text here regardless of sync status.
  loadDaf(dafRef, { silent: true }).then(() => {
    const segmentRef = hlRef.replace(/:(\d+)$/, '.$1'); // Sefaria's colon -> this app's dot, same position number
    const index = state.segments.findIndex((segment) => segment.ref === segmentRef);
    if (index === -1) return;
    switchDafView('text');
    // Set BEFORE seekToSegment, not after -- seekToSegment's own call chain
    // (updateActiveSegment -> renderDafWindow) is what actually builds the
    // segment spans (via buildSegmentSpan -> applyFlashToSegmentSpan above),
    // and it needs shasFlashRef in place to mark the right one on that same
    // pass, the same real render pass that also sets activeIndex and
    // scrolls the segment into view (see updateActiveSegment's own
    // #autoScroll handling) -- no separate render/scroll of this file's own
    // needed.
    shasFlashRef = segmentRef;
    seekToSegment(index);
    const hlQuery = params.get('hlQuery');
    if (hlQuery) showShasBackBanner(hlQuery);
  });
}

function showShasBackBanner(query) {
  const heading = document.querySelector('.daf-heading') || document.querySelector('.daf-card');
  if (!heading || document.getElementById('shasSearchBackBanner')) return;
  const banner = document.createElement('div');
  banner.id = 'shasSearchBackBanner';
  banner.className = 'shas-search-back-banner';
  banner.innerHTML = `<span>Found via search for “${escapeHtml(query)}”</span>
    <button type="button" class="shas-search-back-button">Back to results</button>`;
  banner.querySelector('.shas-search-back-button').addEventListener('click', () => history.back());
  heading.insertAdjacentElement('afterend', banner);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initShasSearch);
} else {
  initShasSearch();
}
