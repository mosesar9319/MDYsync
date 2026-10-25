// Cloud Chaburah Live: sends the background alerts that are due. Runs every minute.
//
// The database decides who is due and what they asked for (live_push_claim: batching, quiet
// hours, the Shabbos pause, mutes, "already read"); this only words it (shared/live-push.mjs)
// and delivers it to each device that agreed. A device the push service reports as gone
// (404/410) is removed. Needs VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and SUPABASE_SERVICE_ROLE_KEY
// (and optionally VAPID_SUBJECT, SUPABASE_URL); without them it does nothing at all.

import webpush from 'web-push';
import { buildPushMessages, pushConfig, isGone } from '../../shared/live-push.mjs';

const env = (name) => (typeof Netlify !== 'undefined' ? Netlify.env.get(name) : process.env[name]);

async function rpc(config, name, body) {
  const res = await fetch(`${config.supabaseUrl}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: config.serviceKey, authorization: `Bearer ${config.serviceKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${name} failed: ${res.status}`);
  return res.status === 204 ? null : res.json().catch(() => null);
}

export async function sendDue(config, { send = webpush.sendNotification.bind(webpush), claim, drop } = {}) {
  const people = await (claim ? claim() : rpc(config, 'live_push_claim', { p_limit: 100 }));
  let sent = 0;
  let removed = 0;
  for (const person of people || []) {
    const messages = buildPushMessages(person);
    for (const device of person.devices || []) {
      for (const message of messages) {
        try {
          await send(
            { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } },
            JSON.stringify(message),
            { TTL: 60 * 60 * 24, urgency: 'normal', topic: message.tag.slice(0, 32).replace(/[^A-Za-z0-9_-]/g, '') },
          );
          sent += 1;
        } catch (error) {
          if (isGone(error)) {
            removed += 1;
            await (drop ? drop(device.endpoint) : rpc(config, 'live_push_drop', { p_endpoint: device.endpoint })).catch(() => {});
            break; // the rest of this device's messages have nowhere to go
          }
          console.warn('live-push-send: delivery failed', error && error.statusCode);
        }
      }
    }
  }
  return { people: (people || []).length, sent, removed };
}

export default async () => {
  const config = pushConfig(env);
  if (!config) return new Response('background alerts are not configured', { status: 200 });
  webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  try {
    const result = await sendDue(config);
    return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
  } catch (error) {
    console.error('live-push-send failed', error);
    return new Response('failed', { status: 500 });
  }
};

export const config = { schedule: '* * * * *' };
