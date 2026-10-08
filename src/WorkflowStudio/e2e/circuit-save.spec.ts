import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { centreOf, documentPanel, dragEnd, dragReading, edge, inspector, newWires, node, openWorkflow, pointOnWire, tab } from './studio';
import { createCircuitThrowaway, expect, removeThrowaway, test, type CircuitThrowaway } from './throwaway';

// Plan 9 §7: Save derives nextStepIds and entryStepIds by tracing the current. These tests save only their own throwaway
// workflow (`e2e-9-…`: a, b, c Completed, d Failed; wf -> a, a -> b, a -> d, b -> c), made and deleted through BaseApi's
// CRUD; throwaway.ts's guard aborts any other write. They build on each other's state, so they run in order.
test.describe.configure({ mode: 'serial', retries: 0 });
let t: CircuitThrowaway;
test.beforeAll(async ({ request }) => { t = await createCircuitThrowaway(request); });
test.afterAll(async ({ request }) => { await removeThrowaway(request); });
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
});

const sorted = (ids: readonly string[]) => [...ids].sort();

async function get<T>(request: APIRequestContext, path: string): Promise<T> {
  const r = await request.get(`/api/v1/${path}`);
  expect(r.ok(), `GET ${path}`).toBe(true);
  return (await r.json()) as T;
}
const nextOf = async (request: APIRequestContext, id: string) => (await get<{ nextStepIds: string[] }>(request, `steps/${id}`)).nextStepIds;
const entriesOf = async (request: APIRequestContext) => (await get<{ entryStepIds: string[] }>(request, `workflows/${t.workflow.id}`)).entryStepIds;

async function open(page: Page): Promise<Locator> {
  await openWorkflow(page, t.workflow);
  return documentPanel(page, t.workflow);
}

/** The capsule's Save, then wait for the answer (the button leaves "Saving…"). */
async function save(page: Page): Promise<void> {
  await page.getByRole('button', { name: '⤓ Save' }).click();
  await expect(page.getByRole('button', { name: '⤓ Saving…' })).toHaveCount(0, { timeout: 20_000 });
}

async function pane(page: Page, name: 'Problems' | 'Output'): Promise<Locator> {
  await tab(page, name).click();
  return page.locator(`[data-pane="${name.toLowerCase()}"]`);
}

async function setEntryCondition(page: Page, panel: Locator, id: string, name: RegExp): Promise<void> {
  await node(panel, id).click({ position: { x: 20, y: 12 } });
  await expect(inspector(page).locator('.kindpill')).toHaveText('STEP');
  await inspector(page).getByLabel('Entry condition', { exact: true }).click();
  await inspector(page).getByRole('option', { name }).click();
}

test('a tail joined on a wire fans out: Save writes the tapped step\'s current into both steps; a fresh read draws the junction again', async ({ page, request }) => {
  const panel = await open(page);
  expect(await dragEnd(page, panel, `${t.b}->${t.c}`, 'tail', await pointOnWire(panel, `${t.a}->${t.b}`, 0.5, 12))).toBe('join here');
  await save(page);
  await expect(await pane(page, 'Output')).toContainText('Saved and applied');
  expect(sorted(await nextOf(request, t.a))).toEqual(sorted([t.b, t.c, t.d]));
  expect(await nextOf(request, t.b)).toEqual([]);
  expect(await entriesOf(request)).toEqual([t.a]);
  await page.reload();
  await expect(edge(documentPanel(page, t.workflow), `${t.b}->${t.c}`).locator('circle.nx-joint')).toHaveCount(1);
});

test('a head joined on a wire fans in; where it joins decides what its current reaches', async ({ page, request }) => {
  const panel = await open(page);
  const ab = `${t.a}->${t.b}`;
  // before b -> c's tap (at a -> b's middle): d's current reaches b and c
  await node(panel, t.d).hover();
  const label = await dragReading(page, panel, await centreOf(node(panel, t.d).locator('.nx-port')), await pointOnWire(panel, ab, 0.15, 12));
  expect(label).toBe('join here');
  await expect(newWires(panel)).toHaveCount(1);
  const id = (await newWires(panel).first().getAttribute('data-id'))!;
  await save(page);
  await expect(await pane(page, 'Output')).toContainText('Saved and applied');
  expect(sorted(await nextOf(request, t.d))).toEqual(sorted([t.b, t.c]));
  // after the tap: d's current reaches b only
  expect(await dragEnd(page, panel, id, 'head', await pointOnWire(panel, ab, 0.85, 12))).toBe('join here');
  await save(page);
  expect(await nextOf(request, t.d)).toEqual([t.b]);
  expect(sorted(await nextOf(request, t.a))).toEqual(sorted([t.b, t.c, t.d]));
});

test('an entry-condition edit that makes a short circuit: listed in Problems; Save writes none of its links and says so, the held-back lists stay as BaseApi had them; a fresh read keeps it marked', async ({ page, request }) => {
  const panel = await open(page);
  const heldA = sorted(await nextOf(request, t.a)), heldD = await nextOf(request, t.d);
  expect(heldA).toEqual(sorted([t.b, t.c, t.d]));
  expect(heldD).toEqual([t.b]);
  await setEntryCondition(page, panel, t.c, /Failed/);
  await expect(panel.locator('circle.nx-joint.short').first()).toBeVisible();
  await expect(await pane(page, 'Problems')).toContainText('short circuit: Completed meets Failed');
  await save(page);
  await expect(await pane(page, 'Output')).toContainText('Saved and applied; 1 short circuit not written');
  await expect(await pane(page, 'Problems')).toContainText('short circuit: Completed meets Failed');
  // the rest applied: c's entry condition; the sources whose wires are in the shorted net keep their saved lists
  expect((await get<{ entryCondition: number }>(request, `steps/${t.c}`)).entryCondition).toBe(2);
  expect(sorted(await nextOf(request, t.a))).toEqual(heldA);
  expect(await nextOf(request, t.d)).toEqual(heldD);
  expect(await entriesOf(request)).toEqual([t.a]);
  await page.reload();
  await expect(documentPanel(page, t.workflow).locator('circle.nx-joint.short').first()).toBeVisible();
});

test('a tail joined on an entry wire makes the steps its current reaches entry steps', async ({ page, request }) => {
  const panel = await open(page);
  await setEntryCondition(page, panel, t.c, /Completed/);
  await expect(panel.locator('circle.nx-joint.short')).toHaveCount(0);
  expect(await dragEnd(page, panel, `${t.a}->${t.b}`, 'tail', await pointOnWire(panel, `wf->${t.a}`, 0.5, 10))).toBe('join here');
  await save(page);
  await expect(await pane(page, 'Output')).toContainText('Saved and applied');
  await expect(await pane(page, 'Output')).not.toContainText('short circuit');
  expect(sorted(await entriesOf(request))).toEqual(sorted([t.a, t.b, t.c]));
  expect(await nextOf(request, t.a)).toEqual([t.d]);
  expect(await nextOf(request, t.d)).toEqual([t.b]);
  expect((await get<{ entryCondition: number }>(request, `steps/${t.c}`)).entryCondition).toBe(1);
});
