// Phase 1: notice a Mercaz Daf Yomi livestream and decide what the site
// should link. Pure functions only — the Netlify poll and the WebSub
// callback share them, and the tests exercise them without GitHub.
//
// Phase 2: shouldDispatchLiveAlignment() is true only for the kept finished
// recording, after YouTube's length has agreed with itself for ten minutes,
// and only while autoSyncNewUploads is on. A thin caption read is rejected
// inside the OCR job, not here. Phase 3 (swap the edited upload in only
// once its own alignment exists) is still the hourly Videos-tab sync.
//
// Phase 3 already happens in youtube-channel-sync.mjs: an edited upload
// on the Videos tab replaces an unlocked link. This module never does
// the reverse.

import { MDY_CHANNEL_ID, isLivestreamVideo, liveTabFeedUrl } from './youtube-broadcast.mjs';

export const WEBSUB_HUB = 'https://pubsubhubbub.appspot.com/subscribe';
// YouTube's push topic is the channel's uploads feed. A notification means
// "a video id exists", including a scheduled stream, so the callback still
// confirms liveBroadcastContent with videos.list before linking anything.
export const WEBSUB_TOPIC = `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${MDY_CHANNEL_ID}`;

// A stream that ended this morning should still be the recording the site
// shows until the edited upload replaces it. Anything older than this is
// left alone — the Live-tab feed also carries broadcasts from years ago.
export const LIVE_LOOKBACK_MS = 36 * 60 * 60 * 1000;

export function videosListUrl(ids, apiKey) {
  const list = [...ids].filter(Boolean);
  return `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,liveStreamingDetails&id=${encodeURIComponent(list.join(','))}&key=${encodeURIComponent(apiKey)}`;
}

export function parseIsoDuration(value) {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(String(value || ''));
  if (!match) return null;
  const seconds = Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
  return seconds > 0 ? Math.round(seconds) : null;
}

function clockDuration(details) {
  const start = Date.parse(details?.actualStartTime || '');
  const end = Date.parse(details?.actualEndTime || '');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return Math.round((end - start) / 1000);
}

// null when the video is not a livestream. liveStatus is 'live' only while
// YouTube says the broadcast is on the air.
export function describeLiveVideo(item) {
  if (!item?.id || !isLivestreamVideo(item)) return null;
  const content = item.snippet?.liveBroadcastContent;
  const liveStatus = content === 'live' ? 'live' : content === 'upcoming' ? 'upcoming' : 'finished';
  return {
    videoId: item.id,
    title: item.snippet?.title || '',
    channelId: item.snippet?.channelId || '',
    publishedAt: item.snippet?.publishedAt || '',
    liveStatus,
    durationSeconds: parseIsoDuration(item.contentDetails?.duration) || clockDuration(item.liveStreamingDetails),
    actualStartTime: item.liveStreamingDetails?.actualStartTime || null,
    actualEndTime: item.liveStreamingDetails?.actualEndTime || null,
  };
}

export function isWithinLookback(iso, now, windowMs = LIVE_LOOKBACK_MS) {
  const time = Date.parse(iso || '');
  if (!Number.isFinite(time)) return false;
  const instant = now instanceof Date ? now.getTime() : Number(now);
  return time <= instant + 5 * 60 * 1000 && instant - time <= windowMs;
}

// A candidate is worth a videos.list check when its feed date is recent.
// Currently-live items are always worth it; the caller passes publishedAt
// from the feed before the API call, and describeLiveVideo afterwards.
export function feedEntryIsRecent(entry, now) {
  if (!entry?.videoId) return false;
  if (!entry.published) return false;
  return isWithinLookback(entry.published, now);
}

// 'keep' leaves the link alone. 'update' rewrites the same video id's
// status and length. 'replace' points the daf at a different id.
//
// An edited upload is never replaced. Two ids that are both on the air
// keep the one already linked (or the earlier one, if nothing is linked
// yet). Two finished recordings keep the longer one. A stream that is on
// the air now replaces a finished live recording, so a restart is what
// the player embeds.
export function chooseLiveRecording(existing, incoming) {
  if (!incoming?.videoId) return 'keep';
  if (!existing?.videoId) return 'replace';
  if (existing.videoId === incoming.videoId) return 'update';
  if (!existing.liveBroadcast) return 'keep';
  const existingFinished = existing.liveStatus === 'finished';
  const incomingFinished = incoming.liveStatus === 'finished';
  if (existingFinished && incomingFinished) {
    const next = Number(incoming.durationSeconds) || 0;
    const prev = Number(existing.durationSeconds) || 0;
    return next > prev ? 'replace' : 'keep';
  }
  if (incoming.liveStatus === 'live' && existingFinished) return 'replace';
  return 'keep';
}

export function recordingSnapshot(video) {
  return {
    videoId: video.videoId,
    liveBroadcast: true,
    liveStatus: video.liveStatus,
    durationSeconds: Number(video.durationSeconds) || null,
    title: video.title || video.label || '',
    actualStartTime: video.actualStartTime || null,
    actualEndTime: video.actualEndTime || null,
  };
}

// Consider candidates in the order they started, so the first of two
// simultaneous streams is the one that sticks.
export function selectRecording(existing, candidates) {
  if (existing?.videoId && !existing.liveBroadcast) {
    return { action: 'keep', video: null, reason: 'edited upload stays' };
  }
  const ordered = [...candidates].sort((a, b) => String(a.actualStartTime || a.publishedAt || '').localeCompare(String(b.actualStartTime || b.publishedAt || '')));
  let current = existing?.liveBroadcast ? recordingSnapshot({ ...existing, title: existing.label }) : null;
  let action = 'keep';
  for (const incoming of ordered) {
    if (incoming.liveStatus === 'upcoming') continue;
    const decision = chooseLiveRecording(current, incoming);
    if (decision === 'keep') continue;
    current = recordingSnapshot(incoming);
    action = existing?.videoId === incoming.videoId ? 'update' : 'replace';
  }
  if (!current) return { action: 'keep', video: null, reason: 'nothing to link' };
  if (!existing?.videoId) return { action: 'replace', video: current, reason: 'first live recording' };
  if (existing.videoId === current.videoId) {
    const changed = existing.liveStatus !== current.liveStatus || Number(existing.durationSeconds) !== Number(current.durationSeconds);
    return { action: changed ? 'update' : 'keep', video: current, reason: changed ? 'status changed' : 'already current' };
  }
  if (action === 'keep') return { action: 'keep', video: null, reason: 'kept the existing live recording' };
  return { action, video: current, reason: action };
}

// While the broadcast is on the air, the daf is shown and nothing is
// highlighted. After it ends, highlight only an alignment measured on
// this exact video (phase 2). Another recording's timestamps are not used.
export function shouldHighlightWords(source, alignment) {
  if (!source?.liveBroadcast) return true;
  if (source.liveStatus === 'live' || source.liveStatus === 'upcoming') return false;
  return Boolean(
    alignment?.videoId
    && alignment.videoId === source.videoId
    && Array.isArray(alignment.segments)
    && alignment.segments.length
  );
}

// Two YouTube length readings this close count as the same processed file.
export const LENGTH_MATCH_SECONDS = 2;
// The second reading has to be at least this long after the first.
export const LENGTH_STABLE_MS = 10 * 60 * 1000;
// A dispatch that never wrote an outcome can be tried once more after this.
export const DISPATCH_RETRY_MS = 6 * 60 * 60 * 1000;

export function advanceLengthCheck(previous, seconds, now) {
  const instant = now instanceof Date ? now : new Date(now);
  const at = instant.toISOString();
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) {
    return { lengthCheck: previous || null, stable: false };
  }
  const same = previous
    && Number.isFinite(Number(previous.seconds))
    && Math.abs(Number(previous.seconds) - value) <= LENGTH_MATCH_SECONDS
    && previous.firstSeenAt;
  if (!same) return { lengthCheck: { seconds: value, firstSeenAt: at }, stable: false };
  const elapsed = instant.getTime() - Date.parse(previous.firstSeenAt);
  return {
    lengthCheck: { seconds: Number(previous.seconds), firstSeenAt: previous.firstSeenAt },
    stable: Number.isFinite(elapsed) && elapsed >= LENGTH_STABLE_MS,
  };
}

// input fields, all required for a yes: autoSync, liveStatus 'finished',
// actualEndTime, lengthStable, isKept. alreadyAligned, outcome, or a fresh
// dispatchedAt are nos. A bare live video (phase 1 shape) is a no.
export function shouldDispatchLiveAlignment(input) {
  if (!input || typeof input !== 'object') return false;
  if (input.autoSync !== true) return false;
  if (input.liveStatus !== 'finished') return false;
  if (!input.actualEndTime) return false;
  if (input.lengthStable !== true) return false;
  if (input.isKept !== true) return false;
  if (input.alreadyAligned || input.outcome) return false;
  if (input.dispatchedAt) {
    const age = Date.now() - Date.parse(input.dispatchedAt);
    if (!Number.isFinite(age) || age < DISPATCH_RETRY_MS) return false;
  }
  return true;
}

export function parseAtomVideoIds(xml) {
  const ids = new Set();
  const text = String(xml || '');
  const tagged = /<yt:videoId>([^<]+)<\/yt:videoId>/g;
  let match;
  while ((match = tagged.exec(text))) ids.add(match[1].trim());
  const watch = /(?:[?&]v=|youtu\.be\/)([A-Za-z0-9_-]{11})/g;
  while ((match = watch.exec(text))) ids.add(match[1]);
  return [...ids];
}

export function hubFieldsFromUrl(url) {
  const params = new URL(url, 'https://dafsync.netlify.app').searchParams;
  return {
    mode: params.get('hub.mode') || '',
    topic: params.get('hub.topic') || '',
    challenge: params.get('hub.challenge') || '',
    leaseSeconds: params.get('hub.lease_seconds') || '',
    verifyToken: params.get('hub.verify_token') || '',
  };
}

export function webSubVerification(fields, { verifyToken = '' } = {}) {
  const mode = fields?.mode || '';
  if (mode !== 'subscribe' && mode !== 'unsubscribe') return { ok: false, status: 404, body: '' };
  if (fields.topic && fields.topic !== WEBSUB_TOPIC) return { ok: false, status: 404, body: '' };
  if (verifyToken && fields.verifyToken !== verifyToken) return { ok: false, status: 404, body: '' };
  if (!fields.challenge) return { ok: false, status: 400, body: '' };
  return { ok: true, status: 200, body: fields.challenge };
}

// The hub lease is a few days. Renew at three quiet hours so a missed
// day still leaves another try, and so a 5-minute poll only does it once
// in each window (minute 0).
export function leaseRenewalDue(now) {
  const hour = now.getUTCHours();
  const minute = now.getUTCMinutes();
  return minute < 5 && (hour === 4 || hour === 12 || hour === 20);
}

export function liveTabFeed() {
  return liveTabFeedUrl(MDY_CHANNEL_ID);
}

export function parseFeedEntries(xml) {
  const entries = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;
  const text = String(xml || '');
  while ((match = entryRegex.exec(text))) {
    const block = match[1];
    const videoId = /<yt:videoId>([^<]+)<\/yt:videoId>/.exec(block)?.[1];
    const title = /<title>([^<]*)<\/title>/.exec(block)?.[1];
    const published = /<published>([^<]*)<\/published>/.exec(block)?.[1];
    if (videoId) entries.push({ videoId, title: title || '', published: published || '' });
  }
  return entries;
}
