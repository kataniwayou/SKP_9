import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import {
  COLLAPSER, EXPANDER, NORMALIZER, VALID_PAYLOAD, clickEmptyBoard, dryRunLines, entry, expectDryRunMatches, expectPublished, field, newStep,
  newWorkflow, openAt, out, pickEdge, pickStep, rowNamed, save, toolbar, typePayload, wfNode, wire, wireEdge,
} from '../helpers';
import { API, getJson, type Row } from '../stack';

// Regression 4 (brief: "dry run correctness"): after each successful Save Acto dry-runs every affected workflow. Each case is built through
// the UI, and BaseAPI's own POST /workflows/{id}/validate is called by the test: Acto's Output lines for the workflow and its triangle's
// badge must equal BaseAPI's problems exactly. Known problems are made on purpose: a schema-edge mismatch (sk-normalizer's output,
// archive-document, into archive-expander's input, file-envelope), a payload its config schema refuses (sk-normalizer's handler is an enum),
// a cycle; and a clean workflow with none (no badge).

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

test('after a Save each affected workflow\'s Output lines and badge are BaseAPI\'s validate answer: a clean one, a schema-edge mismatch, a payload off its schema, a cycle', async ({ page }) => {
  test.setTimeout(test.info().timeout * 3);
  await openAt(page, { x: -40, y: -60 }, 0.75);
  const built = await buildCases(page);
  const answer = await save(page);
  expect(answer.applied).toBe(true);
  const id = (k: string) => answer.made?.[built[k]!] ?? built[k]!;

  const clean = await expectDryRunMatches(page, id('clean'), N.clean);
  expect(clean.filter((p) => p.gate !== 'processorLiveness'), 'the clean workflow: no graph or payload problem').toEqual([]);
  test.info().annotations.push({ type: 'clean', description: clean.length === 0 ? '0 problems, no badge' : `liveness only: ${clean.length}` });
  if (clean.length === 0) await expect(wfNode(page, id('clean')).locator('.tri-problems')).toHaveCount(0);

  const edge = await expectDryRunMatches(page, id('edge'), N.edge);
  const mismatch = edge.filter((p) => p.gate === 'schemaEdge');
  expect(mismatch, 'one schema-edge problem, on the wire edge-1 -> edge-2').toHaveLength(1);
  expect(mismatch[0]!.detail).toContain(id('e1'));
  expect(mismatch[0]!.detail).toContain(id('e2'));
  expect(mismatch[0]!.title).toBe('Schema-edge mismatch between steps');

  const pay = await expectDryRunMatches(page, id('pay'), N.pay);
  const off = pay.filter((p) => p.gate === 'payloadConfigSchema');
  expect(off, 'one payload problem').toHaveLength(1);
  const w = await rowNamed('workflows', N.pay);
  expect(off[0]!.detail).toContain((w.assignmentIds as string[])[0]!);
  expect(off[0]!.title).toBe('Assignment payload does not conform to its config schema');

  const cycle = await expectDryRunMatches(page, id('cycle'), N.cycle);
  expect(cycle.filter((p) => p.gate === 'cycle')).toHaveLength(1);

  // one Kibana diagram per affected workflow, published and served
  for (const k of ['clean', 'edge', 'pay', 'cycle'] as const) {
    await expectPublished(page, N[k]);
    expect(await svgStatus(id(k)), `${N[k]}.svg`).toBe(200);
  }
  // the problems are warnings in Output, one line each
  const warn = await out(page).locator('.k-warn').allInnerTexts();
  expect(warn.filter((t) => t.startsWith(P)).length).toBe(edge.length + pay.length + cycle.length + clean.length);
});

test('a Save re-validates only the workflows it touched: the fixed one is dry-run clean and republished, the untouched ones get no Output line and keep their badges', async ({ page }) => {
  test.setTimeout(test.info().timeout * 3);
  await openAt(page, { x: -40, y: -60 }, 0.75);
  const built = await buildCases(page);
  const first = await save(page);
  expect(first.applied).toBe(true);
  const id = (k: string) => first.made?.[built[k]!] ?? built[k]!;
  const payBadge = await wfNode(page, id('pay')).locator('.tri-problems').innerText();

  // fix the schema edge: the mismatched wire goes; nothing else changes
  await pickEdge(page, wireEdge(page, id('e1'), id('e2')));
  await toolbar(page, 'wire').getByRole('button', { name: 'Delete' }).click();
  await expect(wireEdge(page, id('e1'), id('e2'))).toHaveCount(0);
  const second = await save(page);
  expect(second.applied).toBe(true);
  const fixed = await expectDryRunMatches(page, id('edge'), N.edge);
  expect(fixed.filter((p) => p.gate === 'schemaEdge')).toEqual([]);
  await expectPublished(page, N.edge);
  // the other three were not affected: no dry-run line, no Kibana line; the payload case keeps its badge from its last dry run
  const lines = await out(page).locator('[role="listitem"] span').allInnerTexts();
  for (const k of ['clean', 'pay', 'cycle'] as const) {
    expect(lines.filter((t) => t.startsWith(`${N[k]}: `)), `${N[k]} was not re-validated`).toEqual([]);
    expect(await dryRunLines(page, N[k])).toEqual([]);
  }
  await expect(wfNode(page, id('pay')).locator('.tri-problems')).toHaveText(payBadge);

  // fix the payload through the Inspector: only that workflow is dry-run now, and its badge goes when BaseAPI finds nothing
  await typePayload(page, id('pay'), N.pay, id('p1'), '{"handler": "Sample"}');
  await clickEmptyBoard(page);
  const third = await save(page);
  expect(third.applied).toBe(true);
  const nowPay = await expectDryRunMatches(page, id('pay'), N.pay);
  expect(nowPay.filter((p) => p.gate === 'payloadConfigSchema')).toEqual([]);
  await expectPublished(page, N.pay);
  const after = await out(page).locator('[role="listitem"] span').allInnerTexts();
  for (const k of ['clean', 'edge', 'cycle'] as const) expect(after.filter((t) => t.startsWith(`${N[k]}: `)), `${N[k]} was not re-validated`).toEqual([]);
  // a step shared by nobody else, renamed: its one workflow is affected, through its stream
  await clickEmptyBoard(page);
  await pickStep(page, id('y2'));
  await field(page, 'Name').fill(`${P}cycle-2-renamed`);
  await save(page);
  await expectDryRunMatches(page, id('cycle'), N.cycle);
  await expectPublished(page, N.cycle);
  const last = await out(page).locator('[role="listitem"] span').allInnerTexts();
  for (const k of ['clean', 'edge', 'pay'] as const) expect(last.filter((t) => t.startsWith(`${N[k]}: `))).toEqual([]);
  expect((await getJson<Row[]>('/steps')).some((s) => s.name === `${P}cycle-2-renamed`)).toBe(true);
});
