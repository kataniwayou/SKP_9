import type { APIRequestContext, Page } from '@playwright/test';
import { documentPanel, openWorkflow, tab } from './studio';
import { createRunThrowaway, createThrowaway, expect, removeThrowaway, stopRunThrowaway, test } from './throwaway';

// Workspace › Delete workflow… (the user's rules, 2026-10-10): a fresh liveness reading, BaseApi's dry run, then a
// warning with Cancel (the default) and Continue; nothing destructive before Continue. Real mouse and keys, on this
// run's `e2e-` throwaways only (the write guard allows only their dry run and real run).
test.describe.configure({ mode: 'serial', retries: 0 });

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
});

const status = async (request: APIRequestContext, path: string) => (await request.get(`/api/v1/${path}`)).status();
// read where Output already shows (no tab click: a modal may be open)
const texts = async (page: Page) => page.locator('[data-pane="output"]').getByRole('log', { name: 'Output' }).locator('.outl').evaluateAll((els) => els.map((el) => ({
  text: [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim(), red: el.classList.contains('err'),
})));
const deleteMenu = async (page: Page) => {
  await page.getByRole('menuitem', { name: 'Workspace' }).click();
  await page.getByRole('menuitem', { name: /Delete…/ }).click();
};

test('a stopped workflow: the warning after the fresh reading and the dry run; Cancel sends nothing; Continue deletes it with its steps and assignment, never its cache or processor', async ({ page, request }) => {
  const t = await createThrowaway(request);
  try {
    // the menu strip: Workspace, not File; Load workflow…, not Open
    await expect(page.getByRole('menuitem', { name: 'File' })).toHaveCount(0);
    await page.getByRole('menuitem', { name: 'Workspace' }).click();
    await expect(page.getByRole('menuitem', { name: /Load…/ })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /Delete…/ })).toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('Escape');
    await openWorkflow(page, t.workflow);
    await expect(documentPanel(page, t.workflow)).toBeVisible();

    // nothing destructive before Continue: count the real runs
    const real: string[] = [];
    page.on('request', (r) => { if (r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/delete')) real.push(r.url()); });

    await deleteMenu(page);
    const dialog = page.getByRole('alertdialog', { name: `Delete workflow '${t.tag}'?` });
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expect(dialog).toContainText('Deleted for good: the workflow, 2 steps and 1 assignment');
    await expect(dialog).toContainText('Kept: 1 cache (only unlinked from it) and 1 processor (untouched)');
    await expect(dialog).toContainText('Its id is gone forever');
    // exactly Cancel and Continue; Cancel the default
    await expect(dialog.getByRole('button')).toHaveText(['Cancel', 'Continue']);
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    expect(real.every((u) => u.endsWith('/delete?dryRun=true'))).toBe(true);
    expect(real).toHaveLength(1);
    const before = (await texts(page)).map((l) => l.text);
    expect(before).toEqual(expect.arrayContaining([
      'Delete requested: reading the live set now (a reading from before the request does not count)',
      'Live set read now: not running. Dry run: BaseApi deletes it in a transaction and rolls back',
    ]));

    // Cancel: nothing sent, the document and the workflow as they were
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await texts(page)).at(-1)?.text).toBe('Delete cancelled: nothing was sent; the workflow is as it was');
    expect(real).toHaveLength(1);
    expect(await status(request, `workflows/${t.workflow.id}`)).toBe(200);
    await expect(tab(page, t.workflow.name)).toHaveCount(1);

    // Escape on the warning is Cancel too
    await deleteMenu(page);
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect(real.filter((u) => !u.endsWith('?dryRun=true'))).toEqual([]);

    // Continue: deleted; the document closes; gone from the picker and from a refresh
    await deleteMenu(page);
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await dialog.getByRole('button', { name: 'Continue' }).click();
    await expect(tab(page, t.workflow.name)).toHaveCount(0, { timeout: 15_000 });
    expect(real.filter((u) => !u.endsWith('?dryRun=true'))).toHaveLength(1);
    await expect.poll(async () => (await texts(page)).at(-1)?.text).toBe('Deleted: the workflow, 2 steps and 1 assignment; its id is gone for good');
    expect((await texts(page)).filter((l) => l.red)).toEqual([]);
    expect(await status(request, `workflows/${t.workflow.id}`)).toBe(404);
    expect(await status(request, `steps/${t.stepId}`)).toBe(404);
    expect(await status(request, `steps/${t.stepBId}`)).toBe(404);
    expect(await status(request, `assignments/${t.assignmentId}`)).toBe(404);
    expect(await status(request, `caches/${t.cacheId}`)).toBe(200);
    expect(await status(request, `processors/${t.processorId}`)).toBe(200);
    await page.getByRole('menuitem', { name: 'Workspace' }).click();
    await page.getByRole('menuitem', { name: /Load…/ }).click();
    await page.getByRole('textbox', { name: 'Search workflows' }).fill(t.tag);
    await expect(page.getByRole('listbox', { name: 'Workflows' }).getByText(t.workflow.label, { exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.reload();
    await expect(page.getByRole('menuitem', { name: 'Workspace' })).toBeVisible();
    await expect(tab(page, t.workflow.name)).toHaveCount(0);
  } finally {
    await removeThrowaway(request);
  }
});

test('a running workflow: refused in red at the fresh reading, no warning, still running and open; the plain CRUD delete is refused too', async ({ page, request }) => {
  const t = await createRunThrowaway(request);
  test.skip(t === null, 'no live processor without schemas in the cluster to start a throwaway on');
  try {
    const started = await request.post('/api/v1/orchestration/start', { data: JSON.stringify(t!.workflow.id), headers: { 'Content-Type': 'application/json' } });
    expect(started.status(), await started.text()).toBe(202);
    await expect.poll(async () => ((await (await request.get('/api/v1/orchestration/live')).json()) as string[]).includes(t!.workflow.id), { timeout: 30_000 }).toBe(true);
    await openWorkflow(page, t!.workflow);

    const sent: string[] = [];
    page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/delete')) sent.push(r.url()); });
    await deleteMenu(page);
    await expect.poll(async () => (await texts(page)).at(-1)).toEqual({ text: 'Not deleted: it is running. Stop it first: deleted while running, it could never be stopped', red: true });
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    expect(sent).toEqual([]);
    await expect(tab(page, t!.workflow.name)).toHaveCount(1);
    expect(((await (await request.get('/api/v1/orchestration/live')).json()) as string[])).toContain(t!.workflow.id);
    // the orphan guard on the plain CRUD delete
    const crud = await request.delete(`/api/v1/workflows/${t!.workflow.id}`);
    expect(crud.status()).toBe(422);
    expect(await status(request, `workflows/${t!.workflow.id}`)).toBe(200);
  } finally {
    await stopRunThrowaway(request);
    await removeThrowaway(request);
  }
});
