import { LIVE } from './standin';
import { expect, test } from './valence';

// The shell and the whole-project molecule: every row an atom, every key value an arrow (spec §3b, §5); the menu strip is
// View, Window, Shortcuts (spec §3, the Shortcuts menu).

test('every row of the six tables is an atom, every key value an arrow', async ({ v }) => {
  const p = v.api.project;
  const rows = p.workflows.length + p.steps.length + p.processors.length + p.schemas.length + p.assignments.length + p.caches.length;
  const ids = (x: unknown) => (Array.isArray(x) ? x.length : 0);
  const arrows = p.workflows.reduce((n, w) => n + ids(w.entryStepIds) + ids(w.assignmentIds) + ids(w.cacheIds), 0)
    + p.steps.reduce((n, s) => n + ids(s.nextStepIds) + 1, 0)
    + p.assignments.length
    + p.processors.reduce((n, x) => n + [x.inputSchemaId, x.outputSchemaId, x.configSchemaId].filter(Boolean).length, 0);
  expect(Object.keys(await v.atoms())).toHaveLength(rows);
  const drawn = await v.page.evaluate(() => [...document.querySelectorAll('.mol')].map((e) => (e as unknown as { __molecule?: { arrows: unknown[] } }).__molecule?.arrows.length).find(Boolean));
  expect(drawn).toBe(arrows);
});

test('the rules come from BaseApi, and the legend names every kind and the health colours', async ({ v }) => {
  const rules = await v.said(/^Rules: /);
  if (!LIVE) expect(rules).toBe('Rules: from BaseApi, GET /model/fields.');
  else expect(rules).toMatch(/^Rules: /);
  const legend = (await v.page.locator('.mol-legend').innerText()).replace(/\s+/g, ' ').trim();
  for (const kind of ['Workflow', 'Step', 'Processor', 'Schema', 'Assignment', 'Cache']) expect(legend).toContain(kind);
  await expect(v.page.locator('.mol-legend-health')).toHaveText(/Processor health:\s*healthy\s*unhealthy\s*not known/);
});

test('the menu strip is View, Window and Shortcuts, with the filter and Apply at its right', async ({ v }) => {
  const strip = v.page.locator('.menubar');
  await expect(strip.locator('.menus [role="menuitem"]')).toHaveText(['View', 'Window', 'Shortcuts']);
  await expect(strip.locator('.wfsel-b')).toContainText('Workflows');
  await expect(strip.locator('.wd-b')).toHaveCount(0);
  await expect(strip.locator('.ap-b')).toHaveCount(1);
  // nothing changed yet: Apply is greyed and says why
  await expect(strip.locator('.ap-b')).toHaveAttribute('aria-disabled', 'true');
  await expect(strip.locator('.ap-b')).toHaveAttribute('data-tip', 'Nothing to apply.');
});

test('View shows and hides a pane; Window resets the layout', async ({ v }) => {
  const menu = (name: string) => v.page.locator('.menubar .menus [role="menuitem"]', { hasText: name });
  const entry = (label: string) => v.page.locator('.dropdown[role="menu"] [role="menuitem"]', { hasText: label });

  await menu('View').click();
  await expect(v.page.locator('.dropdown[role="menu"] [role="menuitem"]')).toHaveCount(4);
  for (const pane of ['Inspector', 'Toolbox', 'Output', 'Chat']) await expect(entry(pane)).toContainText('✓');
  await entry('Output').click();
  await expect(v.page.locator('[data-pane="output"]')).toHaveCount(0);
  await menu('View').click();
  await entry('Output').click();
  await expect(v.page.locator('[data-pane="output"]')).toHaveCount(1);

  await menu('Window').click();
  await entry('Reset window layout').click();
  await expect(v.page.locator('.toast.on')).toHaveText('Window layout reset');
  await expect(v.page.locator('.mol')).toHaveCount(1);
});

test('the Shortcuts sheet: ten groups, closed at first, Expand all shows every row, Escape closes, the open groups are kept', async ({ v }) => {
  const sheet = v.page.locator('.sc-sheet[role="dialog"]');
  await v.page.locator('.menubar .menus [role="menuitem"]', { hasText: 'Shortcuts' }).click();
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('.sc-t')).toHaveCount(10);
  await expect(sheet.locator('.sc-row')).toHaveCount(0);

  await sheet.getByRole('button', { name: 'Expand all' }).click();
  await expect(sheet.locator('.sc-row')).toHaveCount(42);
  await sheet.getByRole('button', { name: 'Collapse all' }).click();
  await expect(sheet.locator('.sc-row')).toHaveCount(0);

  // one group opened from its title, with its count
  const mouse = sheet.locator('.sc-t', { hasText: 'Canvas — mouse' });
  await expect(mouse.locator('.sc-n')).toHaveText('9');
  await mouse.click();
  await expect(mouse).toHaveAttribute('aria-expanded', 'true');
  await expect(sheet.locator('.sc-row')).toHaveCount(9);
  await expect(sheet.locator('.sc-row', { hasText: 'Right-drag' })).toContainText('As Ctrl+drag');

  await v.page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  // reopened: the group left open is open again (kept in this browser)
  await v.page.locator('.menubar .menus [role="menuitem"]', { hasText: 'Shortcuts' }).click();
  await expect(sheet.locator('.sc-row')).toHaveCount(9);
  // a press outside closes it too
  const b = await v.box();
  await v.page.mouse.click(b.x + 10, b.y + b.height - 10);
  await expect(sheet).toHaveCount(0);
});

test('Ctrl+E opens the window switcher, Escape closes it; Ctrl+O and Alt+W leave the pinned Canvas open', async ({ v }) => {
  await v.page.locator('.mol').first().focus();
  await v.page.keyboard.down('Control');
  await v.page.keyboard.press('e');
  await expect(v.page.locator('[role="option"].sw-i').first()).toBeVisible();
  await v.page.keyboard.press('Escape');
  await v.page.keyboard.up('Control');
  await expect(v.page.locator('[role="option"].sw-i')).toHaveCount(0);

  await v.canvasKey('Control+o');
  await expect(v.page.locator('.picker[role="dialog"]')).toHaveCount(0);
  await v.canvasKey('Alt+w');
  await expect(v.page.locator('.mol')).toHaveCount(1);
});
