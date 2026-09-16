'use strict';

// Studio admin panel: search profiles by display name and assign (or clear)
// the role_label badge shown next to a poster's name in Cloud Chaburah.
//
// Only wired up on studio/index.html, which ships #profilesList and is
// already gated behind a real admin sign-in (see studio-locked in that
// page) -- everywhere else this file is a no-op, same as notes.js's own
// initModerationQueue. Shares $/escapeHtml/showToast with the rest of
// studio/index.html's plain classic scripts (defined in app.js) rather than
// redeclaring them, matching notes.js's own header on why.
//
// Deliberately its own file rather than folded into notes.js's moderation
// section: those queues are all "hide/unhide a piece of content"; this is a
// different shape entirely (search for a PERSON, set a field on their
// profile), built on profile-data.js rather than the note_documents-style
// queries notes.js already owns.

(function () {
  let profilesRows = [];

  function renderProfilesList() {
    const list = $('profilesList');
    if (!profilesRows.length) {
      list.innerHTML = '<p class="field-note">No profile matches that.</p>';
      return;
    }
    list.innerHTML = profilesRows.map((row) => `
      <div class="note-item" data-id="${row.id}">
        <div class="note-item-head">
          <span class="note-item-author">${escapeHtml(row.display_name || 'Anonymous')}</span>
          <span class="note-item-time">${escapeHtml(row.email)}</span>
        </div>
        <div class="note-mod-actions">
          <input type="text" class="role-label-input" data-id="${row.id}" maxlength="40"
            placeholder="No role label" value="${escapeHtml(row.role_label || '')}">
          <button type="button" class="button secondary small role-label-save" data-id="${row.id}">Save</button>
        </div>
      </div>`).join('');
    list.querySelectorAll('.role-label-save').forEach((button) => {
      button.addEventListener('click', () => saveRoleLabel(button.dataset.id));
    });
  }

  async function saveRoleLabel(id) {
    const input = document.querySelector(`.role-label-input[data-id="${id}"]`);
    const trimmed = input.value.trim();
    try {
      await window.DafSyncProfile.adminSetRoleLabel(id, trimmed || null);
      const row = profilesRows.find((r) => r.id === id);
      if (row) row.role_label = trimmed || null;
      showToast('Saved.', 'normal');
    } catch (error) {
      showToast(window.DafSyncProfile.describeError(error), 'error');
    }
  }

  async function loadProfiles() {
    const list = $('profilesList');
    const search = $('profilesSearch').value.trim();
    if (!search) {
      list.innerHTML = '<p class="field-note">Search for a user to label.</p>';
      profilesRows = [];
      return;
    }
    list.innerHTML = '<p class="field-note">Searching…</p>';
    try {
      profilesRows = await window.DafSyncProfile.adminSearchProfiles(search);
      renderProfilesList();
    } catch (error) {
      list.innerHTML = `<p class="field-note">${escapeHtml(window.DafSyncProfile.describeError(error))}</p>`;
    }
  }

  function initProfilesPanel() {
    const list = $('profilesList');
    if (!list) return; // not on studio -- nothing to attach to

    let searchTimer = null;
    $('profilesSearch').addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(loadProfiles, 250);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initProfilesPanel);
  } else {
    initProfilesPanel();
  }
})();
