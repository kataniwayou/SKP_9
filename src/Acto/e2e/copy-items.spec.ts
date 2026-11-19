import { test, expect } from './fixtures';
import {
  allCaches, allWorkflows, cacheEdge, caNode, clearOutput, clickEmptyBoard, entryEdge, openAt, outLine, pickCache, pickStep, pickWorkflow, save, selbar,
  stNode, toolbar, wfNode,
} from './helpers';
import { seed } from './seed';
import { getJson, type Row } from './stack';

// Copy of workflows (triangles) and caches, alone or mixed with steps [user, 2026-11-19]: a paste is a new id with every
// field the same but the name. A workflow keeps its entry steps, caches and assignment rows (shared); a link between two
// items copied together joins the copies. Only e2e- rows are saved; the pasted workflow is never started.

const SEED = {
  caches: [{ key: 'c', name: 'e2e-cp-cache', at: { x: 0, y: 300 }, root: 'e2e-cp-root' }],
  steps: [{ key: 's', name: 'e2e-cp-step', at: { x: 300, y: 60 }, condition: 3 }],
  payloads: [{ key: 'p', step: 's', payload: '{"maxDepth": 4}' }],
  workflows: [{ key: 'w', name: 'e2e-cp-wf', at: { x: 0, y: 40 }, entry: ['s'], caches: ['c'], payloads: ['p'], cron: '0 0 * * * *' }],
} as const;

const byName = (rows: Row[], name: string) => rows.find((r) => r.name === name);
const nodeId = async (l: ReturnType<typeof wfNode>) => (await l.getAttribute('data-id'))!.replace(/^[a-z]+:/, '');

test('a workflow\'s toolbar has Copy; the paste is a new triangle with every field, the same entry step, cache and assignment, and saves as such', async ({ page }) => {
  const id = await seed(SEED);
  await openAt(page);
  await pickWorkflow(page, id.w!);
  await expect(toolbar(page, 'workflow').getByRole('button')).toHaveText(['▶ Start', 'Copy', 'Delete']);
  await toolbar(page, 'workflow').getByRole('button', { name: 'Copy' }).click();
  await expect(outLine(page, 'Copied 1 workflow')).toHaveCount(1);
  const n0 = await allWorkflows(page).count();

  await clearOutput(page);
  await page.keyboard.press('Control+v');
  await expect(outLine(page, 'Pasted 1 workflow')).toHaveCount(1);
  await expect(allWorkflows(page)).toHaveCount(n0 + 1);
  const copy = page.locator('.react-flow__node-workflow').filter({ hasText: 'e2e-cp-wf-2' });
  await expect(copy).toHaveCount(1);
  await expect(copy.locator('.unsaved-mark')).toHaveCount(1);
  const cid = await nodeId(copy);
  // picked alone, with its own toolbar; its entry arrow and cache line go to the same step and cache
  await expect(toolbar(page, 'workflow').getByRole('button')).toHaveText(['▶ Start', 'Copy', 'Delete']);
  await expect(entryEdge(page, cid, id.s!)).toHaveCount(1);
  await expect(cacheEdge(page, cid, id.c!)).toHaveCount(1);
  // not on top of the original
  const [a, b] = [(await wfNode(page, id.w!).boundingBox())!, (await copy.boundingBox())!];
  expect(a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height, 'the copy overlaps the original').toBe(false);

  const answer = await save(page);
  expect(answer.applied).toBe(true);
  const rows = await getJson<Row[]>('/workflows');
  const orig = byName(rows, 'e2e-cp-wf')!, made = byName(rows, 'e2e-cp-wf-2')!;
  expect(made.id).not.toBe(orig.id);
  for (const k of ['version', 'description', 'cronExpression', 'entryStepIds', 'cacheIds', 'assignmentIds']) expect(made[k], k).toEqual(orig[k]);
  expect(made.assignmentIds).toEqual([id.p]);
});

test('a cache\'s toolbar has Copy; the paste is a new cache with every field but the name and root, and saves as such', async ({ page }) => {
  const id = await seed(SEED);
  await openAt(page);
  await pickCache(page, id.c!);
  await expect(toolbar(page, 'cache').getByRole('button')).toHaveText(['Copy', 'Delete']);
  await toolbar(page, 'cache').getByRole('button', { name: 'Copy' }).click();
  await expect(outLine(page, 'Copied 1 cache')).toHaveCount(1);
  const n0 = await allCaches(page).count();
  await page.keyboard.press('Control+v');
  await expect(outLine(page, 'Pasted 1 cache')).toHaveCount(1);
  await expect(allCaches(page)).toHaveCount(n0 + 1);
  const copy = page.locator('.react-flow__node-cache').filter({ hasText: 'e2e-cp-cache-2' });
  await expect(copy.locator('.unsaved-mark')).toHaveCount(1);
  await expect(toolbar(page, 'cache').getByRole('button')).toHaveText(['Copy', 'Delete']);
  // the original keeps its one workflow line; the copy is linked by none
  await expect(cacheEdge(page, id.w!, id.c!)).toHaveCount(1);
  await expect(cacheEdge(page, id.w!, await nodeId(copy))).toHaveCount(0);

  expect((await save(page)).applied).toBe(true);
  const rows = await getJson<Row[]>('/caches');
  const orig = byName(rows, 'e2e-cp-cache')!, made = byName(rows, 'e2e-cp-cache-2')!;
  expect(made.id).not.toBe(orig.id);
  for (const k of ['version', 'description', 'items']) expect(made[k], k).toEqual(orig[k]);
  // the root is unique in BaseAPI, so it is named on like the name [user, 2026-11-19]
  expect([orig.root, made.root]).toEqual(['e2e-cp-root', 'e2e-cp-root-2']);
});

test('the bar: Copy for any mix of triangles, steps and caches; pasted together, the copy\'s links join the copies', async ({ page }) => {
  const id = await seed(SEED);
  await openAt(page);
  // a step and a cache: Copy · Delete
  await pickStep(page, id.s!);
  await pickCache(page, id.c!, true);
  await expect(selbar(page).getByRole('button')).toHaveText(['Copy', 'Delete']);
  // with the triangle too: Copy only (a triangle's Delete is a BaseAPI delete of its own)
  await wfNode(page, id.w!).locator('.tri-nm').click({ modifiers: ['Control'] });
  await expect(selbar(page).locator('.selbar-pill')).toHaveText('3 SELECTED');
  await expect(selbar(page).getByRole('button')).toHaveText(['Copy']);
  await selbar(page).getByRole('button', { name: 'Copy' }).click();
  await expect(outLine(page, 'Copied 1 workflow, 1 step and 1 cache')).toHaveCount(1);

  await clearOutput(page);
  await page.keyboard.press('Control+v');
  await expect(outLine(page, 'Pasted 1 workflow, 1 step and 1 cache')).toHaveCount(1);
  await expect(selbar(page).locator('.selbar-pill')).toHaveText('3 SELECTED');
  const wf = await nodeId(page.locator('.react-flow__node-workflow').filter({ hasText: 'e2e-cp-wf-2' }));
  const st = await nodeId(page.locator('.react-flow__node-step').filter({ hasText: 'e2e-cp-step-2' }));
  const ca = await nodeId(page.locator('.react-flow__node-cache').filter({ hasText: 'e2e-cp-cache-2' }));
  await expect(entryEdge(page, wf, st)).toHaveCount(1);
  await expect(cacheEdge(page, wf, ca)).toHaveCount(1);
  await expect(entryEdge(page, wf, id.s!)).toHaveCount(0);
  await expect(cacheEdge(page, wf, id.c!)).toHaveCount(0);
  // the originals are untouched
  await expect(entryEdge(page, id.w!, id.s!)).toHaveCount(1);
  await expect(stNode(page, id.s!).locator('.sn')).toHaveText('e2e-cp-step');
  await expect(caNode(page, id.c!)).toContainText('e2e-cp-cache');
  // two triangles: Start · Stop, Copy, Delete
  await clickEmptyBoard(page);
  await pickWorkflow(page, id.w!);
  await wfNode(page, wf).locator('.tri-nm').click({ modifiers: ['Control'] });
  await expect(selbar(page).getByRole('button')).toHaveText(['▶ Start', '■ Stop', 'Copy', 'Delete']);
  // nothing was saved
  expect((await getJson<Row[]>('/workflows')).filter((w) => w.name.startsWith('e2e-cp-')).map((w) => w.name)).toEqual(['e2e-cp-wf']);
});
