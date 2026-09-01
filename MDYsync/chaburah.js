'use strict';

// Cloud Chaburah feed (chaburah/index.html) -- a read-only summary list of
// public notes, reusing notes.js's own rendering helpers (renderFormattedBody,
// renderTimestampPill, categoryByKey, CATEGORY_TYPES, formatNoteTime) and
// app.js's globals (state, escapeHtml, parseDafRef, refKey, $). "View thread"
// reuses the SAME dialog every other page opens notes in (window.DafNotes.open)
// rather than a second note-rendering implementation -- state.dafRef is set
// first so currentDafInfo() (used when composing a reply from here) resolves
// to the right daf.

const CHABURAH_PAGE_SIZE = 20;
// Ranked views (Most helpful/Unanswered) have no denormalized counters to
// sort/filter by in the DB, so this scans the most recent public notes,
// computes counts client-side, and ranks within that window -- reasonable at
// the site's current scale, not true DB-level pagination. See notes.js's own
// reaction/comment loaders for the same batched-count pattern.
const CHABURAH_RANK_SCAN_LIMIT = 200;

let chaburahView = 'latest';
let chaburahCategory = '';
let chaburahOffset = 0;
let chaburahRows = [];
let chaburahRefInfo = null; // { dafRefKey, tractatePrefix } from ?ref=, or null

function chaburahEls() {
  return {
    viewSwitch: document.getElementById('chaburahViewSwitch'),
    categoryFilter: document.getElementById('chaburahCategoryFilter'),
    list: document.getElementById('chaburahFeedList'),
    loadMoreButton: document.getElementById('chaburahLoadMoreButton'),
  };
}

function populateChaburahCategoryFilter() {
  const { categoryFilter } = chaburahEls();
  if (!categoryFilter || categoryFilter.options.length) return;
  categoryFilter.innerHTML = '<option value="">All categories</option>' +
    CATEGORY_TYPES.map((c) => `<option value="${c.key}">${c.he} (${c.en})</option>`).join('');
}

function chaburahCardHtml(row) {
  const categoryInfo = row.category ? categoryByKey(row.category) : null;
  const categoryPill = categoryInfo
    ? `<span class="note-pill note-category-pill" title="${escapeHtml(categoryInfo.en)} — ${escapeHtml(categoryInfo.meaning)}"><span dir="rtl" lang="he">${escapeHtml(categoryInfo.he)}</span></span>`
    : '';
  const timestampPill = renderTimestampPill(row, false);
  const demoPill = demoPillHtml(row);
  const refDisplay = row.daf_ref_key ? row.daf_ref_key.replace(/-/g, ' ') : '';
  const who = escapeHtml(row.author_display_name || 'Anonymous');
  return `
    <div class="note-item chaburah-card" data-id="${row.id}" data-segment-ref="${escapeHtml(row.segment_ref || '')}" data-daf-ref-key="${escapeHtml(row.daf_ref_key || '')}">
      <div class="note-item-head">
        <span class="note-item-author">${who}</span>
        ${categoryPill}
        ${timestampPill}
        ${demoPill}
        ${refDisplay ? `<span class="note-pill">${escapeHtml(refDisplay)}</span>` : ''}
        <span class="note-item-time">${formatNoteTime(row.created_at)}</span>
      </div>
      <p class="note-item-body">${renderFormattedBody(row.body)}</p>
      ${row._chaburahMeta || ''}
      <div class="chaburah-card-actions">
        <button type="button" class="button secondary small chaburah-view-thread">View thread</button>
        <a class="button ghost small" href="../browse/index.html?ref=${encodeURIComponent(refDisplay)}">Open on daf</a>
      </div>
    </div>`;
}

function wireChaburahCardActions(list) {
  list.querySelectorAll('.chaburah-view-thread').forEach((button) => {
    button.addEventListener('click', () => {
      const card = button.closest('.chaburah-card');
      const segmentRef = card.dataset.segmentRef;
      const dafRefKey = card.dataset.dafRefKey;
      if (dafRefKey) state.dafRef = dafRefKey.replace(/-/g, ' ');
      window.DafNotes?.open(segmentRef, '');
    });
  });
}

// Builds the base query every non-ranked view starts from (public,
// not-hidden notes, optionally narrowed by category) -- each view then adds
// its own extra filter on top.
function chaburahBaseQuery() {
  const auth = window.DafSyncAuth;
  let query = auth.client.from('line_notes').select('*').eq('is_private', false).eq('hidden', false);
  if (chaburahCategory) query = query.eq('category', chaburahCategory);
  return query;
}

// Latest/This daf/This masechta/Following all page the same way: fetch one
// row past the current window to know whether "Load more" should show, then
// slice locally rather than using a true offset query (see CHABURAH_RANK_SCAN_LIMIT's
// comment -- same acceptance, applied consistently across every view here).
//
// Builds and AWAITS the query in one expression per branch, deliberately --
// a Supabase query builder is itself a thenable (that's how plain `await
// query` works), so returning one from an `async function` without awaiting
// it first gets silently unwrapped into its resolved {data,error} by the
// same thenable-adoption behavior that makes `await` work at all, losing
// the "just a builder, not yet run" object a caller further up meant to
// keep chaining .order()/.limit() onto.
async function loadChaburahPagedView(view) {
  const auth = window.DafSyncAuth;
  const user = auth?.getUser();
  const limit = chaburahOffset + CHABURAH_PAGE_SIZE + 1;

  if (view === 'following') {
    const { data: follows } = await auth.client.from('thread_follows').select('note_id').eq('user_id', user.id);
    const noteIds = (follows || []).map((f) => f.note_id);
    if (!noteIds.length) return { rows: [], hasMore: false }; // nothing followed yet
    const { data, error } = await chaburahBaseQuery().in('id', noteIds).order('created_at', { ascending: false }).limit(limit);
    if (error) throw error;
    const rows = data || [];
    return { rows: rows.slice(chaburahOffset, chaburahOffset + CHABURAH_PAGE_SIZE), hasMore: rows.length > chaburahOffset + CHABURAH_PAGE_SIZE };
  }

  let query = chaburahBaseQuery();
  if (view === 'this-daf') query = query.eq('daf_ref_key', chaburahRefInfo.dafRefKey);
  else if (view === 'this-masechta') query = query.ilike('daf_ref_key', `%${chaburahRefInfo.tractatePrefix}-%`);

  const { data, error } = await query.order('created_at', { ascending: false }).limit(limit);
  if (error) throw error;
  const rows = data || [];
  const hasMore = rows.length > chaburahOffset + CHABURAH_PAGE_SIZE;
  return { rows: rows.slice(chaburahOffset, chaburahOffset + CHABURAH_PAGE_SIZE), hasMore };
}

async function loadChaburahRankedView(view) {
  const auth = window.DafSyncAuth;
  const { data, error } = await chaburahBaseQuery().order('created_at', { ascending: false }).limit(CHABURAH_RANK_SCAN_LIMIT);
  if (error) throw error;
  const rows = data || [];
  if (!rows.length) return [];
  const noteIds = rows.map((r) => r.id);
  if (view === 'most-helpful') {
    const { data: reactions } = await auth.client.from('reactions').select('target_id').eq('target_type', 'note').in('target_id', noteIds);
    const counts = new Map();
    (reactions || []).forEach((r) => counts.set(r.target_id, (counts.get(r.target_id) || 0) + 1));
    return rows
      .map((row) => ({ row, count: counts.get(row.id) || 0 }))
      .filter((entry) => entry.count > 0)
      .sort((a, b) => b.count - a.count || new Date(b.row.created_at) - new Date(a.row.created_at))
      .slice(0, CHABURAH_PAGE_SIZE)
      .map((entry) => ({ ...entry.row, _chaburahMeta: `<p class="field-note chaburah-meta">${entry.count} reaction${entry.count === 1 ? '' : 's'}</p>` }));
  }
  // unanswered
  const { data: comments } = await auth.client.from('comments').select('note_id').in('note_id', noteIds);
  const commented = new Set((comments || []).map((c) => c.note_id));
  return rows.filter((row) => !commented.has(row.id)).slice(0, CHABURAH_PAGE_SIZE);
}

async function renderChaburahFeed(reset) {
  const { list, loadMoreButton } = chaburahEls();
  if (!list) return;
  if (reset) {
    chaburahOffset = 0;
    chaburahRows = [];
    list.innerHTML = '<p class="field-note">Loading…</p>';
  }
  const auth = window.DafSyncAuth;
  const user = auth?.getUser();

  if (chaburahView === 'following' && !user) {
    list.innerHTML = '<p class="field-note">Sign in to see notes from people you follow.</p>';
    loadMoreButton.hidden = true;
    return;
  }
  if ((chaburahView === 'this-daf' || chaburahView === 'this-masechta') && !chaburahRefInfo) {
    list.innerHTML = '<p class="field-note">Open a daf first, then come back here to see its Cloud Chaburah discussion.</p>';
    loadMoreButton.hidden = true;
    return;
  }

  let rows;
  let hasMore = false;
  try {
    if (chaburahView === 'most-helpful' || chaburahView === 'unanswered') {
      rows = await loadChaburahRankedView(chaburahView);
    } else {
      const result = await loadChaburahPagedView(chaburahView);
      rows = result.rows;
      hasMore = result.hasMore;
    }
  } catch (err) {
    list.innerHTML = '<p class="field-note">Could not load the feed.</p>';
    loadMoreButton.hidden = true;
    return;
  }

  chaburahRows = chaburahRows.concat(rows);
  chaburahOffset += rows.length;
  if (!chaburahRows.length) {
    list.innerHTML = '<p class="field-note">No notes here yet.</p>';
  } else {
    list.innerHTML = chaburahRows.map((row) => chaburahCardHtml(row)).join('');
    wireChaburahCardActions(list);
  }
  loadMoreButton.hidden = !hasMore;
}

function initChaburahRefParam() {
  const params = new URLSearchParams(location.search);
  const ref = params.get('ref');
  if (!ref || typeof parseDafRef !== 'function' || typeof refKey !== 'function') return;
  const parsed = parseDafRef(ref);
  if (!parsed) return;
  chaburahRefInfo = {
    dafRefKey: refKey(ref),
    tractatePrefix: parsed.tractate.replace(/\s+/g, '-'),
  };
}

function initChaburahFeed() {
  const { viewSwitch, categoryFilter, loadMoreButton } = chaburahEls();
  if (!viewSwitch) return; // this page doesn't ship the feed markup
  initChaburahRefParam();
  populateChaburahCategoryFilter();

  viewSwitch.querySelectorAll('button[data-view]').forEach((button) => {
    button.addEventListener('click', () => {
      chaburahView = button.dataset.view;
      viewSwitch.querySelectorAll('button[data-view]').forEach((b) => b.classList.toggle('active', b === button));
      renderChaburahFeed(true);
    });
  });
  categoryFilter.addEventListener('change', () => {
    chaburahCategory = categoryFilter.value || '';
    renderChaburahFeed(true);
  });
  loadMoreButton.addEventListener('click', () => renderChaburahFeed(false));

  // Waits for the initial session check (and re-renders on sign-in/out) --
  // without this, a signed-in reader landing straight on Following would
  // briefly see the signed-out prompt before their session resolves.
  window.DafSyncAuth?.onChange(() => renderChaburahFeed(true));
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initChaburahFeed);
} else {
  initChaburahFeed();
}
