import type { Locator, Page } from '@playwright/test';
import { documentPanel, inspector, node, openWorkflow, outputLines, tab, workflowsWithSteps, type LiveWorkflow } from './studio';
import { createThrowaway, expect, removeThrowaway, test, type Throwaway } from './throwaway';

// The Save spinner (the user's request, 2026-10-10): on the Save button and on the workflow's tab for the whole Save,
// from the click through BaseApi's answer, the re-read and the alignment; a pulse with reduced motion. Real mouse; the
// PUT is held ~1.5 s so the spinner can be seen. Writes only Save of this run's throwaway (`e2e-8-…`); the other
// workflow is only opened (GETs).
test.describe.configure({ mode: 'serial', retries: 0 });
let t: Throwaway;
let other: LiveWorkflow;
test.beforeAll(async ({ request }) => {
  t = await createThrowaway(request);
  other = (await workflowsWithSteps(request))[0]!;
});
test.afterAll(async ({ request }) => { await removeThrowaway(request); });
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
});

const SHOTS = process.env.OUTPUT_SHOTS;
const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };

/** Holds this run's design PUT for `ms` before it goes on to BaseApi. */
async function holdSave(page: Page, ms: number): Promise<void> {
  await page.route(`**/api/v1/workflows/${t.workflow.id}/design`, async (route) => {
    await new Promise((r) => setTimeout(r, ms));
    await route.fallback();
  });
}

async function editStep(page: Page, panel: Locator, text: string): Promise<void> {
  await node(panel, t.stepId).click({ position: { x: 20, y: 12 } });
  await expect(inspector(page).locator('.kindpill')).toHaveText('STEP');
  await inspector(page).getByLabel('Description', { exact: true }).click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type(text);
}

test('the spinner shows on the Save button and the tab for the whole Save, on the tab also behind another tab', async ({ page }) => {
  await openWorkflow(page, other);
  await openWorkflow(page, t.workflow);
  const panel = documentPanel(page, t.workflow);
  await editStep(page, panel, 'spun');
  await holdSave(page, 1500);

  const button = page.getByRole('button', { name: /Save/ });
  const tabSpin = tab(page, t.workflow.name).locator('.spin');
  await page.getByRole('button', { name: '⤓ Save' }).click();
  await expect(page.getByRole('button', { name: 'Saving…' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Saving…' })).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByRole('button', { name: 'Saving…' }).locator('.spin')).toBeVisible();
  await expect(tabSpin).toBeVisible();
  await expect(tab(page, t.workflow.name)).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByRole('status', { name: 'Save status' })).toHaveText(`Saving ${t.workflow.name}…`);
  // it turns
  expect(await tabSpin.evaluate((el) => getComputedStyle(el).animationName)).toBe('skp-spin');

  // another tab in front: the saving workflow's tab still spins
  await tab(page, other.name).click();
  await expect(documentPanel(page, other)).toBeVisible();
  await expect(tabSpin).toBeVisible();
  await shot(page, '9-save-spinner-behind');

  // gone once the Save is answered, read again and aligned
  await expect(tabSpin).toHaveCount(0, { timeout: 20_000 });
  await expect(tab(page, t.workflow.name)).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('status', { name: 'Save status' })).toHaveText(`Saved ${t.workflow.name}`);
  await tab(page, t.workflow.name).click();
  await expect((await outputLines(page)).last()).toContainText('nothing left stored');
  await expect(button).toHaveText('⤓ Save');
  await expect(button.locator('.spin')).toHaveCount(0);
});

test('with reduced motion the spinner pulses instead of turning', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openWorkflow(page, t.workflow);
  const panel = documentPanel(page, t.workflow);
  await editStep(page, panel, 'pulsed');
  await holdSave(page, 1500);
  await page.getByRole('button', { name: '⤓ Save' }).click();
  const spin = page.getByRole('button', { name: 'Saving…' }).locator('.spin');
  await expect(spin).toBeVisible();
  await expect(spin).toHaveClass(/reduced/);
  expect(await spin.evaluate((el) => getComputedStyle(el).animationName)).toBe('skp-pulse');
  await shot(page, '10-save-spinner-reduced');
  await expect(page.getByRole('button', { name: 'Saving…' })).toHaveCount(0, { timeout: 20_000 });
});
