// Signed-in extras: favoriting a daf, resuming playback where a reader left
// off, and syncing overlay/player preferences across devices. Runs as a
// classic deferred script after app.js/catalog.js, sharing their top-level
// bindings (state, parseDafRef, refKey, getCurrentTime, getDuration, seek,
// showToast, formatTime, escapeHtml, $) the same way catalog.js does.
'use strict';

let resumeAttemptToken = 0;

function currentDafInfo() {
  if (!state.dafRef) return null;
  const parsed = parseDafRef(state.dafRef);
  if (!parsed) return null;
  const variant = parsed.variant === 'chazarah' ? 'chazarah' : 'regular';
  return {
    key: refKey(state.dafRef),
    variant,
    display: `${parsed.tractate} ${parsed.daf}${parsed.amud}${variant === 'chazarah' ? ' (Chazarah Daf)' : ''}`,
  };
}

// --- Favorites ---------------------------------------------------------

async function refreshFavoriteButton() {
  const button = $('favoriteButton');
  const auth = window.DafSyncAuth;
  const user = auth?.getUser();
  const info = currentDafInfo();
  if (!user || !info) {
    button.hidden = true;
    return;
  }
  button.hidden = false;
  const { data } = await auth.client
    .from('favorites').select('ref_key')
    .eq('user_id', user.id).eq('ref_key', info.key).eq('variant', info.variant)
    .maybeSingle();
  button.textContent = data ? '★' : '☆';
  button.classList.toggle('is-favorited', Boolean(data));
}

$('favoriteButton').addEventListener('click', async () => {
  const auth = window.DafSyncAuth;
  const user = auth?.getUser();
  const info = currentDafInfo();
  if (!user || !info) return;
  const favorited = $('favoriteButton').classList.contains('is-favorited');
  if (favorited) {
    await auth.client.from('favorites').delete()
      .eq('user_id', user.id).eq('ref_key', info.key).eq('variant', info.variant);
  } else {
    await auth.client.from('favorites')
      .insert({ user_id: user.id, ref_key: info.key, variant: info.variant, ref_display: info.display });
  }
  refreshFavoriteButton();
});

async function openFavoritesDialog() {
  const auth = window.DafSyncAuth;
  const user = auth?.getUser();
  const list = $('favoritesList');
  if (user) {
    const { data, error } = await auth.client
      .from('favorites').select('*').eq('user_id', user.id).order('created_at', { ascending: false });
    if (!error && data?.length) {
      list.innerHTML = data.map((row) => `
        <button type="button" class="favorite-item" data-ref="${escapeHtml(row.ref_display || row.ref_key)}">
          ${escapeHtml(row.ref_display || row.ref_key)}
        </button>`).join('');
      list.querySelectorAll('.favorite-item').forEach((button) => {
        button.addEventListener('click', () => {
          $('favoritesDialog').close();
          loadDaf(button.dataset.ref);
          document.querySelector('.player-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      });
    } else {
      list.innerHTML = '<p class="field-note">No favorites yet. Use the star next to "Current location" while viewing a daf.</p>';
    }
  }
  $('favoritesDialog').showModal();
}

$('myFavoritesButton').addEventListener('click', () => {
  $('accountDropdown').hidden = true;
  openFavoritesDialog();
});
$('closeFavoritesDialog').addEventListener('click', () => $('favoritesDialog').close());

// --- Continue watching (progress) ---------------------------------------

async function tryResumeProgress() {
  const auth = window.DafSyncAuth;
  const user = auth?.getUser();
  const info = currentDafInfo();
  if (!user || !info) return;
  const token = ++resumeAttemptToken;
  const { data } = await auth.client
    .from('progress').select('position_seconds')
    .eq('user_id', user.id).eq('ref_key', info.key).eq('variant', info.variant)
    .maybeSingle();
  if (!data || !(data.position_seconds > 3)) return;

  // The video/YouTube player may not report a duration yet right after a
  // daf just finished loading -- poll briefly rather than seeking blind.
  for (let attempt = 0; attempt < 20; attempt++) {
    if (token !== resumeAttemptToken) return; // a newer daf loaded meanwhile
    if (getDuration() > 0) {
      seek(data.position_seconds);
      showToast(`Resumed ${info.display} from ${formatTime(data.position_seconds)}.`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function saveProgress() {
  const auth = window.DafSyncAuth;
  const user = auth?.getUser();
  const info = currentDafInfo();
  if (!user || !info) return;
  const position = getCurrentTime();
  if (!(position > 0)) return;
  const duration = getDuration();
  auth.client.from('progress').upsert({
    user_id: user.id,
    ref_key: info.key,
    variant: info.variant,
    ref_display: info.display,
    position_seconds: position,
    duration_seconds: duration || null,
    updated_at: new Date().toISOString(),
  }).then(({ error }) => { if (error) console.error('Could not save progress.', error); });
}

setInterval(saveProgress, 8000);
window.addEventListener('pagehide', saveProgress);
document.addEventListener('visibilitychange', () => { if (document.hidden) saveProgress(); });

// --- Saved overlay/player preferences ------------------------------------

const OVERLAY_PREF_IDS = [
  'overlayToggle', 'overlayModeSelect', 'overlayOpacitySlider',
  'overlayOpacityTargetSelect', 'overlayIdleSelect', 'overlayZoomSlider',
];

function readOverlayPrefs() {
  return {
    enabled: $('overlayToggle').checked,
    mode: $('overlayModeSelect').value,
    opacity: $('overlayOpacitySlider').value,
    opacityTarget: $('overlayOpacityTargetSelect').value,
    idleMode: $('overlayIdleSelect').value,
    zoom: $('overlayZoomSlider').value,
  };
}

function applyOverlayPrefs(prefs) {
  if (!prefs) return;
  if (prefs.mode) $('overlayModeSelect').value = prefs.mode;
  if (prefs.opacity != null) $('overlayOpacitySlider').value = prefs.opacity;
  if (prefs.opacityTarget) $('overlayOpacityTargetSelect').value = prefs.opacityTarget;
  if (prefs.idleMode) $('overlayIdleSelect').value = prefs.idleMode;
  if (prefs.zoom != null) $('overlayZoomSlider').value = prefs.zoom;
  if (prefs.enabled != null) $('overlayToggle').checked = prefs.enabled;
  // Re-fire the same events app.js already listens to, so its own state and
  // derived UI (the "overlay-on" class, the transform math) update exactly
  // as if the reader had changed these controls by hand.
  ['overlayModeSelect', 'overlayOpacityTargetSelect', 'overlayIdleSelect'].forEach((id) => $(id).dispatchEvent(new Event('change')));
  ['overlayOpacitySlider', 'overlayZoomSlider'].forEach((id) => $(id).dispatchEvent(new Event('input')));
  $('overlayToggle').dispatchEvent(new Event('change'));
}

let prefsSaveTimer = null;
function schedulePrefsSave() {
  const auth = window.DafSyncAuth;
  const user = auth?.getUser();
  if (!user) return;
  clearTimeout(prefsSaveTimer);
  prefsSaveTimer = setTimeout(() => {
    auth.client.from('preferences')
      .upsert({ user_id: user.id, data: readOverlayPrefs(), updated_at: new Date().toISOString() })
      .then(({ error }) => { if (error) console.error('Could not save preferences.', error); });
  }, 800);
}

OVERLAY_PREF_IDS.forEach((id) => {
  const el = $(id);
  el?.addEventListener('change', schedulePrefsSave);
  el?.addEventListener('input', schedulePrefsSave);
});

async function loadAndApplyPreferences() {
  const auth = window.DafSyncAuth;
  const user = auth?.getUser();
  if (!user) return;
  const { data } = await auth.client.from('preferences').select('data').eq('user_id', user.id).maybeSingle();
  if (data?.data) applyOverlayPrefs(data.data);
}

// --- Wiring ---------------------------------------------------------------

new MutationObserver(() => {
  refreshFavoriteButton();
  tryResumeProgress();
}).observe($('dafTitle'), { childList: true, characterData: true, subtree: true });

window.DafSyncAuth?.onChange(async (user) => {
  refreshFavoriteButton();
  if (user) await loadAndApplyPreferences();
});
