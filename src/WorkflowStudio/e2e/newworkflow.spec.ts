import type { Locator, Page } from '@playwright/test';
import { box, documentPanel, get, inspector, newWire, node, openWorkflow, pane, save, type Pt } from './studio';
import { createThrowaway, expect, removeThrowaway, test, type Throwaway } from './throwaway';

// Workspace › New workflow (the user's decisions, 2026-10-10), with the real mouse and keyboard: a blank document with only
// the hub on the left, a workflow that exists only in the studio until its first Save creates it in BaseApi. Only this
// run's throwaway entities are written (`e2e-8-…`); the guard lets a Save through only for a new workflow named after the
// run's tag. The tests share the throwaway, so they run in order.
test.describe.configure({ mode: 'serial', retries: 0 });
let t: Throwaway;
test.beforeAll(async ({ request }) => { t = await createThrowaway(request); });
test.afterAll(async ({ request }) => { await removeThrowaway(request); });
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
});

const SHOTS = process.env.NEWWORKFLOW_SHOTS;
const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };

const menu = (page: Page, name: string | RegExp) => page.getByRole('menuitem', { name });
/** The new workflow's document: its crumb names it untitled (the base name; the Inspector's rename is a design edit). */
const newPanel = (page: Page): Locator => page.locator('.docpanel').filter({ has: page.locator('.crumb[data-tip^="untitled"]') });
const pill = (page: Page) => inspector(page).locator('.kindpill');
const field = (page: Page, label: string) => inspector(page).getByLabel(label, { exact: true });

async function typeInto(page: Page, label: string, text: string): Promise<void> {
  await field(page, label).click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type(text);
}

/** Workspace › New workflow with the real mouse: the new document's panel. */
async function newWorkflow(page: Page): Promise<Locator> {
  await menu(page, 'Workspace').click();
  const item = menu(page, /^\W*New\b/);
  await expect(item).toContainText('Ctrl+N');
  await item.click();
  const panel = newPanel(page);
  await expect(panel.locator('.react-flow__node-workflow')).toBeVisible();
  return panel;
}

/** The new workflow's id, as the session keeps it. */
const newId = (page: Page) => page.evaluate(() => {
  const s = JSON.parse(sessionStorage.getItem('skp.studio.session') ?? '{}') as { docs?: { workflowId: string; virtual?: boolean }[] };
  return s.docs?.find((d) => d.virtual)?.workflowId ?? null;
});

/** Copies step a of the throwaway and pastes it into the new workflow's canvas, then wires the hub to it: its entry step. */
async function pasteAndWire(page: Page, panel: Locator): Promise<string> {
  const source = documentPanel(page, t.workflow);
  await openWorkflow(page, t.workflow);
  await node(source, t.stepId).locator('.nx-sn').click();
  await page.keyboard.press('Control+c');
  await page.locator('.dv-tab .doctab').filter({ hasText: 'untitled' }).click();
  const area = await box(panel.locator('.react-flow__pane'));
  await page.mouse.click(area.x + area.width - 60, area.y + area.height - 60);
  await page.keyboard.press('Control+v');
  const pasted = panel.locator('.react-flow__node-step');
  await expect(pasted).toHaveCount(1);
  const id = (await pasted.getAttribute('data-id'))!;
  // the hub's wire into the pasted step's input: dropped on its left edge
  const b = await box(node(panel, id));
  const target: Pt = { x: b.x + 2, y: b.y + b.height / 2 };
  await newWire(page, panel, 'wf', target);
  return id;
}

test('New: a blank document with the hub on the left; renamed in the Inspector; Start and Delete wait; a refresh keeps it; Save creates it with a pasted step', async ({ page, request }) => {
  const panel = await newWorkflow(page);
  // only the hub, on the left of the canvas
  await expect(panel.locator('.react-flow__node')).toHaveCount(1);
  const hub = await box(panel.locator('.react-flow__node-workflow'));
  const area = await box(panel.locator('.react-flow__pane'));
  expect(hub.x - area.x).toBeLessThan(area.width / 3);
  await expect(page.locator('.dv-tab .doctab').filter({ hasText: 'untitled' })).toBeVisible();
  await shot(page, '1-new');

  // not in BaseApi yet: Start, Stop and Delete workflow wait for the first Save
  await expect(panel.getByRole('button', { name: /Start/ })).toBeDisabled();
  await expect(panel.getByRole('button', { name: /Stop/ })).toBeDisabled();
  await expect(panel.getByRole('button', { name: /Start/ }).locator('..')).toHaveAttribute('data-tip', 'Not saved yet: BaseApi has no such workflow');
  await menu(page, 'Workspace').click();
  await expect(menu(page, /Delete…/)).toBeDisabled();
  await page.keyboard.press('Escape');

  // renamed in the Inspector, as any workflow
  await panel.locator('.react-flow__node-workflow').click();
  await expect(pill(page)).toHaveText('WORKFLOW');
  const name = `${t.tag}-new`;
  await typeInto(page, 'Name', name);
  await expect(field(page, 'Name')).toHaveValue(name);

  // a refresh keeps the document and its rename
  await expect.poll(() => newId(page)).not.toBeNull();
  const id = (await newId(page))!;
  await page.reload();
  await expect(newPanel(page).locator('.react-flow__node-workflow')).toBeVisible();
  await newPanel(page).locator('.react-flow__node-workflow').click();
  await expect(field(page, 'Name')).toHaveValue(name);
  expect((await request.get(`/api/v1/workflows/${id}`)).status()).toBe(404);

  // a step pasted from the throwaway, wired from the hub: its entry step
  const step = await pasteAndWire(page, newPanel(page));
  await shot(page, '2-pasted');

  await save(page);
  await expect(await pane(page, 'Output')).toContainText('Saved and applied');
  const made = await get<{ name: string; version: string; entryStepIds: string[] }>(request, `workflows/${id}`);
  expect([made.name, made.version, made.entryStepIds]).toEqual([name, '1.0.0', [step]]);
  expect((await get<{ processorId: string }>(request, `steps/${step}`)).processorId).toBe(t.processorId);

  // an ordinary workflow from now on: Start offered, listed by the Load picker
  const saved = page.locator('.docpanel').filter({ has: page.locator(`.crumb[data-tip^="${name}"]`) });
  await expect(saved.getByRole('button', { name: /Start/ })).toBeEnabled();
  await menu(page, 'Workspace').click();
  await expect(menu(page, /Delete…/)).toBeEnabled();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+o');
  await page.getByRole('textbox', { name: 'Search workflows' }).fill(name);
  await expect(page.getByRole('listbox', { name: 'Workflows' }).getByText(name, { exact: false })).toBeVisible();
  await page.keyboard.press('Escape');
  await shot(page, '3-saved');
});

test('a taken name: Save refuses it in red and nothing is created; closing asks, and Discard drops it for good', async ({ page, request }) => {
  const panel = await newWorkflow(page);
  await panel.locator('.react-flow__node-workflow').click();
  await expect(pill(page)).toHaveText('WORKFLOW');
  // the throwaway's own name: taken
  await typeInto(page, 'Name', t.tag);
  await expect.poll(() => newId(page)).not.toBeNull();
  const id = (await newId(page))!;
  const step = await pasteAndWire(page, panel);

  await save(page);
  const output = await pane(page, 'Output');
  await expect(output).toContainText(`Not created: a workflow named '${t.tag}' already exists.`);
  await expect(output.locator('.outl.err').filter({ hasText: 'already exists' }).first()).toBeVisible();
  expect((await request.get(`/api/v1/workflows/${id}`)).status()).toBe(404);
  expect((await request.get(`/api/v1/steps/${step}`)).status()).toBe(404);
  // still new and unsaved
  await expect(panel.getByRole('button', { name: /Start/ })).toBeDisabled();
  await shot(page, '4-taken');

  // closing asks first; Discard drops it, and a refresh does not bring it back
  await page.locator('.dv-tab .doctab').filter({ hasText: 'untitled' }).click();
  await page.keyboard.press('Alt+w');
  const ask = page.getByRole('alertdialog', { name: 'Save design changes?' });
  await expect(ask).toContainText('This new workflow is not saved yet');
  await ask.getByRole('button', { name: 'Discard' }).click();
  await expect(page.locator('.dv-tab .doctab').filter({ hasText: 'untitled' })).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.dv-tab .doctab').filter({ hasText: t.tag }).first()).toBeVisible();
  await expect(page.locator('.dv-tab .doctab').filter({ hasText: 'untitled' })).toHaveCount(0);
});

test('a blank workflow (no entry step) is saved as a design in progress; Start refuses it in red and nothing runs (2026-10-10)', async ({ page, request }) => {
  const panel = await newWorkflow(page);
  await panel.locator('.react-flow__node-workflow').click();
  await expect(pill(page)).toHaveText('WORKFLOW');
  const name = `${t.tag}-blank`;
  await typeInto(page, 'Name', name);
  await expect.poll(() => newId(page)).not.toBeNull();
  const id = (await newId(page))!;

  // nothing wired from the hub: Save stores it all the same
  await save(page);
  const output = await pane(page, 'Output');
  await expect(output).toContainText('Saved and applied');
  const made = await get<{ name: string; entryStepIds: string[] }>(request, `workflows/${id}`);
  expect([made.name, made.entryStepIds]).toEqual([name, []]);

  // Start is offered, and BaseApi refuses it: started, it would dispatch nothing
  const saved = page.locator('.docpanel').filter({ has: page.locator(`.crumb[data-tip^="${name}"]`) });
  const start = saved.getByRole('button', { name: /Start/ });
  await expect(start).toBeEnabled();
  await start.click();
  await expect(output.locator('.outl.err').filter({ hasText: 'no entry step' }).first()).toBeVisible();
  expect((await get<string[]>(request, 'orchestration/live')).includes(id)).toBe(false);
  await shot(page, '5-blank');
});
