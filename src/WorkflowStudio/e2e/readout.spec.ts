import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { documentPanel, dragEnd, emptySpot, get, inspector, openWorkflow, pane, pickWire, pointOnWire, save, setEntryCondition } from './studio';
import { createCircuitThrowaway, expect, removeThrowaway, test, type CircuitThrowaway } from './throwaway';

// The Inspector's read-outs (the user's request, 2026-10-09): a picked wire and the workflow's graph as plain text, the
// drawing as the canvas draws it and what Save would write from it. Real mouse on the dev server, on a throwaway workflow
// (`e2e-9-…`: a, b, c Completed, d Failed; wf -> a, a -> b, a -> d, b -> c) made and deleted through BaseApi's CRUD; only
// its Save is written (throwaway.ts's guard aborts any other write). The tests build on each other's state.
test.describe.configure({ mode: 'serial', retries: 0 });
let t: CircuitThrowaway;
test.beforeAll(async ({ request }) => { t = await createCircuitThrowaway(request); });
test.afterAll(async ({ request }) => { await removeThrowaway(request); });
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
});

const SHOTS = process.env.READOUT_SHOTS;
const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A step's unique name as the studio shows it. */
const nameOf = (step: 'a' | 'b' | 'c' | 'd') => `${t.tag}-${step}_1.0.0-${GUID.test(t[step]) ? t[step].slice(19).toLowerCase() : t[step]}`;

async function open(page: Page): Promise<Locator> {
  await openWorkflow(page, t.workflow);
  return documentPanel(page, t.workflow);
}

/** The picked wire's read-out row `label`, as text. */
const wireRow = (page: Page, label: string) => inspector(page).getByLabel('Wire read-out').locator(`.rrow[data-row="${label}"] dd`);
const graph = (page: Page) => inspector(page).getByRole('region', { name: 'Graph' });

/** The Graph table: per step id, the next steps Save would write (in order) and those held back. */
async function graphRows(page: Page): Promise<Record<string, { next: string[]; held: string[] }>> {
  return graph(page).getByRole('table', { name: 'Steps' }).evaluate((table) => Object.fromEntries([...table.querySelectorAll('tbody tr')].map((tr) => [
    tr.getAttribute('data-step')!,
    {
      next: [...tr.querySelectorAll('li[data-step]:not(.held)')].map((li) => li.getAttribute('data-step')!),
      held: [...tr.querySelectorAll('li[data-step].held')].map((li) => li.getAttribute('data-step')!),
    },
  ])));
}
const entries = (page: Page) => graph(page).locator('.rrow[data-row="Entry steps"] li[data-step]:not(.held)').evaluateAll((lis) => lis.map((li) => li.getAttribute('data-step')!));

async function pickWorkflow(page: Page, panel: Locator): Promise<void> {
  await panel.locator('.react-flow__node-workflow').click();
  await expect(inspector(page).locator('.kindpill')).toHaveText('WORKFLOW');
  await expect(graph(page)).toBeVisible();
}

const listsIn = async (request: APIRequestContext) => {
  const out: Record<string, string[]> = {};
  for (const s of ['a', 'b', 'c', 'd'] as const) out[t[s]] = (await get<{ nextStepIds: string[] }>(request, `steps/${t[s]}`)).nextStepIds;
  return out;
};

test('a picked wire reads as text; a drag that detaches its head changes the read-out', async ({ page, request }) => {
  const panel = await open(page);
  const ab = `${t.a}->${t.b}`;
  await pickWire(page, panel, ab);
  await expect(inspector(page).locator('.kindpill')).toHaveText('WIRE');
  await expect(inspector(page).getByLabel('Wire name')).toHaveText(`${nameOf('a')} → ${nameOf('b')}`);
  await expect(wireRow(page, 'From (tail)')).toHaveText(`step ${nameOf('a')}, output side (automatic)`);
  await expect(wireRow(page, 'To (head)')).toHaveText(`step ${nameOf('b')}, input side (automatic)`);
  await expect(wireRow(page, 'Direction')).toHaveText('directed');
  await expect(wireRow(page, 'Condition')).toHaveText('Completed');
  await expect(wireRow(page, 'Carries')).toHaveText(`${nameOf('a')} → ${nameOf('b')}`);
  await expect(wireRow(page, 'Shape')).toHaveText('automatic');
  await expect(wireRow(page, 'Joined on it')).toHaveText('none');
  // names are plain text
  await expect(inspector(page).getByLabel('Wire read-out').locator('button, a')).toHaveCount(0);
  await shot(page, '1-wire-picked');

  // its head dragged off b onto empty canvas: open there, undecided, nothing carried
  expect(await dragEnd(page, panel, ab, 'head', await emptySpot(panel))).toBe('move here');
  await expect(wireRow(page, 'To (head)')).toHaveText(/^open \(at -?\d+, -?\d+\)$/);
  await expect(wireRow(page, 'Carries')).toHaveText('nothing');
  await expect(wireRow(page, 'Condition')).toHaveText('undecided');
  await expect(wireRow(page, 'Direction')).toHaveText('directed');
  await shot(page, '2-wire-head-detached');
  // the workflow's graph follows: a no longer feeds b, and the open wire is listed
  await pickWorkflow(page, panel);
  expect((await graphRows(page))[t.a]).toEqual({ next: [t.d], held: [] });
  await expect(graph(page).locator('.rrow[data-row="Open wires"] li')).toHaveText([`${nameOf('a')} → an open end`]);
  // Undo puts it back: the list as BaseApi has it (in its order)
  await page.keyboard.press('Control+z');
  const loaded = (await listsIn(request))[t.a];
  expect([...loaded!].sort()).toEqual([t.b, t.d].sort());
  await expect.poll(async () => (await graphRows(page))[t.a]).toEqual({ next: loaded, held: [] });
});

test('the workflow\'s Graph rows are what Save writes: after Save they equal BaseApi\'s nextStepIds and entry steps', async ({ page, request }) => {
  const panel = await open(page);
  await pickWorkflow(page, panel);
  // before any change: the loaded lists
  const loaded = await listsIn(request);
  expect(await graphRows(page)).toEqual(Object.fromEntries(Object.entries(loaded).map(([k, v]) => [k, { next: v, held: [] }])));
  await expect(graph(page).locator('.rrow[data-row="Problems"] dd')).toHaveText('none');

  // b -> c's tail joined on a -> b (fan-out): a feeds c too, b feeds nothing
  expect(await dragEnd(page, panel, `${t.b}->${t.c}`, 'tail', await pointOnWire(panel, `${t.a}->${t.b}`, 0.5, 12))).toBe('join here');
  await expect(wireRow(page, 'From (tail)')).toHaveText(new RegExp(`^a junction on wire ${nameOf('a')} → ${nameOf('b')}, \\d+ px along it$`));
  await expect(wireRow(page, 'Carries')).toHaveText(`${nameOf('a')} → ${nameOf('c')}`);
  await pickWorkflow(page, panel);
  const shown = await graphRows(page);
  // the loaded list in its order, then what is new
  expect(shown[t.a]!.next).toEqual([...loaded[t.a]!, t.c]);
  expect(shown[t.b]!.next).toEqual([]);
  await shot(page, '3-graph-before-save');

  await save(page);
  await expect(await pane(page, 'Output')).toContainText('Saved and applied');
  const saved = await listsIn(request);
  await pickWorkflow(page, panel);
  expect(await graphRows(page)).toEqual(Object.fromEntries(Object.entries(saved).map(([k, v]) => [k, { next: v, held: [] }])));
  expect(await entries(page)).toEqual((await get<{ entryStepIds: string[] }>(request, `workflows/${t.workflow.id}`)).entryStepIds);
  expect([...saved[t.a]!].sort()).toEqual([t.b, t.c, t.d].sort());
  await shot(page, '4-graph-after-save');
});

test('a short circuit shows in both read-outs: the wire\'s condition and what it carries, the source held back, the problem listed', async ({ page }) => {
  const panel = await open(page);
  const bc = `${t.b}->${t.c}`;
  // after the previous Save, b -> c taps a -> b; c made Failed: its net meets Completed (b) and Failed (c)
  await setEntryCondition(page, panel, t.c, /Failed/);
  await pickWire(page, panel, bc);
  await expect(wireRow(page, 'Condition')).toHaveText('short circuit: Completed meets Failed');
  await expect(wireRow(page, 'Carries')).toHaveText(`${nameOf('a')} → ${nameOf('c')} (kept as BaseApi has it: short circuit)`);
  await shot(page, '5-wire-short-circuit');
  await pickWorkflow(page, panel);
  const row = graph(page).locator(`tbody tr[data-step="${t.a}"]`);
  await expect(row.locator('.rnote')).toHaveText('held back by a short circuit: Save keeps BaseApi\'s list');
  await expect(graph(page).locator('.rrow[data-row="Short circuits"] li')).toHaveText(['short circuit: Completed meets Failed']);
  await expect(graph(page).locator(`tbody tr[data-step="${t.c}"] td`).first()).toHaveText('Failed');
  await shot(page, '6-graph-short-circuit');
});
