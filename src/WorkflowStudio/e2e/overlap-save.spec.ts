import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { documentPanel, dragEnd, edge, emptySpot, freeWire, get, layOn, openWorkflow, pane, save, shapeByHand } from './studio';
import { createCircuitThrowaway, expect, removeThrowaway, test, type CircuitThrowaway } from './throwaway';

// The user's rule 2 (2026-10-09) on Save: a wire lying on a wire of another net is a short circuit, held back like any
// other. Its own throwaway workflow (`e2e-9-…`: a, b, c Completed, d Failed; wf -> a, a -> b, a -> d, b -> c), fresh, so
// the overlap is the only short circuit in it; made and deleted through BaseApi's CRUD, and only its Save is written
// (throwaway.ts's guard aborts any other write).
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
const entriesOf = async (request: APIRequestContext) => (await get<{ entryStepIds: string[] }>(request, `workflows/${t.workflow.id}`)).entryStepIds;

async function open(page: Page): Promise<Locator> {
  await openWorkflow(page, t.workflow);
  return documentPanel(page, t.workflow);
}

test('a wire lying on another net\'s wire is a short circuit: Save writes nothing for its sources and says so; a fresh read draws it red again', async ({ page, request }) => {
  const panel = await open(page);
  const ab = `${t.a}->${t.b}`, ad = `${t.a}->${t.d}`;
  const lists = async () => ({
    a: [...await nextOf(request, t.a)].sort(), b: await nextOf(request, t.b), c: await nextOf(request, t.c), d: await nextOf(request, t.d), entries: await entriesOf(request),
  });
  const before = await lists();
  expect(before.a).toEqual([t.b, t.d].sort());
  // a change on a that Save would write: a -> d's head dropped open (a no longer feeds d)
  expect(await dragEnd(page, panel, ad, 'head', await emptySpot(panel))).toBe('move here');
  // a -> b shaped by hand, and a both-open wire laid on its upright run: a -> b's net is short-circuited, so a is held back
  await shapeByHand(page, panel, ab);
  const f = await freeWire(page, panel, t.c);
  await layOn(page, panel, f, ab);
  for (const id of [ab, f]) await expect(edge(panel, id).locator('path.nx-overlap')).toHaveCount(1);
  await save(page);
  const output = await pane(page, 'Output');
  await expect(output).toContainText('Saved and applied; 1 short circuit not written; 1 link held back until fixed');
  // nothing written for a: its loaded list stays, a -> d's removal waits; no other list changed
  expect(await lists()).toEqual(before);
  const ab$ = `${t.tag}-a_1\\.0\\.0-\\S+ → ${t.tag}-b_1\\.0\\.0-\\S+`, free$ = 'an open end → an open end';
  const named = new RegExp(`short circuit: (${ab$} overlaps ${free$}|${free$} overlaps ${ab$})`);
  const problems = await pane(page, 'Problems');
  await expect(problems.getByRole('listitem')).toHaveCount(1);
  await expect(problems.getByRole('listitem').filter({ hasText: named })).toHaveCount(1);
  if (process.env.OVERLAP_SHOTS) await page.screenshot({ path: `${process.env.OVERLAP_SHOTS}/8-saved-held-back.png` });
  // a fresh read draws it as saved: the two wires red where they lie on each other, a -> d still open
  await page.reload();
  const again = documentPanel(page, t.workflow);
  for (const id of [ab, f]) await expect(edge(again, id).locator('path.nx-overlap')).toHaveCount(1);
  await expect(edge(again, ad)).toHaveCount(1);
  expect(await edge(again, ad).locator('path.w').first().evaluate((el) => getComputedStyle(el).strokeDasharray)).not.toBe('none');
  await expect((await pane(page, 'Problems')).getByRole('listitem').filter({ hasText: named })).toHaveCount(1);
  if (process.env.OVERLAP_SHOTS) await page.screenshot({ path: `${process.env.OVERLAP_SHOTS}/9-saved-fresh-read.png` });
});
