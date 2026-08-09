// Scheduled job: polls the Mercaz Daf Yomi YouTube channel's upload feed,
// figures out which daf(s) each new video covers from its title, and
// publishes a video-links/<refKey>.json for each -- the same file
// save-video-link.mjs writes when a reader pastes a link by hand, just
// triggered by a schedule instead of a paste. This is the only piece
// allowed to hold the GitHub token that can write to the repo; it never
// touches the alignment/OCR pipeline, only the video-link association.
//
// The channel uploads four separate recordings per daf (regular and
// "Chazarah Daf", each in English and Hebrew) and titles them consistently;
// parsing a title into the daf refs it covers lives in shared/mdy-channel.mjs,
// which tools/backfill-video-links.mjs imports too so the two can't drift.
//
// Almost every shiur opens with the tail end of the previous daf's amud b
// before moving on to the new daf's a and b, so each video is published
// under three refs, not one: the previous daf's b (if it exists) and the
// new daf's a and b (if it exists) -- see readingsForVideo().
//
// This job only ever sees the 15 newest uploads, since that's all the
// channel's RSS feed carries -- backfilling anything older is what the
// manually-dispatched backfill-video-links workflow is for.
//
// A link is normally left alone once it exists, so a reader's own pasted
// correction is never silently overwritten by a later poll. The one
// exception: the channel sometimes posts an unedited cut of a shiur first,
// then replaces it on YouTube with the finished edit under a fresh upload
// (same daf/variant/language, new videoId) once it's ready. When a newly
// seen upload resolves to a ref that's already linked, but the existing
// link is itself channel-derived (see the `source: 'channel-auto'` marker
// below, also written by backfill-video-links.mjs) rather than a reader's
// own paste, the new video replaces it. A link with no marker at all --
// anything saved through save-video-link.mjs, or written before this
// marker existed -- is never touched.
//
// Optionally (results/settings.json's autoSyncNewUploads, toggled from the
// player's admin-only sync dialog and written by save-settings.mjs), a
// video that actually got a new/replaced link also has a server-side OCR
// sync job dispatched for it automatically -- the same run-ocr-job event
// trigger-ocr-job.mjs sends for a manual "Sync from video" click, just
// self-triggered instead of requiring an admin to notice the new upload
// and start it by hand. Skipped when the toggle is off (the default), and
// per-video rather than per-reading, so one shiur covering three refs
// (previous daf's tail b, this daf's a and b) gets exactly one job
// covering all three, not three separate jobs.

import {
  decodeHtmlEntities,
  buildTalmudLookup,
  parseChannelTitle,
  readingsForVideo,
  refKeyFor,
  refDisplay,
  plainRef,
} from '../../shared/mdy-channel.mjs';

const OWNER = 'mosesar9319';
const REPO = 'MDYsync';
const CHANNEL_ID = 'UCKwQa5DB_VR98ac_r-Wyl-g'; // @MercazDafYomi
const TALMUD_INDEX_URL = `https://raw.githubusercontent.com/${OWNER}/${REPO}/main/MDYsync/talmud_index.json`;
const SETTINGS_URL = `https://raw.githubusercontent.com/${OWNER}/${REPO}/results/settings.json`;

function comboKeyFor(variant, language) {
  const variantPart = variant === 'chazarah' ? 'chazarah' : 'regular';
  const languagePart = language === 'he' ? 'He' : 'En';
  return `${variantPart}${languagePart}`;
}

function parseFeedEntries(xml) {
  const entries = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;
  while ((match = entryRegex.exec(xml))) {
    const block = match[1];
    const videoId = /<yt:videoId>([^<]+)<\/yt:videoId>/.exec(block)?.[1];
    const title = /<title>([^<]*)<\/title>/.exec(block)?.[1];
    const published = /<published>([^<]*)<\/published>/.exec(block)?.[1];
    if (videoId && title) entries.push({ videoId, title, published });
  }
  return entries;
}

export default async (request) => {
  const token = Netlify.env.get('GITHUB_DISPATCH_TOKEN');
  if (!token) {
    return Response.json({ error: 'Server publish is not configured yet.' }, { status: 503 });
  }
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  };

  let talmudIndex;
  try {
    const response = await fetch(TALMUD_INDEX_URL);
    if (!response.ok) throw new Error(`talmud_index.json returned ${response.status}`);
    talmudIndex = await response.json();
  } catch (error) {
    return Response.json({ error: `Could not load talmud_index.json: ${error.message}` }, { status: 502 });
  }
  const lookup = buildTalmudLookup(talmudIndex);

  // Missing/unreadable settings.json defaults to off -- auto-syncing is
  // opt-in, not a behavior change every existing deployment suddenly gets.
  let autoSyncEnabled = false;
  try {
    const response = await fetch(`${SETTINGS_URL}?t=${Date.now()}`);
    if (response.ok) autoSyncEnabled = Boolean((await response.json()).autoSyncNewUploads);
  } catch {
    // Leave it off.
  }

  let entries;
  try {
    const response = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`);
    if (!response.ok) throw new Error(`YouTube feed returned ${response.status}`);
    entries = parseFeedEntries(await response.text());
  } catch (error) {
    return Response.json({ error: `Could not read the channel feed: ${error.message}` }, { status: 502 });
  }

  // One tree listing up front tells us every video-links ref that already
  // exists, so per-video work below is pure local computation -- no GET
  // per candidate ref, and no risk of overwriting an existing file.
  let existingKeys;
  try {
    const treeResponse = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/git/trees/results?recursive=1`);
    if (!treeResponse.ok) throw new Error(`GitHub tree API returned ${treeResponse.status}`);
    const tree = await treeResponse.json();
    existingKeys = new Set(
      (tree.tree || [])
        .filter((item) => item.type === 'blob' && item.path.startsWith('video-links/') && item.path.endsWith('.json'))
        .map((item) => item.path.slice('video-links/'.length, -'.json'.length))
    );
  } catch (error) {
    return Response.json({ error: `Could not list existing video links: ${error.message}` }, { status: 502 });
  }

  const published = [];
  const skipped = [];
  const catalogUpdates = []; // { tractate, daf, amud, comboKey, videoId, label }

  for (const entry of entries) {
    const parsed = parseChannelTitle(entry.title, lookup);
    if (!parsed) {
      skipped.push({ videoId: entry.videoId, title: entry.title, reason: 'title did not match a known pattern' });
      continue;
    }
    const readings = readingsForVideo(parsed, lookup);
    const videoSource = {
      type: 'youtube',
      url: `https://www.youtube.com/watch?v=${entry.videoId}`,
      videoId: entry.videoId,
      label: decodeHtmlEntities(entry.title).slice(0, 100),
      // Every daf this one video actually covers, in reading order, as plain
      // refs with no variant/language markers -- exactly the shape
      // trigger-ocr-job wants. Without this the player knows a link exists
      // for the daf on screen but not whether that video also covers its
      // neighbours, so a one-click sync from the daf page would have to
      // guess (and a wrong guess produces an alignment matched against the
      // wrong stretch of canonical text). The variant/language are implied
      // by the file's own key, so they're deliberately not repeated here.
      coveredRefs: readings.map((r) => `${r.tractate} ${r.daf}${r.amud}`),
      // See the file-level comment: only a link carrying this marker is
      // ever eligible to be silently replaced by a later upload.
      source: 'channel-auto',
    };
    const body = JSON.stringify(videoSource);
    let entryPublishedCount = 0;

    for (const reading of readings) {
      const key = refKeyFor(reading);
      // Only a video's own daf (not the tail reading it also opens on, for
      // the *previous* daf) is ever eligible to replace an existing link.
      // Without this, a later video's tail reference could overwrite a
      // perfectly good primary link for a daf it doesn't actually belong
      // to -- e.g. next week's shiur opening on the tail of this daf's amud
      // b would otherwise be able to bump this daf's own, correct video.
      const isPrimary = reading.daf === parsed.daf;
      let existingSha;
      if (existingKeys.has(key)) {
        let existingLink;
        if (isPrimary) {
          try {
            const getResponse = await fetch(
              `https://api.github.com/repos/${OWNER}/${REPO}/contents/video-links/${key}.json?ref=results`,
              { headers }
            );
            if (getResponse.ok) {
              const file = await getResponse.json();
              existingSha = file.sha;
              existingLink = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
            }
          } catch {
            // Couldn't read it -- treat like any other unreadable file below:
            // leave it alone rather than risk clobbering something unknown.
          }
        }
        if (!existingLink || existingLink.videoId === entry.videoId) continue; // already up to date, tail reading, or unreadable
        if (existingLink.source !== 'channel-auto') continue; // a reader's own paste -- never auto-replaced
        // Falls through: this video's own daf, the existing link is
        // channel-derived, and it points at a different video (the
        // unedited-cut-replaced-by-the-finished-edit case) -- overwrite it
        // below instead of skipping.
      }
      try {
        const putResponse = await fetch(
          `https://api.github.com/repos/${OWNER}/${REPO}/contents/video-links/${key}.json`,
          {
            method: 'PUT',
            headers,
            body: JSON.stringify({
              message: existingSha
                ? `Replace ${refDisplay(reading)}'s linked video with ${entry.videoId}`
                : `Auto-link ${refDisplay(reading)} to ${entry.videoId}`,
              content: Buffer.from(body, 'utf8').toString('base64'),
              branch: 'results',
              ...(existingSha ? { sha: existingSha } : {}),
            }),
          }
        );
        if (putResponse.ok) {
          existingKeys.add(key);
          published.push({ ref: refDisplay(reading), videoId: entry.videoId });
          entryPublishedCount++;
          catalogUpdates.push({
            tractate: reading.tractate,
            daf: reading.daf,
            amud: reading.amud,
            comboKey: comboKeyFor(reading.variant, reading.language),
            videoId: entry.videoId,
            label: decodeHtmlEntities(entry.title).slice(0, 100),
          });
        } else {
          skipped.push({ ref: refDisplay(reading), videoId: entry.videoId, reason: `publish failed (${putResponse.status})` });
        }
      } catch (error) {
        skipped.push({ ref: refDisplay(reading), videoId: entry.videoId, reason: error.message });
      }
    }

    // One job per video, covering every ref it actually got linked to this
    // run -- not one per reading, and not for a video that turned out to be
    // already up to date (entryPublishedCount stays 0 for those).
    if (autoSyncEnabled && entryPublishedCount) {
      try {
        const dispatchResponse = await fetch(
          `https://api.github.com/repos/${OWNER}/${REPO}/dispatches`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({
              event_type: 'run-ocr-job',
              client_payload: {
                driveUrl: null,
                youtubeUrl: videoSource.url,
                // Plain refs, no variant/language marker -- these get
                // fetched straight from Sefaria by caption_ocr_align.py,
                // which doesn't understand "(Chazarah Daf)"/"(Hebrew)" (see
                // plainRef's own comment). Every auto-dispatched Hebrew/
                // Chazarah job was failing at that fetch (or worse,
                // resolving to the wrong text and silently matching zero
                // captions) before this fix.
                refs: readings.map((r) => plainRef(r)),
                jobId: crypto.randomUUID().replace(/-/g, ''),
                variant: parsed.variant || 'regular',
                language: parsed.language || 'en',
              },
            }),
          }
        );
        if (!dispatchResponse.ok) {
          skipped.push({ videoId: entry.videoId, reason: `auto-sync dispatch failed (${dispatchResponse.status})` });
        }
      } catch (error) {
        skipped.push({ videoId: entry.videoId, reason: `auto-sync dispatch error: ${error.message}` });
      }
    }
  }

  // catalog.json is the front end's one-fetch summary of every linked video
  // (see tools/build-video-catalog.mjs); patched here with just the rows this
  // run touched rather than rebuilt from scratch, since rebuilding would mean
  // re-fetching and re-parsing every video-links file on every hourly run.
  if (catalogUpdates.length) {
    try {
      const catalogResponse = await fetch(
        `https://api.github.com/repos/${OWNER}/${REPO}/contents/catalog.json?ref=results`,
        { headers }
      );
      let catalog = { tractates: {} };
      let sha;
      if (catalogResponse.ok) {
        const file = await catalogResponse.json();
        sha = file.sha;
        catalog = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
        if (!catalog.tractates) catalog.tractates = {};
      }
      for (const update of catalogUpdates) {
        // One row per daf, not per amud -- see tools/build-video-catalog.mjs
        // for why: the channel publishes one video per daf, so amud a and b
        // collapse into a single row, preferring whichever combo entry
        // anchors on amud 'a' (the natural start of the daf) when both
        // amudim get linked.
        const rows = catalog.tractates[update.tractate] || (catalog.tractates[update.tractate] = []);
        let row = rows.find((r) => r.daf === update.daf);
        if (!row) {
          row = { daf: update.daf };
          rows.push(row);
          rows.sort((a, b) => a.daf - b.daf);
        }
        const existing = row[update.comboKey];
        if (existing && existing.amud === 'a' && update.amud !== 'a') continue;
        row[update.comboKey] = { videoId: update.videoId, label: update.label, amud: update.amud };
      }
      catalog.generatedAt = new Date().toISOString();
      await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/catalog.json`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          message: `Update video catalog (${catalogUpdates.length} row(s))`,
          content: Buffer.from(JSON.stringify(catalog, null, 2) + '\n', 'utf8').toString('base64'),
          branch: 'results',
          ...(sha ? { sha } : {}),
        }),
      });
    } catch (error) {
      // catalog.json is a derived convenience file, not the source of truth
      // (video-links/ is) -- a failure here shouldn't fail the whole run or
      // stop the individually-published video-links files above from
      // counting as published.
      console.error('Could not update catalog.json', error);
    }
  }

  return Response.json({ published, skipped });
};

export const config = {
  schedule: '0 * * * *',
};
