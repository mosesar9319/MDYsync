// Public catalog: browse every daf in a tractate and see, at a glance,
// which ones already have a synced shiur -- without needing to guess a
// reference and try loading it. Runs as a classic deferred script after
// app.js, so it shares app.js's top-level `const`/`function` bindings
// directly (refKey, loadDaf, dafOptionsFor, amudimForDaf, syncState,
// showToast, escapeHtml, $) instead of duplicating that logic.
'use strict';

const catalogState = {
  syncedKeys: null, // Set of refKeys published under by-ref/ on the results branch
  loadingSynced: null,
};

async function loadSyncedKeys() {
  if (catalogState.syncedKeys) return catalogState.syncedKeys;
  if (catalogState.loadingSynced) return catalogState.loadingSynced;
  catalogState.loadingSynced = (async () => {
    try {
      const response = await fetch('https://api.github.com/repos/mosesar9319/MDYsync/git/trees/results?recursive=1');
      if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
      const data = await response.json();
      const keys = new Set(
        (data.tree || [])
          .filter((entry) => entry.type === 'blob' && entry.path.startsWith('by-ref/') && entry.path.endsWith('.json'))
          .map((entry) => entry.path.slice('by-ref/'.length, -'.json'.length))
      );
      catalogState.syncedKeys = keys;
      return keys;
    } catch (error) {
      console.error('Could not check sync status.', error);
      catalogState.syncedKeys = new Set();
      return catalogState.syncedKeys;
    }
  })();
  return catalogState.loadingSynced;
}

// Checks all four variant/language combinations for a daf. Order here also
// sets which one a catalog-cell click lands on when more than one is
// synced (regular English first, since that's the player's own default
// picker state) -- see renderCatalogGrid below.
const CATALOG_COMBOS = [
  { key: 'regularEn', suffix: '' },
  { key: 'chazarahEn', suffix: ' (Chazarah Daf)' },
  { key: 'regularHe', suffix: ' (Hebrew)' },
  { key: 'chazarahHe', suffix: ' (Chazarah Daf) (Hebrew)' },
];

function dafCellStatus(tractate, daf, amud, syncedKeys) {
  const status = {};
  for (const combo of CATALOG_COMBOS) {
    status[combo.key] = syncedKeys.has(refKey(`${tractate} ${daf}${amud}${combo.suffix}`));
  }
  return status;
}

async function renderCatalogGrid() {
  const grid = $('catalogGrid');
  const note = $('catalogStatusNote');
  const tractateName = $('catalogTractateSelect').value;
  const entry = syncState.talmudByName[tractateName];
  if (!entry) return;

  const syncedKeys = await loadSyncedKeys();
  const dafNumbers = dafOptionsFor(entry);
  const isAdmin = Boolean(window.DafSyncAuth?.isAdmin());

  const cells = [];
  for (const daf of dafNumbers) {
    for (const amud of amudimForDaf(entry, daf)) {
      const status = dafCellStatus(tractateName, daf, amud, syncedKeys);
      const primary = CATALOG_COMBOS.find((combo) => status[combo.key]);
      const synced = Boolean(primary);
      const hasChazarah = status.chazarahEn || status.chazarahHe;
      const hasHebrew = status.regularHe || status.chazarahHe;
      const primaryRef = `${tractateName} ${daf}${amud}${primary ? primary.suffix : ''}`;
      cells.push(`
        <button type="button" class="catalog-cell ${synced ? 'synced' : 'coming-soon'}"
                data-daf="${daf}" data-amud="${amud}" data-synced="${synced ? '1' : '0'}"
                data-primary-ref="${escapeHtml(primaryRef)}">
          ${daf}${amud}
          ${hasChazarah ? '<i class="catalog-swatch chazarah-dot" title="Chazarah Daf available"></i>' : ''}
          ${hasHebrew ? '<i class="catalog-swatch hebrew-dot" title="Hebrew shiur available"></i>' : ''}
        </button>`);
    }
  }
  grid.innerHTML = cells.join('');
  const syncedCount = [...grid.querySelectorAll('.catalog-cell.synced')].length;
  note.textContent = `${syncedCount} of ${grid.querySelectorAll('.catalog-cell').length} dapim synced in ${tractateName}.`;

  grid.querySelectorAll('.catalog-cell').forEach((cell) => {
    cell.addEventListener('click', () => {
      const synced = cell.dataset.synced === '1';
      if (!synced && !isAdmin) {
        showToast('This daf has not been synced yet.');
        return;
      }
      const ref = cell.dataset.primaryRef || `${tractateName} ${cell.dataset.daf}${cell.dataset.amud}`;
      loadDaf(ref);
      document.querySelector('.player-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

function initCatalog() {
  const toggleButton = $('catalogToggleButton');
  const body = $('catalogBody');
  toggleButton.addEventListener('click', () => {
    const hidden = body.hasAttribute('hidden');
    if (hidden) body.removeAttribute('hidden'); else body.setAttribute('hidden', '');
    toggleButton.textContent = hidden ? 'Hide' : 'Show';
  });

  $('catalogTractateSelect').addEventListener('change', renderCatalogGrid);
  window.DafSyncAuth?.onChange(() => renderCatalogGrid());

  (async () => {
    await loadTalmudIndex();
    const select = $('catalogTractateSelect');
    select.innerHTML = syncState.tractateNames
      .map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
    await renderCatalogGrid();
  })();
}

async function loadSeriesInfo() {
  try {
    const auth = window.DafSyncAuth;
    if (!auth) return;
    await auth.ready;
    const { data, error } = await auth.client
      .from('series')
      .select('*')
      .order('sort_order', { ascending: true });
    if (error || !data?.length) return;
    const series = data[0];
    $('catalogSeriesEyebrow').textContent = series.speaker ? `Series · ${series.speaker}` : 'Series';
    $('catalogSeriesName').textContent = series.name;
    $('catalogSeriesDesc').textContent = series.description || '';
  } catch (error) {
    console.error('Could not load series info.', error);
  }
}

initCatalog();
loadSeriesInfo();
