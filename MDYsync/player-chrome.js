// The video player's own chrome: the bar across the top of the frame (brand,
// which daf is loaded, bookmark/notes/more) and the redesigned control bar
// beneath it -- labelled transport controls, chapter markers on the timeline,
// and the two "where does the daf go" toggles.
//
// Rendered here, in one shared script, rather than hand-written into each
// page's HTML. The player markup is embedded verbatim in FOUR pages (player/,
// watch/, browse/, studio/) that already have to keep the same element ids in
// sync by hand; this redesign adds enough new chrome that a fifth
// hand-maintained copy would be a real drift risk. nav.js already takes the
// same approach for the sitewide navigation, and this loads the same way
// (a plain deferred script, after app.js -- so app.js's own top-level
// declarations are already in the global scope this reads them from).
//
// Deliberately ADDITIVE: every control app.js wires by id (#playButton,
// #scrubber, #overlayToggle, #readingModeButton, ...) keeps its id and its
// existing listeners. This moves those nodes into new layout groups and adds
// new controls that DRIVE the existing ones -- clicking "Daf on video" checks
// #overlayToggle and fires its change event, rather than reimplementing what
// that toggle does -- so each feature still has exactly one implementation,
// and app.js stays its owner. Moving a node never drops its listeners, so
// the regrouping below is purely visual.

(() => {
  const $ = (id) => document.getElementById(id);
  const frame = $('videoFrame');
  // Every page that ships the player has #videoFrame; the rest of the site
  // (home, favorites, the standalone dialogs) loads this script harmlessly.
  if (!frame) return;

  const svg = (paths, extra = '') =>
    `<svg viewBox="0 0 24 24" aria-hidden="true" ${extra}>${paths}</svg>`;
  const STROKE = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';

  const ICONS = {
    chevron: svg(`<path d="m6 9 6 6 6-6" ${STROKE}/>`),
    bookmark: svg(`<path d="M6 3h12v18l-6-4.4L6 21V3Z" ${STROKE}/>`),
    notes: svg(`<rect x="4" y="3" width="16" height="18" rx="2" ${STROKE}/><path d="M8 8h8M8 12h8M8 16h5" ${STROKE}/>`),
    more: svg(`<circle cx="5" cy="12" r="1.7" fill="currentColor"/><circle cx="12" cy="12" r="1.7" fill="currentColor"/><circle cx="19" cy="12" r="1.7" fill="currentColor"/>`),
    // The seek buttons were bare "−10"/"+10" text; the mockup's circular
    // arrow wrapping the number reads as "jump back/forward by 10" without
    // depending on the reader parsing a signed number.
    back10: svg(`<path d="M11.5 5.5A7.5 7.5 0 1 1 4.6 10" ${STROKE}/><path d="M4 5.2v5h5" ${STROKE}/><text x="12.4" y="16" text-anchor="middle" font-size="8.4" font-weight="800" fill="currentColor" font-family="Assistant, system-ui, sans-serif">10</text>`),
    forward10: svg(`<path d="M12.5 5.5A7.5 7.5 0 1 0 19.4 10" ${STROKE}/><path d="M20 5.2v5h-5" ${STROKE}/><text x="11.6" y="16" text-anchor="middle" font-size="8.4" font-weight="800" fill="currentColor" font-family="Assistant, system-ui, sans-serif">10</text>`),
    // A video frame with daf lines inside it -- the Vilna page drawn ON the
    // video. Its counterpart below is the same relationship the other way up.
    dafOnVideo: svg(`<rect x="2.5" y="4.5" width="19" height="15" rx="2.2" ${STROKE}/><path d="M6.5 9h11M6.5 12h11M6.5 15h7" ${STROKE}/>`),
    // Matches #readingModeButton's own glyph (a page with a small video
    // inset) -- same feature, so the same picture.
    videoOnDaf: svg(`<rect x="3" y="4" width="18" height="16" rx="2" ${STROKE}/><rect x="5.5" y="12" width="8.5" height="5.5" rx="1" fill="currentColor" opacity=".25"/><path d="m9 13.4 3.2 1.85L9 17.1v-3.7Z" fill="currentColor"/><path d="M7 8h10" ${STROKE}/>`),
    pip: svg(`<rect x="2.5" y="4.5" width="19" height="15" rx="2.2" ${STROKE}/><rect x="12" y="11.5" width="8" height="6.5" rx="1.4" fill="currentColor"/>`),
  };

  // --- The bar across the top of the video ---------------------------------
  // Absolutely positioned inside .video-frame (not above it in page flow) for
  // the same reason the control bar already is: only .video-frame's own
  // descendants render in native fullscreen, and it auto-hides with the rest
  // of the chrome via .controls-hidden.

  const topbar = document.createElement('div');
  topbar.className = 'player-topbar';
  topbar.id = 'playerTopbar';
  // Studio is an authoring workspace whose daf picker is part of the admin
  // setup strip's own workflow -- relocating it into the video chrome there
  // would pull a core authoring control out of the surface it belongs to, so
  // studio gets the same top bar with a plain, non-interactive daf label.
  const isStudio = location.pathname.includes('/studio');
  const hasNotes = Boolean($('noteDialog'));
  topbar.innerHTML = `
    <div class="player-topbar-group">
      <span class="player-brand"><img src="/assets/dafsync-mark.svg" alt="" /><span>DafSync</span></span>
      <span class="player-topbar-rule"></span>
      <button class="player-daf-button" id="playerDafButton" type="button" aria-expanded="false" ${isStudio ? 'disabled' : ''}>
        <span id="playerDafLabel">No daf loaded</span>
        ${isStudio ? '' : `<span class="player-daf-chevron">${ICONS.chevron}</span>`}
      </button>
      <span class="player-topbar-rule player-topbar-rule-he"></span>
      <span class="player-daf-hebrew" id="playerDafHebrew" dir="rtl" lang="he"></span>
    </div>
    <div class="player-topbar-group player-topbar-actions">
      <button class="player-chrome-button" id="playerBookmarkButton" type="button" aria-pressed="false">${ICONS.bookmark}<span>Bookmark</span></button>
      <button class="player-chrome-button" id="playerNotesButton" type="button" ${hasNotes ? '' : 'hidden'}>${ICONS.notes}<span>Notes</span></button>
      <button class="player-chrome-button" id="playerMoreButton" type="button" aria-expanded="false">${ICONS.more}<span>More</span></button>
    </div>
    <div class="player-chrome-menu player-daf-menu" id="playerDafMenu" hidden></div>
    <div class="player-chrome-menu player-more-menu" id="playerMoreMenu" hidden></div>
  `;
  frame.appendChild(topbar);

  // The daf dropdown hosts the page's REAL picker rather than a second copy
  // of it: .ref-field's selects/toggles (#dafTractateSelect, #dafDafSelect,
  // #dafAmudToggle, ...) are moved in wholesale, keeping every id and every
  // listener app.js already attached to them. On the reader-facing pages that
  // picker otherwise sits inside .setup-strip, which those pages hide from
  // non-admins outright -- so this is the first time a reader can actually
  // reach it.
  const refField = !isStudio && document.querySelector('.setup-field.ref-field');
  const dafMenu = $('playerDafMenu');
  if (refField) dafMenu.appendChild(refField);
  else $('playerDafButton').disabled = true;

  // "More" proxies to the page's existing overflow actions by clicking them,
  // so Share/How-it-works keep their own single implementation. Neither is on
  // every page (only player/ ships a share button), hence building the list
  // from whichever ones are actually present.
  const moreMenu = $('playerMoreMenu');
  const moreItems = [
    { id: 'share-button', label: 'Share this daf' },
    { id: 'helpButton', label: 'How it works' },
  ].filter((item) => $(item.id));
  for (const item of moreItems) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'player-chrome-menu-item';
    button.textContent = item.label;
    button.addEventListener('click', () => {
      closeMenus();
      $(item.id).click();
    });
    moreMenu.appendChild(button);
  }
  if (!moreItems.length) $('playerMoreButton').hidden = true;

  function closeMenus(except = null) {
    for (const [menuId, buttonId] of [['playerDafMenu', 'playerDafButton'], ['playerMoreMenu', 'playerMoreButton']]) {
      if (menuId === except) continue;
      $(menuId).hidden = true;
      $(buttonId).setAttribute('aria-expanded', 'false');
    }
  }
  function toggleMenu(menuId, buttonId) {
    const menu = $(menuId);
    const opening = menu.hidden;
    closeMenus(opening ? menuId : null);
    menu.hidden = !opening;
    $(buttonId).setAttribute('aria-expanded', String(opening));
  }
  $('playerDafButton').addEventListener('click', () => toggleMenu('playerDafMenu', 'playerDafButton'));
  $('playerMoreButton').addEventListener('click', () => toggleMenu('playerMoreMenu', 'playerMoreButton'));
  document.addEventListener('click', (event) => {
    if (!topbar.contains(event.target)) closeMenus();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenus();
  });

  // Bookmark and Notes both defer to the page's existing implementations --
  // #favoriteButton (account-features.js, which owns the signed-in/out and
  // saved/not-saved states) and window.DafNotes (notes.js).
  $('playerBookmarkButton').addEventListener('click', () => $('favoriteButton')?.click());
  $('playerNotesButton').addEventListener('click', () => {
    const segment = state.segments[state.activeIndex];
    window.DafNotes?.open(segment?.ref || state.dafRef, segment?.he || '');
  });

  // --- Control bar ---------------------------------------------------------
  // Regrouped into the mockup's three clusters. Every node moved here already
  // existed and keeps its id/listeners; only .pc-* wrappers and the labels
  // are new.

  const controls = document.querySelector('.player-controls');
  const group = (className) => {
    const el = document.createElement('div');
    el.className = `pc-group ${className}`;
    return el;
  };
  // A control plus the small caption underneath it, the way every item in the
  // mockup's right-hand cluster is labelled. The caption is hidden (not
  // removed) in compact mode -- see .video-frame.is-compact in styles.css.
  const stack = (el, label) => {
    const wrap = document.createElement('div');
    wrap.className = 'pc-stack';
    wrap.appendChild(el);
    const caption = document.createElement('span');
    caption.className = 'pc-label';
    caption.textContent = label;
    wrap.appendChild(caption);
    return wrap;
  };

  const transport = group('pc-transport');
  const volume = group('pc-volume');
  const tools = group('pc-tools');

  $('backButton').innerHTML = ICONS.back10;
  $('forwardButton').innerHTML = ICONS.forward10;
  for (const id of ['backButton', 'playButton', 'forwardButton', 'vaaterButton']) {
    if ($(id)) transport.appendChild($(id));
  }

  // "12:47 / 45:36". #currentTime and #duration keep updating themselves --
  // they're the same two spans app.js has always written to, just moved out of
  // the old .time-row and re-joined with a separator. The timeline row above
  // needs them too, at either end of the bar, so THOSE are mirrors of these
  // (see mirrorTimes below) rather than a second thing to keep updated.
  const timeDisplay = document.createElement('div');
  timeDisplay.className = 'pc-time';
  timeDisplay.appendChild($('currentTime'));
  const timeSeparator = document.createElement('span');
  timeSeparator.className = 'pc-time-sep';
  timeSeparator.textContent = '/';
  timeDisplay.appendChild(timeSeparator);
  timeDisplay.appendChild($('duration'));
  transport.appendChild(timeDisplay);

  volume.appendChild($('muteButton'));
  volume.appendChild($('volumeSlider'));

  // Speed comes out from behind the gear and into the bar as its own labelled
  // control, the way the mockup shows it. It's still the same <select> app.js
  // listens to, so nothing about setting the rate changes -- a native select
  // also keeps the whole thing keyboard- and screen-reader-navigable for free.
  const speedSelect = $('speedSelect');
  if (speedSelect) {
    const speedWrap = document.createElement('div');
    speedWrap.className = 'pc-speed';
    speedWrap.appendChild(speedSelect);
    tools.appendChild(stack(speedWrap, 'Speed'));
    $('videoSettings')?.querySelector('.speed-control')?.remove();
  }
  if ($('captionsButton')) tools.appendChild(stack($('captionsButton'), 'Captions'));

  // The two "where does the daf go" toggles, side by side: the Vilna page
  // drawn over the video, and the video floated over the printed daf. Both
  // are pure proxies -- see the comments on each wiring block below.
  const pill = (id, label, icon) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pc-pill';
    button.id = id;
    button.setAttribute('aria-pressed', 'false');
    button.innerHTML = `${icon}<span>${label}</span>`;
    return button;
  };
  const dafOnVideoButton = pill('dafOnVideoButton', 'Daf on video', ICONS.dafOnVideo);
  const videoOnDafButton = pill('videoOnDafButton', 'Video on daf', ICONS.videoOnDaf);
  tools.appendChild(dafOnVideoButton);
  // Reading mode only exists on the pages that ship a daf column to float the
  // video over (player/ and browse/); watch/ and studio/ have no
  // #readingModeButton to proxy to, so there's nothing to offer there.
  if ($('readingModeButton')) tools.appendChild(videoOnDafButton);

  if ($('videoSettings')) tools.appendChild(stack($('videoSettings'), 'Settings'));

  const pipButton = document.createElement('button');
  pipButton.type = 'button';
  pipButton.className = 'icon-button';
  pipButton.id = 'pipButton';
  pipButton.setAttribute('aria-label', 'Picture in picture');
  pipButton.title = 'Picture in picture';
  pipButton.innerHTML = ICONS.pip;
  tools.appendChild(stack(pipButton, 'PiP'));

  if ($('fullscreenButton')) tools.appendChild(stack($('fullscreenButton'), 'Fullscreen'));

  // The old bar's hand-placed spacers/dividers did the job .pc-group's own
  // space-between layout now does.
  controls.querySelectorAll('.control-divider').forEach((el) => el.remove());
  // All four pages ship the same control set today, but anything one of them
  // adds later would otherwise be dropped on the floor by the regroup below
  // -- carried into the tools cluster instead, so a page-specific control
  // degrades to "in the bar, at the end" rather than silently disappearing.
  tools.append(...controls.children);
  controls.replaceChildren(transport, volume, tools);

  // --- Vilna overlay toggle: moved out of its own row and into the bar -----
  // #overlayToggle (the checkbox app.js listens to) stays exactly where it is
  // and stays the single source of truth; this button checks it and fires the
  // change event app.js is already listening for, so turning the overlay on
  // from here runs the identical code path as the old checkbox did. Its own
  // pressed state comes back from .overlay-on on the frame, which
  // applyVideoOverlayEnabled sets on EVERY path -- including the ones the
  // reader didn't drive, like reading mode restoring the overlay it
  // suppressed (see readingModePreviousOverlayEnabled in app.js).
  const overlayToggle = $('overlayToggle');
  dafOnVideoButton.addEventListener('click', () => {
    if (!overlayToggle) return;
    overlayToggle.checked = !overlayToggle.checked;
    overlayToggle.dispatchEvent(new Event('change', { bubbles: true }));
  });
  if (!overlayToggle) dafOnVideoButton.hidden = true;

  // Reading mode is a plain button rather than a checkbox, so this proxies a
  // click to it and reads the state back off <body>, which app.js's
  // updateReadingModeUi keeps authoritative.
  videoOnDafButton.addEventListener('click', () => $('readingModeButton')?.click());

  function syncToggleStates() {
    dafOnVideoButton.setAttribute('aria-pressed', String(frame.classList.contains('overlay-on')));
    videoOnDafButton.setAttribute('aria-pressed', String(document.body.classList.contains('reading-mode-active')));
    const favorite = $('favoriteButton');
    if (favorite) {
      $('playerBookmarkButton').hidden = favorite.hidden;
      $('playerBookmarkButton').setAttribute('aria-pressed', String(favorite.classList.contains('is-favorited')));
    }
  }
  new MutationObserver(syncToggleStates).observe(frame, { attributes: true, attributeFilter: ['class'] });
  new MutationObserver(syncToggleStates).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  if ($('favoriteButton')) {
    new MutationObserver(syncToggleStates).observe($('favoriteButton'), { attributes: true, attributeFilter: ['class', 'hidden'] });
  }
  syncToggleStates();

  // The overlay's display settings (style/opacity/zoom/...) follow its toggle
  // into the bar, under the gear -- there's nowhere else left to reach them
  // now that their own row is gone. Collected by id and moved with whatever
  // <label> wraps each one, rather than by lifting one known container's
  // children: the four pages don't agree on that container (player/ tucks
  // them in a <details id="overlaySettings">, the other three list them
  // straight inside #overlayControls), and the ids are the part app.js
  // actually depends on. Moved, never copied, so every listener app.js
  // attached comes along untouched.
  const settingsBody = $('videoSettings')?.querySelector('.video-settings-body');
  const overlaySettingIds = [
    'overlayModeSelect', 'overlayOpacitySlider', 'overlayOpacityTargetSelect',
    'overlayIdleSelect', 'overlayZoomSlider', 'overlayResetPositionButton',
  ];
  if (settingsBody) {
    const moving = overlaySettingIds
      .map((id) => $(id))
      .filter(Boolean)
      .map((el) => el.closest('label') || el);
    const hint = document.querySelector('.overlay-controls-page .overlay-hint, #overlayControls .overlay-hint');
    if (hint) moving.push(hint);
    if (moving.length) {
      const heading = document.createElement('p');
      heading.className = 'video-settings-heading';
      heading.textContent = 'Daf on video';
      settingsBody.append(heading, ...moving);
    }
  }
  // What's left of each page's old overlay row is just the toggle app.js
  // still reads and writes -- kept in the DOM, hidden from view. The
  // floating in-video copy goes the same way: its whole reason to exist was
  // being reachable in native fullscreen, which the control bar now is.
  for (const el of [document.querySelector('.overlay-controls-page'), $('overlayControls'), $('overlayControlsInVideo')]) {
    if (el) el.hidden = true;
  }

  // --- Picture in picture --------------------------------------------------
  // Real PiP, which the browser only offers for the <video> element -- a
  // YouTube shiur plays in an iframe this page can't reach into, so the
  // button hides itself whenever that's the active source (#youtubePlayerHost
  // un-hidden, which app.js toggles when it swaps sources).
  const video = $('video');
  const youtubeHost = $('youtubePlayerHost');
  function updatePipAvailability() {
    const supported = Boolean(video) && document.pictureInPictureEnabled && !video.disablePictureInPicture;
    const youtubeActive = Boolean(youtubeHost) && !youtubeHost.hidden;
    pipButton.closest('.pc-stack').hidden = !supported || youtubeActive;
  }
  pipButton.addEventListener('click', async () => {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await video.requestPictureInPicture();
    } catch (error) {
      // Rejected for reasons outside this page's control (no metadata loaded
      // yet, or the browser refusing a gesture-less request) -- the button is
      // a convenience, so it stays quiet rather than raising a toast.
      console.error('Picture in picture was refused:', error);
    }
  });
  if (youtubeHost) {
    new MutationObserver(updatePipAvailability).observe(youtubeHost, { attributes: true, attributeFilter: ['hidden'] });
  }
  updatePipAvailability();

  // --- Timeline: times at either end, chapter markers above ----------------

  const scrubberWrap = document.querySelector('.scrubber-wrap');
  const markers = document.createElement('div');
  markers.className = 'chapter-markers';
  markers.id = 'chapterMarkers';
  scrubberWrap.prepend(markers);

  // The old .time-row put both times on their own line under the bar; the
  // redesign sets them at its two ends. These are mirrors of #currentTime /
  // #duration (which now live in the control bar) rather than a second pair
  // for app.js to update -- a MutationObserver copies whatever it writes.
  const timeRow = scrubberWrap.querySelector('.time-row');
  const scrubber = $('scrubber');
  const railTimeStart = document.createElement('span');
  railTimeStart.className = 'pc-rail-time';
  const railTimeEnd = document.createElement('span');
  railTimeEnd.className = 'pc-rail-time';
  const rail = document.createElement('div');
  rail.className = 'pc-rail';
  rail.append(railTimeStart, scrubber, railTimeEnd);
  scrubberWrap.appendChild(rail);
  if (timeRow) timeRow.remove();

  function mirrorTimes() {
    railTimeStart.textContent = $('currentTime').textContent;
    railTimeEnd.textContent = $('duration').textContent;
  }
  for (const el of [$('currentTime'), $('duration')]) {
    new MutationObserver(mirrorTimes).observe(el, { childList: true, characterData: true, subtree: true });
  }
  mirrorTimes();

  // Vilna pagination has no chapter metadata of its own, and a daf's
  // alignment is far too fine-grained to pin on a timeline directly (dozens
  // of segments, most of them seconds apart). These are an even spread across
  // the loaded segments instead -- honest signposts at a glance, each one a
  // real segment the reader can jump straight to, not invented chapter
  // boundaries.
  const MAX_MARKERS = 5;
  function refreshChapterMarkers() {
    markers.replaceChildren();
    const duration = getDuration();
    if (!Number.isFinite(duration) || duration <= 0 || !state.segments.length) return;
    const step = Math.max(1, Math.ceil(state.segments.length / MAX_MARKERS));
    for (let i = 0; i < state.segments.length; i += step) {
      const segment = state.segments[i];
      const fraction = segment.start / duration;
      if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) continue;
      const marker = document.createElement('button');
      marker.type = 'button';
      marker.className = 'chapter-marker';
      marker.style.left = `${fraction * 100}%`;
      // The ref carries the tractate name too ("Berakhot 2a:6"), which the
      // top bar right above already says -- the daf/segment part alone is
      // what distinguishes one marker from the next.
      const parsed = parseDafRef(segment.ref);
      const shortRef = parsed ? String(segment.ref).slice(String(parsed.tractate).length).trim() : segment.ref;
      marker.innerHTML = `
        <span class="chapter-marker-dot"></span>
        <span class="chapter-marker-body">
          <span class="chapter-marker-ref"></span>
          <span class="chapter-marker-he" dir="rtl" lang="he"></span>
        </span>`;
      marker.querySelector('.chapter-marker-ref').textContent = shortRef;
      marker.querySelector('.chapter-marker-he').textContent = segment.he || '';
      marker.title = `${segment.ref} — ${formatTime(segment.start)}`;
      marker.addEventListener('click', () => seek(segment.start));
      markers.appendChild(marker);
    }
    // The first and last markers would otherwise hang off the ends of the
    // bar, since each is centred on its own time.
    markers.firstElementChild?.classList.add('is-first');
    markers.lastElementChild?.classList.add('is-last');
  }

  // --- Keeping the chrome's text in step with what's loaded ----------------

  // Resolved from the shared module below; null until that import lands, which
  // only means the Hebrew half of the title appears a tick late.
  let gematria = null;

  function refreshDafIdentity() {
    const title = $('dafTitle')?.textContent?.trim();
    $('playerDafLabel').textContent = title && title !== 'No daf loaded' ? title : 'No daf loaded';
    const parsed = state.dafRef ? parseDafRef(state.dafRef) : null;
    const hebrewName = parsed ? syncState.talmudByName[parsed.tractate]?.hebrewName : null;
    const hebrewDaf = parsed && typeof gematria === 'function' ? gematria(parsed.daf) : null;
    const hebrew = hebrewName && hebrewDaf ? `מסכת ${hebrewName} דף ${hebrewDaf}׳` : '';
    $('playerDafHebrew').textContent = hebrew;
    topbar.classList.toggle('has-hebrew', Boolean(hebrew));
  }

  // The Hebrew daf number is the same printed-gematria convention the scan
  // feature's header matching already owns (see shared/daf-header-vocabulary
  // .mjs, including the טו/טז special cases a literal conversion gets wrong)
  // -- imported rather than reimplemented here. A dynamic import is what lets
  // this plain script reach an ES module at all; the chrome renders straight
  // away and just picks up its Hebrew title once the module resolves.
  import('/shared/daf-header-vocabulary.mjs')
    .then((module) => {
      gematria = module.toGematria;
      refreshDafIdentity();
    })
    .catch((error) => console.error('Could not load the Hebrew daf-number helper:', error));

  const dafTitle = $('dafTitle');
  if (dafTitle) {
    new MutationObserver(refreshDafIdentity).observe(dafTitle, { childList: true, characterData: true, subtree: true });
  }
  refreshDafIdentity();

  // Three steps down from the full chrome, keyed off the FRAME's own width
  // rather than a viewport media query -- one page shows this player at
  // several sizes at once (the split layout's column, then reading mode's
  // floating mini-player over the daf), so the viewport can't tell them
  // apart. Each threshold is the width at which the tier above it actually
  // starts overflowing the bar, measured rather than guessed. No tier ever
  // DROPS a control: they give up captions, then wording, then millimetres,
  // so every control stays reachable at every size.
  const SNUG_WIDTH = 780;
  const COMPACT_WIDTH = 660;
  const TINY_WIDTH = 400;
  const applyWidthClasses = () => {
    const width = frame.clientWidth;
    frame.classList.toggle('is-snug', width < SNUG_WIDTH);
    frame.classList.toggle('is-compact', width < COMPACT_WIDTH);
    frame.classList.toggle('is-tiny', width < TINY_WIDTH);
  };
  new ResizeObserver(applyWidthClasses).observe(frame);
  applyWidthClasses();

  if (video) {
    video.addEventListener('durationchange', refreshChapterMarkers);
    video.addEventListener('loadedmetadata', refreshChapterMarkers);
  }

  // renderDaf() (app.js) is the single funnel every alignment load and edit
  // already re-renders through -- it calls this so the markers follow the
  // segments they're built from, instead of each of those call sites having
  // to know the chrome exists.
  window.DafSyncPlayerChrome = { refreshChapterMarkers, refreshDafIdentity };
  refreshChapterMarkers();
})();
