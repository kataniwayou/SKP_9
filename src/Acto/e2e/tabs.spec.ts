import { test, expect } from './fixtures';
import { childLabels, childTab, field, inspector, openAt, payloadOf, pickStep, pickWorkflow, selectWorkflowAlone, stNode, tab, tabLabels, wfNode, wireEdge } from './helpers';
import { seed } from './seed';

// Plan 6 (inspector-tabs spec §5), [user, 2026-11-18]: a picked step has two parent tabs, Step and Processor, each showing its own
// fields; with exactly one triangle picked beside it, Step's child row holds that workflow's assignment, Processor's one tab per
// schema its processor holds. No child is chosen at first; a child row with no tabs is not drawn. "▸ show all" reveals the five metadata
// rows; JSON is shown pretty; the entry condition is Studio's picker. Nothing is saved (the guard fails the test on any write):
// processor and schema fields are only read.

const SEED = {
  steps: [
    { key: 's1', name: 'e2e-tab-shared', at: { x: 260, y: 100 }, next: ['s2'] },
    { key: 's2', name: 'e2e-tab-next', at: { x: 560, y: 100 } },
  ],
  payloads: [
    { key: 'pa', step: 's1', payload: '{"from":"a","n":1}' },
    { key: 'pb', step: 's1', payload: '{"only":"b"}' },
  ],
  workflows: [
    { key: 'wa', name: 'e2e-tab-a', at: { x: 0, y: 40 }, entry: ['s1'], payloads: ['pa'] },
    { key: 'wb', name: 'e2e-tab-b', at: { x: 0, y: 220 }, entry: ['s1'], payloads: ['pb'] },
  ],
} as const;

const PRETTY = /\n {2}"/; // one field to a line, two-space indent

test('a step alone; a triangle with the step shows that workflow\'s assignment under Step; two triangles and the step: a tab each; one triangle and a step again', async ({ page }) => {
  const id = await seed(SEED);
  await openAt(page);
  const stepRow = inspector(page).getByRole('tablist', { name: 'Step tabs' });

  // a step alone: Step · Processor, Step open with its own fields, no child row
  await pickStep(page, id.s1!);
  await expect(tabLabels(page)).toHaveText(['Step', 'Processor']);
  await expect(tab(page, 'Step')).toHaveAttribute('aria-selected', 'true');
  await expect(field(page, 'Name')).toHaveValue('e2e-tab-shared');
  await expect(stepRow).toHaveCount(0);
  await tab(page, 'Processor').click();
  await expect(tab(page, 'Processor')).toHaveAttribute('aria-selected', 'true');
  await expect(field(page, 'Name')).toHaveValue('archive-expander');

  // a click on a triangle keeps the step: Step · Processor, the workflow as Step's one child with its colour dot, none chosen
  await pickWorkflow(page, id.wa!);
  await expect(tabLabels(page)).toHaveText(['Step', 'Processor']);
  await expect(tab(page, 'Processor')).toHaveAttribute('aria-selected', 'true'); // the same step stays picked: its tab is kept
  await tab(page, 'Step').click();
  await expect(childLabels(page, 'Step')).toHaveText(['e2e-tab-a']);
  await expect(childTab(page, 'Step', 'e2e-tab-a')).toHaveAttribute('aria-selected', 'false');
  await expect(field(page, 'Name')).toHaveValue('e2e-tab-shared');
  expect(await childTab(page, 'Step', 'e2e-tab-a').locator('.dot').evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(255, 0, 114)');
  await expect(await payloadOf(page, 'e2e-tab-a')).toHaveValue(JSON.stringify({ from: 'a', n: 1 }, null, 2));
  await expect(inspector(page).locator('.kind')).toHaveText('assignment · belongs to e2e-tab-a');
  await expect(tab(page, 'Step')).toHaveAttribute('aria-selected', 'true');
  // the parent tab again: the step's own fields
  await tab(page, 'Step').click();
  await expect(field(page, 'Name')).toHaveValue('e2e-tab-shared');
  await expect(childTab(page, 'Step', 'e2e-tab-a')).toHaveAttribute('aria-selected', 'false');

  // the step clicked again leaves: the workflow alone, its Workflow tab; Ctrl+click the second triangle: the list of both
  await pickStep(page, id.s1!);
  await expect(tabLabels(page)).toHaveText(['Workflow']);
  await expect(field(page, 'Name')).toHaveValue('e2e-tab-a');
  await wfNode(page, id.wb!).locator('.tri-nm').click({ modifiers: ['Control'] });
  await expect(page.locator('.react-flow__node-workflow .tri.sel')).toHaveCount(2);
  await expect(tabLabels(page)).toHaveCount(0);
  await expect(inspector(page).locator('.in-picks li')).toHaveText(['e2e-tab-a', 'e2e-tab-b']);
  // the shared step with both triangles (both reach it): one assignment tab each, in pick order [user, 2026-11-19]
  await pickStep(page, id.s1!);
  await expect(tabLabels(page)).toHaveText(['Step', 'Processor']);
  await expect(childLabels(page, 'Step')).toHaveText(['e2e-tab-a', 'e2e-tab-b']);
  await expect(await payloadOf(page, 'e2e-tab-b')).toHaveValue(JSON.stringify({ only: 'b' }, null, 2));
  await expect(await payloadOf(page, 'e2e-tab-a')).toHaveValue(JSON.stringify({ from: 'a', n: 1 }, null, 2));
  // B clicked off: the step with A's assignment
  await pickWorkflow(page, id.wb!);
  await expect(childLabels(page, 'Step')).toHaveText(['e2e-tab-a']);
  // A clicked off, B clicked: the step with B's assignment, in the first hue
  await pickWorkflow(page, id.wa!);
  await expect(stepRow).toHaveCount(0);
  await pickWorkflow(page, id.wb!);
  await expect(childLabels(page, 'Step')).toHaveText(['e2e-tab-b']);
  expect(await childTab(page, 'Step', 'e2e-tab-b').locator('.dot').evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(255, 0, 114)');
  await expect(await payloadOf(page, 'e2e-tab-b')).toHaveValue(JSON.stringify({ only: 'b' }, null, 2));
  // the chosen child is kept while the same picks stay
  await expect(childTab(page, 'Step', 'e2e-tab-b')).toHaveAttribute('aria-selected', 'true');
  // the step after it is in B's stream too, but holds no assignment: no Payload, only ＋ Create (as Studio)
  await pickStep(page, id.s2!);
  await expect(childLabels(page, 'Step')).toHaveText(['e2e-tab-b']);
  await expect(field(page, 'Name')).toHaveValue('e2e-tab-next'); // a new pick: Step, no child
  await childTab(page, 'Step', 'e2e-tab-b').click();
  await expect(inspector(page)).toContainText('No assignment yet');
  await expect(field(page, 'Payload')).toHaveCount(0);
  await expect(inspector(page).getByRole('button', { name: '＋ Create' })).toBeVisible();
});

// Fix round 1 (B1), spec §5: the chosen tab is kept only while the same pick stays; a new pick opens the first tab.
test('a new click on a step opens its first tab, even after a tab was chosen on it before another item was picked', async ({ page }) => {
  const id = await seed(SEED);
  await openAt(page);
  await pickStep(page, id.s1!);
  await tab(page, 'Processor').click();
  await pickStep(page, id.s2!);
  await expect(tab(page, 'Step')).toHaveAttribute('aria-selected', 'true');
  await tab(page, 'Processor').click();
  await pickStep(page, id.s1!);
  await expect(tab(page, 'Step')).toHaveAttribute('aria-selected', 'true');
});

test('show all reveals the five metadata rows and hide details hides them, for the whole Inspector', async ({ page }) => {
  const id = await seed(SEED);
  await openAt(page);
  await pickStep(page, id.s1!);
  const meta = inspector(page).locator('.meta');
  await expect(meta).toHaveCount(0);
  await inspector(page).getByRole('button', { name: '▸ show all' }).click();
  await expect(meta.locator('dt')).toHaveText(['Id', 'Created at', 'Created by', 'Updated at', 'Updated by']);
  await expect(meta.locator('dd').nth(0)).toHaveText(id.s1!);
  await expect(meta.locator('dd').nth(1)).toHaveText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} UTC$/);
  await expect(meta.locator('dd').nth(3)).toHaveText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} UTC$/);
  await expect(inspector(page).getByRole('button', { name: '▾ hide details' })).toBeVisible();
  // one toggle state: another item's tab opens with the details shown
  await selectWorkflowAlone(page, id.wa!);
  await expect(inspector(page).locator('.meta dd').first()).toHaveText(id.wa!);
  await inspector(page).getByRole('button', { name: '▾ hide details' }).click();
  await expect(inspector(page).locator('.meta')).toHaveCount(0);
  await expect(inspector(page).getByRole('button', { name: '▸ show all' })).toBeVisible();
});

test('payload and schema definitions are pretty JSON', async ({ page }) => {
  const id = await seed(SEED);
  await openAt(page);
  await pickWorkflow(page, id.wa!);
  await pickStep(page, id.s1!);
  const payload = await payloadOf(page, 'e2e-tab-a');
  expect(await payload.inputValue()).toMatch(PRETTY);
  // the schemas are Processor's children (archive-expander has all three), none chosen at first [user, 2026-11-18]
  await tab(page, 'Processor').click();
  await expect(childLabels(page, 'Processor')).toHaveText(['Input schema', 'Output schema', 'Config schema']);
  for (const slot of ['Input', 'Output', 'Config']) await expect(childTab(page, 'Processor', `${slot} schema`)).toHaveAttribute('aria-selected', 'false');
  // Processor's own fields: Source hash and Instance id, the slots as read-only rows, no schema editors
  await expect(field(page, 'Source hash')).toHaveValue(/\S/);
  await expect(field(page, 'Instance id')).toHaveCount(1);
  await expect(field(page, 'Definition')).toHaveCount(0);
  for (const slot of ['Input', 'Output', 'Config']) {
    await expect(inspector(page).locator('dt', { hasText: `${slot} schema` }).locator('xpath=following-sibling::dd[1]')).not.toHaveText('none');
  }
  await expect(inspector(page).getByRole('button', { name: /^(In|Out|Config)$/ })).toHaveCount(0);
  for (const slot of ['Input', 'Output', 'Config']) {
    await childTab(page, 'Processor', `${slot} schema`).click();
    await expect(childTab(page, 'Processor', `${slot} schema`)).toHaveAttribute('aria-selected', 'true');
    await expect(tab(page, 'Processor')).toHaveAttribute('aria-selected', 'true');
    await expect(inspector(page).locator('.kind')).toHaveText(`schema · ${slot.toLowerCase()} of archive-expander`);
    const def = field(page, 'Definition');
    await expect(def).toHaveCount(1);
    expect(await def.inputValue(), `${slot} schema definition`).toMatch(PRETTY);
  }
  // the parent tab again: the processor's own fields, no child chosen
  await tab(page, 'Processor').click();
  await expect(field(page, 'Source hash')).toHaveCount(1);
  await expect(childTab(page, 'Processor', 'Config schema')).toHaveAttribute('aria-selected', 'false');
  // a new pick opens Step with no child
  await pickStep(page, id.s2!);
  await expect(tab(page, 'Step')).toHaveAttribute('aria-selected', 'true');
  await expect(field(page, 'Name')).toHaveValue('e2e-tab-next');
});

test('the entry-condition picker opens by mouse, picks by a keyboard letter, and the card\'s pill letter changes', async ({ page }) => {
  const id = await seed(SEED);
  await openAt(page);
  await pickStep(page, id.s2!);
  const pill = stNode(page, id.s2!).locator('.cond-pill');
  const wire = wireEdge(page, id.s1!, id.s2!).locator('.link-wire');
  await expect(pill).toHaveText('C');
  const picker = field(page, 'Entry condition');
  await expect(picker).toHaveAttribute('data-value', '1');

  // by mouse: the list opens with the five conditions, the current one ticked
  await picker.click();
  const list = inspector(page).getByRole('listbox', { name: 'Entry conditions' });
  await expect(list).toBeVisible();
  await expect(list.getByRole('option')).toHaveCount(5);
  await expect(list.getByRole('option', { selected: true })).toContainText('Completed');
  // a letter moves to its condition, Enter picks it
  await page.keyboard.press('f');
  await page.keyboard.press('Enter');
  await expect(list).toHaveCount(0);
  await expect(picker).toHaveAttribute('data-value', '2');
  await expect(pill).toHaveText('F');
  await expect(wire).toHaveAttribute('data-condition', 'Failed');
  // closed, a letter picks at once
  await page.keyboard.press('x');
  await expect(picker).toHaveAttribute('data-value', '3');
  await expect(pill).toHaveText('X');
  // Escape closes the list without a change
  await picker.click();
  await expect(list).toBeVisible();
  await page.keyboard.press('a');
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  await expect(pill).toHaveText('X');
  await expect(stNode(page, id.s2!).locator('.unsaved-mark')).toBeVisible();
});

test('[user, 2026-11-19] the Step tab removes a wire out by its chip; a Workflow tab assignment opens Step › that workflow', async ({ page }) => {
  const id = await seed(SEED);
  await openAt(page);

  // the Workflow tab's assignment link: the workflow with the step, Step › the workflow's assignment open
  await selectWorkflowAlone(page, id.wa!);
  await inspector(page).getByRole('button', { name: 'Open assignment e2e-tab-shared' }).click();
  await expect(stNode(page, id.s1!).locator('.node.sel')).toHaveCount(1);
  await expect(wfNode(page, id.wa!).locator('.tri.sel')).toHaveCount(1);
  await expect(tab(page, 'Step')).toHaveAttribute('aria-selected', 'true');
  await expect(childTab(page, 'Step', 'e2e-tab-a')).toHaveAttribute('aria-selected', 'true');
  await expect(await payloadOf(page, 'e2e-tab-a')).toHaveValue(JSON.stringify({ from: 'a', n: 1 }, null, 2));

  // the step's own tab: its wire out as a chip; ✕ removes the wire from the board (unsaved), Undo brings it back
  await tab(page, 'Step').click();
  await expect(wireEdge(page, id.s1!, id.s2!)).toHaveCount(1);
  await inspector(page).getByRole('button', { name: 'Remove wire to e2e-tab-next' }).click();
  await expect(wireEdge(page, id.s1!, id.s2!)).toHaveCount(0);
  await expect(inspector(page).getByRole('button', { name: 'Remove wire to e2e-tab-next' })).toHaveCount(0);
  await inspector(page).getByRole('button', { name: 'Undo' }).click();
  await expect(wireEdge(page, id.s1!, id.s2!)).toHaveCount(1);
});

test('[user, 2026-11-19] a schema\'s Definition is read-only (Name, Version, Description stay editable); every label sits above its value, as in Studio', async ({ page }) => {
  const id = await seed(SEED);
  await openAt(page);
  await pickWorkflow(page, id.wa!);
  await pickStep(page, id.s1!);
  await tab(page, 'Processor').click();
  for (const slot of ['Input', 'Output', 'Config']) {
    await childTab(page, 'Processor', `${slot} schema`).click();
    await expect(field(page, 'Definition'), `${slot}: Definition`).toBeDisabled();
    for (const label of ['Name', 'Version', 'Description']) await expect(field(page, label), `${slot}: ${label}`).toBeEnabled();
    await expect(inspector(page).locator('.in-readonly')).toHaveText('The definition is read-only: a change needs the processor restarted.');
  }
  // nothing was changed by looking
  await expect(page.locator('button.save-board')).toHaveText('Save');

  // label above value: each field's label box ends above its control, both starting at the same left edge
  const labelAbove = async (what: string) => {
    for (const f of await inspector(page).locator('label.fld').all()) {
      const lab = (await f.locator(':scope > span').boundingBox())!;
      const ctl = (await f.locator('input, textarea, button.cp-btn').first().boundingBox())!;
      expect(lab.y + lab.height, `${what}: ${await f.locator(':scope > span').innerText()} above`).toBeLessThanOrEqual(ctl.y + 1);
      expect(Math.abs(lab.x - ctl.x), `${what}: ${await f.locator(':scope > span').innerText()} left edges`).toBeLessThan(3);
    }
  };
  await labelAbove('schema tab');
  await tab(page, 'Processor').click();
  await labelAbove('processor tab');
  await tab(page, 'Step').click();
  await labelAbove('step tab');
  await childTab(page, 'Step', 'e2e-tab-a').click();
  await labelAbove('assignment tab');
  // read-outs too: a term above its value
  await tab(page, 'Step').click();
  const dt = inspector(page).locator('dt', { hasText: 'Used by' });
  const dd = dt.locator('xpath=following-sibling::dd[1]');
  const a = (await dt.boundingBox())!, b = (await dd.boundingBox())!;
  expect(a.y + a.height).toBeLessThanOrEqual(b.y + 1);
  expect(Math.abs(a.x - b.x)).toBeLessThan(3);
});
