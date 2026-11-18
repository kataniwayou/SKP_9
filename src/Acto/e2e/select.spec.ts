import { test, expect } from './fixtures';
import {
  allWorkflows, caNode, cacheEdge, clickEmptyBoard, entryEdge, field, inspector, openAt, pickCache, pickEdge, pickStep, pickWorkflow, selbar, stNode, toolbar,
  wfNode, wireEdge,
} from './helpers';
import { seed } from './seed';

// Spec §6: a triangle first. Two workflows share an entry step and each has its own payload on it; the selected triangle lights what it
// reaches and links and dims the rest; a step shows the payload of the selected triangle; steps, caches and wires multi-select with Ctrl.

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

const dimmed = (l: import('@playwright/test').Locator) => expect(l).toHaveClass(/\bdim\b/);
const lit = (l: import('@playwright/test').Locator) => expect(l).not.toHaveClass(/\bdim\b/);

test('a triangle selects alone: it lights what it reaches and links, dims the rest, and each lit step shows its payload', async ({ page }) => {
  const id = await seed(SEED);
  await openAt(page);
  // nothing picked: nothing dimmed, no payload on any footer
  await lit(stNode(page, id.s3!));
  await expect(page.locator('.react-flow__node.dim')).toHaveCount(0);

  await pickWorkflow(page, id.wa!);
  await expect(wfNode(page, id.wa!).locator('.tri')).toHaveClass(/\bsel\b/);
  await expect(field(page, 'Name')).toHaveValue('e2e-sel-a');
  await expect(toolbar(page, 'workflow').getByRole('button')).toHaveText(['▶ Start', 'Delete']);
  // A reaches the shared step and the one after it, and links its cache; the other triangle, the orphan and every real row dim
  await lit(stNode(page, id.s1!));
  await lit(stNode(page, id.s2!));
  await lit(caNode(page, id.c1!));
  await dimmed(stNode(page, id.s3!));
  await dimmed(wfNode(page, id.wb!));
  await dimmed(entryEdge(page, id.wb!, id.s1!));
  await lit(entryEdge(page, id.wa!, id.s1!));
  await lit(cacheEdge(page, id.wa!, id.c1!));
  await lit(wireEdge(page, id.s1!, id.s2!));
  const realStep = page.locator('.react-flow__node-step').filter({ hasNotText: 'e2e-' }).first();
  await dimmed(realStep);
  // the footers: A's payload has two keys, the step after has none
  await expect(stNode(page, id.s1!).locator('.nf .mt')).toHaveText('2 keys');
  await expect(stNode(page, id.s2!).locator('.nf .mt')).toHaveText('no payload');

  // B: the same step, B's payload, and the step only A reaches dims
  await pickWorkflow(page, id.wb!);
  await expect(field(page, 'Name')).toHaveValue('e2e-sel-b');
  await lit(stNode(page, id.s1!));
  await expect(stNode(page, id.s1!).locator('.nf .mt')).toHaveText('1 key');
  await lit(stNode(page, id.s2!)); // reached through the wire out of the shared step
  await dimmed(caNode(page, id.c1!));
  await dimmed(wfNode(page, id.wa!));

  // empty board clears it all
  await clickEmptyBoard(page);
  await expect(page.locator('.react-flow__node.dim')).toHaveCount(0);
  await expect(inspector(page)).toContainText('Select a workflow, step or wire');
  await expect(stNode(page, id.s1!).locator('.nf .mt')).toHaveText('1.0.0');
});

test('a step shows its shared fields, and with a triangle selected that triangle\'s payload; clicking a step keeps the triangle', async ({ page }) => {
  const id = await seed(SEED);
  await openAt(page);

  // no triangle: shared fields only, no payload
  await pickStep(page, id.s1!);
  await expect(field(page, 'Name')).toHaveValue('e2e-sel-shared');
  await expect(inspector(page)).toContainText('shared fields · used by');
  await expect(inspector(page)).toContainText('e2e-sel-a, e2e-sel-b');
  await expect(inspector(page).getByText(/^Payload · /)).toHaveCount(0);
  await expect(field(page, 'Payload · JSON')).toHaveCount(0);

  // triangle first, then the step: A's payload; then B's
  await pickWorkflow(page, id.wa!);
  await pickStep(page, id.s1!);
  await expect(wfNode(page, id.wa!).locator('.tri')).toHaveClass(/\bsel\b/); // the triangle stays selected
  await expect(inspector(page).getByText('Payload · e2e-sel-a')).toBeVisible();
  await expect(field(page, 'Payload · JSON')).toHaveValue('{"from":"a","n":1}');
  await expect(inspector(page)).toContainText('in e2e-sel-a');
  await pickWorkflow(page, id.wb!);
  await pickStep(page, id.s1!);
  await expect(inspector(page).getByText('Payload · e2e-sel-b')).toBeVisible();
  await expect(field(page, 'Payload · JSON')).toHaveValue('{"only":"b"}');

  // a step the selected triangle does not reach: shared fields, "not in ..."
  await pickWorkflow(page, id.wa!);
  await pickStep(page, id.s3!);
  await expect(inspector(page)).toContainText('not in e2e-sel-a');
  await expect(field(page, 'Name')).toHaveValue('e2e-sel-orphan');
  await expect(field(page, 'Payload · JSON')).toHaveCount(0);

  // an entry arrow or a cache line selects its triangle too
  await pickEdge(page, entryEdge(page, id.wb!, id.s1!));
  await expect(toolbar(page, 'entry').getByRole('button')).toHaveText(['Delete']);
  await expect(wfNode(page, id.wb!).locator('.tri')).toHaveClass(/\bsel\b/);
  await pickEdge(page, cacheEdge(page, id.wa!, id.c1!));
  await expect(toolbar(page, 'cacheLink').getByRole('button')).toHaveText(['Delete']);
  await expect(wfNode(page, id.wa!).locator('.tri')).toHaveClass(/\bsel\b/);
});

test('Ctrl+click multi-selects steps, caches and wires with the light bar and numbered badges; triangles never join', async ({ page }) => {
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

  // a triangle: Ctrl or not, it selects alone and ends the multi-selection
  await wfNode(page, id.wa!).locator('.tri-nm').click({ modifiers: ['Control'] });
  await expect(selbar(page)).toHaveCount(0);
  await expect(page.locator('.pick-no')).toHaveCount(0);
  await expect(wfNode(page, id.wa!).locator('.tri')).toHaveClass(/\bsel\b/);
  await expect(page.locator('.react-flow__node-workflow .tri.sel')).toHaveCount(1);
  // and a triangle is never added to steps already picked
  await pickStep(page, id.s1!);
  await pickStep(page, id.s2!, true);
  await wfNode(page, id.wb!).locator('.tri-nm').click({ modifiers: ['Control'] });
  await expect(selbar(page)).toHaveCount(0);
  await expect(page.locator('.react-flow__node-workflow .tri.sel')).toHaveCount(1);
  await expect(allWorkflows(page).locator('.tri.sel')).toHaveCount(1);
});

test('Esc clears the picks and the triangle; the Delete key does nothing', async ({ page }) => {
  const id = await seed(SEED);
  await openAt(page);
  await pickWorkflow(page, id.wa!);
  await expect(page.locator('.react-flow__node.dim').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.react-flow__node.dim')).toHaveCount(0);
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
