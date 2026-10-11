import { test, expect } from '@playwright/test';
import { preparePage, stubPrintedPage } from '../support/harness.mjs';

// Interactive Daf: a daf with more than one shiur on the site (another rabbi's, a Hebrew or a
// Chazarah recording) loads none of them until the reader chooses; a daf with one still loads it.

const link = (videoId, label) => ({ type: 'youtube', videoId, url: `https://www.youtube.com/watch?v=${videoId}`, label });
const CATALOG = {
  tractates: {
    Bekhorot: [
      { daf: 2, regularEn: { videoId: 'AAAAAAAAAAA', label: 'Daf Yomi Bechoros Daf 2', amud: 'a' }, regularHe: { videoId: 'BBBBBBBBBBB', label: 'מרכז דף יומי בכורות', amud: 'a' } },
      { daf: 3, regularEn: { videoId: 'CCCCCCCCCCC', label: 'Daf Yomi Bechoros Daf 3', amud: 'a' } },
    ],
  },
  maggidim: { bornstein: { tractates: { Bekhorot: [{ daf: 2, regularEn: { videoId: 'Zsy7oDUP6Pw', label: 'Bechoros 2', amud: 'a', testShiur: true } }] } } },
};
const SYNCED = { Bekhorot: { '2a': ['regularEn', 'regularHe'], '3a': ['regularEn'] } };

async function open(page, url) {
  const asked = [];
  await preparePage(page);
  await stubPrintedPage(page);
  // No YouTube in the test browser: a stand-in player that is ready at once and does nothing.
  await page.addInitScript(() => {
    window.YT = {
      PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
      Player: function Player(_id, options) {
        const target = new Proxy({}, { get: (_t, name) => (name === 'then' ? undefined : () => 0) });
        setTimeout(() => options?.events?.onReady?.({ target }), 0);
        return target;
      },
    };
  });
  await page.route('**/api/get-catalog', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CATALOG) }));
  await page.route('**/api/list-synced-dapim', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SYNCED) }));
  await page.route('**/api/get-results-file?*', (route) => {
    const path = new URL(route.request().url()).searchParams.get('path');
    asked.push(path);
    if (path.startsWith('video-links/')) {
      const known = { 'video-links/Bekhorot-2a.json': link('AAAAAAAAAAA', 'Daf Yomi Bechoros Daf 2'), 'video-links/Hebrew-Bekhorot-2a.json': link('BBBBBBBBBBB', 'Hebrew'), 'video-links/Bornstein-Bekhorot-2a.json': link('Zsy7oDUP6Pw', 'Bechoros 2'), 'video-links/Bekhorot-3a.json': link('CCCCCCCCCCC', 'Daf 3') };
      if (path in known) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(known[path]) });
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not found."}' });
  });
  await page.goto(url);
  await expect.poll(() => page.evaluate(() => !!state.videoCatalog)).toBe(true);
  return asked;
}

const loadedVideo = (page) => page.evaluate(() => state.videoSource?.videoId || null);
const options = (page) => page.locator('#videoChoiceList .video-choice-option');

test.describe('Interactive Daf — a daf with several shiurim', () => {
  test('lists every shiur for the daf and loads none of them', async ({ page }) => {
    const asked = await open(page, '/browse/?ref=Bekhorot%202a');
    await expect(page.locator('#videoChoice')).toBeVisible();
    await expect(page.locator('#videoChoiceTitle')).toContainText('3 shiurim for Bekhorot 2');
    await expect(options(page)).toHaveCount(3);
    await expect(options(page).nth(0)).toContainText("R' Eli Stefansky");
    await expect(options(page).nth(0)).toContainText('English');
    await expect(options(page).nth(1)).toContainText('Hebrew');
    await expect(options(page).nth(2)).toContainText("R' Sruly Bornstein");
    await expect(options(page).nth(2)).toContainText('Bechoros 2');
    await page.waitForTimeout(600);
    expect(await loadedVideo(page)).toBeNull();
    expect(asked.filter((p) => p.startsWith('video-links/'))).toEqual([]);
  });

  test('choosing a shiur loads that one, and the list marks it', async ({ page }) => {
    const asked = await open(page, '/browse/?ref=Bekhorot%202a');
    await options(page).nth(2).click();
    await expect.poll(() => asked.includes('video-links/Bornstein-Bekhorot-2a.json')).toBe(true);
    expect(asked).not.toContain('video-links/Bekhorot-2a.json');
    await expect.poll(() => loadedVideo(page)).toBe('Zsy7oDUP6Pw');
    expect(await page.evaluate(() => state.maggid)).toBe('bornstein');
    await expect(options(page).nth(2)).toHaveAttribute('aria-pressed', 'true');
    await expect(options(page).nth(0)).toHaveAttribute('aria-pressed', 'false');
    await options(page).nth(1).click();
    await expect.poll(() => asked.includes('video-links/Hebrew-Bekhorot-2a.json')).toBe(true);
    await expect.poll(() => loadedVideo(page)).toBe('BBBBBBBBBBB');
    expect(await page.evaluate(() => state.maggid)).toBeNull();
  });

  test('a daf with one shiur loads it on its own and shows no list', async ({ page }) => {
    const asked = await open(page, '/browse/?ref=Bekhorot%203a');
    await expect(page.locator('#videoChoice')).toBeHidden();
    await expect.poll(() => asked.includes('video-links/Bekhorot-3a.json')).toBe(true);
    await expect.poll(() => loadedVideo(page)).toBe('CCCCCCCCCCC');
  });

  test('picking another daf in the picker brings the list back and unloads nothing new', async ({ page }) => {
    const asked = await open(page, '/browse/?ref=Bekhorot%203a');
    await expect.poll(() => loadedVideo(page)).toBe('CCCCCCCCCCC');
    asked.length = 0;
    await page.selectOption('#dafDafSelect', '2');
    await expect(options(page)).toHaveCount(3);
    await page.waitForTimeout(500);
    expect(asked.filter((p) => p.startsWith('video-links/'))).toEqual([]);
  });

  test('a link that names its shiur loads it straight away', async ({ page }) => {
    const asked = await open(page, '/browse/?ref=Bekhorot%202a&language=hebrew');
    await expect.poll(() => asked.includes('video-links/Hebrew-Bekhorot-2a.json')).toBe(true);
    await expect.poll(() => loadedVideo(page)).toBe('BBBBBBBBBBB');
  });

  test('?maggid=bornstein in the link loads that rabbi\'s shiur', async ({ page }) => {
    const asked = await open(page, '/browse/?ref=Bekhorot%202a&maggid=bornstein');
    await expect.poll(() => asked.includes('video-links/Bornstein-Bekhorot-2a.json')).toBe(true);
    await expect.poll(() => loadedVideo(page)).toBe('Zsy7oDUP6Pw');
  });
});
