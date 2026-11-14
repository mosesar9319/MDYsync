// Turns verified livestreams into video-links and a catalog row.
// Writes only the daf the title names (not the previous daf's tail).
// Never dispatches OCR. Never overwrites a link that is not itself a
// livestream — that replacement belongs to the edited upload, which the
// hourly Videos-tab sync already performs.

import {
  buildTalmudLookup,
  parseChannelTitle,
  amudimForDaf,
  readingsForVideo,
  refKeyFor,
  refDisplay,
  plainRef,
} from './mdy-channel.mjs';
import { MDY_CHANNEL_ID } from './youtube-broadcast.mjs';
import {
  describeLiveVideo,
  feedEntryIsRecent,
  isWithinLookback,
  selectRecording,
  shouldDispatchLiveAlignment,
  advanceLengthCheck,
  videosListUrl,
  parseFeedEntries,
  liveTabFeed,
  WEBSUB_HUB,
  WEBSUB_TOPIC,
  leaseRenewalDue,
} from './live-broadcast.mjs';

const OWNER = 'mosesar9319';
const REPO = 'MDYsync';
const TALMUD_INDEX_URL = `https://raw.githubusercontent.com/${OWNER}/${REPO}/main/MDYsync/talmud_index.json`;
const SETTINGS_URL = `https://raw.githubusercontent.com/${OWNER}/${REPO}/results/settings.json`;

function comboKeyFor(language) {
  return language === 'he' ? 'regularHe' : 'regularEn';
}

export function primaryReadings(parsed, lookup) {
  if (!parsed || parsed.variant !== 'regular') return [];
  const entry = lookup.byName.get(parsed.tractate.toLowerCase());
  if (!entry) return [];
  return amudimForDaf(entry, parsed.daf).map((amud) => ({
    tractate: parsed.tractate,
    daf: parsed.daf,
    amud,
    variant: 'regular',
    language: parsed.language,
  }));
}

export function liveVideoSource(video, readings) {
  return {
    type: 'youtube',
    url: `https://www.youtube.com/watch?v=${video.videoId}`,
    videoId: video.videoId,
    label: String(video.title || video.label || '').slice(0, 100),
    coveredRefs: readings.map((reading) => plainRef(reading)),
    source: 'live-auto',
    liveBroadcast: true,
    liveStatus: video.liveStatus,
    durationSeconds: Number(video.durationSeconds) || null,
    // Phase 2 reads these when it decides the processed file has settled.
    actualStartTime: video.actualStartTime || null,
    actualEndTime: video.actualEndTime || null,
    locked: false,
  };
}

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  };
}

async function readJsonFile(fetchImpl, token, path) {
  const response = await fetchImpl(
    `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}?ref=results`,
    { headers: githubHeaders(token) }
  );
  if (response.status === 404) return { file: null, sha: null };
  if (!response.ok) throw new Error(`GitHub contents ${path} returned ${response.status}`);
  const body = await response.json();
  const json = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'));
  return { file: json, sha: body.sha };
}

async function writeJsonFile(fetchImpl, token, path, json, message, sha) {
  const response = await fetchImpl(
    `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`,
    {
      method: 'PUT',
      headers: githubHeaders(token),
      body: JSON.stringify({
        message,
        content: Buffer.from(JSON.stringify(json, null, 2) + '\n', 'utf8').toString('base64'),
        branch: 'results',
        ...(sha ? { sha } : {}),
      }),
    }
  );
  if (!response.ok) throw new Error(`GitHub write ${path} returned ${response.status}`);
}

function groupKey(parsed) {
  return `${parsed.language}:${parsed.tractate}:${parsed.daf}`;
}

export function planGroups(described, lookup) {
  const groups = new Map();
  for (const video of described) {
    if (!video || video.liveStatus === 'upcoming') continue;
    if (video.channelId && video.channelId !== MDY_CHANNEL_ID) continue;
    const parsed = parseChannelTitle(video.title, lookup);
    // Chazarah is not streamed. A title that is not the main shiur is ignored.
    if (!parsed || parsed.variant !== 'regular') continue;
    const readings = primaryReadings(parsed, lookup);
    if (!readings.length) continue;
    const key = groupKey(parsed);
    if (!groups.has(key)) groups.set(key, { parsed, readings, videos: [] });
    groups.get(key).videos.push(video);
  }
  return [...groups.values()];
}

async function applyCatalog(fetchImpl, token, reading, video, label) {
  const path = 'catalog.json';
  const { file, sha } = await readJsonFile(fetchImpl, token, path);
  const catalog = file && typeof file === 'object' ? file : { tractates: {} };
  if (!catalog.tractates) catalog.tractates = {};
  const rows = catalog.tractates[reading.tractate] || (catalog.tractates[reading.tractate] = []);
  let row = rows.find((item) => item.daf === reading.daf);
  if (!row) {
    row = { daf: reading.daf };
    rows.push(row);
    rows.sort((a, b) => a.daf - b.daf);
  }
  const combo = comboKeyFor(reading.language);
  const existing = row[combo];
  if (existing?.videoId && !existing.liveBroadcast) return 'catalog kept the edited upload';
  row[combo] = {
    videoId: video.videoId,
    label: label.slice(0, 100),
    amud: reading.amud,
    liveBroadcast: true,
    liveStatus: video.liveStatus,
    ...(Number(video.durationSeconds) ? { durationSeconds: Number(video.durationSeconds) } : {}),
  };
  catalog.generatedAt = new Date().toISOString();
  await writeJsonFile(fetchImpl, token, path, catalog, `Update video catalog for live ${video.videoId}`, sha);
  return 'catalog updated';
}

function byVideoPath(language, videoId) {
  return `by-video/${language === 'he' ? 'Hebrew-' : ''}${videoId}.json`;
}

async function existsOnResults(fetchImpl, token, path) {
  const response = await fetchImpl(
    `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}?ref=results`,
    { headers: githubHeaders(token) }
  );
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`GitHub contents ${path} returned ${response.status}`);
  return true;
}

async function dispatchLiveOcr(fetchImpl, token, { video, refs, expectedDurationSeconds }) {
  const jobId = crypto.randomUUID().replace(/-/g, '');
  const response = await fetchImpl(
    `https://api.github.com/repos/${OWNER}/${REPO}/dispatches`,
    {
      method: 'POST',
      headers: githubHeaders(token),
      body: JSON.stringify({
        event_type: 'run-ocr-job',
        client_payload: {
          driveUrl: null,
          youtubeUrl: `https://www.youtube.com/watch?v=${video.videoId}`,
          refs,
          jobId,
          variant: 'regular',
          language: video.language,
          liveRecording: true,
          expectedDurationSeconds,
        },
      }),
    }
  );
  if (!(response.ok || response.status === 204)) {
    throw new Error(`alignment dispatch returned ${response.status}`);
  }
  return jobId;
}

export async function publishGroups({ groups, fetchImpl, token, lookup, autoSync = false, now = new Date() }) {
  const published = [];
  const skipped = [];
  const dispatched = [];
  for (const group of groups) {
    const amudA = group.readings.find((reading) => reading.amud === 'a') || group.readings[0];
    let reads;
    try {
      reads = [];
      for (const reading of group.readings) {
        const path = `video-links/${refKeyFor(reading)}.json`;
        const current = await readJsonFile(fetchImpl, token, path);
        reads.push({ reading, path, ...current });
      }
    } catch (error) {
      skipped.push({ videoId: group.videos[0]?.videoId, reason: error.message });
      continue;
    }
    if (reads.some((item) => item.file?.videoId && !item.file.liveBroadcast)) {
      skipped.push({ ref: refDisplay(amudA), videoId: group.videos.map((video) => video.videoId).join(','), reason: 'edited upload stays' });
      continue;
    }
    const anchor = reads.find((item) => item.reading.amud === 'a') || reads[0];
    const decision = selectRecording(anchor.file, group.videos);
    // 'keep' with a video still needs the length check: the id did not
    // change, and the second stable reading is what starts alignment.
    if (!decision.video) {
      skipped.push({
        ref: refDisplay(amudA),
        videoId: group.videos.map((video) => video.videoId).join(','),
        reason: decision.reason,
      });
      continue;
    }
    const chosen = decision.video;
    const same = anchor.file?.videoId === chosen.videoId;
    const priorCheck = same ? anchor.file?.lengthCheck : null;
    let lengthCheck = priorCheck || null;
    let stable = false;
    if (chosen.liveStatus === 'finished' && Number(chosen.durationSeconds) > 0) {
      const advanced = advanceLengthCheck(priorCheck, chosen.durationSeconds, now);
      lengthCheck = advanced.lengthCheck;
      stable = advanced.stable;
    }
    let outcome = same ? anchor.file?.alignmentOutcome || null : null;
    let alreadyAligned = false;
    let dispatchedAt = same ? anchor.file?.alignmentDispatchedAt || null : null;
    if (chosen.liveStatus === 'finished') {
      try {
        if (!outcome && await existsOnResults(fetchImpl, token, `live-outcomes/${chosen.videoId}.json`)) {
          outcome = 'recorded';
        }
        alreadyAligned = await existsOnResults(fetchImpl, token, byVideoPath(amudA.language, chosen.videoId));
      } catch (error) {
        skipped.push({ ref: refDisplay(amudA), videoId: chosen.videoId, reason: error.message });
        continue;
      }
    }
    const dispatch = shouldDispatchLiveAlignment({
      autoSync,
      liveStatus: chosen.liveStatus,
      actualEndTime: chosen.actualEndTime,
      lengthStable: stable,
      isKept: true,
      alreadyAligned,
      outcome,
      dispatchedAt,
    });
    if (dispatch) dispatchedAt = now.toISOString();
    const source = {
      ...liveVideoSource(chosen, group.readings),
      ...(lengthCheck ? { lengthCheck } : {}),
      ...(dispatchedAt ? { alignmentDispatchedAt: dispatchedAt } : {}),
      ...(outcome ? { alignmentOutcome: outcome } : {}),
    };
    const trackingChanged = JSON.stringify(lengthCheck || null) !== JSON.stringify(priorCheck || null)
      || (dispatch && dispatchedAt !== anchor.file?.alignmentDispatchedAt);
    if (decision.action === 'keep' && !trackingChanged) {
      skipped.push({
        ref: refDisplay(amudA),
        videoId: chosen.videoId,
        reason: decision.reason,
      });
      continue;
    }
    const message = decision.action === 'replace'
      ? `Link live ${refDisplay(amudA)} to ${chosen.videoId}`
      : `Update live ${refDisplay(amudA)} (${chosen.videoId})`;
    try {
      for (const item of reads) {
        await writeJsonFile(fetchImpl, token, item.path, source, message, item.sha);
        published.push({ ref: refDisplay(item.reading), videoId: chosen.videoId, action: decision.action });
      }
      await applyCatalog(fetchImpl, token, anchor.reading, chosen, source.label);
      if (dispatch) {
        const refs = readingsForVideo(group.parsed, lookup).map((reading) => plainRef(reading));
        const jobId = await dispatchLiveOcr(fetchImpl, token, {
          video: { videoId: chosen.videoId, language: amudA.language },
          refs,
          expectedDurationSeconds: Number(lengthCheck.seconds),
        });
        dispatched.push({ videoId: chosen.videoId, jobId });
      }
    } catch (error) {
      skipped.push({ ref: refDisplay(amudA), videoId: chosen.videoId, reason: error.message });
    }
  }
  return { published, skipped, dispatched };
}

export async function loadLookup(fetchImpl) {
  const response = await fetchImpl(TALMUD_INDEX_URL);
  if (!response.ok) throw new Error(`talmud_index.json returned ${response.status}`);
  return buildTalmudLookup(await response.json());
}

export async function verifyVideoIds(ids, { fetchImpl, apiKey }) {
  if (!apiKey) return { videos: [], error: 'YOUTUBE_API_KEY is not set' };
  if (!ids.length) return { videos: [], error: null };
  const videos = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const response = await fetchImpl(videosListUrl(chunk, apiKey));
    if (!response.ok) return { videos, error: `YouTube Data API returned ${response.status}` };
    const body = await response.json();
    for (const item of body.items || []) {
      const described = describeLiveVideo(item);
      if (described) videos.push(described);
    }
  }
  return { videos, error: null };
}

export async function ingestDescribed(videos, { fetchImpl, token, lookup, autoSync = false, now = new Date() }) {
  const recent = videos.filter((video) => video.liveStatus === 'live' || isWithinLookback(video.publishedAt, now));
  const groups = planGroups(recent, lookup);
  if (!token) return { published: [], skipped: [{ reason: 'GitHub token is not set' }], dispatched: [] };
  return publishGroups({ groups, fetchImpl, token, lookup, autoSync, now });
}

export async function readAutoSync(fetchImpl) {
  try {
    const response = await fetchImpl(`${SETTINGS_URL}?t=${Date.now()}`);
    if (!response.ok) return false;
    return Boolean((await response.json()).autoSyncNewUploads);
  } catch {
    return false;
  }
}

// The public playlist RSS answers 200, then 404, then 500, with no
// pattern (the same flakiness trigger-ocr-job.mjs already retries).
async function fetchFeed(fetchImpl) {
  let last = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    last = await fetchImpl(liveTabFeed(), {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/atom+xml' },
    });
    if (last.ok) return last;
  }
  return last;
}

export async function pollLive({ fetchImpl, token, apiKey, callback, verifyToken = '', now = new Date() }) {
  const renewed = await maybeRenewLease({ fetchImpl, callback, verifyToken, now });
  const feedResponse = await fetchFeed(fetchImpl);
  if (!feedResponse.ok) {
    return { renewed, published: [], skipped: [], error: `YouTube live feed returned ${feedResponse.status}`, dispatched: false };
  }
  const feedText = await feedResponse.text();
  const recentIds = parseFeedEntries(feedText).filter((entry) => feedEntryIsRecent(entry, now)).map((entry) => entry.videoId);
  const verified = await verifyVideoIds(recentIds, { fetchImpl, apiKey });
  if (verified.error) {
    return { renewed, published: [], skipped: [], error: verified.error, dispatched: false };
  }
  const lookup = await loadLookup(fetchImpl);
  const autoSync = await readAutoSync(fetchImpl);
  const result = await ingestDescribed(verified.videos, { fetchImpl, token, lookup, autoSync, now });
  return { renewed, autoSync, ...result, checked: recentIds };
}

async function maybeRenewLease({ fetchImpl, callback, verifyToken, now }) {
  if (!callback || !leaseRenewalDue(now)) return false;
  const body = new URLSearchParams({
    'hub.mode': 'subscribe',
    'hub.topic': WEBSUB_TOPIC,
    'hub.callback': callback,
    'hub.verify': 'async',
    'hub.lease_seconds': '432000',
  });
  if (verifyToken) body.set('hub.verify_token', verifyToken);
  const response = await fetchImpl(WEBSUB_HUB, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  return response.ok || response.status === 202 || response.status === 204;
}

export function webSubCallbackFromEnv(envGet) {
  const override = envGet('YOUTUBE_WEBSUB_CALLBACK');
  if (override) return override;
  const site = envGet('URL');
  return site ? `${site.replace(/\/$/, '')}/api/youtube-live-webhook` : '';
}
