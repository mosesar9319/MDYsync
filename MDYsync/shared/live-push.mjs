// Cloud Chaburah Live: turning what the database says is due into the messages a phone or
// browser shows. Pure functions, so the rules (what is grouped, what a digest says, where a
// tap goes) are tested without a network. Used by netlify/functions/live-push-send.mjs.
//
// The database (live_push_claim) has already applied each person's choices -- batching,
// quiet hours, the Shabbos pause, mutes, "already read" -- and hands over, per person, the
// notifications that are due, newest first. This only words them.

import core from '../live-chaburah-core.js';

const MAX_SEPARATE = 3; // more discussions than this become one summary
const clip = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

function threadUrl(item) {
  return core.notificationUrl('', { daf_ref_key: item.daf_ref_key, thread_id: item.thread_id });
}
const inboxUrl = (item) => `/browse/?ref=${encodeURIComponent(core.dafLabelFromKey(item.daf_ref_key))}&live=inbox`;

// -> [{ title, body, url, tag }]
export function buildPushMessages(person) {
  const items = Array.isArray(person?.items) ? person.items : [];
  if (!items.length) return [];

  const byThread = new Map();
  for (const item of items) {
    if (!byThread.has(item.thread_id)) byThread.set(item.thread_id, []);
    byThread.get(item.thread_id).push(item);
  }
  const threads = [...byThread.values()];

  if (person.digest) {
    const count = items.length;
    const dafs = new Set(items.map((i) => i.daf_ref_key)).size;
    return [{
      title: 'DafSync digest',
      body: `${count} new ${count === 1 ? 'message' : 'messages'} in ${threads.length} ${threads.length === 1 ? 'discussion' : 'discussions'}`
        + (dafs > 1 ? ` across ${dafs} dapim` : ` on ${core.dafLabelFromKey(items[0].daf_ref_key)}`),
      url: inboxUrl(items[0]),
      tag: 'live-digest',
    }];
  }

  if (threads.length > MAX_SEPARATE) {
    return [{
      title: 'DafSync',
      body: `${threads.length} discussions have new activity`,
      url: inboxUrl(items[0]),
      tag: 'live-summary',
    }];
  }

  return threads.map((group) => {
    const latest = group[0];
    const text = core.notificationText({ kind: latest.kind, actor_display_name: latest.actor, daf_ref_key: latest.daf_ref_key });
    const more = group.length - 1;
    return {
      title: text,
      body: clip(latest.preview || '', 140) + (more > 0 ? ` (+${more} more)` : ''),
      url: threadUrl(latest),
      tag: `live-thread-${latest.thread_id}`,
    };
  });
}

// The VAPID settings the sender needs; null when any is missing (background alerts are then
// simply not offered).
export function pushConfig(get) {
  const publicKey = get('VAPID_PUBLIC_KEY');
  const privateKey = get('VAPID_PRIVATE_KEY');
  const serviceKey = get('SUPABASE_SERVICE_ROLE_KEY');
  if (!publicKey || !privateKey || !serviceKey) return null;
  return {
    publicKey, privateKey, serviceKey,
    subject: get('VAPID_SUBJECT') || 'mailto:admin@dafsync.com',
    supabaseUrl: get('SUPABASE_URL') || 'https://cyexvsymuivvvhvpeber.supabase.co',
  };
}

// Whether the push service said the device is gone for good.
export const isGone = (error) => error && (error.statusCode === 404 || error.statusCode === 410);
