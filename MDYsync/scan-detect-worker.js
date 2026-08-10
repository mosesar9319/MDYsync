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

// Runs the standard "flatten a photographed document" pipeline (grayscale ->
// blur -> edge detection -> contour finding -> largest convex 4-sided
// shape) to find the page's corners without the reader marking them by
// hand. Identical logic to the old main-thread detectPageCorners, just
// building the source Mat directly from raw RGBA bytes instead of
// cv.imread(<img>) -- a Worker has no DOM, canvas, or Image element to read
// from, only the pixel buffer the main thread decoded and transferred over.
// Returns 4 corner points in image-pixel space (unordered), or null if
// nothing plausible was found.
function detectPageCorners(cv, width, height, rgba) {
  const src = new cv.Mat(height, width, cv.CV_8UC4);
  src.data.set(rgba);
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const edges = new cv.Mat();
  const dilated = new cv.Mat();
  const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  const otsuMask = new cv.Mat();
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    // Canny's two thresholds used to be a fixed 50/150 -- reasonable for a
    // well-lit, high-contrast page-on-dark-background photo, but a real
    // failure case (a scan that needed a manual corner fallback) had a page
    // sitting against a comparatively light, low-contrast background, where
    // the actual page/background luminance step can fall below a fixed
    // lower threshold of 50 and produce no boundary edge at all -- the
    // detector then has nothing to find a quad in, regardless of how the
    // downstream contour/confidence scoring is tuned (see scoreQuadConfidence
    // in app.js, which is never even reached in that case). Otsu's method
    // computes the threshold that best separates this specific image's own
    // two dominant intensity populations (page vs. background), so deriving
    // Canny's thresholds from it -- the standard high=otsu, low=0.5*otsu
    // pairing -- adapts per-photo instead of assuming every photo has the
    // same fixed contrast. Floored at 30 so a near-blank/uniform frame
    // (Otsu threshold near 0) doesn't collapse Canny to a no-op.
    const otsuLevel = cv.threshold(blurred, otsuMask, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    const cannyUpper = Math.max(30, otsuLevel);
    cv.Canny(blurred, edges, cannyUpper * 0.5, cannyUpper);
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
    return best;
  } finally {
    src.delete();
    gray.delete();
    blurred.delete();
    edges.delete();
    dilated.delete();
    kernel.delete();
    contours.delete();
    hierarchy.delete();
    otsuMask.delete();
  }
}

self.onmessage = async (event) => {
  const { id, width, height, buffer } = event.data;
  try {
    const cv = await ensureCv();
    const quad = detectPageCorners(cv, width, height, new Uint8ClampedArray(buffer));
    self.postMessage({ id, quad });
  } catch (error) {
    self.postMessage({ id, error: error.message });
  }
};
