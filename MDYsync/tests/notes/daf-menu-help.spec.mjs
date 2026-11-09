import { test, expect } from '@playwright/test';
import { preparePage } from '../support/harness.mjs';

// The daf's right-click / long-press menu (daf-context-menu.js): it opens in
// fullscreen too, and three small aids help a reader find it -- a ring that
// grows under a held finger, a one-time hint when a daf first opens, and a
// one-time tip after three word taps.

function pageMapFixture() {
  const boxes = [];
  for (let i = 0; i < 5; i += 1) {
    boxes.push({ ref: 'Chullin 89a.1', wordIndex: i, x: 0.8 - i * 0.15, y: 0.10, w: 0.1, h: 0.12 });
  }
  return { wordBoxes: boxes };
}

async function openDaf(page, options = {}) {
  await preparePage(page, { user: null, ...options });
  await page.goto('/browse/');
  await page.evaluate((map) => {
    // The test page has no scan image; give the page a fixed size to hit.
    const style = document.createElement('style');
    style.textContent = '#vilnaPageWrap { height: 900px !important; }';
    document.head.append(style);
    // Pinned: the test page's own daf load would otherwise clear it.
    Object.defineProperty(state, 'vilnaPageMap', { configurable: true, get: () => map, set: () => {} });
    state.textSelection = null;
    state.vilnaSelectTextMode = false;
    switchDafView('page');
  }, pageMapFixture());
}

// Screen position of fixture word `index`.
const wordPoint = (page, index) => page.evaluate((i) => {
  const r = document.getElementById('vilnaPageWrap').getBoundingClientRect();
  const box = state.vilnaPageMap.wordBoxes[i];
  return { x: r.left + (box.x + box.w / 2) * r.width, y: r.top + (box.y + box.h / 2) * r.height };
}, index);

test('a right-click in fullscreen opens the menu where it can be seen', async ({ page }) => {
  await openDaf(page);
  await page.evaluate(() => document.getElementById('dafCard').requestFullscreen());
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('dafCard');
  const point = await wordPoint(page, 2);
  await page.evaluate(({ x, y }) => {
    document.getElementById('vilnaPageWrap').dispatchEvent(new MouseEvent('contextmenu', { clientX: x, clientY: y, bubbles: true, cancelable: true }));
  }, point);
  await expect(page.locator('.daf-context-menu')).toBeVisible();
  expect(await page.evaluate(() => document.fullscreenElement.contains(document.querySelector('.daf-context-menu')))).toBe(true);
});

test('a held finger grows a ring under the word until the menu opens', async ({ page }) => {
  test.skip(test.info().project.name !== 'mobile', 'touch');
  await openDaf(page);
  const point = await wordPoint(page, 1);
  await page.evaluate(({ x, y }) => {
    const wrap = document.getElementById('vilnaPageWrap');
    const touch = new Touch({ identifier: 1, target: wrap, clientX: x, clientY: y });
    wrap.dispatchEvent(new TouchEvent('touchstart', { touches: [touch], targetTouches: [touch], changedTouches: [touch], bubbles: true }));
  }, point);
  await page.waitForTimeout(250);
  await expect(page.locator('.daf-press-ring')).toHaveCount(1);
  await page.waitForTimeout(450);
  await expect(page.locator('.daf-press-ring')).toHaveCount(0);
  await expect(page.locator('.daf-context-menu')).toBeVisible();
});

test('a quick tap shows no ring', async ({ page }) => {
  test.skip(test.info().project.name !== 'mobile', 'touch');
  await openDaf(page);
  const point = await wordPoint(page, 1);
  await page.evaluate(async ({ x, y }) => {
    const wrap = document.getElementById('vilnaPageWrap');
    const touch = new Touch({ identifier: 1, target: wrap, clientX: x, clientY: y });
    wrap.dispatchEvent(new TouchEvent('touchstart', { touches: [touch], targetTouches: [touch], changedTouches: [touch], bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    wrap.dispatchEvent(new TouchEvent('touchend', { touches: [], targetTouches: [], changedTouches: [touch], bubbles: true }));
  }, point);
  await page.waitForTimeout(200);
  await expect(page.locator('.daf-press-ring')).toHaveCount(0);
  await expect(page.locator('.daf-context-menu')).toBeHidden();
});

test('a one-time hint says how to open the menu, and not again after that', async ({ page }) => {
  await openDaf(page, { menuHints: true });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('dafsync:vilna-page', { detail: { reason: 'map' } })));
  const hint = page.locator('.daf-menu-hint');
  await expect(hint).toBeVisible({ timeout: 4000 });
  const word = test.info().project.name === 'mobile' ? 'Hold' : 'Right-click';
  await expect(hint).toContainText(`${word} any word for more`);
  await page.getByRole('button', { name: 'Dismiss the tip' }).click();
  await expect(hint).toHaveCount(0);
  await page.reload();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('dafsync:vilna-page', { detail: { reason: 'map' } })));
  await page.waitForTimeout(2200);
  await expect(hint).toHaveCount(0);
});

test('the hint does not get in the way of the daf under it', async ({ page }) => {
  await openDaf(page, { menuHints: true });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('dafsync:vilna-page', { detail: { reason: 'map' } })));
  await expect(page.locator('.daf-menu-hint')).toBeVisible({ timeout: 4000 });
  await expect(page.locator('.daf-menu-hint')).toHaveCSS('pointer-events', 'none');
});

test('someone who has opened the menu never sees the hint', async ({ page }) => {
  await openDaf(page, { menuHints: true });
  const point = await wordPoint(page, 2);
  await page.evaluate(({ x, y }) => {
    document.getElementById('vilnaPageWrap').dispatchEvent(new MouseEvent('contextmenu', { clientX: x, clientY: y, bubbles: true, cancelable: true }));
  }, point);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('dafsync:vilna-page', { detail: { reason: 'map' } })));
  await page.waitForTimeout(2200);
  await expect(page.locator('.daf-menu-hint')).toHaveCount(0);
});

test('after three word taps a one-time tip mentions the menu', async ({ page }) => {
  await openDaf(page, { menuHints: true });
  await page.evaluate(() => { hapticTap(); hapticTap(); });
  await expect(page.locator('#toast')).not.toContainText('Tip:');
  await page.evaluate(() => hapticTap());
  await expect(page.locator('#toast')).toContainText('Tip:');
  await expect(page.locator('#toast')).toContainText('a word to look it up');
  expect(await page.evaluate(() => localStorage.getItem('dafsync.dafMenu.tipShown'))).toBe('1');
});
