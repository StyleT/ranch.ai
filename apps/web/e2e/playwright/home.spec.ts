import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
const status = JSON.parse(readFileSync('test/fixtures/daemon/status.json', 'utf8')) as {
  cameras: { name: string; online: boolean }[];
};

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
    for (const c of offline) {
      await expect(page.getByTestId(`alert-camera_offline-${c.name}`)).toBeVisible();
    }
  });
  test('the clips tile shows the last hour and links to the pipeline on System', async ({ page }) => {
    await page.goto('/');
    const tile = page.getByTestId('clips-tile');
    await expect(tile).toContainText('6 cut · 18 cand');
    await expect(tile).toHaveAttribute('data-tone', 'bad'); // mops_cam's ring stopped in the fixture
    await expect(tile).toHaveAttribute('title', /ring input stalled: mops_cam 95 s/);
    await tile.click();
    await expect(page).toHaveURL(/\/system#clips$/);
    await expect(page.getByTestId('clips-section')).toBeVisible();
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
    await expect(page.getByTestId('stream-player')).toHaveAttribute('data-mode', /^(starting|live|stalled|offline)$/);
  });
});
