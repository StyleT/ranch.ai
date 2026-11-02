import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
const frames = JSON.parse(readFileSync('test/fixtures/daemon/frames.json', 'utf8')) as {
  id: number;
  clip: { id: number; labels: string[] } | null;
}[];
const clipHead = frames.find((f) => f.clip)!;

test.describe('clips', () => {
  test('a clip head shows the play badge and the viewer opens on the video, frames one tap away', async ({ page }) => {
    await page.goto(`/detections?since=24h`);
    await expect(page.getByTestId(`clip-badge-${clipHead.id}`)).toBeVisible();
    await expect(page.getByTestId(`clip-labels-${clipHead.id}`)).toContainText('in clip: equine, person');
    const r = await page.request.get(`/api/ui/clip/${clipHead.clip!.id}`, { headers: { range: 'bytes=0-15' } });
    expect(r.status()).toBe(206);
    expect(r.headers()['content-range']).toMatch(/^bytes 0-15\//);
    const other = frames.find((f) => !f.clip)!;
    await expect(page.getByTestId(`frame-card-${other.id}`)).toBeVisible();
    const more = page.getByRole('button', { name: /more/ }); // phones keep the extra filters behind it
    if (await more.isVisible()) {
      await more.click();
    }
    await page.getByTestId('filter-clip').click(); // controlled by the URL: the checked state follows router.replace
    await expect(page).toHaveURL(/clip=1/);
    await expect(page.getByTestId(`frame-card-${other.id}`)).toBeHidden();
    await expect(page.getByTestId(`frame-card-${clipHead.id}`)).toBeVisible();
    await page.goto(`/detections?since=24h&frame=${clipHead.id}`);
    const dialog = page.getByTestId('viewer-dialog');
    await expect(dialog).toBeVisible();
    const video = dialog.getByTestId('viewer-video');
    await expect(video).toBeVisible();
    await expect(video).toHaveAttribute('src', `/api/ui/clip/${clipHead.clip!.id}`);
    await dialog.getByTestId('viewer-frames').click();
    await expect(video).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });
});
