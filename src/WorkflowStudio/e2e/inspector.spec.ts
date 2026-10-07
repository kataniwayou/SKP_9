import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { documentPanel, inspector, openWorkflow, tab } from './studio';
import { allow, createThrowaway, expect, removeThrowaway, test, type Throwaway } from './throwaway';

// Spec §7.1: the Inspector edits each entity's metadata. Every write goes to this run's own
// throwaway entities (e2e/throwaway.ts, named `e2e-3b-…`), created here and deleted afterwards.
// The tests share that one set and build on each other's state, so they run in order, never retried.
test.describe.configure({ mode: 'serial', retries: 0 });
let t: Throwaway;
test.beforeAll(async ({ request }) => { t = await createThrowaway(request); });
test.afterAll(async ({ request }) => { await removeThrowaway(request); });
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
});

const field = (page: Page, label: string): Locator => inspector(page).getByLabel(label, { exact: true });
const fieldRow = (page: Page, label: string): Locator =>
  inspector(page).locator('.field').filter({ has: page.locator('label', { hasText: new RegExp(`^${label}$`) }) });
const pill = (page: Page): Locator => inspector(page).locator('.kindpill');

async function get<T>(request: APIRequestContext, path: string): Promise<T> {
  const r = await request.get(`/api/v1/${path}`);
  expect(r.ok(), `GET ${path}`).toBe(true);
  return (await r.json()) as T;
}

/** Save, then wait until nothing is unsaved: the Inspector, the capsule and the tab are clean. */
async function save(page: Page): Promise<void> {
  await inspector(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('● unsaved changes')).toHaveCount(0);
  await expect(tab(page, t.workflow.name)).not.toHaveClass(/\bdirty\b/);
}

async function open(page: Page): Promise<Locator> {
  await openWorkflow(page, t.workflow);
  return documentPanel(page, t.workflow);
}

const selectStep = async (page: Page, panel: Locator) => {
  await panel.locator('.react-flow__node-step').first().click({ position: { x: 20, y: 12 } });
  await expect(pill(page)).toHaveText('STEP');
};

test('each entity kind saves its metadata', async ({ page, request }) => {
  const panel = await open(page);
  const stamp = Date.now().toString(36);

  await test.step('workflow', async () => {
    await panel.locator('.react-flow__node-workflow').click();
    await expect(pill(page)).toHaveText('WORKFLOW');
    await field(page, 'Description').fill(`wf ${stamp}`);
    await save(page);
    expect((await get<{ description: string }>(request, `workflows/${t.workflow.id}`)).description).toBe(`wf ${stamp}`);
  });

  await test.step('step', async () => {
    const before = await get<{ nextStepIds: string[] }>(request, `steps/${t.stepId}`);
    await selectStep(page, panel);
    await field(page, 'Description').fill(`step ${stamp}`);
    await field(page, 'Entry condition').click();
    await inspector(page).getByRole('option', { name: /Always/ }).click();
    await save(page);
    const after = await get<{ description: string; entryCondition: number; nextStepIds: string[] }>(request, `steps/${t.stepId}`);
    expect(after.description).toBe(`step ${stamp}`);
    expect(after.entryCondition).toBe(4);
    expect(after.nextStepIds).toEqual(before.nextStepIds);
  });

  await test.step('processor', async () => {
    await panel.locator('.react-flow__node-step .chipg').first().click();
    await expect(pill(page)).toHaveText('PROCESSOR');
    await field(page, 'Description').fill(`proc ${stamp}`);
    await save(page);
    expect((await get<{ description: string }>(request, `processors/${t.processorId}`)).description).toBe(`proc ${stamp}`);
  });

  await test.step('schema, from the Config slot', async () => {
    await inspector(page).locator('.slot').filter({ hasText: 'Config' }).getByRole('button').click();
    await expect(pill(page)).toHaveText('SCHEMA');
    await expect(inspector(page).getByRole('navigation', { name: 'Drill-down' })).toBeVisible();
    await field(page, 'Description').fill(`schema ${stamp}`);
    await save(page);
    expect((await get<{ description: string }>(request, `schemas/${t.schemaId}`)).description).toBe(`schema ${stamp}`);
  });

  await test.step('cache', async () => {
    await panel.locator('.react-flow__node-cache').first().click();
    await expect(pill(page)).toHaveText('CACHE');
    await field(page, 'Items').fill('{"a":"b"}');
    await save(page);
    expect(JSON.parse((await get<{ items: string }>(request, `caches/${t.cacheId}`)).items)).toEqual({ a: 'b' });
  });
});

test('a 400 shows under its field and keeps what was typed', async ({ page }) => {
  const panel = await open(page);
  await selectStep(page, panel);
  await field(page, 'Version').fill('abc');
  await inspector(page).getByRole('button', { name: 'Save', exact: true }).click();

  await expect(fieldRow(page, 'Version').locator('.ferr').first()).toBeVisible();
  await expect(field(page, 'Version')).toHaveAttribute('aria-invalid', 'true');
  await expect(field(page, 'Version')).toHaveValue('abc');

  await inspector(page).getByRole('button', { name: 'Revert' }).click();
  await expect(field(page, 'Version')).toHaveValue('1.0.0');
  await expect(page.getByText('● unsaved changes')).toHaveCount(0);
});

test('a 409 shows as a banner and keeps what was typed', async ({ page }) => {
  const panel = await open(page);
  await panel.locator('.react-flow__node-step .chipg').first().click();
  await expect(pill(page)).toHaveText('PROCESSOR');
  await inspector(page).locator('.slot').filter({ hasText: 'Config' }).getByRole('button').click();
  await expect(pill(page)).toHaveText('SCHEMA');
  await field(page, 'Definition').fill('{"type":"string"}');
  await inspector(page).getByRole('button', { name: 'Save', exact: true }).click();

  // the banner carries the problem's detail (its title, "Schema definition is frozen", is not shown)
  await expect(inspector(page).getByRole('alert'))
    .toContainText(`Not saved: Schema '${t.schemaId}' is referenced by a processor; its Definition cannot be modified.`);
  await expect(field(page, 'Definition')).toHaveValue('{"type":"string"}');

  await inspector(page).getByRole('button', { name: 'Revert' }).click();
  await expect(page.getByText('● unsaved changes')).toHaveCount(0);
});

test('an assignment is added, edited and unlinked from the step', async ({ page, request }) => {
  const panel = await open(page);
  const assignmentIds = async () => (await get<{ assignmentIds: string[] | null }>(request, `workflows/${t.workflow.id}`)).assignmentIds ?? [];
  await selectStep(page, panel);

  await inspector(page).getByRole('button', { name: '＋ Add assignment' }).click();
  await expect(pill(page)).toHaveText('NEW ASSIGNMENT');
  await inspector(page).getByRole('button', { name: 'Create' }).click();
  await expect(pill(page)).toHaveText('ASSIGNMENT');
  await expect.poll(assignmentIds).toHaveLength(1);

  await inspector(page).getByRole('button', { name: '▸ show all' }).click();
  const id = (await fieldRow(page, 'Id').locator('.ro').textContent())!.trim();
  expect((await assignmentIds())[0]).toBe(id);
  allow('assignments', id);
  await field(page, 'Payload').fill('{"k":1}');
  await save(page);
  expect(JSON.parse((await get<{ payload: string }>(request, `assignments/${id}`)).payload)).toEqual({ k: 1 });

  await inspector(page).getByRole('button', { name: 'Unlink from this workflow' }).click();
  await page.getByRole('alertdialog', { name: 'Unlink assignment' }).getByRole('button', { name: 'Unlink' }).click();
  await expect(pill(page)).toHaveText('STEP');
  await expect.poll(assignmentIds).toEqual([]);
});

test('unsaved edits are guarded and survive a refresh', async ({ page }) => {
  const panel = await open(page);
  const typed = `draft ${Date.now().toString(36)}`;
  await selectStep(page, panel);
  await field(page, 'Description').fill(typed);

  await panel.locator('.react-flow__node-workflow').click();
  const dialog = page.getByRole('alertdialog', { name: 'Unsaved changes' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(pill(page)).toHaveText('STEP');
  await expect(field(page, 'Description')).toHaveValue(typed);

  await page.reload();

  await expect(documentPanel(page, t.workflow).locator('.react-flow__node').first()).toBeVisible();
  await expect(field(page, 'Description')).toHaveValue(typed);
  await expect(inspector(page).getByText('● unsaved changes')).toBeVisible();
  await expect(tab(page, t.workflow.name)).toHaveClass(/\bdirty\b/);

  await documentPanel(page, t.workflow).locator('.react-flow__node-workflow').click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Discard' }).click();
  await expect(pill(page)).toHaveText('WORKFLOW');
  await expect(page.getByText('● unsaved changes')).toHaveCount(0);
});
