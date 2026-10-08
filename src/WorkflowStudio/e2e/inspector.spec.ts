import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { documentPanel, inspector, openWorkflow, tab } from './studio';
import { createThrowaway, expect, removeThrowaway, test, type Throwaway } from './throwaway';

// Plan 8 §3.3: the Inspector edits the design, never BaseApi. These tests never press Save. The write guard
// (e2e/throwaway.ts) aborts any write except Save of this run's workflow, so each test also records every
// request that is not a GET and fails on any, Save included; and each checks BaseApi still holds what it created.
test.describe.configure({ mode: 'serial', retries: 0 });
let t: Throwaway;
let writes: string[];
test.beforeAll(async ({ request }) => { t = await createThrowaway(request); });
test.afterAll(async ({ request }) => { await removeThrowaway(request); });
test.beforeEach(async ({ page, context }) => {
  writes = [];
  context.on('request', (r) => {
    if (r.method() !== 'GET' && r.method() !== 'HEAD') writes.push(`${r.method()} ${new URL(r.url()).pathname}`);
  });
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
});
test.afterEach(() => { expect(writes, 'the Inspector writes nothing: no PUT, not even Save').toEqual([]); });

const field = (page: Page, label: string): Locator => inspector(page).getByLabel(label, { exact: true });
const pill = (page: Page): Locator => inspector(page).locator('.kindpill');

async function get<T>(request: APIRequestContext, path: string): Promise<T> {
  const r = await request.get(`/api/v1/${path}`);
  expect(r.ok(), `GET ${path}`).toBe(true);
  return (await r.json()) as T;
}

async function typeInto(page: Page, label: string, text: string): Promise<void> {
  await field(page, label).click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type(text);
}

async function open(page: Page): Promise<Locator> {
  await openWorkflow(page, t.workflow);
  return documentPanel(page, t.workflow);
}

test('every entity kind edits the design: marked unsaved, kept while the Inspector moves on, nothing written', async ({ page, request }) => {
  const panel = await open(page);
  await panel.locator('.react-flow__node-workflow').click();
  await expect(pill(page)).toHaveText('WORKFLOW');
  await typeInto(page, 'Description', 'wf designed');
  await expect(inspector(page).getByText('● unsaved changes')).toBeVisible();

  await panel.locator(`.react-flow__node[data-id="${t.stepId}"]`).click({ position: { x: 20, y: 12 } });
  await expect(pill(page)).toHaveText('STEP');
  await typeInto(page, 'Description', 'step designed');
  await field(page, 'Entry condition').click();
  await inspector(page).getByRole('option', { name: /Always/ }).click();

  await panel.locator(`.react-flow__node[data-id="${t.stepId}"] .chipg`).click();
  await expect(pill(page)).toHaveText('PROCESSOR');
  await typeInto(page, 'Description', 'proc designed');

  await panel.locator('.react-flow__node-cache').first().click();
  await expect(pill(page)).toHaveText('CACHE');
  await typeInto(page, 'Items', '{"a":"b"}');

  // back on the workflow: its edit is still there
  await panel.locator('.react-flow__node-workflow').click();
  await expect(field(page, 'Description')).toHaveValue('wf designed');
  await expect(page.getByText('● design draft')).toBeVisible();

  expect((await get<{ description: string | null }>(request, `workflows/${t.workflow.id}`)).description).toBeNull();
  expect((await get<{ description: string | null; entryCondition: number }>(request, `steps/${t.stepId}`)).entryCondition).toBe(1);
  expect((await get<{ description: string | null }>(request, `processors/${t.processorId}`)).description).toBeNull();
  expect((await get<{ items: string }>(request, `caches/${t.cacheId}`)).items).toBe('{}');
});

test('a refresh keeps unsaved Inspector edits: the field, the Inspector on it, the dirty mark; nothing written', async ({ page, request }) => {
  const panel = await open(page);
  await panel.locator(`.react-flow__node[data-id="${t.stepId}"]`).click({ position: { x: 20, y: 12 } });
  await expect(pill(page)).toHaveText('STEP');
  await typeInto(page, 'Description', 'kept over a refresh');
  await expect(page.getByText('● design draft')).toBeVisible();

  await page.reload();
  await expect(documentPanel(page, t.workflow).locator('.react-flow__node').first()).toBeVisible();
  await expect(pill(page)).toHaveText('STEP');
  await expect(field(page, 'Description')).toHaveValue('kept over a refresh');
  await expect(inspector(page).getByText('● unsaved changes')).toBeVisible();
  await expect(page.getByText('● design draft')).toBeVisible();
  await expect(tab(page, t.workflow.name)).toHaveClass(/\bdirty\b/);
  expect((await get<{ description: string | null }>(request, `steps/${t.stepId}`)).description).toBeNull();
});

test('Revert drops one entity\'s edits; the others stay', async ({ page }) => {
  const panel = await open(page);
  await panel.locator(`.react-flow__node[data-id="${t.stepId}"]`).click({ position: { x: 20, y: 12 } });
  await typeInto(page, 'Version', 'abc');
  await panel.locator('.react-flow__node-workflow').click();
  await typeInto(page, 'Description', 'kept');
  await panel.locator(`.react-flow__node[data-id="${t.stepId}"]`).click({ position: { x: 20, y: 12 } });
  await inspector(page).getByRole('button', { name: 'Revert' }).click();
  await expect(field(page, 'Version')).toHaveValue('1.0.0');
  await panel.locator('.react-flow__node-workflow').click();
  await expect(field(page, 'Description')).toHaveValue('kept');
});

test('Create and Remove assignment change the design only', async ({ page, request }) => {
  const panel = await open(page);
  await panel.locator(`.react-flow__node[data-id="${t.stepBId}"]`).click({ position: { x: 20, y: 12 } });
  await inspector(page).getByRole('button', { name: '＋ Create' }).click();
  await expect(pill(page)).toHaveText('ASSIGNMENT');
  await expect(field(page, 'Name')).toHaveValue(`${t.tag}-b-assignment`);
  await inspector(page).getByRole('button', { name: 'Remove assignment' }).click();
  await expect(pill(page)).toHaveText('STEP');
  const all = await get<{ stepId: string }[]>(request, 'assignments');
  expect(all.filter((a) => a.stepId === t.stepBId)).toEqual([]);
});

test('a Description opens sized to its whole text, with no inner scroll bar', async ({ page }) => {
  const panel = await open(page);
  await panel.locator(`.react-flow__node[data-id="${t.stepId}"]`).click({ position: { x: 20, y: 12 } });
  await expect(pill(page)).toHaveText('STEP');
  await field(page, 'Description').click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('line one');
  for (const n of ['two', 'three', 'four', 'five', 'six']) { await page.keyboard.press('Enter'); await page.keyboard.type(`line ${n}`); }
  await page.reload(); // reopens from the kept draft: the textarea mounts with its whole text
  await expect(field(page, 'Description')).toHaveValue(/line six/);
  const size = await field(page, 'Description').evaluate((e) => ({ client: e.clientHeight, scroll: e.scrollHeight }));
  expect(size.client).toBeGreaterThanOrEqual(size.scroll);
  expect(size.client).toBeGreaterThan(80); // six lines, not the two-row default
  await inspector(page).screenshot({ path: 'C:/Users/UserL/AppData/Local/Temp/claude/C--Users-UserL-source-repos-SK-P10/cf954b91-a84b-487f-9613-5ccf0e8dee60/scratchpad/inspector-description.png' });
});
