// Mercaz Daf Yomi posts the finished shiur on the channel's Videos tab and the
// unedited livestream (and the replay, once the stream ends) on the Live tab.
// YouTube derives those two tabs from the channel id, and both are ordinary
// playlists the same public RSS feed already used for "newest uploads" can
// read:
//   Videos tab (final cuts):  UULF + channelId without the leading "UC"
//   Live tab (streams / past broadcasts): UULV + the same suffix
//
// A video can also be classified from a YouTube Data API videos.list item
// (part=snippet,liveStreamingDetails). snippet.liveBroadcastContent is
// "live" or "upcoming" while the broadcast is scheduled or on air, then
// falls back to "none" once it ends -- but liveStreamingDetails stays,
// which is what distinguishes a past broadcast from a normal upload.

export const MDY_CHANNEL_ID = 'UCKwQa5DB_VR98ac_r-Wyl-g'; // @MercazDafYomi

export function channelTabPlaylistId(channelId, tab) {
  const id = String(channelId || '');
  if (!id.startsWith('UC') || id.length < 3) return null;
  const prefix = tab === 'live' ? 'UULV' : 'UULF';
  return prefix + id.slice(2);
}

export function playlistFeedUrl(playlistId) {
  return `https://www.youtube.com/feeds/videos.xml?playlist_id=${encodeURIComponent(playlistId)}`;
}

export function channelFeedUrl(channelId) {
  return `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
}

export function videosTabFeedUrl(channelId) {
  const playlistId = channelTabPlaylistId(channelId, 'videos');
  return playlistId ? playlistFeedUrl(playlistId) : channelFeedUrl(channelId);
}

export function liveTabFeedUrl(channelId) {
  const playlistId = channelTabPlaylistId(channelId, 'live');
  return playlistId ? playlistFeedUrl(playlistId) : null;
}

// Mercaz Daf Yomi's "recent uploads" are the Videos tab. The channel-wide
// uploads feed also carries the Live tab, which is how an unedited stream
// was getting linked. Every other channel keeps the uploads feed.
export function recentUploadFeedUrl(channelId) {
  if (channelId === MDY_CHANNEL_ID) return videosTabFeedUrl(channelId);
  return channelFeedUrl(channelId);
}

// True for an in-progress stream, an upcoming one, and a finished broadcast
// (the Live tab's past broadcasts). A normal upload is false.
export function isLivestreamVideo(video) {
  if (!video || typeof video !== 'object') return false;
  const content = video.snippet?.liveBroadcastContent ?? video.liveBroadcastContent;
  if (content === 'live' || content === 'upcoming') return true;
  const details = video.liveStreamingDetails;
  if (!details || typeof details !== 'object') return false;
  return Boolean(details.actualStartTime || details.actualEndTime || details.scheduledStartTime);
}

// videos.list response -> Set of video ids that are livestreams.
export function livestreamIdsFromVideosList(apiResponse) {
  const items = Array.isArray(apiResponse?.items) ? apiResponse.items : [];
  const ids = new Set();
  for (const item of items) {
    if (item?.id && isLivestreamVideo(item)) ids.add(item.id);
  }
  return ids;
}

export function parseFeedVideoIds(xml) {
  const ids = new Set();
  const re = /<yt:videoId>([^<]+)<\/yt:videoId>/g;
  let match;
  const text = String(xml || '');
  while ((match = re.exec(text))) ids.add(match[1]);
  return ids;
}

// Which of `videoIds` are livestreams. Uses the Data API when `apiKey` is
// set (authoritative for past broadcasts, including ones that also show up
// as uploads). Otherwise the channel's Live-tab RSS, which carries the same
// 15-item window as the uploads feed this site already polls.
export async function livestreamIdsAmong(videoIds, { fetchImpl = fetch, apiKey = '', channelId = '' } = {}) {
  const ids = [...new Set((videoIds || []).filter((id) => typeof id === 'string' && id))];
  if (!ids.length) return new Set();
  if (apiKey) {
    const found = new Set();
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,liveStreamingDetails&id=${encodeURIComponent(chunk.join(','))}&key=${encodeURIComponent(apiKey)}`;
      const response = await fetchImpl(url);
      if (!response.ok) throw new Error(`YouTube Data API returned ${response.status}`);
      for (const id of livestreamIdsFromVideosList(await response.json())) found.add(id);
    }
    return found;
  }
  const feedUrl = liveTabFeedUrl(channelId);
  if (!feedUrl) return new Set();
  const response = await fetchImpl(feedUrl);
  if (!response.ok) throw new Error(`YouTube live feed returned ${response.status}`);
  const live = parseFeedVideoIds(await response.text());
  return new Set(ids.filter((id) => live.has(id)));
}
