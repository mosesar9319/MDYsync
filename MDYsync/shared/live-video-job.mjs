// What the two Live Follow video-transcript functions share
// (live-video-job-background.mjs does the transcribing, live-video-status.mjs
// reports on it): which links are acceptable, what a job is keyed by, how the
// ElevenLabs request is built and how its answer is boiled down.
//
// ElevenLabs fetches the video itself (its batch API takes a link:
// `source_url` for YouTube and other video sites, `cloud_storage_url` for a
// plain file), so this server never downloads or handles the audio.

import { createHash } from 'node:crypto';
import { getStore } from '@netlify/blobs';

export const ALLOWED_ORIGINS = new Set([
  'https://dafsync.netlify.app',
  'https://main--dafsync.netlify.app',
  'http://localhost:8080',
]);
export const DEPLOY_PREVIEW_ORIGIN = /^https:\/\/deploy-preview-\d+--dafsync\.netlify\.app$/;
export const isAllowedOrigin = (origin) => ALLOWED_ORIGINS.has(origin) || DEPLOY_PREVIEW_ORIGIN.test(origin);

// A job that has been "pending" longer than the background function can run
// (15 minutes) died; start over rather than wait on it.
export const PENDING_STALE_MS = 16 * 60 * 1000;
export const MAX_KEYTERMS = 400;

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be']);
const MEDIA_EXTENSIONS = /\.(mp4|m4v|webm|mov|mp3|m4a|aac|wav|ogg|oga|opus|flac)$/i;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

// A host ElevenLabs could be pointed at that is not the public internet:
// IP literals, localhost, single-label and internal names.
function isPublicHostname(host) {
  if (!host || !host.includes('.')) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':') || host.startsWith('[')) return false;
  if (/(^|\.)(localhost|local|internal|lan|home|corp|intranet)$/.test(host)) return false;
  return true;
}

// -> { kind: 'youtube' | 'media', url } or null. YouTube is reduced to its
// canonical watch URL; a media file must be https and a recognised extension.
export function acceptVideoUrl(input) {
  let url;
  try { url = new URL(String(input ?? '').trim()); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (!isPublicHostname(host)) return null;
  if (YOUTUBE_HOSTS.has(host)) {
    let id = host.endsWith('youtu.be') ? url.pathname.split('/')[1] : url.searchParams.get('v');
    if (!id) {
      const m = /^\/(?:embed|shorts|live|v)\/([^/?#]+)/.exec(url.pathname);
      id = m ? m[1] : null;
    }
    return id && VIDEO_ID.test(id) ? { kind: 'youtube', url: `https://www.youtube.com/watch?v=${id}` } : null;
  }
  if (MEDIA_EXTENSIONS.test(url.pathname)) return { kind: 'media', url: url.toString() };
  return null;
}

// ElevenLabs' limits: under 50 characters and at most 5 words a term.
export function sanitizeKeyterms(keyterms) {
  if (!Array.isArray(keyterms)) return [];
  const seen = new Set();
  const out = [];
  for (const term of keyterms) {
    if (typeof term !== 'string') continue;
    const clean = term.trim();
    if (!clean || clean.length >= 50 || clean.split(/\s+/).length > 5 || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= MAX_KEYTERMS) break;
  }
  return out;
}

// One job per (video, daf, whether a bias list is used, language): the same
// video opened again, on any device, is answered from what was already paid for.
export function jobKey({ url, daf, withKeyterms, language }) {
  return createHash('sha256')
    .update([url, daf || '', withKeyterms ? 'kt' : '', language || ''].join('\n'))
    .digest('hex')
    .slice(0, 40);
}

// The multipart fields for ElevenLabs' batch endpoint.
export function buildTranscribeFields({ kind, url, keyterms, language }) {
  const fields = [
    ['model_id', 'scribe_v2'],
    [kind === 'youtube' ? 'source_url' : 'cloud_storage_url', url],
    ['timestamps_granularity', 'word'],
    ['tag_audio_events', 'false'],
  ];
  if (language === 'he') fields.push(['language_code', 'he']);
  for (const term of keyterms) fields.push(['keyterms', term]);
  return fields;
}

// ElevenLabs' words (with "spacing" and audio-event entries between them) ->
// [[text, start, end], ...] in seconds.
export function compactWords(result) {
  const words = Array.isArray(result?.words) ? result.words : [];
  return words
    .filter((w) => w && w.type === 'word' && typeof w.text === 'string' && w.text.trim() && Number.isFinite(w.start))
    .map((w) => [w.text.trim(), +w.start.toFixed(2), +(Number.isFinite(w.end) ? w.end : w.start).toFixed(2)]);
}

let storeOverride = null;
export const setStoreForTests = (store) => { storeOverride = store; };
// Strong consistency: the page polls this right after the job writes it.
export const jobStore = () => storeOverride || getStore({ name: 'live-video', consistency: 'strong' });
