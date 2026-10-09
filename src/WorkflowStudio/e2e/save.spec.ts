import type { Locator, Page } from '@playwright/test';
import { centreOf, documentPanel, dropOpen, get, inspector, newWires, node, openWorkflow, pane, problems, pointOnWire, save } from './studio';
import { createThrowaway, expect, removeThrowaway, test, type Throwaway } from './throwaway';

// Plan 8 §8: Save is the studio's only write, and these tests write only to their own throwaway workflow
// (e2e/throwaway.ts, `e2e-8-…`), created here through BaseApi's CRUD and deleted afterwards. They build on
// each other's state, so they run in order, never retried.
test.describe.configure({ mode: 'serial', retries: 0 });
let t: Throwaway;
test.beforeAll(async ({ request }) => { t = await createThrowaway(request); });
test.afterAll(async ({ request }) => { await removeThrowaway(request); });
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
});

const field = (page: Page, label: string): Locator => inspector(page).getByLabel(label, { exact: true });
const pill = (page: Page): Locator => inspector(page).locator('.kindpill');

/** Replaces a field's text with the real keyboard: click, select all, type. */
async function typeInto(page: Page, label: string, text: string): Promise<void> {
  await field(page, label).click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type(text);
}

async function selectStep(page: Page, panel: Locator, id: string): Promise<void> {
  await node(panel, id).click({ position: { x: 20, y: 12 } });
  await expect(pill(page)).toHaveText('STEP');
}

test('an invalid design is stored but not applied: Output pins the error and says why, BaseApi is unchanged, a fresh page shows the stored design', async ({ page, request, context }) => {
  await openWorkflow(page, t.workflow);
  const panel = documentPanel(page, t.workflow);

  // on the canvas: a new wire from B's port, released on empty canvas, is a grey wire open at its head (plan 9)
  const b = node(panel, t.stepBId);
  await b.hover();
  const port = await centreOf(b.locator('.nx-port'));
  const area = (await panel.locator('.studio-canvas').boundingBox())!;
  const empty = { x: area.x + area.width - 80, y: area.y + area.height - 120 };
  await page.mouse.move(port.x, port.y);
  await page.mouse.down();
  await page.mouse.move(empty.x, empty.y, { steps: 12 });
  await expect(panel.locator('.design-drop-label')).toHaveText('move here');
  await page.mouse.up();
  await expect(newWires(panel)).toHaveCount(1);

  // in the Inspector: step A gets a description and a version BaseApi refuses
  await selectStep(page, panel, t.stepId);
  await typeInto(page, 'Description', 'designed');
  await typeInto(page, 'Version', 'abc');
  await expect(page.getByText('● design draft')).toBeVisible();
  await save(page);

  const pinned = await problems(page);
  await expect(pinned.getByRole('listitem')).toHaveCount(1);
  await expect(pinned.getByRole('listitem').first()).toContainText('version');
  await expect(await pane(page, 'Output')).toContainText('Saved; not applied: 1 error');
  // the real step is unchanged, and the design is stored on the workflow
  const step = await get<{ version: string; description: string | null }>(request, `steps/${t.stepId}`);
  expect([step.version, step.description]).toEqual(['1.0.0', null]);
  expect((await get<{ design: unknown }>(request, `workflows/${t.workflow.id}/graph`)).design).not.toBeNull();

  // a fresh page, with no session, shows the stored design and no errors
  const fresh = await context.newPage();
  await fresh.goto('/');
  await fresh.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await fresh.reload();
  await openWorkflow(fresh, t.workflow);
  const again = documentPanel(fresh, t.workflow);
  await expect(newWires(again)).toHaveCount(1);
  await selectStep(fresh, again, t.stepId);
  await expect(field(fresh, 'Version')).toHaveValue('abc');
  await expect(field(fresh, 'Description')).toHaveValue('designed');
  await expect((await problems(fresh)).getByRole('listitem')).toHaveCount(0);
  await fresh.close();
});

test('fixed and saved again, the design is applied: BaseApi holds it, the stored design is emptied, the new wire stays in the layout', async ({ page, request }) => {
  await openWorkflow(page, t.workflow);
  const panel = documentPanel(page, t.workflow);
  await selectStep(page, panel, t.stepId);
  await expect(field(page, 'Version')).toHaveValue('abc');
  await typeInto(page, 'Version', '1.0.1');
  await save(page);

  await expect(await pane(page, 'Output')).toContainText('Saved and applied');
  await expect((await problems(page)).getByRole('listitem')).toHaveCount(0);
  const step = await get<{ version: string; description: string | null }>(request, `steps/${t.stepId}`);
  expect([step.version, step.description]).toEqual(['1.0.1', 'designed']);
  expect((await get<{ design: unknown }>(request, `workflows/${t.workflow.id}/graph`)).design).toBeNull();

  await page.reload();
  const again = documentPanel(page, t.workflow);
  await expect(newWires(again)).toHaveCount(1);
  await expect(page.getByText('● design draft')).toHaveCount(0);
});

test('one Save applies changes of every kind: a deleted wire, a removed assignment, a schema copy with its name and version', async ({ page, request }) => {
  await openWorkflow(page, t.workflow);
  const panel = documentPanel(page, t.workflow);
  const wireId = `${t.stepId}->${t.stepBId}`;

  // the canvas: pick A -> B and delete it; B stays on the canvas and looks like any step
  const p = await pointOnWire(panel, wireId);
  await page.mouse.click(p.x, p.y);
  await page.keyboard.press('Delete');
  await expect(panel.locator(`.react-flow__edge[data-id="${wireId}"]`)).toHaveCount(0);
  await expect(node(panel, t.stepBId)).toBeVisible();
  await expect(node(panel, t.stepBId).locator('.blk.parked')).toHaveCount(0);

  // the Inspector: A's assignment removed; its processor's Config schema edited (a background copy)
  await selectStep(page, panel, t.stepId);
  await inspector(page).getByRole('button', { name: '✕ Remove' }).click();
  await expect(inspector(page).getByRole('button', { name: '＋ Create' })).toBeVisible();
  await node(panel, t.stepId).locator('.chipg').click();
  await expect(pill(page)).toHaveText('PROCESSOR');
  await inspector(page).locator('.slot').filter({ hasText: 'Config' }).getByRole('button').first().click();
  await expect(pill(page)).toHaveText('SCHEMA');
  await typeInto(page, 'Definition', '{"type":"string"}');
  await save(page);
  await expect(await pane(page, 'Output')).toContainText('Saved and applied');

  expect((await get<{ nextStepIds: string[] }>(request, `steps/${t.stepId}`)).nextStepIds).toEqual([]);
  expect((await request.get(`/api/v1/assignments/${t.assignmentId}`)).status()).toBe(404);
  const proc = await get<{ configSchemaId: string }>(request, `processors/${t.processorId}`);
  expect(proc.configSchemaId).not.toBe(t.schemaId);
  const copy = await get<{ name: string; version: string; definition: string }>(request, `schemas/${proc.configSchemaId}`);
  expect([copy.name, copy.version]).toEqual([`${t.tag}-config`, '1.0.0']);
  expect(JSON.parse(copy.definition)).toEqual({ type: 'string' });
});

test('an entry wire whose tail was dragged off the hub is never sent as an entry: Save sends an empty entry list, and the layout keeps the wire open at its tail', async ({ page }) => {
  await openWorkflow(page, t.workflow);
  const panel = documentPanel(page, t.workflow);
  const wireId = `wf->${t.stepId}`;
  // an empty spot whose leg lies on no other wire (rule 2, 2026-10-09)
  await dropOpen(page, panel, async () => {
    const p = await pointOnWire(panel, wireId);
    await page.mouse.click(p.x, p.y);
    return centreOf(panel.locator(`.design-wire[data-wire="${wireId}"] .design-handle.end[data-end="tail"]`));
  });
  await expect(panel.locator(`.react-flow__edge[data-id="${wireId}"] circle.nx-src`)).toHaveCount(1);

  const sent = page.waitForRequest((r) => r.method() === 'PUT' && r.url().endsWith(`/workflows/${t.workflow.id}/design`));
  await save(page);
  const body = (await sent).postDataJSON() as { workflow: { entryStepIds: string[] | null }; steps: { nextStepIds: string[] | null }[]; layout: { v: number; wires: Record<string, { tail: { on: string } }> } };
  expect(body.workflow.entryStepIds).toEqual([]);
  expect(body.steps.flatMap((s) => s.nextStepIds ?? [])).not.toContain(t.stepId);
  expect(body.layout.v).toBe(2);
  expect(body.layout.wires[wireId]!.tail.on).toBe('open');

  // a fresh read keeps the wire: open at its tail, its arrow head on its step, in its step's colour, dashed
  await page.reload();
  const again = documentPanel(page, t.workflow);
  await expect(again.locator(`.react-flow__edge[data-id="${wireId}"] .nx-head`)).toHaveCount(1);
  await expect(again.locator(`.react-flow__edge[data-id="${wireId}"] path.w`)).toHaveAttribute('stroke', '#2DD4BF');
});
