import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import {
  caNode, cacheEdge, childLabels, childTab, clickEmptyBoard, entryEdge, field, ghost, inspector, openAt, payloadOf, pickCache, pickEdge,
  pickStep, pickWorkflow, pretty, stNode, tab, tabLabels, toolbar, wfNode, wireEdge,
} from './helpers';
import { seed, type Seeded } from './seed';

// The four rules of selection and the Inspector [user, 2026-11-18], spec §4/§5, one test per case, on throwaway e2e- rows.
// Rule 1: what a click does. Rule 2: what the Inspector shows. Rule 3: parent tabs Step · Processor and their children.
// Nothing is saved and nothing is started or stopped: every edit here (a step deleted for its ghost) stays on the board.

const SEED = {
  steps: [
    // S runs kafka-importer: two filled schema slots (output, config), the input slot empty
    { key: 's', name: 'e2e-rules-S', at: { x: 300, y: 180 }, processor: 'kafka-importer', next: ['t'] },
    { key: 't', name: 'e2e-rules-T', at: { x: 620, y: 180 } },
    { key: 'u', name: 'e2e-rules-U', at: { x: 620, y: 330 } },
    { key: 'g', name: 'e2e-rules-G', at: { x: 620, y: 470 } },
  ],
  caches: [{ key: 'k', name: 'e2e-rules-K', at: { x: 300, y: 420 } }],
  payloads: [
    { key: 'pa', step: 's', payload: '{"from":"A"}' },
    { key: 'pb', step: 's', payload: '{"from":"B"}' },
    { key: 'pc', step: 's', payload: '{"from":"C"}' },
  ],
  workflows: [
    { key: 'a', name: 'e2e-rules-A', at: { x: 0, y: 20 }, entry: ['s'], caches: ['k'], payloads: ['pa'] },
    { key: 'b', name: 'e2e-rules-B', at: { x: 0, y: 190 }, entry: ['s'], payloads: ['pb'] },
    { key: 'c', name: 'e2e-rules-C', at: { x: 0, y: 360 }, entry: ['s'], payloads: ['pc'] },
  ],
} as const;

const A = 'e2e-rules-A';
const B = 'e2e-rules-B';
const C = 'e2e-rules-C';
const S = 'e2e-rules-S';
const T = 'e2e-rules-T';
const U = 'e2e-rules-U';
const K = 'e2e-rules-K';
const G = 'e2e-rules-G';

/** The board's selected items (React Flow ids of the picked nodes and edges), sorted. */
const selectedIds = (page: Page) => page.evaluate(() =>
  [...document.querySelectorAll('.react-flow__node.selected, .react-flow__edge.selected')].map((e) => e.getAttribute('data-id') ?? '').sort());
async function expectSelected(page: Page, ids: string[]) {
  await expect.poll(() => selectedIds(page), { message: 'the board selection' }).toEqual([...ids].sort());
}
const wf = (id: Seeded, k: 'a' | 'b' | 'c') => `wf:${id[k]}`;
const st = (id: Seeded, k: 's' | 't' | 'u') => `st:${id[k]}`;
const ca = (id: Seeded) => `ca:${id.k}`;
const wireId = (id: Seeded) => `wire:${id.s}:${id.t}`;
const entryId = (id: Seeded) => `entry:${id.a}:${id.s}`;
const lineId = (id: Seeded) => `cache:${id.a}:${id.k}`;
const ghostId = (id: Seeded) => `ghost:step:${id.g}`;

const list = (page: Page) => inspector(page).locator('.in-picks li');
const nothing = (page: Page) => expect(inspector(page)).toContainText('Select a workflow, step or wire');
const ctrlWf = (page: Page, id: string) => wfNode(page, id).locator('.tri-nm').click({ modifiers: ['Control'] });
const stepRow = (page: Page) => inspector(page).getByRole('tablist', { name: 'Step tabs' });
const processorRow = (page: Page) => inspector(page).getByRole('tablist', { name: 'Processor tabs' });
/** The Inspector shows this workflow's form. */
async function showsWorkflow(page: Page, name: string) {
  await expect(tabLabels(page)).toHaveText(['Workflow']);
  await expect(field(page, 'Name')).toHaveValue(name);
}
/** The Inspector shows this step: Step · Processor, Step's own fields, and Step's children (none: no row). */
async function showsStep(page: Page, name: string, children: string[]) {
  await expect(tabLabels(page)).toHaveText(['Step', 'Processor']);
  await expect(tab(page, 'Step')).toHaveAttribute('aria-selected', 'true');
  await expect(field(page, 'Name')).toHaveValue(name);
  if (children.length === 0) await expect(stepRow(page)).toHaveCount(0);
  else await expect(childLabels(page, 'Step')).toHaveText(children);
}
/** Deletes G from its toolbar (unsaved, on the board only): its ghost stays drawn. */
async function makeGhost(page: Page, id: Seeded) {
  await pickStep(page, id.g!);
  await toolbar(page, 'step').getByRole('button', { name: 'Delete' }).click();
  await expect(stNode(page, id.g!)).toHaveCount(0);
  await expect(ghost(page, G)).toHaveCount(1);
  await clickEmptyBoard(page);
}
const pickGhost = (page: Page, add = false) => ghost(page, G).locator('.sn').click(add ? { modifiers: ['Control'] } : {});

async function open(page: Page) {
  const id = await seed(SEED);
  await openAt(page);
  await expect(wfNode(page, id.a!)).toBeVisible();
  return id;
}

// ---------------------------------------------------------------- Rule 1: what a click does

test('Rule 1: "a plain click on an unselected triangle replaces every selected triangle; selected steps stay; everything else is dropped"', async ({ page }) => {
  const id = await open(page);
  await pickWorkflow(page, id.a!);
  await pickStep(page, id.s!, true);
  await pickStep(page, id.t!, true);
  await pickCache(page, id.k!, true);
  await pickEdge(page, wireEdge(page, id.s!, id.t!), true);
  await expectSelected(page, [wf(id, 'a'), st(id, 's'), st(id, 't'), ca(id), wireId(id)]);
  await pickWorkflow(page, id.b!);
  await expectSelected(page, [st(id, 's'), st(id, 't'), wf(id, 'b')]);
  await expect(list(page)).toHaveText([S, T, B]);
});

test('Rule 1: "a plain click on an unselected step replaces every selected step; selected triangles stay; everything else is dropped"', async ({ page }) => {
  const id = await open(page);
  await pickWorkflow(page, id.a!);
  await ctrlWf(page, id.b!);
  await pickStep(page, id.s!, true);
  await pickCache(page, id.k!, true);
  await pickEdge(page, entryEdge(page, id.a!, id.s!), true);
  await expectSelected(page, [wf(id, 'a'), wf(id, 'b'), st(id, 's'), ca(id), entryId(id)]);
  await pickStep(page, id.t!);
  await expectSelected(page, [wf(id, 'a'), wf(id, 'b'), st(id, 't')]);
  await expect(list(page)).toHaveText([A, B, T]);
});

test('Rule 1: "a plain click on an unselected cache / wire / entry arrow / cache line / ghost selects it alone"', async ({ page }) => {
  const id = await open(page);
  await makeGhost(page, id);
  const busy = async () => {
    await clickEmptyBoard(page);
    await pickWorkflow(page, id.a!);
    await pickStep(page, id.s!, true);
    await expectSelected(page, [wf(id, 'a'), st(id, 's')]);
  };
  await busy();
  await pickCache(page, id.k!);
  await expectSelected(page, [ca(id)]);
  await busy();
  await pickEdge(page, wireEdge(page, id.s!, id.t!));
  await expectSelected(page, [wireId(id)]);
  await busy();
  await pickEdge(page, entryEdge(page, id.a!, id.s!));
  await expectSelected(page, [entryId(id)]); // not its workflow
  await busy();
  await pickEdge(page, cacheEdge(page, id.a!, id.k!));
  await expectSelected(page, [lineId(id)]); // not its workflow
  await busy();
  await pickGhost(page);
  await expectSelected(page, [ghostId(id)]);
});

test('Rule 1: "Ctrl+click on any item toggles it in/out" — triangle, step, cache, wire, entry arrow, cache line, ghost', async ({ page }) => {
  const id = await open(page);
  await makeGhost(page, id);
  const toggles: [string, (add: boolean) => Promise<void>][] = [
    [wf(id, 'b'), async () => ctrlWf(page, id.b!)],
    [st(id, 't'), async () => pickStep(page, id.t!, true)],
    [ca(id), async () => pickCache(page, id.k!, true)],
    [wireId(id), async () => pickEdge(page, wireEdge(page, id.s!, id.t!), true)],
    [entryId(id), async () => pickEdge(page, entryEdge(page, id.a!, id.s!), true)],
    [lineId(id), async () => pickEdge(page, cacheEdge(page, id.a!, id.k!), true)],
    [ghostId(id), async () => pickGhost(page, true)],
  ];
  await pickWorkflow(page, id.a!);
  await pickStep(page, id.s!, true);
  const base = [wf(id, 'a'), st(id, 's')];
  for (const [flowId, ctrl] of toggles) {
    await ctrl(true);
    await expectSelected(page, [...base, flowId]);
    await expect(page.locator('.pick-no')).toHaveCount(3);
    await ctrl(true);
    await expectSelected(page, base);
  }
  // all added together, then all taken out again
  for (const [, ctrl] of toggles) await ctrl(true);
  await expectSelected(page, [...base, ...toggles.map(([f]) => f)]);
  await expect(list(page)).toHaveCount(2 + toggles.length);
  for (const [, ctrl] of toggles) await ctrl(true);
  await expectSelected(page, base);
});

test('Rule 1: "a plain click on an already-selected item removes only that item" — triangle, step, cache, wire', async ({ page }) => {
  const id = await open(page);
  await pickWorkflow(page, id.a!);
  await ctrlWf(page, id.b!);
  await pickStep(page, id.s!, true);
  await pickCache(page, id.k!, true);
  await pickEdge(page, wireEdge(page, id.s!, id.t!), true);
  const all = [wf(id, 'a'), wf(id, 'b'), st(id, 's'), ca(id), wireId(id)];
  await expectSelected(page, all);
  await pickWorkflow(page, id.a!);
  await expectSelected(page, all.filter((x) => x !== wf(id, 'a')));
  await pickStep(page, id.s!);
  await expectSelected(page, [wf(id, 'b'), ca(id), wireId(id)]);
  await pickCache(page, id.k!);
  await expectSelected(page, [wf(id, 'b'), wireId(id)]);
  await pickEdge(page, wireEdge(page, id.s!, id.t!));
  await expectSelected(page, [wf(id, 'b')]);
  await showsWorkflow(page, B);
  await pickWorkflow(page, id.b!);
  await expectSelected(page, []);
  await nothing(page);
});

test('Rule 1: "click on empty board → clears everything"', async ({ page }) => {
  const id = await open(page);
  await pickWorkflow(page, id.a!);
  await ctrlWf(page, id.c!);
  await pickStep(page, id.s!, true);
  await pickCache(page, id.k!, true);
  await expectSelected(page, [wf(id, 'a'), wf(id, 'c'), st(id, 's'), ca(id)]);
  await clickEmptyBoard(page);
  await expectSelected(page, []);
  await expect(page.locator('.react-flow__node-workflow .tri.sel')).toHaveCount(0);
  await expect(page.locator('.key-chip')).toHaveCount(0);
  await nothing(page);
});

test('Rule 1: "clicking a node\'s handle does nothing" — the step\'s out handle, the triangle\'s tip and back, picked or not', async ({ page }) => {
  const id = await open(page);
  const edges0 = await page.locator('.react-flow__edge').count();
  await pickWorkflow(page, id.a!);
  await pickStep(page, id.s!, true);
  const sel = [wf(id, 'a'), st(id, 's')];
  await stNode(page, id.s!).locator('.react-flow__handle[data-handleid="out"]').click();
  await expectSelected(page, sel);
  await wfNode(page, id.a!).locator('.react-flow__handle[data-handleid="tip"]').click();
  await expectSelected(page, sel);
  await wfNode(page, id.a!).locator('.react-flow__handle[data-handleid="back"]').click();
  await expectSelected(page, sel);
  // unpicked nodes' handles pick nothing either
  await stNode(page, id.t!).locator('.react-flow__handle[data-handleid="out"]').click();
  await wfNode(page, id.b!).locator('.react-flow__handle[data-handleid="tip"]').click();
  await expectSelected(page, sel);
  await showsStep(page, S, [A]);
  await page.keyboard.press('Escape');
  await expect(page.locator('.react-flow__edge')).toHaveCount(edges0); // nothing was connected
});

// ---------------------------------------------------------------- Rule 2: what the Inspector shows

test('Rule 2: "exactly one workflow (and nothing else) → its Workflow form"', async ({ page }) => {
  const id = await open(page);
  await pickWorkflow(page, id.c!);
  await expectSelected(page, [wf(id, 'c')]);
  await showsWorkflow(page, C);
  await expect(inspector(page).locator('.kind')).toHaveText(/^workflow · /);
});

test('Rule 2: "exactly one step (and nothing else) → Step · Processor, no assignment"', async ({ page }) => {
  const id = await open(page);
  await pickStep(page, id.s!);
  await expectSelected(page, [st(id, 's')]);
  await showsStep(page, S, []);
  await expect(inspector(page).getByLabel('Payload')).toHaveCount(0);
});

test('Rule 2: "exactly one workflow + exactly one step → Step · Processor, with THAT workflow\'s assignment under Step"', async ({ page }) => {
  const id = await open(page);
  for (const [k, name] of [['a', A], ['b', B], ['c', C]] as const) {
    await clickEmptyBoard(page);
    await pickWorkflow(page, id[k]!);
    await pickStep(page, id.s!);
    await expectSelected(page, [wf(id, k), st(id, 's')]);
    await showsStep(page, S, [name]);
    // its hue dot: the only selected workflow is the first colour
    expect(await childTab(page, 'Step', name).locator('.dot').evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(255, 0, 114)');
    await expect(await payloadOf(page, name)).toHaveValue(pretty(`{"from":"${name.slice(-1)}"}`));
    await expect(inspector(page).locator('.kind')).toHaveText(`assignment · belongs to ${name}`);
  }
});

test('Rule 2: "one workflow + one step its stream does not reach (U) → Step · Processor, no assignment child"', async ({ page }) => {
  const id = await open(page);
  await pickWorkflow(page, id.a!);
  await pickStep(page, id.u!);
  await expectSelected(page, [wf(id, 'a'), st(id, 'u')]);
  await showsStep(page, U, []);
});

test('Rule 2: "exactly one other item (cache, wire, entry arrow, cache line, ghost) → its own tab"', async ({ page }) => {
  const id = await open(page);
  await makeGhost(page, id);
  await pickCache(page, id.k!);
  await expect(tabLabels(page)).toHaveText(['Cache']);
  await expect(field(page, 'Name')).toHaveValue(K);
  await pickEdge(page, wireEdge(page, id.s!, id.t!));
  await expect(tabLabels(page)).toHaveText(['Link']);
  await expect(inspector(page).locator('.kind')).toHaveText('wire');
  await expect(inspector(page).locator('[aria-label="Unique name"]')).toHaveText(`${S} → ${T}`);
  await pickEdge(page, entryEdge(page, id.a!, id.s!));
  await expect(tabLabels(page)).toHaveText(['Link']);
  await expect(inspector(page).locator('.kind')).toHaveText('entry arrow');
  await expect(inspector(page).locator('[aria-label="Unique name"]')).toHaveText(`${A} → ${S}`);
  await pickEdge(page, cacheEdge(page, id.a!, id.k!));
  await expect(tabLabels(page)).toHaveText(['Link']);
  await expect(inspector(page).locator('.kind')).toHaveText('cache line');
  await pickGhost(page);
  await expect(tabLabels(page)).toHaveText(['Deleted']);
  await expect(inspector(page).locator('.kind')).toHaveText('deleted · step');
});

test('Rule 2: "anything else → the numbered pick list of everything selected" — 2 workflows; 2 steps; 2 workflows + step; step + cache; 1 workflow + 2 steps', async ({ page }) => {
  const id = await open(page);
  const cases: [string, () => Promise<void>, string[]][] = [
    ['2 workflows', async () => { await pickWorkflow(page, id.a!); await ctrlWf(page, id.b!); }, [A, B]],
    ['2 steps', async () => { await pickStep(page, id.s!); await pickStep(page, id.t!, true); }, [S, T]],
    ['2 workflows + step', async () => { await pickWorkflow(page, id.a!); await ctrlWf(page, id.b!); await pickStep(page, id.s!); }, [A, B, S]],
    ['step + cache', async () => { await pickStep(page, id.s!); await pickCache(page, id.k!, true); }, [S, K]],
    ['1 workflow + 2 steps', async () => { await pickWorkflow(page, id.a!); await pickStep(page, id.s!); await pickStep(page, id.t!, true); }, [A, S, T]],
  ];
  for (const [what, select, names] of cases) {
    await clickEmptyBoard(page);
    await select();
    await expect(list(page), what).toHaveText(names);
    await expect(tabLabels(page), what).toHaveCount(0);
    await expect(inspector(page).locator('.ph .cnt'), what).toHaveText(`${names.length} selected`);
    // the board numbers them in the same order
    for (const [i, n] of names.entries()) {
      const node = n === A || n === B ? wfNode(page, n === A ? id.a! : id.b!) : n === K ? caNode(page, id.k!) : stNode(page, n === S ? id.s! : id.t!);
      await expect(node.locator('.pick-no'), `${what}: ${n}`).toHaveText(String(i + 1));
    }
  }
});

// ---------------------------------------------------------------- Rule 3: tabs

test('Rule 3: "parent tabs Step · Processor only" — no duplicate Step or Processor child, in any case', async ({ page }) => {
  const id = await open(page);
  await pickWorkflow(page, id.a!);
  await pickStep(page, id.s!);
  await expect(tabLabels(page)).toHaveText(['Step', 'Processor']);
  await expect(childLabels(page, 'Step')).toHaveText([A]);
  await tab(page, 'Processor').click();
  await expect(tabLabels(page)).toHaveText(['Step', 'Processor']);
  await expect(childLabels(page, 'Processor')).not.toContainText(['Processor']);
  for (const row of [stepRow(page), processorRow(page)]) {
    await expect(row.getByRole('tab', { name: /^(Step|Processor)$/ })).toHaveCount(0);
  }
  // the top row never holds an assignment or a schema
  await expect(tabLabels(page)).toHaveCount(2);
});

test('Rule 3: "under Processor: its filled schema slots" — opening each shows that schema\'s form', async ({ page }) => {
  const id = await open(page);
  await pickStep(page, id.s!);
  await tab(page, 'Processor').click();
  await expect(field(page, 'Name')).toHaveValue('kafka-importer');
  // kafka-importer: output and config filled, input empty — only the filled slots are children
  await expect(childLabels(page, 'Processor')).toHaveText(['Output schema', 'Config schema']);
  await expect(inspector(page).locator('dt', { hasText: 'Input schema' }).locator('xpath=following-sibling::dd[1]')).toHaveText('none');
  for (const slot of ['Output', 'Config']) {
    await childTab(page, 'Processor', `${slot} schema`).click();
    await expect(childTab(page, 'Processor', `${slot} schema`)).toHaveAttribute('aria-selected', 'true');
    await expect(inspector(page).locator('.kind')).toHaveText(`schema · ${slot.toLowerCase()} of kafka-importer`);
    await expect(field(page, 'Definition')).toHaveCount(1);
  }
  // a step whose processor holds all three: three children
  await pickStep(page, id.t!);
  await tab(page, 'Processor').click();
  await expect(childLabels(page, 'Processor')).toHaveText(['Input schema', 'Output schema', 'Config schema']);
});

test('Rule 3: "no child chosen at first; a parent click returns to its own fields"', async ({ page }) => {
  const id = await open(page);
  await pickWorkflow(page, id.b!);
  await pickStep(page, id.s!);
  await expect(childTab(page, 'Step', B)).toHaveAttribute('aria-selected', 'false');
  await expect(field(page, 'Name')).toHaveValue(S);
  await childTab(page, 'Step', B).click();
  await expect(inspector(page).locator('.kind')).toHaveText(`assignment · belongs to ${B}`);
  await tab(page, 'Step').click();
  await expect(childTab(page, 'Step', B)).toHaveAttribute('aria-selected', 'false');
  await expect(field(page, 'Name')).toHaveValue(S);

  await tab(page, 'Processor').click();
  await expect(childTab(page, 'Processor', 'Config schema')).toHaveAttribute('aria-selected', 'false');
  await expect(field(page, 'Source hash')).toHaveCount(1);
  await childTab(page, 'Processor', 'Config schema').click();
  await expect(field(page, 'Definition')).toHaveCount(1);
  await tab(page, 'Processor').click();
  await expect(field(page, 'Source hash')).toHaveCount(1);
  await expect(field(page, 'Definition')).toHaveCount(0);
});

test('Rule 3: "each parent keeps its own chosen child while the same pick stays"; "a new pick resets"', async ({ page }) => {
  const id = await open(page);
  await pickWorkflow(page, id.a!);
  await pickStep(page, id.s!);
  await childTab(page, 'Step', A).click();
  await tab(page, 'Processor').click();
  await childTab(page, 'Processor', 'Output schema').click();
  await tab(page, 'Step').click(); // switching parents: Step's child is still chosen
  await expect(childTab(page, 'Step', A)).toHaveAttribute('aria-selected', 'true');
  await expect(inspector(page).locator('.kind')).toHaveText(`assignment · belongs to ${A}`);
  await tab(page, 'Processor').click();
  await expect(childTab(page, 'Processor', 'Output schema')).toHaveAttribute('aria-selected', 'true');
  await expect(inspector(page).locator('.kind')).toHaveText('schema · output of kafka-importer');
  // a new pick (T instead of S) resets: Step, no child
  await pickStep(page, id.t!);
  await expect(tab(page, 'Step')).toHaveAttribute('aria-selected', 'true');
  await expect(field(page, 'Name')).toHaveValue(T);
  await expect(childTab(page, 'Step', A)).toHaveAttribute('aria-selected', 'false');
  // back to S: also a new pick, nothing remembered
  await pickStep(page, id.s!);
  await expect(tab(page, 'Step')).toHaveAttribute('aria-selected', 'true');
  await expect(childTab(page, 'Step', A)).toHaveAttribute('aria-selected', 'false');
  await tab(page, 'Processor').click();
  await expect(childTab(page, 'Processor', 'Output schema')).toHaveAttribute('aria-selected', 'false');
});

// ---------------------------------------------------------------- the user's sequence

test('the user\'s sequence: click A → A form; Ctrl+click B → list [A, B]; Ctrl+click S → list [A, B, S]; click B (selected) → S with A\'s assignment; click C → C replaces A, S stays → S with C\'s assignment', async ({ page }) => {
  const id = await open(page);
  await pickWorkflow(page, id.a!);
  await expectSelected(page, [wf(id, 'a')]);
  await showsWorkflow(page, A);

  await ctrlWf(page, id.b!);
  await expectSelected(page, [wf(id, 'a'), wf(id, 'b')]);
  await expect(list(page)).toHaveText([A, B]);

  await pickStep(page, id.s!, true);
  await expectSelected(page, [wf(id, 'a'), wf(id, 'b'), st(id, 's')]);
  await expect(list(page)).toHaveText([A, B, S]);

  await pickWorkflow(page, id.b!);
  await expectSelected(page, [wf(id, 'a'), st(id, 's')]);
  await showsStep(page, S, [A]);
  await expect(await payloadOf(page, A)).toHaveValue(pretty('{"from":"A"}'));

  await pickWorkflow(page, id.c!);
  await expectSelected(page, [st(id, 's'), wf(id, 'c')]);
  await tab(page, 'Step').click();
  await showsStep(page, S, [C]);
  await expect(await payloadOf(page, C)).toHaveValue(pretty('{"from":"C"}'));
});

test('the user\'s extra cases: "2 steps selected then click a triangle → list"; "cache selected then click a step → cache dropped"', async ({ page }) => {
  const id = await open(page);
  await pickStep(page, id.s!);
  await pickStep(page, id.t!, true);
  await pickWorkflow(page, id.a!);
  await expectSelected(page, [st(id, 's'), st(id, 't'), wf(id, 'a')]);
  await expect(list(page)).toHaveText([S, T, A]);

  await clickEmptyBoard(page);
  await pickCache(page, id.k!);
  await expectSelected(page, [ca(id)]);
  await expect(tabLabels(page)).toHaveText(['Cache']);
  await pickStep(page, id.s!);
  await expectSelected(page, [st(id, 's')]);
  await showsStep(page, S, []);
});
