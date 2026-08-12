'use strict';
// Runs OpenCV.js-based page-corner detection off the main thread. A real
// end-to-end trial (see app.js's module comment on the camera-scan feature)
// found that this library's own runtime bring-up can, in some environments,
// monopolize its thread for a long time before ever settling -- fine in a
// Worker, where that only delays this one background task, but unacceptable
// on the main thread, where it would freeze the whole page's UI. This exact
// build of OpenCV.js explicitly supports running under importScripts() in a
// Worker (see its own UMD wrapper's `typeof importScripts==='function'`
// branch), which is the standard way to use it off the main thread.

const OPENCV_JS_VERSION = '4.9.0-release.1';

let cvReadyPromise = null;

// Same defensive multi-path readiness check as the old main-thread loader
// (immediately usable, a thenable Module, or an onRuntimeInitialized
// callback) -- still don't know which this build will do in a given
// browser, and guessing wrong here should reject cleanly, not hang.
function ensureCv() {
  if (self.cv?.Mat) return Promise.resolve(self.cv);
  if (cvReadyPromise) return cvReadyPromise;
  cvReadyPromise = (async () => {
    try {
      importScripts(`https://cdn.jsdelivr.net/npm/@techstark/opencv-js@${OPENCV_JS_VERSION}/dist/opencv.js`);
    } catch (error) {
      cvReadyPromise = null;
      throw new Error(`Could not load the page-detection library: ${error.message}`);
    }
    try {
      let cv = self.cv;
      if (!cv) throw new Error('Page-detection library did not attach itself.');
      if (typeof cv.then === 'function') cv = await cv;
      if (!cv.Mat) await new Promise((ready) => { cv['onRuntimeInitialized'] = ready; });
      self.cv = cv;
      return cv;
    } catch (error) {
      cvReadyPromise = null;
      throw error;
    }
  })();
  return cvReadyPromise;
}

// Canny's two thresholds have no single value that works across every
// photo's contrast -- a real failure case (a scan that needed a manual
// corner fallback) had a page sitting against a comparatively low-contrast
// background, where the page/background luminance step can fall below a
// fixed lower threshold and produce no boundary edge at all, leaving
// nothing for the contour step below to find a quad in regardless of how
// the downstream confidence scoring (scoreQuadConfidence in app.js) is
// tuned. Tries, in order, until one finds a plausible quad:
//   1. Otsu's method -- computes the threshold that best separates this
//      specific image's own two dominant intensity populations (page vs.
//      background), so it adapts per-photo instead of assuming a fixed
//      contrast. Wrapped in its own try/catch since it's a less
//      battle-tested call in this environment than plain Canny -- if it
//      throws for any reason, the fixed-threshold strategies below still
//      run instead of the whole detection silently failing.
//   2. The original fixed 50/150 pair -- works fine on a typical, well-lit
//      photo, kept as a proven fallback.
//   3. A deliberately oversensitive fixed pair, as a last resort for a
//      photo low-contrast enough that even Otsu's own threshold sits too
//      high -- picks up weak/noisy edges too, but findLargestQuad's own
//      "must be a 4-sided convex shape, take the largest" filter and
//      app.js's confidence scoring downstream both exist specifically to
//      reject a bad guess rather than trust it blindly.
function cannyThresholdStrategies(cv, blurred) {
  const strategies = [];
  try {
    const otsuMask = new cv.Mat();
    let otsuLevel;
    try {
      otsuLevel = cv.threshold(blurred, otsuMask, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    } finally {
      otsuMask.delete();
    }
    const upper = Math.max(30, otsuLevel);
    strategies.push({ low: upper * 0.5, high: upper });
  } catch (error) {
    console.error('Otsu threshold unavailable, skipping:', error);
  }
  strategies.push({ low: 50, high: 150 });
  strategies.push({ low: 20, high: 60 });
  return strategies;
}

// One Canny + contour pass at a given threshold pair -- the largest convex
// 4-sided contour found, or null. Shared by every strategy in
// cannyThresholdStrategies so detectPageCorners can just pick whichever
// pass's result is most convincing (largest area).
function findLargestQuad(cv, blurred, kernel, lowThreshold, highThreshold) {
  const edges = new cv.Mat();
  const dilated = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  try {
    cv.Canny(blurred, edges, lowThreshold, highThreshold);
    cv.dilate(edges, dilated, kernel);
    cv.findContours(dilated, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    let best = null;
    let bestArea = 0;
    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      const approx = new cv.Mat();
      try {
        const perimeter = cv.arcLength(contour, true);
        cv.approxPolyDP(contour, approx, 0.02 * perimeter, true);
        if (approx.rows === 4 && cv.isContourConvex(approx)) {
          const area = cv.contourArea(approx);
          if (area > bestArea) {
            bestArea = area;
            best = [];
            for (let r = 0; r < 4; r++) best.push([approx.data32S[r * 2], approx.data32S[r * 2 + 1]]);
          }
        }
      } finally {
        approx.delete();
        contour.delete();
      }
    }
    return best ? { points: best, area: bestArea } : null;
  } finally {
    edges.delete();
    dilated.delete();
    contours.delete();
    hierarchy.delete();
  }
}

// Runs the standard "flatten a photographed document" pipeline (grayscale ->
// blur -> edge detection -> contour finding -> largest convex 4-sided
// shape) to find the page's corners without the reader marking them by
// hand, trying multiple Canny threshold strategies (see
// cannyThresholdStrategies) and keeping whichever finds the largest
// plausible page-shaped contour. Builds the source Mat directly from raw
// RGBA bytes instead of cv.imread(<img>) -- a Worker has no DOM, canvas, or
// Image element to read from, only the pixel buffer the main thread decoded
// and transferred over. Returns 4 corner points in image-pixel space
// (unordered), or null if nothing plausible was found by any strategy.
function detectPageCorners(cv, width, height, rgba) {
  const src = new cv.Mat(height, width, cv.CV_8UC4);
  src.data.set(rgba);
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);

    let best = null;
    for (const { low, high } of cannyThresholdStrategies(cv, blurred)) {
      const found = findLargestQuad(cv, blurred, kernel, low, high);
      if (found && (!best || found.area > best.area)) best = found;
    }
    return best ? best.points : null;
  } finally {
    src.delete();
    gray.delete();
    blurred.delete();
    kernel.delete();
  }
}

self.onmessage = async (event) => {
  // A warmup message (see app.js's prewarmScanDetection) just starts the
  // opencv.js download+compile early -- no id, no pixels, no reply expected
  // (app.js fires this and moves on without waiting). Letting a real
  // detection request race in behind it is fine either way: ensureCv()
  // caches its promise, so a request that arrives before warmup finishes
  // just awaits the same in-flight load instead of starting a second one.
  if (event.data.warmup) {
    try {
      await ensureCv();
    } catch (error) {
      console.error('Page-detection warmup failed:', error.message);
    }
    return;
  }

  const { id, width, height, buffer } = event.data;
  try {
    const cv = await ensureCv();
    const quad = detectPageCorners(cv, width, height, new Uint8ClampedArray(buffer));
    self.postMessage({ id, quad });
  } catch (error) {
    self.postMessage({ id, error: error.message });
  }
};
