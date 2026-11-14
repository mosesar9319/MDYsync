# Live shiurim (phase 1)

When a Mercaz Daf Yomi English or Hebrew shiur goes live, DafSync links that video for the daf in the title and plays it on the site. The daf is shown underneath. Words are not highlighted. The edited upload, once it exists, is left alone. A second live video does not replace one that is already on the air; of two finished live recordings, the longer one is kept.

Chazarah is not part of this. Other maggidim are not part of this. Nothing here starts the caption or voice alignment jobs. That wait — until YouTube's processed file has a stable length — is phase 2 (`shouldDispatchLiveAlignment` in `shared/live-broadcast.mjs` is the hook, and it returns false).

The hourly Videos-tab sync is unchanged. When the edited upload appears there, it still replaces this unlocked live link. That is the swap phase 3 will make wait until the edit's own alignment exists.

## What has to be set

On the Netlify site, for production functions:

| Name | Required | What it is |
|---|---|---|
| `YOUTUBE_API_KEY` | yes | A YouTube Data API v3 key. Used only for `videos.list` (`snippet`, `contentDetails`, `liveStreamingDetails`). The poll checks the handful of recent Live-tab ids every five minutes, about one quota unit each time, a few hundred units a day. Do not point this at `search.list`. |
| `GITHUB_DISPATCH_TOKEN` | yes | Already used by the hourly sync. Needs permission to write `video-links/` and `catalog.json` on the `results` branch. |
| `YOUTUBE_WEBSUB_TOKEN` | recommended | A random string. The hub lease renewal sends it as `hub.verify_token`, and the callback rejects a verification that presents a different one. |
| `YOUTUBE_WEBSUB_CALLBACK` | no | Defaults to `$URL/api/youtube-live-webhook`, which on production is `https://dafsync.netlify.app/api/youtube-live-webhook`. Set it only if the public site URL is different from Netlify's `URL`. |

`URL` is provided by Netlify. Do not hard-code a secret in the repo.

## One-time: tell YouTube where to push

Scheduled functions run on the published production deploy, not on a deploy preview. After this is merged and the env vars above are set, the poll renews the lease at 04:00, 12:00, and 20:00 UTC. To subscribe immediately instead of waiting for the next window:

```bash
curl -X POST https://pubsubhubbub.appspot.com/subscribe \
  -d "hub.mode=subscribe" \
  -d "hub.topic=https://www.youtube.com/xml/feeds/videos.xml?channel_id=UCKwQa5DB_VR98ac_r-Wyl-g" \
  -d "hub.callback=https://dafsync.netlify.app/api/youtube-live-webhook" \
  -d "hub.verify=async" \
  -d "hub.lease_seconds=432000" \
  -d "hub.verify_token=THE_SAME_YOUTUBE_WEBSUB_TOKEN"
```

A `202` from the hub means it accepted the request and will call the callback with `hub.challenge`. The function answers with that challenge as plain text. The Netlify function log for `youtube-live-webhook` is where that shows up.

Do not subscribe a deploy-preview URL. The preview cron does not run, and that callback goes away when the preview does.

The five-minute Live-tab poll does not need the hub. It is the backup if a push is missed. It still needs `YOUTUBE_API_KEY`, because a feed entry is not linked until `videos.list` says the video is a broadcast. That RSS answers 200, 404, and 500 with no pattern, so one miss is retried twice and then the cycle does nothing rather than guessing.
