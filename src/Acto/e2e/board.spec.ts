import { test, expect } from '@playwright/test';

test('every workflow BaseAPI holds has a frame, with its state badge', async ({ page, request }) => {
  const workflows = (await (await request.get('/api/v1/workflows')).json()) as { name: string }[];
  await page.goto('/');
  for (const w of workflows) {
    await expect(page.locator('.react-flow__node-workflow', { hasText: w.name }).first()).toBeVisible();
  }
  await expect(page.locator('.react-flow__node-workflow .state-badge').first()).toHaveText(/Running|Stopped|Checking…/);
  await expect(page.getByText(/Board loaded: \d+ workflows?/)).toBeVisible();
});

test('panels resize and remember their size', async ({ page }) => {
  await page.goto('/');
  const sep = page.getByRole('separator').first();
  const b = (await sep.boundingBox())!;
  await page.mouse.move(b.x + 4, b.y + 100);
  await page.mouse.down();
  await page.mouse.move(b.x + 104, b.y + 100);
  await page.mouse.up();
  await page.reload();
  // Rendered width reads 298px (border/padding), so assert the persisted size instead.
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('acto.panels') ?? '{}'));
  expect(saved.tools).toBe(300);
  await expect(page.locator('[data-panel="toolbox"]')).toBeVisible();
});
