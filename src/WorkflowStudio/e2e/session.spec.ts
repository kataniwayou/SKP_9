import { documentPanel, esc, expect, groupOf, inspector, liveWorkflows, openWorkflow, settledView, tab, test, type LiveWorkflow } from './studio';

// Spec §6.1 (amended 2026-10-06): a refresh keeps the documents, the dock and each drawing's view. Read-only.
let workflows: LiveWorkflow[];
test.beforeAll(async ({ request }) => { workflows = await liveWorkflows(request, 2); });
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
});

test('a refresh brings back the open workflows, the active tab, each selection and view, and the panes', async ({ page }) => {
  const [a, b] = workflows;
  await openWorkflow(page, a!);
  await documentPanel(page, a!).locator('.react-flow__node-step').first().click({ position: { x: 20, y: 12 } });
  await expect(inspector(page).locator('.kindpill')).toHaveText(/STEP/);
  await openWorkflow(page, b!);
  const panelB = documentPanel(page, b!);
  await panelB.getByRole('button', { name: 'Zoom in' }).click();
  await panelB.getByRole('button', { name: 'Zoom in' }).click();
  const zoom = await panelB.getByLabel('Zoom level').textContent();
  await tab(page, 'Problems').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Auto hide/ }).click();
  await expect(page.locator('[data-rt="problems"]')).toBeVisible();
  // the canvas grows when Problems hides (then gives back its strip's height) and keeps its centre: the view
  // as left is the one it settles at
  const transform = await settledView(page, panelB.locator('.react-flow__viewport'));

  await page.reload();

  await expect(documentPanel(page, b!).locator('.react-flow__node').first()).toBeVisible();
  await expect(tab(page, a!.name)).toBeVisible();
  await expect(page.locator('.dv-tab.dv-active-tab .doctab .nm').filter({ hasText: new RegExp(`^${esc(b!.name)}$`) })).toHaveCount(1);
  await expect(documentPanel(page, b!).getByLabel('Zoom level')).toHaveText(zoom!);
  expect(await documentPanel(page, b!).locator('.react-flow__viewport').getAttribute('style')).toBe(transform);
  await expect(page.locator('[data-rt="problems"]')).toBeVisible();

  await tab(page, a!.name).click();
  await expect(documentPanel(page, a!).locator('.react-flow__node-step.studio-sel')).toHaveCount(1);
  await expect(inspector(page).locator('.kindpill')).toHaveText(/STEP/);
});

test('a workflow closed before the refresh stays closed', async ({ page }) => {
  const [a, b] = workflows;
  await openWorkflow(page, a!);
  await openWorkflow(page, b!);
  await tab(page, a!.name).getByRole('button', { name: `Close ${a!.name}` }).click();

  await page.reload();

  await expect(documentPanel(page, b!).locator('.react-flow__node').first()).toBeVisible();
  await expect(tab(page, a!.name)).toHaveCount(0);
});

test('a document popped out when the page went away comes back shown in the main window', async ({ page }) => {
  const [a] = workflows;
  await openWorkflow(page, a!);
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    groupOf(page, a!.name).getByRole('button', { name: 'Pop out to its own window' }).click(),
  ]);
  await popup.waitForLoadState();
  await expect(popup.locator('.docpanel .react-flow__node').first()).toBeVisible();
  // the session as written while the document is popped out (its dock holds no document panel)
  const popped = () => page.evaluate(() => {
    const text = localStorage.getItem('skp.studio.session');
    const session = text === null ? null : JSON.parse(text) as { docs: unknown[]; dock: { dock: { panels: Record<string, unknown> } } | null };
    return session && session.docs.length === 1 && session.dock && !Object.keys(session.dock.dock.panels).some((id) => id.startsWith('doc:')) ? text : null;
  });
  await expect.poll(popped).not.toBeNull();
  const session = (await popped())!;
  // A normal reload closes the pop-out first (dockview, on beforeunload), docking the document back.
  // A page that goes away without that (a crash, a discarded tab) starts from this session: load it.
  await page.addInitScript((text) => { sessionStorage.setItem('skp.studio.session', text); localStorage.setItem('skp.studio.session', text); }, session);

  await page.reload();

  await expect(tab(page, a!.name)).toBeVisible();
  await expect(documentPanel(page, a!).locator('.react-flow__node').first()).toBeVisible();
});
