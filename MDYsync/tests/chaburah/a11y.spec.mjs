import { test, expect } from '@playwright/test';
import { preparePage } from '../support/harness.mjs';
import { USERS, NOTE_IDS } from '../fixtures/dataset.mjs';

// The WCAG 2.2 AA checks that can be made mechanical. The rest of the review —
// contrast ratios, screen-reader narration, high-contrast mode — is recorded in
// docs/ACCESSIBILITY.md, because the acceptance criterion is a DOCUMENTED
// checklist with its exceptions, not a green run that implies more than it tested.

const THREAD = `/chaburah/thread/?thread=${NOTE_IDS.deepThread}`;

test.describe('Accessibility — structure', () => {
  test('the thread has one h1 and no skipped heading levels', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await page.goto(THREAD);
    await expect(page.locator('.ct-root')).toBeVisible();

    await expect(page.locator('h1')).toHaveCount(1);
    const levels = await page.evaluate(() =>
      [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => Number(h.tagName[1])));
    levels.forEach((level, index) => {
      if (index === 0) return;
      // A jump of more than one (h1 straight to h3) leaves a screen-reader
      // user guessing what the missing level was.
      expect(level - levels[index - 1]).toBeLessThanOrEqual(1);
    });
  });

  test('the feed has one h1 and one main', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/chaburah/');
    await expect(page.locator('.cc-card').first()).toBeVisible();
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.locator('main')).toHaveCount(1);
  });

  test('posts are articles with accessible names', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await page.goto(THREAD);
    await expect(page.locator('.ct-root')).toBeVisible();

    await expect(page.locator('article.ct-root')).toHaveAttribute('aria-label', /Opening post/);
    const replies = page.locator('article.ct-reply');
    const count = await replies.count();
    for (let i = 0; i < count; i += 1) {
      await expect(replies.nth(i)).toHaveAttribute('aria-label', /Reply by .+, level \d+/);
    }
  });
});

test.describe('Accessibility — controls', () => {
  test('every button has an accessible name', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await page.goto(THREAD);
    await expect(page.locator('.ct-root')).toBeVisible();

    const unnamed = await page.evaluate(() =>
      [...document.querySelectorAll('button')]
        .filter((b) => b.offsetParent !== null)
        .filter((b) => !(b.textContent || '').trim() && !b.getAttribute('aria-label') && !b.getAttribute('title'))
        .map((b) => b.className));
    expect(unnamed).toEqual([]);
  });

  test('every form control has a label', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await page.goto(THREAD);
    await expect(page.locator('.ct-root')).toBeVisible();

    const unlabelled = await page.evaluate(() =>
      [...document.querySelectorAll('input, select, textarea')]
        .filter((el) => el.offsetParent !== null)
        .filter((el) => !el.getAttribute('aria-label')
          && !el.getAttribute('aria-labelledby')
          && !el.getAttribute('placeholder')
          && !(el.id && document.querySelector(`label[for="${el.id}"]`)))
        .map((el) => el.id || el.className));
    expect(unlabelled).toEqual([]);
  });

  test('toggles expose pressed or expanded state', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await page.goto(THREAD);
    await expect(page.locator('.ct-root')).toBeVisible();

    await expect(page.locator('.ct-branch-toggle').first()).toHaveAttribute('aria-expanded', /true|false/);
    await expect(page.locator('.ct-more').first()).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#ccNotifyButton')).toHaveAttribute('aria-expanded', /true|false/);
  });

  test('links that open a new tab carry safe rel attributes', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await page.goto(THREAD);
    await expect(page.locator('.ct-root')).toBeVisible();

    const unsafe = await page.evaluate(() =>
      [...document.querySelectorAll('a[target="_blank"]')]
        .filter((a) => !(a.rel || '').includes('noopener'))
        .map((a) => a.href));
    expect(unsafe).toEqual([]);
  });
});

test.describe('Accessibility — touch, zoom and motion', () => {
  test('interactive targets meet the minimum size on a phone', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'Touch target sizing is a phone concern');
    await preparePage(page, { user: USERS.ordinary });
    await page.goto(THREAD);
    await expect(page.locator('.ct-root')).toBeVisible();

    const small = await page.evaluate(() => {
      // WCAG 2.2 target size (minimum) exempts a target that is "in a sentence
      // or its size is otherwise constrained by the line-height of non-target
      // text". The "Replying to X" backlink and the quote attribution link are
      // exactly that, so flagging them would be reporting a violation that the
      // criterion does not make. A link is treated as inline when its parent
      // carries meaningfully more text than the link itself.
      const isInlineInSentence = (el) => {
        if (el.tagName !== 'A') return false;
        const own = (el.textContent || '').trim().length;
        const parent = (el.parentElement?.textContent || '').trim().length;
        return own > 0 && parent > own + 3;
      };
      return [...document.querySelectorAll('button, a[href], select')]
        .filter((el) => el.offsetParent !== null)
        .filter((el) => !isInlineInSentence(el))
        .map((el) => ({ el, r: el.getBoundingClientRect() }))
        .filter(({ r }) => r.width > 0 && r.height > 0 && (r.height < 24 || r.width < 24))
        .map(({ el, r }) => `${el.tagName}.${el.className} ${Math.round(r.width)}x${Math.round(r.height)}`);
    });
    // WCAG 2.2 AA target size (minimum) is 24x24 CSS px.
    expect(small).toEqual([]);
  });

  test('the page does not scroll sideways at 200% zoom', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'Measured against the desktop layout');
    await preparePage(page, { user: USERS.ordinary });
    // 200% zoom on a 1280-wide window is equivalent to a 640px viewport.
    await page.setViewportSize({ width: 640, height: 720 });
    await page.goto(THREAD);
    await expect(page.locator('.ct-root')).toBeVisible();

    const layout = await page.evaluate(() => ({
      inner: window.innerWidth,
      document: document.documentElement.scrollWidth,
    }));
    expect(layout.document).toBeLessThanOrEqual(layout.inner);
  });

  test('reduced motion removes the permalink flash', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${THREAD}&comment=b0000000-0000-4000-8000-000000000002`);
    await expect(page.locator('#comment-b0000000-0000-4000-8000-000000000002')).toBeVisible();

    const animation = await page.locator('#comment-b0000000-0000-4000-8000-000000000002')
      .evaluate((node) => getComputedStyle(node).animationName);
    expect(animation).toBe('none');
  });
});

test.describe('Accessibility — announcements and RTL', () => {
  test('a live region announces load results', async ({ page }) => {
    await preparePage(page, { user: USERS.ordinary });
    await page.goto(THREAD);
    await expect(page.locator('.ct-root')).toBeVisible();

    const status = page.locator('#ctStatus');
    await expect(status).toHaveAttribute('role', 'status');
    await expect(status).toHaveAttribute('aria-live', 'polite');
  });

  test('errors are announced assertively, not merely coloured', async ({ page }) => {
    await preparePage(page, {
      user: null,
      control: { failures: { 'line_notes:select': { message: 'boom', code: '42501' } } },
    });
    await page.goto(THREAD);
    await expect(page.locator('[role="alert"]')).toBeVisible();
  });

  test('Hebrew excerpts carry dir and lang', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto(`/chaburah/thread/?thread=${NOTE_IDS.singleWordRange}`);
    await expect(page.locator('.ct-root')).toBeVisible();

    const quote = page.locator('.ct-source-text');
    await expect(quote).toHaveAttribute('dir', 'rtl');
    await expect(quote).toHaveAttribute('lang', 'he');
  });
});
