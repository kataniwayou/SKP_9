import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { box, centreOf, documentPanel, dragEnd, dragReading, edge, emptySpot, get, newWire, newWires, node, openWorkflow, pane, pointOnWire, save, setEntryCondition, type Pt } from './studio';
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

const nextOf = async (request: APIRequestContext, id: string) => (await get<{ nextStepIds: string[] }>(request, `steps/${id}`)).nextStepIds;
const entriesOf = async (request: APIRequestContext) => (await get<{ entryStepIds: string[] }>(request, `workflows/${t.workflow.id}`)).entryStepIds;

async function open(page: Page): Promise<Locator> {
  await openWorkflow(page, t.workflow);
  return documentPanel(page, t.workflow);
}

/** A page point inside the hub's disc at `deg` round its centre (0 right, 90 down). */
async function onHub(panel: Locator, deg: number): Promise<Pt> {
  const b = await box(node(panel, 'wf'));
  const r = (deg * Math.PI) / 180, R = b.width / 2;
  return { x: b.x + R + 0.8 * R * Math.cos(r), y: b.y + R + 0.8 * R * Math.sin(r) };
}

/** Where a wire's tail is drawn, in flow coordinates, and the hub's top ring point. */
async function tailOf(panel: Locator, id: string): Promise<[number, number]> {
  const d = (await edge(panel, id).locator('path.w').first().getAttribute('d')) ?? '';
  const m = /M([-\d.e]+)[ ,]([-\d.e]+)/.exec(d)!;
  return [Number(m[1]), Number(m[2])];
}
async function hubTop(panel: Locator): Promise<[number, number]> {
  return node(panel, 'wf').evaluate((el) => {
    const e = el as HTMLElement;
    const m = /translate\(([-\d.e]+)px, ?([-\d.e]+)px\)/.exec(e.style.transform)!;
    return [Number(m[1]) + e.offsetWidth / 2, Number(m[2])] as [number, number];
  });
}

test('a tail joined on a wire fans out: Save writes the tapped step\'s current into both steps; a fresh read draws the junction again', async ({ page, request }) => {
  const panel = await open(page);
  expect(await dragEnd(page, panel, `${t.b}->${t.c}`, 'tail', await pointOnWire(panel, `${t.a}->${t.b}`, 0.5, 12))).toBe('join here');
  // and the entry wire's tail at the hub's top (a hub angle): a design of its own, beside the junction
  expect(await dragEnd(page, panel, `wf->${t.a}`, 'tail', await onHub(panel, 270))).toBe('connect here');
  await expect(page.getByText('● design draft')).toBeVisible();
  await save(page);
  await expect(await pane(page, 'Output')).toContainText('Saved and applied');
  expect(sorted(await nextOf(request, t.a))).toEqual(sorted([t.b, t.c, t.d]));
  expect(await nextOf(request, t.b)).toEqual([]);
  expect(await entriesOf(request)).toEqual([t.a]);
  // saved: the stored design is what is shown, so nothing is left to save (final review M5)
  await expect(page.getByText('● design draft')).toHaveCount(0);
  await page.reload();
  const again = documentPanel(page, t.workflow);
  await expect(edge(again, `${t.b}->${t.c}`).locator('circle.nx-joint')).toHaveCount(1);
  const [tx, ty] = await tailOf(again, `wf->${t.a}`), [hx, hy] = await hubTop(again);
  expect(Math.hypot(tx - hx, ty - hy)).toBeLessThan(1);
  // read fresh from BaseApi, the junction and the hub angle are the stored design, not a draft
  await expect(page.getByText('● design draft')).toHaveCount(0);
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
  const sent = page.waitForRequest((r) => r.method() === 'PUT' && r.url().endsWith(`/workflows/${t.workflow.id}/design`));
  await save(page);
  // the request writes no list for the held-back sources (a and d: their wires are in the shorted net), and no entries
  const body = (await sent).postDataJSON() as { workflow: { entryStepIds: string[] | null }; steps: { id: string; nextStepIds: string[] | null }[] };
  for (const id of [t.a, t.d]) expect(body.steps.find((s) => s.id === id)?.nextStepIds ?? null, `nextStepIds sent for ${id}`).toBeNull();
  expect(body.workflow.entryStepIds).toBeNull();
  // c's edit is in it
  expect(body.steps.some((s) => s.id === t.c)).toBe(true);
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

test('a direction-less wire writes nothing: Save leaves every list as BaseApi had it; a fresh read draws it again with no direction (rule D, 2026-10-09)', async ({ page, request }) => {
  const panel = await open(page);
  const lists = async () => ({
    entries: sorted(await entriesOf(request)),
    next: await Promise.all([t.a, t.b, t.c, t.d].map(async (id) => sorted(await nextOf(request, id)))),
  });
  const before = await lists();
  // one joined on a -> d's line and open at its other end, one open at both ends: neither has an end on a step
  const spot = await emptySpot(panel);
  const joined = await newWire(page, panel, t.c, spot);
  expect(await dragEnd(page, panel, joined, 'tail', await pointOnWire(panel, `${t.a}->${t.d}`, 0.5, 12))).toBe('join here');
  const spot2 = await emptySpot(panel, [spot]);
  const loose = await newWire(page, panel, t.b, spot2);
  expect(await dragEnd(page, panel, loose, 'tail', await emptySpot(panel, [spot, spot2]))).toBe('move here');
  for (const id of [joined, loose]) {
    await expect(edge(panel, id).locator('circle.nx-src')).toHaveCount(0);
    await expect(edge(panel, id).locator('path.nx-head')).toHaveCount(0);
  }
  await save(page);
  await expect(await pane(page, 'Output')).toContainText('Saved');
  expect(await lists()).toEqual(before);
  await page.reload();
  const again = documentPanel(page, t.workflow);
  for (const id of [joined, loose]) {
    await expect(edge(again, id)).toHaveCount(1);
    await expect(edge(again, id).locator('circle.nx-src')).toHaveCount(0);
    await expect(edge(again, id).locator('path.nx-head')).toHaveCount(0);
  }
  await expect(edge(again, joined).locator('circle.nx-joint')).toHaveCount(1);
});
