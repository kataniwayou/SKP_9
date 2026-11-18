import { test, expect } from './fixtures';
import { field, inspector, openAt, payloadOf, pickStep, pickWorkflow, stNode, tab, tabLabels, wfNode, wireEdge } from './helpers';
import { seed } from './seed';

// Plan 6 (inspector-tabs spec §5): the Inspector's tabs follow what is picked: a step alone has Step · Processor; with selected workflows a
// tab per workflow whose stream holds the step. "▸ show all" reveals the five metadata rows; JSON is shown pretty; the entry condition is
// Studio's picker. Nothing is saved (the guard fails the test on any write): processor and schema fields are only read.

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

test('the three tab sets: a step alone, a triangle then the step, and two Ctrl+clicked triangles on their shared step', async ({ page }) => {
  const id = await seed(SEED);
  await openAt(page);

  // a step alone: Step · Processor, Step open
  await pickStep(page, id.s1!);
  await expect(tabLabels(page)).toHaveText(['Step', 'Processor']);
  await expect(tab(page, 'Step')).toHaveAttribute('aria-selected', 'true');
  await expect(field(page, 'Name')).toHaveValue('e2e-tab-shared');
  await tab(page, 'Processor').click();
  await expect(tab(page, 'Processor')).toHaveAttribute('aria-selected', 'true');
  await expect(field(page, 'Name')).toHaveValue('archive-expander');

  // a triangle: its Workflow tab; then the step: Step · Processor · the workflow, with the workflow's colour dot
  await pickWorkflow(page, id.wa!);
  await expect(tabLabels(page)).toHaveText(['Workflow']);
  await pickStep(page, id.s1!);
  await expect(tabLabels(page)).toHaveText(['Step', 'Processor', 'e2e-tab-a']);
  expect(await tab(page, 'e2e-tab-a').locator('.dot').evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(255, 0, 114)');
  await expect(await payloadOf(page, 'e2e-tab-a')).toHaveValue(JSON.stringify({ from: 'a', n: 1 }, null, 2));
  await expect(inspector(page).locator('.kind')).toHaveText('assignment · belongs to e2e-tab-a');

  // Ctrl+click the second triangle, then the shared step: one tab per workflow, each with its own payload
  await pickWorkflow(page, id.wa!);
  await wfNode(page, id.wb!).locator('.tri-nm').click({ modifiers: ['Control'] });
  await expect(page.locator('.react-flow__node-workflow .tri.sel')).toHaveCount(2);
  await expect(tabLabels(page)).toHaveText(['Workflow']); // the last triangle clicked
  await expect(field(page, 'Name')).toHaveValue('e2e-tab-b');
  await pickStep(page, id.s1!);
  await expect(tabLabels(page)).toHaveText(['Step', 'Processor', 'e2e-tab-a', 'e2e-tab-b']);
  expect(await tab(page, 'e2e-tab-b').locator('.dot').evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(124, 58, 237)');
  await expect(await payloadOf(page, 'e2e-tab-a')).toHaveValue(JSON.stringify({ from: 'a', n: 1 }, null, 2));
  await expect(await payloadOf(page, 'e2e-tab-b')).toHaveValue(JSON.stringify({ only: 'b' }, null, 2));
  // the chosen tab is kept while the same step stays picked
  await expect(tab(page, 'e2e-tab-b')).toHaveAttribute('aria-selected', 'true');
  // the step after it is in both streams too, but holds no assignment: both tabs, an empty payload that would make one
  await pickStep(page, id.s2!);
  await expect(tabLabels(page)).toHaveText(['Step', 'Processor', 'e2e-tab-a', 'e2e-tab-b']);
  await expect(await payloadOf(page, 'e2e-tab-a')).toHaveValue('');
  await expect(inspector(page)).toContainText('No assignment yet');
});

// Fix round 1 (B1), spec §5: the chosen tab is kept only while the same pick stays; a new pick opens the first tab.
test('a new click on a step opens its first tab, even after a tab was chosen on it before another item was picked', async ({ page }) => {
  const id = await seed(SEED);
  await openAt(page);
  await pickStep(page, id.s1!);
  await tab(page, 'Processor').click();
  await pickWorkflow(page, id.wa!);
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
  await pickWorkflow(page, id.wa!);
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
  // the Processor tab: the three schemas one under another, each definition laid out (archive-expander has all three)
  await tab(page, 'Processor').click();
  for (const slot of ['Input', 'Output', 'Config']) {
    await expect(inspector(page).locator('.sec', { hasText: new RegExp(`^${slot} schema · `) })).toHaveCount(1);
    const def = field(page, `${slot} schema definition`);
    await expect(def).toHaveCount(1);
    expect(await def.inputValue(), `${slot} schema definition`).toMatch(PRETTY);
  }
  // no In/Out/Config buttons
  await expect(inspector(page).getByRole('button', { name: /^(In|Out|Config)$/ })).toHaveCount(0);
});

test('the entry-condition picker opens by mouse, picks by a keyboard letter, and the card\'s pill letter changes', async ({ page }) => {
  const id = await seed(SEED);
  await openAt(page);
  await pickStep(page, id.s2!);
  const pill = stNode(page, id.s2!).locator('.cond-pill');
  const wire = wireEdge(page, id.s1!, id.s2!).locator('.pilltx');
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
  await expect(wire).toHaveText('F');
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
