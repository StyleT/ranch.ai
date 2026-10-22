import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
const status = JSON.parse(readFileSync('test/fixtures/daemon/status.json', 'utf8')) as { cameras: { name: string; online: boolean }[] };

test.describe('home', () => {
  test('renders every camera with its online state and the health strip', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('health-strip')).toBeVisible();
    for (const c of status.cameras) {
      const card = page.getByTestId(`camera-card-${c.name}`);
      await expect(card).toBeVisible();
      await expect(card).toHaveAttribute('data-state', c.online ? 'online' : 'offline');
    }
    const offline = status.cameras.filter((c) => !c.online);
    for (const c of offline) await expect(page.getByTestId(`alert-camera_offline-${c.name}`)).toBeVisible();
  });
  test('goes live over SSE and shows activity', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('connection-badge')).toHaveAttribute('data-connection', 'live');
    await expect(page.getByTestId('activity-feed')).toBeVisible();
    await expect(page.getByTestId('detections-matrix')).toBeVisible();
  });
  test('a camera card opens the camera page', async ({ page }) => {
    await page.goto('/');
    const first = status.cameras[0]!.name;
    await page.getByTestId(`camera-card-${first}`).click();
    await expect(page).toHaveURL(new RegExp(`/cameras/${first}$`));
    await expect(page.getByRole('heading', { level: 1, name: first })).toBeVisible();
    await expect(page.getByTestId('stream-player')).toHaveAttribute('data-mode', 'buffer-mjpeg');
  });
});
