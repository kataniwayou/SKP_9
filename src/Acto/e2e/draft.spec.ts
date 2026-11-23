import { test, expect } from './fixtures';
import {
  drawEntry, dropTool, field, ghost, openAt, outLine, pickStep, selbar, regionPoint, renameTo, save, saveButton, selectWorkflowAlone, stNode, toolbar,
  toolboxStep, validateStored, waitLoaded, wfNode, workflowTool, PROC_B,
} from './helpers';
import { seed } from './seed';
import { getJson, type Row } from './stack';

// The draft lives in localStorage; Save checks the design rules only and pushes the design as drawn; the orchestration rules
// (cycles, schema edges, payloads, liveness) are Start's [user, 2026-11-23, rev 2]. Nothing here presses Start or Stop.

test('an unsaved rename survives a reload, still unsaved and not in BaseAPI', async ({ page }) => {
  const id = await seed({
    steps: [{ key: 's', name: 'e2e-draft-one', at: { x: 300, y: 100 } }],
    workflows: [{ key: 'w', name: 'e2e-draft-wf', at: { x: 0, y: 30 }, entry: ['s'] }],
  });
  await openAt(page);
  await selectWorkflowAlone(page, id.w!);
  await field(page, 'Name').fill('e2e-draft-wf-renamed');
  await page.reload();
  await waitLoaded(page);
  await expect(wfNode(page, id.w!).locator('.tri-nm')).toHaveText('e2e-draft-wf-renamed');
  await expect(wfNode(page, id.w!).locator('.unsaved-mark')).toBeVisible();
  await expect(saveButton(page)).toContainText('Save ·');
  expect((await getJson<Row>(`/workflows/${id.w}`)).name).toBe('e2e-draft-wf');
});

test('a design with a cycle saves as drawn (free style); BaseAPI\'s workflow check names the cycle Start would refuse', async ({ page }) => {
  const id = await seed({
    steps: [
      { key: 's1', name: 'e2e-draft-one', at: { x: 300, y: 100 }, next: ['s2'] },
      { key: 's2', name: 'e2e-draft-two', at: { x: 600, y: 100 }, next: ['s1'] },
    ],
    workflows: [{ key: 'w', name: 'e2e-draft-wf', at: { x: 0, y: 30 }, entry: ['s1'] }],
  });
  await openAt(page);
  await selectWorkflowAlone(page, id.w!);
  await field(page, 'Name').fill('e2e-draft-wf-renamed');
  const answer = await save(page);
  expect(answer.applied).toBe(true);
  expect((await getJson<Row>(`/workflows/${id.w}`)).name).toBe('e2e-draft-wf-renamed');
  // Save set no problem count: that is Start's
  await expect(wfNode(page, id.w!).locator('.tri-problems')).toHaveCount(0);
  expect((await validateStored(id.w!)).problems.some((p) => p.gate === 'cycle')).toBe(true);
});

test('a new triangle\'s Start is disabled until it is saved', async ({ page }) => {
  await openAt(page);
  const wf = await dropTool(page, workflowTool(page), 'workflow', await regionPoint(page, { x: 90, y: 130 }));
  await renameTo(page, 'e2e-draft-new');
  const step = await dropTool(page, toolboxStep(page, PROC_B), 'step', await regionPoint(page, { x: 400, y: 130 }));
  await renameTo(page, 'e2e-draft-new-step');
  await drawEntry(page, wfNode(page, wf), stNode(page, step));
  await selectWorkflowAlone(page, wf);
  await expect(toolbar(page, 'workflow').getByRole('button', { name: '▶ Start' })).toBeDisabled();
  const answer = await save(page);
  expect(answer.applied).toBe(true);
  const saved = answer.made![wf]!;
  await selectWorkflowAlone(page, saved);
  await expect(wfNode(page, saved).locator('.tri-st[data-status="stopped"]')).toBeVisible();
  await expect(toolbar(page, 'workflow').getByRole('button', { name: '▶ Start' })).toBeEnabled();
});

test('a deleted step stays a ghost across a reload, still waiting for Save', async ({ page }) => {
  const id = await seed({ steps: [{ key: 's', name: 'e2e-draft-lone', at: { x: 300, y: 100 } }] });
  await openAt(page);
  await pickStep(page, id.s!);
  await toolbar(page, 'step').getByRole('button', { name: 'Delete' }).click();
  await expect(stNode(page, id.s!)).toHaveCount(0);
  await expect(ghost(page, 'e2e-draft-lone')).toHaveCount(1);
  await page.reload();
  await waitLoaded(page);
  await expect(ghost(page, 'e2e-draft-lone')).toHaveCount(1);
  await expect(stNode(page, id.s!)).toHaveCount(0);
  await expect(saveButton(page)).toContainText('Save · 1');
});

test('a refused Start lists every problem BaseAPI\'s check names and puts the count on the triangle (the Start is answered here, never sent)', async ({ page }) => {
  const id = await seed({
    steps: [
      { key: 's1', name: 'e2e-draft-one', at: { x: 300, y: 100 }, next: ['s2'] },
      { key: 's2', name: 'e2e-draft-two', at: { x: 600, y: 100 }, next: ['s1'] },
    ],
    workflows: [{ key: 'w', name: 'e2e-draft-wf', at: { x: 0, y: 30 }, entry: ['s1'] }],
  });
  // a later route wins over the guard's: BaseAPI never sees a start
  await page.route('**/api/v1/orchestration/start', (route) => route.fulfill({
    status: 422, contentType: 'application/problem+json', json: { title: 'Workflow contains a cycle', detail: 'Workflow contains a cycle', status: 422 },
  }));
  await openAt(page);
  await expect(wfNode(page, id.w!).locator('.tri-st[data-status="stopped"]')).toBeVisible();
  await selectWorkflowAlone(page, id.w!);
  const checked = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/v1/workflows/${id.w}/validate`);
  await toolbar(page, 'workflow').getByRole('button', { name: '▶ Start' }).click();
  await checked;
  const truth = (await validateStored(id.w!)).problems;
  expect(truth.some((p) => p.gate === 'cycle')).toBe(true);
  await expect(outLine(page, /^e2e-draft-wf: Start refused — /)).toHaveCount(1);
  for (const p of truth) await expect(outLine(page, `e2e-draft-wf: ${p.title ?? p.gate} — ${p.detail ?? ''}`)).toHaveCount(1);
  await expect(wfNode(page, id.w!).locator('.tri-problems')).toHaveText(String(truth.length));
});

test('the bar\'s Start is disabled while a picked triangle was never saved', async ({ page }) => {
  const id = await seed({
    steps: [{ key: 's', name: 'e2e-draft-one', at: { x: 300, y: 100 } }],
    workflows: [{ key: 'w', name: 'e2e-draft-wf', at: { x: 0, y: 30 }, entry: ['s'] }],
  });
  await openAt(page);
  const fresh = await dropTool(page, workflowTool(page), 'workflow', await regionPoint(page, { x: 90, y: 260 }));
  await expect(wfNode(page, id.w!).locator('.tri-st[data-status="stopped"]')).toBeVisible();
  await wfNode(page, id.w!).locator('.tri-nm').click();
  await wfNode(page, fresh).locator('.tri-nm').click({ modifiers: ['Control'] });
  await expect(selbar(page).getByRole('button', { name: '▶ Start' })).toBeDisabled();
  // the saved one alone: Start is there and enabled
  await wfNode(page, fresh).locator('.tri-nm').click({ modifiers: ['Control'] });
  await expect(toolbar(page, 'workflow').getByRole('button', { name: '▶ Start' })).toBeEnabled();
});
