import type { Locator, Page } from '@playwright/test';
import { documentPanel, get, inspector, node, openWorkflow, save } from './studio';
import { createThrowaway, expect, removeThrowaway, test, type Throwaway } from './throwaway';

// The Inspector shows the design graph's entity (the user's ruling, 2026-10-10): an unsaved edit at once, and after a
// Save what BaseApi holds, with no re-pick (it used to keep the values from before the Save). Real mouse and keyboard;
// writes only Save of this run's throwaway (`e2e-8-…`). The tests build on each other's state, so they run in order.
test.describe.configure({ mode: 'serial', retries: 0 });
let t: Throwaway;
test.beforeAll(async ({ request }) => { t = await createThrowaway(request); });
test.afterAll(async ({ request }) => { await removeThrowaway(request); });
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
});

const SHOTS = process.env.OUTPUT_SHOTS;
const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };
const field = (page: Page, label: string): Locator => inspector(page).getByLabel(label, { exact: true });
const pill = (page: Page): Locator => inspector(page).locator('.kindpill');
const unsaved = (page: Page): Locator => inspector(page).getByText('● unsaved changes');

async function typeInto(page: Page, label: string, text: string): Promise<void> {
  await field(page, label).click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type(text);
}

async function open(page: Page): Promise<Locator> {
  await openWorkflow(page, t.workflow);
  return documentPanel(page, t.workflow);
}

const pickStep = async (page: Page, panel: Locator) => {
  await node(panel, t.stepId).click({ position: { x: 20, y: 12 } });
  await expect(pill(page)).toHaveText('STEP');
};

test('a step: the edit shows at once; after Save the Inspector shows what BaseApi holds without a re-pick; a refresh too', async ({ page, request }) => {
  const panel = await open(page);
  await pickStep(page, panel);
  await typeInto(page, 'Description', 'saved step text');
  await expect(field(page, 'Description')).toHaveValue('saved step text');
  await expect(unsaved(page)).toBeVisible();

  await save(page);
  expect((await get<{ description: string }>(request, `steps/${t.stepId}`)).description).toBe('saved step text');
  await expect(pill(page)).toHaveText('STEP');
  await expect(field(page, 'Description')).toHaveValue('saved step text');
  await expect(unsaved(page)).toHaveCount(0);
  await shot(page, '7-inspector-after-save');

  await page.reload();
  const again = documentPanel(page, t.workflow);
  await expect(again.locator('.react-flow__node').first()).toBeVisible();
  await pickStep(page, again);
  await expect(field(page, 'Description')).toHaveValue('saved step text');
});

test('the workflow and a processor: saved values shown at once; Revert shows the base again', async ({ page, request }) => {
  const panel = await open(page);
  await panel.locator('.react-flow__node-workflow').click();
  await expect(pill(page)).toHaveText('WORKFLOW');
  await typeInto(page, 'Description', 'saved wf text');
  await save(page);
  expect((await get<{ description: string }>(request, `workflows/${t.workflow.id}`)).description).toBe('saved wf text');
  await expect(pill(page)).toHaveText('WORKFLOW');
  await expect(field(page, 'Description')).toHaveValue('saved wf text');
  await expect(unsaved(page)).toHaveCount(0);

  await pickStep(page, panel);
  await inspector(page).locator('.field').filter({ hasText: 'Processor' }).getByRole('button').click();
  await expect(pill(page)).toHaveText('PROCESSOR');
  await typeInto(page, 'Description', 'saved proc text');
  await save(page);
  expect((await get<{ description: string }>(request, `processors/${t.processorId}`)).description).toBe('saved proc text');
  await expect(pill(page)).toHaveText('PROCESSOR');
  await expect(field(page, 'Description')).toHaveValue('saved proc text');
  await expect(unsaved(page)).toHaveCount(0);

  // an unsaved edit, then the Inspector's Revert: the base (what BaseApi holds) again
  await typeInto(page, 'Description', 'not kept');
  await expect(field(page, 'Description')).toHaveValue('not kept');
  await inspector(page).getByRole('button', { name: 'Revert' }).click();
  await expect(field(page, 'Description')).toHaveValue('saved proc text');
  await expect(unsaved(page)).toHaveCount(0);
});

test('rename a step, Save, rename it straight back and Save again: both applied, no "changed by someone else"', async ({ page, request }) => {
  const panel = await open(page);
  const original = `${t.tag}-b`;
  const read = page.waitForResponse((r) => r.request().method() === 'GET' && r.url().endsWith(`/steps/${t.stepBId}`));
  await node(panel, t.stepBId).click({ position: { x: 20, y: 12 } });
  await expect(pill(page)).toHaveText('STEP');
  await read;
  // from here the step's own GET fails: the Inspector's read stays the one from before the Save (the review's case)
  await page.route(`**/api/v1/steps/${t.stepBId}`, (r) => (r.request().method() === 'GET' ? r.abort() : r.fallback()));

  await typeInto(page, 'Name', `${original}2`);
  await save(page);
  await expect(inspector(page).getByText(/^Could not read it\./)).toBeVisible();
  expect((await get<{ name: string }>(request, `steps/${t.stepBId}`)).name).toBe(`${original}2`);
  await expect(field(page, 'Name')).toHaveValue(`${original}2`);

  // straight away, no re-pick: back to the old name (a change against what BaseApi now holds, with its new stamp)
  await typeInto(page, 'Name', original);
  await expect(unsaved(page)).toBeVisible();
  await save(page);
  expect((await get<{ name: string }>(request, `steps/${t.stepBId}`)).name).toBe(original);
  await expect(field(page, 'Name')).toHaveValue(original);
  await expect(unsaved(page)).toHaveCount(0);
  const output = page.locator('[data-pane="output"]');
  await expect(output.getByRole('log').locator('.outl').filter({ hasText: /^.*Saved and applied$/ })).toHaveCount(2);
  await expect(output.getByRole('log')).not.toContainText('changed by someone else');
  await expect(output.getByRole('list', { name: 'Problems' })).toHaveCount(0);
});

test('removing a step\'s assignment is an Undo step (2026-10-23): Undo brings it back, Redo removes it again, a refresh keeps both', async ({ page, request }) => {
  const panel = await open(page);
  await pickStep(page, panel);
  const assignment = inspector(page).locator('.field').filter({ hasText: 'Assignment' });
  const undo = page.getByRole('button', { name: '↶ Undo' }), redo = page.getByRole('button', { name: '↷ Redo' });
  await expect(assignment.getByRole('button', { name: '✕ Remove' })).toBeVisible();
  await expect(undo).toBeDisabled();

  await assignment.getByRole('button', { name: '✕ Remove' }).click();
  await expect(assignment.getByRole('button', { name: '＋ Create' })).toBeVisible();
  await expect(page.getByText('● design draft')).toBeVisible();

  await undo.click();
  await expect(assignment.getByRole('button', { name: '✕ Remove' })).toBeVisible();
  await expect(page.getByText('● design draft')).toHaveCount(0);
  await redo.click();
  await expect(assignment.getByRole('button', { name: '＋ Create' })).toBeVisible();

  // the refresh keeps the removal and its Undo step
  await page.reload();
  const again = documentPanel(page, t.workflow);
  await expect(again.locator('.react-flow__node').first()).toBeVisible();
  await pickStep(page, again);
  await expect(assignment.getByRole('button', { name: '＋ Create' })).toBeVisible();
  await undo.click();
  await expect(assignment.getByRole('button', { name: '✕ Remove' })).toBeVisible();
  await expect(page.getByText('● design draft')).toHaveCount(0);
  // nothing was saved: BaseApi still has the assignment
  expect((await get<{ assignmentIds: string[] }>(request, `workflows/${t.workflow.id}`)).assignmentIds).toContain(t.assignmentId);
});
