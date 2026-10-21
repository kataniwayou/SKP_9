import type { APIRequestContext, Locator, Page } from '@playwright/test';
import {
  box, documentPanel, dragEnd, dragRunAcross, edge, get, labelsOf, newWire, node, openWorkflow, pane, pickWire, problems, pressTo, save, shapeByHand,
  squareOn, upright, zoomOf,
} from './studio';
import { createCircuitThrowaway, expect, removeThrowaway, test, type CircuitThrowaway } from './throwaway';

// The user's ruling (2026-10-09): wires out of the same step's output (or the hub) of the same colour may share a line,
// as a bus; of different colours that is still a short circuit. Its own throwaway workflow (`e2e-9-…`: a, b, c
// Completed, d Failed; wf -> a, a -> b, a -> d, b -> c), made and deleted through BaseApi's CRUD; only its Save is
// written (throwaway.ts's guard aborts any other write).
test.describe.configure({ mode: 'serial', retries: 0 });
let t: CircuitThrowaway;
test.beforeAll(async ({ request }) => { t = await createCircuitThrowaway(request); });
test.afterAll(async ({ request }) => { await removeThrowaway(request); });
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
});

const nextOf = async (request: APIRequestContext, id: string) => (await get<{ nextStepIds: string[] }>(request, `steps/${id}`)).nextStepIds;

async function open(page: Page): Promise<Locator> {
  await openWorkflow(page, t.workflow);
  return documentPanel(page, t.workflow);
}

test('two wires out of one step of one colour may lie on each other (nothing red, nothing listed, Save writes both links); of different colours it is a short circuit', async ({ page, request }) => {
  const panel = await open(page);
  const ab = `${t.a}->${t.b}`, ad = `${t.a}->${t.d}`;
  // a new wire a -> c (Completed, as a -> b)
  const c = await box(node(panel, t.c));
  const ac = await newWire(page, panel, t.a, { x: c.x + c.width * 0.15, y: c.y + c.height / 2 });
  await expect(edge(panel, ac).locator('path.nx-head')).toHaveCount(1);
  // its upright run dragged onto a -> b's: allowed, no "short circuit"
  const b = await upright(panel, ab), run = await upright(panel, ac);
  expect(await dragRunAcross(page, panel, ac, run, b.x - run.x)).toEqual([]);
  await expect.poll(async () => (await upright(panel, ac)).x).toBe(b.x);
  const now = await upright(panel, ac), still = await upright(panel, ab);
  expect(still.x).toBe(b.x);
  expect(Math.min(now.hi, still.hi) - Math.max(now.lo, still.lo), 'they lie on each other').toBeGreaterThan(8);
  await expect(panel.locator('path.nx-overlap')).toHaveCount(0);
  await expect((await problems(page)).getByRole('listitem')).toHaveCount(0);
  if (process.env.OVERLAP_SHOTS) await page.screenshot({ path: `${process.env.OVERLAP_SHOTS}/10-siblings-one-colour.png` });
  // Save writes both links
  await save(page);
  const output = await pane(page, 'Output');
  await expect(output).toContainText('Saved and applied');
  await expect(output).not.toContainText('short circuit');
  expect([...await nextOf(request, t.a)].sort()).toEqual([t.b, t.c, t.d].sort());

  // a -> d (Failed) out of the same step: its tail slid down a's output, shaped by hand there; a -> b's upright run onto
  // it is a short circuit, refused
  const a = await box(node(panel, t.a));
  expect(await dragEnd(page, panel, ad, 'tail', { x: a.x + a.width * 0.85, y: a.y + a.height * 0.95 })).toBe('connect here');
  const shaped = await shapeByHand(page, panel, ad);
  const from = await upright(panel, ab);
  // its upright 32 right of a -> b's (and a -> c's, laid on it): a run dragged there is beyond the 12 px snap to a -> c's
  // line, which may share it, and to b's left side (plan 10 phase 2)
  expect(await dragRunAcross(page, panel, ad, shaped, from.x + 32 - shaped.x)).toEqual([]);
  const d = await upright(panel, ad);
  expect(d.x).toBe(from.x + 32);
  expect(Math.min(d.hi, from.hi) - Math.max(d.lo, from.lo), 'their upright runs share heights').toBeGreaterThan(8);
  await pickWire(page, panel, ab);
  const sq = await squareOn(panel, ab, from);
  await pressTo(page, sq, { x: sq.x + (d.x - from.x) * (await zoomOf(panel)), y: sq.y });
  expect(await labelsOf(panel)).toEqual(['short circuit']);
  if (process.env.OVERLAP_SHOTS) await page.screenshot({ path: `${process.env.OVERLAP_SHOTS}/11-siblings-two-colours.png` });
  await page.mouse.up();
  await expect.poll(async () => (await upright(panel, ab)).x).toBe(from.x);
});
