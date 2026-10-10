import type { Locator, Page } from '@playwright/test';
import { documentPanel, get, inspector, node, openWorkflow, outputLines, save } from './studio';
import { createThrowaway, expect, removeThrowaway, test, type Throwaway } from './throwaway';

// Removing a processor from a step (the user's rules, 2026-10-10), with the real mouse and keyboard: a click on a step's
// processor picture picks the processor; Delete removes it from the step (never the entity), the slot shows a dashed
// amber ⚠ on a transparent background; undo, refresh and Save behave; BaseApi's dry run refuses the step. Only this
// run's throwaway (`e2e-8-…`: a -> b on one processor) is written; throwaway.ts's guard aborts any other write.
test.describe.configure({ mode: 'serial', retries: 0 });
let t: Throwaway;
test.beforeAll(async ({ request }) => { t = await createThrowaway(request); });
test.afterAll(async ({ request }) => { await removeThrowaway(request); });

const SHOTS = process.env.PROCESSOR_SHOTS;
const shot = async (l: Locator, name: string) => { if (SHOTS) await l.screenshot({ path: `${SHOTS}/${name}.png` }); };

async function open(page: Page): Promise<Locator> {
  await openWorkflow(page, t.workflow);
  return documentPanel(page, t.workflow);
}

test('a click on a step\'s processor picks it; Delete removes it from the step: the amber dashed ⚠ slot, transparent, the step and its wires stay; undo, redo, refresh', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
  const panel = await open(page);
  const a = node(panel, t.stepId);
  const cables = panel.locator('.react-flow__edge-cable');
  const wires = await cables.count();

  await a.locator('.chipg .nx-pn').click();
  await expect(a).toHaveClass(/studio-die-sel/);
  await expect(a).not.toHaveClass(/studio-pick/);
  await page.keyboard.press('Delete');

  await expect(a.locator('.chipg')).toHaveCount(0);
  const slot = a.locator('.chip-empty');
  await expect(slot).toBeVisible();
  await expect(slot.locator('title')).toHaveText('No processor: drag one from the toolbox. Save will fail until this step has one.');
  await expect(slot.locator('.chip-empty-mark')).toHaveText('⚠');
  // transparent: the outline is not filled, dashed and amber; nothing else is drawn behind the ⚠
  const look = await slot.evaluate((g) => {
    const shapes = [...g.querySelectorAll('rect, circle, ellipse, path, polygon')];
    const line = g.querySelector('.chip-empty-line')!;
    const cs = getComputedStyle(line);
    const warn = getComputedStyle(document.documentElement).getPropertyValue('--warn').trim();
    return { shapes: shapes.length, fill: cs.fill, dash: cs.strokeDasharray, stroke: cs.stroke, mark: getComputedStyle(g.querySelector('.chip-empty-mark')!).fill, warn };
  });
  expect(look.shapes).toBe(1);
  expect(look.fill).toBe('none');
  expect(look.dash).not.toBe('none');
  expect(look.stroke).toBe('rgb(245, 184, 65)');
  expect(look.mark).toBe('rgb(245, 184, 65)');
  await shot(a, 'step-without-processor');
  // the step and its wires stay; the step is picked, the Inspector says the processor is none
  await expect(cables).toHaveCount(wires);
  await expect(a).toHaveClass(/studio-pick/);
  await expect(inspector(page).locator('.processor-none').first()).toHaveText('none');
  await expect(inspector(page).locator('[data-row="Processor"] dd')).toHaveText('none');
  await expect(page.getByText('● design draft')).toBeVisible();

  await page.keyboard.press('Control+z');
  await expect(a.locator('.chipg')).toBeVisible();
  await expect(a.locator('.chip-empty')).toHaveCount(0);
  await expect(page.getByText('● design draft')).toHaveCount(0);
  await page.keyboard.press('Control+y');
  await expect(a.locator('.chip-empty')).toBeVisible();

  // a refresh keeps it
  await page.reload();
  const again = node(documentPanel(page, t.workflow), t.stepId);
  await expect(again.locator('.chip-empty')).toBeVisible();
  await expect(again.locator('.chipg')).toHaveCount(0);
});

test('Save with it: BaseApi\'s dry run refuses the step in red; nothing is written, the processor entity stays', async ({ page, request }) => {
  await page.goto('/');
  const panel = await open(page);
  await node(panel, t.stepId).locator('.chipg .nx-pn').click();
  await page.keyboard.press('Delete');
  await expect(node(panel, t.stepId).locator('.chip-empty')).toBeVisible();
  await save(page);
  const lines = await outputLines(page);
  await expect(lines.filter({ hasText: 'No processor: drag one from the toolbox.' }).first()).toHaveClass(/err/);
  expect((await get<{ processorId: string }>(request, `steps/${t.stepId}`)).processorId).toBe(t.processorId);
  expect((await request.get(`/api/v1/processors/${t.processorId}`)).status()).toBe(200);
  // the stored design keeps it: still without a processor after the refused Save
  await expect(node(panel, t.stepId).locator('.chip-empty')).toBeVisible();
});
