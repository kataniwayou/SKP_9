import { test, expect } from '@playwright/test';

test('every workflow BaseAPI holds has a frame, with its state badge', async ({ page, request }) => {
  const workflows = (await (await request.get('/api/v1/workflows')).json()) as { name: string }[];
  expect(workflows.length).toBeGreaterThan(0);
  const unplaced: string[] = [];
  page.on('console', (m) => { if (m.text().includes("Couldn't create edge")) unplaced.push(m.text()); });
  await page.goto('/');
  for (const w of workflows) {
    await expect(page.locator('.react-flow__node-workflow', { hasText: w.name }).first()).toBeVisible();
  }
  await expect(page.locator('.react-flow__node-workflow .state-badge').first()).toHaveText(/Running|Stopped|Checking…/);
  await expect(page.getByText(/Board loaded: \d+ workflows?/)).toBeVisible();
  expect(unplaced, 'React Flow could place every wire').toEqual([]);
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
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('acto.panels') ?? '{}'));
  expect(saved.tools).toBe(300);
  const toolbox = page.locator('[data-panel="toolbox"]');
  await expect(toolbox).toBeVisible();
  expect((await toolbox.boundingBox())!.width).toBe(300);
});

test('every step card sits inside its frame, below the header', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText(/Board loaded: \d+ workflows?/)).toBeVisible();
  await expect(page.locator('.react-flow__node-step').first()).toBeAttached();
  const bad = await page.evaluate(() => {
    const zoom = Number(/scale\(([\d.]+)\)/.exec((document.querySelector('.react-flow__viewport') as HTMLElement).style.transform)?.[1] ?? 1);
    const out: string[] = [];
    for (const n of document.querySelectorAll<HTMLElement>('.react-flow__node-step')) {
      const [, wf] = (n.dataset.id ?? '').split(':');
      const f = document.querySelector<HTMLElement>(`.react-flow__node-workflow[data-id="wf:${wf}"]`);
      if (!f) { out.push(`${n.dataset.id}: no frame`); continue; }
      const s = n.getBoundingClientRect();
      const r = f.getBoundingClientRect();
      const tol = 1;
      if (s.left < r.left - tol || s.right > r.right + tol || s.bottom > r.bottom + tol || s.top < r.top + 46 * zoom - tol) out.push(n.dataset.id!);
    }
    return out;
  });
  expect(bad).toEqual([]);
});
