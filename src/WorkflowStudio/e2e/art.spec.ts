import type { APIRequestContext, Page } from '@playwright/test';
import { documentPanel, expect, openWorkflow, test, workflowsWithSteps, type LiveWorkflow } from './studio';

// Spec §5.1, slice 3c: the live states against the live BaseApi. Read-only: GETs only.
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
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

/** The first workflow with steps whose graph has a cache, or null. Read-only. */
async function workflowWithCache(request: APIRequestContext): Promise<LiveWorkflow | null> {
  for (const w of await workflowsWithSteps(request)) {
    const graph = await request.get(`/api/v1/workflows/${w.id}/graph`);
    if (graph.ok() && ((await graph.json()) as { caches?: unknown[] }).caches?.length) return w;
  }
  return null;
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
  test.skip(!wf, 'BaseApi has no workflow with steps');
  const panel = await open(page, wf!);
  const verdicts = await liveness(request);

  const chips = panel.locator('.react-flow__node-step .chipg');
  expect(await chips.count()).toBeGreaterThan(0);
  for (const chip of await chips.all()) {
    const id = (await chip.getAttribute('data-processor')) ?? '';
    await expect(chip.locator('.nx-health')).toHaveAttribute('data-health', verdicts.get(id.toLowerCase()) ?? 'undetermined');
  }
});

test('a running workflow is started and its intact wires pulse', async ({ page, request }) => {
  const { running } = await runningAndIdle(request);
  test.skip(!running, 'no running workflow in BaseApi');
  const panel = await open(page, running!);

  await expect(panel.locator('.wf')).toHaveAttribute('data-started', 'true');
  const intact = panel.locator('.react-flow__edge .wire:not(.dashed)');
  await expect.poll(() => intact.count()).toBeGreaterThan(0);
  for (const wire of await intact.all()) {
    await expect(wire.locator('.nx-pulse')).toHaveCount(1);
  }
  await expect(panel.locator('.react-flow__edge .wire.dashed .nx-pulse')).toHaveCount(0);
});

test('an idle workflow is still', async ({ page, request }) => {
  const { idle } = await runningAndIdle(request);
  test.skip(!idle, 'no idle workflow with steps in BaseApi');
  const panel = await open(page, idle!);

  await expect(panel.locator('.wf')).toHaveAttribute('data-started', 'false');
  await expect(panel.locator('.wf')).toHaveClass(/nx-idlewf/);
  await expect(panel.locator('.nx-pulse')).toHaveCount(0);
});

const animation = (el: import('@playwright/test').Locator) => el.evaluate((e) => getComputedStyle(e).animationName);

test('with reduced motion a started workflow, nothing spins or pulses', async ({ page, request }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { running } = await runningAndIdle(request);
  test.skip(!running, 'no running workflow in BaseApi');
  const panel = await open(page, running!);

  await expect.poll(() => panel.locator('.nx-pulse').count()).toBeGreaterThan(0);
  for (const pulse of await panel.locator('.nx-pulse').all()) {
    expect(await pulse.evaluate((e) => getComputedStyle(e).display)).toBe('none');
  }
  for (const selector of ['.chipg .nx-spin', '.wf .nx-spin']) {
    await expect.poll(() => panel.locator(selector).count()).toBeGreaterThan(0);
    for (const spin of await panel.locator(selector).all()) expect(await animation(spin)).toBe('none');
  }
  const waits = panel.locator('.nx-health.nx-wait');
  if ((await waits.count()) === 0) {
    test.info().annotations.push({ type: 'note', description: 'no undetermined processor in the live data; processor blink not checked' });
  } else {
    for (const wait of await waits.all()) expect(await animation(wait)).toBe('none');
  }
});

test('with reduced motion an idle hub does not blink', async ({ page, request }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { idle } = await runningAndIdle(request);
  test.skip(!idle, 'no idle workflow with steps in BaseApi');
  const panel = await open(page, idle!);

  const hubInner = panel.locator('.wf.nx-idlewf .hub-inner');
  await expect(hubInner).toHaveCount(1);
  await expect.poll(() => animation(hubInner)).toBe('none');
});

test('a selected step and die draw the cyan selection stroke', async ({ page, request }) => {
  const [wf] = await workflowsWithSteps(request);
  test.skip(!wf, 'BaseApi has no workflow with steps');
  const panel = await open(page, wf!);
  const cyan = 'rgb(125, 211, 252)';
  const stroke = (selector: string) => panel.locator(selector).first().evaluate((e) => getComputedStyle(e).stroke);

  await expect.poll(() => stroke('.react-flow__node-step .nx-frame')).not.toBe(cyan);
  await panel.locator('.react-flow__node-step').first().click({ position: { x: 20, y: 12 } });
  await expect.poll(() => stroke('.studio-sel .nx-frame')).toBe(cyan);

  await expect.poll(() => stroke('.react-flow__node-step .nx-panel')).not.toBe(cyan);
  await panel.locator('.react-flow__node-step .chipg').first().click();
  await expect.poll(() => stroke('.studio-die-sel .nx-panel')).toBe(cyan);
});

test('a selected cache draws the cyan selection stroke', async ({ page, request }) => {
  const wf = await workflowWithCache(request);
  test.skip(!wf, 'no workflow with a cache in BaseApi');
  const panel = await open(page, wf!);
  const cyan = 'rgb(125, 211, 252)';
  const stroke = (selector: string) => panel.locator(selector).first().evaluate((e) => getComputedStyle(e).stroke);

  await expect.poll(() => stroke('.react-flow__node-cache .nx-brk')).not.toBe(cyan);
  await panel.locator('.react-flow__node-cache').first().click();
  await expect.poll(() => stroke('.studio-sel .nx-brk')).toBe(cyan);
});

test('a selected hub keeps its selection glow while hovered', async ({ page, request }) => {
  const [wf] = await workflowsWithSteps(request);
  test.skip(!wf, 'BaseApi has no workflow with steps');
  const panel = await open(page, wf!);
  const hub = panel.locator('.react-flow__node-workflow');
  const filter = () => panel.locator('.react-flow__node-workflow .wf .sphere').evaluate((e) => getComputedStyle(e).filter);

  await hub.hover();
  await expect.poll(filter).toContain('brightness'); // the hover baseline: an unselected hub only brightens
  await hub.click();
  await expect(panel.locator('.react-flow__node-workflow.studio-sel')).toHaveCount(1);
  await hub.hover();
  await expect.poll(filter).toMatch(/url\(.*#glow/);
});
