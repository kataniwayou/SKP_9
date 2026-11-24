import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import {
  COLLAPSER, EXPANDER, NORMALIZER, PERSISTER, VALID_PAYLOAD, caNode, clickEmptyBoard, entry, expectSaveChecksNothing, field, ghost,
  link, newCache, newStep, newWorkflow, openAt, outLine, pickCache, pickEdge, pickStep, save, saveButton, selectWorkflowAlone, stNode,
  toolbar, typePayload, unsavedCount, validateStored, waitLoaded, wfNode, wire, wireEdge,
} from '../helpers';
import { API, apply, bodyOf, getJson, type Row } from '../stack';

// One designer's session through the four rule groups of 2026-11-23 (spec revision 2), combined the way practical work meets
// them — not one rule per test:
//   1. design options are a draft: kept in the browser on every edit, nothing checked; every delete a ghost; a reload brings it back;
//   2. Save is BaseAPI's row rules, all or nothing (/model/apply): a refused row saves nothing, "changed elsewhere" offers Take stored;
//      a cycle, a schema-edge mismatch, a payload off its schema and a missing payload all save (free style);
//   3. Start is the orchestration rules: refused with every problem in Output and a count on the triangle; fixed, it runs;
//   4. the workflow's state meets the design: never saved → no Start; running → no Delete, but edits and Saves are allowed, and
//      Start runs the stored version whatever is unsaved.
// Live only (ACTO_E2E_LIVE=1): it really starts and stops its own e2e workflow (cron unset, so nothing is scheduled).

// a stuck click fails within a minute instead of waiting out the whole (long) test
test.use({ actionTimeout: 60_000 });

test.skip(process.env.ACTO_E2E_LIVE !== '1', 'the live run: set ACTO_E2E_LIVE=1');

const N = 'e2e-prac';
const ROOT = 'e2e-prac-root';
const draft = (page: Page) => page.evaluate(() => localStorage.getItem('acto.board'));
const stopFor = async (id: string) => { await fetch(`${API}/orchestration/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(id) }); };
const stored = async () => (await getJson<Row[]>('/workflows')).filter((w) => w.name.startsWith(N));
async function changeElsewhere(table: 'steps', id: string, patch: Record<string, unknown>) {
  const row = await getJson<Row>(`/${table}/${id}`);
  const r = await apply([{ op: 'update', table, id, row: { ...bodyOf(row), ...patch }, updatedAt: row.updatedAt as string }]);
  expect(r.applied, 'the other writer saved').toBe(true);
}

test('practical session: draft, Save by BaseAPI rows, Start by orchestration rules, and the workflow state meeting the design', async ({ page }) => {
  test.setTimeout(test.info().timeout * 8);
  let saved: string | null = null;
  try {
    await openAt(page, { x: -40, y: -60 }, 0.7);

    // ---- 1. design options as a draft --------------------------------------------------------------------------------------
    // expander → normalizer → collapser, collapser → expander (a cycle), normalizer → persister (archive-document into a
    // file-envelope input: a schema-edge mismatch); expander's payload is off its schema (maxDepth ≥ 1), the normalizer has none
    // (its schema requires a handler); two caches with one root (BaseAPI refuses the second)
    const wf = await newWorkflow(page, { x: 0, y: 140 }, N);
    const ex = await newStep(page, EXPANDER, { x: 220, y: 140 }, `${N}-expand`);
    const no = await newStep(page, NORMALIZER, { x: 500, y: 40 }, `${N}-norm`);
    const co = await newStep(page, COLLAPSER, { x: 780, y: 140 }, `${N}-collapse`);
    const pe = await newStep(page, PERSISTER, { x: 780, y: -40 }, `${N}-persist`);
    const k1 = await newCache(page, { x: 0, y: 380 }, `${N}-cache`, ROOT);
    const k2 = await newCache(page, { x: 260, y: 380 }, `${N}-cache-2`, ROOT);
    await wire(page, ex, no); await wire(page, no, co); await wire(page, co, ex); await wire(page, no, pe);
    await entry(page, wf, ex);
    await link(page, wf, k1); await link(page, wf, k2);
    await typePayload(page, wf, N, ex, '{"maxDepth": 0}');
    await typePayload(page, wf, N, co, VALID_PAYLOAD[COLLAPSER]!);
    await typePayload(page, wf, N, pe, VALID_PAYLOAD[PERSISTER]!);
    await clickEmptyBoard(page);
    expect(await draft(page), 'every edit is written to the draft').toContain(`${N}-persist`);
    expect(await stored(), 'nothing reached BaseAPI').toEqual([]);

    // state rule: never saved, so no Start
    await selectWorkflowAlone(page, wf);
    await expect(toolbar(page, 'workflow').getByRole('button', { name: '▶ Start' })).toBeDisabled();

    // a delete is a ghost, kept across a reload with the rest of the unsaved draft; Restore brings the step back with its wire
    await clickEmptyBoard(page);
    await pickStep(page, pe);
    await toolbar(page, 'step').getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(ghost(page, `${N}-persist`)).toHaveCount(1);
    const count = await unsavedCount(page);
    await page.reload();
    await waitLoaded(page);
    await expect(wfNode(page, wf).locator('.tri-nm')).toHaveText(N);
    await expect(ghost(page, `${N}-persist`), 'the ghost belongs to the draft').toHaveCount(1);
    expect(await unsavedCount(page), 'the same unsaved count after the reload').toBe(count);
    expect(await stored()).toEqual([]);
    await ghost(page, `${N}-persist`).locator('.sn').click();
    await toolbar(page, 'ghost').getByRole('button', { name: 'Restore' }).click();
    await expect(stNode(page, pe)).toBeVisible();
    // restoring the step restores its ghost wire too, the one INTO it included [user, 2026-11-24]
    await expect(wireEdge(page, no, pe)).toHaveCount(1);
    await expect(page.locator(`.react-flow__edge.ghost[data-id="ghost:wire:${no}:${pe}"]`)).toHaveCount(0);

    // ---- 2. Save: BaseAPI's row rules, all or nothing ----------------------------------------------------------------------
    const refused = await save(page);
    expect(refused.applied, 'one row refused: the whole push refused').not.toBe(true);
    await expect(outLine(page, `cache ${N}-cache-2: Unique constraint violation: root already exists.`)).toHaveCount(1);
    expect(await stored(), 'all or nothing: no row of the push was kept').toEqual([]);
    expect((await getJson<Row[]>('/caches')).filter((c) => c.name.startsWith(N))).toEqual([]);
    // the designer fixes the row (a delete: a ghost), and the free-style design saves as drawn
    await clickEmptyBoard(page);
    await pickCache(page, k2);
    await toolbar(page, 'cache').getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(ghost(page, `${N}-cache-2`)).toHaveCount(1);
    const first = await save(page);
    expect(first.applied, 'a cycle, a schema edge, a bad and a missing payload: all save').toBe(true);
    saved = first.made![wf]!;
    const id = (x: string) => first.made?.[x] ?? x;
    await expect(outLine(page, /^Pushed \d+ changes?$/)).toHaveCount(1);
    await expect(ghost(page, `${N}-cache-2`), 'the ghost stays after the push').toHaveCount(1);
    const problems = (await expectSaveChecksNothing(page, saved, N)).filter((p) => p.gate !== 'processorLiveness');
    expect(new Set(problems.map((p) => p.gate)), 'what Start will refuse').toEqual(new Set(['cycle', 'schemaEdge', 'payloadConfigSchema', 'missingPayload']));

    // ---- 3. Start: the orchestration rules ---------------------------------------------------------------------------------
    await expect(wfNode(page, saved).locator('.tri-st[data-status="stopped"]')).toBeVisible({ timeout: 20_000 });
    await selectWorkflowAlone(page, saved);
    await toolbar(page, 'workflow').getByRole('button', { name: '▶ Start' }).click();
    await expect(outLine(page, new RegExp(`^${N}: Start refused — `))).toHaveCount(1);
    const all = (await validateStored(saved)).problems;
    const listed = outLine(page, new RegExp(`^${N}: (?!Start refused).+ — `));
    await expect(listed, 'every problem listed in Output').toHaveCount(all.length);
    await expect(wfNode(page, saved).locator('.tri-problems')).toHaveText(String(all.length));
    expect((await stored()).map((w) => w.name), 'a refused Start changes nothing stored').toEqual([N]);

    // meanwhile another designer saves the collapser: my edit of it is refused as "changed elsewhere" and nothing else goes
    await changeElsewhere('steps', id(co), { description: 'changed elsewhere' });
    await clickEmptyBoard(page);
    await pickStep(page, id(co));
    await field(page, 'Description').fill('my edit');
    await clickEmptyBoard(page);
    await expect(wfNode(page, saved).locator('.tri-problems'), 'an edit of the workflow clears its count').toHaveCount(0);
    const stale = await save(page);
    expect(stale.applied).not.toBe(true);
    await expect(outLine(page, `${N}-collapse changed elsewhere — Take stored drops your change to it`)).toHaveCount(1);
    await page.locator('button.take-stored').click();
    await expect(outLine(page, /^Took the stored /)).toHaveCount(1);
    await expect(saveButton(page)).toBeDisabled();

    // the fixes: the cycle's wire and the persister go (ghosts), both payloads right; it saves, and only liveness may remain
    await clickEmptyBoard(page);
    await pickEdge(page, wireEdge(page, id(co), id(ex)));
    await toolbar(page, 'wire').getByRole('button', { name: 'Delete' }).click();
    await clickEmptyBoard(page);
    await pickStep(page, id(pe));
    await toolbar(page, 'step').getByRole('button', { name: 'Delete', exact: true }).click();
    await typePayload(page, saved, N, id(ex), VALID_PAYLOAD[EXPANDER]!);
    await typePayload(page, saved, N, id(no), '{"handler": "Sample"}');
    await clickEmptyBoard(page);
    expect((await save(page)).applied).toBe(true);
    expect((await validateStored(saved)).problems.filter((p) => p.gate !== 'processorLiveness')).toEqual([]);
    expect((await getJson<Row[]>('/steps')).some((s) => s.name === `${N}-persist`), 'the ghosted step was pushed as a delete').toBe(false);

    // ---- 4. the workflow's state meets the design ------------------------------------------------------------------------
    // an unsaved edit does not block Start: the stored version runs
    await selectWorkflowAlone(page, saved);
    await field(page, 'Description').fill('unsaved while starting');
    await toolbar(page, 'workflow').getByRole('button', { name: '▶ Start' }).click();
    await expect(outLine(page, `${N}: Start requested`)).toHaveCount(1);
    await expect(wfNode(page, saved).locator('.tri-st[data-status="running"]')).toBeVisible({ timeout: 30_000 });
    expect((await getJson<Row>(`/workflows/${saved}`)).description ?? '', 'Start pushed nothing').not.toBe('unsaved while starting');
    expect(await unsavedCount(page)).toBeGreaterThan(0);
    // running: Delete deletes nothing; the edit saves
    await selectWorkflowAlone(page, saved);
    await toolbar(page, 'workflow').getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(outLine(page, `${N} is running — stop it first`)).toHaveCount(1);
    await expect(wfNode(page, saved)).toBeVisible();
    expect((await save(page)).applied).toBe(true);
    expect((await getJson<Row>(`/workflows/${saved}`)).description).toBe('unsaved while starting');
    await expect(wfNode(page, saved).locator('.tri-st[data-status="running"]')).toBeVisible();

    // Stop, then the delete: a ghost, pushed by Save; the cache it alone linked goes with it
    await selectWorkflowAlone(page, saved);
    await toolbar(page, 'workflow').getByRole('button', { name: '■ Stop' }).click();
    await expect(outLine(page, `${N}: Stop requested`)).toHaveCount(1);
    await expect(wfNode(page, saved).locator('.tri-st[data-status="stopped"]')).toBeVisible({ timeout: 30_000 });
    await toolbar(page, 'workflow').getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(ghost(page, N)).toHaveCount(1);
    expect((await save(page)).applied).toBe(true);
    expect((await getJson<Row[]>('/workflows')).some((w) => w.id === saved)).toBe(false);
    await expect(caNode(page, id(k1)), 'the cache stays: a delete of a workflow keeps its caches and steps').toBeVisible();
    saved = null;
  } finally {
    if (saved) {
      await stopFor(saved);
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }
});
