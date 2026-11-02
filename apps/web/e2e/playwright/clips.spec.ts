import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
const clips = JSON.parse(readFileSync('test/fixtures/daemon/clips.json', 'utf8')) as { id: number; camera: string }[];
const frames = JSON.parse(readFileSync('test/fixtures/daemon/frames.json', 'utf8')) as {
  id: number;
  clip: { id: number } | null;
}[];
const clipHead = frames.find((f) => f.clip)!;

test.describe('clips', () => {
  test('/clips lists every clip with a playable video that the server serves by byte range', async ({ page }) => {
    await page.goto('/clips');
    await expect(page.locator('[data-loaded="true"]')).toBeVisible();
    for (const c of clips) {
      await expect(page.getByTestId(`clip-card-${c.id}`)).toBeVisible();
    }
    const r = await page.request.get(`/api/ui/clip/${clips[0]!.id}`, { headers: { range: 'bytes=0-15' } });
    expect(r.status()).toBe(206);
    expect(r.headers()['content-range']).toMatch(/^bytes 0-15\//);
    await page.getByTestId('filter-camera').selectOption(clips[1]!.camera);
    await expect(page).toHaveURL(/camera=/);
    await expect(page.getByTestId(`clip-card-${clips[1]!.id}`)).toBeVisible();
  });
  test('a clip head shows the play badge and the viewer opens on the video, frames one tap away', async ({ page }) => {
    await page.goto(`/detections?since=24h`);
    await expect(page.getByTestId(`clip-badge-${clipHead.id}`)).toBeVisible();
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
