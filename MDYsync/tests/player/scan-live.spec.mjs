import { test, expect } from '@playwright/test';
import { preparePage } from '../support/harness.mjs';

// The live, shutter-free Daf Scan feature (scan-live.js) -- covers what can
// actually be exercised in a headless browser with no real camera hardware:
//  1. The pure logic (consensus/stability, quality-gate thresholds, the
//     object-fit:cover capture-rect math, route building) -- all plain
//     functions, fully testable with synthetic input via page.evaluate.
//  2. The DOM lifecycle: entering/leaving the Scan tab, the "Use photo scan
//     instead" fallback, Cancel, and the real (genuine, not mocked) camera-
//     permission-denied path a headless run always hits, since there is no
//     camera to grant permission to.
// What this file deliberately does NOT attempt: driving a full capture ->
// OCR -> lock -> navigate cycle against real decoded video frames, which
// needs an actual (or fake-device-flagged) camera this project's Playwright
// config does not configure. That gap is real-device testing this suite
// cannot substitute for -- see the feature's own final report.

test.describe('scan-live.js -- pure logic', () => {
  test('dafKeyOf builds a stable tractate+daf+amud key, and null for no match', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    const result = await page.evaluate(() => {
      const { dafKeyOf } = window.ScanLive.__testing;
      return {
        a: dafKeyOf({ tractate: 'Chullin', daf: 89, amud: 'a' }),
        b: dafKeyOf({ tractate: 'Chullin', daf: 89, amud: 'a' }),
        differentDaf: dafKeyOf({ tractate: 'Chullin', daf: 86, amud: 'a' }),
        differentAmud: dafKeyOf({ tractate: 'Chullin', daf: 89, amud: 'b' }),
        none: dafKeyOf(null),
      };
    });
    expect(result.a).toBe(result.b);
    expect(result.a).not.toBe(result.differentDaf);
    // Same daf, different amud -- must NOT be treated as the same read.
    // scan-daf-header.mjs's amud is a real, potentially noisy position
    // signal now, not a constant -- two frames agreeing on the daf but
    // disagreeing on amud is exactly what consensus should catch, the same
    // way disagreeing on daf already does (see dafKeyOf's own comment).
    expect(result.a).not.toBe(result.differentAmud);
    expect(result.none).toBe(null);
  });

  test('pushScanHistory caps the rolling window at 3, dropping the oldest first', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    const history = await page.evaluate(() => {
      const { pushScanHistory } = window.ScanLive.__testing;
      let h = [];
      h = pushScanHistory(h, 'A');
      h = pushScanHistory(h, 'B');
      h = pushScanHistory(h, 'C');
      h = pushScanHistory(h, 'D');
      return h;
    });
    expect(history).toEqual(['B', 'C', 'D']);
  });

  test('evaluateConsensus locks on 2 consecutive agreeing reads', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    const key = await page.evaluate(() => window.ScanLive.__testing.evaluateConsensus(['A', 'A']));
    expect(key).toBe('A');
  });

  test('evaluateConsensus locks on 2-of-last-3 even when not consecutive', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    const key = await page.evaluate(() => window.ScanLive.__testing.evaluateConsensus(['A', 'B', 'A']));
    expect(key).toBe('A');
  });

  test('evaluateConsensus never locks on a single read, or on pure disagreement', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    const results = await page.evaluate(() => {
      const { evaluateConsensus } = window.ScanLive.__testing;
      return {
        single: evaluateConsensus(['A']),
        allDifferent: evaluateConsensus(['A', 'B', 'C']),
        empty: evaluateConsensus([]),
        allNull: evaluateConsensus([null, null, null]),
      };
    });
    expect(results.single).toBe(null);
    expect(results.allDifferent).toBe(null);
    expect(results.empty).toBe(null);
    expect(results.allNull).toBe(null);
  });

  test('evaluateConsensus resets on a conflicting result -- one stale match does not out-vote two fresh disagreements', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    // A matched twice, then two rounds of B -- the window is capped at 3, so
    // by the time B has appeared twice, only one A is still in the window
    // and B (2 consecutive, at the end) rightly wins, not a stale A.
    const key = await page.evaluate(() => {
      const { pushScanHistory, evaluateConsensus } = window.ScanLive.__testing;
      let h = [];
      h = pushScanHistory(h, 'A');
      h = pushScanHistory(h, 'A');
      h = pushScanHistory(h, 'B');
      h = pushScanHistory(h, 'B');
      return evaluateConsensus(h);
    });
    expect(key).toBe('B');
  });

  test('evaluateFrameQuality rejects dark, bright, flat, blurry, and moving frames; accepts a clean one', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    const results = await page.evaluate(() => {
      const { evaluateFrameQuality } = window.ScanLive.__testing;
      const base = { mean: 128, stddev: 40, edgeVariance: 20, motionDiff: 2 };
      return {
        clean: evaluateFrameQuality(base),
        dark: evaluateFrameQuality({ ...base, mean: 5 }),
        bright: evaluateFrameQuality({ ...base, mean: 250 }),
        flat: evaluateFrameQuality({ ...base, stddev: 1 }),
        blurry: evaluateFrameQuality({ ...base, edgeVariance: 0.1 }),
        moving: evaluateFrameQuality({ ...base, motionDiff: 80 }),
        noMotionSignalYet: evaluateFrameQuality({ ...base, motionDiff: null }),
      };
    });
    expect(results.clean.ok).toBe(true);
    expect(results.dark).toEqual({ ok: false, reason: 'dark' });
    expect(results.bright).toEqual({ ok: false, reason: 'bright' });
    expect(results.flat).toEqual({ ok: false, reason: 'flat' });
    expect(results.blurry).toEqual({ ok: false, reason: 'blurry' });
    expect(results.moving).toEqual({ ok: false, reason: 'moving' });
    // null motionDiff (no previous sample yet -- the very first frame) must
    // never be treated as "definitely moving": the gate has to pass on
    // everything else alone.
    expect(results.noMotionSignalYet.ok).toBe(true);
  });

  test('buildScanLiveHref matches the sitewide canonical /browse/?ref= convention and encodes the ref', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    const href = await page.evaluate(() => window.ScanLive.__testing.buildScanLiveHref('Chullin 89a'));
    expect(href).toBe('/browse/?ref=Chullin%2089a');
  });
});

test.describe('scan-live.js -- computeCaptureSourceRect (object-fit: cover math)', () => {
  // computeCaptureSourceRect (app.js) only ever calls .getBoundingClientRect()
  // and reads .videoWidth/.videoHeight on its first argument, and
  // .getBoundingClientRect() on its second -- plain duck-typed objects work
  // exactly like real elements here, no actual <video> or decoded frame
  // needed. Reused by scan-live.js for the exact same crop math the legacy
  // capture flow already relies on (see app.js's own comment on that
  // function) -- these are new tests since none existed before this feature.

  test('a video wider than the cutout region (landscape video, portrait cutout): cover crops the sides', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    const source = await page.evaluate(() => {
      const video = { videoWidth: 1920, videoHeight: 1080, getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 400 }) };
      const cutout = { getBoundingClientRect: () => ({ left: 100, top: 150, width: 200, height: 40 }) };
      return computeCaptureSourceRect(video, cutout);
    });
    expect(source).not.toBeNull();
    expect(source.sWidth).toBeGreaterThan(0);
    expect(source.sHeight).toBeGreaterThan(0);
    // The cutout sits inside the covered video area -- source rect must stay
    // within the native video's own pixel bounds.
    expect(source.sx).toBeGreaterThanOrEqual(0);
    expect(source.sy).toBeGreaterThanOrEqual(0);
    expect(source.sx + source.sWidth).toBeLessThanOrEqual(1920 + 0.001);
    expect(source.sy + source.sHeight).toBeLessThanOrEqual(1080 + 0.001);
  });

  test('a portrait video (phone camera) with a wide header cutout still resolves inside the native frame', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    const source = await page.evaluate(() => {
      const video = { videoWidth: 1080, videoHeight: 1920, getBoundingClientRect: () => ({ left: 0, top: 0, width: 390, height: 844 }) };
      const cutout = { getBoundingClientRect: () => ({ left: 20, top: 300, width: 350, height: 70 }) };
      return computeCaptureSourceRect(video, cutout);
    });
    expect(source).not.toBeNull();
    expect(source.sx + source.sWidth).toBeLessThanOrEqual(1080 + 0.001);
    expect(source.sy + source.sHeight).toBeLessThanOrEqual(1920 + 0.001);
  });

  test('a cutout exactly matching the video (1:1, no letterboxing) maps to the full native frame', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    const source = await page.evaluate(() => {
      const video = { videoWidth: 800, videoHeight: 600, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) };
      const cutout = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) };
      return computeCaptureSourceRect(video, cutout);
    });
    expect(source.sx).toBeCloseTo(0, 1);
    expect(source.sy).toBeCloseTo(0, 1);
    expect(source.sWidth).toBeCloseTo(800, 1);
    expect(source.sHeight).toBeCloseTo(600, 1);
  });

  test('returns null before the video has real dimensions (not yet playing)', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    const source = await page.evaluate(() => {
      const video = { videoWidth: 0, videoHeight: 0, getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 400 }) };
      const cutout = { getBoundingClientRect: () => ({ left: 10, top: 10, width: 100, height: 20 }) };
      return computeCaptureSourceRect(video, cutout);
    });
    expect(source).toBeNull();
  });
});

test.describe('scan-live.js -- DOM lifecycle', () => {
  test('opening the Scan tab shows the live scanner, not the legacy intro, by default', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    await page.evaluate(() => switchDafView('scan'));
    await expect(page.locator('#scanLive')).toBeVisible();
    await expect(page.locator('#scanIntro')).toBeHidden();
  });

  test('a real (headless, no camera) permission failure shows the emphasized fallback link, not a stuck spinner', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    await page.evaluate(() => switchDafView('scan'));
    // Headless Chromium with no granted camera permission and no fake
    // device rejects getUserMedia for real -- this is the genuine failure
    // path, not a mock standing in for one.
    await expect(page.locator('#scanLiveFallbackButton')).toHaveClass(/scan-live-fallback-emphasized/, { timeout: 10000 });
    await expect(page.locator('#scanLiveStatus')).not.toHaveText('Point your camera at the header, above the Gemara text.');
  });

  test('"Use photo scan instead" switches to the legacy flow and remembers that choice for the rest of the session', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    await page.evaluate(() => switchDafView('scan'));
    await page.locator('#scanLiveFallbackButton').click();
    await expect(page.locator('#scanLive')).toBeHidden();
    await expect(page.locator('#scanIntro')).toBeVisible();
    expect(await page.evaluate(() => state.scanUseLegacyFlow)).toBe(true);

    // Switching away and back to Scan respects the choice -- no snap back to
    // the live scanner mid-session once the reader has opted out of it.
    await page.evaluate(() => switchDafView('text'));
    await page.evaluate(() => switchDafView('scan'));
    await expect(page.locator('#scanIntro')).toBeVisible();
    await expect(page.locator('#scanLive')).toBeHidden();
  });

  test('Cancel returns to the legacy intro WITHOUT setting the session-wide legacy preference', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    await page.evaluate(() => switchDafView('scan'));
    await page.locator('#scanLiveCancelButton').click();
    await expect(page.locator('#scanLive')).toBeHidden();
    await expect(page.locator('#scanIntro')).toBeVisible();
    expect(await page.evaluate(() => state.scanUseLegacyFlow)).toBe(false);
  });

  test('navigating away from the Scan tab tears the live scanner down (hidden, checkmark cleared)', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    await page.evaluate(() => switchDafView('scan'));
    await expect(page.locator('#scanLive')).toBeVisible();
    await page.evaluate(() => switchDafView('text'));
    await expect(page.locator('#scanLive')).toBeHidden();
    expect(await page.evaluate(() => $('scanLiveCheckmark').hidden)).toBe(true);
  });

  test('window.ScanLive.stop() is idempotent and safe to call when nothing is running', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    // Never started at all on this page load -- must not throw.
    await expect(page.evaluate(() => { window.ScanLive.stop(); window.ScanLive.stop(); })).resolves.not.toThrow();
  });
});

test.describe('scan-live.js -- computeCropSourceRect ("Choose a photo" pinch/pan/zoom math)', () => {
  // computeCropSourceRect (app.js, reused here rather than duplicated -- see
  // this feature's own module comment) only calls .getBoundingClientRect()
  // on its wrap/cutout arguments and reads .naturalWidth/.naturalHeight on
  // its img argument -- plain duck-typed objects work exactly like real
  // elements, no actual <img> or decoded photo needed. Already used by the
  // legacy library-photo flow; these are new tests since none existed
  // before this feature reused it for a second caller.

  test('at zoom 1, no pan: the cutout maps straight onto the matching region of a same-proportioned photo', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    const source = await page.evaluate(() => {
      // A 1000x200 photo (5:1, matching the header cutout's own aspect
      // ratio) displayed at width:100% of a 500px-wide wrap -> 500x100 on
      // screen, nativeScale 2. A cutout covering the whole wrap should map
      // to the whole photo.
      const img = { naturalWidth: 1000, naturalHeight: 200 };
      const wrap = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 500, height: 100 }) };
      const cutout = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 500, height: 100 }) };
      return computeCropSourceRect(img, wrap, cutout, 0, 0, 1);
    });
    expect(source.sx).toBeCloseTo(0, 1);
    expect(source.sy).toBeCloseTo(0, 1);
    expect(source.sWidth).toBeCloseTo(1000, 1);
    expect(source.sHeight).toBeCloseTo(200, 1);
  });

  test('zooming in shrinks the cropped native region proportionally', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    const source = await page.evaluate(() => {
      const img = { naturalWidth: 1000, naturalHeight: 200 };
      const wrap = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 500, height: 100 }) };
      const cutout = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 500, height: 100 }) };
      // Zoomed 2x with no pan -- the cutout now only covers half the
      // photo's own native width/height (centered on the top-left corner,
      // since transform-origin is 0 0 -- panning is what recenters it).
      return computeCropSourceRect(img, wrap, cutout, 0, 0, 2);
    });
    expect(source.sWidth).toBeCloseTo(500, 1);
    expect(source.sHeight).toBeCloseTo(100, 1);
  });

  test('panning shifts the cropped native region, clamped to the photo\'s own bounds', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    const source = await page.evaluate(() => {
      const img = { naturalWidth: 1000, naturalHeight: 200 };
      const wrap = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 500, height: 100 }) };
      const cutout = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 500, height: 100 }) };
      // Panned the photo 10000px to the right at zoom 1 -- geometrically
      // that would put the crop entirely past the photo's own right edge;
      // a reader really can drag a library photo that far off-cutout
      // (unlike the live camera, where object-fit:cover geometrically
      // guarantees full coverage), so this has to clamp rather than
      // return a nonsensical negative-origin crop.
      return computeCropSourceRect(img, wrap, cutout, -10000, 0, 1);
    });
    expect(source.sx).toBe(1000); // clamped to the photo's own right edge
    expect(source.sWidth).toBe(1); // the 1px floor (Math.max(1, ...)) for an entirely off-canvas crop, not 0 or negative
  });

  test('returns null before the photo has real natural dimensions (not yet decoded)', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    const source = await page.evaluate(() => {
      const img = { naturalWidth: 0, naturalHeight: 0 };
      const wrap = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 500, height: 100 }) };
      const cutout = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 500, height: 100 }) };
      return computeCropSourceRect(img, wrap, cutout, 0, 0, 1);
    });
    expect(source).toBeNull();
  });
});

test.describe('scan-live.js -- "Choose a photo" DOM lifecycle', () => {
  // A minimal valid 2x2 red PNG -- real enough for <img>.decode() to
  // succeed (required before computeMinLivePhotoZoom/resetLivePhotoCropTransform
  // can read real naturalWidth/Height), with no dependency on any fixture
  // asset file.
  const TINY_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC',
    'base64'
  );

  test('choosing a photo hides the live camera controls and shows the photo-positioning UI', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    await page.evaluate(() => switchDafView('scan'));
    // activeSession is set synchronously before the getUserMedia call (see
    // startLiveScan), so this doesn't need to wait for that call's own
    // real, headless camera-permission failure to resolve first.
    await page.locator('#scanLiveLibraryInput').setInputFiles({ name: 'header.png', mimeType: 'image/png', buffer: TINY_PNG });

    await expect(page.locator('#scanLivePhotoWrap')).toBeVisible();
    await expect(page.locator('#scanLiveVideo')).toBeHidden();
    await expect(page.locator('#scanLiveControls')).toBeHidden();
    await expect(page.locator('#scanLivePhotoControls')).toBeVisible();
    await expect(page.locator('#scanLiveStatus')).toHaveText(
      'Pinch or drag the photo to fit the header inside the frame, then tap the checkmark.'
    );
  });

  test('"Back to camera" reverses photo mode and restarts the live camera path', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    await page.evaluate(() => switchDafView('scan'));
    await page.locator('#scanLiveLibraryInput').setInputFiles({ name: 'header.png', mimeType: 'image/png', buffer: TINY_PNG });
    await expect(page.locator('#scanLivePhotoWrap')).toBeVisible();

    await page.locator('#scanLivePhotoBackButton').click();
    await expect(page.locator('#scanLivePhotoWrap')).toBeHidden();
    await expect(page.locator('#scanLiveVideo')).toBeVisible();
    await expect(page.locator('#scanLiveControls')).toBeVisible();
    await expect(page.locator('#scanLivePhotoControls')).toBeHidden();
  });

  test('Cancel out of photo mode leaves no stale photo-mode markup on the next entry', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    await page.evaluate(() => switchDafView('scan'));
    await page.locator('#scanLiveLibraryInput').setInputFiles({ name: 'header.png', mimeType: 'image/png', buffer: TINY_PNG });
    await expect(page.locator('#scanLivePhotoWrap')).toBeVisible();

    await page.locator('#scanLiveCancelButton').click();
    await expect(page.locator('#scanLive')).toBeHidden();

    await page.evaluate(() => switchDafView('scan'));
    await expect(page.locator('#scanLivePhotoWrap')).toBeHidden();
    await expect(page.locator('#scanLiveControls')).toBeVisible();
  });

  test('confirming with no photo chosen is a safe no-op (defensive guard, not a crash)', async ({ page }) => {
    await preparePage(page, { user: null });
    await page.goto('/player/?ref=Chullin%2089a');
    await page.evaluate(() => switchDafView('scan'));
    // #scanLivePhotoConfirmButton exists in the DOM even while hidden --
    // dispatching its click event directly (rather than a real, visibility-
    // checked .click()) exercises handleScanLivePhotoConfirm's own early-
    // return guard (no scanLivePhotoTargetSession set, since no photo was
    // ever chosen) rather than a real crop attempt.
    await expect(page.locator('#scanLivePhotoConfirmButton').dispatchEvent('click')).resolves.not.toThrow();
  });
});
