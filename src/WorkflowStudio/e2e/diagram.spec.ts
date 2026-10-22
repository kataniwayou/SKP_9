import type { Locator, Page } from '@playwright/test';
import { documentPanel, openWorkflow, outputLines, save } from './studio';
import { createThrowaway, expect, removeThrowaway, test, type Throwaway } from './throwaway';

// The dashboard's diagram (the user's rule, 2026-10-11), with the real mouse: every applied Save publishes the studio's
// drawing to the workflow row, which the Kibana panel shows (GET /workflows/{id}.svg). Only this run's throwaway is saved.
test.describe.configure({ mode: 'serial', retries: 0 });
// the publish follows the Save (it renders the drawing with its fonts built in, then puts it): its own wait, as save()'s
const PUBLISHED = { timeout: 30_000 };
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
  await expect(lines.filter({ hasText: 'Diagram published: the dashboard shows this drawing' })).toHaveCount(1, PUBLISHED);
  const first = await svgOf();
  expect(first).not.toContain('No diagram published');
  // the canvas's own art (2026-10-11): its blocks and wires, its styles and faces built in, the legend
  expect(first).toContain('WORKFLOW');
  expect(first).toContain('class="blk nx"');
  expect(first).toContain('.wire path.w');
  expect(first).toContain('.blk .nx-sn');
  expect(first).toMatch(/@font-face\{font-family:"IBM Plex Mono";font-weight:400;src:url\(data:font\/woff2;base64,/);
  expect(first).toContain('>short circuit<');
  // light for the light dashboard (2026-10-11), while the studio's own canvas stays dark
  expect(first).toContain('fill="#FFFFFF"/>');
  await expect(panel.locator('.react-flow')).toBeVisible();
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ground').trim())).toMatch(/^#0a1220$/i); // a production build lowercases it

  // the publish left the workflow's stamp alone: a second Save is applied, not a conflict, and publishes again
  await moveDown(page, panel, t.stepBId, 96);
  await save(page);
  await expect(lines.filter({ hasText: 'Saved and applied' })).toHaveCount(2);
  await expect(lines.filter({ hasText: 'Diagram published' })).toHaveCount(2, PUBLISHED);
  const second = await svgOf();
  expect(second).not.toBe(first);
});

test('Save is offered with nothing changed: its tooltip says so, and it publishes the drawing again', async ({ page }) => {
  await openWorkflow(page, t.workflow);
  const button = page.getByRole('button', { name: '⤓ Save' });
  await expect(button).toBeEnabled();
  await expect(button).toHaveAttribute('data-tip', /^Nothing changed since the last Save/);
  await save(page);
  const lines = await outputLines(page);
  await expect(lines.filter({ hasText: 'Save started: sending the layout only' })).toHaveCount(1);
  await expect(lines.filter({ hasText: 'Saved and applied' })).toHaveCount(1);
  await expect(lines.filter({ hasText: 'Diagram published' })).toHaveCount(1, PUBLISHED);
});
