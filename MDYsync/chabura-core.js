'use strict';

// Shared foundation for every Cloud Chabura page.
//
// Extracted when the thread reader (Prompt 4) turned out to need the same
// client handle, viewer lookup and PostgREST error mapping the feed already
// had. Copying them would have guaranteed the drift the Phase 1 audit found
// between chaburah.js and notes.js (§6.4) -- the whole reason notes-format.js
// exists.

(function () {
  function client() {
    const auth = window.DafSyncAuth;
    if (!auth || !auth.client) throw new Error('Sign-in library is not ready.');
    return auth.client;
  }

  function currentUser() {
    return window.DafSyncAuth?.getUser?.() || null;
  }

  // The auth user object (currentUser) carries no display_name -- that's a
  // column on `profiles`, loaded separately (see auth.js's loadProfile) and
  // exposed as DafSyncAuth.getProfile(). Every insert this app makes into a
  // table with a NOT NULL author_display_name needs this, not currentUser()
  // alone: notes.js has done `profile?.display_name || user.email` since the
  // original note/reply composer; this is that same fallback, shared so
  // every Cloud Chabura write path gets it identically rather than each
  // re-deriving it (and, once, forgetting to).
  function currentDisplayName() {
    const user = currentUser();
    if (!user) return null;
    const profile = window.DafSyncAuth?.getProfile?.();
    return profile?.display_name || user.email || null;
  }

  // PostgREST errors are not presentable as-is. Map the ones a reader can
  // actually hit to something that says what to do about it, and keep the
  // original for the console so a real fault is still debuggable.
  function describeError(error) {
    if (!error) return 'Something went wrong.';
    const code = error.code || '';
    if (code === 'PGRST301' || code === '401') return 'Your session expired. Sign in again to continue.';
    if (code === '42501') return 'You do not have permission to do that.';
    if (code === '42P17') return 'The server rejected this request. This is a bug, not something you did.';
    // The highlighted-answer trigger raises 23514 when the chosen reply is not
    // a visible reply on this thread -- which a reader can hit for real by
    // marking an answer that a moderator hides in the same moment.
    if (code === '23514') return 'That reply cannot be used here any more. Reload the thread and try again.';
    if (code === '23505') return 'That has already been recorded.';
    if (error.message && /Failed to fetch|NetworkError/i.test(error.message)) {
      return 'Could not reach the server. Check your connection and try again.';
    }
    return error.message || 'Something went wrong.';
  }

  // Bumped on every user-initiated load. A result whose token is no longer
  // current is discarded -- the cheap, dependency-free equivalent of
  // AbortController for a query builder that does not accept a signal.
  // Each page gets its own counter so the feed and the thread cannot
  // invalidate one another.
  function generations() {
    let current = 0;
    return {
      next() { current += 1; return current; },
      isCurrent(token) { return token === current; },
    };
  }

  window.DafSyncChabura = window.DafSyncChabura || {};
  window.DafSyncChabura.core = { client, currentUser, currentDisplayName, describeError, generations };
})();
