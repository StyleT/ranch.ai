import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
const status = JSON.parse(readFileSync('test/fixtures/daemon/status.json', 'utf8')) as { daemons: { label: string }[]; cameras: { name: string }[] };

test('system shows every daemon with parsed status and the probe table', async ({ page }) => {
  await page.goto('/system');
  for (const d of status.daemons) await expect(page.getByTestId(`daemon-row-${d.label.replace('com.ranch.', '')}`)).toBeVisible();
  await expect(page.getByTestId('daemon-status-ingest')).toContainText('bursts');
  // the table and the phone card list both exist in the DOM; assert on whichever is visible
  const probe = page.getByTestId(`netprobe-row-${status.cameras[0]!.name}`).or(page.getByTestId(`netprobe-row-${status.cameras[0]!.name}-card`)).filter({ visible: true }).first();
  await probe.scrollIntoViewIfNeeded();
  await expect(probe).toBeVisible({ timeout: 20_000 });
});
test('system shows the Wyze bridge metrics moved from :5080', async ({ page }) => {
  await page.goto('/system');
  const summary = page.getByTestId('bridge-summary'); await summary.scrollIntoViewIfNeeded();
  await expect(summary).toContainText('streaming');
  const mops = page.getByTestId('bridge-camera-mops_cam').or(page.getByTestId('bridge-camera-mops_cam-card')).filter({ visible: true }).first();
  await expect(mops).toContainText('error');
  const api = page.getByTestId('bridge-api-row-app-user-refresh-token').or(page.getByTestId('bridge-api-row-app-user-refresh-token-card')).filter({ visible: true }).first();
  await expect(api).toBeVisible();
});
test('evals leaderboard marks prod and opens a result file', async ({ page }) => {
  await page.goto('/evals');
  await expect(page.locator('[data-prod="true"]').filter({ visible: true }).first()).toBeVisible();
  const link = page.getByRole('link', { name: /filter-v1-yolo26\.json/ }).filter({ visible: true }).first();
  if (!(await link.isVisible())) await page.locator('details > summary').filter({ visible: true }).first().click();
  await page.getByRole('link', { name: /filter-v1-yolo26\.json/ }).filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/evals\/.*\.json$/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByText(/horse recall/)).toBeVisible();
});
