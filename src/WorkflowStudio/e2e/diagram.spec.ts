import type { Locator, Page } from '@playwright/test';
import { documentPanel, openWorkflow, outputLines, save } from './studio';
import { createThrowaway, expect, removeThrowaway, test, type Throwaway } from './throwaway';

// The dashboard's diagram (the user's rule, 2026-10-11), with the real mouse: every applied Save publishes the studio's
// drawing to the workflow row, which the Kibana panel shows (GET /workflows/{id}.svg). Only this run's throwaway is saved.
test.describe.configure({ mode: 'serial', retries: 0 });
let t: Throwaway;
test.beforeAll(async ({ request }) => { t = await createThrowaway(request); });
test.afterAll(async ({ request }) => { await removeThrowaway(request); });
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
});

/** Drags step `id` by its name `dy` px down on screen, with the real mouse. */
async function moveDown(page: Page, panel: Locator, id: string, dy: number): Promise<void> {
  const grip = (await panel.locator(`.react-flow__node[data-id="${id}"] .nx-sn`).boundingBox())!;
  await page.mouse.move(grip.x + 10, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + 10, grip.y + grip.height / 2 + dy, { steps: 10 });
  await page.mouse.up();
}

test('an applied Save publishes the drawing for the dashboard; the next Save is not refused for it', async ({ page, request }) => {
  await openWorkflow(page, t.workflow);
  const panel = documentPanel(page, t.workflow);
  const svgOf = async () => {
    const r = await request.get(`/api/v1/workflows/${t.workflow.id}.svg`);
    expect(r.ok()).toBe(true);
    return r.text();
  };
  // a throwaway starts with the placeholder
  expect(await svgOf()).toContain('No diagram published');

  await moveDown(page, panel, t.stepBId, 160);
  await save(page);
  const lines = await outputLines(page);
  await expect(lines.filter({ hasText: 'Diagram published: the dashboard shows this drawing' })).toHaveCount(1);
  const first = await svgOf();
  expect(first).not.toContain('No diagram published');
  expect(first).toContain('WORKFLOW');
  expect(first).toContain(`>${t.stepName}<`);

  // the publish left the workflow's stamp alone: a second Save is applied, not a conflict, and publishes again
  await moveDown(page, panel, t.stepBId, 96);
  await save(page);
  await expect(lines.filter({ hasText: 'Saved and applied' })).toHaveCount(2);
  await expect(lines.filter({ hasText: 'Diagram published' })).toHaveCount(2);
  const second = await svgOf();
  expect(second).not.toBe(first);
});
