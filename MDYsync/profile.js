'use strict';

// /profile/ page controller: the signed-in reader's own display name and
// avatar, plus a "how this appears" preview. See profile-data.js for the
// full authorization model this relies on.

(function () {
  const els = {};
  function cacheEls() {
    [
      'pfStatus', 'pfSignedOut', 'pfProfile',
      'pfAvatarPreview', 'pfAvatarControls', 'pfChangeAvatarButton',
      'pfForm', 'pfDisplayName', 'pfRoleLabelNote', 'pfError', 'pfSaveButton', 'pfSaveStatus',
      'pfPreviewAvatar', 'pfPreviewName', 'pfPreviewRole',
      'pfAvatarDialog', 'pfAvatarClose', 'pfAvatarFile', 'pfCropWrap', 'pfCropCanvas', 'pfCropZoom',
      'pfAvatarError', 'pfAvatarCancel', 'pfAvatarSave',
    ].forEach((id) => { els[id] = document.getElementById(id); });
  }

  function announce(message) {
    if (els.pfStatus) els.pfStatus.textContent = message;
  }

  const data = () => window.DafSyncProfile;

  // Same shape as chabura-thread-view.js's own initials() -- not shared,
  // since this page does not otherwise load that file, and it is three
  // lines either way.
  function initials(name) {
    return String(name || 'Anonymous').trim().split(/\s+/).slice(0, 2)
      .map((part) => part[0] || '').join('').toUpperCase() || '?';
  }

  // Renders either the profile's avatar image or an initials fallback into
  // a .pf-avatar-preview element. A broken image URL (a deleted Storage
  // object, a network hiccup) falls back to initials rather than showing a
  // broken-image icon.
  function renderAvatarInto(el, profile) {
    if (!el) return;
    el.innerHTML = '';
    if (profile?.avatar_path) {
      const img = document.createElement('img');
      img.src = profile.avatar_path;
      img.alt = '';
      img.addEventListener('error', () => {
        img.remove();
        el.textContent = initials(profile.display_name);
      });
      el.appendChild(img);
    } else {
      el.textContent = initials(profile?.display_name);
    }
  }

  let currentProfile = null;

  function renderProfile() {
    els.pfDisplayName.value = currentProfile?.display_name || '';
    renderAvatarInto(els.pfAvatarPreview, currentProfile);
    renderAvatarInto(els.pfPreviewAvatar, currentProfile);
    els.pfPreviewName.textContent = currentProfile?.display_name || 'Anonymous';
    if (currentProfile?.role_label) {
      els.pfRoleLabelNote.hidden = false;
      els.pfRoleLabelNote.textContent = `Role label: ${currentProfile.role_label} (assigned by an admin)`;
      els.pfPreviewRole.hidden = false;
      els.pfPreviewRole.textContent = currentProfile.role_label;
    } else {
      els.pfRoleLabelNote.hidden = true;
      els.pfPreviewRole.hidden = true;
    }
  }

  async function loadProfile() {
    const user = window.DafSyncChabura.core.currentUser();
    if (!user) {
      els.pfSignedOut.hidden = false;
      els.pfProfile.hidden = true;
      return;
    }
    els.pfSignedOut.hidden = true;
    els.pfProfile.hidden = false;
    try {
      currentProfile = await data().fetchOwnProfile();
      renderProfile();
    } catch (error) {
      announce(data().describeError(error));
    }
  }

  async function onSaveProfile(event) {
    event.preventDefault();
    els.pfError.hidden = true;
    els.pfSaveStatus.textContent = '';
    const trimmed = els.pfDisplayName.value.trim();
    if (!trimmed) {
      els.pfError.textContent = 'Enter a display name.';
      els.pfError.hidden = false;
      return;
    }
    if (trimmed.length > data().DISPLAY_NAME_MAX) {
      els.pfError.textContent = `That is ${trimmed.length} characters; the limit is ${data().DISPLAY_NAME_MAX}.`;
      els.pfError.hidden = false;
      return;
    }
    els.pfSaveButton.disabled = true;
    els.pfSaveStatus.textContent = 'Saving…';
    try {
      await data().updateDisplayName(trimmed);
      currentProfile = { ...currentProfile, display_name: trimmed };
      renderProfile();
      els.pfSaveStatus.textContent = 'Saved.';
    } catch (error) {
      els.pfError.textContent = data().describeError(error);
      els.pfError.hidden = false;
      els.pfSaveStatus.textContent = '';
    } finally {
      els.pfSaveButton.disabled = false;
    }
  }

  // --- Avatar crop widget --------------------------------------------------
  //
  // Its own small pan/zoom widget rather than reusing player/scan-live.js's
  // reposition UI -- that one is a state machine built around OCR daf
  // matching (see its own header); this needs none of that, just "give me
  // back a fixed-size square crop of whatever photo was picked". The canvas
  // IS the output: its pixel dimensions (CROP_SIZE) are exactly what gets
  // uploaded, so there is no separate export-resolution step.

  const CROP_SIZE = 320;
  let cropImage = null;
  let cropScale = 1;
  let cropMinScale = 1;
  let cropOffsetX = 0;
  let cropOffsetY = 0;
  let dragging = false;
  let dragStart = null;

  function openAvatarDialog() {
    els.pfAvatarError.hidden = true;
    els.pfAvatarFile.value = '';
    els.pfCropWrap.hidden = true;
    els.pfAvatarSave.disabled = true;
    cropImage = null;
    els.pfAvatarDialog.showModal();
  }

  function onAvatarFileChange() {
    const file = els.pfAvatarFile.files[0];
    if (!file) return;
    els.pfAvatarError.hidden = true;
    const img = new Image();
    img.onload = () => {
      cropImage = img;
      // The minimum zoom that still fully covers the square viewport --
      // whichever of the image's two dimensions is the tighter fit.
      cropMinScale = Math.max(CROP_SIZE / img.width, CROP_SIZE / img.height);
      cropScale = cropMinScale;
      cropOffsetX = 0;
      cropOffsetY = 0;
      els.pfCropZoom.min = String(cropMinScale);
      els.pfCropZoom.max = String(cropMinScale * 4);
      els.pfCropZoom.step = String((cropMinScale * 4 - cropMinScale) / 200 || 0.001);
      els.pfCropZoom.value = String(cropMinScale);
      els.pfCropZoom.disabled = false;
      els.pfCropWrap.hidden = false;
      els.pfAvatarSave.disabled = false;
      drawCrop();
    };
    img.onerror = () => {
      els.pfAvatarError.textContent = 'Could not read that image.';
      els.pfAvatarError.hidden = false;
    };
    img.src = URL.createObjectURL(file);
  }

  // Keeps the image covering the whole viewport at all times -- panning
  // can never drag the photo's edge into view, so every save is a full
  // square, never a crop with blank corners.
  function clampOffsets() {
    const scaledW = cropImage.width * cropScale;
    const scaledH = cropImage.height * cropScale;
    const maxX = Math.max(0, (scaledW - CROP_SIZE) / 2);
    const maxY = Math.max(0, (scaledH - CROP_SIZE) / 2);
    cropOffsetX = Math.min(maxX, Math.max(-maxX, cropOffsetX));
    cropOffsetY = Math.min(maxY, Math.max(-maxY, cropOffsetY));
  }

  function drawCrop() {
    if (!cropImage) return;
    clampOffsets();
    const ctx = els.pfCropCanvas.getContext('2d');
    ctx.clearRect(0, 0, CROP_SIZE, CROP_SIZE);
    const scaledW = cropImage.width * cropScale;
    const scaledH = cropImage.height * cropScale;
    const x = (CROP_SIZE - scaledW) / 2 + cropOffsetX;
    const y = (CROP_SIZE - scaledH) / 2 + cropOffsetY;
    ctx.drawImage(cropImage, x, y, scaledW, scaledH);
  }

  function onCropZoomInput() {
    cropScale = Number(els.pfCropZoom.value);
    drawCrop();
  }

  function onCropPointerDown(event) {
    if (!cropImage) return;
    dragging = true;
    dragStart = { x: event.clientX, y: event.clientY, offsetX: cropOffsetX, offsetY: cropOffsetY };
    els.pfCropCanvas.setPointerCapture(event.pointerId);
  }

  function onCropPointerMove(event) {
    if (!dragging) return;
    cropOffsetX = dragStart.offsetX + (event.clientX - dragStart.x);
    cropOffsetY = dragStart.offsetY + (event.clientY - dragStart.y);
    drawCrop();
  }

  function onCropPointerUp(event) {
    dragging = false;
    try { els.pfCropCanvas.releasePointerCapture(event.pointerId); } catch { /* already released */ }
  }

  async function onSaveAvatar() {
    if (!cropImage) return;
    els.pfAvatarError.hidden = true;
    els.pfAvatarSave.disabled = true;
    try {
      const blob = await new Promise((resolve, reject) => {
        els.pfCropCanvas.toBlob(
          (result) => (result ? resolve(result) : reject(new Error('Could not process that image.'))),
          'image/webp', 0.9);
      });
      const url = await data().uploadAvatar(blob, 'webp');
      currentProfile = { ...currentProfile, avatar_path: url };
      renderProfile();
      els.pfAvatarDialog.close();
    } catch (error) {
      els.pfAvatarError.textContent = data().describeError(error);
      els.pfAvatarError.hidden = false;
    } finally {
      els.pfAvatarSave.disabled = false;
    }
  }

  // --- Init ----------------------------------------------------------------

  function init() {
    cacheEls();
    if (!els.pfProfile) return; // page doesn't ship the profile UI

    els.pfForm.addEventListener('submit', onSaveProfile);
    els.pfChangeAvatarButton.addEventListener('click', openAvatarDialog);
    els.pfAvatarClose.addEventListener('click', () => els.pfAvatarDialog.close());
    els.pfAvatarCancel.addEventListener('click', () => els.pfAvatarDialog.close());
    els.pfAvatarFile.addEventListener('change', onAvatarFileChange);
    els.pfCropZoom.addEventListener('input', onCropZoomInput);
    els.pfCropCanvas.addEventListener('pointerdown', onCropPointerDown);
    els.pfCropCanvas.addEventListener('pointermove', onCropPointerMove);
    els.pfCropCanvas.addEventListener('pointerup', onCropPointerUp);
    els.pfCropCanvas.addEventListener('pointerleave', onCropPointerUp);
    els.pfAvatarSave.addEventListener('click', onSaveAvatar);

    window.DafSyncAuth?.onChange(() => loadProfile());
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
