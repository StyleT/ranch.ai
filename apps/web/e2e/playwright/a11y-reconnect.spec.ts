import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

for (const path of ['/', '/detections?since=24h', '/taxonomy', '/system', '/evals']) {
  test(`axe: no serious or critical violations on ${path}`, async ({ page }) => {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    const results = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();
    const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([]);
  });
}

test('after 45 s of silence the client reopens the live stream', async ({ page, context }) => {
  // every live connection is routed to the stalled scenario (one status, then silence); the watchdog must reconnect
  let opens = 0;
  await context.route('**/api/ui/live', (route) => { opens++; return route.continue({ url: route.request().url().replace('/api/ui/live', '/api/ui/live?scenario=sse-stall') }); });
  await page.clock.install();
  await page.goto('/');
  await expect(page.getByTestId('connection-badge')).toHaveAttribute('data-connection', 'live');
  expect(opens).toBe(1);
  await page.clock.runFor(50_000);
  await expect.poll(() => opens, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
});
