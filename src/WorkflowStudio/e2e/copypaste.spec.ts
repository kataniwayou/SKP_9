import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { blocks, box, centreOf, documentPanel, edge, get, inspector, newWires, node, openWorkflow, outputLines, pane, pointOnWire, pressTo, problems, save, upright, zoomOf, type LiveWorkflow, type Pt } from './studio';
import { createCopyThrowaway, expect, removeThrowaway, test, type CopyThrowaway } from './throwaway';

// Copy, paste and delete (the user's decisions, 2026-10-10), with the real mouse and keyboard. Only this run's own
// throwaway entities are written (`e2e-cp-…`: a -> b with an assignment on a, and a second workflow whose entry step is
// b); throwaway.ts's guard aborts any other write. The tests build on each other's state, so they run in order.
test.describe.configure({ mode: 'serial', retries: 0 });
let t: CopyThrowaway;
/** The copies the first test pastes and saves: a's and b's. */
let copyA = '', copyB = '';
/** The copy of a pasted into the other workflow. */
let inOther = '';
test.beforeAll(async ({ request }) => { t = await createCopyThrowaway(request); });
test.afterAll(async ({ request }) => { await removeThrowaway(request); });
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
});

const SHOTS = process.env.COPYPASTE_SHOTS;
const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };

async function open(page: Page, wf: LiveWorkflow = t.workflow): Promise<Locator> {
  await openWorkflow(page, wf);
  return documentPanel(page, wf);
}

async function drag(page: Page, from: Pt, to: Pt): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
}

/** The ids of the blocks a canvas draws. */
const nodeIds = (panel: Locator) => panel.locator('.react-flow__node').evaluateAll((els) => els.map((e) => e.getAttribute('data-id')!));

/** Every block's flow box by id. */
async function boxesById(panel: Locator): Promise<Map<string, { x: number; y: number; w: number; h: number }>> {
  const ids = await nodeIds(panel);
  const all = await blocks(panel);
  return new Map(ids.map((id, i) => [id, all[i]!]));
}

const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/** The pasted step whose name is `name` among the blocks that were not there before. */
async function pastedNamed(panel: Locator, before: string[], name: string): Promise<string> {
  for (const id of await nodeIds(panel)) {
    if (before.includes(id)) continue;
    if (((await node(panel, id).textContent()) ?? '').includes(name)) return id;
  }
  throw new Error(`no pasted step named ${name}`);
}

const assignmentsOf = async (request: APIRequestContext, stepId: string) =>
  (await get<{ id: string; stepId: string; name: string; version: string; description: string | null; payload: string }[]>(request, 'assignments')).filter((a) => a.stepId === stepId);

test('a rectangle round the hub, a, b and their wire: Ctrl+C, Ctrl+V pastes a and b where there is room (the hub not copied), their wire between the copies; Save creates them on the same processor with a copied assignment', async ({ page, request }) => {
  const panel = await open(page);
  const before = await nodeIds(panel);
  const was = await boxesById(panel);
  const hub = await box(node(panel, 'wf')), ba = await box(node(panel, t.a)), bb = await box(node(panel, t.b));
  const x0 = Math.min(hub.x, ba.x, bb.x) - 12, y0 = Math.min(hub.y, ba.y, bb.y) - 12;
  const x1 = Math.max(hub.x + hub.width, ba.x + ba.width, bb.x + bb.width) + 12, y1 = Math.max(hub.y + hub.height, ba.y + ba.height, bb.y + bb.height) + 12;
  // the rectangle is a Ctrl+drag (the user, 2026-10-22: a plain left drag pans)
  await page.keyboard.down('Control');
  await drag(page, { x: x0, y: y0 }, { x: x1, y: y1 });
  await page.keyboard.up('Control');
  for (const id of ['wf', t.a, t.b]) await expect(node(panel, id)).toHaveClass(/studio-pick/);
  await expect(edge(panel, `${t.a}->${t.b}`).locator('.wire.picked')).toHaveCount(1);

  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  await expect(panel.locator('.react-flow__node')).toHaveCount(before.length + 2);
  // the hub is never copied: still one
  await expect(panel.locator('.react-flow__node[data-id="wf"]')).toHaveCount(1);
  copyA = await pastedNamed(panel, before, `${t.tag}-a`);
  copyB = await pastedNamed(panel, before, `${t.tag}-b`);
  expect([copyA, copyB]).not.toContain(t.a);
  // the copied wire runs between the copies, picked with them
  await expect(newWires(panel)).toHaveCount(1);
  await expect(node(panel, copyA)).toHaveClass(/studio-pick/);
  await expect(page.getByText('● design draft')).toBeVisible();

  // where there is room: +32 / +32 lies on the originals, so the group went to the nearest free spot, as one unit on
  // the 32 px grid, on no block
  const now = await boxesById(panel);
  const dA = { x: now.get(copyA)!.x - was.get(t.a)!.x, y: now.get(copyA)!.y - was.get(t.a)!.y };
  const dB = { x: now.get(copyB)!.x - was.get(t.b)!.x, y: now.get(copyB)!.y - was.get(t.b)!.y };
  expect(dB).toEqual(dA);
  expect([dA.x % 32, dA.y % 32].map(Math.abs)).toEqual([0, 0]);
  expect(dA).not.toEqual({ x: 32, y: 32 });
  for (const id of [copyA, copyB]) {
    for (const [other, b] of now) if (other !== id) expect(overlaps(now.get(id)!, b), `${id} on ${other}`).toBe(false);
  }
  await shot(page, '1-pasted');

  await save(page);
  await expect(await pane(page, 'Output')).toContainText('Saved and applied');
  const lines = await (await outputLines(page)).allTextContents();
  expect(lines.some((l) => l.includes(`step '${t.tag}-a' created (copy of '${t.tag}-a')`))).toBe(true);
  type S = { name: string; processorId: string; nextStepIds: string[] };
  const sa = await get<S>(request, `steps/${copyA}`), sb = await get<S>(request, `steps/${copyB}`);
  expect([sa.name, sa.processorId, sa.nextStepIds]).toEqual([`${t.tag}-a`, t.processorId, [copyB]]);
  expect([sb.name, sb.processorId, sb.nextStepIds]).toEqual([`${t.tag}-b`, t.processorId, []]);
  const [asg] = await assignmentsOf(request, copyA);
  expect(asg).toBeDefined();
  expect([asg!.name, asg!.version, asg!.description, JSON.parse(asg!.payload)]).toEqual([`${t.tag}-asg`, '2.0.0', 'copied', { k: 7 }]);
  expect(asg!.id).not.toBe(t.assignmentId);
  const wf = await get<{ entryStepIds: string[]; assignmentIds: string[] }>(request, `workflows/${t.workflow.id}`);
  expect(wf.entryStepIds).toEqual([t.a]);
  expect([...wf.assignmentIds].sort()).toEqual([t.assignmentId, asg!.id].sort());
  // the originals are as they were
  expect((await get<S>(request, `steps/${t.a}`)).nextStepIds).toEqual([t.b]);

  // read again: the copies are drawn where they were pasted
  await page.reload();
  const again = documentPanel(page, t.workflow);
  await expect(node(again, copyA)).toBeVisible();
  const reread = await boxesById(again);
  expect([reread.get(copyA), reread.get(copyB)]).toEqual([now.get(copyA), now.get(copyB)]);
  await expect(page.getByText('● design draft')).toHaveCount(0);
  await shot(page, '2-saved-reread');
});

test('Backspace does nothing; Delete removes a pasted step, Undo brings it back, Redo removes it; Save deletes the entity', async ({ page, request }) => {
  const panel = await open(page);
  await node(panel, copyB).locator('.nx-sn').click();
  await expect(node(panel, copyB)).toHaveClass(/studio-pick/);
  const count = await panel.locator('.react-flow__node').count();
  await page.keyboard.press('Backspace');
  await expect(panel.locator('.react-flow__node')).toHaveCount(count);
  await expect(page.getByText('● design draft')).toHaveCount(0);

  await page.keyboard.press('Delete');
  await expect(node(panel, copyB)).toHaveCount(0);
  await expect(newWires(panel)).toHaveCount(0);
  await expect(panel.locator('.react-flow__edge-cable')).toHaveCount(2);
  await page.keyboard.press('Control+z');
  await expect(node(panel, copyB)).toBeVisible();
  await page.keyboard.press('Control+y');
  await expect(node(panel, copyB)).toHaveCount(0);
  await expect(page.getByText('● design draft')).toBeVisible();

  await save(page);
  await expect(await pane(page, 'Output')).toContainText('Saved and applied');
  expect((await request.get(`/api/v1/steps/${copyB}`)).status()).toBe(404);
  expect((await get<{ nextStepIds: string[] }>(request, `steps/${copyA}`)).nextStepIds).toEqual([]);
  const lines = await (await outputLines(page)).allTextContents();
  expect(lines.some((l) => l.includes(`step '${t.tag}-b' deleted`))).toBe(true);
});

test('keys typed in an Inspector field never copy, paste or delete', async ({ page }) => {
  const panel = await open(page);
  await node(panel, t.a).locator('.nx-sn').click();
  await expect(inspector(page).locator('.kindpill')).toHaveText('STEP');
  const count = await panel.locator('.react-flow__node').count();
  const field = inspector(page).getByLabel('Description', { exact: true });
  await field.click();
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  await page.keyboard.press('Delete');
  await page.keyboard.press('Backspace');
  await expect(panel.locator('.react-flow__node')).toHaveCount(count);
  await expect(node(panel, t.a)).toBeVisible();
  await expect(page.getByText('● design draft')).toHaveCount(0);
});

test('a group drag moves a picked hand-shaped wire\'s bends with the picked blocks; not picked, they stay', async ({ page }) => {
  const panel = await open(page);
  const id = `${t.a}->${t.b}`;
  // give a -> b a shape of its own: its run dragged down 48 px makes a U
  const p = await pointOnWire(panel, id);
  await page.mouse.click(p.x, p.y);
  const run = panel.locator(`.design-wire[data-wire="${id}"] .design-handle.seg`).first();
  const at = await centreOf(run);
  await drag(page, at, { x: at.x, y: at.y + 48 });
  const shaped = await upright(panel, id);

  // pick a, b and the wire; drag a two grid steps right and one down
  await node(panel, t.a).locator('.nx-sn').click();
  await node(panel, t.b).locator('.nx-sn').click({ modifiers: ['Control'] });
  const q = await pointOnWire(panel, id, 0.5);
  // the mouse's click takes no modifiers: Ctrl is held on the keyboard
  await page.keyboard.down('Control');
  await page.mouse.click(q.x, q.y);
  await page.keyboard.up('Control');
  await expect(edge(panel, id).locator('.wire.picked')).toHaveCount(1);
  await expect(inspector(page).getByText('3 items selected')).toBeVisible();
  const z = await zoomOf(panel);
  const startA = (await boxesById(panel)).get(t.a)!;
  const from = await centreOf(node(panel, t.a).locator('.nx-sn'));
  await pressTo(page, from, { x: from.x + 64 * z, y: from.y + 32 * z });
  await page.mouse.up();
  const movedA = (await boxesById(panel)).get(t.a)!;
  const d = { x: movedA.x - startA.x, y: movedA.y - startA.y };
  expect(d.x).toBeGreaterThan(0);
  await expect.poll(async () => (await upright(panel, id)).x).toBe(shaped.x + d.x);
  await shot(page, '3-group-drag');

  // the same drag with the wire not picked: its bends stay where they are
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await upright(panel, id)).x).toBe(shaped.x);
  await node(panel, t.a).locator('.nx-sn').click();
  await node(panel, t.b).locator('.nx-sn').click({ modifiers: ['Control'] });
  const from2 = await centreOf(node(panel, t.a).locator('.nx-sn'));
  await pressTo(page, from2, { x: from2.x + 64 * z, y: from2.y + 32 * z });
  await page.mouse.up();
  await expect.poll(async () => (await boxesById(panel)).get(t.a)!.x).toBe(movedA.x);
  expect((await upright(panel, id)).x).toBe(shaped.x);
});

test('copied in one workflow, the clipboard survives a refresh and pastes into another open workflow; Save creates the copy there', async ({ page, request }) => {
  const panel = await open(page);
  await node(panel, t.a).locator('.nx-sn').click();
  await page.keyboard.press('Control+c');
  const other = await open(page, t.other);
  // a refresh keeps the clipboard (with the session)
  await page.reload();
  const there = documentPanel(page, t.other);
  await expect(there.locator('.react-flow__node').first()).toBeVisible();
  await page.locator('.dv-tab .doctab').filter({ hasText: `${t.tag}-other` }).click();
  const before = await nodeIds(there);
  // focus the canvas with a click on its empty pane
  const pane0 = await box(there.locator('.react-flow__pane'));
  await page.mouse.click(pane0.x + pane0.width - 40, pane0.y + pane0.height - 40);
  await page.keyboard.press('Control+v');
  await expect(there.locator('.react-flow__node')).toHaveCount(before.length + 1);
  const pasted = await pastedNamed(there, before, `${t.tag}-a`);
  const now = await boxesById(there);
  for (const [id, b] of now) if (id !== pasted) expect(overlaps(now.get(pasted)!, b), `on ${id}`).toBe(false);
  await shot(page, '4-other-workflow');
  void other;

  await save(page);
  await expect(await pane(page, 'Output')).toContainText('Saved and applied');
  inOther = pasted;
  const s = await get<{ name: string; processorId: string }>(request, `steps/${pasted}`);
  expect([s.name, s.processorId]).toEqual([`${t.tag}-a`, t.processorId]);
  const [asg] = await assignmentsOf(request, pasted);
  expect(JSON.parse(asg!.payload)).toEqual({ k: 7 });
  expect((await get<{ assignmentIds: string[] }>(request, `workflows/${t.other.id}`)).assignmentIds).toEqual([asg!.id]);
});

test('a pasted cache keeps its root as copied: Save is refused for it until the Inspector gives it another (2026-10-22)', async ({ page, request }) => {
  const panel = await open(page);
  await node(panel, `cache:${t.cacheId}`).click();
  await expect(node(panel, `cache:${t.cacheId}`)).toHaveClass(/studio-pick/);
  const before = await nodeIds(panel);
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  await expect(panel.locator('.react-flow__node')).toHaveCount(before.length + 1);
  const made = (await nodeIds(panel)).find((id) => !before.includes(id))!;
  expect(made.startsWith('cache:')).toBe(true);
  const id = made.slice('cache:'.length);
  const now = await boxesById(panel);
  for (const [other, b] of now) if (other !== made) expect(overlaps(now.get(made)!, b), `on ${other}`).toBe(false);
  // the Inspector shows the original's root, editable
  await node(panel, made).click();
  const root = inspector(page).getByLabel('Root', { exact: true });
  await expect(root).toHaveValue(t.root);
  await shot(page, '6-cache-pasted');

  // BaseApi refuses a root another cache uses (and so the workflow's list naming it): nothing is created
  await save(page);
  await expect(await pane(page, 'Output')).toContainText('Saved; not applied: 2 errors');
  await expect(await problems(page)).toContainText(`Root '${t.root}' is already used by cache`);
  expect((await request.get(`/api/v1/caches/${id}`)).status()).toBe(404);

  // the user gives it its own root: Save creates it beside the original
  await node(panel, made).click();
  await root.click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type(`${t.root}-2`);
  await page.keyboard.press('Tab');
  await save(page);
  await expect(await pane(page, 'Output')).toContainText('Saved and applied');
  const c = await get<{ name: string; root: string }>(request, `caches/${id}`);
  expect([c.name, c.root]).toEqual([`${t.tag}-cache`, `${t.root}-2`]);
  expect([...(await get<{ cacheIds: string[] }>(request, `workflows/${t.workflow.id}`)).cacheIds].sort()).toEqual([t.cacheId, id].sort());
});

test('cut and paste across workflows: the copy keeps its assignment\'s own name, version and description though the original is deleted first', async ({ page, request }) => {
  const panel = await open(page);
  const [original] = await assignmentsOf(request, copyA);
  expect(original).toBeDefined();
  await node(panel, copyA).locator('.nx-sn').click();
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Delete');
  await expect(node(panel, copyA)).toHaveCount(0);
  await save(page);
  await expect(await pane(page, 'Output')).toContainText('Saved and applied');
  expect((await request.get(`/api/v1/assignments/${original!.id}`)).status()).toBe(404);

  const there = await open(page, t.other);
  const before = await nodeIds(there);
  const pane0 = await box(there.locator('.react-flow__pane'));
  await page.mouse.click(pane0.x + pane0.width - 40, pane0.y + pane0.height - 40);
  await page.keyboard.press('Control+v');
  await expect(there.locator('.react-flow__node')).toHaveCount(before.length + 1);
  const pasted = (await nodeIds(there)).find((x) => !before.includes(x))!;
  await save(page);
  await expect((await outputLines(page)).filter({ hasText: 'Saved and applied' })).toHaveCount(2);
  const [asg] = await assignmentsOf(request, pasted);
  expect([asg!.name, asg!.version, asg!.description, JSON.parse(asg!.payload)]).toEqual([`${t.tag}-asg`, '2.0.0', 'copied', { k: 7 }]);
});

test('Delete of a step another workflow uses: Save refuses it in red and the step stays', async ({ page, request }) => {
  const panel = await open(page);
  await node(panel, t.b).locator('.nx-sn').click();
  await page.keyboard.press('Delete');
  await expect(node(panel, t.b)).toHaveCount(0);
  await save(page);
  const out = await pane(page, 'Output');
  await expect(out).toContainText('Saved; not applied');
  const row = (await problems(page)).getByRole('listitem').filter({ hasText: `Not deleted: still used by workflow '${t.tag}-other'` });
  await expect(row).toHaveCount(1);
  // named as the workflow had it, though the drawing no longer holds it
  await expect(row).toContainText(`${t.tag}-b_1.0.0`);
  await expect(row.locator('.pd')).toHaveCSS('color', 'rgb(248, 113, 113)');
  const red = (await outputLines(page)).filter({ hasText: `step '${t.tag}-b': Not deleted` });
  await expect(red).toHaveCount(1);
  await expect(red).toHaveCSS('color', 'rgb(248, 113, 113)');
  // the drawing is the stored design: nothing for settling to put back
  expect((await (await outputLines(page)).allTextContents()).filter((l) => l.includes('wire added'))).toEqual([]);
  expect((await request.get(`/api/v1/steps/${t.b}`)).status()).toBe(200);
  expect((await get<{ nextStepIds: string[] }>(request, `steps/${t.a}`)).nextStepIds).toEqual([t.b]);
  await shot(page, '5-refused');
});

test('a delete kept through a refused Save and a reopen still carries the stamp it was loaded with: someone else\'s change conflicts', async ({ page, request }) => {
  // B, meanwhile: changes b and stops the other workflow from using it
  type S = { name: string; version: string; description: string | null; processorId: string; nextStepIds: string[]; entryCondition: number };
  const b = await get<S>(request, `steps/${t.b}`);
  const put = await request.put(`/api/v1/steps/${t.b}`, { data: { ...b, description: 'changed by B' } });
  expect(put.ok(), await put.text()).toBe(true);
  type W = { name: string; version: string; description: string | null; entryStepIds: string[]; assignmentIds: string[]; cacheIds: string[]; cronExpression: string | null };
  const o = await get<W>(request, `workflows/${t.other.id}`);
  const w = await request.put(`/api/v1/workflows/${t.other.id}`, { data: { ...o, entryStepIds: [inOther] } });
  expect(w.ok(), await w.text()).toBe(true);

  // A reopens the workflow (its stored design still deletes b) and saves again
  await open(page);
  await save(page);
  await expect(await pane(page, 'Output')).toContainText('Saved; not applied');
  const row = (await problems(page)).getByRole('listitem').filter({ hasText: 'changed by someone else since you opened it' });
  await expect(row).toHaveCount(1);
  expect((await get<S>(request, `steps/${t.b}`)).description).toBe('changed by B');
  await shot(page, '7-stale-delete');
});
