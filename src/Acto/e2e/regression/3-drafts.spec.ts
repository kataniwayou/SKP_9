import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import {
  COLLAPSER, NORMALIZER, VALID_PAYLOAD, boardSnapshot, caNode, clickEmptyBoard, dragBy, dropTool, regionPoint, toolboxStep, cacheTool, pickCache, payloadOf, entry, entryEdge, field, ghost, inspector, newCache,
  newStep, newWorkflow, openAt, out, outLine, pickEdge, pickStep, rowNamed, rowsNamed, save, saveButton, selectWorkflowAlone, setCondition,
  stNode, toolbar, typePayload, unsavedCount, waitLoaded, wfNode, wire, wireEdge,
} from '../helpers';
import { apply, bodyOf, getJson, type Row } from '../stack';

// Regression 3 (brief: "verify saving drafts"): the unsaved board as a session draft across a reload, the draft replayed over changes
// made elsewhere, the "changed elsewhere" refusal and Take stored, a long Undo/Redo session, and a refused Save that saves nothing.
// Everything is built through the UI; the API is used only to read BaseAPI back and to make the "changed elsewhere" edits.

const P = 'e2e-d-';
const draft = (page: Page) => page.evaluate(() => sessionStorage.getItem('acto.board'));
const undoBtn = (page: Page) => inspector(page).getByRole('button', { name: 'Undo', exact: true });
const redoBtn = (page: Page) => inspector(page).getByRole('button', { name: 'Redo', exact: true });

/** A small saved board through the UI: W1 -> S1 -> S2 and W2 -> S3; answers BaseAPI's ids. */
async function savedBase(page: Page) {
  const c: Record<string, string> = {};
  c.w1 = await newWorkflow(page, { x: 0, y: 40 }, `${P}w1`);
  c.w2 = await newWorkflow(page, { x: 0, y: 300 }, `${P}w2`);
  c.s1 = await newStep(page, NORMALIZER, { x: 260, y: 40 }, `${P}s1`);
  c.s2 = await newStep(page, COLLAPSER, { x: 560, y: 40 }, `${P}s2`);
  c.s3 = await newStep(page, NORMALIZER, { x: 260, y: 300 }, `${P}s3`);
  await wire(page, c.s1, c.s2);
  await entry(page, c.w1, c.s1);
  await entry(page, c.w2, c.s3);
  const answer = await save(page);
  expect(answer.applied).toBe(true);
  await expect(saveButton(page)).toBeDisabled();
  return Object.fromEntries(Object.entries(c).map(([k, v]) => [k, answer.made?.[v] ?? v])) as Record<'w1' | 'w2' | 's1' | 's2' | 's3', string>;
}

/** Changes a stored row through BaseAPI directly (someone else's edit), checked against its stamp. */
async function changeElsewhere(table: 'workflows' | 'steps', id: string, patch: Record<string, unknown>) {
  const row = await getJson<Row>(`/${table}/${id}`);
  await apply([{ op: 'update', table, id, row: { ...bodyOf(row), ...patch }, updatedAt: row.updatedAt as string }]);
}

test('unsaved edits carry their marks and the Save count; a reload brings the same unsaved board, marks and count back, and no ghost', async ({ page }) => {
  await openAt(page);
  expect(await draft(page), 'a fresh browser: no draft').toBeNull();
  const id = await savedBase(page);
  expect(await draft(page), 'a clean board keeps no draft').toBeNull();

  // edits of every kind: a rename, a new step with a wire to it, a deleted step (a ghost), a moved triangle, a payload
  await clickEmptyBoard(page);
  await pickStep(page, id.s1);
  await field(page, 'Name').fill(`${P}s1-renamed`);
  const s4 = await newStep(page, COLLAPSER, { x: 560, y: 300 }, `${P}s4-new`);
  await wire(page, id.s3, s4);
  await clickEmptyBoard(page);
  await pickStep(page, id.s2);
  await toolbar(page, 'step').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(ghost(page, `${P}s2`)).toHaveCount(1);
  await dragBy(page, wfNode(page, id.w2).locator('.tri-shape'), 0, 60);
  await typePayload(page, id.w1, `${P}w1`, id.s1, VALID_PAYLOAD[NORMALIZER]!);
  await clickEmptyBoard(page);

  // marks: on each changed item, none on the untouched one; the count is the rows changed
  for (const l of [stNode(page, id.s1), stNode(page, s4), stNode(page, id.s3), wfNode(page, id.w1), wfNode(page, id.w2)]) await expect(l.locator('.unsaved-mark')).toBeVisible();
  // s1 (renamed, and its wire to s2 goes), s2 (deleted), s3 (wire out), s4 (new), w1 (payload), w2 (moved), w1's new assignment
  expect(await unsavedCount(page)).toBe(7);
  expect(await draft(page), 'the unsaved board is kept as the session draft').not.toBeNull();
  const before = await boardSnapshot(page);

  await page.reload();
  await waitLoaded(page);
  await clickEmptyBoard(page);
  expect(await boardSnapshot(page), 'the same unsaved board after the reload').toEqual(before);
  await expect(page.locator('.react-flow__node.ghost, .react-flow__edge.ghost'), 'ghosts are not kept across a reload').toHaveCount(0);
  await expect(saveButton(page)).toHaveText('Save · 7');
  // and BaseAPI has none of it yet
  expect((await rowsNamed('steps', P)).map((s) => s.name).sort()).toEqual([`${P}s1`, `${P}s2`, `${P}s3`]);
  await selectWorkflowAlone(page, id.w1);
  await pickStep(page, id.s1);
  await expect(await payloadOf(page, `${P}w1`)).toHaveValue(JSON.stringify(JSON.parse(VALID_PAYLOAD[NORMALIZER]!), null, 2));

  // the draft saves as it is
  const answer = await save(page);
  expect(answer.applied).toBe(true);
  expect((await rowsNamed('steps', P)).map((s) => s.name).sort()).toEqual([`${P}s1-renamed`, `${P}s3`, `${P}s4-new`]);
  expect(await draft(page)).toBeNull();
});

test('a draft replays over changes made elsewhere: my edits are kept, the other rows show what was saved elsewhere', async ({ page }) => {
  await openAt(page);
  const id = await savedBase(page);
  await clickEmptyBoard(page);
  await pickStep(page, id.s1);
  await field(page, 'Name').fill(`${P}s1-mine`);
  await selectWorkflowAlone(page, id.w1);
  await field(page, 'Description').fill('my unsaved description');
  expect(await unsavedCount(page)).toBe(2);

  // elsewhere: W2 and S3 (rows I did not touch) are changed and saved
  await changeElsewhere('workflows', id.w2, { description: 'saved elsewhere' });
  await changeElsewhere('steps', id.s3, { name: `${P}s3-elsewhere`, entryCondition: 4 });

  await page.reload();
  await waitLoaded(page);
  await expect(stNode(page, id.s1).locator('.sn')).toHaveText(`${P}s1-mine`);
  await expect(stNode(page, id.s1).locator('.unsaved-mark')).toBeVisible();
  await expect(stNode(page, id.s3).locator('.sn')).toHaveText(`${P}s3-elsewhere`);
  await expect(stNode(page, id.s3).locator('.cond-pill')).toHaveText('A');
  await expect(stNode(page, id.s3).locator('.unsaved-mark')).toHaveCount(0);
  await expect(wfNode(page, id.w2).locator('.unsaved-mark')).toHaveCount(0);
  await selectWorkflowAlone(page, id.w2);
  await expect(field(page, 'Description')).toHaveValue('saved elsewhere');
  await selectWorkflowAlone(page, id.w1);
  await expect(field(page, 'Description')).toHaveValue('my unsaved description');
  expect(await unsavedCount(page)).toBe(2);

  // Save sends only my two rows: the changes made elsewhere stay as they were saved
  const answer = await save(page);
  expect(answer.applied).toBe(true);
  await expect(outLine(page, 'Saved 2 changes')).toHaveCount(1);
  expect((await getJson<Row>(`/steps/${id.s1}`)).name).toBe(`${P}s1-mine`);
  expect((await getJson<Row>(`/workflows/${id.w1}`)).description).toBe('my unsaved description');
  expect((await getJson<Row>(`/workflows/${id.w2}`)).description).toBe('saved elsewhere');
  const s3 = await getJson<Row>(`/steps/${id.s3}`);
  expect([s3.name, s3.entryCondition]).toEqual([`${P}s3-elsewhere`, 4]);
});

test('a row changed elsewhere refuses the Save ("changed elsewhere", Take stored · 1); Take stored takes that row only, and the next Save passes', async ({ page }) => {
  await openAt(page);
  const id = await savedBase(page);
  await clickEmptyBoard(page);
  await pickStep(page, id.s1);
  await field(page, 'Name').fill(`${P}s1-mine`);
  await clickEmptyBoard(page);
  await pickStep(page, id.s3);
  await field(page, 'Description').fill('my edit of s3');
  await clickEmptyBoard(page);
  expect(await unsavedCount(page)).toBe(2);
  const s3Before = await getJson<Row>(`/steps/${id.s3}`);

  await changeElsewhere('steps', id.s1, { description: 'changed elsewhere', entryCondition: 2 });
  const answer = await save(page);
  expect(answer.applied, 'refused').toBe(false);
  await expect(outLine(page, `${P}s1-mine changed elsewhere — Take stored drops your change to it`)).toHaveCount(1);
  const take = page.locator('button.take-stored');
  await expect(take).toHaveText('Take stored · 1');
  // nothing was saved: s3 is as it was, s1 is the other writer's
  expect((await getJson<Row>(`/steps/${id.s3}`)).updatedAt).toBe(s3Before.updatedAt);
  expect((await getJson<Row>(`/steps/${id.s1}`)).name).toBe(`${P}s1`);
  await expect(saveButton(page)).toHaveText('Save · 2');

  await take.click();
  await expect(take).toHaveCount(0);
  await expect(outLine(page, /^Took the stored /)).toHaveCount(1);
  // s1 is the stored version now (its name back, the other writer's condition); my edit of s3 is still there, unsaved
  await expect(stNode(page, id.s1).locator('.sn')).toHaveText(`${P}s1`);
  await expect(stNode(page, id.s1).locator('.cond-pill')).toHaveText('F');
  await expect(stNode(page, id.s1).locator('.unsaved-mark')).toHaveCount(0);
  await expect(stNode(page, id.s3).locator('.unsaved-mark')).toBeVisible();
  await expect(saveButton(page)).toHaveText('Save · 1');

  const again = await save(page);
  expect(again.applied).toBe(true);
  expect((await getJson<Row>(`/steps/${id.s3}`)).description).toBe('my edit of s3');
  const s1 = await getJson<Row>(`/steps/${id.s1}`);
  expect([s1.name, s1.description, s1.entryCondition]).toEqual([`${P}s1`, 'changed elsewhere', 2]);
  await expect(saveButton(page)).toBeDisabled();
});

test('a long edit session undoes and redoes exactly, step by step; with everything undone there is nothing to save', async ({ page }) => {
  test.setTimeout(test.info().timeout * 2);
  await openAt(page);
  const id = await savedBase(page);
  await clickEmptyBoard(page);
  const snaps = [await boardSnapshot(page)];
  /** One board edit, then the board as it is after it (nothing picked, so no key chip depends on the selection). */
  const step = async (edit: () => Promise<void>) => {
    await edit();
    await clickEmptyBoard(page);
    const s = await boardSnapshot(page);
    expect(s, 'each edit changes the board').not.toEqual(snaps[snaps.length - 1]);
    snaps.push(s);
  };
  let s4 = '';
  await step(async () => { s4 = await dropTool(page, toolboxStep(page, NORMALIZER), 'step', await regionPoint(page, { x: 560, y: 300 })); });
  await step(async () => { await pickStep(page, s4); await field(page, 'Name').fill(`${P}s4`); });
  await step(() => wire(page, id.s2, s4));
  await step(() => entry(page, id.w2, s4));
  await step(() => setCondition(page, s4, 'Never'));
  await step(() => setCondition(page, id.s2, 'Always'));
  await step(() => typePayload(page, id.w1, `${P}w1`, id.s2, VALID_PAYLOAD[COLLAPSER]!));
  await step(() => dragBy(page, stNode(page, id.s3), 0, 70));
  await step(async () => { await pickEdge(page, wireEdge(page, id.s1, id.s2)); await toolbar(page, 'wire').getByRole('button', { name: 'Delete' }).click(); });
  await step(async () => { await selectWorkflowAlone(page, id.w2); await field(page, 'Name').fill(`${P}w2-renamed`); });
  let c1 = '';
  await step(async () => { c1 = await dropTool(page, cacheTool(page), 'cache', await regionPoint(page, { x: 260, y: 520 })); });
  await step(async () => { await pickCache(page, c1); await field(page, 'Name').fill(`${P}c1`); });
  await step(async () => { await pickStep(page, id.s1); await toolbar(page, 'step').getByRole('button', { name: 'Delete', exact: true }).click(); });
  const n = snaps.length - 1;
  expect(await unsavedCount(page)).toBeGreaterThan(0);

  // back, one step at a time, each the board as it was before that edit
  for (let i = n; i > 0; i--) {
    await undoBtn(page).click();
    await clickEmptyBoard(page);
    expect(await boardSnapshot(page), `undo ${n - i + 1} of ${n}`).toEqual(snaps[i - 1]);
  }
  await expect(undoBtn(page)).toBeDisabled();
  await expect(saveButton(page)).toHaveText('Save');
  await expect(saveButton(page)).toBeDisabled();
  // forward again, the same boards
  for (let i = 1; i <= n; i++) {
    await redoBtn(page).click();
    await clickEmptyBoard(page);
    expect(await boardSnapshot(page), `redo ${i} of ${n}`).toEqual(snaps[i]);
  }
  await expect(redoBtn(page)).toBeDisabled();
  // and all the way back: nothing to save, nothing sent
  for (let i = 0; i < n; i++) await undoBtn(page).click();
  await clickEmptyBoard(page);
  expect(await boardSnapshot(page)).toEqual(snaps[0]);
  await expect(saveButton(page)).toBeDisabled();
  expect(await draft(page), 'no draft once nothing is unsaved').toBeNull();
  expect((await rowsNamed('steps', P)).map((s) => s.name).sort()).toEqual([`${P}s1`, `${P}s2`, `${P}s3`]);
});

test('a Save BaseAPI refuses (a new workflow with no entry arrow) saves nothing at all and keeps the board unsaved; fixed, it saves', async ({ page }) => {
  await openAt(page);
  const id = await savedBase(page);
  // a stored row edited, and new rows: a triangle with no entry arrow, a step, a cache
  await clickEmptyBoard(page);
  await pickStep(page, id.s3);
  await field(page, 'Description').fill('edited in a refused save');
  const wf = await newWorkflow(page, { x: 0, y: 520 }, `${P}w-noentry`);
  const st = await newStep(page, COLLAPSER, { x: 560, y: 520 }, `${P}s-new`);
  const ca = await newCache(page, { x: 860, y: 300 }, `${P}c-new`);
  const label = await saveButton(page).innerText();
  const s3Before = await getJson<Row>(`/steps/${id.s3}`);

  const answer = await save(page);
  expect(answer.applied).toBe(false);
  const err = out(page).locator('.k-err').first();
  await expect(err).toContainText(`workflow ${P}w-noentry:`);
  await expect(err).toContainText(/entry/i);
  await expect(wfNode(page, wf).locator('.tri')).toHaveClass(/\bfailed\b/);
  // BaseAPI has none of it: no new row, the stored one untouched
  expect(await rowsNamed('workflows', `${P}w-noentry`)).toEqual([]);
  expect(await rowsNamed('steps', `${P}s-new`)).toEqual([]);
  expect(await rowsNamed('caches', `${P}c-new`)).toEqual([]);
  expect((await getJson<Row>(`/steps/${id.s3}`)).updatedAt).toBe(s3Before.updatedAt);
  // the board is still unsaved, as it was
  await expect(saveButton(page)).toHaveText(label);
  for (const l of [wfNode(page, wf), stNode(page, st), caNode(page, ca), stNode(page, id.s3)]) await expect(l.locator('.unsaved-mark')).toBeVisible();

  await entry(page, wf, st);
  await expect(entryEdge(page, wf, st)).toHaveCount(1);
  const again = await save(page);
  expect(again.applied).toBe(true);
  await expect(saveButton(page)).toBeDisabled();
  const w = await rowNamed('workflows', `${P}w-noentry`);
  const s = await rowNamed('steps', `${P}s-new`);
  expect(w.entryStepIds).toEqual([s.id]);
  await rowNamed('caches', `${P}c-new`);
  expect((await getJson<Row>(`/steps/${id.s3}`)).description).toBe('edited in a refused save');
  await expect(wfNode(page, w.id).locator('.tri')).not.toHaveClass(/\bfailed\b/);
});
