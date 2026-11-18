import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import {
  allWorkflows, caNode, cacheEdge, clickEmptyBoard, entryEdge, field, inspector, openAt, payloadOf, pickCache, pickEdge, pickStep, pickWorkflow, pretty, selbar,
  stNode, tabLabels, toolbar, wfNode, wireEdge,
} from './helpers';
import { seed } from './seed';

// Plan 6 (inspector-tabs spec §4): nothing fades for "not selected". A selected triangle carries its hue (pink first, then purple), and every
// step in its stream holding its assignment shows a key chip "◆ N keys" in that hue; Ctrl+click adds a second triangle with its own hue. A
// step shows Step · Processor, plus one tab per selected workflow whose stream holds it. Steps, caches and wires multi-select with Ctrl.

const SEED = {
  steps: [
    { key: 's1', name: 'e2e-sel-shared', at: { x: 260, y: 100 }, next: ['s2'] },
    { key: 's2', name: 'e2e-sel-onlya', at: { x: 560, y: 100 } },
    { key: 's3', name: 'e2e-sel-orphan', at: { x: 560, y: 300 } },
  ],
  caches: [{ key: 'c1', name: 'e2e-sel-cache', at: { x: 40, y: 380 } }],
  payloads: [
    { key: 'pa', step: 's1', payload: '{"from":"a","n":1}' },
    { key: 'pb', step: 's1', payload: '{"only":"b"}' },
  ],
  workflows: [
    { key: 'wa', name: 'e2e-sel-a', at: { x: 0, y: 40 }, entry: ['s1'], caches: ['c1'], payloads: ['pa'] },
    { key: 'wb', name: 'e2e-sel-b', at: { x: 0, y: 220 }, entry: ['s1'], payloads: ['pb'] },
  ],
} as const;

const PINK = 'rgb(255, 0, 114)';
const PURPLE = 'rgb(124, 58, 237)';
const chips = (page: Page, step: string) => stNode(page, step).locator('.key-chip');
const borderOf = (l: Locator) => l.evaluate((e) => getComputedStyle(e).borderTopColor);
const strokeOf = (l: Locator) => l.evaluate((e) => getComputedStyle(e).stroke);
/** Nothing on the board is faded: no .dim anywhere and every real node at full opacity. */
async function nothingFaded(page: Page) {
  await expect(page.locator('.dim')).toHaveCount(0);
  const faded = await page.locator('.react-flow__node:not(.ghost)').evaluateAll((ns) => ns.filter((n) => Number(getComputedStyle(n).opacity) < 1).length);
  expect(faded, 'nodes drawn faded').toBe(0);
}

test('a triangle selects with its hue: its key chips show on the steps holding its assignment, and nothing fades', async ({ page }) => {
  const id = await seed(SEED);
  await openAt(page);
  await nothingFaded(page);
  await expect(page.locator('.key-chip')).toHaveCount(0);

  await pickWorkflow(page, id.wa!);
  await expect(wfNode(page, id.wa!).locator('.tri')).toHaveClass(/\bsel\b/);
  expect(await strokeOf(wfNode(page, id.wa!).locator('.tri-body'))).toBe(PINK);
  await expect(field(page, 'Name')).toHaveValue('e2e-sel-a');
  await expect(tabLabels(page)).toHaveText(['Workflow']);
  await expect(toolbar(page, 'workflow').getByRole('button')).toHaveText(['▶ Start', 'Delete']);
  // A's entry arrow carries the hue; B's does not
  await expect(entryEdge(page, id.wa!, id.s1!).locator('g.entry-edge')).toHaveClass(/\bon\b/);
  await expect(entryEdge(page, id.wb!, id.s1!).locator('g.entry-edge')).not.toHaveClass(/\bon\b/);
  // A's payload has two keys; the step after it holds none of A's, the orphan none
  await expect(chips(page, id.s1!)).toHaveCount(1);
  await expect(chips(page, id.s1!)).toHaveText('◆ 2 keys');
  expect(await borderOf(chips(page, id.s1!))).toBe(PINK);
  await expect(chips(page, id.s2!)).toHaveCount(0);
  await expect(chips(page, id.s3!)).toHaveCount(0);
  await nothingFaded(page);

  // Ctrl+click B: both selected, B purple; the shared step shows one chip per workflow
  await wfNode(page, id.wb!).locator('.tri-nm').click({ modifiers: ['Control'] });
  await expect(page.locator('.react-flow__node-workflow .tri.sel')).toHaveCount(2);
  expect(await strokeOf(wfNode(page, id.wb!).locator('.tri-body'))).toBe(PURPLE);
  await expect(chips(page, id.s1!)).toHaveCount(2);
  await expect(chips(page, id.s1!).nth(0)).toContainText('◆ 2 keys');
  await expect(chips(page, id.s1!).nth(1)).toContainText('◆ 1 key');
  expect(await borderOf(chips(page, id.s1!).nth(1))).toBe(PURPLE);
  await nothingFaded(page);
  // Ctrl+click B again takes it out
  await wfNode(page, id.wb!).locator('.tri-nm').click({ modifiers: ['Control'] });
  await expect(page.locator('.react-flow__node-workflow .tri.sel')).toHaveCount(1);
  await expect(chips(page, id.s1!)).toHaveCount(1);

  // a plain click on B: B alone, pink now
  await pickWorkflow(page, id.wb!);
  await expect(page.locator('.react-flow__node-workflow .tri.sel')).toHaveCount(1);
  await expect(chips(page, id.s1!)).toHaveText('◆ 1 key');
  expect(await borderOf(chips(page, id.s1!))).toBe(PINK);

  // empty board clears it all
  await clickEmptyBoard(page);
  await expect(page.locator('.key-chip')).toHaveCount(0);
  await expect(page.locator('.react-flow__node-workflow .tri.sel')).toHaveCount(0);
  await expect(inspector(page)).toContainText('Select a workflow, step or wire');
});

test('a step shows Step and Processor, and a tab per selected workflow whose stream holds it; clicking a step keeps the triangles', async ({ page }) => {
  const id = await seed(SEED);
  await openAt(page);

  // no triangle: Step and Processor only, the users on the kind line
  await pickStep(page, id.s1!);
  await expect(tabLabels(page)).toHaveText(['Step', 'Processor']);
  await expect(field(page, 'Name')).toHaveValue('e2e-sel-shared');
  await expect(inspector(page).locator('.kind')).toHaveText(/^step · shared by /);
  await expect(inspector(page).locator('.kind')).toContainText('e2e-sel-a');
  await expect(inspector(page).locator('.kind')).toContainText('e2e-sel-b');

  // triangle first, then the step: A's tab with A's payload; then B's
  await pickWorkflow(page, id.wa!);
  await pickStep(page, id.s1!);
  await expect(wfNode(page, id.wa!).locator('.tri')).toHaveClass(/\bsel\b/); // the triangle stays selected
  await expect(tabLabels(page)).toHaveText(['Step', 'Processor', 'e2e-sel-a']);
  await expect(await payloadOf(page, 'e2e-sel-a')).toHaveValue(pretty('{"from":"a","n":1}'));
  await pickWorkflow(page, id.wb!);
  await pickStep(page, id.s1!);
  await expect(await payloadOf(page, 'e2e-sel-b')).toHaveValue(pretty('{"only":"b"}'));

  // a step the selected triangle does not reach: no workflow tab
  await pickWorkflow(page, id.wa!);
  await pickStep(page, id.s3!);
  await expect(field(page, 'Name')).toHaveValue('e2e-sel-orphan');
  await expect(tabLabels(page)).toHaveText(['Step', 'Processor']);

  // an entry arrow or a cache line selects its triangle too
  await pickEdge(page, entryEdge(page, id.wb!, id.s1!));
  await expect(toolbar(page, 'entry').getByRole('button')).toHaveText(['Delete']);
  await expect(wfNode(page, id.wb!).locator('.tri')).toHaveClass(/\bsel\b/);
  await pickEdge(page, cacheEdge(page, id.wa!, id.c1!));
  await expect(toolbar(page, 'cacheLink').getByRole('button')).toHaveText(['Delete']);
  await expect(wfNode(page, id.wa!).locator('.tri')).toHaveClass(/\bsel\b/);
});

test('Ctrl+click multi-selects steps, caches and wires with the light bar and numbered badges; two triangles get Start · Stop · Delete', async ({ page }) => {
  const id = await seed(SEED);
  await openAt(page);
  await pickStep(page, id.s1!);
  // one pick: its own toolbar, no bar, no badge
  await expect(toolbar(page, 'step').getByRole('button')).toHaveText(['Copy', 'Delete']);
  await expect(selbar(page)).toHaveCount(0);
  await expect(page.locator('.pick-no')).toHaveCount(0);

  await pickStep(page, id.s2!, true);
  await expect(selbar(page).locator('.selbar-pill')).toHaveText('2 SELECTED');
  await expect(selbar(page).getByRole('button')).toHaveText(['Copy', 'Delete']);
  await expect(toolbar(page, 'step')).toHaveCount(0);
  await expect(stNode(page, id.s1!).locator('.pick-no')).toHaveText('1');
  await expect(stNode(page, id.s2!).locator('.pick-no')).toHaveText('2');
  await expect(inspector(page)).toContainText('2 things are selected');
  await expect(inspector(page).locator('.in-picks li')).toHaveText(['e2e-sel-shared', 'e2e-sel-onlya']);

  // a cache: Copy goes (a cache cannot be copied), Delete stays; a wire joins
  await pickCache(page, id.c1!, true);
  await expect(selbar(page).locator('.selbar-pill')).toHaveText('3 SELECTED');
  await expect(selbar(page).getByRole('button')).toHaveText(['Delete']);
  await expect(caNode(page, id.c1!).locator('.pick-no')).toHaveText('3');
  await pickEdge(page, wireEdge(page, id.s1!, id.s2!), true);
  await expect(selbar(page).locator('.selbar-pill')).toHaveText('4 SELECTED');
  await expect(page.locator('.pick-wire .pick-no')).toHaveText('4');

  // Ctrl+click on a picked step takes it out, and the badges renumber
  await pickStep(page, id.s1!, true);
  await expect(selbar(page).locator('.selbar-pill')).toHaveText('3 SELECTED');
  await expect(stNode(page, id.s2!).locator('.pick-no')).toHaveText('1');

  // a plain click on a triangle ends the multi-selection: it is the one selected workflow
  await pickWorkflow(page, id.wa!);
  await expect(selbar(page)).toHaveCount(0);
  await expect(page.locator('.pick-no')).toHaveCount(0);
  await expect(allWorkflows(page).locator('.tri.sel')).toHaveCount(1);
  // Ctrl+click a second triangle: two selected, the bar offers Start · Stop · Delete for both (never pressed)
  await wfNode(page, id.wb!).locator('.tri-nm').click({ modifiers: ['Control'] });
  await expect(allWorkflows(page).locator('.tri.sel')).toHaveCount(2);
  await expect(selbar(page).locator('.selbar-pill')).toHaveText('2 SELECTED');
  await expect(selbar(page).getByRole('button')).toHaveText(['▶ Start', '■ Stop', 'Delete']);
});

test('Esc clears the picks and the triangle; the Delete key does nothing', async ({ page }) => {
  const id = await seed(SEED);
  await openAt(page);
  await pickWorkflow(page, id.wa!);
  await expect(allWorkflows(page).locator('.tri.sel')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(allWorkflows(page).locator('.tri.sel')).toHaveCount(0);
  await expect(inspector(page)).toContainText('Select a workflow, step or wire');

  await pickStep(page, id.s1!);
  await pickStep(page, id.s2!, true);
  await expect(selbar(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(selbar(page)).toHaveCount(0);
  await expect(page.locator('.pick-no')).toHaveCount(0);

  // the Delete key and Backspace delete nothing
  await pickStep(page, id.s3!);
  await page.keyboard.press('Delete');
  await page.keyboard.press('Backspace');
  await expect(stNode(page, id.s3!)).toBeVisible();
  await pickEdge(page, wireEdge(page, id.s1!, id.s2!));
  await page.keyboard.press('Delete');
  await expect(wireEdge(page, id.s1!, id.s2!)).toHaveCount(1);
  await pickWorkflow(page, id.wa!);
  await page.keyboard.press('Delete');
  await expect(wfNode(page, id.wa!)).toBeVisible();
});
