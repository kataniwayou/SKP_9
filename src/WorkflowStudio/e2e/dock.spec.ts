import type { Page } from '@playwright/test';
import { box, documentPanel, esc, expect, floatOver, groupOf, inspector, liveWorkflows, openWorkflow, overlap, selectProcessor, tab, test, type LiveWorkflow } from './studio';
import { createChainThrowaway, removeThrowaway } from './throwaway';

// Spec §9, slice 3a. Read-only against the live BaseApi: GETs only.
let workflows: LiveWorkflow[];

test.beforeAll(async ({ request }) => { workflows = await liveWorkflows(request, 2); });

test.beforeEach(async ({ page }) => {
  // every test starts from the default layout: no saved window layout in this browser
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
  await expect(tab(page, 'Inspector')).toBeVisible();
});

/** The workflow block of a document, or a skip with a reason when the document has none to click. */
async function workflowBlock(page: Page, wf: LiveWorkflow) {
  const block = documentPanel(page, wf).locator('.react-flow__node-workflow');
  test.skip((await block.count()) === 0, 'the live workflow draws no clickable workflow block');
  return block;
}

test('opens a workflow, selects an entity and the Inspector fills', async ({ page }) => {
  const [wf] = workflows;
  await openWorkflow(page, wf!);
  await expect(inspector(page)).toContainText('Nothing selected');

  await documentPanel(page, wf!).locator('.react-flow__node-step').first().click({ position: { x: 20, y: 12 } });

  await expect(inspector(page).locator('.kindpill')).toHaveText(/STEP/);
  await expect(inspector(page).getByLabel('Unique name')).toHaveText(/_\d+\.\d+\.\d+-/);
  await expect(documentPanel(page, wf!).locator('.react-flow__node-step.studio-sel')).toHaveCount(1);

  const processor = await selectProcessor(page, documentPanel(page, wf!));
  test.skip(!processor, 'no processor chip in the first live workflow shows the three schema slots');
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
  await (await workflowBlock(page, wf!)).click();
  await expect(rail).toHaveClass(/fresh/);
  await rail.hover();
  await expect(page.locator('.fly')).toBeVisible();
  await expect(page.locator('.fly [data-pane="inspector"] .kindpill')).toHaveText('WORKFLOW');

  await page.locator('.fly').getByRole('button', { name: /Dock/ }).click();
  await expect(rail).toHaveCount(0);
  const after = await box(groupOf(page, 'Inspector'));
  expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(2);
  for (const k of ['y', 'width', 'height'] as const) expect(Math.abs(after[k] - before[k])).toBeLessThanOrEqual(2);
});

for (const pane of ['Toolbox', 'Inspector', 'Output']) {
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
  await (await workflowBlock(page, a!)).click();
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

test('a background document draws nothing and takes no clicks', async ({ page }) => {
  // React Flow writes an inline `visibility: visible` on every node, which beats the
  // `visibility: hidden` dockview puts on a background tab's panel
  const [a, b] = workflows;
  await openWorkflow(page, a!);
  const step = documentPanel(page, a!).locator('.react-flow__node-step').first();
  const at = await box(step);
  await openWorkflow(page, b!);

  await expect(documentPanel(page, a!).locator('.react-flow__node')).not.toHaveCount(0);
  for (const node of await documentPanel(page, a!).locator('.react-flow__node').all()) await expect(node).toBeHidden();
  const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.closest('.docpanel')?.querySelector('.crumb')?.getAttribute('data-tip') ?? null,
    [at.x + at.width / 2, at.y + at.height / 2]);
  expect(hit).not.toBe(a!.label);
});

test('the canvas follows its size: re-fits until zoomed, then keeps its centre', async ({ page, request }) => {
  // a chain wide enough to fit below 100% (the fit's cap) even with the side panes closed: a small live workflow is
  // already at 100% with them open and cannot grow (2026-10-11)
  const t = await createChainThrowaway(request, 5);
  try {
    await canvasFollowsItsSize(page, t.workflow);
  } finally {
    await removeThrowaway(request);
  }
});

async function canvasFollowsItsSize(page: Page, wf: LiveWorkflow): Promise<void> {
  await openWorkflow(page, wf);
  const panel = documentPanel(page, wf);
  // the graph's centre minus the canvas's centre, and the graph's width
  const view = () => panel.evaluate((p) => {
    const c = p.querySelector('.react-flow__pane')!.getBoundingClientRect();
    const ns = [...p.querySelectorAll('.react-flow__node')].map((n) => n.getBoundingClientRect());
    const l = Math.min(...ns.map((r) => r.left)), r = Math.max(...ns.map((r) => r.right));
    const t = Math.min(...ns.map((r) => r.top)), b = Math.max(...ns.map((r) => r.bottom));
    return { dx: (l + r) / 2 - (c.left + c.right) / 2, dy: (t + b) / 2 - (c.top + c.bottom) / 2, width: r - l };
  });
  const closeAll = async (names: string[]) => {
    for (const name of names) await tab(page, name).getByRole('button', { name: `Close ${name}` }).click();
  };
  const before = await view();

  // untouched: closing the side panes re-fits, so the graph grows and stays centred
  await closeAll(['Inspector', 'Toolbox']);
  await expect.poll(async () => (await view()).width).toBeGreaterThan(before.width + 20);
  const fitted = await view();
  expect(Math.abs(fitted.dx)).toBeLessThanOrEqual(4);
  expect(Math.abs(fitted.dy)).toBeLessThanOrEqual(4);

  // zoomed: the zoom stays and the point at the centre stays at the centre
  await panel.getByRole('button', { name: 'Zoom in' }).click();
  const zoom = await panel.getByLabel('Zoom level').textContent();
  const zoomed = await view();
  const height = (await box(panel.locator('.react-flow__pane'))).height;
  await closeAll(['Output']);
  await expect.poll(async () => (await box(panel.locator('.react-flow__pane'))).height).toBeGreaterThan(height + 50);
  await expect(panel.getByLabel('Zoom level')).toHaveText(zoom!);
  await expect.poll(async () => Math.abs((await view()).dy - zoomed.dy)).toBeLessThanOrEqual(4);
  expect(Math.abs((await view()).dx - zoomed.dx)).toBeLessThanOrEqual(4);
}

test('scroll bars appear only when needed, and dragging or clicking them pans', async ({ page }) => {
  const [wf] = workflows;
  await openWorkflow(page, wf!);
  const panel = documentPanel(page, wf!);
  const h = panel.getByTestId('scrollbar-h');
  const viewportX = async () => Number((await panel.locator('.react-flow__viewport').getAttribute('style'))!.match(/translate\((-?[\d.]+)px/)![1]);

  // fitted: everything is in view, so no bars
  await expect(h).toBeHidden();
  await expect(panel.getByTestId('scrollbar-v')).toBeHidden();

  for (let i = 0; i < 4; i++) await panel.getByRole('button', { name: 'Zoom in' }).click();
  await expect(h).toBeVisible();

  // dragging the thumb to the right moves the drawing to the left
  const thumb = h.locator('.th');
  const t = await box(thumb);
  const x0 = await viewportX();
  await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2);
  await page.mouse.down();
  await page.mouse.move(t.x + t.width / 2 + 60, t.y + t.height / 2, { steps: 4 });
  await page.mouse.up();
  const x1 = await viewportX();
  expect(x1).toBeLessThan(x0);

  // clicking the track beyond the thumb pages the same way
  const track = await box(h);
  const after = await box(thumb);
  test.skip(after.x + after.width > track.x + track.width - 8, 'the thumb already reaches the end of the track');
  await page.mouse.click(track.x + track.width - 4, track.y + track.height / 2);
  expect(await viewportX()).toBeLessThan(x1);

  await panel.getByRole('button', { name: 'Fit' }).click();
  await expect(h).toBeHidden();
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
  const topmostAt = (x: number, y: number, selector: string) =>
    page.evaluate(([px, py, sel]) => !!document.elementFromPoint(Number(px), Number(py))?.closest(String(sel)), [x, y, selector] as const);
  expect(await topmostAt(m.x + 20, m.y + 10, '.dropdown')).toBe(true);
  expect(m.x).toBeGreaterThanOrEqual(f.x - 1);
  await page.keyboard.press('Escape');

  // the picker: put the floating group under it, and the picker is still the topmost thing in the shared area
  await page.getByRole('menuitem', { name: 'Workflow' }).click();
  await page.getByRole('menuitem', { name: /Load…/ }).click();
  const picker = page.locator('.picker');
  await expect(picker).toBeVisible();
  await floatOver(floating, await box(picker));
  const sharedPicker = overlap(await box(picker), await box(floating));
  expect(sharedPicker, 'the picker overlaps the floating group').not.toBeNull();
  expect(await topmostAt(sharedPicker!.x + sharedPicker!.width / 2, sharedPicker!.y + sharedPicker!.height / 2, '.picker')).toBe(true);
  const pickerZ = await picker.evaluate((el) => getComputedStyle(el).zIndex);
  const floatZ = await floating.evaluate((el) => getComputedStyle(el).zIndex);
  expect(Number(pickerZ)).toBeGreaterThan(Number(floatZ));
  await page.keyboard.press('Escape');

  // the tooltip: hover the close button inside the floating group; the tooltip lands over the group
  await tab(page, 'Inspector').locator('.x').hover();
  const tip = page.getByRole('tooltip').filter({ hasText: 'Close' });
  await expect(tip).toHaveClass(/on/);
  const shared = overlap(await box(tip), await box(floating));
  expect(shared, 'the tooltip overlaps the floating group').not.toBeNull();
  // the tooltip takes no pointer events, so let it take them for a moment to see what is on top of the group
  await tip.evaluate((el) => { (el as HTMLElement).style.pointerEvents = 'auto'; });
  expect(await topmostAt(shared!.x + shared!.width / 2, shared!.y + shared!.height / 2, '[role="tooltip"]')).toBe(true);
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

  // review focus 4: the pop-out loads its own faces (fonts.check is true when no face matches, so
  // look for a real, loaded FontFace of each family the fitter measures with), and has the SVG definitions
  for (const family of ['IBM Plex Sans Condensed', 'IBM Plex Mono']) {
    await expect.poll(() => popup.evaluate((fam) => {
      let loaded = 0;
      document.fonts.forEach((f) => { if (f.family.replace(/["']/g, '') === fam && f.status === 'loaded') loaded++; });
      return loaded;
    }, family), { message: `a loaded ${family} face in the pop-out` }).toBeGreaterThan(0);
  }
  expect(await popup.evaluate(() => !!document.getElementById('glow') && !!document.getElementById('nxCap'))).toBe(true);

  // selecting in the pop-out fills the Inspector in the main window
  test.skip((await panel.locator('.react-flow__node-workflow').count()) === 0, 'the live workflow draws no clickable workflow block');
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

test('in a popped-out pane, tooltips show and a press outside closes a menu or the picker', async ({ page }) => {
  // what React draws in a pop-out after it opened belongs to the pop-out window's JS realm
  const [wf] = workflows;
  await openWorkflow(page, wf!);
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    groupOf(page, 'Inspector').getByRole('button', { name: 'Pop out to its own window' }).click(),
  ]);
  await popup.waitForLoadState();

  // the header's Dock button is drawn in the pop-out: its tooltip shows there
  await popup.getByRole('button', { name: 'Dock back into the main layout' }).hover();
  await expect(popup.getByRole('tooltip').filter({ hasText: 'Dock back into the main layout' })).toHaveClass(/on/);

  // a selection in the main window draws new Inspector rows in the pop-out
  await documentPanel(page, wf!).locator('.react-flow__node-step').first().click({ position: { x: 20, y: 12 } });
  const pill = popup.locator('[data-pane="inspector"] .kindpill');
  await expect(pill).toHaveText(/STEP/);

  await popup.getByRole('button', { name: 'Window position' }).click();
  await expect(popup.getByRole('menu')).toBeVisible();
  await pill.click();
  await expect(popup.getByRole('menu')).toHaveCount(0);

  await pill.click();
  await popup.keyboard.press('Control+o');
  await expect(popup.locator('.picker')).toBeVisible();
  // the picker opens at the pop-out's top left, over the pill: press it without a mouse
  await pill.dispatchEvent('pointerdown', { bubbles: true });
  await expect(popup.locator('.picker')).toHaveCount(0);
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
  await expect(page.locator('.dv-tab.dv-active-tab .doctab .nm').filter({ hasText: new RegExp(`^${esc(a!.name)}$`) })).toHaveCount(1);

  await page.keyboard.press('Alt+w');
  await expect(tab(page, a!.name)).toHaveCount(0);
  await expect(tab(page, b!.name)).toHaveCount(1);
});

test('Window › Apply brings back the saved layout after a refresh changed nothing else', async ({ page }) => {
  await openWorkflow(page, workflows[0]!);
  await tab(page, 'Output').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Auto hide/ }).click();
  await page.getByRole('menuitem', { name: 'Window' }).click();
  await page.getByRole('menuitem', { name: /Save window layout/ }).click();
  await expect(page.locator('.toast')).toHaveText('Window layout saved in this browser');
  await page.locator('[data-rt="output"]').click();
  await page.locator('.fly').getByRole('button', { name: /Dock/ }).click();
  await expect(page.locator('[data-rt="output"]')).toHaveCount(0);

  await page.reload();

  // the refresh keeps the page as it was: the document is back, Output docked
  await expect(documentPanel(page, workflows[0]!).locator('.react-flow__node').first()).toBeVisible();
  await expect(page.locator('[data-rt="output"]')).toHaveCount(0);
  // the saved layout is still there for Apply, and Apply keeps the document
  await page.getByRole('menuitem', { name: 'Window' }).click();
  await page.getByRole('menuitem', { name: /Apply saved layout/ }).click();
  await expect(page.locator('[data-rt="output"]')).toBeVisible();
  await expect(documentPanel(page, workflows[0]!)).toHaveCount(1);
});

test('a pane popped out at the refresh comes back docked',async ({ page }) => {
  const before = await box(groupOf(page, 'Inspector'));
  const toolbox = (await box(groupOf(page, 'Toolbox'))).width;
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    groupOf(page, 'Inspector').getByRole('button', { name: 'Pop out to its own window' }).click(),
  ]);
  await popup.waitForLoadState();
  await expect(tab(page, 'Inspector')).toHaveCount(0);
  // the space it left goes to the document area, not to the Toolbox
  await expect.poll(async () => Math.abs((await box(groupOf(page, 'Toolbox'))).width - toolbox)).toBeLessThanOrEqual(2);
  await page.getByRole('menuitem', { name: 'Window' }).click();
  await page.getByRole('menuitem', { name: /Save window layout/ }).click();
  await expect(page.locator('.toast')).toHaveText('Window layout saved in this browser');

  await page.reload();

  await expect(tab(page, 'Inspector')).toBeVisible();
  const after = await box(groupOf(page, 'Inspector'));
  for (const k of ['x', 'width'] as const) expect(Math.abs(after[k] - before[k])).toBeLessThanOrEqual(2);
});

/**
 * Resizes the window wider and taller, then narrower and shorter: the tool panes keep their width
 * (Inspector, Toolbox) and height (Output) within 2 px, and the document group takes the difference.
 */
async function expectDocumentAreaTakesSlack(page: Page, wf: LiveWorkflow) {
  const start = page.viewportSize()!;
  const sizes = async () => ({
    inspector: (await box(groupOf(page, 'Inspector'))).width,
    toolbox: (await box(groupOf(page, 'Toolbox'))).width,
    output: (await box(groupOf(page, 'Output'))).height,
    doc: await box(groupOf(page, wf.name)),
  });
  const before = await sizes();
  for (const [dw, dh] of [[240, 120], [-260, -110]] as const) {
    await page.setViewportSize({ width: start.width + dw, height: start.height + dh });
    await expect.poll(async () => Math.abs((await box(groupOf(page, wf.name))).width - (before.doc.width + dw)), { message: `the document group takes ${dw} px of width` }).toBeLessThanOrEqual(2);
    await expect.poll(async () => Math.abs((await box(groupOf(page, wf.name))).height - (before.doc.height + dh)), { message: `the document group takes ${dh} px of height` }).toBeLessThanOrEqual(2);
    const now = await sizes();
    expect(Math.abs(now.inspector - before.inspector), 'the Inspector keeps its width').toBeLessThanOrEqual(2);
    expect(Math.abs(now.toolbox - before.toolbox), 'the Toolbox keeps its width').toBeLessThanOrEqual(2);
    expect(Math.abs(now.output - before.output), 'Output keeps its height').toBeLessThanOrEqual(2);
  }
  await page.setViewportSize(start);
  await expect.poll(async () => Math.abs((await box(groupOf(page, wf.name))).width - before.doc.width)).toBeLessThanOrEqual(2);
}

test('the document area takes the resize slack: at load, after Reset and after Apply saved layout', async ({ page }) => {
  const [wf] = workflows;
  await openWorkflow(page, wf!);
  await expectDocumentAreaTakesSlack(page, wf!);

  await page.getByRole('menuitem', { name: 'Window' }).click();
  await page.getByRole('menuitem', { name: /Reset window layout/ }).click();
  await expectDocumentAreaTakesSlack(page, wf!);

  // a saved layout with a wider Inspector, applied over the default one
  const sash = await box(groupOf(page, 'Inspector'));
  await page.mouse.move(sash.x - 1, sash.y + sash.height / 2);
  await page.mouse.down();
  await page.mouse.move(sash.x - 81, sash.y + sash.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.getByRole('menuitem', { name: 'Window' }).click();
  await page.getByRole('menuitem', { name: /Save window layout/ }).click();
  await page.getByRole('menuitem', { name: 'Window' }).click();
  await page.getByRole('menuitem', { name: /Reset window layout/ }).click();
  await page.getByRole('menuitem', { name: 'Window' }).click();
  await page.getByRole('menuitem', { name: /Apply saved layout/ }).click();
  await expect(page.locator('.toast')).toHaveText('Saved window layout applied');
  expect(Math.abs((await box(groupOf(page, 'Inspector'))).width - (sash.width + 80))).toBeLessThanOrEqual(3);
  await expectDocumentAreaTakesSlack(page, wf!);
});

test('after layout every step border lies on a 32 px line and every wire point on an 8 px line', async ({ page }) => {
  const [wf] = workflows;
  await openWorkflow(page, wf!);
  const panel = documentPanel(page, wf!);
  await expect(panel.locator('.react-flow__edge path.w').first()).toBeAttached();

  const drawn = await panel.evaluate((root) => {
    // flow coordinates: a node's own translate(x, y) (React Flow positions it inside the viewport), a wire's path data
    const steps = [...root.querySelectorAll<HTMLElement>('.react-flow__node-step')].map((n) => {
      const m = /translate\(\s*(-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(n.style.transform);
      return { x: Number(m?.[1]), y: Number(m?.[2]), w: n.offsetWidth, h: n.offsetHeight };
    });
    const wires = [...root.querySelectorAll('.react-flow__edge path.w')].map((p) => p.getAttribute('d') ?? '');
    return { steps, wires };
  });

  expect(drawn.steps.length).toBeGreaterThan(0);
  for (const s of drawn.steps) {
    expect(Number.isFinite(s.x) && Number.isFinite(s.y)).toBe(true);
    for (const edge of [s.x, s.y, s.x + s.w, s.y + s.h]) expect(edge % 32, `step border ${edge}`).toBe(0);
  }
  expect(drawn.wires.length).toBeGreaterThan(0);
  for (const d of drawn.wires) {
    const numbers = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    expect(numbers.length).toBeGreaterThanOrEqual(4);
    for (const n of numbers) expect(Math.abs(n % 8), `wire point ${n} in ${d}`).toBe(0);
  }
});

test('Window › Apply after a Save made while the document group was popped out shows the document', async ({ page }) => {
  const wf = workflows[0]!;
  await openWorkflow(page, wf);
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    groupOf(page, wf.name).getByRole('button', { name: 'Pop out to its own window' }).click(),
  ]);
  await popup.waitForLoadState();
  await expect(popup.locator('.docpanel .react-flow__node').first()).toBeVisible();
  await page.getByRole('menuitem', { name: 'Window' }).click();
  await page.getByRole('menuitem', { name: /Save window layout/ }).click();
  await expect(page.locator('.toast')).toHaveText('Window layout saved in this browser');
  await popup.getByRole('button', { name: 'Dock back into the main layout' }).click();
  await expect(tab(page, wf.name)).toBeVisible();
  await page.getByRole('menuitem', { name: 'Window' }).click();
  await page.getByRole('menuitem', { name: /Apply saved layout/ }).click();
  await expect(tab(page, wf.name)).toBeVisible();
  await expect(documentPanel(page, wf).locator('.react-flow__node').first()).toBeVisible();
});
