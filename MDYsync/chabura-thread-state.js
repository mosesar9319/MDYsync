'use strict';

// Normalized thread state: the single source of truth the view renders from.
//
// Comments arrive from several places -- the first branch page, a descendant
// batch, a permalink branch, an optimistic insert, an edit -- and the same row
// can arrive twice. Keeping one map keyed by id, plus a children index, is what
// makes those merges idempotent and keeps the tree honest.
//
// Two invariants the plan states explicitly and this file enforces:
//   * True parent-child relationships are preserved. Nothing here flattens a
//     reply onto the root just because it is deep.
//   * Sorting top-level branches NEVER reorders children. Sorting applies to
//     the roots array only; every childrenByParent list stays chronological,
//     because scrambling replies inside a branch destroys the argument.

(function () {
  // Indentation steps, NOT stored depth. The plan caps stored depth at four
  // levels (depth 0..3) and asks indentation to stop increasing "after 2-3
  // desktop levels and after 1 mobile level" -- so a desktop cap of 3 would
  // never actually fire on a four-level thread. Two means depths 0,1,2 each get
  // their own rail and depth 3 onwards is held at that inset, with the parent
  // named in words instead.
  const MAX_INDENT_DESKTOP = 2;
  const MAX_INDENT_MOBILE = 1;

  function createState() {
    return {
      note: null,
      reason: null,              // null | 'sign-in-required' | 'not-found-or-private'
      commentsById: new Map(),
      childrenByParent: new Map(), // parentId ('' for top level) -> [ids] chronological
      profiles: new Map(),
      reactions: new Map(),      // targetId -> { counts: Map, mine: Set }
      collapsed: new Set(),      // root branch ids the viewer collapsed
      branchCursor: null,
      hasMoreBranches: false,
      loadedBranchRoots: new Set(),
      permalinkTarget: null,
      permalinkPending: false,
      viewer: { isFollowed: false, isSaved: false, lastReadSequence: 0, isAdmin: false },
      savedComments: new Set(),   // individually saved replies
      currentBranchId: null,      // where the reader is, for the outline
      newReplies: [],             // arrived while reading, not yet inserted
      sort: 'conversation',      // conversation | newest | helpful
      search: '',
      searchMatches: [],
      searchIndex: -1,
      loading: true,
      error: null,
    };
  }

  const TOP = '';

  function indexComment(state, row) {
    const existing = state.commentsById.get(row.id);
    state.commentsById.set(row.id, existing ? { ...existing, ...row } : row);
    if (existing) return; // already in the children index; merging must not duplicate it

    const parent = row.parent_comment_id || TOP;
    if (!state.childrenByParent.has(parent)) state.childrenByParent.set(parent, []);
    state.childrenByParent.get(parent).push(row.id);
  }

  // Children stay chronological, always. Called after a merge because rows can
  // arrive out of order (a permalink branch before the branch page that would
  // have contained it).
  function sortChildren(state, parentId) {
    const ids = state.childrenByParent.get(parentId);
    if (!ids || ids.length < 2) return;
    ids.sort((a, b) => {
      const left = state.commentsById.get(a);
      const right = state.commentsById.get(b);
      if (!left || !right) return 0;
      if (left.created_at === right.created_at) return left.id < right.id ? -1 : 1;
      return left.created_at < right.created_at ? -1 : 1;
    });
  }

  function mergeComments(state, rows) {
    const touched = new Set();
    (rows || []).forEach((row) => {
      indexComment(state, row);
      touched.add(row.parent_comment_id || TOP);
    });
    touched.forEach((parent) => sortChildren(state, parent));
  }

  // Removes an optimistic row that the server rejected. Only ever called for a
  // row this client invented, which by definition has no children yet.
  function removeComment(state, commentId) {
    const row = state.commentsById.get(commentId);
    if (!row) return;
    state.commentsById.delete(commentId);
    const parent = row.parent_comment_id || TOP;
    const siblings = state.childrenByParent.get(parent);
    if (siblings) {
      const index = siblings.indexOf(commentId);
      if (index >= 0) siblings.splice(index, 1);
    }
    state.childrenByParent.delete(commentId);
  }

  function topLevelIds(state) {
    return state.childrenByParent.get(TOP) || [];
  }

  function childIds(state, commentId) {
    return state.childrenByParent.get(commentId) || [];
  }

  // Every descendant of a branch, depth-first in reading order.
  function descendantIds(state, rootId) {
    const out = [];
    const walk = (id) => {
      childIds(state, id).forEach((childId) => { out.push(childId); walk(childId); });
    };
    walk(rootId);
    return out;
  }

  function branchStats(state, rootId) {
    const ids = descendantIds(state, rootId);
    let unread = 0;
    ids.concat([rootId]).forEach((id) => {
      const row = state.commentsById.get(id);
      if (row && row.activity_sequence > state.viewer.lastReadSequence) unread += 1;
    });
    return { replies: ids.length, unread };
  }

  // A row the viewer must not read the content of, but whose position in the
  // tree still matters because visible replies hang beneath it.
  function isTombstone(row) {
    return Boolean(row && (row.deleted_at || row.hidden));
  }

  function tombstoneLabel(row) {
    // Public copy stays restrained and does not distinguish who removed it;
    // the distinction is kept in the data for moderation, not shown here.
    if (row.deleted_at) return 'This reply was deleted by its author.';
    return 'This reply was removed by a moderator.';
  }

  // Indentation stops increasing past the cap; deeper replies stay connected by
  // a "Replying to X" line instead of an ever-narrowing column.
  function indentLevel(depth, isMobile) {
    const cap = isMobile ? MAX_INDENT_MOBILE : MAX_INDENT_DESKTOP;
    return Math.min(depth, cap);
  }

  function isIndentCapped(depth, isMobile) {
    return depth > (isMobile ? MAX_INDENT_MOBILE : MAX_INDENT_DESKTOP);
  }

  // Ordering applies to top-level branches ONLY (see the file header).
  function orderedTopLevel(state) {
    const ids = topLevelIds(state).slice();
    if (state.sort === 'newest') {
      ids.sort((a, b) => lastActivity(state, b) - lastActivity(state, a));
    } else if (state.sort === 'helpful') {
      ids.sort((a, b) => {
        const diff = reactionTotal(state, b) - reactionTotal(state, a);
        if (diff !== 0) return diff;
        return lastActivity(state, a) - lastActivity(state, b);
      });
    }
    return ids;
  }

  function lastActivity(state, rootId) {
    let newest = 0;
    [rootId].concat(descendantIds(state, rootId)).forEach((id) => {
      const row = state.commentsById.get(id);
      if (!row) return;
      const at = Date.parse(row.created_at);
      if (!Number.isNaN(at) && at > newest) newest = at;
    });
    return newest;
  }

  function reactionTotal(state, commentId) {
    const entry = state.reactions.get(commentId);
    if (!entry) return 0;
    let total = 0;
    entry.counts.forEach((count) => { total += count; });
    return total;
  }

  function ancestorIds(state, commentId) {
    const chain = [];
    let row = state.commentsById.get(commentId);
    while (row && row.parent_comment_id) {
      chain.unshift(row.parent_comment_id);
      row = state.commentsById.get(row.parent_comment_id);
    }
    return chain;
  }

  // Opening a permalink must reveal the target: every collapsed ancestor
  // branch is expanded, not just the immediate one.
  function expandAncestors(state, commentId) {
    const row = state.commentsById.get(commentId);
    if (row) state.collapsed.delete(row.root_comment_id);
    ancestorIds(state, commentId).forEach((id) => state.collapsed.delete(id));
  }

  function participants(state) {
    const seen = new Map();
    if (state.note && state.note.author_id) {
      seen.set(state.note.author_id, state.note.author_display_name || 'Anonymous');
    }
    state.commentsById.forEach((row) => {
      if (isTombstone(row)) return; // a removed reply does not advertise its author
      if (row.author_id && !seen.has(row.author_id)) {
        // Never an id: it is a private identifier, and a mention chip or
        // participant list showing one would leak it to every reader.
        seen.set(row.author_id, (row.author_display_name || '').trim() || 'A member');
      }
    });
    return [...seen.entries()].map(([id, name]) => ({ id, name }));
  }

  function unreadIds(state) {
    const out = [];
    const walkTop = (ids) => ids.forEach((id) => {
      const row = state.commentsById.get(id);
      if (row && row.activity_sequence > state.viewer.lastReadSequence) out.push(id);
      walkTop(childIds(state, id));
    });
    walkTop(orderedTopLevel(state));
    return out;
  }

  function highestSequence(state) {
    let highest = 0;
    state.commentsById.forEach((row) => {
      if (row.activity_sequence > highest) highest = row.activity_sequence;
    });
    return highest;
  }

  // Search runs over what is loaded, and says so in the UI -- it never implies
  // it searched replies that were never fetched.
  function runSearch(state, term) {
    state.search = term;
    state.searchMatches = [];
    state.searchIndex = -1;
    const needle = term.trim().toLowerCase();
    if (!needle) return;
    const consider = (id, row) => {
      if (isTombstone(row)) return;
      if (String(row.body || '').toLowerCase().includes(needle)) state.searchMatches.push(id);
    };
    const walk = (ids) => ids.forEach((id) => {
      const row = state.commentsById.get(id);
      if (row) consider(id, row);
      walk(childIds(state, id));
    });
    walk(orderedTopLevel(state));
    if (state.searchMatches.length) state.searchIndex = 0;
  }

  window.DafSyncChabura = window.DafSyncChabura || {};
  window.DafSyncChabura.threadState = {
    TOP,
    MAX_INDENT_DESKTOP,
    MAX_INDENT_MOBILE,
    createState,
    mergeComments,
    removeComment,
    topLevelIds,
    childIds,
    descendantIds,
    branchStats,
    isTombstone,
    tombstoneLabel,
    indentLevel,
    isIndentCapped,
    orderedTopLevel,
    reactionTotal,
    ancestorIds,
    expandAncestors,
    participants,
    unreadIds,
    highestSequence,
    runSearch,
  };
})();
