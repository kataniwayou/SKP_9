import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import {
  COLLAPSER, EXPANDER, NORMALIZER, VALID_PAYLOAD, clickEmptyBoard, entry, expectPublished, newStep, newWorkflow, openAt, rowNamed, save,
  typePayload, validateStored, wfNode, wire,
} from '../helpers';
import { API } from '../stack';

// Regression 4 (brief: "dry run correctness"), the user's rules of 2026-11-23 (rev 2): Save checks the design rules only and pushes
// the design as drawn; the orchestration rules are Start's. Each case is built through the UI and saved; BaseAPI's own
// POST /workflows/{id}/validate (what a Start would refuse, liveness aside) must name exactly the known problems made on purpose:
// a schema-edge mismatch (sk-normalizer's output, archive-document, into archive-expander's input, file-envelope), a payload its
// config schema refuses (sk-normalizer's handler is an enum), a cycle; and a clean workflow with none. Start is never pressed.

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
const graphProblems = async (id: string) => (await validateStored(id)).problems.filter((p) => p.gate !== 'processorLiveness');

test('a design with a schema-edge mismatch, a payload off its schema and a cycle saves as drawn; BaseAPI names exactly those problems, and Save set no count', async ({ page }) => {
  test.setTimeout(test.info().timeout * 3);
  await openAt(page, { x: -40, y: -60 }, 0.75);
  const built = await buildCases(page);
  const answer = await save(page);
  expect(answer.applied).toBe(true);
  const id = (k: string) => answer.made?.[built[k]!] ?? built[k]!;

  expect(await graphProblems(id('clean')), 'the clean workflow: no graph or payload problem').toEqual([]);
  const edge = (await graphProblems(id('edge'))).filter((p) => p.gate === 'schemaEdge');
  expect(edge, 'one schema-edge problem, on the wire edge-1 -> edge-2').toHaveLength(1);
  expect(edge[0]!.detail).toContain(id('e1'));
  expect(edge[0]!.detail).toContain(id('e2'));
  const pay = (await graphProblems(id('pay'))).filter((p) => p.gate === 'payloadConfigSchema');
  expect(pay, 'one payload problem').toHaveLength(1);
  const w = await rowNamed('workflows', N.pay);
  expect(pay[0]!.detail).toContain((w.assignmentIds as string[])[0]!);
  expect((await graphProblems(id('cycle'))).filter((p) => p.gate === 'cycle')).toHaveLength(1);

  // Save is not Start: no count on any triangle, every diagram published
  for (const k of ['clean', 'edge', 'pay', 'cycle'] as const) {
    await expect(wfNode(page, id(k)).locator('.tri-problems')).toHaveCount(0);
    await expectPublished(page, N[k]);
    expect(await svgStatus(id(k)), `${N[k]}.svg`).toBe(200);
  }
});

test('a step that needs a payload but has none saves, and BaseAPI names it as a missing payload Start would refuse', async ({ page }) => {
  test.setTimeout(test.info().timeout * 3);
  await openAt(page, { x: -40, y: -60 }, 0.75);
  const wf = await newWorkflow(page, { x: 0, y: 0 }, `${P}nopay`);
  const step = await newStep(page, NORMALIZER, { x: 220, y: 0 }, `${P}nopay-1`);
  await entry(page, wf, step);
  await clickEmptyBoard(page);
  const answer = await save(page);
  expect(answer.applied).toBe(true);
  const id = answer.made?.[wf] ?? wf;
  const missing = (await graphProblems(id)).filter((p) => p.gate === 'missingPayload');
  expect(missing, 'sk-normalizer requires a handler').toHaveLength(1);
  expect(missing[0]!.detail).toContain('handler');
});
