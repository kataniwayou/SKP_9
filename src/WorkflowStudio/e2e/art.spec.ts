import type { APIRequestContext, Page } from '@playwright/test';
import { documentPanel, expect, openWorkflow, test, workflowsWithSteps, type LiveWorkflow } from './studio';

// Spec §5.1, slice 3c: the live states against the live BaseApi. Read-only: GETs only.
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

/** One running and one idle workflow (either may be null), by `GET /orchestration/live`. */
async function runningAndIdle(request: APIRequestContext): Promise<{ running: LiveWorkflow | null; idle: LiveWorkflow | null }> {
  const live = await request.get('/api/v1/orchestration/live');
  expect(live.ok()).toBe(true);
  const ids = new Set(((await live.json()) as string[]).map((s) => s.toLowerCase()));
  const all = await workflowsWithSteps(request);
  return {
    running: all.find((w) => ids.has(w.id.toLowerCase())) ?? null,
    idle: all.find((w) => !ids.has(w.id.toLowerCase())) ?? null,
  };
}

async function liveness(request: APIRequestContext): Promise<Map<string, string>> {
  const res = await request.get('/api/v1/processors/liveness');
  expect(res.ok()).toBe(true);
  return new Map(((await res.json()) as { processorId: string; live: boolean }[])
    .map((p) => [p.processorId.toLowerCase(), p.live ? 'healthy' : 'unhealthy']));
}

async function open(page: Page, wf: LiveWorkflow) {
  await openWorkflow(page, wf);
  return documentPanel(page, wf);
}

test('every processor shows the health BaseApi reports for it', async ({ page, request }) => {
  const [wf] = await workflowsWithSteps(request);
  const panel = await open(page, wf!);
  const verdicts = await liveness(request);

  const chips = panel.locator('.react-flow__node-step .chipg');
  expect(await chips.count()).toBeGreaterThan(0);
  for (const chip of await chips.all()) {
    const id = (await chip.getAttribute('data-processor')) ?? '';
    await expect(chip.locator('.nx-health')).toHaveAttribute('data-health', verdicts.get(id.toLowerCase()) ?? 'undetermined');
  }
});

test('a running workflow is started and its intact wires pulse; an idle one is still', async ({ page, request }) => {
  const { running, idle } = await runningAndIdle(request);
  test.skip(!running && !idle, 'BaseApi has no workflow with steps');

  if (running) {
    const panel = await open(page, running);
    await expect(panel.locator('.wf')).toHaveAttribute('data-started', 'true');
    const intact = panel.locator('.react-flow__edge .wire:not(.broken)');
    await expect.poll(() => panel.locator('.nx-pulse').count()).toBe(await intact.count());
    expect(await intact.count()).toBeGreaterThan(0);
  }
  if (idle) {
    const panel = await open(page, idle);
    await expect(panel.locator('.wf')).toHaveAttribute('data-started', 'false');
    await expect(panel.locator('.wf')).toHaveClass(/nx-idlewf/);
    await expect(panel.locator('.nx-pulse')).toHaveCount(0);
  }
});

test('with reduced motion nothing spins, blinks or pulses', async ({ page, request }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { running, idle } = await runningAndIdle(request);
  const wf = running ?? idle;
  test.skip(!wf, 'BaseApi has no workflow with steps');
  const panel = await open(page, wf!);

  const animation = (selector: string) => panel.locator(selector).first().evaluate((e) => getComputedStyle(e).animationName);
  await expect.poll(() => animation('.chipg .nx-spin')).toBe('none');
  await expect.poll(() => animation('.wf .hub-inner')).toBe('none');
  for (const pulse of await panel.locator('.nx-pulse').all()) {
    expect(await pulse.evaluate((e) => getComputedStyle(e).display)).toBe('none');
  }
  for (const wait of await panel.locator('.nx-wait').all()) {
    expect(await wait.evaluate((e) => getComputedStyle(e).animationName)).toBe('none');
  }
});

test('a selected step, die and cache draw the cyan selection stroke', async ({ page, request }) => {
  const [wf] = await workflowsWithSteps(request);
  const panel = await open(page, wf!);
  const cyan = 'rgb(125, 211, 252)';
  const stroke = (selector: string) => panel.locator(selector).first().evaluate((e) => getComputedStyle(e).stroke);

  await panel.locator('.react-flow__node-step').first().click({ position: { x: 20, y: 12 } });
  await expect.poll(() => stroke('.studio-sel .nx-frame')).toBe(cyan);

  await panel.locator('.react-flow__node-step .chipg').first().click();
  await expect.poll(() => stroke('.studio-die-sel .nx-panel')).toBe(cyan);

  const cache = panel.locator('.react-flow__node-cache');
  test.skip((await cache.count()) === 0, 'the first live workflow has no cache');
  await cache.first().click();
  await expect.poll(() => stroke('.studio-sel .nx-brk')).toBe(cyan);
});
