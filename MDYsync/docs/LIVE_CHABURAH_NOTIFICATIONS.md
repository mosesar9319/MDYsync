# Cloud Chaburah Live — notifications (phase 3)

What a person can choose, and what has to be set up on the server for background alerts.

## What people can choose (the gear in the panel)

- **Where:** in the panel and as small messages on the page (always works), and/or background
  alerts on devices that agreed (browser permission prompt = consent; nothing is asked or sent
  before the button is pressed).
- **What (combinable):** my discussions (replies to me, mentions, discussions I follow — the
  suggested start); new discussions on my dapim (dapim followed, plus the daf open now); new
  discussions anywhere (off by default; arrives as a digest unless "as they happen" is chosen);
  live alerts while using the site (no push).
- **When:** group background alerts (right away / 5 / 15 / 60 minutes), a daily digest at a chosen
  hour, quiet hours, a snooze ("pause for a while"), and "turn off all notifications".
- **Mutes:** per discussion (chat header) and per daf (list header).
- A tapped alert opens that discussion, with its words highlighted. A grouped alert opens the inbox.

The panel's inbox always shows everything that is not muted or turned off; batching, quiet hours
and the digest only delay **background** alerts.

## How it works

`live_messages` insert → trigger `live_messages_notify` writes one `live_notifications` row per
person per message (most specific reason wins: mention → reply to me → reply in my discussion →
followed discussion; a first message also reaches daf followers and "everything" subscribers).
Each row carries `deliver_after`, computed from that person's settings (`live_push_time`).
Reading a discussion clears its notifications (`live_read_state` trigger).

In-app: a private Broadcast topic `notify:user:<id>` (a policy lets a person join only their own)
plus a once-a-minute catch-up.

Background: `netlify/functions/live-push-send.mjs` runs every minute, calls `live_push_claim`
(service key only), words the alerts (`shared/live-push.mjs`) and delivers them with Web Push to
each device. Anything already read is dropped; devices the push service reports gone are removed.
The service worker is `/live-sw.js` — it only shows alerts and opens the right page; it caches
and intercepts nothing.

## Turning on background alerts (once, by the site owner)

Set these environment variables in Netlify (Site configuration → Environment variables):

| Variable | Value |
|---|---|
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | from `npx web-push generate-vapid-keys` |
| `VAPID_SUBJECT` | `mailto:` an address you read (optional; defaults to `mailto:admin@dafsync.com`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project settings → API → `service_role` (secret; never put it in browser code) |

Until all three of the first and last rows are set, the settings say background alerts "are not set
up on the server yet", and everything else works. On iPhone/iPad, web push only works for a site
added to the Home Screen; the settings say so.

## Database

`supabase/migrations/20261026100000_live_chaburah_notifications.sql` (+ `.down.sql`). Also
redefines `live_unread_counts` (phase 2) so a muted discussion shows no number. No table here has
a client policy: everything goes through functions, and push keys are never readable.
Tests: `supabase/tests/live_chaburah_notifications.sql` (`./supabase/run-tests.sh`).
