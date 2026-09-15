import { test, expect } from '@playwright/test';
import { preparePage } from '../support/harness.mjs';

// Daf Scan's "Reposition photo" recovery: a failed match (no daf identified
// from the header) used to force a full retake even for a library-picked
// photo, because the final cropped image submitted to the server was the
// only copy of it kept anywhere -- once cropped, the original was gone.
// state.scanWidePhotoDataUrl now stashes the widest photo available for the
// current attempt (set inside showScanCameraPhotoCrop, so both the library
// pick and this feature's own re-entry go through the same choke point),
// and the failure screen offers reopening the same pinch/pan crop UI on it
// instead of only "Retake" (discard everything, start over).
//
// No real camera in this sandbox, so this exercises the "choose from
// library" sub-flow directly (forcing #scanCameraView open, then feeding
// #scanLibraryInput a file) rather than the live-shutter path -- both paths
// stash the wide photo the same way; see captureScanWidePhotoFromCamera's
// own comment for why the shutter path needs a second capture where the
// library path doesn't.
//
// 40x30 solid-red PNG, standing in for a photographed page.
const TEST_PHOTO_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAACgAAAAeCAIAAADRv8uKAAAAK0lEQVR4nO3NMQ0AAAgDsGmafwHIQgYcTfo3056IWCwWi8VisVgsFov/xgsth36Mmzf4yAAAAABJRU5ErkJggg==';

test('a failed match offers repositioning the same photo instead of only a retake', async ({ page }) => {
  // The real endpoint needs Vision credentials this sandbox doesn't have --
  // simulate the exact failure this feature targets. A stub that never
  // resolves the route (harness.mjs has no /api/scan-daf-page entry) throws
  // inside confirmScan()'s try block, which its own catch handles the same
  // way as a real network/HTTP failure would -- good enough here since this
  // test is about the recovery UI, not the fetch itself.
  await preparePage(page);
  await page.goto('/player/?view=scan');

  // Bypass the real camera (no device in this sandbox) -- jump straight to
  // the guided-capture view's "library" sub-flow.
  await page.evaluate(() => {
    document.getElementById('scanIntro').hidden = true;
    document.getElementById('scanCameraView').hidden = false;
  });

  const buffer = Buffer.from(TEST_PHOTO_BASE64, 'base64');
  await page.locator('#scanLibraryInput').setInputFiles({ name: 'page.png', mimeType: 'image/png', buffer });
  await expect(page.locator('#scanCameraConfirmCropButton')).toBeVisible();

  await page.locator('#scanCameraConfirmCropButton').click();

  // The failure screen, with Reposition photo offered alongside Retake.
  await expect(page.locator('#scanAlign')).toBeVisible();
  await expect(page.locator('#scanRepositionButton')).toBeVisible();

  await page.locator('#scanRepositionButton').click();

  // Back in the same pinch/pan crop UI, no new photo pick, no camera
  // re-open -- populated with the photo already provided.
  await expect(page.locator('#scanCameraView')).toBeVisible();
  await expect(page.locator('#scanCameraPhotoWrap')).toBeVisible();
  await expect(page.locator('#scanCameraConfirmCropButton')).toBeVisible();
  const photoSrc = await page.locator('#scanCameraPhotoZoom').getAttribute('src');
  expect(photoSrc).toContain('data:image');
});
