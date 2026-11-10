'use strict';

// Cloud Chaburah Live -- notifications, as part of the discussion panel: the bell and its
// inbox, the settings (what to hear about, where, and when), "follow / mute this daf" and
// "mute this discussion", the live toast, and background alerts through a service worker.
//
// It attaches to the panel through the hooks live-chaburah-ui.js exposes (window.DafLive._ui)
// and changes nothing else: the discussions work exactly the same with it switched off,
// signed out, or on a browser that cannot show background alerts.
//
// Consent: nothing is sent to a phone or browser unless the person turns background alerts
// on here, and the browser's own permission prompt is the last word. All user text goes in
// with textContent -- never innerHTML.

(function () {
  const ui = window.DafLive && window.DafLive._ui;
  if (!ui) return;
  const { L, els, hooks, core, data, el, button, toast } = ui;

  const STATE_POLL_MS = 60000;
  const SNOOZES = [['', 'Not paused'], ['1', 'For 1 hour'], ['4', 'For 4 hours'], ['24', 'For a day'], ['168', 'For a week']];
  const PUSH_CONFIG_URL = '/.netlify/functions/live-push-config';
  const SW_URL = '/live-sw.js';

  const N = {
    state: null, // what live_my_notification_state returned (null: not available to this person)
    list: [], // the inbox, newest first
    unread: 0,
    listLoaded: false,
    channel: null,
    channelUserId: null,
    live: false,
    pollTimer: null,
    dafKey: null,
    devicePush: 'unknown', // 'unsupported' | 'blocked' | 'off' | 'on' | 'unavailable' | 'unknown'
    pushBusy: false,
    saveTimer: null,
    saveStatus: '',
    refs: {},
  };
  const prefs = () => ({ ...core.PREF_DEFAULTS, ...(N.state?.prefs || {}) });

  // ---- state ---------------------------------------------------------------------------------
  async function loadState() {
    if (!ui.signedIn() || !L.available) {
      N.state = null;
      N.unread = 0;
      renderBadges();
      return;
    }
    const state = await data.fetchNotificationState(N.dafKey || L.dafKey);
    if (!state) return; // keep what we had; the feature may simply not be installed yet
    N.state = state;
    N.unread = Number(state.unread) || 0;
    renderBadges();
    if (L.built) { renderSettings(); renderDafAlerts(); renderChatMute(); }
    ui.syncDafChannel();
  }

  function renderBadges() {
    if (!L.built) return;
    const n = N.unread;
    if (N.refs.bellCount) {
      N.refs.bellCount.textContent = n ? (n > 99 ? '99+' : String(n)) : '';
      N.refs.bellCount.hidden = n === 0;
      N.refs.bell.setAttribute('aria-label', n ? `Notifications, ${n} unread` : 'Notifications');
    }
    if (N.refs.toggleAlert) {
      N.refs.toggleAlert.hidden = n === 0;
      N.refs.toggleAlert.textContent = n ? (n > 99 ? '99+ alerts' : `${n} ${n === 1 ? 'alert' : 'alerts'}`) : '';
    }
  }

  // ---- the user's own channel: notifications as they happen --------------------------------------
  function joinUserChannel() {
    const id = ui.myId();
    if (!id || !L.available) { leaveUserChannel(); return; }
    if (N.channel && N.channelUserId === id) return;
    leaveUserChannel();
    N.channelUserId = id;
    N.channel = data.joinUser(id, onNotification, (status) => { N.live = status === 'live'; });
  }
  function leaveUserChannel() {
    N.channel?.close();
    N.channel = null;
    N.channelUserId = null;
    N.live = false;
  }

  function onNotification(payload) {
    if (!payload || !payload.id) return;
    if (N.list.some((n) => n.id === payload.id)) return;
    const viewing = L.open && L.view === 'chat' && L.thread && L.thread.id === payload.thread_id;
    N.list = [{ ...payload, read_at: viewing ? new Date().toISOString() : null }, ...N.list];
    if (!viewing) {
      N.unread += 1;
      renderBadges();
      if (N.refs.inbox && !N.refs.inbox.hidden) renderInbox();
      toast(`${core.notificationText(payload)}: ${payload.preview}`);
    }
    // The conversation list's own counts follow along.
    ui.refreshUnread();
  }

  // ---- the bell and the inbox ------------------------------------------------------------------
  async function openInbox() {
    if (!L.open) ui.openPanel();
    ui.showView('inbox');
    await loadInbox();
    N.refs.inboxBack?.focus?.();
  }

  async function loadInbox() {
    if (!ui.signedIn()) { renderInbox(); return; }
    N.refs.inboxStatus.textContent = N.listLoaded ? '' : 'Loading…';
    try {
      N.list = await data.listNotifications(50);
      N.listLoaded = true;
      N.refs.inboxStatus.textContent = '';
    } catch (error) {
      N.refs.inboxStatus.textContent = core.errorText(error);
    }
    N.unread = core.unreadNotificationCount(N.list);
    renderBadges();
    renderInbox();
  }

  function renderInbox() {
    const box = N.refs.inboxList;
    if (!box) return;
    box.textContent = '';
    if (!ui.signedIn()) {
      N.refs.inboxEmpty.textContent = 'Sign in to see your notifications.';
      N.refs.inboxEmpty.hidden = false;
      N.refs.markAll.hidden = true;
      return;
    }
    const groups = core.groupNotifications(N.list);
    N.refs.inboxEmpty.hidden = groups.length > 0;
    N.refs.inboxEmpty.textContent = 'Nothing yet. Replies to you, mentions and activity in the discussions you follow will appear here.';
    N.refs.markAll.hidden = core.unreadNotificationCount(N.list) === 0;
    for (const group of groups) {
      const latest = group.latest;
      const row = el('li', 'live-notice');
      if (group.unread) row.classList.add('live-notice-unread');
      const open = el('button', 'live-notice-open');
      open.type = 'button';
      const head = el('span', 'live-notice-head');
      if (group.unread) head.append(el('span', 'live-notice-dot'));
      head.append(el('strong', null, core.notificationText(latest)));
      const where = el('span', 'live-notice-where', `${core.dafLabelFromKey(group.daf_ref_key)} · ${core.timeAgo(latest.created_at)}`);
      const text = el('span', 'live-notice-text', latest.preview);
      open.append(head, text, where);
      if (group.count > 1) open.append(el('span', 'live-badge', `${group.count} messages`));
      open.addEventListener('click', () => openNotification(group));
      row.append(open);
      box.append(row);
    }
  }

  function openNotification(group) {
    const here = core.dafKeyFromRef(ui.currentDafRef());
    if (here && here === group.daf_ref_key) {
      ui.openThread(group.thread_id);
      markThreadSeen(group.thread_id);
    } else {
      // Another daf: go there, with the discussion open.
      window.location.assign(core.notificationUrl(window.location.origin, group.latest));
    }
  }

  function markThreadSeen(threadId) {
    const now = new Date().toISOString();
    N.list = N.list.map((n) => (n.thread_id === threadId && !n.read_at ? { ...n, read_at: now } : n));
    N.unread = core.unreadNotificationCount(N.list);
    renderBadges();
    data.markNotificationsRead({ threadId }).catch(() => {});
  }

  async function markAllRead() {
    const now = new Date().toISOString();
    N.list = N.list.map((n) => (n.read_at ? n : { ...n, read_at: now }));
    N.unread = 0;
    renderBadges();
    renderInbox();
    try { await data.markNotificationsRead({ all: true }); } catch (error) { toast(core.errorText(error)); }
  }

  // ---- settings ----------------------------------------------------------------------------------
  // Quick successive changes are merged and sent together, so none is lost.
  function savePrefs(patch, { quiet = false } = {}) {
    N.state = { ...(N.state || {}), prefs: { ...prefs(), ...patch } };
    ui.syncDafChannel();
    N.pending = { ...(N.pending || {}), ...patch };
    N.pendingQuiet = quiet && (N.pendingQuiet === undefined || N.pendingQuiet);
    N.saveStatus = 'Saving…';
    renderSaveStatus();
    renderSettings();
    clearTimeout(N.saveTimer);
    N.saveTimer = setTimeout(async () => {
      const batch = N.pending;
      const hush = N.pendingQuiet;
      N.pending = null;
      N.pendingQuiet = undefined;
      try {
        await data.setNotificationPrefs(batch);
        N.saveStatus = hush ? '' : 'Saved';
      } catch (error) {
        N.saveStatus = core.errorText(error);
        loadState();
      }
      renderSaveStatus();
    }, 150);
  }
  function renderSaveStatus() {
    if (N.refs.saveStatus) N.refs.saveStatus.textContent = N.saveStatus;
  }

  function checkbox(label, key, hint) {
    const row = el('label', 'live-setting');
    const box = el('input');
    box.type = 'checkbox';
    box.dataset.pref = key;
    box.addEventListener('change', () => savePrefs({ [key]: box.checked }));
    const text = el('span', 'live-setting-text');
    text.append(el('span', 'live-setting-label', label));
    if (hint) text.append(el('span', 'live-setting-hint', hint));
    row.append(box, text);
    return row;
  }
  function choice(label, key, options, { numeric = true, onChange = null } = {}) {
    const row = el('label', 'live-setting live-setting-select');
    const select = el('select');
    select.dataset.pref = key;
    for (const [value, text] of options) {
      const option = el('option', null, text);
      option.value = String(value);
      select.append(option);
    }
    select.addEventListener('change', () => {
      if (onChange) onChange(select.value);
      else savePrefs({ [key]: numeric ? Number(select.value) : select.value });
    });
    row.append(el('span', 'live-setting-label', label), select);
    return row;
  }
  const hourOptions = () => Array.from({ length: 24 }, (_, h) => [h, core.hourLabel(h)]);
  const section = (title, hint) => {
    const box = el('fieldset', 'live-settings-group');
    box.append(el('legend', null, title));
    if (hint) box.append(el('p', 'live-note', hint));
    return box;
  };

  function buildSettings() {
    const view = el('section', 'live-view live-settings-view');
    view.hidden = true;
    const head = el('div', 'live-chat-head');
    head.append(button('live-icon-button live-back', '‹', ui.backToList, 'Back to the discussions'), el('strong', null, 'Notification settings'));
    N.refs.saveStatus = el('span', 'live-save-status');
    N.refs.saveStatus.setAttribute('role', 'status');
    head.append(N.refs.saveStatus);
    const scroll = el('div', 'live-scroll live-settings-scroll');
    N.refs.settingsSignedOut = el('p', 'live-note', 'Sign in to choose what you hear about.');
    N.refs.settingsBody = el('div', 'live-settings-body');

    const pause = section('Pause');
    pause.append(checkbox('Turn off all notifications', 'all_off', 'Nothing is shown in the panel and nothing is sent to your devices.'));
    N.refs.snooze = choice('Or pause for a while', 'snooze_until', SNOOZES, {
      numeric: false,
      onChange: (value) => {
        const hours = Number(value);
        savePrefs({ snooze_until: hours ? new Date(Date.now() + hours * 3600 * 1000).toISOString() : null });
      },
    });
    pause.append(N.refs.snooze);
    N.refs.snoozeUntil = el('p', 'live-setting-hint');
    pause.append(N.refs.snoozeUntil);

    const what = section('What to hear about', 'You can combine these.');
    what.append(
      checkbox('My discussions', 'lvl_mine', 'Replies to my questions and messages, mentions of me, and activity in discussions I follow. Recommended.'),
      checkbox('New discussions on my dapim', 'lvl_daf', 'Dapim I follow, and the daf I have open.'),
      checkbox('New discussions anywhere on DafSync', 'lvl_everywhere', 'Off unless you ask for it.'),
      choice('Anywhere on DafSync arrives', 'everywhere_mode', [['digest', 'In the daily digest'], ['live', 'As they happen']], { numeric: false }),
      checkbox('Live alerts while I am using DafSync', 'lvl_while_using', 'A small message when someone starts a discussion on the daf you have open. Nothing is sent to your devices for this.'),
    );

    const where = section('Where');
    where.append(checkbox('In the panel and as small messages on the page', 'in_app_enabled'));
    N.refs.pushBox = el('div', 'live-push');
    where.append(N.refs.pushBox);

    const when = section('When', 'Background alerts wait for these; the panel always shows everything straight away.');
    when.append(
      choice('Group background alerts', 'batch_minutes', core.BATCH_CHOICES),
      checkbox('Send a daily digest instead of separate alerts', 'digest_enabled'),
      choice('Digest time', 'digest_hour', hourOptions()),
      checkbox('Quiet hours', 'quiet_enabled', 'Background alerts wait until they end.'),
      choice('Quiet from', 'quiet_start', hourOptions()),
      choice('until', 'quiet_end', hourOptions()),
    );
    N.refs.timezone = el('p', 'live-setting-hint');
    N.refs.tzButton = button('live-link', 'Use this device’s time zone', () => {
      const zone = deviceZone();
      if (zone) savePrefs({ timezone: zone });
      renderSettings();
    });
    when.append(N.refs.timezone, N.refs.tzButton);

    N.refs.settingsBody.append(pause, what, where, when);
    scroll.append(N.refs.settingsSignedOut, N.refs.settingsBody);
    view.append(head, scroll);
    return view;
  }

  function deviceZone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; }
  }

  function renderSettings() {
    if (!N.refs.settingsBody) return;
    const signedIn = ui.signedIn();
    N.refs.settingsSignedOut.hidden = signedIn;
    N.refs.settingsBody.hidden = !signedIn;
    if (!signedIn) return;
    const p = prefs();
    for (const input of N.refs.settingsBody.querySelectorAll('input[data-pref]')) input.checked = Boolean(p[input.dataset.pref]);
    for (const select of N.refs.settingsBody.querySelectorAll('select[data-pref]')) {
      if (select.dataset.pref === 'snooze_until') { select.value = ''; continue; }
      select.value = String(p[select.dataset.pref]);
    }
    const snoozed = p.snooze_until && new Date(p.snooze_until) > new Date();
    N.refs.snoozeUntil.textContent = snoozed ? `Paused until ${new Date(p.snooze_until).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}.` : '';
    const zone = deviceZone();
    N.refs.timezone.textContent = `Times are in ${p.timezone}.`;
    N.refs.tzButton.hidden = !zone || zone === p.timezone;
    // Settings that only matter when their switch is on.
    const dim = (key, on) => N.refs.settingsBody.querySelector(`[data-pref="${key}"]`)?.closest('.live-setting')?.classList.toggle('live-setting-off', !on);
    dim('everywhere_mode', p.lvl_everywhere);
    dim('digest_hour', p.digest_enabled || (p.lvl_everywhere && p.everywhere_mode === 'digest'));
    dim('quiet_start', p.quiet_enabled);
    dim('quiet_end', p.quiet_enabled);
    renderPush();
  }

  // ---- background alerts: this device, and the others ------------------------------------------
  function pushSupported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }
  const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent || '');
  const isStandalone = () => Boolean(window.navigator.standalone) || window.matchMedia?.('(display-mode: standalone)').matches;

  async function detectDevicePush() {
    if (!pushSupported()) {
      N.devicePush = isIos() && !isStandalone() ? 'ios-install' : 'unsupported';
      return;
    }
    if (Notification.permission === 'denied') { N.devicePush = 'blocked'; return; }
    try {
      const reg = await navigator.serviceWorker.getRegistration(SW_URL) || await navigator.serviceWorker.getRegistration();
      const sub = reg && await reg.pushManager.getSubscription();
      N.devicePush = sub && Notification.permission === 'granted' ? 'on' : 'off';
    } catch {
      N.devicePush = 'off';
    }
  }

  function renderPush() {
    const box = N.refs.pushBox;
    if (!box) return;
    box.textContent = '';
    const devices = N.state?.devices || [];
    const line = (text) => box.append(el('p', 'live-note', text));
    box.append(el('div', 'live-setting-label', 'Background alerts on this device'));
    switch (N.devicePush) {
      case 'unsupported':
        line('This browser cannot show background alerts. The panel and the small messages on the page still work.');
        break;
      case 'ios-install':
        line('On iPhone and iPad, background alerts work once DafSync is added to your Home Screen (Share → Add to Home Screen) and opened from there.');
        break;
      case 'blocked':
        line('This browser is blocking notifications for DafSync. Allow them in the browser’s site settings, then come back here.');
        break;
      case 'on': {
        line('On. This device gets background alerts, even when DafSync is closed.');
        box.append(button('live-secondary', 'Turn off on this device', disablePush));
        break;
      }
      default: {
        line('Off. Turn them on to hear about replies when DafSync is closed. Your browser will ask for permission.');
        const turnOn = button('live-primary', 'Turn on for this device', enablePush);
        turnOn.disabled = N.pushBusy;
        box.append(turnOn);
      }
    }
    if (N.refs.pushError) box.append(N.refs.pushError);
    if (devices.length) {
      box.append(el('div', 'live-setting-label live-devices-title', 'Your devices'));
      const list = el('ul', 'live-devices');
      for (const device of devices) {
        const row = el('li', 'live-device');
        row.append(el('span', null, `${device.label || 'A device'} · added ${core.timeAgo(device.created_at)}`));
        row.append(button('live-link', 'Remove', () => removeDevice(device), `Remove ${device.label || 'this device'}`));
        list.append(row);
      }
      box.append(list);
    }
  }

  function showPushError(text) {
    if (!N.refs.pushError) { N.refs.pushError = el('p', 'live-error'); N.refs.pushError.setAttribute('role', 'alert'); }
    N.refs.pushError.textContent = text;
    N.refs.pushError.hidden = !text;
  }

  function keyToBytes(base64) {
    const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(padded);
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }

  async function enablePush() {
    if (N.pushBusy) return;
    N.pushBusy = true;
    showPushError('');
    renderPush();
    try {
      // The permission prompt first, straight from the click: browsers only allow it there.
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        N.devicePush = permission === 'denied' ? 'blocked' : 'off';
        showPushError(permission === 'denied' ? '' : 'Notifications were not allowed, so nothing was turned on.');
        return;
      }
      const config = await fetch(PUSH_CONFIG_URL, { headers: { accept: 'application/json' } }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (!config || !config.available || !config.publicKey) {
        showPushError('Background alerts are not set up on the server yet. The panel and the small messages on the page work now.');
        return;
      }
      const registration = await navigator.serviceWorker.register(SW_URL, { scope: '/' });
      await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(config.publicKey) });
      }
      const json = subscription.toJSON();
      await data.savePushSubscription({
        endpoint: json.endpoint, p256dh: json.keys && json.keys.p256dh, auth: json.keys && json.keys.auth,
        label: core.deviceLabel(navigator.userAgent),
      });
      N.devicePush = 'on';
      await loadState();
      toast('Background alerts are on for this device.');
    } catch (error) {
      showPushError(error && /live_/.test(String(error.message)) ? core.errorText(error) : 'Could not turn on background alerts on this device.');
    } finally {
      N.pushBusy = false;
      renderPush();
    }
  }

  async function disablePush() {
    showPushError('');
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = registration && await registration.pushManager.getSubscription();
      if (subscription) {
        const endpoint = subscription.endpoint;
        await subscription.unsubscribe();
        await data.removePushSubscription({ endpoint });
      }
      N.devicePush = 'off';
      await loadState();
    } catch (error) {
      showPushError(core.errorText(error));
    }
    renderPush();
  }

  async function removeDevice(device) {
    try {
      await data.removePushSubscription({ deviceId: device.id });
      await loadState();
      await detectDevicePush();
      renderPush();
    } catch (error) {
      showPushError(core.errorText(error));
    }
  }

  // ---- this daf, this discussion ------------------------------------------------------------------
  function buildDafAlerts() {
    const row = el('div', 'live-daf-alerts');
    N.refs.dafFollow = el('button', 'live-chip');
    N.refs.dafFollow.type = 'button';
    N.refs.dafFollow.addEventListener('click', () => toggleDaf('following'));
    N.refs.dafMute = el('button', 'live-chip');
    N.refs.dafMute.type = 'button';
    N.refs.dafMute.addEventListener('click', () => toggleDaf('muted'));
    row.append(N.refs.dafFollow, N.refs.dafMute);
    return row;
  }

  function renderDafAlerts() {
    if (!N.refs.dafAlerts) return;
    const signedIn = ui.signedIn() && Boolean(N.state);
    N.refs.dafAlerts.hidden = !signedIn || !L.dafKey;
    if (N.refs.dafAlerts.hidden) return;
    const daf = N.state.daf || {};
    const label = L.dafLabel || 'this daf';
    N.refs.dafFollow.textContent = daf.following ? `Following ${label}` : `Follow ${label}`;
    N.refs.dafFollow.classList.toggle('live-chip-on', Boolean(daf.following));
    N.refs.dafFollow.setAttribute('aria-pressed', String(Boolean(daf.following)));
    N.refs.dafFollow.title = daf.following ? 'Stop hearing about new discussions on this daf' : 'Hear about new discussions on this daf (turn on “New discussions on my dapim” in settings)';
    N.refs.dafMute.textContent = daf.muted ? 'Muted' : 'Mute daf';
    N.refs.dafMute.classList.toggle('live-chip-on', Boolean(daf.muted));
    N.refs.dafMute.setAttribute('aria-pressed', String(Boolean(daf.muted)));
    N.refs.dafMute.title = daf.muted ? 'Hear about this daf again' : 'Hear nothing about this daf';
  }

  async function toggleDaf(which) {
    if (!L.dafKey || !N.state) return;
    const current = N.state.daf || {};
    const next = { following: Boolean(current.following), muted: Boolean(current.muted) };
    next[which] = !next[which];
    if (which === 'following' && next.following) {
      next.muted = false;
      // Following a daf is asking to hear about it: make sure that setting is on.
      if (!prefs().lvl_daf) savePrefs({ lvl_daf: true }, { quiet: true });
    }
    N.state = { ...N.state, daf: next };
    renderDafAlerts();
    try {
      await data.setDafPref(L.dafKey, next);
    } catch (error) {
      toast(core.errorText(error));
      loadState();
    }
  }

  function renderChatMute() {
    if (!L.built || !L.thread || !N.state || !ui.signedIn()) return;
    const existing = els.chatTools.querySelector('.live-mute');
    existing?.remove();
    const muted = new Set(N.state.muted_thread_ids || []).has(L.thread.id);
    const chip = button('live-chip live-mute', muted ? 'Muted' : 'Mute', () => toggleMute(L.thread.id, !muted),
      muted ? 'Hear about this discussion again' : 'Stop notifications from this discussion');
    chip.classList.toggle('live-chip-on', muted);
    chip.setAttribute('aria-pressed', String(muted));
    els.chatTools.append(chip);
  }

  async function toggleMute(threadId, mute) {
    const ids = new Set(N.state?.muted_thread_ids || []);
    if (mute) ids.add(threadId); else ids.delete(threadId);
    N.state = { ...(N.state || {}), muted_thread_ids: [...ids] };
    renderChatMute();
    try {
      await data.setThreadMuted(threadId, mute);
      ui.refreshUnread();
    } catch (error) {
      toast(core.errorText(error));
      loadState();
    }
  }

  // ---- wiring into the panel ---------------------------------------------------------------------------
  hooks.built = () => {
    // The bell and the gear, next to the close button.
    const tools = el('div', 'live-head-tools');
    N.refs.bell = el('button', 'live-icon-button live-bell');
    N.refs.bell.type = 'button';
    N.refs.bell.setAttribute('aria-label', 'Notifications');
    N.refs.bell.append(el('span', 'live-bell-icon', '🔔'));
    N.refs.bellCount = el('span', 'live-bell-count');
    N.refs.bellCount.hidden = true;
    N.refs.bell.append(N.refs.bellCount);
    N.refs.bell.addEventListener('click', openInbox);
    N.refs.gear = button('live-icon-button live-gear', '⚙', () => { ui.showView('settings'); renderSettings(); }, 'Notification settings');
    tools.append(N.refs.bell, N.refs.gear);
    els.head.insertBefore(tools, els.close);

    N.refs.toggleAlert = el('span', 'live-toggle-alert');
    N.refs.toggleAlert.hidden = true;
    els.toggle.append(N.refs.toggleAlert);

    // The inbox.
    const inbox = el('section', 'live-view live-inbox-view');
    inbox.hidden = true;
    const head = el('div', 'live-chat-head');
    N.refs.inboxBack = button('live-icon-button live-back', '‹', ui.backToList, 'Back to the discussions');
    N.refs.markAll = button('live-link', 'Mark all read', markAllRead);
    head.append(N.refs.inboxBack, el('strong', null, 'Notifications'), N.refs.markAll);
    N.refs.inboxStatus = el('p', 'live-status');
    N.refs.inboxStatus.setAttribute('role', 'status');
    N.refs.inboxList = el('ul', 'live-notices');
    N.refs.inboxEmpty = el('div', 'live-inbox-empty');
    const scroll = el('div', 'live-scroll');
    scroll.append(N.refs.inboxStatus, N.refs.inboxList, N.refs.inboxEmpty);
    inbox.append(head, scroll);
    N.refs.inbox = inbox;

    const settings = buildSettings();
    N.refs.settings = settings;
    els.extraViews.inbox = inbox;
    els.extraViews.settings = settings;
    els.panel.append(inbox, settings);

    // Follow / mute this daf, under the list's options.
    N.refs.dafAlerts = buildDafAlerts();
    N.refs.dafAlerts.hidden = true;
    els.options.after(N.refs.dafAlerts);

    renderBadges();
    renderSettings();
    renderDafAlerts();
  };

  hooks.chatMeta = () => renderChatMute();

  // Live alerts while using the site: the daf's channel stays joined (it carries new
  // discussions), and a new one by someone else becomes a small message on the page.
  hooks.keepDafChannel = () => {
    const p = prefs();
    return ui.signedIn() && L.available && p.lvl_while_using && !p.all_off && p.in_app_enabled;
  };
  hooks.threadEvent = (thread) => {
    if (L.open || !thread) return;
    const ok = core.liveAlertApplies(prefs(), {
      dafKey: thread.daf_ref_key, openDafKey: L.dafKey, authorId: thread.author_id, myId: ui.myId(),
    });
    if (ok) toast(`${thread.author_display_name} started a discussion on ${L.dafLabel}: ${thread.preview}`);
  };

  hooks.view = (view) => {
    if (view === 'inbox') renderInbox();
    if (view === 'settings') { detectDevicePush().then(renderPush); loadState(); }
  };

  // A discussion opened from anywhere clears its notifications (the database does it as the
  // discussion is read; this keeps the bell in step without a round trip).
  hooks.threadOpened = (id) => markThreadSeen(id);

  hooks.daf = (key, changed) => {
    N.dafKey = key;
    renderDafAlerts();
    if (changed) {
      loadState();
      if (prefs().lvl_daf && ui.signedIn()) data.setCurrentDaf(key).catch(() => {});
    }
  };

  hooks.available = (available) => {
    if (!available) { leaveUserChannel(); clearInterval(N.pollTimer); N.pollTimer = null; return; }
    joinUserChannel();
    loadState().then(() => {
      if (prefs().lvl_daf && ui.signedIn() && L.dafKey) data.setCurrentDaf(L.dafKey).catch(() => {});
      openInboxIfAsked();
    });
    detectDevicePush();
    if (!N.pollTimer) {
      N.pollTimer = setInterval(() => { if (!document.hidden && ui.signedIn()) loadState(); }, STATE_POLL_MS);
    }
  };

  // "?live=inbox" (what a grouped background alert opens) shows the inbox.
  let wantsInbox = new URLSearchParams(window.location.search).get('live') === 'inbox';
  function openInboxIfAsked() {
    if (!wantsInbox || !ui.signedIn() || !L.available) return;
    wantsInbox = false;
    openInbox();
  }

  // A tab that comes back to the front catches up at once.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && L.available && ui.signedIn()) loadState();
  });

  // The service worker tells an open tab which discussion a tapped alert wanted.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      const message = event.data;
      if (!message || message.type !== 'live-open' || !message.url) return;
      try {
        const url = new URL(message.url, window.location.origin);
        const thread = core.threadIdFromSearch(url.search);
        const sameDaf = url.searchParams.get('ref') && core.dafKeyFromRef(url.searchParams.get('ref')) === core.dafKeyFromRef(ui.currentDafRef());
        if (thread && sameDaf) ui.openThread(thread);
        else window.location.assign(url.href);
      } catch { /* nothing to open */ }
    });
  }

  window.DafLive.notify = { state: N, openInbox, openSettings: () => { ui.showView('settings'); renderSettings(); } };
  // The panel may have been built already (this script loads after it, and the panel is built
  // as soon as the audience is known): attach to it now, then catch up on what was missed.
  if (L.built) hooks.built();
  if (L.available) hooks.available(true);
})();
