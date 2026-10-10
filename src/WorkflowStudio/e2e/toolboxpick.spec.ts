import type { Locator, Page } from '@playwright/test';
import { box, documentPanel, emptySpot, get, inspector, node, openWorkflow, save, tab, type Pt } from './studio';
import { createThrowaway, expect, removeThrowaway, test, type Throwaway } from './throwaway';

// The Toolbox's tiles clicked (the user's rules, 2026-10-11), with the real mouse: a processor or cache is shown in the
// Inspector read-only (the Toolbox only drags), one tile at a time; a hidden Inspector stays hidden but its content
// switches; a click on a canvas takes the Inspector back. An entity the active design changed shows the design's values on
// its tile, marked unsaved. An empty cache is drawn with a dashed muted rectangle. Only this run's throwaway is written.
test.describe.configure({ mode: 'serial', retries: 0 });
let t: Throwaway;
test.beforeAll(async ({ request }) => { t = await createThrowaway(request); });
test.afterAll(async ({ request }) => { await removeThrowaway(request); });
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
});

const SHOTS = process.env.TOOLBOXPICK_SHOTS;
const toolbox = (page: Page) => page.locator('[data-pane="toolbox"]');
const tileOf = (page: Page, tool: string, id?: string) => toolbox(page).locator(`.tb-tile[data-tool="${tool}"]${id ? `[data-id="${id}"]` : ''}`);
const centre = async (l: Locator): Promise<Pt> => { const b = await box(l); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
const pill = (page: Page) => inspector(page).locator('.kindpill');

test('a click on a processor or cache tile shows it read-only in the Inspector, one at a time; a canvas click takes it back; a hidden Inspector stays hidden', async ({ page }) => {
  await openWorkflow(page, t.workflow);
  const panel = documentPanel(page, t.workflow);
  await toolbox(page).getByRole('searchbox', { name: 'Search the toolbox' }).fill(t.tag);
  const proc = tileOf(page, 'processor', t.processorId), cache = tileOf(page, 'cache', t.cacheId);

  // the processor: read-only, its liveness and schemas; the tile picked
  await proc.click();
  await expect(proc).toHaveClass(/picked/);
  await expect(pill(page)).toHaveText('PROCESSOR');
  await expect(inspector(page)).toContainText('From the Toolbox: read-only');
  await expect(inspector(page).getByLabel('Liveness')).toBeVisible();
  await expect(inspector(page).locator('input:not([readonly]), textarea:not([readonly])')).toHaveCount(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/toolbox-pick.png` });

  // the cache: the processor tile let go; its items read-only
  await cache.click();
  await expect(cache).toHaveClass(/picked/);
  await expect(proc).not.toHaveClass(/picked/);
  await expect(pill(page)).toHaveText('CACHE');
  await expect(inspector(page).getByRole('button', { name: '+ Add item' })).toHaveCount(0);

  // the Inspector auto-hidden: a click switches what it shows, but it stays hidden
  await tab(page, 'Inspector').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Auto hide/ }).click();
  await expect(tab(page, 'Inspector')).toBeHidden();
  await proc.click();
  await expect(page.locator('.fly')).toHaveCount(0);
  const rail = page.locator('[data-rt="inspector"]');
  await rail.hover();
  await expect(page.locator('.fly [data-pane="inspector"] .kindpill')).toHaveText('PROCESSOR');
  await page.locator('.fly').getByRole('button', { name: /Dock/ }).click();
  await expect(tab(page, 'Inspector')).toBeVisible();

  // a click on the canvas: the Inspector follows it again, no tile picked
  await node(panel, t.stepId).locator('.nx-sn').click();
  await expect(pill(page)).toHaveText('STEP');
  await expect(toolbox(page).locator('.tb-tile.picked')).toHaveCount(0);

  // a drag still drags after the clicks: an empty cache dropped is drawn dashed, muted, no ⚠
  const known = new Set(await panel.locator('.react-flow__node-cache').evaluateAll((els) => els.map((e) => e.getAttribute('data-id')!)));
  const spot = await emptySpot(panel);
  const from = await centre(tileOf(page, 'newCache'));
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 20, from.y + 5, { steps: 3 });
  await page.mouse.move(spot.x, spot.y, { steps: 12 });
  await page.mouse.up();
  const dropped = panel.locator('.react-flow__node-cache');
  await expect.poll(async () => (await dropped.evaluateAll((els) => els.map((e) => e.getAttribute('data-id')!))).filter((id) => !known.has(id)).length).toBe(1);
  const id = (await dropped.evaluateAll((els) => els.map((e) => e.getAttribute('data-id')!))).find((x) => !known.has(x))!;
  const fresh = panel.locator(`.react-flow__node-cache[data-id="${id}"]`);
  await expect(fresh.locator('.cache-empty-line')).toHaveCount(1);
  await expect(fresh.locator('.cache-empty-line')).toHaveCSS('stroke-dasharray', /5/);
  await expect(fresh.locator('.cache-empty-line')).toHaveCSS('stroke', 'rgb(129, 147, 174)');
  await expect(fresh.locator('.nx-hex')).toHaveCount(0);
  await expect(fresh).not.toContainText('⚠');
  if (SHOTS) await fresh.screenshot({ path: `${SHOTS}/empty-cache.png` });

  // an item added in the Inspector: drawn as any cache
  await expect(pill(page)).toHaveText('CACHE');
  await inspector(page).getByRole('button', { name: '+ Add item' }).click();
  await page.keyboard.type('usd');
  await page.keyboard.press('Tab');
  await page.keyboard.type('3.7');
  await page.keyboard.press('Enter');
  await expect(fresh.locator('.cache-empty-line')).toHaveCount(0);
  await expect(fresh.locator('.nx-hex')).toHaveCount(1);
  // the dropped cache is not saved: dropped from the design
  await page.getByRole('button', { name: 'Discard design' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Discard' }).click();
});

test('a cache renamed in the Inspector on the canvas: its Toolbox tile shows the design\'s name, marked unsaved; after Save, BaseApi\'s', async ({ page, request }) => {
  await openWorkflow(page, t.workflow);
  const panel = documentPanel(page, t.workflow);
  await toolbox(page).getByRole('searchbox', { name: 'Search the toolbox' }).fill(t.tag);
  const tile = tileOf(page, 'cache', t.cacheId);
  await expect(tile.locator('.tb-unsaved')).toHaveCount(0);
  await node(panel, `cache:${t.cacheId}`).click();
  await expect(pill(page)).toHaveText('CACHE');
  const name = `${t.tag}-renamed`;
  const field = inspector(page).getByLabel('Name', { exact: true });
  await field.click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type(name);
  await page.keyboard.press('Tab');
  await expect(tile).toContainText(name);
  await expect(tile.locator('.tb-unsaved')).toHaveCount(1);
  // the same values when the tile is picked: read-only, marked unsaved
  await tile.click();
  await expect(inspector(page)).toContainText('● unsaved changes');
  await expect(inspector(page)).toContainText(name);

  await save(page);
  await expect.poll(async () => (await get<{ name: string }>(request, `caches/${t.cacheId}`)).name).toBe(name);
  await expect(tile.locator('.tb-unsaved')).toHaveCount(0);
  await expect(tile).toContainText(name);
});
