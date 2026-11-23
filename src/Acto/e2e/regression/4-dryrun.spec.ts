import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import {
  COLLAPSER, EXPANDER, NORMALIZER, VALID_PAYLOAD, clickEmptyBoard, dryRunLines, entry, expectPublished, newStep,
  newWorkflow, openAt, outLine, pickEdge, rowNamed, save, toolbar, typePayload, validateStored, wfNode, wire, wireEdge, type Problem,
} from '../helpers';
import { API, getJson, type Row } from '../stack';

// Regression 4 (brief: "dry run correctness"), the user's rules of 2026-11-23: Save dry-runs every affected workflow first (BaseAPI's
// POST /workflows/validate: the changes run and rolled back, the start's gates, liveness aside) and pushes only when all are clean.
// Each case is built through the UI. Known problems are made on purpose: a schema-edge mismatch (sk-normalizer's output,
// archive-document, into archive-expander's input, file-envelope), a payload its config schema refuses (sk-normalizer's handler is an
// enum), a cycle; and a clean workflow with none. Acto's Output lines and badges must be exactly the dry run's answer.

const P = 'e2e-v-';
const N = { clean: `${P}clean`, edge: `${P}edge`, pay: `${P}payload`, cycle: `${P}cycle` };

/** Four workflows, each its own steps; answers the client ids. */
async function buildCases(page: Page) {
  const id: Record<string, string> = {};
  // clean: expander -> normalizer -> collapser, every payload valid
  id.clean = await newWorkflow(page, { x: 0, y: 0 }, N.clean);
  id.c1 = await newStep(page, EXPANDER, { x: 220, y: 0 }, `${P}clean-1`);
  id.c2 = await newStep(page, NORMALIZER, { x: 500, y: 0 }, `${P}clean-2`);
  id.c3 = await newStep(page, COLLAPSER, { x: 780, y: 0 }, `${P}clean-3`);
  await wire(page, id.c1!, id.c2!);
  await wire(page, id.c2!, id.c3!);
  await entry(page, id.clean!, id.c1!);
  for (const [k, proc] of [['c1', EXPANDER], ['c2', NORMALIZER], ['c3', COLLAPSER]] as const) await typePayload(page, id.clean!, N.clean, id[k]!, VALID_PAYLOAD[proc]!);
  // schema edge: normalizer (out archive-document) -> expander (in file-envelope)
  id.edge = await newWorkflow(page, { x: 0, y: 180 }, N.edge);
  id.e1 = await newStep(page, NORMALIZER, { x: 220, y: 180 }, `${P}edge-1`);
  id.e2 = await newStep(page, EXPANDER, { x: 500, y: 180 }, `${P}edge-2`);
  await wire(page, id.e1!, id.e2!);
  await entry(page, id.edge!, id.e1!);
  await typePayload(page, id.edge!, N.edge, id.e1!, VALID_PAYLOAD[NORMALIZER]!);
  await typePayload(page, id.edge!, N.edge, id.e2!, VALID_PAYLOAD[EXPANDER]!);
  // payload: a handler the enum does not have
  id.pay = await newWorkflow(page, { x: 0, y: 360 }, N.pay);
  id.p1 = await newStep(page, NORMALIZER, { x: 220, y: 360 }, `${P}payload-1`);
  await entry(page, id.pay!, id.p1!);
  await typePayload(page, id.pay!, N.pay, id.p1!, '{"handler": "NoSuchHandler"}');
  // cycle: two normalizers wired both ways
  id.cycle = await newWorkflow(page, { x: 0, y: 540 }, N.cycle);
  id.y1 = await newStep(page, NORMALIZER, { x: 220, y: 540 }, `${P}cycle-1`);
  id.y2 = await newStep(page, NORMALIZER, { x: 500, y: 540 }, `${P}cycle-2`);
  await wire(page, id.y1!, id.y2!);
  await wire(page, id.y2!, id.y1!);
  await entry(page, id.cycle!, id.y1!);
  for (const k of ['y1', 'y2']) await typePayload(page, id.cycle!, N.cycle, id[k]!, VALID_PAYLOAD[NORMALIZER]!);
  await clickEmptyBoard(page);
  return id;
}

const svgStatus = async (id: string) => (await fetch(`${API}/workflows/${id}.svg`)).status;
type Checked = { valid: boolean; workflows: { workflowId: string; problems: Problem[] }[] };

/** Output's lines for the workflow and its badge are exactly the dry run's problems for it; answers them. */
async function expectCheckShown(page: Page, checked: Checked, wf: string, wfName: string): Promise<Problem[]> {
  const problems = checked.workflows.find((w) => w.workflowId === wf)?.problems ?? [];
  const want = problems.map((p) => `${wfName}: ${p.title ?? p.gate} — ${p.detail ?? ''}`).sort();
  test.info().annotations.push({ type: 'dry run', description: `${wfName}: ${want.length} problem(s)${want.length ? ` — ${problems.map((p) => p.gate).join(', ')}` : ''}` });
  expect((await dryRunLines(page, wfName)).sort(), `${wfName}: Output's lines are the dry run's problems`).toEqual(want);
  const badge = wfNode(page, wf).locator('.tri-problems');
  if (want.length === 0) await expect(badge, `${wfName}: no problem badge`).toHaveCount(0);
  else await expect(badge, `${wfName}: the badge counts the dry run's problems`).toHaveText(String(want.length));
  return problems;
}

test('a Save holding a schema-edge mismatch, a payload off its schema and a cycle pushes nothing: Output and the badges are the dry run\'s answer, workflow by workflow', async ({ page }) => {
  test.setTimeout(test.info().timeout * 3);
  await openAt(page, { x: -40, y: -60 }, 0.75);
  const id = await buildCases(page);
  const answer = await save(page);
  expect(answer.applied).toBe(false);
  const checked = answer.checked as Checked;
  expect(checked.valid).toBe(false);

  expect((await expectCheckShown(page, checked, id.clean!, N.clean)), 'the clean workflow: no problem').toEqual([]);
  const edge = await expectCheckShown(page, checked, id.edge!, N.edge);
  const mismatch = edge.filter((p) => p.gate === 'schemaEdge');
  expect(mismatch, 'one schema-edge problem, on the wire edge-1 -> edge-2').toHaveLength(1);
  expect(mismatch[0]!.title).toBe('Schema-edge mismatch between steps');
  const pay = await expectCheckShown(page, checked, id.pay!, N.pay);
  expect(pay.filter((p) => p.gate === 'payloadConfigSchema'), 'one payload problem').toHaveLength(1);
  expect(pay.find((p) => p.gate === 'payloadConfigSchema')!.title).toBe('Assignment payload does not conform to its config schema');
  const cycle = await expectCheckShown(page, checked, id.cycle!, N.cycle);
  expect(cycle.filter((p) => p.gate === 'cycle')).toHaveLength(1);
  // liveness is never part of it
  expect([...edge, ...pay, ...cycle].some((p) => p.gate === 'processorLiveness')).toBe(false);

  const n = edge.length + pay.length + cycle.length;
  await expect(outLine(page, `Not pushed: ${n} problems in 3 workflows`)).toHaveCount(1);
  // nothing reached BaseAPI, not even the clean workflow
  const names = new Set((await getJson<Row[]>('/workflows')).map((w) => w.name));
  for (const k of ['clean', 'edge', 'pay', 'cycle'] as const) expect(names.has(N[k]), `${N[k]} not pushed`).toBe(false);
});

test('fixed one problem at a time, each Save still pushes nothing until the last one is fixed; then the whole board pushes at once, every badge goes and every diagram is published', async ({ page }) => {
  test.setTimeout(test.info().timeout * 3);
  await openAt(page, { x: -40, y: -60 }, 0.75);
  const id = await buildCases(page);
  expect((await save(page)).applied).toBe(false);

  // the schema edge: its wire goes; the payload and the cycle still hold the push back
  await pickEdge(page, wireEdge(page, id.e1!, id.e2!));
  await toolbar(page, 'wire').getByRole('button', { name: 'Delete' }).click();
  await expect(wireEdge(page, id.e1!, id.e2!)).toHaveCount(0);
  const second = await save(page);
  expect(second.applied).toBe(false);
  expect(await expectCheckShown(page, second.checked as Checked, id.edge!, N.edge)).toEqual([]);

  // the payload, through the Inspector
  await typePayload(page, id.pay!, N.pay, id.p1!, '{"handler": "Sample"}');
  await clickEmptyBoard(page);
  const third = await save(page);
  expect(third.applied).toBe(false);
  expect(await expectCheckShown(page, third.checked as Checked, id.pay!, N.pay)).toEqual([]);
  await expect(outLine(page, /^Not pushed: \d+ problems? in 1 workflow$/)).toHaveCount(1);

  // the cycle: the wire back goes, and the board pushes as a whole
  await pickEdge(page, wireEdge(page, id.y2!, id.y1!));
  await toolbar(page, 'wire').getByRole('button', { name: 'Delete' }).click();
  const last = await save(page);
  expect(last.applied).toBe(true);
  const real = (k: string) => last.made?.[id[k]!] ?? id[k]!;
  for (const k of ['clean', 'edge', 'pay', 'cycle'] as const) {
    await expect(wfNode(page, real(k)).locator('.tri-problems')).toHaveCount(0);
    await expectPublished(page, N[k]);
    expect(await svgStatus(real(k)), `${N[k]}.svg`).toBe(200);
    expect((await rowNamed('workflows', N[k])).name).toBe(N[k]);
  }
  // and BaseAPI agrees the pushed board is clean (liveness aside)
  for (const k of ['clean', 'edge', 'pay', 'cycle'] as const) {
    expect((await validateStored(real(k))).problems.filter((p) => p.gate !== 'processorLiveness'), N[k]).toEqual([]);
  }
});
