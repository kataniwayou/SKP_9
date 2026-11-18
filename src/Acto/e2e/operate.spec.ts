import { test, expect } from './fixtures';
import {
  allSteps, clearOutput, dropTool, field, inspector, openAt, openFitted, outLine, pickStep, pickWorkflow, regionPoint, selbar, stNode, toolbar, toolboxStep,
  wfNode, workflowTool, PROC_A,
} from './helpers';
import { seed } from './seed';
import { getJson, type Row } from './stack';

// Copy and paste of steps (toolbar Copy, the bar's Copy, Ctrl+V), and Start and Stop: pressed only on a workflow that was never saved. A real
// workflow's toolbar is looked at, never pressed (and the guard in fixtures.ts aborts any Start or Stop request that is sent).

const SEED = {
  steps: [
    { key: 's1', name: 'e2e-op-first', at: { x: 300, y: 100 }, next: ['s2'], condition: 3 },
    { key: 's2', name: 'e2e-op-second', at: { x: 600, y: 100 } },
  ],
  payloads: [{ key: 'p', step: 's1', payload: '{"copy": "me"}' }],
  workflows: [{ key: 'w', name: 'e2e-op-wf', at: { x: 0, y: 30 }, entry: ['s1'], payloads: ['p'] }],
} as const;

test('Copy from the step toolbar and from the bar; Ctrl+V pastes new steps with the wires among them, shared fields and no payload, and picks what it pasted', async ({ page }) => {
  const id = await seed(SEED);
  await openAt(page);
  // nothing copied yet
  await page.keyboard.press('Control+v');
  await expect(outLine(page, 'Nothing copied yet')).toHaveCount(1);
  const steps0 = await allSteps(page).count();

  // the step toolbar's Copy: one step
  await pickStep(page, id.s1!);
  await toolbar(page, 'step').getByRole('button', { name: 'Copy' }).click();
  await expect(outLine(page, 'Copied 1 step')).toHaveCount(1);
  // two picked steps and the bar's Copy: the steps and the wire between them
  await pickStep(page, id.s2!, true);
  await selbar(page).getByRole('button', { name: 'Copy' }).click();
  await expect(outLine(page, 'Copied 2 steps and 1 wire')).toHaveCount(1);

  await clearOutput(page);
  await page.keyboard.press('Control+v');
  await expect(outLine(page, 'Pasted 2 steps')).toHaveCount(1);
  await expect(allSteps(page)).toHaveCount(steps0 + 2);
  // they are picked, numbered, unsaved, named apart from the originals, and wired like the originals
  await expect(selbar(page).locator('.selbar-pill')).toHaveText('2 SELECTED');
  const copies = page.locator('.react-flow__node-step').filter({ hasText: /e2e-op-(first|second)-2/ });
  await expect(copies).toHaveCount(2);
  await expect(copies.locator('.unsaved-mark')).toHaveCount(2);
  await expect(copies.locator('.pick-no')).toHaveText(['1', '2']);
  const names = await copies.locator('.sn').allInnerTexts();
  expect(names.sort()).toEqual(['e2e-op-first-2', 'e2e-op-second-2']);
  const wires = await page.locator('.react-flow__edge[data-id^="wire:"]').evaluateAll((es) => es.map((e) => (e as HTMLElement).dataset.id!));
  const copyIds = await copies.evaluateAll((ns) => ns.map((n) => (n as HTMLElement).dataset.id!.replace(/^st:/, '')));
  expect(wires.filter((w) => copyIds.some((c) => w.startsWith(`wire:${c}:`)) && copyIds.some((c) => w.endsWith(`:${c}`)))).toHaveLength(1);
  // not on top of the originals
  const boxes = await Promise.all([stNode(page, id.s1!), stNode(page, id.s2!), copies.first(), copies.nth(1)].map(async (l) => (await l.boundingBox())!));
  for (let i = 0; i < 2; i++) for (let j = 2; j < 4; j++) {
    const a = boxes[i]!, b = boxes[j]!;
    expect(a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height, 'a copy overlaps an original').toBe(false);
  }
  // the entry condition came with them; the payload did not (and the copies belong to no workflow)
  await pickStep(page, copyIds[0]!);
  await expect(field(page, /^Entry condition/)).toBeEnabled();
  await expect(inspector(page)).toContainText('used by no workflow');
  await expect(field(page, 'Payload · JSON')).toHaveCount(0);
  // a second paste goes further along; the original steps are untouched
  await page.keyboard.press('Control+v');
  await expect(allSteps(page)).toHaveCount(steps0 + 4);
  await expect(stNode(page, id.s1!).locator('.sn')).toHaveText('e2e-op-first');
  // nothing was saved
  expect((await getJson<Row[]>('/steps')).filter((s) => s.name.startsWith('e2e-op-')).map((s) => s.name).sort()).toEqual(['e2e-op-first', 'e2e-op-second']);
});

test('Start and Stop: a real workflow\'s toolbar offers the right one for its state (never pressed)', async ({ page, request, stack }) => {
  const live = new Set(((await (await request.get('/api/v1/orchestration/live')).json()) as string[]).map((x) => x.toLowerCase()));
  const real = stack.workflows.map((w) => ({ ...w, running: live.has(w.id.toLowerCase()) }));
  await openFitted(page);
  const tb = toolbar(page, 'workflow');
  const stopped = real.find((w) => !w.running);
  const running = real.find((w) => w.running);
  if (stopped) {
    await pickWorkflow(page, stopped.id);
    await expect(wfNode(page, stopped.id).locator('.tri-st')).toHaveText('■ stopped');
    await expect(tb.getByRole('button', { name: '▶ Start', exact: true })).toBeEnabled();
    await expect(tb.getByRole('button', { name: '■ Stop', exact: true })).toHaveCount(0);
    await expect(tb.getByRole('button', { name: 'Delete', exact: true })).toBeVisible();
    await expect(tb.getByRole('button', { name: 'Save' })).toHaveCount(0); // Save is the board's one button, not a triangle's
  } else test.info().annotations.push({ type: 'skipped', description: 'no stopped workflow on the stack' });
  if (running) {
    await pickWorkflow(page, running.id);
    await expect(wfNode(page, running.id).locator('.tri-st')).toHaveText('● running');
    await expect(tb.getByRole('button', { name: '■ Stop', exact: true })).toBeEnabled();
    await expect(tb.getByRole('button', { name: '▶ Start', exact: true })).toHaveCount(0);
  } else test.info().annotations.push({ type: 'skipped', description: 'no running workflow on the stack' });
  // several triangles never multi-select: no bar
  if (stopped && running) {
    await pickWorkflow(page, stopped.id);
    await wfNode(page, running.id).locator('.tri-nm').click({ modifiers: ['Control'] });
    await expect(selbar(page)).toHaveCount(0);
  }
});

test('Start on a never-saved workflow says it is not saved yet and sends nothing', async ({ page }) => {
  await openAt(page);
  const sent: string[] = [];
  page.on('request', (r) => { if (r.method() !== 'GET' && r.url().includes('/api/')) sent.push(`${r.method()} ${new URL(r.url()).pathname}`); });
  const wf = await dropTool(page, workflowTool(page), 'workflow', await regionPoint(page, { x: 90, y: 130 }));
  const step = await dropTool(page, toolboxStep(page, PROC_A), 'step', await regionPoint(page, { x: 450, y: 130 }));
  void step;
  const name = await wfNode(page, wf).locator('.tri-nm').innerText();
  await pickWorkflow(page, wf);
  const start = toolbar(page, 'workflow').getByRole('button', { name: '▶ Start', exact: true });
  await expect(start).toBeVisible();
  await expect(toolbar(page, 'workflow').getByRole('button', { name: '■ Stop', exact: true })).toHaveCount(0);
  await expect(start).toBeEnabled();
  await start.click();
  await expect(outLine(page, `${name}: not saved yet — BaseAPI has no such workflow`)).toHaveCount(1);
  expect(sent).toEqual([]);
});
