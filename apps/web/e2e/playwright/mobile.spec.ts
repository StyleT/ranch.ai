import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
const frames = JSON.parse(readFileSync('test/fixtures/daemon/frames.json', 'utf8')) as { id: number }[];

test.describe('phone gestures', () => {
  test.skip(({ isMobile }) => !isMobile, 'touch only');
  test('swipe left advances to the next frame', async ({ page }) => {
    await page.goto(`/detections?since=24h&frame=${frames[0]!.id}`);
    const dialog = page.getByTestId('viewer-dialog');
    await expect(dialog).toBeVisible();
    const box = (await dialog.boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    const y = box.y + box.height / 2; const x0 = box.x + box.width * 0.8, x1 = box.x + box.width * 0.2;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y }] });
    for (let i = 1; i <= 5; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + (x1 - x0) * (i / 5), y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(page).toHaveURL(new RegExp(`frame=${frames[1]!.id}`));
  });
  test('the bottom tab bar navigates', async ({ page }) => {
    await page.goto('/');
    // the bottom bar exists under 768 px; the rail/sidebar above it
    const vw = page.viewportSize()?.width ?? 0;
    await page.getByTestId(vw < 768 ? 'nav-tab-system-mobile' : 'nav-tab-system').click();
    await expect(page).toHaveURL(/\/system$/);
    await expect(page.getByRole('heading', { level: 1, name: 'System' })).toBeVisible();
  });
});
