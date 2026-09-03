'use strict';

// Cloud Chabura notifications, grouped by thread.
//
// The plan's two explicit failure modes, both avoided here:
//
//   "no duplicate storm for the same burst of activity" -- ten replies to one
//   thread arrive as ten rows in `notifications` (one per trigger firing). They
//   are shown as ONE row for the thread saying what happened and how many
//   times, because a reader wants "this discussion moved", not ten identical
//   lines pushing everything else off the panel.
//
//   "Marking all notifications read simply by opening the panel" -- opening it
//   marks nothing. Read state advances when a group is opened (its own rows,
//   and only those), or when the reader explicitly says so.
//
// RLS is owner-only on this table for select, update and delete, so nothing
// here can read or clear anyone else's; that is proven in the SQL suite.

(function () {
  const { client, currentUser, describeError } = window.DafSyncChabura.core;
  const PAGE_SIZE = 50;

  const COLUMNS = [
    'id', 'type', 'actor_id', 'actor_display_name', 'note_id', 'comment_id',
    'daf_ref_key', 'segment_ref', 'preview', 'read', 'created_at',
  ].join(', ');

  async function fetchNotifications() {
    const user = currentUser();
    if (!user) return [];
    const { data, error } = await client()
      .from('notifications').select(COLUMNS)
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(PAGE_SIZE);
    if (error) throw error;
    return data || [];
  }

  async function markRead(ids) {
    const user = currentUser();
    if (!user || !ids.length) return;
    const { error } = await client()
      .from('notifications').update({ read: true })
      .eq('user_id', user.id).in('id', ids);
    if (error) throw error;
  }

  // One entry per thread, newest first, carrying every row it stands for so
  // opening it can mark exactly those read and nothing else.
  function groupByThread(rows) {
    const groups = new Map();
    rows.forEach((row) => {
      if (!groups.has(row.note_id)) {
        groups.set(row.note_id, {
          noteId: row.note_id,
          dafRefKey: row.daf_ref_key,
          segmentRef: row.segment_ref,
          rows: [],
          actors: new Map(),
          unread: 0,
          latest: row,
        });
      }
      const group = groups.get(row.note_id);
      group.rows.push(row);
      if (!row.read) group.unread += 1;
      if (row.actor_id) group.actors.set(row.actor_id, row.actor_display_name || 'Someone');
      if (Date.parse(row.created_at) > Date.parse(group.latest.created_at)) group.latest = row;
    });
    return [...groups.values()].sort((a, b) => Date.parse(b.latest.created_at) - Date.parse(a.latest.created_at));
  }

  // "Ruthie and 2 others replied", not ten lines each saying "Ruthie replied".
  function summarise(group) {
    const names = [...group.actors.values()];
    const kinds = new Set(group.rows.map((row) => row.type));
    const verb = kinds.has('mention') && kinds.size === 1 ? 'mentioned you'
      : kinds.has('mention') ? 'replied and mentioned you'
      : 'replied';
    if (names.length === 1) {
      const count = group.rows.length;
      return `${names[0]} ${verb}${count > 1 ? ` (${count} times)` : ''}`;
    }
    if (names.length === 2) return `${names[0]} and ${names[1]} ${verb}`;
    return `${names[0]} and ${names.length - 1} others ${verb}`;
  }

  // A deep link to the exact reply when there is one, so the thread opens
  // scrolled and focused on what the notification was about.
  function href(group) {
    const target = group.latest;
    const params = new URLSearchParams({ thread: target.note_id });
    if (target.comment_id) params.set('comment', target.comment_id);
    return `/chaburah/thread/?${params.toString()}`;
  }

  function relativeTime(iso) {
    return window.DafNotesFormat?.formatNoteTime
      ? window.DafNotesFormat.formatNoteTime(iso)
      : new Date(iso).toLocaleString();
  }

  // --- UI ------------------------------------------------------------------

  function mount(options = {}) {
    const trigger = document.getElementById('ccNotifyButton');
    const panel = document.getElementById('ccNotifyPanel');
    const badge = document.getElementById('ccNotifyBadge');
    if (!trigger || !panel) return null;

    let rows = [];
    let open = false;

    function renderBadge() {
      const unread = rows.filter((row) => !row.read).length;
      if (!badge) return;
      badge.textContent = unread > 99 ? '99+' : String(unread);
      badge.hidden = unread === 0;
      trigger.setAttribute('aria-label', unread ? `Notifications, ${unread} unread` : 'Notifications');
    }

    function renderPanel() {
      panel.innerHTML = '';
      const head = document.createElement('div');
      head.className = 'cc-notify-head';
      const title = document.createElement('h2');
      title.textContent = 'Notifications';
      head.appendChild(title);

      const unreadIds = rows.filter((row) => !row.read).map((row) => row.id);
      if (unreadIds.length) {
        const all = document.createElement('button');
        all.type = 'button';
        all.className = 'cc-btn cc-btn-quiet cc-btn-sm';
        all.textContent = 'Mark all read';
        all.addEventListener('click', async () => {
          try {
            await markRead(unreadIds);
            rows = rows.map((row) => ({ ...row, read: true }));
            renderBadge();
            renderPanel();
          } catch (error) { options.onError?.(describeError(error)); }
        });
        head.appendChild(all);
      }
      panel.appendChild(head);

      const groups = groupByThread(rows);
      if (!groups.length) {
        const empty = document.createElement('p');
        empty.className = 'cc-notify-empty';
        empty.textContent = 'Nothing new. Replies and mentions on discussions you follow will appear here.';
        panel.appendChild(empty);
        return;
      }

      const list = document.createElement('ul');
      list.className = 'cc-notify-list';
      groups.forEach((group) => {
        const item = document.createElement('li');
        item.className = `cc-notify-item${group.unread ? ' is-unread' : ''}`;

        const link = document.createElement('a');
        link.href = href(group);
        link.className = 'cc-notify-link';

        const summary = document.createElement('span');
        summary.className = 'cc-notify-summary';
        summary.textContent = summarise(group);
        link.appendChild(summary);

        const where = document.createElement('span');
        where.className = 'cc-notify-where';
        where.textContent = (group.dafRefKey || '').replace(/-/g, ' ');
        link.appendChild(where);

        const preview = document.createElement('span');
        preview.className = 'cc-notify-preview';
        preview.textContent = group.latest.preview || '';
        link.appendChild(preview);

        const when = document.createElement('time');
        when.className = 'cc-notify-time';
        when.dateTime = group.latest.created_at;
        when.textContent = relativeTime(group.latest.created_at);
        link.appendChild(when);

        // Opening a group marks that group's rows read -- and only that
        // group's. Following the link is the reader saying they have seen it.
        link.addEventListener('click', () => {
          const ids = group.rows.filter((row) => !row.read).map((row) => row.id);
          if (ids.length) markRead(ids).catch(() => { /* navigation wins */ });
        });
        item.appendChild(link);

        if (group.unread) {
          const dot = document.createElement('span');
          dot.className = 'cc-notify-dot';
          dot.setAttribute('aria-label', `${group.unread} unread`);
          item.appendChild(dot);
        }
        list.appendChild(item);
      });
      panel.appendChild(list);
    }

    async function refresh() {
      if (!currentUser()) { rows = []; renderBadge(); return; }
      try {
        rows = await fetchNotifications();
        renderBadge();
        if (open) renderPanel();
      } catch (error) {
        options.onError?.(describeError(error));
      }
    }

    function setOpen(next) {
      open = next;
      panel.hidden = !open;
      trigger.setAttribute('aria-expanded', String(open));
      // Deliberately does NOT mark anything read: seeing that something exists
      // is not the same as having read it.
      if (open) renderPanel();
    }

    trigger.addEventListener('click', () => setOpen(!open));
    document.addEventListener('click', (event) => {
      if (open && !panel.contains(event.target) && event.target !== trigger && !trigger.contains(event.target)) setOpen(false);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && open) { setOpen(false); trigger.focus(); }
    });

    trigger.hidden = !currentUser();
    setOpen(false);
    refresh();
    window.DafSyncAuth?.onChange(() => { trigger.hidden = !currentUser(); refresh(); });

    return { refresh, setOpen };
  }

  window.DafSyncChabura = window.DafSyncChabura || {};
  window.DafSyncChabura.notifications = {
    PAGE_SIZE,
    fetchNotifications,
    markRead,
    groupByThread,
    summarise,
    href,
    mount,
  };
})();
