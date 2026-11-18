import { test, expect } from '@playwright/test';
import { preparePage } from '../support/harness.mjs';

// The Interactive Daf page as a sefer (daf-book.js): the cover on a plain
// visit, turning the printed page by the arrows and by swiping, the dial, and
// the page-sound switch.
//
// A stand-in pdf.js draws each amud as a page of its own colour (the PDF the
// test serves is just the amud's name), so a test can see which amud a canvas
// or a picture shows.

const FAKE_PDFJS = `
export const GlobalWorkerOptions = {};
const COLORS = { a: [200, 60, 60], b: [60, 90, 200] };
export function getDocument({ data }) {
  const name = new TextDecoder().decode(new Uint8Array(data)); // "Chullin 86 a"
  const amud = name.trim().split(' ').pop();
  const daf = Number(name.trim().split(' ').slice(-2)[0]);
  return { promise: Promise.resolve({
    destroy() {},
    getPage: async () => ({
      getViewport: ({ scale }) => ({ width: 600 * scale, height: 900 * scale, scale }),
      render: ({ canvasContext, viewport }) => {
        const [r, g, b] = COLORS[amud] || [0, 0, 0];
        canvasContext.fillStyle = 'rgb(' + r + ',' + (g + (daf % 10) * 10) + ',' + b + ')';
        canvasContext.fillRect(0, 0, viewport.width, viewport.height);
        return { promise: Promise.resolve() };
      },
    }),
  }) };
}`;

async function open(page, url = '/browse/?ref=Chullin%2086a', { reducedMotion = false } = {}) {
  await preparePage(page, { bookCover: true });
  if (reducedMotion) await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/daf-page?*', (route) => {
    const params = new URL(route.request().url()).searchParams;
    route.fulfill({ status: 200, contentType: 'application/pdf', body: `${params.get('tractate')} ${params.get('daf')} ${params.get('amud')}` });
  });
  await page.route(/^https:\/\/cdn\.jsdelivr\.net\/npm\/pdfjs-dist@[^/]+\/build\/pdf\.min\.mjs$/, (route) => route.fulfill({
    status: 200, contentType: 'text/javascript', body: FAKE_PDFJS,
  }));
  await page.goto(url);
  await expect(page.locator('#dafBookDial')).toBeVisible();
}

const pageKey = (page) => page.evaluate(() => state.vilnaPageKey);
const readyOn = (page, key) => expect.poll(() => pageKey(page), { timeout: 10000 }).toBe(key);
// The colour in the middle of the real page canvas: red for amud a, blue for b.
const canvasAmud = (page) => page.evaluate(() => {
  const canvas = document.getElementById('vilnaPageCanvas');
  const [r, , b] = canvas.getContext('2d').getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data;
  return r > b ? 'a' : 'b';
});
// The pictures either side are drawn ahead of time.
const picturesReady = (page) => expect.poll(() => page.evaluate(() => document.querySelectorAll('.daf-book-stage').length === 0
  && window.dafBook && true), { timeout: 5000 }).toBe(true);

// The top of the printed page, on screen.
async function pageInView(page) {
  await page.evaluate(() => document.getElementById('dafScroll').scrollIntoView({ block: 'start', behavior: 'instant' }));
  const box = await page.locator('#vilnaPageCanvas').boundingBox();
  const height = page.viewportSize().height;
  return { ...box, midY: Math.min(box.y + 160, height - 80) };
}

async function touchSwipe(page, dx, dy = 0, steps = 10) {
  const cdp = await page.context().newCDPSession(page);
  const box = await pageInView(page);
  const x0 = box.x + box.width * (dx > 0 ? 0.2 : 0.8);
  const y0 = box.midY;
  const point = (i) => ({ x: x0 + (dx * i) / steps, y: y0 + (dy * i) / steps });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(0)] });
  for (let i = 1; i <= steps; i += 1) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(i)] });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

test.describe('Interactive Daf as a sefer', () => {
  test('a plain visit opens on the masechta’s cover; tapping it opens the daf', async ({ page }) => {
    await open(page, '/browse/');
    const cover = page.locator('.daf-book-cover');
    await expect(cover).toBeVisible();
    await expect(cover.locator('.dbc-masechta')).toHaveText('חולין');
    await expect(cover).toHaveAttribute('aria-label', /Chullin/);
    await cover.click();
    await expect(cover).toHaveCount(0, { timeout: 3000 });
    await expect(page.locator('#vilnaPlaceholder')).not.toHaveClass(/daf-book-closed/);
  });

  test('the next-amud arrow on a closed book opens it', async ({ page }) => {
    await open(page, '/browse/');
    await expect(page.locator('.daf-book-cover')).toBeVisible();
    await page.locator('#dafNextAmudButton').click();
    await expect(page.locator('.daf-book-cover')).toHaveCount(0);
  });

  test('a link to a daf goes straight to the page, with no cover', async ({ page }) => {
    await open(page);
    await readyOn(page, 'Chullin|86|a');
    await expect(page.locator('.daf-book-cover')).toHaveCount(0);
  });

  test('the next-amud arrow turns the page: a leaf lifts away and the page lands on 86b', async ({ page }) => {
    await open(page);
    await readyOn(page, 'Chullin|86|a');
    expect(await canvasAmud(page)).toBe('a');
    await page.locator('#dafNextAmudButton').click();
    await expect(page.locator('.daf-book-stage .dbs-leaf')).toHaveCount(1);
    expect(await page.evaluate(() => state.browsePageRef)).toBe('Chullin 86b');
    await readyOn(page, 'Chullin|86|b');
    await expect(page.locator('.daf-book-stage')).toHaveCount(0, { timeout: 3000 });
    expect(await canvasAmud(page)).toBe('b');
    // And back.
    await page.locator('#dafPrevAmudButton').click();
    await readyOn(page, 'Chullin|86|a');
    await expect(page.locator('.daf-book-stage')).toHaveCount(0, { timeout: 3000 });
  });

  test('the amud underneath is drawn ahead of time', async ({ page }) => {
    await open(page);
    await readyOn(page, 'Chullin|86|a');
    await picturesReady(page);
    await page.waitForTimeout(900);
    await page.locator('#dafNextAmudButton').click();
    const under = page.locator('.daf-book-stage .dbs-under img');
    await expect(under).toHaveCount(1);
    const color = await under.evaluate(async (img) => {
      await img.decode().catch(() => {});
      const c = document.createElement('canvas');
      c.width = 4; c.height = 4;
      c.getContext('2d').drawImage(img, 0, 0, 4, 4);
      const [r, , b] = c.getContext('2d').getImageData(2, 2, 1, 1).data;
      return r > b ? 'a' : 'b';
    });
    expect(color).toBe('b');
  });

  test('a swipe to the right turns to the next amud; up and down only scrolls', async ({ page }) => {
    test.skip(test.info().project.name !== 'mobile', 'touch');
    await open(page);
    await readyOn(page, 'Chullin|86|a');
    await touchSwipe(page, 0, -160);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => state.browsePageRef)).toBe('Chullin 86a');
    await expect(page.locator('.daf-book-stage')).toHaveCount(0);
    await touchSwipe(page, 220);
    await readyOn(page, 'Chullin|86|b');
    await expect(page.locator('.daf-book-stage')).toHaveCount(0, { timeout: 3000 });
    // A swipe to the left goes back.
    await touchSwipe(page, -220);
    await readyOn(page, 'Chullin|86|a');
  });

  test('a short sideways drag springs back without turning', async ({ page }) => {
    test.skip(test.info().project.name !== 'mobile', 'touch');
    await open(page);
    await readyOn(page, 'Chullin|86|a');
    await touchSwipe(page, 40, 0, 10);
    await page.waitForTimeout(800);
    expect(await page.evaluate(() => state.browsePageRef)).toBe('Chullin 86a');
    await expect(page.locator('.daf-book-stage')).toHaveCount(0);
  });

  test('with Select text on, a sideways drag does not turn the page', async ({ page }) => {
    test.skip(test.info().project.name !== 'mobile', 'touch');
    await open(page);
    await readyOn(page, 'Chullin|86|a');
    await page.evaluate(() => { state.vilnaSelectTextMode = true; });
    await touchSwipe(page, 220);
    await page.waitForTimeout(600);
    expect(await page.evaluate(() => state.browsePageRef)).toBe('Chullin 86a');
  });

  test('a mouse drag turns the page and is not taken as a click on a word', async ({ page }) => {
    test.skip(test.info().project.name !== 'desktop', 'mouse');
    await open(page);
    await readyOn(page, 'Chullin|86|a');
    const clicks = [];
    await page.exposeFunction('noteClick', () => clicks.push(1));
    await page.evaluate(() => document.getElementById('vilnaPageWrap').addEventListener('click', () => window.noteClick()));
    const box = await pageInView(page);
    const y = box.midY;
    await page.mouse.move(box.x + 60, y);
    await page.mouse.down();
    for (let i = 1; i <= 10; i += 1) await page.mouse.move(box.x + 60 + i * 30, y);
    await page.mouse.up();
    await readyOn(page, 'Chullin|86|b');
    expect(clicks.length).toBe(0);
  });

  test('the dial shows the masechta’s dapim and goes to the daf it is turned to', async ({ page }) => {
    await open(page);
    await readyOn(page, 'Chullin|86|a');
    const drum = page.locator('#dafBookDrum');
    await expect(drum).toHaveAttribute('aria-valuenow', '86');
    await expect(drum).toHaveAttribute('aria-valuemin', '2');
    await expect(drum).toHaveAttribute('aria-valuemax', '142');
    await expect(page.locator('.dbd-tick.is-current .dbd-he')).toHaveText('פו');
    // Left is a higher daf, as in a Hebrew book.
    await drum.focus();
    for (let i = 0; i < 3; i += 1) await page.keyboard.press('ArrowLeft');
    await expect(drum).toHaveAttribute('aria-valuenow', '89');
    await readyOn(page, 'Chullin|89|a');
    expect(await page.evaluate(() => state.browsePageRef)).toBe('Chullin 89a');
    await expect(page.locator('.daf-book-stage')).toHaveCount(0, { timeout: 4000 });
    // Turning a page keeps the dial in step.
    await page.locator('#dafPrevAmudButton').click();
    await readyOn(page, 'Chullin|88|b');
    await expect(drum).toHaveAttribute('aria-valuenow', '88');
  });

  test('a drag on the dial spins it and lands on a daf', async ({ page }) => {
    await open(page);
    await readyOn(page, 'Chullin|86|a');
    await page.evaluate(() => document.getElementById('dafBookDrum').scrollIntoView({ block: 'center', behavior: 'instant' }));
    const box = await page.locator('#dafBookDrum').boundingBox();
    const y = box.y + box.height / 2;
    const x = (i) => box.x + box.width / 2 - i * 8;
    if (test.info().project.name === 'mobile') {
      // A finger on the drum.
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x(0), y }] });
      for (let i = 1; i <= 12; i += 1) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x(i), y }] });
        await page.waitForTimeout(40);
      }
      await page.waitForTimeout(150);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await page.mouse.move(x(0), y);
      await page.mouse.down();
      for (let i = 1; i <= 12; i += 1) { await page.mouse.move(x(i), y); await page.waitForTimeout(40); }
      await page.waitForTimeout(150);
      await page.mouse.up();
    }
    // About two dapim lower (to the right is lower).
    await expect.poll(() => page.evaluate(() => state.browsePageRef), { timeout: 8000 }).toMatch(/^Chullin 8[34]a$/);
  });

  test('the page sound starts on and its switch is remembered', async ({ page }) => {
    await open(page);
    const button = page.locator('#dafBookSoundButton');
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(await page.evaluate(() => localStorage.getItem('dafsync-book-sound'))).toBe('off');
    await page.reload();
    await expect(page.locator('#dafBookSoundButton')).toHaveAttribute('aria-pressed', 'false');
  });

  test('with reduced motion the arrows step plainly, with no turning leaf', async ({ page }) => {
    await open(page, '/browse/?ref=Chullin%2086a', { reducedMotion: true });
    await readyOn(page, 'Chullin|86|a');
    await page.locator('#dafNextAmudButton').click();
    await expect(page.locator('.daf-book-stage')).toHaveCount(0);
    await readyOn(page, 'Chullin|86|b');
  });
});
