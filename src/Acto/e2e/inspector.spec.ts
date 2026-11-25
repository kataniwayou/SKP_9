import { test, expect } from './fixtures';
import { addItem, caNode, field, itemKey, itemValue, inspector, openAt, payloadOf, pickCache, pickStep, selectWorkflowAlone, pretty, saveButton, stNode, childTab, tab, wfNode, wireEdge } from './helpers';
import { seed } from './seed';

// Spec §6–§7: every field of a triangle, a step and a cache edits through the Inspector; the payload check; one undo history for the whole
// board. Nothing is saved: edits are on the board only, and the guard would fail the test on any write.

const SEED = {
  steps: [
    { key: 's1', name: 'e2e-ins-first', at: { x: 260, y: 100 }, next: ['s2'] },
    { key: 's2', name: 'e2e-ins-second', at: { x: 560, y: 100 } },
  ],
  caches: [{ key: 'c1', name: 'e2e-ins-cache', at: { x: 40, y: 380 } }],
  payloads: [
    { key: 'p1', step: 's1', payload: '{"first":1}' },
    { key: 'p2', step: 's2', payload: '{"second":2}' },
  ],
  workflows: [
    { key: 'wa', name: 'e2e-ins-a', at: { x: 0, y: 40 }, entry: ['s1'], caches: ['c1'], payloads: ['p1', 'p2'], entryCrons: { s1: '0 0 * * * *' } },
    { key: 'wb', name: 'e2e-ins-b', at: { x: 0, y: 220 }, entry: ['s2'] },
  ],
} as const;

const undo = (page: import('@playwright/test').Page) => inspector(page).getByRole('button', { name: 'Undo', exact: true });
const redo = (page: import('@playwright/test').Page) => inspector(page).getByRole('button', { name: 'Redo', exact: true });

test('a triangle\'s Inspector: name, version, the cron of its entry step with its reading, description, entry steps, caches, location and assignments', async ({ page }) => {
  const id = await seed(SEED);
  await openAt(page);
  await selectWorkflowAlone(page, id.wa!);
  await expect(inspector(page).locator('.ph .cnt')).toHaveText('workflow');
  await expect(inspector(page).locator('[aria-label="Unique name"]')).toHaveText('e2e-ins-a 1.0.0');
  await expect(field(page, 'Name')).toHaveValue('e2e-ins-a');
  await expect(field(page, 'Version')).toHaveValue('1.0.0');
  // no cron of its own: one Schedules row per entry step
  await expect(inspector(page).getByTestId(`schedule:${id.s1}`).locator('.sec-sub')).toHaveText('e2e-ins-first');
  await expect(field(page, 'Cron')).toHaveCount(1);
  await expect(field(page, 'Cron')).toHaveValue('0 0 * * * *');
  await expect(inspector(page)).toContainText(/every hour|hourly|at minute 0|hour/i);
  await expect(inspector(page).locator('.chip:not(.in-assign)', { hasText: 'e2e-ins-first' })).toHaveCount(1);
  await expect(inspector(page).locator('.chip', { hasText: 'e2e-ins-cache' })).toBeVisible();
  await expect(inspector(page).getByText('Caches · 1')).toBeVisible();
  await expect(inspector(page).locator('dt', { hasText: 'Location' }).locator('xpath=following-sibling::dd[1]')).toHaveText(/^-?\d+, -?\d+$/);
  // its assignments, each naming the step it references
  const asg = inspector(page).getByTestId('assignments');
  await expect(asg.locator('.in-assign')).toHaveCount(2);
  expect([...(await asg.locator('.chip-nm').allInnerTexts())].sort()).toEqual(['e2e-ins-first', 'e2e-ins-second']);
  await expect(asg.locator('.in-assign .chip-sub').first()).toHaveText(/^◆ \d+ keys?$/);

  // every field edits, each marking the triangle unsaved
  await expect(wfNode(page, id.wa!).locator('.unsaved-mark')).toHaveCount(0);
  await field(page, 'Name').fill('e2e-ins-a-renamed');
  await expect(wfNode(page, id.wa!).locator('.tri-nm')).toHaveText('e2e-ins-a-renamed');
  await expect(wfNode(page, id.wa!).locator('.unsaved-mark')).toBeVisible();
  await field(page, 'Version').fill('2.5.1');
  await field(page, 'Description').fill('an e2e description');
  await field(page, 'Cron').fill('0 */5 * * * *');
  await expect(inspector(page)).toContainText(/5 minutes/i);
  await field(page, 'Cron').fill('not a cron');
  // the reading under the field, not the row: the row also holds the presets list, whose options say "Every …"
  await expect(inspector(page).getByTestId(`schedule:${id.s1}`).locator('.in-note')).toHaveText(/has 3/);
  await field(page, 'Cron').fill('');
  await expect(field(page, 'Cron')).toHaveAttribute('placeholder', 'not scheduled');
  await expect(inspector(page).getByTestId(`schedule:${id.s1}`).locator('.in-note')).toHaveCount(0);
  await expect(field(page, 'Version')).toHaveValue('2.5.1');
  await expect(field(page, 'Description')).toHaveValue('an e2e description');
  await expect(saveButton(page)).toContainText('Save ·');

  // an entry step and a cache can be removed from here: the arrow and the line go
  await inspector(page).getByRole('button', { name: 'Remove entry e2e-ins-first' }).click();
  await expect(page.locator(`.react-flow__edge[data-id="entry:${id.wa}:${id.s1}"]`)).toHaveCount(0);
  await expect(inspector(page)).toContainText('No entry steps — draw an entry arrow to schedule this workflow.');
  await inspector(page).getByRole('button', { name: 'Remove cache e2e-ins-cache' }).click();
  await expect(page.locator(`.react-flow__edge[data-id="cache:${id.wa}:${id.c1}"]`)).toHaveCount(0);
  await expect(inspector(page).locator('.chip:not(.in-assign)', { hasText: 'e2e-ins-first' })).toHaveCount(0);
  await expect(inspector(page).getByText('Caches · 0')).toBeVisible();
});

test('a step\'s Inspector: shared name, version, description and entry condition (which colours its wires); the processor tab is shown, not edited', async ({ page }) => {
  const id = await seed(SEED);
  await openAt(page);
  await pickStep(page, id.s2!);
  await expect(inspector(page).locator('.ph .cnt')).toHaveText('step');
  await expect(field(page, 'Name')).toHaveValue('e2e-ins-second');
  await expect(field(page, 'Version')).toHaveValue('1.0.0');
  await expect(field(page, 'Description')).toHaveValue('');
  await expect(field(page, /^Entry condition/)).toHaveAttribute('data-value', '1');
  // the processor tab and its liveness are there (never edited by the suite)
  await tab(page, 'Processor').click();
  await expect(field(page, 'Name')).toHaveValue('archive-expander');
  await expect(inspector(page).locator('dt', { hasText: 'Liveness' })).toBeVisible();
  await expect(field(page, 'Source hash')).toHaveValue(/^\S+$/);
  // its input schema is a child tab of Processor, the definition pretty JSON [user, 2026-11-18]
  await childTab(page, 'Processor', 'Input schema').click();
  await expect(field(page, 'Definition')).toHaveValue(/\n {2}"/);
  await tab(page, 'Step').click();

  await field(page, 'Name').fill('e2e-ins-second-renamed');
  await expect(stNode(page, id.s2!).locator('.sn')).toHaveText('e2e-ins-second-renamed');
  await field(page, 'Version').fill('3.0.0');
  await field(page, 'Description').fill('step description');
  // the wire into this step names its entry condition (data-condition; it draws none of its own [user, 2026-11-25])
  const pill = wireEdge(page, id.s1!, id.s2!).locator('.link-wire');
  const was = await pill.getAttribute('data-condition');
  await field(page, /^Entry condition/).click();
  await inspector(page).getByRole('option', { name: /Cancelled/ }).click();
  await expect(pill).not.toHaveAttribute('data-condition', was!);
  await expect(pill).toHaveAttribute('data-condition', 'Cancelled');
  await expect(stNode(page, id.s2!).locator('.unsaved-mark')).toBeVisible();
  await expect(field(page, 'Description')).toHaveValue('step description');
});

test('a cache\'s Inspector: name, version, description, root and items', async ({ page }) => {
  const id = await seed(SEED);
  await openAt(page);
  await pickCache(page, id.c1!);
  await expect(inspector(page).locator('.ph .cnt')).toHaveText('cache');
  await expect(field(page, 'Name')).toHaveValue('e2e-ins-cache');
  await expect(field(page, 'Root')).toHaveValue('e2e');
  await expect(inspector(page).getByText('0 items')).toBeVisible();
  await expect(inspector(page)).toContainText('cache · used by e2e-ins-a');
  await field(page, 'Name').fill('e2e-ins-cache-renamed');
  await expect(caNode(page, id.c1!).locator('.cache-nm')).toHaveText('e2e-ins-cache-renamed');
  await field(page, 'Version').fill('1.2.0');
  await field(page, 'Description').fill('cache description');
  await field(page, 'Root').fill('e2e-root');
  await addItem(page, 1, 'k', 'v');
  await expect(caNode(page, id.c1!).locator('.unsaved-mark')).toBeVisible();
  await expect(field(page, 'Root')).toHaveValue('e2e-root');
  await expect(itemKey(page, 1)).toHaveValue('k');
  await expect(itemValue(page, 1)).toHaveValue('v');
});

test('the payload field checks JSON as it is typed; the triangle lists its assignments read-only, and the step edits and removes them', async ({ page }) => {
  const id = await seed(SEED);
  await openAt(page);
  await selectWorkflowAlone(page, id.wa!);
  const asg = inspector(page).getByTestId('assignments');
  // one trigger per action: the triangle's list has no payload editor, no Delete and no ✕
  await expect(asg.locator('.in-assign')).toHaveCount(2);
  await expect(asg.locator('textarea')).toHaveCount(0);
  await expect(asg.getByRole('button', { name: 'Delete' })).toHaveCount(0);
  await expect(asg.locator('.in-assign .chip-sub').first()).toHaveText(/^◆ 1 key$/);

  // the payload is edited through the step with the triangle selected
  await pickStep(page, id.s1!);
  const box = await payloadOf(page, 'e2e-ins-a');
  await expect(box).toHaveValue(pretty('{"first":1}'));
  await box.fill('{"first": ');
  await expect(inspector(page).locator('.in-problem')).toContainText('Not valid JSON');
  await box.fill('{"first": 2}');
  await expect(inspector(page).locator('.in-problem').filter({ hasText: 'Not valid JSON' })).toHaveCount(0);
  await expect(wfNode(page, id.wa!).locator('.unsaved-mark')).toBeVisible();
  // more edits through the same step tab
  await expect(field(page, 'Payload')).toHaveValue('{"first": 2}');
  await expect(stNode(page, id.s1!).locator('.key-chip')).toContainText('1 key');
  await field(page, 'Payload').fill('nope');
  await expect(inspector(page).locator('.in-problem')).toContainText('Not valid JSON');
  await field(page, 'Payload').fill('{"a":1,"b":2,"c":3}');
  await expect(stNode(page, id.s1!).locator('.key-chip')).toContainText('3 key');
  // Remove assignment unlinks it
  await inspector(page).getByRole('button', { name: 'Remove assignment' }).click();
  await expect(stNode(page, id.s1!).locator('.key-chip')).toHaveCount(0);
  await selectWorkflowAlone(page, id.wa!);
  await expect(asg.locator('.in-assign')).toHaveCount(1);
  await pickStep(page, id.s2!);
  await payloadOf(page, 'e2e-ins-a');
  await inspector(page).getByRole('button', { name: 'Remove assignment' }).click();
  await selectWorkflowAlone(page, id.wa!);
  await expect(inspector(page)).toContainText('No assignments.');
});

test('one undo history for the whole board: edits across two workflows undo and redo in order, from the buttons and from Ctrl+Z / Ctrl+Y', async ({ page }) => {
  const id = await seed(SEED);
  await openAt(page);
  await expect(undo(page)).toBeDisabled();
  await expect(redo(page)).toBeDisabled();
  await selectWorkflowAlone(page, id.wa!);
  await field(page, 'Description').fill('edit one, in A');
  await selectWorkflowAlone(page, id.wb!);
  await field(page, 'Description').fill('edit two, in B');
  await pickCache(page, id.c1!);
  await field(page, 'Root').fill('edit-three');
  await expect(undo(page)).toBeEnabled();

  // the buttons: the last edit first, whichever item it was in
  await undo(page).click();
  await expect(field(page, 'Root')).toHaveValue('e2e');
  await expect(redo(page)).toBeEnabled();
  await selectWorkflowAlone(page, id.wb!);
  await expect(field(page, 'Description')).toHaveValue('edit two, in B');
  await undo(page).click();
  await expect(field(page, 'Description')).toHaveValue('');
  await expect(wfNode(page, id.wb!).locator('.unsaved-mark')).toHaveCount(0);
  await selectWorkflowAlone(page, id.wa!);
  await expect(field(page, 'Description')).toHaveValue('edit one, in A');

  // Ctrl+Z with the focus on the board (the browser keeps it while typing in a field): A's edit goes too
  await selectWorkflowAlone(page, id.wa!);
  await page.keyboard.press('Control+z');
  await expect(field(page, 'Description')).toHaveValue('');
  await expect(undo(page)).toBeDisabled();
  await expect(saveButton(page).or(page.locator('button.save-board'))).toBeVisible();

  // and forward again: Ctrl+Y, then Ctrl+Shift+Z
  await page.keyboard.press('Control+y');
  await expect(field(page, 'Description')).toHaveValue('edit one, in A');
  await page.keyboard.press('Control+y');
  await selectWorkflowAlone(page, id.wb!);
  await expect(field(page, 'Description')).toHaveValue('edit two, in B');
  await page.keyboard.press('Control+Shift+z');
  await expect(redo(page)).toBeDisabled();
  await pickCache(page, id.c1!);
  await expect(field(page, 'Root')).toHaveValue('edit-three');

  // a new edit after an undo drops the redo branch
  await undo(page).click();
  await expect(redo(page)).toBeEnabled();
  await field(page, 'Description').fill('a new branch');
  await expect(redo(page)).toBeDisabled();
});

// Fix round 1 (B2): a click on the button right under a JSON field just typed in lands on the button (the field keeps its height on blur).
test('a click on Remove assignment right after typing a one-line payload removes it', async ({ page }) => {
  const id = await seed(SEED);
  await openAt(page);
  await selectWorkflowAlone(page, id.wa!);
  await pickStep(page, id.s1!);
  await (await payloadOf(page, 'e2e-ins-a')).fill('{"a":1,"b":2,"c":3}');
  await expect(stNode(page, id.s1!).locator('.key-chip')).toContainText('3 key');
  await inspector(page).getByRole('button', { name: 'Remove assignment' }).click();
  await expect(stNode(page, id.s1!).locator('.key-chip')).toHaveCount(0);
});

test('[user, 2026-11-19] every Workflow-tab chip opens its item, shows the hover style, and only a connection has a ✕', async ({ page }) => {
  const id = await seed(SEED);
  await openAt(page);
  const chips = inspector(page).locator('.chip-link');
  const asg = inspector(page).getByTestId('assignments');

  // one style: entry steps, caches and assignments are all link chips; hover turns the border to the accent; ✕ only on the entry and the cache
  await selectWorkflowAlone(page, id.wa!);
  await expect(chips).toHaveCount(4); // 1 entry, 1 cache, 2 assignments
  await expect(inspector(page).locator('.chip-link .chip-x')).toHaveCount(2);
  await expect(inspector(page).getByTestId('assignments').locator('.chip-x')).toHaveCount(0);
  const cacheChip = inspector(page).locator('.chip-link', { hasText: 'e2e-ins-cache' });
  const before = await cacheChip.evaluate((e) => getComputedStyle(e).borderColor);
  await cacheChip.getByRole('button', { name: 'Open cache e2e-ins-cache' }).hover();
  await expect.poll(() => cacheChip.evaluate((e) => getComputedStyle(e).borderColor)).not.toBe(before);

  // a link centres its step on the board: pan the step far off first
  const centre = async (loc: import('@playwright/test').Locator) => {
    const pane = (await page.locator('.react-flow').boundingBox())!;
    const box = (await loc.boundingBox())!;
    return Math.hypot(box.x + box.width / 2 - (pane.x + pane.width / 2), box.y + box.height / 2 - (pane.y + pane.height / 2));
  };
  const s1Card = stNode(page, id.s1!);
  const pane0 = (await page.locator('.react-flow').boundingBox())!;
  await page.mouse.move(pane0.x + 20, pane0.y + pane0.height - 20);
  await page.mouse.down();
  await page.mouse.move(pane0.x + pane0.width - 20, pane0.y + 20, { steps: 8 });
  await page.mouse.up();
  await selectWorkflowAlone(page, id.wa!);
  await inspector(page).getByRole('button', { name: 'Open entry e2e-ins-first' }).click();
  await expect.poll(() => centre(s1Card)).toBeLessThan(4);
  // the entry chip: the workflow with the step, Step open
  await expect(stNode(page, id.s1!).locator('.node.sel')).toHaveCount(1);
  await expect(wfNode(page, id.wa!).locator('.tri.sel')).toHaveCount(1);
  await expect(tab(page, 'Step')).toHaveAttribute('aria-selected', 'true');
  await expect(field(page, 'Name')).toHaveValue('e2e-ins-first');

  // the step's next-step chip: that step, the workflow kept
  await inspector(page).getByRole('button', { name: 'Open step e2e-ins-second' }).click();
  await expect(stNode(page, id.s2!).locator('.node.sel')).toHaveCount(1);
  await expect(stNode(page, id.s1!).locator('.node.sel')).toHaveCount(0);
  await expect(wfNode(page, id.wa!).locator('.tri.sel')).toHaveCount(1);
  await expect(field(page, 'Name')).toHaveValue('e2e-ins-second');
  await expect.poll(() => centre(stNode(page, id.s2!))).toBeLessThan(4);

  // the cache chip: the cache alone (the centred step clicked again leaves the workflow alone; its triangle may be off-screen now)
  await pickStep(page, id.s2!);
  await expect(tab(page, 'Workflow')).toBeVisible();
  await inspector(page).getByRole('button', { name: 'Open cache e2e-ins-cache' }).click();
  await expect(caNode(page, id.c1!).locator('.cache-chip.sel')).toHaveCount(1);
  await expect.poll(() => centre(caNode(page, id.c1!))).toBeLessThan(4);
  await expect(wfNode(page, id.wa!).locator('.tri.sel')).toHaveCount(0);
  await expect(tab(page, 'Cache')).toBeVisible();

  // an assignment chip opens Step › that workflow's assignment and centres its step too [user, 2026-11-19]
  await selectWorkflowAlone(page, id.wa!);
  expect(await centre(stNode(page, id.s2!))).toBeGreaterThan(50); // the cache is centred now, not the step
  await asg.getByRole('button', { name: 'Open assignment e2e-ins-second' }).click();
  await expect.poll(() => centre(stNode(page, id.s2!))).toBeLessThan(4);
  await expect(childTab(page, 'Step', 'e2e-ins-a')).toHaveAttribute('aria-selected', 'true');
  await expect(await payloadOf(page, 'e2e-ins-a')).toHaveValue(pretty('{"second":2}'));
});
