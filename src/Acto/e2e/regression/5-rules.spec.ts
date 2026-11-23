import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import {
  dropTool, field, ghost, openAt, openFitted, outLine, pickStep, regionPoint, save, saveButton, selbar, selectWorkflowAlone, stNode,
  toolbar, wfNode, workflowTool,
} from '../helpers';
import { seed } from '../seed';
import { getJson, type Row } from '../stack';

// Regression 5 (user, 2026-11-23): the design rules (Save), the workflow-state rules and the orchestration rules (Start), driven
// in the browser. A running workflow is never made here: the cases that need one use a workflow the cluster already runs, and
// write nothing (Delete is refused before any request; Start/Stop answers are given in the browser, never sent).

/** A triangle the cluster runs now, by its id (the board fitted so it is drawn). */
async function runningWorkflow(page: Page): Promise<string> {
  const tri = page.locator('.react-flow__node-workflow:has(.tri-st[data-status="running"])').first();
  await expect(tri, 'the cluster runs at least one workflow').toBeVisible({ timeout: 15_000 });
  return (await tri.getAttribute('data-id'))!.replace(/^wf:/, '');
}

const cycle = {
  steps: [
    { key: 's1', name: 'e2e-rule-one', at: { x: 300, y: 100 }, next: ['s2'] },
    { key: 's2', name: 'e2e-rule-two', at: { x: 600, y: 100 }, next: ['s1'] },
  ],
  workflows: [{ key: 'w', name: 'e2e-rule-wf', at: { x: 0, y: 30 }, entry: ['s1'] }],
};

test('state rule: Delete on a running workflow deletes nothing, sends nothing, and Output says to stop it first', async ({ page }) => {
  await openFitted(page);
  const wf = await runningWorkflow(page);
  const name = await wfNode(page, wf).locator('.tri-nm').innerText();
  const writes: string[] = [];
  page.on('request', (r) => { if (r.method() !== 'GET' && r.url().includes('/api/')) writes.push(r.url()); });
  await selectWorkflowAlone(page, wf);
  await toolbar(page, 'workflow').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(outLine(page, `${name} is running — stop it first`)).toHaveCount(1);
  await expect(wfNode(page, wf)).toBeVisible();
  await expect(saveButton(page)).toHaveText('Save');
  expect(writes).toEqual([]);
});

test('state rule: a pick of a running workflow and an e2e step deletes nothing at all', async ({ page }) => {
  const id = await seed({ steps: [{ key: 's', name: 'e2e-rule-lone', at: { x: 300, y: 100 } }] });
  await openFitted(page);
  const wf = await runningWorkflow(page);
  const name = await wfNode(page, wf).locator('.tri-nm').innerText();
  await wfNode(page, wf).locator('.tri-nm').click();
  await stNode(page, id.s!).locator('.sn').click({ modifiers: ['Control'] });
  await selbar(page).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(outLine(page, `${name} is running — stop it first`)).toHaveCount(1);
  await expect(stNode(page, id.s!)).toBeVisible();
  await expect(wfNode(page, wf)).toBeVisible();
});

test('state rule: a running workflow offers Stop, a stopped one Start, a never-saved one a disabled Start', async ({ page }) => {
  const id = await seed(cycle);
  await openFitted(page);
  const running = await runningWorkflow(page);
  await selectWorkflowAlone(page, running);
  await expect(toolbar(page, 'workflow').getByRole('button', { name: '■ Stop' })).toBeEnabled();
  await selectWorkflowAlone(page, id.w!);
  await expect(wfNode(page, id.w!).locator('.tri-st[data-status="stopped"]')).toBeVisible();
  await expect(toolbar(page, 'workflow').getByRole('button', { name: '▶ Start' })).toBeEnabled();
  await openAt(page);
  const fresh = await dropTool(page, workflowTool(page), 'workflow', await regionPoint(page, { x: 90, y: 300 }));
  await selectWorkflowAlone(page, fresh);
  await expect(toolbar(page, 'workflow').getByRole('button', { name: '▶ Start' })).toBeDisabled();
});

test('orchestration rule: a refused Start sets the count, an edit of the workflow clears it, an accepted Start clears it too', async ({ page }) => {
  const id = await seed(cycle);
  let answer: 422 | 200 = 422;
  await page.route('**/api/v1/orchestration/start', (route) => route.fulfill(answer === 422
    ? { status: 422, contentType: 'application/problem+json', json: { title: 'Workflow contains a cycle', detail: 'Workflow contains a cycle', status: 422 } }
    : { status: 202, body: '' }));
  await openAt(page);
  await expect(wfNode(page, id.w!).locator('.tri-st[data-status="stopped"]')).toBeVisible();
  await selectWorkflowAlone(page, id.w!);
  await toolbar(page, 'workflow').getByRole('button', { name: '▶ Start' }).click();
  const badge = wfNode(page, id.w!).locator('.tri-problems');
  await expect(badge).toBeVisible();
  // an edit of the workflow: the count no longer describes it
  await field(page, 'Description').fill('edited after the refusal');
  await expect(badge).toHaveCount(0);
  // refused again, then accepted: the accepted Start clears the count
  await toolbar(page, 'workflow').getByRole('button', { name: '▶ Start' }).click();
  await expect(badge).toBeVisible();
  answer = 200;
  await toolbar(page, 'workflow').getByRole('button', { name: '▶ Start' }).click();
  await expect(outLine(page, 'e2e-rule-wf: Start requested').last()).toBeVisible();
  await expect(badge).toHaveCount(0);
});

test('save rule: with nothing changed Save says so; a pushed delete leaves its ghost; the push changed only what was drawn', async ({ page }) => {
  const id = await seed({ steps: [{ key: 's', name: 'e2e-rule-lone', at: { x: 300, y: 100 } }, { key: 't', name: 'e2e-rule-other', at: { x: 300, y: 260 } }] });
  await openAt(page);
  await expect(saveButton(page)).toBeDisabled();
  await pickStep(page, id.s!);
  await toolbar(page, 'step').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(ghost(page, 'e2e-rule-lone')).toHaveCount(1);
  const answer = await save(page);
  expect(answer.applied).toBe(true);
  await expect(outLine(page, 'Pushed 1 change')).toHaveCount(1);
  await expect(ghost(page, 'e2e-rule-lone'), 'the ghost belongs to the draft: it stays after the push').toHaveCount(1);
  const names = (await getJson<Row[]>('/steps')).map((s) => s.name);
  expect(names).not.toContain('e2e-rule-lone');
  expect(names).toContain('e2e-rule-other');
  await expect(saveButton(page)).toBeDisabled();
});

test('item 4: a wire into a Never step moves while its workflow runs (an unsaved edit on a running workflow, never saved)', async ({ page }) => {
  await openFitted(page);
  await runningWorkflow(page);
  const edge = page.locator('.react-flow__edge:has(.link-wire .wire.running)').first();
  await expect(edge).toBeAttached();
  const to = (await edge.getAttribute('data-id'))!.split(':')[2]!;
  const eid = (await edge.getAttribute('data-id'))!;
  await stNode(page, to).locator('.sn').click();
  await page.getByRole('combobox').first().click();
  await page.getByRole('option', { name: /Never/ }).click();
  const wire = page.locator(`.react-flow__edge[data-id="${eid}"] .link-wire`);
  await expect(wire).toHaveAttribute('data-condition', 'Never');
  await expect(wire.locator('.wire')).toHaveClass(/\brunning\b/);
  expect(await wire.locator('.wire').evaluate((w) => getComputedStyle(w).animationName)).toBe('wire-flow');
});
