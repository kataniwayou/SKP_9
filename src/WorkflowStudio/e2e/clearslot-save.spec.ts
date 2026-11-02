import { documentPanel, get, inspector, node, openWorkflow, save } from './studio';
import { createThrowaway, expect, removeThrowaway, test, type Throwaway } from './throwaway';

// A cleared slot saved for real (the user, 2026-11-01): on this run's throwaway (`e2e-8-…`), whose processor is its own,
// so no shared processor is touched. The write guard lets the browser write only Save of the throwaway workflow.
test.describe.configure({ mode: 'serial', retries: 0 });
let t: Throwaway;
test.beforeAll(async ({ request }) => { t = await createThrowaway(request); });
test.afterAll(async ({ request }) => { await removeThrowaway(request); });

test('Save clears a processor slot in BaseApi, and the re-read draws it empty', async ({ page, request }) => {
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
  await openWorkflow(page, t.workflow);
  const panel = documentPanel(page, t.workflow);
  await node(panel, t.stepId).locator('.chipg').click();
  await expect(inspector(page).locator('.kindpill')).toHaveText('PROCESSOR');
  await inspector(page).getByRole('button', { name: 'Clear the Config schema' }).click();
  await save(page);
  const p = await get<{ configSchemaId: string | null }>(request, `processors/${t.processorId}`);
  expect(p.configSchemaId).toBeNull();
  await expect(inspector(page).locator('.slot').nth(2)).toContainText('∅');
  await expect(node(panel, t.stepId).locator('.chipg')).toContainText('cfg∅');
  // the Toolbox reads BaseApi again after the Save: its tile shows the saved empty slot, no longer unsaved
  const tile = page.locator('.tb-tile').filter({ hasText: `${t.tag}-proc` });
  await expect(tile.locator('.chipg')).toContainText('cfg∅');
  await expect(tile.locator('.tb-unsaved')).toHaveCount(0);
});
