'use strict';

// Studio admin panel: the most recently registered accounts, newest first.
//
// Only wired up on studio/index.html, which ships #newAccountsList and is
// already gated behind a real admin sign-in (see studio-locked in that
// page) -- everywhere else this file is a no-op, same as studio-profiles.js's
// own initProfilesPanel. Shares $/escapeHtml/showToast with the rest of
// studio/index.html's plain classic scripts (defined in app.js), and
// formatNoteTime from notes-format.js for the "X min/hr ago" timestamp,
// rather than redeclaring either.
//
// Own file rather than folded into studio-profiles.js: that panel searches
// for a person by name; this one lists everyone in signup order with no
// search input at all -- close enough in shape to profiles that it shares
// the same data layer (profile-data.js), but different enough in behavior
// (load-on-open + Refresh, not search-as-you-type) to keep as its own
// controller, matching that file's own header on why panels of different
// shapes get their own file.

(function () {
  const RECENT_SIGNUPS_LIMIT = 30;

  function renderNewAccountsList(rows) {
    const list = $('newAccountsList');
    if (!rows.length) {
      list.innerHTML = '<p class="field-note">No accounts yet.</p>';
      return;
    }
    list.innerHTML = rows.map((row) => `
      <div class="note-item" data-id="${row.id}">
        <div class="note-item-head">
          <span class="note-item-author">${escapeHtml(row.display_name || 'Anonymous')}</span>
          <span class="note-item-time">${escapeHtml(formatNoteTime(row.created_at))}</span>
        </div>
        <p class="field-note">${escapeHtml(row.email)}</p>
      </div>`).join('');
  }

  async function loadNewAccounts() {
    const list = $('newAccountsList');
    list.innerHTML = '<p class="field-note">Loading…</p>';
    try {
      const rows = await window.DafSyncProfile.adminListRecentSignups(RECENT_SIGNUPS_LIMIT);
      renderNewAccountsList(rows);
    } catch (error) {
      list.innerHTML = `<p class="field-note">${escapeHtml(window.DafSyncProfile.describeError(error))}</p>`;
    }
  }

  function initNewAccountsPanel() {
    const list = $('newAccountsList');
    if (!list) return; // not on studio -- nothing to attach to

    $('refreshNewAccountsButton').addEventListener('click', loadNewAccounts);
    // Mirrors initModerationQueue's own load trigger: admin status isn't
    // known synchronously on page load, so wait for auth to actually
    // confirm it rather than firing (and likely failing) a query first.
    window.DafSyncAuth?.onChange((user, profile) => {
      if (user && profile?.is_admin) loadNewAccounts();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initNewAccountsPanel);
  } else {
    initNewAccountsPanel();
  }
})();
