import type { Locator, Page } from '@playwright/test';
import { box, documentPanel, emptySpot, get, labelsOf, node, openWorkflow, pane, save, type Pt } from './studio';
import { created, createThrowaway, expect, removeThrowaway, test, type Throwaway } from './throwaway';

// The Toolbox (the user's rules, 2026-10-11), with the real mouse: its tiles dragged onto a workflow's canvas. New or empty
// items are new virtual entities (as a paste makes); an existing processor or cache is the same entity, never a copy.
// Only this run's throwaway is written (`e2e-8-…`, and a new workflow named after its tag).
test.describe.configure({ mode: 'serial', retries: 0 });
let t: Throwaway;
const extra: { steps: string[]; caches: string[] } = { steps: [], caches: [] };
test.beforeAll(async ({ request }) => { t = await createThrowaway(request); });
test.afterAll(async ({ request }) => {
  // what the Saves made that the throwaway's cleanup does not know by name: the new step first (it points at the
  // throwaway's processor), the new cache after the workflows that list it
  for (const id of extra.steps) await request.delete(`/api/v1/steps/${id}`);
  try { await removeThrowaway(request); } finally {
    for (const id of extra.caches) await request.delete(`/api/v1/caches/${id}`);
  }
});
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
});

const SHOTS = process.env.TOOLBOX_SHOTS;
const toolbox = (page: Page) => page.locator('[data-pane="toolbox"]');
const tileOf = (page: Page, tool: string, id?: string) => toolbox(page).locator(`.tb-tile[data-tool="${tool}"]${id ? `[data-id="${id}"]` : ''}`);
const centre = async (l: Locator): Promise<Pt> => { const b = await box(l); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };

/** Presses a tile and moves the real mouse to `to` in steps; `release` lets go there (else the drag is left held). */
async function drag(page: Page, tile: Locator, to: Pt, release = true): Promise<void> {
  await tile.scrollIntoViewIfNeeded();
  const from = await centre(tile);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 20, from.y + 5, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 12 });
  if (release) await page.mouse.up();
}

const newSteps = (panel: Locator, before: Set<string>) => panel.locator('.react-flow__node-step').evaluateAll(
  (els, known) => els.map((e) => e.getAttribute('data-id')!).filter((id) => !known.includes(id)), [...before],
);

test('Toolbox: an empty step, the throwaway\'s processor onto it, a wire, an empty cache; refusals; Undo; Save creates them with the same processor', async ({ page, request }) => {
  await openWorkflow(page, t.workflow);
  const panel = documentPanel(page, t.workflow);
  await expect(toolbox(page)).toBeVisible();
  // the lists: narrowed to this run's entities
  await toolbox(page).getByRole('searchbox', { name: 'Search the toolbox' }).fill(t.tag);
  const proc = tileOf(page, 'processor', t.processorId);
  await expect(proc).toBeVisible();
  await expect(proc.locator('[data-health]')).toHaveCount(1);
  await expect(proc.locator('.nx-spinner')).toHaveCount(1);
  await expect(tileOf(page, 'cache', t.cacheId)).toBeVisible();
  await expect(tileOf(page, 'step')).toBeVisible();
  await expect(tileOf(page, 'wire')).toBeVisible();
  await expect(tileOf(page, 'newCache')).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/toolbox.png` });

  // an empty step dropped on empty canvas: a new step with the amber empty slot
  const known = new Set(await panel.locator('.react-flow__node-step').evaluateAll((els) => els.map((e) => e.getAttribute('data-id')!)));
  const spot = await emptySpot(panel);
  await drag(page, tileOf(page, 'step'), spot, false);
  // held over the canvas: the landing box is drawn; nothing committed yet
  await expect(panel.locator('.design-tool-landing')).toHaveCount(1);
  await expect(page.locator('.tb-ghost')).toHaveCount(1);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/toolbox-drag.png` });
  await page.mouse.up();
  await expect(panel.locator('.design-tool-landing')).toHaveCount(0);
  await expect.poll(() => newSteps(panel, known)).toHaveLength(1);
  const stepId = (await newSteps(panel, known))[0]!;
  const made = node(panel, stepId);
  await expect(made.locator('.chip-empty')).toHaveCount(1);
  await expect(page.getByText('● design draft')).toBeVisible();

  // the processor dragged off every step: "drop on a step", red; let go there, nothing changes
  const elsewhere = await emptySpot(panel, [spot]);
  await drag(page, proc, elsewhere, false);
  await expect.poll(() => labelsOf(panel)).toEqual(['drop on a step']);
  await expect(panel.locator('.design-drop-label.no')).toHaveCount(1);
  await page.mouse.up();
  await expect(made.locator('.chip-empty')).toHaveCount(1);

  // onto the new step: "assign processor", the step lit; let go: its slot shows the throwaway's processor
  await drag(page, proc, await centre(made), false);
  await expect.poll(() => labelsOf(panel)).toEqual(['assign processor']);
  await expect(made).toHaveClass(/drop-ok/);
  await page.mouse.up();
  await expect(made.locator('.chip-empty')).toHaveCount(0);
  await expect(made.locator(`.chipg[data-processor="${t.processorId}"]`)).toHaveCount(1);

  // a wire: a new free wire, grey, open at both ends
  const wires = panel.locator('.react-flow__edge[data-id^="w:"]');
  const wiresBefore = await wires.count();
  await drag(page, tileOf(page, 'wire'), await emptySpot(panel, [spot, elsewhere]));
  await expect(wires).toHaveCount(wiresBefore + 1);
  const wire = wires.last().locator('g.wire');
  await expect(wire).toHaveClass(/dashed/);
  await expect(wire.locator('.nx-head, .nx-src')).toHaveCount(0);

  // the throwaway's own cache again: refused, "already in this workflow"
  await drag(page, tileOf(page, 'cache', t.cacheId), await emptySpot(panel, [spot, elsewhere]), false);
  await expect.poll(() => labelsOf(panel)).toEqual(['already in this workflow']);
  await page.mouse.up();

  // an empty cache: a new cache; Ctrl+Z takes it back, Ctrl+Y brings it again
  const caches = panel.locator('.react-flow__node-cache');
  const cachesBefore = await caches.count();
  await drag(page, tileOf(page, 'newCache'), await emptySpot(panel, [spot, elsewhere]));
  await expect(caches).toHaveCount(cachesBefore + 1);
  await panel.locator('.studio-canvas').focus();
  await page.keyboard.press('Control+z');
  await expect(caches).toHaveCount(cachesBefore);
  await page.keyboard.press('Control+y');
  await expect(caches).toHaveCount(cachesBefore + 1);
  // named after this run, so its cleanup finds it whatever happens
  const newCacheId = (await caches.evaluateAll((els, k) => els.map((e) => e.getAttribute('data-id')!).find((id) => id !== `cache:${k}`), t.cacheId))!.slice('cache:'.length);
  extra.caches.push(newCacheId);
  extra.steps.push(stepId);

  // Save: the new step with the same processor (no new processor), the new cache, linked to the workflow
  const procsBefore = (await get<{ id: string }[]>(request, 'processors')).length;
  await save(page);
  await expect(await pane(page, 'Output')).toContainText('Saved and applied');
  const step = await get<{ processorId: string }>(request, `steps/${stepId}`);
  expect(step.processorId).toBe(t.processorId);
  const cache = await get<{ root: string; items: string }>(request, `caches/${newCacheId}`);
  expect(cache.root).toMatch(/^cache(-\d+)?$/);
  expect(JSON.parse(cache.items)).toEqual({});
  expect((await get<{ cacheIds: string[] }>(request, `workflows/${t.workflow.id}`)).cacheIds).toEqual(expect.arrayContaining([t.cacheId, newCacheId]));
  expect((await get<{ id: string }[]>(request, 'processors')).length).toBe(procsBefore);
});

test('Toolbox: an existing cache dropped into a new workflow is the same entity, linked; Save adds no cache row', async ({ page, request }) => {
  await page.getByRole('menuitem', { name: 'Workspace' }).click();
  await page.getByRole('menuitem', { name: /^\W*New\b/ }).click();
  const panel = page.locator('.docpanel').filter({ has: page.locator('.crumb[data-tip^="untitled"]') });
  await expect(panel.locator('.react-flow__node-workflow')).toBeVisible();
  // named after this run (the write guard lets its Save through, and cleanup deletes it)
  await panel.locator('.react-flow__node-workflow').click();
  const name = page.locator('[data-pane="inspector"]').getByLabel('Name', { exact: true });
  await name.click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type(`${t.tag}-tb`);
  await toolbox(page).getByRole('searchbox', { name: 'Search the toolbox' }).fill(t.tag);
  const cachesBefore = (await get<{ id: string }[]>(request, 'caches')).length;
  await drag(page, tileOf(page, 'cache', t.cacheId), await emptySpot(panel));
  await expect(panel.locator(`.react-flow__node[data-id="cache:${t.cacheId}"]`)).toBeVisible();
  // a second drop of it: refused
  await drag(page, tileOf(page, 'cache', t.cacheId), await emptySpot(panel), false);
  await expect.poll(() => labelsOf(panel)).toEqual(['already in this workflow']);
  await page.mouse.up();
  await expect(panel.locator(`.react-flow__node[data-id="cache:${t.cacheId}"]`)).toHaveCount(1);

  await save(page);
  await expect(await pane(page, 'Output')).toContainText('Saved and applied');
  const id = created.newWorkflowIds?.at(-1);
  expect(id).toBeTruthy();
  expect((await get<{ cacheIds: string[] }>(request, `workflows/${id}`)).cacheIds).toEqual([t.cacheId]);
  expect((await get<{ id: string }[]>(request, 'caches')).length).toBe(cachesBefore);
});
