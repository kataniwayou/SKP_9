import { test, expect } from '../fixtures';
import {
  COLLAPSER, EXPANDER, NORMALIZER, VALID_PAYLOAD, clickEmptyBoard, entry, field, ghost, link, newCache, newStep, newWorkflow, openAt,
  outLine, save, selectWorkflowAlone, toolbar, typePayload, wfNode, wire, wireEdge,
} from '../helpers';
import { API, getJson, type Row } from '../stack';

// The live run (user, 2026-11-23): a complex workflow built through the UI, really started and stopped on the cluster. It runs only
// with ACTO_E2E_LIVE=1 (the guard then lets Start/Stop through for workflows this run made, never a real one). Its cron stays unset,
// so nothing is scheduled; the cleanup stops it before the e2e- rows are deleted.

test.skip(process.env.ACTO_E2E_LIVE !== '1', 'the live run: set ACTO_E2E_LIVE=1');

const N = 'e2e-live';
const stopFor = async (id: string) => { await fetch(`${API}/orchestration/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(id) }); };

test('a complex workflow built in the UI: Start rules, a real start and stop, the state rules while it runs, then its delete', async ({ page }) => {
  test.setTimeout(test.info().timeout * 6);
  let saved: string | null = null;
  try {
    await openAt(page, { x: -40, y: -60 }, 0.75);
    // a diamond: expander → (normalizer Acme, normalizer Sample) → collapser, a cache linked
    const wf = await newWorkflow(page, { x: 0, y: 120 }, N);
    const ex = await newStep(page, EXPANDER, { x: 220, y: 120 }, `${N}-expand`);
    const na = await newStep(page, NORMALIZER, { x: 500, y: 20 }, `${N}-norm-a`);
    const nb = await newStep(page, NORMALIZER, { x: 500, y: 220 }, `${N}-norm-b`);
    const co = await newStep(page, COLLAPSER, { x: 780, y: 120 }, `${N}-collapse`);
    const ca = await newCache(page, { x: 0, y: 360 }, `${N}-cache`);
    await wire(page, ex, na); await wire(page, ex, nb); await wire(page, na, co); await wire(page, nb, co);
    await entry(page, wf, ex);
    await link(page, wf, ca);
    for (const [s, p] of [[ex, VALID_PAYLOAD[EXPANDER]!], [na, VALID_PAYLOAD[NORMALIZER]!], [co, VALID_PAYLOAD[COLLAPSER]!]] as const) await typePayload(page, wf, N, s, p);
    await clickEmptyBoard(page);

    // state rule: never saved, so no Start
    await selectWorkflowAlone(page, wf);
    await expect(toolbar(page, 'workflow').getByRole('button', { name: '▶ Start' })).toBeDisabled();

    // design rule: it saves as drawn — norm-b has no payload though its schema requires a handler (free style)
    const first = await save(page);
    expect(first.applied).toBe(true);
    saved = first.made![wf]!;
    const id = (x: string) => first.made?.[x] ?? x;

    // orchestration rule: Start is refused (missing payload), every problem listed, the count on the triangle
    await expect(wfNode(page, saved).locator('.tri-st[data-status="stopped"]')).toBeVisible({ timeout: 20_000 });
    await selectWorkflowAlone(page, saved);
    await toolbar(page, 'workflow').getByRole('button', { name: '▶ Start' }).click();
    await expect(outLine(page, new RegExp(`^${N}: Start refused — `))).toHaveCount(1);
    await expect(outLine(page, new RegExp(`^${N}: Step has no payload its config schema requires — .*${N}-norm-b`))).toHaveCount(1);
    await expect(wfNode(page, saved).locator('.tri-problems')).toHaveText('1');
    expect((await getJson<Row>(`/workflows/${saved}`)).name).toBe(N);

    // fixed: the payload, saved; the edit clears the count; Start goes through and the workflow runs
    await typePayload(page, saved, N, id(nb), '{"handler": "Sample"}');
    await clickEmptyBoard(page);
    await expect(wfNode(page, saved).locator('.tri-problems')).toHaveCount(0);
    expect((await save(page)).applied).toBe(true);
    await selectWorkflowAlone(page, saved);
    await toolbar(page, 'workflow').getByRole('button', { name: '▶ Start' }).click();
    await expect(outLine(page, `${N}: Start requested`)).toHaveCount(1);
    await expect(wfNode(page, saved).locator('.tri-st[data-status="running"]')).toBeVisible({ timeout: 30_000 });
    await expect(toolbar(page, 'workflow').getByRole('button', { name: '■ Stop' })).toBeEnabled();
    await expect(wireEdge(page, id(ex), id(na)).locator('.wire')).toHaveClass(/\brunning\b/);

    // state rules while it runs: Delete (alone, or with a step) deletes nothing; an edit is allowed and saves
    await toolbar(page, 'workflow').getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(outLine(page, `${N} is running — stop it first`)).toHaveCount(1);
    await expect(wfNode(page, saved)).toBeVisible();
    // (the mixed pick with a running workflow is covered by regression/5-rules on the cluster's own running workflow)
    await selectWorkflowAlone(page, saved);
    await field(page, 'Description').fill('edited while it runs');
    expect((await save(page)).applied).toBe(true);
    expect((await getJson<Row>(`/workflows/${saved}`)).description).toBe('edited while it runs');
    await expect(wfNode(page, saved).locator('.tri-st[data-status="running"]')).toBeVisible();

    // Stop: it stops, Start comes back
    await selectWorkflowAlone(page, saved);
    await toolbar(page, 'workflow').getByRole('button', { name: '■ Stop' }).click();
    await expect(outLine(page, `${N}: Stop requested`)).toHaveCount(1);
    await expect(wfNode(page, saved).locator('.tri-st[data-status="stopped"]')).toBeVisible({ timeout: 30_000 });
    await expect(toolbar(page, 'workflow').getByRole('button', { name: '▶ Start' })).toBeEnabled();

    // stopped: Delete makes a ghost; Save pushes the delete
    await toolbar(page, 'workflow').getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(ghost(page, N)).toHaveCount(1);
    expect((await save(page)).applied).toBe(true);
    expect((await getJson<Row[]>('/workflows')).some((w) => w.id === saved)).toBe(false);
    saved = null;
  } finally {
    if (saved) {
      // never leave a running e2e workflow behind: stop it and give the stop time to land before the cleanup deletes the rows
      await stopFor(saved);
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }
});
