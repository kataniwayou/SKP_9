import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import {
  clickEmptyBoard, entry, entryEdge, inspector, marks, newStep, newWorkflow, offMark, openAt, outLine, save, selectWorkflowAlone,
  setCondition, toolbar, wfNode, wire,
} from '../helpers';
import { ENTRY_DISPATCHED, FROZEN_SKIPPED, HANDED_OFF, getJson, orchestrate, settledLogs, type LogRecord, type Row } from '../stack';

// Regression 12 (user, 2026-11-25): what the board says about an entry arrow that never fires is what the orchestrator does.
// One workflow, built in the UI, two entry steps on one cron and a third with none:
//
//            ┌─ L (*/10, Completed) ─┬▶ LC (Completed)
//    wf ─────┤                       └▶ LN (Never)          a wire into a Never step: never followed
//            ├─ Z (*/10, Never)    ──▶ ZC                   frozen: skipped on every fire of the cron it shares with L
//            └─ U (no cron)        ──▶ UC                   unscheduled: never dispatched
//
// Started from the toolbar, the orchestrator's own records in Elasticsearch must show: L dispatched on every */10 mark and
// handed off to LC only; Z skipped (the frozen record) under each of L's ticks and never dispatched; U never dispatched.
// Then Z is set to Completed and saved while running: nothing changes (L2 is the projection taken at Start) until Start is
// re-issued, after which Z is dispatched with L under one correlation id per tick. Then Stop from the toolbar: nothing more.
// Live only (ACTO_E2E_LIVE=1); every step is outcome-recorder (no schema, always Completed, no side effect but its record).

test.skip(process.env.ACTO_E2E_LIVE !== '1', 'the live run: set ACTO_E2E_LIVE=1');
test.use({ actionTimeout: 60_000 });

const N = 'e2e-idle';
const RECORDER = 'outcome-recorder';
const CRON = '*/10 * * * * *';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hhmmss = (ms: number) => new Date(ms).toISOString().slice(11, 23);
const cronIn = (page: Page, step: string) => inspector(page).getByTestId(`schedule:${step}`).getByRole('textbox', { name: 'Cron' });

test('frozen and unscheduled entries in the orchestrator\'s own records: skipped, never dispatched, unfrozen only by the next Start', async ({ page }) => {
  test.setTimeout(12 * 60_000);
  let saved: string | null = null;
  const evidence: Record<string, unknown> = {};
  try {
    await openAt(page, { x: -40, y: -40 }, 0.7);

    // ---- build in the UI --------------------------------------------------------------------------------------------------
    const id: Record<string, string> = {};
    id.wf = await newWorkflow(page, { x: 0, y: 260 }, N);
    for (const [k, at] of [['L', { x: 280, y: 60 }], ['LC', { x: 580, y: 0 }], ['LN', { x: 580, y: 140 }], ['Z', { x: 280, y: 300 }],
      ['ZC', { x: 580, y: 300 }], ['U', { x: 280, y: 480 }], ['UC', { x: 580, y: 480 }]] as const) {
      id[k] = await newStep(page, RECORDER, at, `${N}-${k}`);
    }
    for (const [f, t] of [['L', 'LC'], ['L', 'LN'], ['Z', 'ZC'], ['U', 'UC']]) await wire(page, id[f]!, id[t]!);
    for (const e of ['L', 'Z', 'U']) await entry(page, id.wf!, id[e]!);
    await setCondition(page, id.Z!, 'Never');
    await setCondition(page, id.LN!, 'Never');
    await selectWorkflowAlone(page, id.wf!);
    await cronIn(page, id.L!).fill(CRON);
    await cronIn(page, id.Z!).fill(CRON);
    await expect(cronIn(page, id.U!)).toHaveValue('');
    await clickEmptyBoard(page);

    // the board, before anything runs: Z frozen, U unscheduled
    await expect(entryEdge(page, id.wf!, id.Z!).locator('.entry-edge')).toHaveAttribute('data-idle', 'frozen');
    await expect(entryEdge(page, id.wf!, id.U!).locator('.entry-edge')).toHaveAttribute('data-idle', 'unscheduled');
    await expect(entryEdge(page, id.wf!, id.L!).locator('.entry-edge')).not.toHaveAttribute('data-idle', /.*/);

    // ---- Save ---------------------------------------------------------------------------------------------------------------
    const answer = await save(page);
    expect(answer.applied).toBe(true);
    saved = answer.made![id.wf!]!;
    const S: Record<string, string> = Object.fromEntries(['L', 'LC', 'LN', 'Z', 'ZC', 'U', 'UC'].map((k) => [k, answer.made?.[id[k]!] ?? id[k]!]));
    const name = Object.fromEntries(Object.entries(S).map(([k, v]) => [v, k]));
    evidence.workflowId = saved;
    evidence.steps = S;
    const row = await getJson<Row>(`/workflows/${saved}`);
    expect(row.entryCrons).toEqual({ [S.L!]: CRON, [S.Z!]: CRON });

    // ---- phase 1: Start from the toolbar, 35 s -----------------------------------------------------------------------------
    await expect(wfNode(page, saved).locator('.tri-st[data-status="stopped"]')).toBeVisible({ timeout: 20_000 });
    await selectWorkflowAlone(page, saved);
    await offMark();
    await toolbar(page, 'workflow').getByRole('button', { name: '▶ Start' }).click();
    const t0 = Date.now();
    await expect(outLine(page, `${N}: Start requested`)).toHaveCount(1);
    await expect(wfNode(page, saved).locator('.tri-st[data-status="running"]')).toBeVisible({ timeout: 30_000 });
    // the board while it runs: L's arrow moves, Z's and U's stand still
    await expect(entryEdge(page, saved, S.L!).locator('.entry-line')).toHaveClass(/\brunning\b/);
    for (const k of ['Z', 'U']) await expect(entryEdge(page, saved, S[k]!).locator('.entry-line'), k).not.toHaveClass(/\brunning\b/);
    await sleep(Math.max(0, t0 + 35_000 - Date.now()));

    // ---- phase 2: Z to Completed, saved while running: no effect until the next Start --------------------------------------
    await offMark();
    await setCondition(page, S.Z!, 'Completed');
    expect((await save(page)).applied).toBe(true);
    const t1 = Date.now();
    await sleep(22_000);

    // ---- phase 3: Start re-issued (the toolbar offers only Stop while running: BaseApi's start, idempotent), 25 s ----------
    await offMark();
    const restart = await orchestrate('start', saved);
    expect(restart.ok, 'the re-issued Start').toBe(true);
    const t2 = Date.now();
    await sleep(25_000);

    // ---- Stop from the toolbar, then a quiet period -------------------------------------------------------------------------
    await offMark();
    await clickEmptyBoard(page);
    await selectWorkflowAlone(page, saved);
    await toolbar(page, 'workflow').getByRole('button', { name: '■ Stop' }).click();
    const t3 = Date.now();
    await expect(wfNode(page, saved).locator('.tri-st[data-status="stopped"]')).toBeVisible({ timeout: 30_000 });
    await sleep(15_000);
    const t4 = Date.now();
    evidence.window = Object.fromEntries(Object.entries({ t0, t1, t2, t3, t4 }).map(([k, v]) => [k, new Date(v).toISOString()]));

    // ---- Elasticsearch ------------------------------------------------------------------------------------------------------
    const SLACK = 2_000;
    const all = await settledLogs({ 'attributes.WorkflowId': saved }, t0, t4, { floorMs: 15_000 });
    const of = (tpl: string) => all.filter((r) => r.attributes['{OriginalFormat}'] === tpl);
    const dispatches = of(ENTRY_DISPATCHED);
    const by = (k: string, from: number, to: number) => dispatches.filter((d) => d.attributes.StepId === S[k] && d.at > from && d.at <= to);
    const line = (d: LogRecord) => `${hhmmss(d.at)} ${name[d.attributes.StepId!] ?? d.attributes.StepId} ${d.attributes.CorrelationId}`;
    evidence.dispatches = dispatches.map(line);
    const summary = dispatches.map(line).join('; ');
    // the frozen records: matched on the step (the record is the step's, under its fire's correlation id)
    const skips = (await settledLogs({ 'attributes.StepId': S.Z! }, t0, t4, { floorMs: 0, settleOnEmpty: true }))
      .filter((r) => r.body === FROZEN_SKIPPED || r.attributes['{OriginalFormat}'] === FROZEN_SKIPPED);
    evidence.frozenSkips = skips.map((r) => `${hhmmss(r.at)} ${r.attributes.CorrelationId}`);

    // phase 1 and 2 (t0..t2): L on every mark, Z only skipped (once per L tick, same correlation id), U never
    const l12 = by('L', t0, t2 + SLACK);
    expect(Math.abs(l12.length - marks(10, t0, t2)), `L ticks before the re-start: ${summary}`).toBeLessThanOrEqual(1);
    expect(l12.length).toBeGreaterThan(0);
    expect(by('Z', t0, t2 + SLACK), `Z dispatched while frozen (the Save at ${hhmmss(t1)} must not unfreeze it): ${summary}`).toEqual([]);
    const lCorr12 = new Set(l12.map((d) => d.attributes.CorrelationId));
    const skipCorr = new Set(skips.filter((r) => r.at <= t2 + SLACK).map((r) => r.attributes.CorrelationId));
    expect(skipCorr, 'one frozen skip under each of L\'s ticks before the re-start').toEqual(lCorr12);

    // phase 3 (t2..t3): Z unfrozen, dispatched with L under one correlation id per tick; no more skips
    const l3 = by('L', t2 + SLACK, t3 + SLACK);
    const z3 = by('Z', t2 + SLACK, t3 + SLACK);
    expect(z3.length, `Z dispatched after the re-start: ${summary}`).toBeGreaterThan(0);
    expect(new Set(z3.map((d) => d.attributes.CorrelationId)), 'Z rides L\'s ticks').toEqual(new Set(l3.map((d) => d.attributes.CorrelationId)));
    expect(skips.filter((r) => r.at > t2 + SLACK), 'no frozen skip after the re-start').toEqual([]);

    // U, never; LN, never handed off; LC on every L tick finished before the stop
    expect(dispatches.filter((d) => d.attributes.StepId === S.U), `U (no cron) dispatched: ${summary}`).toEqual([]);
    const handoffs = of(HANDED_OFF);
    expect(handoffs.filter((h) => h.attributes.NextStepId === S.LN), 'LN (Never) handed off').toEqual([]);
    for (const d of by('L', t0, t3 - 5_000)) {
      expect(handoffs.some((h) => h.attributes.CorrelationId === d.attributes.CorrelationId && h.attributes.NextStepId === S.LC), `L tick ${line(d)} handed to LC`).toBe(true);
    }

    // after the stop: nothing
    expect(dispatches.filter((d) => d.at > t3 + SLACK), `dispatches after the stop at ${hhmmss(t3)}: ${summary}`).toEqual([]);

    // ---- delete through the board: the cleanup has nothing left to stop ------------------------------------------------------
    await selectWorkflowAlone(page, saved);
    await toolbar(page, 'workflow').getByRole('button', { name: 'Delete', exact: true }).click();
    expect((await save(page)).applied).toBe(true);
    saved = null;
  } finally {
    const dir = resolve(process.cwd(), 'test-results');
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'regression-12-evidence.json'), JSON.stringify(evidence, null, 2));
    if (saved) {
      // never leave a running e2e workflow behind
      await orchestrate('stop', saved);
      await sleep(15_000);
    }
  }
});
