import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import {
  EXPANDER, NORMALIZER, boardSnapshot, caNode, cacheEdge, childLabels, childTab, clickEmptyBoard, entry, entryEdge, expectSaveChecksNothing,
  expectPublished, field, ghost, inspector, link, newCache, newStep, newWorkflow, openAt, outLine, payloadOf, pickCache, pickStep,
  pretty, rowNamed, rowsNamed, save, saveButton, sameJson, selbar, selectWorkflowAlone, setCondition, stNode, tab, tabLabels, toolbar,
  typePayload, unsavedCount, wfNode, wire, wireEdge,
} from '../helpers';
import { getJson, type Row } from '../stack';

// Regression 2 (brief: "create all the combinations of shared entities"): everything is built through the UI from a clean browser, then
// checked on the board, in the Inspector and in BaseAPI after the Save.
//   S  entry of W1 and W2 (one step shared by two workflows as entry), a different payload per workflow
//   U  entry of W3 and wired from S (reached by one workflow as entry and by two others through a wire)
//   T  wired from S and from U (shared by all three only through wires)
//   O  an orphan step; C1 linked to all three; C2 linked to W1 too (one workflow, two caches); C3 linked to none
// S, U and T run one processor (sk-normalizer), so its Processor tab lists them all.

const P = 'e2e-s-';
const N = { w1: `${P}w1`, w2: `${P}w2`, w3: `${P}w3`, s: `${P}shared`, u: `${P}entry-or-wire`, t: `${P}wires-only`, o: `${P}orphan`, c1: `${P}c-all`, c2: `${P}c-w1`, c3: `${P}c-none` };
const PAY = { w1: '{"handler": "Acme"}', w2: '{"handler": "Sample", "cacheRoot": "e2e-s-root"}' };

type Ids = Record<'w1' | 'w2' | 'w3' | 's' | 'u' | 't' | 'o' | 'c1' | 'c2' | 'c3', string>;

/** The shared board through the UI. `extraEntries` gives W1 and W2 a second entry each (T and U), so S can be deleted and still save. */
async function buildShared(page: Page, opts: { payloads?: boolean; extraEntries?: boolean } = {}): Promise<Ids> {
  const id = {} as Ids;
  id.w1 = await newWorkflow(page, { x: 0, y: 0 }, N.w1);
  id.w2 = await newWorkflow(page, { x: 0, y: 200 }, N.w2);
  id.w3 = await newWorkflow(page, { x: 0, y: 420 }, N.w3);
  id.s = await newStep(page, NORMALIZER, { x: 260, y: 100 }, N.s);
  id.u = await newStep(page, NORMALIZER, { x: 560, y: 420 }, N.u);
  id.t = await newStep(page, NORMALIZER, { x: 860, y: 100 }, N.t);
  id.o = await newStep(page, EXPANDER, { x: 860, y: 300 }, N.o);
  id.c1 = await newCache(page, { x: 180, y: 620 }, N.c1);
  id.c2 = await newCache(page, { x: 400, y: 620 }, N.c2);
  id.c3 = await newCache(page, { x: 620, y: 620 }, N.c3);
  await wire(page, id.s, id.u);
  await wire(page, id.s, id.t);
  await wire(page, id.u, id.t);
  await entry(page, id.w1, id.s);
  await entry(page, id.w2, id.s);
  await entry(page, id.w3, id.u);
  if (opts.extraEntries) {
    await entry(page, id.w1, id.t);
    await entry(page, id.w2, id.u);
  }
  for (const w of [id.w1, id.w2, id.w3]) await link(page, w, id.c1);
  await link(page, id.w1, id.c2);
  if (opts.payloads !== false) {
    await typePayload(page, id.w1, N.w1, id.s, PAY.w1);
    await typePayload(page, id.w2, N.w2, id.s, PAY.w2);
  }
  await clickEmptyBoard(page);
  return id;
}

/** After a Save the board holds BaseAPI's ids: the same keys, mapped. */
const remap = (id: Ids, made: Record<string, string> | undefined): Ids =>
  Object.fromEntries(Object.entries(id).map(([k, v]) => [k, made?.[v] ?? v])) as Ids;

const kindLine = (page: Page) => inspector(page).locator('.kind');
const usedBy = (page: Page) => inspector(page).locator('dt', { hasText: /^Used by$/ }).locator('xpath=following-sibling::dd[1]');

async function expectStepUsers(page: Page, step: string, users: string[]) {
  await clickEmptyBoard(page);
  await pickStep(page, step);
  if (users.length === 0) {
    await expect(kindLine(page)).toHaveText('step');
    await expect(usedBy(page)).toHaveText('no workflow');
    return;
  }
  await expect(kindLine(page)).toHaveText(/^step · shared by /);
  for (const u of users) await expect(usedBy(page)).toContainText(u);
  expect((await usedBy(page).innerText()).split(', ').sort()).toEqual([...users].sort());
}

test('every shared-entity combination: shared entry, wires-only sharing, entry-or-wire, per-workflow payloads, shared and orphan caches, one processor, an orphan step', async ({ page }) => {
  test.setTimeout(test.info().timeout * 3);
  await openAt(page, { x: -40, y: -60 }, 0.7);
  const built = await buildShared(page);

  // on the board and in the Inspector, before the Save
  const check = async (id: Ids) => {
    await expectStepUsers(page, id.s, [N.w1, N.w2]);
    await expectStepUsers(page, id.u, [N.w1, N.w2, N.w3]);
    await expectStepUsers(page, id.t, [N.w1, N.w2, N.w3]);
    await expectStepUsers(page, id.o, []);
    // the shared step's payload, per workflow: its own assignment tab under Step, its own keys on the chip
    await selectWorkflowAlone(page, id.w1);
    await pickStep(page, id.s);
    await expect(childLabels(page, 'Step')).toHaveText([N.w1]);
    await expect(await payloadOf(page, N.w1)).toHaveValue(pretty(PAY.w1));
    await expect(stNode(page, id.s).locator('.key-chip')).toHaveText('◆ 1 key');
    await selectWorkflowAlone(page, id.w2);
    await pickStep(page, id.s);
    await expect(childLabels(page, 'Step')).toHaveText([N.w2]);
    await expect(await payloadOf(page, N.w2)).toHaveValue(pretty(PAY.w2));
    await expect(stNode(page, id.s).locator('.key-chip')).toHaveText('◆ 2 keys');
    // both triangles: one chip per workflow, each with that workflow's keys; T and U hold no payload of either
    await selectWorkflowAlone(page, id.w1);
    await wfNode(page, id.w2).locator('.tri-nm').click({ modifiers: ['Control'] });
    await expect(stNode(page, id.s).locator('.key-chip')).toHaveText([`◆ 1 key · ${N.w1}`, `◆ 2 keys · ${N.w2}`]);
    await expect(stNode(page, id.t).locator('.key-chip')).toHaveCount(0);
    await expect(stNode(page, id.u).locator('.key-chip')).toHaveCount(0);
    // W3 reaches T only through U's wire: no assignment there, only ＋ Create (no Payload editor, as Studio)
    await selectWorkflowAlone(page, id.w3);
    await pickStep(page, id.t);
    await expect(childLabels(page, 'Step')).toHaveText([N.w3]);
    await childTab(page, 'Step', N.w3).click();
    await expect(field(page, 'Payload')).toHaveCount(0);
    await expect(inspector(page).getByRole('button', { name: '＋ Create' })).toBeVisible();
    // the caches: C1 used by all three, C2 by W1, C3 by none; W1 links two
    await clickEmptyBoard(page);
    await pickCache(page, id.c1);
    for (const w of [N.w1, N.w2, N.w3]) await expect(kindLine(page)).toContainText(w);
    await clickEmptyBoard(page);
    await pickCache(page, id.c3);
    await expect(usedBy(page)).toHaveText('no workflow');
    await selectWorkflowAlone(page, id.w1);
    await expect(inspector(page).getByText('Caches · 2')).toBeVisible();
    for (const w of [id.w1, id.w2, id.w3]) await expect(cacheEdge(page, w, id.c1)).toHaveCount(1);
    await expect(page.locator(`.react-flow__edge[data-id$=":${id.c3}"]`)).toHaveCount(0);
    // one processor under three steps: its Used by lists them all, and its config schema reads the same from each
    const definitions: string[] = [];
    for (const s of [id.s, id.u, id.t]) {
      await clickEmptyBoard(page);
      await pickStep(page, s);
      await tab(page, 'Processor').click();
      await expect(field(page, 'Name')).toHaveValue(NORMALIZER);
      await expect(kindLine(page)).toHaveText(/^processor · used by \d+ steps$/);
      for (const n of [N.s, N.u, N.t]) await expect(usedBy(page)).toContainText(n);
      await expect(usedBy(page)).not.toContainText(N.o);
      await expect(childLabels(page, 'Processor')).toHaveText(['Input schema', 'Output schema', 'Config schema']);
      await childTab(page, 'Processor', 'Config schema').click();
      definitions.push(await field(page, 'Definition').inputValue());
    }
    expect(new Set(definitions).size, 'the same config schema on every step of the processor').toBe(1);
    await clickEmptyBoard(page);
  };
  await check(built);

  const answer = await save(page);
  expect(answer.applied).toBe(true);
  const id = remap(built, answer.made);

  // BaseAPI: the links as built
  const w1 = await rowNamed('workflows', N.w1), w2 = await rowNamed('workflows', N.w2), w3 = await rowNamed('workflows', N.w3);
  const s = await rowNamed('steps', N.s), u = await rowNamed('steps', N.u), t = await rowNamed('steps', N.t), o = await rowNamed('steps', N.o);
  const c1 = await rowNamed('caches', N.c1), c2 = await rowNamed('caches', N.c2), c3 = await rowNamed('caches', N.c3);
  expect(w1.entryStepIds).toEqual([s.id]);
  expect(w2.entryStepIds).toEqual([s.id]);
  expect(w3.entryStepIds).toEqual([u.id]);
  expect([...(s.nextStepIds as string[])].sort()).toEqual([u.id, t.id].sort());
  expect(u.nextStepIds).toEqual([t.id]);
  expect(t.nextStepIds).toEqual([]);
  expect(o.nextStepIds, 'the orphan is saved, linked to nothing').toEqual([]);
  expect((await getJson<Row[]>('/workflows')).filter((w) => (w.entryStepIds as string[]).includes(o.id))).toEqual([]);
  expect([...(w1.cacheIds as string[])].sort()).toEqual([c1.id, c2.id].sort());
  expect(w2.cacheIds).toEqual([c1.id]);
  expect(w3.cacheIds).toEqual([c1.id]);
  expect((await getJson<Row[]>('/workflows')).filter((w) => (w.cacheIds as string[]).includes(c3.id)), 'the orphan cache is saved, used by none').toEqual([]);
  // one assignment row per workflow on S, each its own payload
  const asg = await getJson<Row[]>('/assignments');
  const of = (w: Row) => asg.filter((a) => (w.assignmentIds as string[]).includes(a.id));
  expect(of(w1).map((a) => a.stepId)).toEqual([s.id]);
  expect(of(w2).map((a) => a.stepId)).toEqual([s.id]);
  expect(of(w3)).toEqual([]);
  expect(of(w1)[0]!.id).not.toBe(of(w2)[0]!.id);
  sameJson(of(w1)[0]!.payload, PAY.w1);
  sameJson(of(w2)[0]!.payload, PAY.w2);
  for (const k of Object.keys(id) as (keyof Ids)[]) {
    expect([w1, w2, w3, s, u, t, o, c1, c2, c3].map((r) => r.id), `${k} has its BaseAPI id on the board`).toContain(id[k]);
  }

  // Save checked no orchestration rule on any of the three; the diagram of all three
  for (const [w, name] of [[w1, N.w1], [w2, N.w2], [w3, N.w3]] as const) {
    await expectSaveChecksNothing(page, w.id, name);
    await expectPublished(page, name);
  }
  // and the same board and Inspector after it, on BaseAPI's ids
  await check(id);
});

test('a shared step\'s entry condition and name, edited once: every workflow\'s wires into it change, the Save count grows by one, all three are dry-run', async ({ page }) => {
  test.setTimeout(test.info().timeout * 3);
  await openAt(page, { x: -40, y: -60 }, 0.7);
  const id = remap(...await (async () => { const b = await buildShared(page, { payloads: false }); const a = await save(page); return [b, a.made] as const; })());
  await expect(saveButton(page)).toBeDisabled();
  const into = [wireEdge(page, id.s, id.t), wireEdge(page, id.u, id.t)];
  for (const w of into) await expect(w.locator('.link-wire')).toHaveAttribute('data-condition', 'Completed');

  await setCondition(page, id.t, 'Failed');
  await field(page, 'Name').fill(`${N.t}-renamed`);
  await field(page, 'Description').fill('edited once, shared by three');
  expect(await unsavedCount(page), 'one row changed').toBe(1);
  // both wires into it, the one from W1/W2's stream and the one from W3's, follow the step's condition (wires draw none of
  // their own [user, 2026-11-25]: the step's pill shows it; the wire names it in data-condition)
  await expect(stNode(page, id.t).locator('.cond-pill')).toHaveText('F');
  for (const w of into) {
    await expect(w.locator('.link-wire')).toHaveAttribute('data-condition', 'Failed');
    // the wire wears the condition's colour (Failed's red), the same on every wire into it
    expect(await w.locator('path.wire').evaluate((p) => getComputedStyle(p).stroke)).toBe('rgb(224, 72, 47)');
  }
  await expect(wireEdge(page, id.s, id.u).locator('.link-wire')).toHaveAttribute('data-condition', 'Completed');
  await expect(stNode(page, id.t).locator('.unsaved-mark')).toBeVisible();
  for (const s of [id.s, id.u]) await expect(stNode(page, s).locator('.unsaved-mark')).toHaveCount(0);
  for (const w of [id.w1, id.w2, id.w3]) await expect(wfNode(page, w).locator('.unsaved-mark')).toHaveCount(0);
  // the step is the same one in every workflow's Inspector
  for (const w of [id.w1, id.w2, id.w3]) {
    await selectWorkflowAlone(page, w);
    await pickStep(page, id.t);
    await expect(field(page, 'Name')).toHaveValue(`${N.t}-renamed`);
    await expect(field(page, /^Entry condition/)).toHaveAttribute('data-value', '2');
  }

  const answer = await save(page);
  expect(answer.applied).toBe(true);
  await expect(outLine(page, 'Pushed 1 change')).toHaveCount(1);
  const t = await rowNamed('steps', `${N.t}-renamed`);
  expect(t.id).toBe(id.t);
  expect(t.entryCondition).toBe(2);
  expect(t.description).toBe('edited once, shared by three');
  // every workflow reaching it is affected: dry-run and republished; nothing else of theirs changed
  for (const [w, name] of [[id.w1, N.w1], [id.w2, N.w2], [id.w3, N.w3]] as const) {
    await expectSaveChecksNothing(page, w, name);
    await expectPublished(page, name);
  }
});

test('deleting a shared step takes its wires, entry arrows and every workflow\'s payload in one undo step; Undo, Redo, ghosts, Restore; the saved delete', async ({ page }) => {
  test.setTimeout(test.info().timeout * 3);
  await openAt(page, { x: -40, y: -60 }, 0.7);
  const built = await buildShared(page, { extraEntries: true });
  const id = remap(built, (await save(page)).made);
  await expect(saveButton(page)).toBeDisabled();
  const asgOn = async (step: string) => (await getJson<Row[]>('/assignments')).filter((a) => a.stepId === step);
  expect(await asgOn(id.s)).toHaveLength(2);
  const before = await boardSnapshot(page);

  await clickEmptyBoard(page);
  await pickStep(page, id.s);
  await toolbar(page, 'step').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(stNode(page, id.s)).toHaveCount(0);
  for (const [f, t] of [[id.s, id.u], [id.s, id.t]]) await expect(wireEdge(page, f!, t!)).toHaveCount(0);
  for (const w of [id.w1, id.w2]) await expect(entryEdge(page, w, id.s)).toHaveCount(0);
  await expect(wireEdge(page, id.u, id.t)).toHaveCount(1);
  await expect(entryEdge(page, id.w1, id.t)).toHaveCount(1);
  for (const w of [id.w1, id.w2]) {
    await selectWorkflowAlone(page, w);
    await expect(inspector(page), 'its payload on the step went with it').toContainText('No assignments.');
  }
  await clickEmptyBoard(page);
  const deleted = await boardSnapshot(page);
  // ghosts: the step, its two wires out and the two entry arrows into it
  await expect(ghost(page, N.s)).toHaveCount(1);
  for (const g of [`ghost:wire:${id.s}:${id.u}`, `ghost:wire:${id.s}:${id.t}`]) await expect(page.locator(`.react-flow__edge.ghost[data-id="${g}"]`)).toHaveCount(1);
  await expect(page.locator(`.react-flow__edge.ghost[data-id^="ghost:entry:"]`)).toHaveCount(2);

  // one undo step brings all of it back; one redo removes all of it again
  await inspector(page).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(stNode(page, id.s)).toBeVisible();
  expect(await boardSnapshot(page), 'Undo restores the board exactly').toEqual(before);
  await expect(ghost(page, N.s)).toHaveCount(0);
  await selectWorkflowAlone(page, id.w2);
  await pickStep(page, id.s);
  await expect(await payloadOf(page, N.w2)).toHaveValue(pretty(PAY.w2));
  await clickEmptyBoard(page);
  await inspector(page).getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(stNode(page, id.s)).toHaveCount(0);
  expect(await boardSnapshot(page), 'Redo removes it again').toEqual(deleted);
  await expect(ghost(page, N.s)).toHaveCount(1);

  // Restore from the ghost's toolbar: the stored row back, unchanged, with its wires out (both ends are on the board)
  await ghost(page, N.s).locator('.sn').click();
  await expect(tabLabels(page)).toHaveText(['Deleted']);
  await toolbar(page, 'ghost').getByRole('button', { name: 'Restore' }).click();
  await expect(stNode(page, id.s)).toBeVisible();
  await expect(ghost(page, N.s)).toHaveCount(0);
  await expect(stNode(page, id.s).locator('.unsaved-mark')).toHaveCount(0);
  await expect(wireEdge(page, id.s, id.u)).toHaveCount(1);
  await expect(wireEdge(page, id.s, id.t)).toHaveCount(1);
  // the entry arrows are the workflows' own links: still ghosts, each restorable now that both ends exist
  for (const w of [id.w1, id.w2]) {
    const g = page.locator(`.react-flow__edge.ghost[data-id="ghost:entry:${w}:${id.s}"]`);
    await expect(g).toHaveCount(1);
  }

  // delete it again and Save: BaseAPI drops the step and both payload rows, and the workflows keep their other entries
  await clickEmptyBoard(page);
  await pickStep(page, id.s);
  await toolbar(page, 'step').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(stNode(page, id.s)).toHaveCount(0);
  const answer = await save(page);
  expect(answer.applied).toBe(true);
  await expect(saveButton(page)).toBeDisabled();
  expect((await getJson<Row[]>('/steps')).some((r) => r.id === id.s), 'the step row is gone').toBe(false);
  expect(await asgOn(id.s), 'every workflow\'s payload on it is gone').toEqual([]);
  expect((await getJson<Row>(`/workflows/${id.w1}`)).entryStepIds).toEqual([id.t]);
  expect((await getJson<Row>(`/workflows/${id.w2}`)).entryStepIds).toEqual([id.u]);
  expect((await getJson<Row>(`/workflows/${id.w1}`)).assignmentIds).toEqual([]);
  expect((await rowsNamed('steps', P)).map((r) => r.name).sort()).toEqual([N.o, N.t, N.u].sort());
  for (const [w, name] of [[id.w1, N.w1], [id.w2, N.w2], [id.w3, N.w3]] as const) await expectSaveChecksNothing(page, w, name);
});

test('deleting a cache linked to three workflows takes all three cache lines in one undo step; the saved delete unlinks it everywhere', async ({ page }) => {
  test.setTimeout(test.info().timeout * 3);
  await openAt(page, { x: -40, y: -60 }, 0.7);
  const id = remap(...await (async () => { const b = await buildShared(page, { payloads: false }); const a = await save(page); return [b, a.made] as const; })());
  const before = await boardSnapshot(page);
  await clickEmptyBoard(page);
  await pickCache(page, id.c1);
  await toolbar(page, 'cache').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(caNode(page, id.c1)).toHaveCount(0);
  for (const w of [id.w1, id.w2, id.w3]) await expect(cacheEdge(page, w, id.c1)).toHaveCount(0);
  await expect(cacheEdge(page, id.w1, id.c2)).toHaveCount(1);
  expect(await unsavedCount(page), 'the cache and the three workflows that linked it').toBe(4);
  await inspector(page).getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await boardSnapshot(page)).toEqual(before);
  await inspector(page).getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(caNode(page, id.c1)).toHaveCount(0);

  const answer = await save(page);
  expect(answer.applied).toBe(true);
  expect((await getJson<Row[]>('/caches')).some((c) => c.id === id.c1)).toBe(false);
  expect((await getJson<Row>(`/workflows/${id.w1}`)).cacheIds).toEqual([id.c2]);
  expect((await getJson<Row>(`/workflows/${id.w2}`)).cacheIds).toEqual([]);
  expect((await getJson<Row>(`/workflows/${id.w3}`)).cacheIds).toEqual([]);
  // the orphan cache is still there
  await rowNamed('caches', N.c3);
});

test('copy and paste of a branch of shared steps: new steps, the wires among them, no payloads; saved as new rows', async ({ page }) => {
  test.setTimeout(test.info().timeout * 3);
  await openAt(page, { x: -40, y: -60 }, 0.7);
  const id = remap(...await (async () => { const b = await buildShared(page); const a = await save(page); return [b, a.made] as const; })());
  const steps0 = await page.locator('.react-flow__node-step:not(.ghost)').count();

  await clickEmptyBoard(page);
  await pickStep(page, id.s);
  await pickStep(page, id.u, true);
  await pickStep(page, id.t, true);
  await selbar(page).getByRole('button', { name: 'Copy' }).click();
  await expect(outLine(page, 'Copied 3 steps and 3 wires')).toHaveCount(1);
  await page.keyboard.press('Control+v');
  await expect(outLine(page, 'Pasted 3 steps')).toHaveCount(1);
  await expect(page.locator('.react-flow__node-step:not(.ghost)')).toHaveCount(steps0 + 3);
  const copies = page.locator('.react-flow__node-step:not(.ghost)').filter({ has: page.locator('.sn', { hasText: /^e2e-s-.*-2$/ }) });
  await expect(copies).toHaveCount(3);
  expect((await copies.locator('.sn').allInnerTexts()).sort()).toEqual([`${N.s}-2`, `${N.u}-2`, `${N.t}-2`].sort());
  const copyIds = await copies.evaluateAll((ns) => ns.map((n) => (n as HTMLElement).dataset.id!.replace(/^st:/, '')));
  const byName = async (n: string) => (await copies.filter({ has: page.locator('.sn', { hasText: new RegExp(`^${n}-2$`) }) }).getAttribute('data-id'))!.replace(/^st:/, '');
  const [cs, cu, ct] = [await byName(N.s), await byName(N.u), await byName(N.t)];
  await expect(wireEdge(page, cs, cu)).toHaveCount(1);
  await expect(wireEdge(page, cs, ct)).toHaveCount(1);
  await expect(wireEdge(page, cu, ct)).toHaveCount(1);
  // no workflow reaches a copy, so no payload, no assignment tab
  for (const c of copyIds) {
    await clickEmptyBoard(page);
    await pickStep(page, c);
    await expect(usedBy(page)).toHaveText('no workflow');
    await expect(tabLabels(page)).toHaveText(['Step', 'Processor']);
    await expect(stNode(page, c).locator('.key-chip')).toHaveCount(0);
  }
  // the originals keep their payloads
  await selectWorkflowAlone(page, id.w1);
  await pickStep(page, id.s);
  await expect(await payloadOf(page, N.w1)).toHaveValue(pretty(PAY.w1));

  const answer = await save(page);
  expect(answer.applied).toBe(true);
  const made = await Promise.all([N.s, N.u, N.t].map((n) => rowNamed('steps', `${n}-2`)));
  const [ms, mu, mt] = made;
  expect([...(ms!.nextStepIds as string[])].sort()).toEqual([mu!.id, mt!.id].sort());
  expect(mu!.nextStepIds).toEqual([mt!.id]);
  const asg = await getJson<Row[]>('/assignments');
  expect(asg.filter((a) => made.some((m) => m.id === a.stepId)), 'no payload was copied').toEqual([]);
  // the originals are untouched
  expect([...((await rowNamed('steps', N.s)).nextStepIds as string[])].sort()).toEqual([id.u, id.t].sort());
  expect(asg.filter((a) => a.stepId === id.s)).toHaveLength(2);
});
