import { test, expect } from '@playwright/test';
import { preparePage } from '../support/harness.mjs';
import { USERS } from '../fixtures/dataset.mjs';

// Estimated phrases (segment.estimated, from fillMissingDafText) keep their
// timing behavior for everyone. The dashed rings / faded text are an admin
// diagnostic, gated the same way as the alignment chip: body.is-admin, which
// auth.js sets when the profile arrives -- including after first paint.

function pageMap() {
  const boxes = [];
  const row = (ref, y, count) => {
    for (let i = 0; i < count; i += 1) boxes.push({ ref, wordIndex: i, x: 0.8 - i * 0.12, y, w: 0.1, h: 0.02 });
  };
  row('Chullin 89a.1', 0.10, 5);
  row('Chullin 89a.2', 0.30, 4);
  return { wordBoxes: boxes };
}

async function paintEstimatedPhrase(page) {
  return page.evaluate((map) => {
    state.dafRef = 'Chullin 89a';
    state.segments = [
      { ref: 'Chullin 89a.1', w0: 0, w1: 4, start: 0, end: 10, he: 'real phrase', en: 'real', estimated: false },
      { ref: 'Chullin 89a.2', w0: 0, w1: 3, start: 20, end: 30, he: 'estimated phrase', en: 'estimated', estimated: true },
    ];
    state.vilnaPageMap = map;
    state.vilnaOverlayKey = '';
    state.activeIndex = 0;
    switchDafView('text');
    renderDafWindow();
    const realActive = getComputedStyle(document.querySelector('.daf-segment.active'));
    const realSnapshot = {
      background: realActive.backgroundColor,
      outline: realActive.outlineStyle,
      opacity: realActive.opacity,
      shadow: realActive.boxShadow,
    };
    state.activeIndex = 1;
    state.vilnaOverlayKey = '';
    renderDafWindow();
    switchDafView('page');
    renderVilnaWordBoxes();
    updateVilnaOverlay();
    const estimatedBox = document.querySelector('.vilna-phrase-box.estimated');
    const realBox = document.querySelector('.vilna-phrase-box:not(.estimated)');
    estimatedBox.classList.add('phrase-hover');
    realBox.classList.add('phrase-hover');
    const text = getComputedStyle(document.querySelector('.daf-segment.estimated.active'));
    const rect = getComputedStyle(document.querySelector('.vilna-active-rect'));
    const phrase = getComputedStyle(estimatedBox);
    const realPhrase = getComputedStyle(realBox);
    return {
      admin: document.body.classList.contains('is-admin'),
      textClass: document.querySelector('.daf-segment.estimated.active').className,
      phraseClass: estimatedBox.className,
      rectClass: document.querySelector('.vilna-active-rect').className,
      real: realSnapshot,
      text: { background: text.backgroundColor, outline: text.outlineStyle, opacity: text.opacity, shadow: text.boxShadow },
      rect: { background: rect.backgroundColor, outline: rect.outlineStyle, blend: rect.mixBlendMode },
      hover: { estimated: phrase.backgroundColor, real: realPhrase.backgroundColor, outline: phrase.outlineStyle },
    };
  }, pageMap());
}

test.describe('estimated phrases are marked for admins only', () => {
  test('a signed-out reader sees a normal phrase, on the page and in the text', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/watch/?ref=Chullin%2089a');
    await expect.poll(() => page.evaluate(() => Boolean(window.DafSyncAuth) && !document.body.classList.contains('is-admin'))).toBe(true);

    const view = await paintEstimatedPhrase(page);
    expect(view.admin).toBe(false);
    expect(view.textClass).toContain('estimated');
    expect(view.phraseClass).toContain('estimated');
    expect(view.rectClass).toContain('estimated');
    expect(view.text.outline).toBe('none');
    expect(view.text.opacity).toBe('1');
    expect(view.text.background).toBe(view.real.background);
    expect(view.text.shadow).toBe(view.real.shadow);
    expect(view.rect.background).toBe('rgb(142, 205, 245)');
    expect(view.rect.outline).toBe('none');
    expect(view.rect.blend).toBe('multiply');
    expect(view.hover.outline).toBe('none');
    expect(view.hover.estimated).toBe(view.hover.real);
  });

  test('a signed-in non-admin sees the same normal highlight', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await page.goto('/watch/?ref=Chullin%2089a');
    await expect.poll(() => page.evaluate(() => document.body.classList.contains('is-signed-in') && !document.body.classList.contains('is-admin'))).toBe(true);

    const view = await paintEstimatedPhrase(page);
    expect(view.text.outline).toBe('none');
    expect(view.text.background).toBe(view.real.background);
    expect(view.rect.background).toBe('rgb(142, 205, 245)');
    expect(view.rect.outline).toBe('none');
    expect(view.hover.estimated).toBe(view.hover.real);
  });

  test('an admin sees the dashed estimated outline, including when admin status arrives after paint', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/watch/?ref=Chullin%2089a');
    await expect.poll(() => page.evaluate(() => Boolean(window.DafSyncAuth))).toBe(true);

    const before = await paintEstimatedPhrase(page);
    expect(before.rect.outline).toBe('none');
    expect(before.text.outline).toBe('none');

    // auth.js does this when the profile resolves: toggle body.is-admin.
    // No second render -- the marks have to follow the class on their own.
    const after = await page.evaluate(() => {
      document.body.classList.add('is-admin');
      const text = getComputedStyle(document.querySelector('.daf-segment.estimated.active'));
      const rect = getComputedStyle(document.querySelector('.vilna-active-rect'));
      const phrase = getComputedStyle(document.querySelector('.vilna-phrase-box.estimated'));
      return {
        textOutline: text.outlineStyle,
        textOpacity: text.opacity,
        rectOutline: rect.outlineStyle,
        rectBackground: rect.backgroundColor,
        phraseOutline: phrase.outlineStyle,
      };
    });
    expect(after.textOutline).toBe('dashed');
    expect(Number(after.textOpacity)).toBeLessThan(1);
    expect(after.rectOutline).toBe('dashed');
    expect(after.rectBackground).toBe('rgba(0, 0, 0, 0)');
    expect(after.phraseOutline).toBe('dashed');
  });

  test('a signed-in admin sees the outlines from the real is-admin class', async ({ page }) => {
    await preparePage(page, { user: USERS.admin });
    await page.goto('/watch/?ref=Chullin%2089a');
    await expect.poll(() => page.evaluate(() => document.body.classList.contains('is-admin'))).toBe(true);

    const view = await paintEstimatedPhrase(page);
    expect(view.admin).toBe(true);
    expect(view.text.outline).toBe('dashed');
    expect(Number(view.text.opacity)).toBeLessThan(1);
    expect(view.rect.outline).toBe('dashed');
    expect(view.rect.background).toBe('rgba(0, 0, 0, 0)');
    expect(view.hover.outline).toBe('dashed');
    expect(view.hover.estimated).toBe(view.hover.real);
  });
});
