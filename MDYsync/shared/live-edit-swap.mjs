// Phase 3: the edited upload replaces the live recording only after its
// own alignment exists, and a lead-in never becomes the previous daf's link.
//
// The hourly Videos-tab sync sees the edit. The live poll sees the live id.
// Both use these decisions so the player keeps the live video (and its
// by-video alignment) until results/by-video/<edited id>.json is there,
// then the link and the catalog move together.

import { maggidKeyPrefix } from './maggidim.mjs';

export const EDIT_DISPATCH_RETRY_MS = 6 * 60 * 60 * 1000;

// Video-link files are only for the daf the title names. The previous
// amud is still sent to the caption job (so the opening can be matched)
// but it must not get this video's link. That was how a later shiur's
// lead-in became the previous daf's recording.
export function linkReadingsOnly(parsed, readings) {
  if (!parsed) return [];
  // Readings are already this maggid's. Comparing maggid ids here would
  // drop them: the title parser does not set maggid, and the default
  // maggid's readings do not either.
  return (readings || []).filter((reading) => reading
    && reading.daf === parsed.daf
    && (reading.variant || 'regular') === (parsed.variant || 'regular')
    && (reading.language || 'en') === (parsed.language || 'en'));
}

export function byVideoAlignmentPath(videoId, { language, variant, maggid } = {}) {
  const prefix = maggidKeyPrefix(maggid)
    + (language === 'he' ? 'Hebrew-' : '')
    + (variant === 'chazarah' ? 'Chazarah-Daf-' : '');
  return `by-video/${prefix}${videoId}.json`;
}

// A videos.list item the public player cannot open.
export function videoIsPrivate(item) {
  return item?.status?.privacyStatus === 'private';
}

// Ids we asked for that YouTube did not return, plus any it marked private.
export function unavailableVideoIds(requestedIds, items) {
  const list = Array.isArray(items) ? items : [];
  const returned = new Set(list.map((item) => item?.id).filter(Boolean));
  const missing = (requestedIds || []).filter((id) => id && !returned.has(id));
  const privated = list.filter(videoIsPrivate).map((item) => item.id);
  return [...new Set([...missing, ...privated])];
}

// What to do with a finished (non-live) upload for this daf.
// 'create'  — nothing linked yet
// 'same'    — the link is already this video
// 'hold'    — the link is still the live recording; remember the edit and
//             align it, but do not point the player at it yet
// 'swap'    — the edit's by-video alignment exists; change the link now
// 'replace' — the link is some other finished upload
// 'keep'    — locked
export function decideUpload({ existing, videoId, aligned, now = new Date() }) {
  if (existing?.locked) return { action: 'keep', dispatch: false };
  if (!existing?.videoId) return { action: 'create', dispatch: true };
  if (existing.videoId === videoId && !existing.liveBroadcast) return { action: 'same', dispatch: false };
  if (existing.liveBroadcast || existing.liveUnavailable) {
    if (aligned) return { action: 'swap', dispatch: false };
    const pending = existing.pendingEdit;
    const sameEdit = pending?.videoId === videoId;
    const dispatchedAt = Date.parse(pending?.dispatchedAt || '');
    const age = Number.isFinite(dispatchedAt) ? now.getTime() - dispatchedAt : Infinity;
    const dispatch = !sameEdit || age >= EDIT_DISPATCH_RETRY_MS;
    return { action: 'hold', dispatch };
  }
  return { action: 'replace', dispatch: true };
}

export function pendingEditRecord(videoId, label, coveredRefs, now = new Date()) {
  return {
    videoId,
    label: String(label || '').slice(0, 100),
    coveredRefs: coveredRefs || [],
    dispatchedAt: now.toISOString(),
  };
}

// The link the player should follow once the edit's alignment is in.
// No liveBroadcast flag, so a later live id cannot take the daf back.
export function editedLinkFrom(liveLink, edit) {
  const videoId = edit?.videoId || liveLink?.pendingEdit?.videoId;
  return {
    type: 'youtube',
    url: `https://www.youtube.com/watch?v=${videoId}`,
    videoId,
    label: String(edit?.label || liveLink?.pendingEdit?.label || liveLink?.label || '').slice(0, 100),
    coveredRefs: edit?.coveredRefs || liveLink?.pendingEdit?.coveredRefs || liveLink?.coveredRefs || [],
    source: 'channel-auto',
    locked: false,
  };
}
