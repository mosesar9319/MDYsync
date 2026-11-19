// netlify/functions/lakewood-audio.mjs: the player asks it for R' Bornstein's mp3
// of a daf, read from Lakewood Daf Yomi's own podcast feed.
import test from 'node:test';
import assert from 'node:assert/strict';
import handler, { clearFeedCache } from '../../netlify/functions/lakewood-audio.mjs';

const FEED = `<rss><channel>
<item><title>Eruchin 2</title><enclosure url="https://lakewoodafyomi.appspot.com/m5/A/Arachin%202_1.mp3"/><itunes:duration>0:58:07</itunes:duration></item>
<item><title>Bechoros 58</title><enclosure url="https://lakewoodafyomi.appspot.com/m5/B/Bechoros%2058_2.mp3"/><itunes:duration>1:03:34</itunes:duration></item>
<item><title>Chulin 100</title><enclosure url="https://lakewoodafyomi.appspot.com/m5/C/Chulin%20100_3.mp3"/><itunes:duration>50:00</itunes:duration></item>
</channel></rss>`;

function feedFetch(counter) {
  return async () => {
    counter.calls += 1;
    return new Response(FEED, { status: 200 });
  };
}

const ask = (query, fetchImpl) => handler(new Request(`https://dafsync.com/api/lakewood-audio?${query}`), {}, fetchImpl);

test('a daf in the feed: its mp3, length, title and picture', async () => {
  clearFeedCache();
  const response = await ask('tractate=Bekhorot&daf=58', feedFetch({ calls: 0 }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    url: 'https://lakewoodafyomi.appspot.com/m5/B/Bechoros%2058_2.mp3',
    seconds: 3814,
    title: 'Bechoros 58',
    artwork: 'https://app.daf-yomi.net/images/daf-podcast-2.jpeg',
  });
  assert.match(response.headers.get('cache-control'), /max-age=600/);
});

test('the feed\'s own spellings: "Chulin", "Eruchin"', async () => {
  clearFeedCache();
  const counter = { calls: 0 };
  assert.equal((await (await ask('tractate=Chullin&daf=100', feedFetch(counter))).json()).title, 'Chulin 100');
  assert.equal((await (await ask('tractate=Arakhin&daf=2', feedFetch(counter))).json()).title, 'Eruchin 2');
  assert.equal(counter.calls, 1, 'the feed is read once and kept');
});

test('a daf the feed does not have is 404', async () => {
  clearFeedCache();
  const response = await ask('tractate=Bekhorot&daf=40', feedFetch({ calls: 0 }));
  assert.equal(response.status, 404);
  assert.match((await response.json()).error, /no shiur on this daf/);
});

test('a bad question is 400, and a feed that will not load is 502', async () => {
  clearFeedCache();
  assert.equal((await ask('tractate=Nowhere&daf=2', feedFetch({ calls: 0 }))).status, 400);
  assert.equal((await ask('tractate=Bekhorot&daf=1', feedFetch({ calls: 0 }))).status, 400);
  const down = await ask('tractate=Bekhorot&daf=58', async () => new Response('', { status: 503 }));
  assert.equal(down.status, 502);
});
