import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import {
  COLLAPSER, CONDITION, EXPANDER, FETCHER, NORMALIZER, PERSISTER, VALID_PAYLOAD, type ConditionName,
  entry, expectAt, expectDryRunMatches, expectPublished, field, inspector, link, newCache, newStep, newWorkflow, openAt, outLine, pickStep,
  placeOf, rowNamed, save, saveButton, sameJson, selectWorkflowAlone, setCondition, stNode, typePayload, unsavedCount, waitLoaded, wfNode,
  caNode, wire, clickEmptyBoard,
} from '../helpers';
import { getJson, type Row } from '../stack';

// Regression 1 (brief: "start from fresh start and build complex workflows"): three workflows over one branching graph, built through the
// UI only (toolbox drops, handle drags, the condition picker, Inspector typing, Save) from a clean browser and an empty region. A fan-out,
// a diamond, a six-step chain, every entry condition, a cron, descriptions and a valid payload on every step each workflow reaches. After
// the Save, BaseAPI's rows are read back and compared with what the board shows, field by field; then a reload shows the same board.

const P = 'e2e-r-';
interface StepPlan { key: string; proc: string; at: { x: number; y: number }; cond: ConditionName }
// processors chain by schema: expander (envelope -> document), normalizer (document -> document), collapser (document -> envelope),
// persister (envelope -> locator), fetcher (locator -> envelope): every wire below is schema-clean
const STEPS: StepPlan[] = [
  { key: 'a1', proc: EXPANDER, at: { x: 200, y: 60 }, cond: 'Completed' },
  { key: 'n1', proc: NORMALIZER, at: { x: 480, y: -40 }, cond: 'Completed' },
  { key: 'n2', proc: NORMALIZER, at: { x: 480, y: 160 }, cond: 'Failed' },
  { key: 'n3', proc: NORMALIZER, at: { x: 760, y: 60 }, cond: 'Cancelled' },
  { key: 'c1', proc: COLLAPSER, at: { x: 1040, y: 60 }, cond: 'Always' },
  { key: 'p1', proc: PERSISTER, at: { x: 760, y: 320 }, cond: 'Never' },
  { key: 'f1', proc: FETCHER, at: { x: 1040, y: 320 }, cond: 'Completed' },
];
const WIRES: [string, string][] = [['a1', 'n1'], ['a1', 'n2'], ['n1', 'n3'], ['n2', 'n3'], ['n3', 'c1'], ['c1', 'p1'], ['p1', 'f1']];
const WORKFLOWS = [
  { key: 'a', at: { x: 0, y: 70 }, entry: ['a1'], caches: ['k1'], cron: null, description: 'regression A: the whole graph' },
  { key: 'b', at: { x: 560, y: 380 }, entry: ['c1'], caches: [], cron: null, description: 'regression B: the tail from the collapser' },
  { key: 'c', at: { x: 560, y: 520 }, entry: ['f1', 'p1'], caches: ['k1'], cron: '0 */5 * * * *', description: 'regression C: scheduled' },
] as const;
/** Which steps each workflow reaches (its stream). */
const REACH: Record<string, string[]> = {
  a: ['a1', 'n1', 'n2', 'n3', 'c1', 'p1', 'f1'],
  b: ['c1', 'p1', 'f1'],
  c: ['f1', 'p1'],
};
/** A distinct, valid payload per workflow and step: the workflow's letter is in it where the schema allows a free value. */
function payloadFor(wf: string, step: StepPlan): string {
  const n = { a: 1, b: 2, c: 3 }[wf]!;
  switch (step.proc) {
    case EXPANDER: return `{"maxDepth": ${n + 1}}`;
    case NORMALIZER: return `{"handler": "${['Acme', 'AlphaBeta', 'Sample'][n - 1]}", "cacheRoot": "${P}${wf}-${step.key}"}`;
    case PERSISTER: return `{"folderPath": "/tmp/${P}${wf}"}`;
    case FETCHER: return `{"minimumSizeBytes": ${n}, "maximumSizeBytes": ${n * 1000}}`;
    default: return VALID_PAYLOAD[step.proc]!;
  }
}

/** The whole plan through the UI; answers the client ids by key. */
async function build(page: Page) {
  const id: Record<string, string> = {};
  for (const w of WORKFLOWS) {
    id[w.key] = await newWorkflow(page, w.at, `${P}${w.key}`);
    await field(page, 'Description').fill(w.description);
    if (w.cron) {
      await field(page, 'Cron').fill(w.cron);
      await expect(inspector(page)).toContainText(/5 minutes/i);
    }
  }
  for (const s of STEPS) id[s.key] = await newStep(page, s.proc, s.at, `${P}${s.key}`);
  id.k1 = await newCache(page, { x: 200, y: 520 }, `${P}k1`, `${P}root`);
  for (const [f, t] of WIRES) await wire(page, id[f]!, id[t]!);
  for (const w of WORKFLOWS) {
    for (const e of w.entry) await entry(page, id[w.key]!, id[e]!);
    for (const c of w.caches) await link(page, id[w.key]!, id[c]!);
  }
  for (const s of STEPS) if (s.cond !== 'Completed') await setCondition(page, id[s.key]!, s.cond);
  for (const w of WORKFLOWS) {
    for (const key of REACH[w.key]!) await typePayload(page, id[w.key]!, `${P}${w.key}`, id[key]!, payloadFor(w.key, STEPS.find((s) => s.key === key)!));
  }
  await clickEmptyBoard(page);
  return id;
}

/** The graph as the board draws it now: wires, entry arrows and cache lines by their edge ids. */
async function drawn(page: Page) {
  const ids = await page.locator('.react-flow__edge:not(.ghost)').evaluateAll((es) => es.map((e) => (e as HTMLElement).dataset.id!));
  const pairs = (kind: string) => ids.filter((i) => i.startsWith(`${kind}:`)).map((i) => i.split(':').slice(1) as [string, string]);
  return { wires: pairs('wire').sort(), entries: pairs('entry').sort(), lines: pairs('cache').sort() };
}

test('three workflows over a branching graph, every entry condition, a cron and a payload on every reached step: Save writes exactly what the board shows', async ({ page }) => {
  test.setTimeout(test.info().timeout * 3);
  await openAt(page, { x: -40, y: -80 }, 0.62);
  expect(await page.evaluate(() => localStorage.getItem('acto.board')), 'a fresh browser: no draft').toBeNull();
  const n0 = await unsavedCount(page);
  const id = await build(page);

  // every item and edge is unsaved and on the board: 3 triangles + 7 steps + 1 cache + 11 assignments = 22 rows
  expect(await unsavedCount(page)).toBe(n0 + 3 + STEPS.length + 1 + Object.values(REACH).flat().length);
  const before = await drawn(page);
  expect(before.wires.filter(([f]) => Object.values(id).includes(f))).toHaveLength(WIRES.length);

  const answer = await save(page);
  expect(answer.applied, 'the Save is applied').toBe(true);
  await expect(outLine(page, /^Pushed \d+ changes?$/)).toHaveCount(1);
  await expect(saveButton(page)).toHaveText('Save');
  await expect(saveButton(page)).toBeDisabled();
  const real = (k: string) => answer.made?.[id[k]!] ?? id[k]!;

  // BaseAPI's rows, by name
  const wf: Record<string, Row> = {};
  for (const w of WORKFLOWS) wf[w.key] = await rowNamed('workflows', `${P}${w.key}`);
  const st: Record<string, Row> = {};
  for (const s of STEPS) st[s.key] = await rowNamed('steps', `${P}${s.key}`);
  const k1 = await rowNamed('caches', `${P}k1`);
  const assignments = await getJson<Row[]>('/assignments');
  for (const k of Object.keys(id)) expect([...Object.values(wf), ...Object.values(st), k1].some((r) => r.id === real(k)), `${k} took a BaseAPI id`).toBe(true);

  // what the board draws now (BaseAPI's ids): every link is a row field, and every row field is a link on the board
  const now = await drawn(page);
  const stepIds = new Set(Object.values(st).map((s) => s.id));
  for (const s of STEPS) {
    const row = st[s.key]!;
    expect(row.version, `${row.name} version`).toBe('1.0.0');
    expect(row.entryCondition, `${row.name} entry condition`).toBe(CONDITION[s.cond].value);
    const wantNext = WIRES.filter(([f]) => f === s.key).map(([, t]) => st[t]!.id).sort();
    expect([...(row.nextStepIds as string[])].sort(), `${row.name} next steps`).toEqual(wantNext);
    expect(now.wires.filter(([f]) => f === row.id).map(([, t]) => t).sort(), `${row.name}: the board's wires`).toEqual(wantNext);
    expect(row.processorId, `${row.name} processor`).toBeTruthy();
    expectAt(row, await placeOf(stNode(page, row.id)));
    await expect(stNode(page, row.id).locator('.cond-pill')).toHaveText(CONDITION[s.cond].letter);
  }
  expect(now.wires.filter(([f, t]) => stepIds.has(f) || stepIds.has(t))).toHaveLength(WIRES.length);
  for (const w of WORKFLOWS) {
    const row = wf[w.key]!;
    expect(row.version).toBe('1.0.0');
    expect(row.description).toBe(w.description);
    expect(row.cronExpression ?? null).toBe(w.cron);
    const wantEntry = w.entry.map((e) => st[e]!.id).sort();
    expect([...(row.entryStepIds as string[])].sort(), `${row.name} entry steps`).toEqual(wantEntry);
    expect(now.entries.filter(([f]) => f === row.id).map(([, t]) => t).sort(), `${row.name}: the board's entry arrows`).toEqual(wantEntry);
    const wantCaches = w.caches.map(() => k1.id);
    expect(row.cacheIds, `${row.name} caches`).toEqual(wantCaches);
    expect(now.lines.filter(([f]) => f === row.id).map(([, t]) => t), `${row.name}: the board's cache lines`).toEqual(wantCaches);
    expectAt(row, await placeOf(wfNode(page, row.id)));
    // one assignment per reached step, each with the payload typed for this workflow
    const mine = assignments.filter((a) => (row.assignmentIds as string[]).includes(a.id));
    expect(mine.map((a) => a.stepId).sort(), `${row.name} assignment steps`).toEqual(REACH[w.key]!.map((k) => st[k]!.id).sort());
    for (const a of mine) {
      const key = Object.keys(st).find((k) => st[k]!.id === a.stepId)!;
      sameJson(a.payload, payloadFor(w.key, STEPS.find((s) => s.key === key)!));
      expect(a.name, 'an assignment row is an e2e- row').toMatch(/^e2e-/);
    }
  }
  expect(k1.root).toBe(`${P}root`);
  expectAt(k1, await placeOf(caNode(page, k1.id)));

  // the dry run of every workflow the Save touched: Acto's lines and badge are BaseAPI's own answer; the graph is schema-clean and
  // every payload conforms, so no schema-edge or payload problem may be among them
  for (const w of WORKFLOWS) {
    const problems = await expectDryRunMatches(page, wf[w.key]!.id, `${P}${w.key}`);
    expect(problems.filter((p) => p.gate === 'schemaEdge' || p.gate === 'payloadConfigSchema' || p.gate === 'cycle'), `${P}${w.key}: a clean graph`).toEqual([]);
    await expectPublished(page, `${P}${w.key}`);
  }

  // each step's Inspector shows the stored name and version; each workflow's assignments show the stored payloads
  for (const s of STEPS) {
    await clickEmptyBoard(page);
    await pickStep(page, st[s.key]!.id);
    await expect(field(page, 'Name')).toHaveValue(st[s.key]!.name);
    await expect(field(page, 'Version')).toHaveValue(st[s.key]!.version as string);
  }
  await selectWorkflowAlone(page, wf.c!.id);
  await expect(field(page, 'Cron')).toHaveValue('0 */5 * * * *');
  await expect(inspector(page).getByTestId('assignments').locator('.in-assign')).toHaveCount(REACH.c!.length);

  // a reload: the stored board, nothing unsaved, the same places
  const places = await Promise.all(Object.values(st).map((r) => placeOf(stNode(page, r.id))));
  await page.reload();
  await waitLoaded(page);
  await expect(page.locator('.unsaved-mark')).toHaveCount(0);
  await expect(saveButton(page)).toBeDisabled();
  expect(await Promise.all(Object.values(st).map((r) => placeOf(stNode(page, r.id))))).toEqual(places);
  expect(await drawn(page)).toEqual(now);
});
