'use strict';

// Cloud Chaburah Live -- the pure parts: no DOM, no network. Loaded as a plain <script>
// (window.LiveChaburahCore) by the pages that show the discussion panel, and require()d
// directly by tests/functions/live-chaburah-core.test.mjs.
//
// Everything that decides what a reader sees -- which threads come first, how a new
// message is folded into a chat, what an error says in words -- lives here so it can be
// tested without a browser or a database.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LiveChaburahCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const DAF_REF = /^\s*([A-Za-z][A-Za-z' ]*?)\s+(\d{1,3})\s*([ab])\b/;

  // The key a discussion is filed under: the daf itself ("Bekhorot-22a"), the same for the
  // regular shiur, the Hebrew one, a Chazarah recording and another rabbi's -- the talk is
  // about the Gemara, not about one recording of it. Accepts "Bekhorot 22a", a ref with a
  // variant marker, or a segment ref ("Bekhorot 22a.5", "Bekhorot 22a:5").
  function dafKeyFromRef(ref) {
    const m = DAF_REF.exec(String(ref || ''));
    if (!m) return null;
    return `${m[1].trim().replace(/\s+/g, '-')}-${Number(m[2])}${m[3]}`;
  }

  // "Bekhorot 22a" for display, from the same input.
  function dafLabelFromRef(ref) {
    const m = DAF_REF.exec(String(ref || ''));
    return m ? `${m[1].trim().replace(/\s+/g, ' ')} ${Number(m[2])}${m[3]}` : '';
  }

  // The segment number at the end of "Bekhorot 22a.5" / "Bekhorot 22a:5"; 0 for a bare daf.
  function segmentNumber(ref) {
    const m = /[.:](\d+)\s*$/.exec(String(ref || ''));
    return m ? Number(m[1]) : 0;
  }

  // Where a thread starts on the daf, as a number that orders threads top to bottom.
  const WORDS_PER_SEGMENT_SPAN = 400;
  function anchorOrder(thread) {
    return (Number(thread.anchor_segment) || 0) * WORDS_PER_SEGMENT_SPAN + (Number(thread.anchor_word) || 0);
  }

  // The reader's place: { segment, word } -> the same scale.
  function placeOrder(place) {
    if (!place) return null;
    return (Number(place.segment) || 0) * WORDS_PER_SEGMENT_SPAN + (Number(place.word) || 0);
  }

  const time = (iso) => (iso ? Date.parse(iso) : 0);

  // Orders (and for 'unanswered', filters) a daf's threads. Pure: returns a new array.
  //   near       closest to the reader's place first, then most recent
  //   latest     most recent activity first
  //   unanswered still-open questions, most recent first
  //   active     busiest in the last hour first, then most recent
  //   all        in the order of the daf, top to bottom
  // With no known place, 'near' falls back to the daf's own order.
  function sortThreads(threads, mode, place, now) {
    const list = threads.slice();
    const byRecent = (a, b) => time(b.last_message_at) - time(a.last_message_at);
    const byDaf = (a, b) => anchorOrder(a) - anchorOrder(b) || time(a.created_at) - time(b.created_at);
    const at = placeOrder(place);
    switch (mode) {
      case 'latest':
        return list.sort(byRecent);
      case 'unanswered':
        return list.filter((t) => t.status !== 'answered').sort(byRecent);
      case 'active': {
        const hourAgo = (now ?? Date.now()) - 60 * 60 * 1000;
        const recent = (t) => (time(t.last_message_at) >= hourAgo ? 1 : 0);
        return list.sort((a, b) => recent(b) - recent(a) || (recent(a) ? b.message_count - a.message_count : 0) || byRecent(a, b));
      }
      case 'all':
        return list.sort(byDaf);
      case 'near':
      default:
        if (at === null) return list.sort(byDaf);
        return list.sort((a, b) =>
          Math.abs(anchorOrder(a) - at) - Math.abs(anchorOrder(b) - at) || byRecent(a, b));
    }
  }

  const replyCount = (thread) => Math.max(0, (Number(thread.message_count) || 0) - 1);

  // "just now", "2 minutes ago", "3 hours ago", "yesterday", "12 Oct".
  function timeAgo(iso, now) {
    const then = time(iso);
    if (!then) return '';
    const seconds = Math.max(0, Math.round(((now ?? Date.now()) - then) / 1000));
    if (seconds < 45) return 'just now';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    const days = Math.round(hours / 24);
    if (days === 1) return 'yesterday';
    if (days < 7) return `${days} days ago`;
    return new Date(then).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }

  // Is there activity in a thread the reader follows that they have not seen? An
  // indicator, not a count: the thread row says when it last moved, the read state says
  // when the reader last looked.
  function hasUnread(thread, readState, followed, myId) {
    if (!followed) return false;
    if (!readState) return thread.author_id !== myId || replyCount(thread) > 0;
    return time(thread.last_message_at) > time(readState.updated_at) + 500;
  }

  // Folds one message (from the database or from a broadcast) into a chat: replaces a
  // message already there (an edit, a redaction, or the same message arriving twice by
  // two routes), otherwise inserts it in seq order. Never mutates its input.
  function mergeMessage(messages, message) {
    const next = messages.slice();
    const index = next.findIndex((m) => m.id === message.id);
    if (index >= 0) {
      next[index] = { ...next[index], ...message };
      return next;
    }
    let at = next.length;
    while (at > 0 && Number(next[at - 1].seq) > Number(message.seq)) at -= 1;
    next.splice(at, 0, message);
    return next;
  }

  // Inserts or replaces a thread in a daf's list (a broadcast summary), by id.
  function mergeThread(threads, thread) {
    const index = threads.findIndex((t) => t.id === thread.id);
    if (index < 0) return [thread, ...threads];
    const next = threads.slice();
    next[index] = { ...next[index], ...thread };
    return next;
  }

  function removeThread(threads, id) {
    return threads.filter((t) => t.id !== id);
  }

  // A one-line version of a message for the quote bar above a reply.
  function quoteSnippet(message, max = 90) {
    if (!message) return '';
    if (message.deleted_at) return 'This message was deleted';
    if (message.hidden) return 'This message was removed';
    const text = String(message.body || '').replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  // Whether a body is worth sending: 1..2000 characters once trimmed.
  function bodyProblem(body) {
    const text = String(body || '').trim();
    if (!text) return 'Write something first.';
    if (text.length > 2000) return `That is ${text.length} characters; the limit is 2000.`;
    return null;
  }

  // The words a reader sees for a failure. The database raises short codes
  // ("live_rate_limited"); anything else is a network or server fault.
  const ERROR_TEXT = {
    live_not_signed_in: 'Sign in to join the discussion.',
    live_not_available: 'Live discussions are not open to you yet.',
    live_account_too_new: 'New accounts can read discussions right away and can post after 24 hours.',
    live_rate_limited: 'You are posting very quickly. Wait a moment and try again.',
    live_invalid_input: 'That could not be sent. Check the text and try again.',
    live_cannot_edit: 'You can edit your own message for 15 minutes after posting it.',
    live_cannot_delete: 'You can only delete your own messages.',
    live_root_has_replies: 'This opening question has replies, so it cannot be deleted.',
    live_thread_missing: 'This discussion is no longer available.',
  };
  function errorText(error) {
    const message = String(error?.message || '');
    for (const code of Object.keys(ERROR_TEXT)) {
      if (message.includes(code)) return ERROR_TEXT[code];
    }
    if (error?.code === '42501') return 'You do not have permission to do that.';
    if (/Failed to fetch|NetworkError|network/i.test(message)) return 'Could not reach the server. Check your connection.';
    return 'Something went wrong. Please try again.';
  }

  // The word ranges a selection covers, in the shape the notes use: [{ ref, start, end }].
  // `target` is what the right-click menu builds (runs for a multi-run selection, or one
  // ref with start/end); with neither, the whole segment, when its text is known.
  function runsFromTarget(target, segments) {
    if (target?.runs?.length) {
      return target.runs.map((r) => ({ ref: r.ref, start: Number(r.start), end: Number(r.end) }));
    }
    if (target && target.start != null && target.end != null) {
      return [{ ref: target.ref, start: Number(target.start), end: Number(target.end) }];
    }
    const segment = (segments || []).find((s) => s.ref === target?.ref);
    const words = segment ? String(segment.he || '').trim().split(/\s+/).filter(Boolean).length : 0;
    return words ? [{ ref: target.ref, start: 0, end: words - 1 }] : [];
  }

  // A link that opens the right daf and discussion.
  function threadUrl(origin, dafRef, threadId) {
    return `${origin}/browse/?ref=${encodeURIComponent(dafLabelFromRef(dafRef))}&live=${encodeURIComponent(threadId)}`;
  }

  function threadIdFromSearch(search) {
    const id = new URLSearchParams(search || '').get('live');
    return id && /^[0-9a-f-]{36}$/i.test(id) ? id : null;
  }

  // Who is here: a Presence state is { <key>: [entries] }, and each tab joins under its own
  // random key (never a user id, so readers cannot tell who is present), so the count is
  // the number of keys that still have an entry.
  function presenceCount(state) {
    return Object.values(state || {}).filter((entries) => Array.isArray(entries) && entries.length > 0).length;
  }

  // ---- Phase 2: finding, filtering, markers -----------------------------------------------

  // Text for matching: without Hebrew vowel points and cantillation, lower-cased, spaces folded,
  // so a search for "רבי" finds "רַבִּי" and "Rashi" finds "rashi".
  function normalizeText(value) {
    return String(value || '')
      .normalize('NFC')
      .replace(/[\u0591-\u05C7]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Does a thread's own text (its quoted words, opening question or asker) contain the query?
  // Messages are searched by the database; this covers what the list already holds.
  function matchesQuery(thread, query) {
    const q = normalizeText(query);
    if (!q) return true;
    return [thread.quoted_text, thread.preview, thread.author_display_name]
      .some((text) => normalizeText(text).includes(q));
  }

  // A search word as a LIKE pattern body: the characters that mean something to LIKE are
  // escaped, so "100%" is searched for, not treated as a wildcard.
  function escapeLike(query) {
    return String(query || '').trim().replace(/[\\%_]/g, (c) => `\\${c}`);
  }

  // Which threads to list. `filter`: 'all', 'following', 'mine' (asked, or posted in) or 'here'
  // (anchored in the passage the reader is at); `matchIds` is the set a search found (null
  // means no search); `ids` limits to a set (the threads behind a marker the reader clicked).
  function filterThreads(threads, { filter = 'all', follows, mine, matchIds = null, ids = null, myId = null, place = null } = {}) {
    return threads.filter((thread) => {
      if (ids && !ids.has(thread.id)) return false;
      if (matchIds && !matchIds.has(thread.id)) return false;
      if (filter === 'following') return Boolean(follows?.has(thread.id));
      if (filter === 'mine') return thread.author_id === myId || Boolean(mine?.has(thread.id));
      if (filter === 'here') return isHere(thread, place);
      return true;
    });
  }

  // Is a thread about the passage the reader is at (the same paragraph of the daf)?
  function isHere(thread, place) {
    return Boolean(place) && Number(thread.anchor_segment) === Number(place.segment) && Number(place.segment) > 0;
  }

  // The reader's place from what is on screen: the printed word nearest the vertical middle of
  // the visible part of the page. `boxes` are the page's word boxes ({ ref, wordIndex, y, h }
  // as fractions of the page height), `middle` the fraction of the page height at the middle
  // of the viewport. Null when there is nothing to go by.
  function placeFromViewport(boxes, middle) {
    if (!Array.isArray(boxes) || !boxes.length || !Number.isFinite(middle)) return null;
    let best = null;
    let bestDistance = Infinity;
    for (const box of boxes) {
      const distance = Math.abs(box.y + box.h / 2 - middle);
      if (distance < bestDistance) { best = box; bestDistance = distance; }
    }
    return best ? { segment: segmentNumber(best.ref), word: Number(best.wordIndex) || 0 } : null;
  }

  // Groups marker positions (fractions of the page) that are close enough to overlap into one
  // marker with a count, so several threads about the same few words are one tap target.
  // Points are { x, y, id }. Returns [{ x, y, ids: [...] }], top to bottom.
  function clusterMarkers(points, { dx = 0.04, dy = 0.014 } = {}) {
    const sorted = points.slice().sort((a, b) => a.y - b.y || a.x - b.x);
    const clusters = [];
    for (const point of sorted) {
      const home = clusters.find((c) => Math.abs(c.x - point.x) <= dx && Math.abs(c.y - point.y) <= dy);
      if (home) home.ids.push(point.id);
      else clusters.push({ x: point.x, y: point.y, ids: [point.id] });
    }
    return clusters;
  }

  // Total new messages across an unread map (thread id -> count).
  function unreadTotal(counts) {
    let total = 0;
    for (const value of (counts instanceof Map ? counts.values() : Object.values(counts || {}))) total += Number(value) || 0;
    return total;
  }

  return {
    normalizeText, matchesQuery, escapeLike, filterThreads, isHere, placeFromViewport,
    clusterMarkers, unreadTotal,
    dafKeyFromRef, dafLabelFromRef, segmentNumber, anchorOrder, placeOrder, sortThreads,
    replyCount, timeAgo, hasUnread, mergeMessage, mergeThread, removeThread, quoteSnippet,
    bodyProblem, errorText, runsFromTarget, threadUrl, threadIdFromSearch, presenceCount,
    ERROR_TEXT,
  };
});
