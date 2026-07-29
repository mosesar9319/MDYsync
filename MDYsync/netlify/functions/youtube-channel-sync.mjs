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
// This only ever *creates* a video-links file; if one already exists for a
// ref (from this job or a manual paste), it's left alone, so a reader's own
// correction is never silently overwritten by a later poll.

import {
  decodeHtmlEntities,
  buildTalmudLookup,
  parseChannelTitle,
  readingsForVideo,
  refKeyFor,
  refDisplay,
} from '../../shared/mdy-channel.mjs';

const OWNER = 'mosesar9319';
const REPO = 'MDYsync';
const CHANNEL_ID = 'UCKwQa5DB_VR98ac_r-Wyl-g'; // @MercazDafYomi
const TALMUD_INDEX_URL = `https://raw.githubusercontent.com/${OWNER}/${REPO}/main/MDYsync/talmud_index.json`;

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
      label: decodeHtmlEntities(entry.title).slice(0, 40),
      // Every daf this one video actually covers, in reading order, as plain
      // refs with no variant/language markers -- exactly the shape
      // trigger-ocr-job wants. Without this the player knows a link exists
      // for the daf on screen but not whether that video also covers its
      // neighbours, so a one-click sync from the daf page would have to
      // guess (and a wrong guess produces an alignment matched against the
      // wrong stretch of canonical text). The variant/language are implied
      // by the file's own key, so they're deliberately not repeated here.
      coveredRefs: readings.map((r) => `${r.tractate} ${r.daf}${r.amud}`),
    };
    const body = JSON.stringify(videoSource);

    for (const reading of readings) {
      const key = refKeyFor(reading);
      if (existingKeys.has(key)) continue;
      try {
        const putResponse = await fetch(
          `https://api.github.com/repos/${OWNER}/${REPO}/contents/video-links/${key}.json`,
          {
            method: 'PUT',
            headers,
            body: JSON.stringify({
              message: `Auto-link ${refDisplay(reading)} to ${entry.videoId}`,
              content: Buffer.from(body, 'utf8').toString('base64'),
              branch: 'results',
            }),
          }
        );
        if (putResponse.ok) {
          existingKeys.add(key);
          published.push({ ref: refDisplay(reading), videoId: entry.videoId });
        } else {
          skipped.push({ ref: refDisplay(reading), videoId: entry.videoId, reason: `publish failed (${putResponse.status})` });
        }
      } catch (error) {
        skipped.push({ ref: refDisplay(reading), videoId: entry.videoId, reason: error.message });
      }
    }
  }

  return Response.json({ published, skipped });
};

export const config = {
  schedule: '0 * * * *',
};
