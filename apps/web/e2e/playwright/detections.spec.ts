import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
const frames = JSON.parse(readFileSync('test/fixtures/daemon/frames.json', 'utf8')) as { id: number; camera: string; burst: unknown[] }[];
const burstHead = frames.find((f) => f.burst.length > 0) ?? frames[0]!;

test.describe('detections', () => {
  test('filters update the url and the list', async ({ page }) => {
    await page.goto('/detections?since=24h');
    await expect(page.locator('[data-loaded="true"]')).toBeVisible();
    await page.getByTestId('filter-camera').selectOption(burstHead.camera);
    await expect(page).toHaveURL(/camera=/);
    await expect(page.getByTestId(`frame-card-${frames[0]!.id}`).or(page.getByTestId(`frame-card-${burstHead.id}`))).toBeVisible();
  });
  test('a deep link opens the viewer on the requested burst member', async ({ page }) => {
    await page.goto(`/detections?since=24h&frame=${burstHead.id}&seq=1`);
    const dialog = page.getByTestId('viewer-dialog');
    await expect(dialog).toBeVisible();
    if (burstHead.burst.length > 0) await expect(dialog.getByTestId('viewer-member-1')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page).not.toHaveURL(/frame=/);
  });
  test('keyboard moves between frames in the viewer', async ({ page }) => {
    await page.goto(`/detections?since=24h&frame=${frames[0]!.id}`);
    await expect(page.getByTestId('viewer-dialog')).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect(page).toHaveURL(new RegExp(`frame=${frames[1]!.id}`));
    await page.keyboard.press('ArrowLeft');
    await expect(page).toHaveURL(new RegExp(`frame=${frames[0]!.id}`));
  });
  test('baseline sets overlay gold labels', async ({ page }) => {
    await page.goto('/detections?set=2026-10-20&model=yolo26s');
    await expect(page.locator('[data-source="baseline"]')).toBeVisible();
    await expect(page.locator('[data-loaded="true"]')).toContainText('baseline frames');
  });
});
