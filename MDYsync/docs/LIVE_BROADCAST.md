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

## After the stream ends (phase 2)

The same poll watches a linked live recording once YouTube has set `actualEndTime`. It reads `lengthSeconds` (`contentDetails.duration`). The first reading is stored on the video link as `lengthCheck`. A later reading at least 10 minutes afterwards, within 2 seconds of the first, means the processed file has settled. If `autoSyncNewUploads` is on (the same switch as the hourly sync), one caption-OCR job is dispatched for that video id.

The job downloads the processed file as an ordinary video, without `--live-from-start`. A normal upload still uses `--live-from-start`, which does nothing once the file is already finished.

The alignment is published only at `results/by-video/<id>.json` (Hebrew recordings use the `Hebrew-` prefix). It is not written to `by-ref/`, so it cannot be played against the edited upload. The player, for a live link, reads that by-video file and ignores a by-ref alignment from any other video.

Two gates, either of which leaves the recording on the site with no highlight:

- **Length.** The OpenCV duration of the download (frame count ÷ fps, the same clock the aligner uses) must be within 2 seconds of the YouTube length the poll sent. Otherwise the outcome is `rejected-length` and nothing is published.
- **Captions.** At least 200 highlighted-caption samples, and at least 20% of the phrases from a real match rather than a guess. The Hebrew Bekhorot 40 live file (`4vSdKjq5P6s`) had 65 samples and 11 of 198 phrases real (6%). The other Bekhorot 39–41 live files that actually read the caption band were at 43–53% real phrases, with hundreds of real words (one English run logged 4,896 samples). The thresholds sit in that gap. There is no voice fallback.

Each job writes `results/live-outcomes/<videoId>.json` with `outcome` of `synced`, `rejected-length`, or `rejected-captions`. After a week, that folder is the tally. A video that already has an outcome, or a `by-video` alignment, or a dispatch from the last 6 hours, is not queued again. Only the recording the site is keeping (the one on the air, or the longest finished one) is queued.

### The first real shiur after this is merged

1. Confirm `autoSyncNewUploads` is on (it is the admin switch already used for new uploads).
2. When the stream ends, wait about 15 minutes. The link's `lengthCheck.firstSeenAt` should be at least 10 minutes old and the next poll should dispatch `run-ocr-job` with `liveRecording: true`.
3. The Actions log for that job should download without `--live-from-start`, then either publish `by-video/<id>.json` or write `live-outcomes/<id>.json` with `rejected-length` or `rejected-captions`.
4. Open that daf. The highlight should follow this recording. It should not follow any other video's timestamps. If the outcome is a rejection, the daf is on screen and nothing is highlighted.
