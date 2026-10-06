import { expect, test } from '@playwright/test';
import { box, documentPanel, groupOf, inspector, liveWorkflows, openWorkflow, tab, type LiveWorkflow } from './studio';

// Spec §9, slice 3a. Read-only against the live BaseApi: GETs and the validate dry run only.
let workflows: LiveWorkflow[];

test.beforeAll(async ({ request }) => { workflows = await liveWorkflows(request, 2); });

test.beforeEach(async ({ page }) => {
  // every test starts from the default layout: no saved window layout in this browser
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(tab(page, 'Inspector')).toBeVisible();
});

test('opens a workflow, selects an entity and the Inspector fills', async ({ page }) => {
  const [wf] = workflows;
  await openWorkflow(page, wf!);
  await expect(inspector(page)).toContainText('Nothing selected');

  await documentPanel(page, wf!).locator('.react-flow__node-step').first().click({ position: { x: 20, y: 12 } });

  await expect(inspector(page).locator('.kindpill')).toHaveText(/STEP/);
  await expect(inspector(page).getByLabel('Unique name')).toHaveText(/_\d+\.\d+\.\d+-/);
  await expect(documentPanel(page, wf!).locator('.react-flow__node-step.studio-sel')).toHaveCount(1);

  await documentPanel(page, wf!).locator('.react-flow__node-step .chipg').first().click();
  await expect(inspector(page).locator('.kindpill')).toHaveText('PROCESSOR');
  await expect(inspector(page).locator('.slot')).toHaveCount(3);

  await page.keyboard.press('Escape');
  await expect(inspector(page)).toContainText('Nothing selected');
});

test('auto-hides a pane and pins it back', async ({ page }) => {
  const [wf] = workflows;
  await openWorkflow(page, wf!);
  const before = await box(groupOf(page, 'Inspector'));

  await tab(page, 'Inspector').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Auto hide/ }).click();
  await expect(tab(page, 'Inspector')).toBeHidden();
  const rail = page.locator('[data-rt="inspector"]');
  await expect(rail).toBeVisible();

  // a hidden Inspector still fills, and its rail tab glows
  await documentPanel(page, wf!).locator('.react-flow__node-workflow').click();
  await expect(rail).toHaveClass(/fresh/);
  await rail.hover();
  await expect(page.locator('.fly')).toBeVisible();
  await expect(page.locator('.fly [data-pane="inspector"] .kindpill')).toHaveText('WORKFLOW');

  await page.locator('.fly').getByRole('button', { name: /Dock/ }).click();
  await expect(rail).toHaveCount(0);
  const after = await box(groupOf(page, 'Inspector'));
  expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(after.width - before.width)).toBeLessThanOrEqual(2);
});

for (const pane of ['Toolbox', 'Inspector', 'Problems']) {
  test(`floats the ${pane} and docks it back to the exact spot`, async ({ page }) => {
    await openWorkflow(page, workflows[0]!);
    const before = await box(groupOf(page, pane));

    await tab(page, pane).click({ button: 'right' });
    await page.getByRole('menuitem', { name: /^⧉\s*Float/ }).click();
    await expect(page.locator('.dv-resize-container').filter({ has: tab(page, pane) })).toBeVisible();

    await tab(page, pane).dblclick({ modifiers: ['Control'] });
    await expect(page.locator('.dv-resize-container').filter({ has: tab(page, pane) })).toHaveCount(0);
    const after = await box(groupOf(page, pane));
    for (const k of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(after[k] - before[k])).toBeLessThanOrEqual(2);
  });
}

test('switches document tabs and comes back with the viewport and selection kept', async ({ page }) => {
  const [a, b] = workflows;
  await openWorkflow(page, a!);
  const panelA = documentPanel(page, a!);
  await panelA.locator('.react-flow__node-workflow').click();
  await panelA.getByRole('button', { name: 'Zoom in' }).click();
  await panelA.getByRole('button', { name: 'Zoom in' }).click();
  const zoom = await panelA.getByLabel('Zoom level').textContent();
  const transform = await panelA.locator('.react-flow__viewport').getAttribute('style');

  await openWorkflow(page, b!);
  await expect(inspector(page)).toContainText('Nothing selected');
  await tab(page, a!.name).click();

  await expect(panelA.getByLabel('Zoom level')).toHaveText(zoom!);
  expect(await panelA.locator('.react-flow__viewport').getAttribute('style')).toBe(transform);
  await expect(panelA.locator('.react-flow__node-workflow.studio-sel')).toHaveCount(1);
  await expect(inspector(page).locator('.kindpill')).toHaveText('WORKFLOW');
});

test('menus, the picker and the tooltip open above a floating group', async ({ page }) => {
  const [wf] = workflows;
  await openWorkflow(page, wf!);
  await tab(page, 'Inspector').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^⧉\s*Float/ }).click();
  const floating = page.locator('.dv-resize-container').filter({ has: tab(page, 'Inspector') });
  await expect(floating).toBeVisible();
  const f = await box(floating);

  // a menu opened at a point inside the floating group is the topmost thing there
  await tab(page, 'Inspector').click({ button: 'right' });
  const menu = page.getByRole('menu');
  const m = await box(menu);
  const topmost = await page.evaluate(([x, y]) => !!document.elementFromPoint(x!, y!)?.closest('.dropdown'), [m.x + 20, m.y + 10]);
  expect(topmost).toBe(true);
  expect(m.x).toBeGreaterThanOrEqual(f.x - 1);
  await page.keyboard.press('Escape');

  await page.getByRole('menuitem', { name: 'File' }).click();
  await page.getByRole('menuitem', { name: /Open workflow/ }).click();
  const pickerZ = await page.locator('.picker').evaluate((el) => getComputedStyle(el).zIndex);
  const floatZ = await floating.evaluate((el) => getComputedStyle(el).zIndex);
  expect(Number(pickerZ)).toBeGreaterThan(Number(floatZ));
  await page.keyboard.press('Escape');

  await documentPanel(page, wf!).locator('[data-tip="Not available yet"]').first().hover();
  const tip = page.getByRole('tooltip').filter({ hasText: 'Not available yet' });
  await expect(tip).toHaveClass(/on/);
  expect(Number(await tip.evaluate((el) => getComputedStyle(el).zIndex))).toBeGreaterThan(Number(floatZ));
});

test('pops a document out, and it keeps its fonts, its drawing and its zoom', async ({ page }) => {
  const [wf] = workflows;
  await openWorkflow(page, wf!);
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    groupOf(page, wf!.name).getByRole('button', { name: 'Pop out to its own window' }).click(),
  ]);
  await popup.waitForLoadState();
  const panel = popup.locator('.docpanel');
  await expect(panel.locator('.react-flow__node-step').first()).toBeVisible();

  // review focus 4: the pop-out has the fonts, the measure canvas and the SVG definitions it needs
  expect(await popup.evaluate(async () => {
    await document.fonts.ready;
    return document.fonts.check('600 14.5px "IBM Plex Sans Condensed"') && !!document.getElementById('glow') && !!document.getElementById('capfill');
  })).toBe(true);

  // selecting in the pop-out fills the Inspector in the main window
  await panel.locator('.react-flow__node-workflow').click();
  await expect(inspector(page).locator('.kindpill')).toHaveText('WORKFLOW');

  const level = async () => Number((await panel.getByLabel('Zoom level').textContent())!.replace('%', ''));
  const start = await level();
  await panel.getByRole('button', { name: 'Zoom in' }).click();
  await expect.poll(level).toBeGreaterThan(start);

  const pane = await box(panel.locator('.react-flow__pane'));
  const zoomed = await level();
  await popup.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2);
  await popup.keyboard.down('Control');
  await popup.mouse.wheel(0, -300);
  await popup.keyboard.up('Control');
  await expect.poll(level).toBeGreaterThan(zoomed);
});

test('a document drops only into or beside the document area', async ({ page }) => {
  const [a, b] = workflows;
  await openWorkflow(page, a!);
  await openWorkflow(page, b!);
  const documentGroup = await box(groupOf(page, a!.name));

  // onto the Toolbox: refused, the tab stays where it was
  const toolbox = await box(page.locator('[data-pane="toolbox"]'));
  await tab(page, b!.name).hover();
  await page.mouse.down();
  await page.mouse.move(toolbox.x + toolbox.width / 2, toolbox.y + toolbox.height / 2, { steps: 12 });
  await page.mouse.up();
  expect(await box(groupOf(page, b!.name))).toEqual(await box(groupOf(page, a!.name)));

  // beside the other document: allowed, a new document group to its right
  await tab(page, b!.name).hover();
  await page.mouse.down();
  await page.mouse.move(documentGroup.x + documentGroup.width - 30, documentGroup.y + documentGroup.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => (await box(groupOf(page, b!.name))).x).toBeGreaterThan(documentGroup.x + 40);
});

test('Ctrl+E switches windows and Alt+W closes the active document', async ({ page }) => {
  const [a, b] = workflows;
  await openWorkflow(page, a!);
  await openWorkflow(page, b!);

  await page.keyboard.down('Control');
  await page.keyboard.press('e');
  await expect(page.getByRole('dialog', { name: 'Switch window' })).toBeVisible();
  await page.keyboard.up('Control');
  await expect(page.getByRole('dialog', { name: 'Switch window' })).toHaveCount(0);
  await expect(page.locator('.dv-tab.dv-active-tab .doctab .nm').filter({ hasText: a!.name })).toHaveCount(1);

  await page.keyboard.press('Alt+w');
  await expect(tab(page, a!.name)).toHaveCount(0);
  await expect(tab(page, b!.name)).toHaveCount(1);
});

test('a saved window layout comes back after a reload, without the documents', async ({ page }) => {
  await openWorkflow(page, workflows[0]!);
  await tab(page, 'Output').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Auto hide/ }).click();
  await page.getByRole('menuitem', { name: 'Window' }).click();
  await page.getByRole('menuitem', { name: /Save window layout/ }).click();
  await expect(page.locator('.toast')).toHaveText('Window layout saved in this browser');

  await page.reload();

  await expect(page.locator('[data-rt="output"]')).toBeVisible();
  await expect(tab(page, 'Inspector')).toBeVisible();
  await expect(page.locator('.docpanel')).toHaveCount(0);
  await expect(page.getByText('No workflow open')).toBeVisible();
});
