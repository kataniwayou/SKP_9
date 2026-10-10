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

test('the workflow and a processor: saved values shown at once; Discard shows the base again', async ({ page, request }) => {
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

  // an unsaved edit, then Discard design: the base (what BaseApi holds) again
  await typeInto(page, 'Description', 'not kept');
  await expect(field(page, 'Description')).toHaveValue('not kept');
  await page.getByRole('button', { name: 'Discard design' }).click();
  await page.getByRole('alertdialog', { name: 'Discard design' }).getByRole('button', { name: 'Discard' }).click();
  await expect(field(page, 'Description')).toHaveValue('saved proc text');
  await expect(unsaved(page)).toHaveCount(0);
});
