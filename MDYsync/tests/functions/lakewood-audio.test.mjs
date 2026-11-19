// tools/lakewood-audio.mjs: R' Bornstein's mp3 for a sync job, from Lakewood Daf
// Yomi's own podcast feed instead of YouTube.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTalmudLookup } from '../../shared/mdy-channel.mjs';
import { durationSeconds, feedItems, itemForReadings } from '../../tools/lakewood-audio.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const lookup = buildTalmudLookup(JSON.parse(fs.readFileSync(path.join(HERE, '..', '..', 'talmud_index.json'), 'utf8')));

// The shape of the real feed (app.daf-yomi.net/podcasts/DafYomi.xml), trimmed.
const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel>
<title>Lakewood Daf Yomi</title>
<item><title>Eruchin 2</title><pubDate>Thu, 19 Nov 2026 04:47:41 GMT</pubDate>
  <enclosure url="https://lakewoodafyomi.appspot.com/m5/AAA/Arachin%202_213511665.mp3" type="audio/mpeg" length="1"/>
  <itunes:duration>0:58:07</itunes:duration></item>
<item><title>Bechoros 58</title><pubDate>Sat, 14 Nov 2026 23:34:45 GMT</pubDate>
  <enclosure url="https://lakewoodafyomi.appspot.com/m5/BBB/Bechoros%2058_213147286.mp3" type="audio/mpeg" length="1"/>
  <itunes:duration>1:03:34</itunes:duration></item>
<item><title><![CDATA[Bechoros 57]]></title><pubDate>Fri, 13 Nov 2026 12:56:10 GMT</pubDate>
  <enclosure url="https://lakewoodafyomi.appspot.com/m5/CCC/Bechoros%2057_213022570.mp3" type="audio/mpeg" length="1"/>
  <itunes:duration>56:07</itunes:duration></item>
<item><title>A shmuess for Chanukah</title>
  <enclosure url="https://lakewoodafyomi.appspot.com/m5/DDD/shmuess.mp3" type="audio/mpeg" length="1"/></item>
</channel></rss>`;

test('lengths in the feed are read in seconds', () => {
  assert.equal(durationSeconds('1:03:34'), 3814);
  assert.equal(durationSeconds('56:07'), 3367);
  assert.equal(durationSeconds('3814'), 3814);
  assert.equal(durationSeconds(''), null);
  assert.equal(durationSeconds('n/a'), null);
});

test('each item gives its title, mp3 and length', () => {
  const items = feedItems(FEED);
  assert.equal(items.length, 4);
  assert.deepEqual(items[1], {
    title: 'Bechoros 58',
    url: 'https://lakewoodafyomi.appspot.com/m5/BBB/Bechoros%2058_213147286.mp3',
    seconds: 3814,
    published: 'Sat, 14 Nov 2026 23:34:45 GMT',
  });
  assert.equal(items[2].title, 'Bechoros 57');
});

test("a job's readings find the daf most of them are on", () => {
  const items = feedItems(FEED);
  const item = itemForReadings(items, lookup, ['Bekhorot 57b', 'Bekhorot 58a', 'Bekhorot 58b', 'Bekhorot 59a']);
  assert.match(item.url, /Bechoros%2058_/);
  assert.equal(itemForReadings(items, lookup, ['Bekhorot 57a', 'Bekhorot 57b']).title, 'Bechoros 57');
});

test('the feed\'s spelling "Eruchin" is Arakhin', () => {
  const item = itemForReadings(feedItems(FEED), lookup, ['Arakhin 2a', 'Arakhin 2b']);
  assert.match(item.url, /Arachin%202_/);
});

test('a daf the feed does not have, or readings it cannot place, give nothing', () => {
  const items = feedItems(FEED);
  assert.equal(itemForReadings(items, lookup, ['Bekhorot 40a', 'Bekhorot 40b']), null);
  assert.equal(itemForReadings(items, lookup, ['Not a tractate 2a']), null);
  assert.equal(itemForReadings(items, lookup, []), null);
});
