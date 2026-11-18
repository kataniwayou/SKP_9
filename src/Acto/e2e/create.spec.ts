import { test, expect } from './fixtures';
import {
  caNode, cacheEdge, cacheTool, drawCacheLink, drawEntry, drawWire, dropTool, entryEdge, field, inspector, openAt, outLine, regionPoint, renameTo,
  saveButton, stNode, toolbar, toolboxStep, PROC_A, PROC_B, wfNode, wireEdge, workflowTool, pickStep, selectWorkflowAlone,
} from './helpers';

// Spec §7: the toolbox drops (a triangle, a cache, a step), a wire, an entry arrow from the tip, a cache link from the back, and the
// refusals of duplicates. Nothing here is saved: no request reaches BaseAPI (the guard would fail the test).

const unsavedCount = async (page: import('@playwright/test').Page) => {
  const t = await saveButton(page).innerText();
  return t === 'Save' ? 0 : Number(/·\s*(\d+)/.exec(t)![1]);
};

test('the toolbox drops a triangle, a cache and a step where they are dropped, each unsaved and picked', async ({ page }) => {
  await openAt(page);
  const n0 = await unsavedCount(page);

  const wfAt = await regionPoint(page, { x: 100, y: 120 });
  const wf = await dropTool(page, workflowTool(page), 'workflow', wfAt);
  await expect(wfNode(page, wf).locator('.tri-nm')).toHaveText(/^new-workflow-\d+$/);
  // centred on the drop point
  const b = (await wfNode(page, wf).boundingBox())!;
  expect(Math.abs(b.x + b.width / 2 - wfAt.x)).toBeLessThan(3);
  expect(Math.abs(b.y + b.height / 2 - wfAt.y)).toBeLessThan(3);
  await expect(wfNode(page, wf).locator('.unsaved-mark')).toBeVisible();
  await expect(toolbar(page, 'workflow').getByRole('button')).toHaveText(['▶ Start', 'Delete']);
  await expect(field(page, 'Name')).toHaveValue(/^new-workflow-\d+$/);
  await expect(field(page, 'Version')).toHaveValue('1.0.0');
  await expect(field(page, 'Cron')).toHaveValue('');
  await expect(inspector(page)).toContainText('not scheduled');
  await expect(inspector(page)).toContainText('No assignments.');
  await expect(page.locator(`.react-flow__edge[data-id*="${wf}"]`)).toHaveCount(0);
  expect(await unsavedCount(page)).toBe(n0 + 1);

  const cache = await dropTool(page, cacheTool(page), 'cache', await regionPoint(page, { x: 150, y: 360 }));
  await expect(caNode(page, cache).locator('.cache-nm')).toHaveText(/^new-cache-\d+$/);
  await expect(field(page, 'Version')).toHaveValue('1.0.0');
  await expect(caNode(page, cache).locator('.unsaved-mark')).toBeVisible();
  await expect(toolbar(page, 'cache').getByRole('button')).toHaveText(['Delete']);
  expect(await unsavedCount(page)).toBe(n0 + 2);

  const step = await dropTool(page, toolboxStep(page, PROC_A), 'step', await regionPoint(page, { x: 450, y: 120 }));
  await expect(stNode(page, step).locator('.sp2')).toHaveText(PROC_A);
  await expect(stNode(page, step).locator('.unsaved-mark')).toBeVisible();
  await expect(toolbar(page, 'step').getByRole('button')).toHaveText(['Copy', 'Delete']);
  expect(await unsavedCount(page)).toBe(n0 + 3);

  // a second triangle and cache count up from the first
  const wf2 = await dropTool(page, workflowTool(page), 'workflow', await regionPoint(page, { x: 100, y: 260 }));
  const a = await wfNode(page, wf).locator('.tri-nm').innerText();
  const c = await wfNode(page, wf2).locator('.tri-nm').innerText();
  expect(Number(c.replace(/\D/g, ''))).toBe(Number(a.replace(/\D/g, '')) + 1);
  expect(await unsavedCount(page)).toBe(n0 + 4);
});

test('a wire from a step\'s right handle, an entry arrow from the triangle\'s tip and a cache link from its back', async ({ page }) => {
  await openAt(page);
  const wf = await dropTool(page, workflowTool(page), 'workflow', await regionPoint(page, { x: 90, y: 130 }));
  const s1 = await dropTool(page, toolboxStep(page, PROC_A), 'step', await regionPoint(page, { x: 400, y: 130 }));
  const s2 = await dropTool(page, toolboxStep(page, PROC_B), 'step', await regionPoint(page, { x: 700, y: 130 }));
  const cache = await dropTool(page, cacheTool(page), 'cache', await regionPoint(page, { x: 200, y: 360 }));
  await selectWorkflowAlone(page, wf);
  await renameTo(page, 'e2e-create-wf');
  const n0 = await (async () => { const t = await saveButton(page).innerText(); return Number(/·\s*(\d+)/.exec(t)![1]); })();

  // the wire s1 -> s2
  await drawWire(page, stNode(page, s1), stNode(page, s2));
  await expect(wireEdge(page, s1, s2)).toHaveCount(1);
  await expect(wireEdge(page, s1, s2).locator('.pill')).toBeVisible();

  // the entry arrow, tip -> s1: solid, from the triangle
  await drawEntry(page, wfNode(page, wf), stNode(page, s1));
  await expect(entryEdge(page, wf, s1)).toHaveCount(1);
  await selectWorkflowAlone(page, wf);
  await expect(inspector(page)).toContainText('Entry step');
  await expect(inspector(page)).toContainText(/Entry steps\s*archive-expander/);

  // the cache link, back -> cache: dashed, from the triangle
  await drawCacheLink(page, wfNode(page, wf), caNode(page, cache));
  await expect(cacheEdge(page, wf, cache)).toHaveCount(1);
  await expect(inspector(page)).toContainText(/Caches · 1\s*⛁ new-cache-\d+/);

  // a back handle onto a step, a tip onto a cache, a step's handle onto a cache or a triangle: no connection
  await drawCacheLink(page, wfNode(page, wf), stNode(page, s2));
  await drawEntry(page, wfNode(page, wf), caNode(page, cache));
  await drawWire(page, stNode(page, s2), caNode(page, cache));
  await drawWire(page, stNode(page, s2), wfNode(page, wf));
  await expect(entryEdge(page, wf, s2)).toHaveCount(0);
  await expect(cacheEdge(page, wf, s2)).toHaveCount(0);
  await expect(wireEdge(page, s2, cache)).toHaveCount(0);
  await expect(page.locator(`.react-flow__edge[data-id="entry:${wf}:${cache}"]`)).toHaveCount(0);

  // three links, each an edit: unsaved count up by the rows they changed (the step with the wire, the triangle with arrow and line)
  const t = await saveButton(page).innerText();
  expect(Number(/·\s*(\d+)/.exec(t)![1])).toBe(n0);
  await expect(wfNode(page, wf).locator('.unsaved-mark')).toBeVisible();
  await expect(stNode(page, s1).locator('.unsaved-mark')).toBeVisible();
});

test('a wire, an entry arrow or a cache link that is already there is refused with its message and adds nothing', async ({ page }) => {
  await openAt(page);
  const wf = await dropTool(page, workflowTool(page), 'workflow', await regionPoint(page, { x: 90, y: 130 }));
  await renameTo(page, 'e2e-dup-wf');
  const s1 = await dropTool(page, toolboxStep(page, PROC_A), 'step', await regionPoint(page, { x: 400, y: 130 }));
  await renameTo(page, 'e2e-dup-first');
  const s2 = await dropTool(page, toolboxStep(page, PROC_B), 'step', await regionPoint(page, { x: 700, y: 130 }));
  await renameTo(page, 'e2e-dup-second');
  const cache = await dropTool(page, cacheTool(page), 'cache', await regionPoint(page, { x: 200, y: 360 }));
  await renameTo(page, 'e2e-dup-cache');

  await drawWire(page, stNode(page, s1), stNode(page, s2));
  await drawEntry(page, wfNode(page, wf), stNode(page, s1));
  await drawCacheLink(page, wfNode(page, wf), caNode(page, cache));
  await expect(wireEdge(page, s1, s2)).toHaveCount(1);
  await expect(entryEdge(page, wf, s1)).toHaveCount(1);
  await expect(cacheEdge(page, wf, cache)).toHaveCount(1);
  await expect(page.locator('[data-panel="output"] .k-warn')).toHaveCount(0);

  await drawWire(page, stNode(page, s1), stNode(page, s2));
  await expect(outLine(page, 'That wire already exists')).toHaveCount(1);
  await drawEntry(page, wfNode(page, wf), stNode(page, s1));
  await expect(outLine(page, 'e2e-dup-wf already starts at e2e-dup-first')).toHaveCount(1);
  await drawCacheLink(page, wfNode(page, wf), caNode(page, cache));
  await expect(outLine(page, 'e2e-dup-wf already uses e2e-dup-cache')).toHaveCount(1);
  await expect(page.locator(`.react-flow__edge[data-id*="${wf}"]`)).toHaveCount(2);
  await expect(page.locator(`.react-flow__edge[data-id^="wire:${s1}"]`)).toHaveCount(1);
  // each refusal is a warning in Output
  await expect(page.locator('[data-panel="output"] .k-warn')).toHaveCount(3);
});

test('a second entry arrow from one triangle is allowed: only a repeat is refused', async ({ page }) => {
  await openAt(page);
  const wf = await dropTool(page, workflowTool(page), 'workflow', await regionPoint(page, { x: 90, y: 150 }));
  await renameTo(page, 'e2e-multi-wf');
  const s1 = await dropTool(page, toolboxStep(page, PROC_A), 'step', await regionPoint(page, { x: 400, y: 60 }));
  await renameTo(page, 'e2e-multi-a');
  const s2 = await dropTool(page, toolboxStep(page, PROC_B), 'step', await regionPoint(page, { x: 400, y: 280 }));
  await renameTo(page, 'e2e-multi-b');
  await drawEntry(page, wfNode(page, wf), stNode(page, s1));
  await drawEntry(page, wfNode(page, wf), stNode(page, s2));
  await expect(entryEdge(page, wf, s1)).toHaveCount(1);
  await expect(entryEdge(page, wf, s2)).toHaveCount(1);
  await pickStep(page, s1);
  await expect(page.locator('[data-panel="output"] .k-warn')).toHaveCount(0);
});
