import { test, expect, type Page } from '@playwright/test';
import { dragOnto, findEmptySpot } from './helpers';

// Writes only to throwaway workflows it creates. It never presses Start or Stop (a real processor could run).
// Every created id is recorded as soon as it is known; afterAll deletes those still present.
const created: string[] = [];

test.afterAll(async ({ request }) => {
  const list = await request.get('/api/v1/workflows');
  const present = new Set<string>(list.ok() ? ((await list.json()) as { id: string }[]).map((w) => w.id) : created);
  for (const id of created) {
    if (!present.has(id)) continue;
    const r = await request.post(`/api/v1/workflows/${id}/delete`);
    expect(r.ok(), `deleting the throwaway workflow ${id}`).toBe(true);
  }
});

/** Drops a workflow frame on an empty spot and a step into it; returns the frame locator and its id. */
async function createWorkflow(page: Page) {
  const before = await page.locator('.react-flow__node-workflow').count();
  const spot = await findEmptySpot(page);
  expect(spot, 'an empty spot on the board').not.toBeNull();
  await dragOnto(page, page.getByRole('button', { name: /Workflow\s*drop on empty board/ }), spot!.x, spot!.y);
  await expect(page.locator('.react-flow__node-workflow')).toHaveCount(before + 1);
  const probe = page.locator('.react-flow__node-workflow').filter({ has: page.locator('.unsaved-tag') }).filter({ hasText: /new-workflow-\d+/ });
  const id = (await probe.last().getAttribute('data-id'))!.replace(/^wf:/, '');
  const frame = page.locator(`.react-flow__node-workflow[data-id="wf:${id}"]`);
  const fb = (await frame.boundingBox())!;
  await dragOnto(page, page.getByTestId('toolbox-step').first(), fb.x + fb.width / 2, fb.y + fb.height * 0.6);
  await expect(page.locator(`.react-flow__node-step[data-id*=":${id}:"]`)).toHaveCount(1);
  return { frame, id };
}

test('operate the board: save two, copy and paste a step, delete both', async ({ page, request }) => {
  const live = (await (await request.get('/api/v1/orchestration/live')).json()) as string[];
  const existing = (await (await request.get('/api/v1/workflows')).json()) as { id: string; name: string }[];
  const stopped = existing.find((w) => !live.includes(w.id));

  await page.goto('/');
  await expect(page.getByText(/Board loaded: \d+ workflows?/)).toBeVisible();
  await expect(page.getByTestId('toolbox-step').first()).toBeVisible();
  await expect(page.locator('.react-flow__node-workflow').first()).toBeVisible();
  await page.waitForTimeout(500);

  // pan left so the right side of the board is free
  const pb = (await page.locator('.react-flow__pane').boundingBox())!;
  const grab = { x: pb.x + pb.width - 20, y: pb.y + 30 };
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x - 400, grab.y, { steps: 10 });
  await page.mouse.up();

  const a = await createWorkflow(page);
  created.push(a.id);
  const b = await createWorkflow(page);
  created.push(b.id);
  expect(a.id).not.toBe(b.id);

  // Ctrl+click both frame headers, Save 2 from the bar
  await a.frame.locator('.fh').click();
  await page.keyboard.down('Control');
  await b.frame.locator('.fh').click();
  await page.keyboard.up('Control');
  await expect(page.locator('.selbar-pill', { hasText: '2 SELECTED' })).toBeVisible();
  await page.getByRole('button', { name: 'Save 2', exact: true }).click();
  await expect(a.frame.locator('.unsaved-tag')).toHaveCount(0);
  await expect(b.frame.locator('.unsaved-tag')).toHaveCount(0);
  const saved = (await (await request.get('/api/v1/workflows')).json()) as { id: string }[];
  expect(saved.map((w) => w.id)).toEqual(expect.arrayContaining([a.id, b.id]));

  // pick the step of A, Copy, pick B's frame, Ctrl+V
  const wheel = async (dy: number, n: number) => {
    const c = (await a.frame.boundingBox())!;
    await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2);
    for (let i = 0; i < n; i++) { await page.mouse.wheel(0, dy); await page.waitForTimeout(80); }
    await page.waitForTimeout(300);
  };
  const widthBefore = (await a.frame.boundingBox())!.width;
  let zooms = 0;
  while (zooms < 20 && (await a.frame.locator('.far-body').count()) > 0) { await wheel(-300, 1); zooms++; }
  await wheel(-300, 2); zooms += 2;
  const stepA = page.locator(`.react-flow__node-step[data-id*=":${a.id}:"]`);
  await stepA.click();
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  await wheel(300, zooms);
  expect(Math.abs((await a.frame.boundingBox())!.width - widthBefore)).toBeLessThan(widthBefore * 0.2);
  await b.frame.locator('.fh').click();
  await page.keyboard.press('Control+v');
  await expect(page.locator(`.react-flow__node-step[data-id*=":${b.id}:"]`)).toHaveCount(2);
  await expect(b.frame.locator('.unsaved-tag')).toBeVisible();

  // Ctrl+click both frames: 2 SELECTED, Delete asks, confirm removes both
  await a.frame.locator('.fh').click();
  await page.keyboard.down('Control');
  await b.frame.locator('.fh').click();
  await page.keyboard.up('Control');
  await expect(page.locator('.selbar-pill', { hasText: '2 SELECTED' })).toBeVisible();
  const bar = page.getByRole('toolbar', { name: 'selection actions' });
  await bar.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(bar.getByText(/Delete 2 workflows\?/)).toBeVisible();
  await bar.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.locator(`[data-id="wf:${a.id}"]`)).toHaveCount(0);
  await expect(page.locator(`[data-id="wf:${b.id}"]`)).toHaveCount(0);
  await expect.poll(async () => {
    const ids = ((await (await request.get('/api/v1/workflows')).json()) as { id: string }[]).map((w) => w.id);
    return ids.includes(a.id) || ids.includes(b.id);
  }).toBe(false);

  // an existing stopped workflow shows ▶ Start in its toolbar (never pressed)
  if (!stopped) {
    test.info().annotations.push({ type: 'skipped', description: 'no stopped workflow exists; the Start toolbar assertion was skipped' });
    return;
  }
  const target = page.locator(`.react-flow__node-workflow[data-id="wf:${stopped.id}"]`);
  await expect(target).toBeVisible();
  await target.locator('.fh').click();
  await expect(page.getByRole('button', { name: '▶ Start', exact: true })).toBeVisible();
});
