// Scheduled job: finds every currently-linked video (video-links/*.json and
// the catalog.json summary built from it) whose YouTube video is no longer
// reachable -- deleted, made private, whatever -- and removes it.
//
// The channel routinely posts an "unedited cut" of a shiur first, then
// deletes it once the finished edit is up under a fresh upload;
// youtube-channel-sync.mjs's replace-on-newer-upload logic only fires when
// that finished edit's title actually matches the expected pattern for the
// same daf/variant/language. When it doesn't (or the channel just deletes
// something without ever posting a replacement this job's title parser
// recognizes), the old link is left pointing at a video that no longer
// exists -- a dead thumbnail and an unplayable card, indefinitely, since
// nothing else ever rechecks a link once it's been published. This is that
// recheck, running independently of the hourly new-upload poll.
//
// Named with the -background suffix (Netlify's convention for a longer
// timeout) since a full pass means one oembed request per unique video
// across the whole catalog, not just the last few uploads -- this is a
// once-a-day sweep, not the hourly one.

const OWNER = 'mosesar9319';
const REPO = 'MDYsync';
const RAW_BASE = `https://raw.githubusercontent.com/${OWNER}/${REPO}/results`;
const COMBO_KEYS = ['regularEn', 'chazarahEn', 'regularHe', 'chazarahHe'];

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) return null;
  return res.json();
}

// oembed is the same "does this still exist and is it embeddable" check
// trigger-ocr-job.mjs already relies on for the YouTube-sync authorization
// gate -- no API key needed, and a 200 is a reasonable proxy for "still a
// normal public video."
async function isVideoAlive(videoId) {
  const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`;
  try {
    const res = await fetch(url);
    return res.ok;
  } catch {
    return false;
  }
}

async function pool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, run));
  return results;
}

export default async () => {
  const token = Netlify.env.get('GITHUB_DISPATCH_TOKEN');
  if (!token) {
    return Response.json({ error: 'Server publish is not configured yet.' }, { status: 503 });
  }
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  };

  // One tree listing gives every video-links path + blob sha up front, so
  // deleting one later needs no extra GET (see the same pattern in
  // youtube-channel-sync.mjs).
  let videoLinkEntries;
  try {
    const treeResponse = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/git/trees/results?recursive=1`, { headers });
    if (!treeResponse.ok) throw new Error(`GitHub tree API returned ${treeResponse.status}`);
    const tree = await treeResponse.json();
    videoLinkEntries = (tree.tree || [])
      .filter((item) => item.type === 'blob' && item.path.startsWith('video-links/') && item.path.endsWith('.json'))
      .map((item) => ({ path: item.path, sha: item.sha }));
  } catch (error) {
    return Response.json({ error: `Could not list video links: ${error.message}` }, { status: 502 });
  }

  const videoLinkFiles = await pool(videoLinkEntries, 10, async (entry) => {
    const content = await fetchJson(`${RAW_BASE}/${entry.path}`);
    return { ...entry, videoId: content?.videoId || null };
  });

  const catalog = await fetchJson(`${RAW_BASE}/catalog.json`) || { tractates: {} };

  const allVideoIds = new Set();
  for (const f of videoLinkFiles) if (f.videoId) allVideoIds.add(f.videoId);
  for (const tractate of Object.keys(catalog.tractates || {})) {
    for (const row of catalog.tractates[tractate]) {
      for (const key of COMBO_KEYS) if (row[key]?.videoId) allVideoIds.add(row[key].videoId);
    }
  }
  if (!allVideoIds.size) return Response.json({ checked: 0, dead: [] });

  const ids = [...allVideoIds];
  const aliveMap = new Map();
  async function checkAll(idList) {
    return pool(idList, 8, async (id) => [id, await isVideoAlive(id)]);
  }
  for (const [id, alive] of await checkAll(ids)) aliveMap.set(id, alive);
  // A single oembed request failing is more likely a network blip than a
  // truly dead video -- give every apparent failure one more chance before
  // treating it as confirmed dead.
  const retryIds = ids.filter((id) => !aliveMap.get(id));
  if (retryIds.length) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    for (const [id, alive] of await checkAll(retryIds)) if (alive) aliveMap.set(id, true);
  }
  const deadIds = new Set(ids.filter((id) => !aliveMap.get(id)));

  if (!deadIds.size) return Response.json({ checked: ids.length, dead: [] });

  const deletedPaths = [];
  const filesToDelete = videoLinkFiles.filter((f) => f.videoId && deadIds.has(f.videoId));
  for (const file of filesToDelete) {
    try {
      const deleteResponse = await fetch(
        `https://api.github.com/repos/${OWNER}/${REPO}/contents/${file.path}`,
        {
          method: 'DELETE',
          headers,
          body: JSON.stringify({
            message: `Remove dead video link (video no longer reachable on YouTube): ${file.path}`,
            sha: file.sha,
            branch: 'results',
          }),
        }
      );
      if (deleteResponse.ok) deletedPaths.push(file.path);
    } catch {
      // Leave it for the next run to retry rather than failing the whole pass.
    }
  }

  let removedCombos = 0;
  let removedRows = 0;
  try {
    const catalogResponse = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/catalog.json?ref=results`, { headers });
    if (catalogResponse.ok) {
      const file = await catalogResponse.json();
      const sha = file.sha;
      const freshCatalog = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
      for (const tractate of Object.keys(freshCatalog.tractates || {})) {
        const rows = freshCatalog.tractates[tractate];
        for (const row of rows) {
          for (const key of COMBO_KEYS) {
            if (row[key]?.videoId && deadIds.has(row[key].videoId)) {
              delete row[key];
              removedCombos++;
            }
          }
        }
        const kept = rows.filter((row) => COMBO_KEYS.some((key) => row[key]));
        removedRows += rows.length - kept.length;
        freshCatalog.tractates[tractate] = kept;
      }
      if (removedCombos) {
        freshCatalog.generatedAt = new Date().toISOString();
        await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/catalog.json`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({
            message: `Remove ${removedCombos} dead video listing(s) from catalog.json`,
            content: Buffer.from(JSON.stringify(freshCatalog, null, 2) + '\n', 'utf8').toString('base64'),
            branch: 'results',
            sha,
          }),
        });
      }
    }
  } catch (error) {
    // catalog.json is a derived convenience file -- a failure here shouldn't
    // hide that the video-links files themselves were already cleaned up.
    console.error('Could not update catalog.json', error);
  }

  return Response.json({
    checked: ids.length,
    dead: [...deadIds],
    deletedVideoLinkFiles: deletedPaths,
    catalogCombosRemoved: removedCombos,
    catalogRowsRemoved: removedRows,
  });
};

export const config = {
  schedule: '0 6 * * *',
};
