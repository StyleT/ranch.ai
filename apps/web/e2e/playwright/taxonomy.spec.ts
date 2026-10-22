import { test, expect } from '@playwright/test';

test.describe('taxonomy', () => {
  test('edit a threshold, validate, score, apply with the token, see the new version, revert', async ({ page }) => {
    await page.goto('/taxonomy');
    await expect(page.locator('[data-dirty]')).toHaveCount(1); // editor hydrated with the draft
    const thr = page.getByTestId('tax-threshold-coco-person');
    await expect(thr).toBeVisible();
    const current = Number(await thr.inputValue()); const next = current >= 0.9 ? '0.5' : (current + 0.1).toFixed(2);
    await thr.fill(next);
    await expect(page.locator('[data-dirty="true"]')).toBeVisible();
    await page.getByTestId('tax-validate').click();
    await expect(page.getByRole('status')).toHaveText('valid');
    await page.getByTestId('tax-score').click();
    const gate = page.getByTestId('gate-table');
    await expect(gate).toBeVisible();
    await expect(gate).toHaveAttribute('data-gate', /pass|fail/);
    await expect(page.getByTestId('gate-row-horse_recall')).toBeVisible();
    // apply without a token: the confirm button stays disabled
    await page.getByTestId('tax-apply').click();
    await page.getByTestId('tax-apply-note').fill(`e2e: person threshold ${next}`);
    await expect(page.getByTestId('tax-apply-confirm')).toBeDisabled();
    await page.getByTestId('tax-token').fill('test-token');
    await page.getByTestId('tax-apply-confirm').click();
    await expect(page.getByRole('status')).toHaveText(/applied as v\d+/);
    const applied = Number((await page.getByRole('status').textContent())!.match(/v(\d+)/)![1]);
    await expect(page.getByTestId(`tax-version-row-${applied}`)).toHaveAttribute('data-state', 'active');
    await expect(page.locator('[data-dirty="true"]')).toHaveCount(0);
    // revert to the previous version
    page.once('dialog', (d) => d.accept('back'));
    await page.getByTestId(`tax-version-row-${applied - 1}`).getByRole('button', { name: 'revert to' }).click();
    await expect(page.getByRole('status')).toHaveText(/reverted as v\d+/);
  });
});
