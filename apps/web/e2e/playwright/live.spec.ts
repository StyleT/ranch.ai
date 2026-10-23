import { test, expect } from '@playwright/test';

const CODEC = 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"';

test('the camera page plays the recorder HLS and says LIVE with a latency', async ({ page }) => {
  await page.goto('/cameras/donkey_cam');
  const player = page.getByTestId('stream-player');
  await expect(player).toHaveAttribute('data-mode', /^(starting|live)$/);
  const canPlay = await page.evaluate((c) => document.createElement('video').canPlayType(c) !== '', CODEC);
  test.skip(!canPlay, 'this browser build cannot decode H.264/AAC (run with Google Chrome: PW_CHANNEL unset)');
  await expect(player).toHaveAttribute('data-mode', 'live', { timeout: 20_000 });
  await expect(player).toHaveAttribute('data-latency-s', /^\d+(\.\d+)?$/);
  // playback is real: the clock advances (readyState dips to 1 between segments of the looping fixture, so poll currentTime)
  await expect.poll(() => player.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 10_000 }).toBeGreaterThan(1);
  await expect(player.getByText(/^LIVE · \d+(\.\d+)? s$/)).toBeVisible();
});

test('the camera page shows the probe-derived session state and the 24 h availability strip', async ({ page }) => {
  await page.goto('/cameras/donkey_cam');
  await expect(page.getByTestId('camera-state')).toHaveAttribute('data-state', /^(connected|degraded|down|unknown)$/);
  const avail = page.getByTestId('availability'); await avail.scrollIntoViewIfNeeded();
  await expect(avail).toContainText(/% connected/);
  await expect(avail.locator('[data-testid=chart-timeline]')).toBeVisible();
});

test('unmute toggles the audio track', async ({ page }) => {
  await page.goto('/cameras/donkey_cam');
  const video = page.getByTestId('stream-player').locator('video');
  expect(await video.evaluate((v: HTMLVideoElement) => v.muted)).toBe(true);
  await page.getByTestId('stream-mute').click();
  expect(await video.evaluate((v: HTMLVideoElement) => v.muted)).toBe(false);
  await expect(page.getByTestId('stream-mute')).toHaveAttribute('aria-pressed', 'true');
});

test('a playlist the recorder stopped writing is shown as the camera reconnecting, never as LIVE', async ({ page, context }) => {
  await context.route('**/api/ui/hls/**/index.m3u8*', (route) => route.continue({ url: route.request().url().split('?')[0] + '?scenario=live-stall' }));
  await page.goto('/cameras/donkey_cam');
  const player = page.getByTestId('stream-player');
  await expect(player).toHaveAttribute('data-mode', 'offline', { timeout: 20_000 });
  await expect(player.getByText(/camera reconnecting/)).toBeVisible();
  await expect(player.getByText(/^LIVE/)).toHaveCount(0);
});
