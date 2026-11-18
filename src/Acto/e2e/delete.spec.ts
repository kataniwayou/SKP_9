import { test, expect } from './fixtures';
import {
  caNode, cacheEdge, dropTool, entryEdge, field, inspector, openAt, outLine, pickCache, pickEdge, pickStep, selectWorkflowAlone, regionPoint, save,
  saveButton, stNode, toolbar, toolboxStep, wfNode, wireEdge, workflowTool, PROC_A,
} from './helpers';
import { seed } from './seed';
import { getJson, type Row } from './stack';

// Spec §8: deleting a triangle is immediate (BaseAPI's CRUD delete through /model/apply), asks first with what goes, and leaves its steps and
// caches. Only never-started e2e- workflows are used: Start and Stop are never pressed (the guard aborts them).

const SEED = {
  steps: [
    { key: 's1', name: 'e2e-del-first', at: { x: 300, y: 100 }, next: ['s2'] },
    { key: 's2', name: 'e2e-del-second', at: { x: 600, y: 100 } },
  ],
  caches: [{ key: 'c1', name: 'e2e-del-cache', at: { x: 40, y: 360 } }],
  payloads: [
    { key: 'own', step: 's1', payload: '{"own": true}' },
    { key: 'shared', step: 's2', payload: '{"shared": true}' },
  ],
  workflows: [
    { key: 'a', name: 'e2e-del-a', at: { x: 0, y: 30 }, entry: ['s1'], caches: ['c1'], payloads: ['own', 'shared'] },
    { key: 'b', name: 'e2e-del-b', at: { x: 0, y: 220 }, entry: ['s2'], payloads: ['shared'] },
  ],
} as const;

const ids = async (table: string) => new Set((await getJson<Row[]>(`/${table}`)).map((r) => r.id));

test('deleting a triangle asks with what goes; Cancel sends nothing; Delete removes the workflow and its own payloads, and its steps and caches stay', async ({ page }) => {
  const id = await seed(SEED);
  await openAt(page);
  await selectWorkflowAlone(page, id.a!);
  const tb = toolbar(page, 'workflow');
  await expect(tb.getByRole('button')).toHaveText(['▶ Start', 'Delete']);

  const writes: string[] = [];
  page.on('request', (r) => { if (r.method() !== 'GET' && r.url().includes('/api/')) writes.push(`${r.method()} ${new URL(r.url()).pathname}`); });
  await tb.getByRole('button', { name: 'Delete', exact: true }).click();
  // the dry run's list: the workflow and the payload only it links (the shared one stays with B)
  await expect(tb.locator('.confirm-text')).toHaveText('Delete workflow e2e-del-a, assignment e2e-pay-own? Its steps and caches stay.');
  await expect(tb.getByRole('button')).toHaveText(['Delete', 'Cancel']);
  expect(writes.filter((w) => !w.endsWith('/validate'))).toEqual([]); // the dry run is /model/validate: it writes nothing

  await tb.getByRole('button', { name: 'Cancel' }).click();
  await expect(outLine(page, 'Delete cancelled — nothing was sent')).toHaveCount(1);
  await expect(tb.getByRole('button')).toHaveText(['▶ Start', 'Delete']);
  await expect(wfNode(page, id.a!)).toBeVisible();
  expect((await ids('workflows')).has(id.a!)).toBe(true);
  expect(writes.filter((w) => w.endsWith('/apply'))).toEqual([]);

  // a different selection also drops a pending confirm
  await tb.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(tb.locator('.confirm-text')).toBeVisible();
  await pickStep(page, id.s1!);
  await selectWorkflowAlone(page, id.a!);
  await expect(tb.locator('.confirm-text')).toHaveCount(0);

  await tb.getByRole('button', { name: 'Delete', exact: true }).click();
  await tb.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(wfNode(page, id.a!)).toHaveCount(0);
  await expect(outLine(page, 'Deleted workflow e2e-del-a, assignment e2e-pay-own. Its steps and caches stay')).toHaveCount(1);
  await expect(inspector(page)).toContainText('Select a workflow, step or wire');
  expect(writes.filter((w) => w.endsWith('/apply'))).toEqual(['POST /api/v1/model/apply']);

  // BaseAPI: the workflow and its own payload are gone, the shared payload, the steps and the cache stay, B still links the shared one
  expect((await ids('workflows')).has(id.a!)).toBe(false);
  expect((await ids('assignments')).has(id.own!)).toBe(false);
  expect((await ids('assignments')).has(id.shared!)).toBe(true);
  const steps = await ids('steps');
  expect(steps.has(id.s1!) && steps.has(id.s2!)).toBe(true);
  expect((await ids('caches')).has(id.c1!)).toBe(true);
  expect((await getJson<Row>(`/workflows/${id.b}`)).assignmentIds).toEqual([id.shared]);
  // and on the board: its steps, wire and cache are still there, its arrow and dashed line are not
  await expect(stNode(page, id.s1!)).toBeVisible();
  await expect(stNode(page, id.s2!)).toBeVisible();
  await expect(caNode(page, id.c1!)).toBeVisible();
  await expect(wireEdge(page, id.s1!, id.s2!)).toHaveCount(1);
  await expect(entryEdge(page, id.a!, id.s1!)).toHaveCount(0);
  await expect(cacheEdge(page, id.a!, id.c1!)).toHaveCount(0);
  await expect(wfNode(page, id.b!)).toBeVisible();
  await expect(saveButton(page)).toBeDisabled();
});

test('a never-saved triangle is discarded with no request, and the steps dropped beside it stay on the board', async ({ page }) => {
  await openAt(page);
  const writes: string[] = [];
  page.on('request', (r) => { if (r.method() !== 'GET' && r.url().includes('/api/')) writes.push(`${r.method()} ${new URL(r.url()).pathname}`); });
  const wf = await dropTool(page, workflowTool(page), 'workflow', await regionPoint(page, { x: 90, y: 130 }));
  const step = await dropTool(page, toolboxStep(page, PROC_A), 'step', await regionPoint(page, { x: 450, y: 130 }));
  const name = await wfNode(page, wf).locator('.tri-nm').innerText();
  await selectWorkflowAlone(page, wf);
  const tb = toolbar(page, 'workflow');
  await tb.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(tb.locator('.confirm-text')).toHaveText(`Delete workflow ${name}? Its steps and caches stay.`);
  await tb.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(wfNode(page, wf)).toHaveCount(0);
  await expect(stNode(page, step)).toBeVisible();
  await expect(outLine(page, `Deleted workflow ${name}. Its steps and caches stay`)).toHaveCount(1);
  expect(writes).toEqual([]);
});

test('deleting a triangle drops its own unsaved edits and keeps the unsaved edits of the steps it reached', async ({ page }) => {
  const id = await seed(SEED);
  await openAt(page);
  await selectWorkflowAlone(page, id.a!);
  await field(page, 'Description').fill('an unsaved edit of the triangle');
  await pickStep(page, id.s1!);
  await field(page, 'Name').fill('e2e-del-first-edited');
  await expect(wfNode(page, id.a!).locator('.unsaved-mark')).toBeVisible();
  await selectWorkflowAlone(page, id.a!);
  const tb = toolbar(page, 'workflow');
  await tb.getByRole('button', { name: 'Delete', exact: true }).click();
  await tb.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(wfNode(page, id.a!)).toHaveCount(0);
  // the step's rename stays unsaved on the board; B and the others are untouched
  await expect(stNode(page, id.s1!).locator('.sn')).toHaveText('e2e-del-first-edited');
  await expect(stNode(page, id.s1!).locator('.unsaved-mark')).toBeVisible();
  await expect(wfNode(page, id.b!).locator('.unsaved-mark')).toHaveCount(0);
  await expect(saveButton(page)).toContainText('Save ·');
  await expect(saveButton(page)).not.toContainText('Save · 0');
  // and it saves
  await save(page);
  expect((await getJson<Row>(`/steps/${id.s1}`)).name).toBe('e2e-del-first-edited');
});

test('Delete on a step takes its wires, entry arrows and payloads with it; on a cache its dashed lines; each is one undo step and saves as a delete', async ({ page }) => {
  const id = await seed({
    steps: [
      { key: 's1', name: 'e2e-del-first', at: { x: 300, y: 100 }, next: ['s2'] },
      { key: 's2', name: 'e2e-del-second', at: { x: 600, y: 100 } },
      { key: 's3', name: 'e2e-del-third', at: { x: 600, y: 260 } },
      { key: 's4', name: 'e2e-del-fourth', at: { x: 600, y: 420 } },
    ],
    caches: SEED.caches,
    payloads: [{ key: 'own', step: 's1', payload: '{"own": true}' }],
    workflows: [
      { key: 'a', name: 'e2e-del-a', at: { x: 0, y: 30 }, entry: ['s1', 's3'], caches: ['c1'], payloads: ['own'] },
      { key: 'b', name: 'e2e-del-b', at: { x: 0, y: 220 }, entry: ['s3', 's4'] },
    ],
  });
  await openAt(page);

  // a wire's own toolbar
  await pickEdge(page, wireEdge(page, id.s1!, id.s2!));
  await toolbar(page, 'wire').getByRole('button', { name: 'Delete' }).click();
  await expect(wireEdge(page, id.s1!, id.s2!)).toHaveCount(0);
  // an entry arrow's
  await pickEdge(page, entryEdge(page, id.b!, id.s4!));
  await toolbar(page, 'entry').getByRole('button', { name: 'Delete' }).click();
  await expect(entryEdge(page, id.b!, id.s4!)).toHaveCount(0);
  await expect(entryEdge(page, id.b!, id.s3!)).toHaveCount(1);
  // a cache line's
  await pickEdge(page, cacheEdge(page, id.a!, id.c1!));
  await toolbar(page, 'cacheLink').getByRole('button', { name: 'Delete' }).click();
  await expect(cacheEdge(page, id.a!, id.c1!)).toHaveCount(0);
  await expect(caNode(page, id.c1!)).toBeVisible();

  // the step that is an entry of A (its other entry stays): arrow, payload and the step go
  await pickStep(page, id.s1!);
  await toolbar(page, 'step').getByRole('button', { name: 'Delete' }).click();
  await expect(stNode(page, id.s1!)).toHaveCount(0);
  await expect(entryEdge(page, id.a!, id.s1!)).toHaveCount(0);
  await selectWorkflowAlone(page, id.a!);
  // A's payload on that step is gone from its assignments
  await expect(inspector(page)).toContainText('No assignments.');
  // the cache goes with its (already removed) line
  await pickCache(page, id.c1!);
  await toolbar(page, 'cache').getByRole('button', { name: 'Delete' }).click();
  await expect(caNode(page, id.c1!)).toHaveCount(0);

  // one board history: undo brings the cache back, then the step with its arrow and payload
  await inspector(page).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(caNode(page, id.c1!)).toBeVisible();
  await inspector(page).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(stNode(page, id.s1!)).toBeVisible();
  await expect(entryEdge(page, id.a!, id.s1!)).toHaveCount(1);
  await inspector(page).getByRole('button', { name: 'Redo', exact: true }).click();
  await inspector(page).getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(stNode(page, id.s1!)).toHaveCount(0);
  await expect(caNode(page, id.c1!)).toHaveCount(0);

  // Save writes the deletes (steps, assignments and the cache go from BaseAPI; the rest of the board is as it was)
  await save(page);
  await expect(saveButton(page)).toBeDisabled();
  expect((await ids('steps')).has(id.s1!)).toBe(false);
  expect((await ids('steps')).has(id.s2!) && (await ids('steps')).has(id.s4!)).toBe(true);
  expect((await ids('caches')).has(id.c1!)).toBe(false);
  expect((await ids('assignments')).has(id.own!)).toBe(false);
  expect((await getJson<Row>(`/workflows/${id.a}`)).entryStepIds).toEqual([id.s3]);
  expect((await getJson<Row>(`/workflows/${id.b}`)).entryStepIds).toEqual([id.s3]);
  expect((await getJson<Row>(`/steps/${id.s1}`).catch(() => null))).toBeNull();
});
