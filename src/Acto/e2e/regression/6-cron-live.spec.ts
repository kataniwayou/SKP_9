import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import {
  EXPANDER, VALID_PAYLOAD, clickEmptyBoard, entry, entryEdge, field, inspector, newStep, newWorkflow, openAt, outLine, pickEdge, save,
  selectWorkflowAlone, setCondition, tab, toolbar, typePayload, validateStored, waitLoaded, wfNode, wire,
} from '../helpers';
import {
  ADVANCED_ANYWAY, ENTRY_COMPLETED, ENTRY_DISPATCHED, HANDED_OFF, getJson, orchestrate, settledLogs, type LogRecord, type Row,
} from '../stack';

// Regression 6 (user, 2026-11-24): a workflow has no cron; each entry arrow carries its own. One workflow with four entry steps and
// branching downstream, built entirely in the UI, its crons set in the Workflow tab's Schedules section (one in an entry arrow's Link
// tab), saved, reloaded, dry-run, started and stopped from the toolbar — then the orchestrator's own records in Elasticsearch must
// match the cron arithmetic: per-entry tick counts, one correlation id per cron group (E1 and E2 share one cron, E2's typed with
// stray whitespace), the ticks on the cron's second marks, every branch handed off under its tick's correlation id, and nothing
// dispatched after the stop.
//
//            ┌─ E1 (*/10) ─▶ A1 ─▶ A2 ─▶ A3                         chain, depth 4
//            ├─ E2 (*/10) ─┬▶ B1 ─┐                                 fan-out, then fan-in
//    wf ─────┤             └▶ B2 ─┴▶ J
//            ├─ E3 (*/15) ─┬▶ OK   (Completed: never — E3 always fails, it is a source with no file)
//            │  expander   ├▶ FL   (Failed)
//            │             └▶ AL   (Always)
//            └─ E4 (*/30) ─▶ D1                                      cron set in the arrow's Link tab
//
// Every step but E3 is outcome-recorder (no config schema, no input schema, always Completed, no side effect beyond its record);
// E3 is archive-expander with a valid payload: as an entry step it gets no input and fails ("input branch did not carry a fetched
// file"), which makes the failure path observable. Live only (ACTO_E2E_LIVE=1); the cleanup stops the workflow before the rows go.

test.skip(process.env.ACTO_E2E_LIVE !== '1', 'the live run: set ACTO_E2E_LIVE=1');
test.use({ actionTimeout: 60_000 });

const N = 'e2e-cronlive';
const RECORDER = 'outcome-recorder';
const CRON = { E1: '*/10 * * * * *', E2: ' */10  * * * * * ', E3: '*/15 * * * * *', E4: '*/30 * * * * *' } as const;
const PERIOD_S = { E1: 10, E2: 10, E3: 15, E4: 30 } as const;
type EntryKey = keyof typeof CRON;
const ENTRIES: EntryKey[] = ['E1', 'E2', 'E3', 'E4'];

const STEPS = [
  { key: 'E1', proc: RECORDER, at: { x: 260, y: 0 } },
  { key: 'A1', proc: RECORDER, at: { x: 540, y: 0 } },
  { key: 'A2', proc: RECORDER, at: { x: 820, y: 0 } },
  { key: 'A3', proc: RECORDER, at: { x: 1100, y: 0 } },
  { key: 'E2', proc: RECORDER, at: { x: 260, y: 230 } },
  { key: 'B1', proc: RECORDER, at: { x: 540, y: 160 } },
  { key: 'B2', proc: RECORDER, at: { x: 540, y: 300 } },
  { key: 'J', proc: RECORDER, at: { x: 820, y: 230 } },
  { key: 'E3', proc: EXPANDER, at: { x: 260, y: 520 } },
  { key: 'OK', proc: RECORDER, at: { x: 540, y: 430 } },
  { key: 'FL', proc: RECORDER, at: { x: 540, y: 540 } },
  { key: 'AL', proc: RECORDER, at: { x: 540, y: 650 } },
  { key: 'E4', proc: RECORDER, at: { x: 260, y: 790 } },
  { key: 'D1', proc: RECORDER, at: { x: 540, y: 790 } },
] as const;
const WIRES: [string, string][] = [
  ['E1', 'A1'], ['A1', 'A2'], ['A2', 'A3'],
  ['E2', 'B1'], ['E2', 'B2'], ['B1', 'J'], ['B2', 'J'],
  ['E3', 'OK'], ['E3', 'FL'], ['E3', 'AL'],
  ['E4', 'D1'],
];
/** The hand-offs each entry's tick must make, under that tick's correlation id (finished step → successor). */
const BRANCH: Record<'E12' | 'E3' | 'E4', [string, string][]> = {
  E12: [['E1', 'A1'], ['A1', 'A2'], ['A2', 'A3'], ['E2', 'B1'], ['E2', 'B2'], ['B1', 'J'], ['B2', 'J']],
  E3: [['E3', 'FL'], ['E3', 'AL']],
  E4: [['E4', 'D1']],
};

const schedule = (page: Page, step: string) => inspector(page).getByTestId(`schedule:${step}`);
const cronIn = (page: Page, step: string) => schedule(page, step).getByRole('textbox', { name: 'Cron' });
const label = (page: Page, wf: string, step: string) => entryEdge(page, wf, step).locator('.entry-cron');
const shot = (name: string) => resolve(process.cwd(), '../../.playwright-mcp', name);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Waits until the wall clock is `lo`..`hi` ms past a 10 s mark, so a Start or Stop never lands on a cron second. */
async function offMark(lo = 3_000, hi = 5_000) { while (Date.now() % 10_000 < lo || Date.now() % 10_000 >= hi) await sleep(100); }
/** The cron marks of an every-p-seconds cron (p divides 60, so they are epoch-aligned) in (from, to]. */
const marks = (p: number, from: number, to: number) => Math.floor(to / (p * 1000)) - Math.floor(from / (p * 1000));
const hhmmss = (ms: number) => new Date(ms).toISOString().slice(11, 23);

test('four entry crons on one branching workflow, built in the UI: saved, dry-run clean, started, and the orchestrator fires each group on its own marks with every branch handed off', async ({ page }) => {
  test.setTimeout(15 * 60_000);
  let saved: string | null = null;
  const evidence: Record<string, unknown> = {};
  try {
    await openAt(page, { x: -40, y: -40 }, 0.55);

    // ---- build: triangle, 14 steps, 11 wires, 4 entry arrows, 2 entry conditions, 1 payload ----------------------------------
    const id: Record<string, string> = {};
    id.wf = await newWorkflow(page, { x: 0, y: 400 }, N);
    for (const s of STEPS) id[s.key] = await newStep(page, s.proc, s.at, `${N}-${s.key}`);
    for (const [f, t] of WIRES) await wire(page, id[f]!, id[t]!);
    for (const e of ENTRIES) await entry(page, id.wf!, id[e]!);
    await setCondition(page, id.FL!, 'Failed');
    await setCondition(page, id.AL!, 'Always');
    await typePayload(page, id.wf!, N, id.E3!, VALID_PAYLOAD[EXPANDER]!);

    // crons: E1..E3 in the Workflow tab's Schedules section, E4 in its arrow's Link tab
    await selectWorkflowAlone(page, id.wf!);
    await expect(inspector(page).locator('[data-testid^="schedule:"]')).toHaveCount(4);
    for (const e of ENTRIES) {
      await expect(schedule(page, id[e]!).locator('.sec-sub')).toHaveText(`${N}-${e}`);
      await expect(cronIn(page, id[e]!)).toHaveAttribute('placeholder', 'not scheduled');
    }
    for (const e of ['E1', 'E2', 'E3'] as const) await cronIn(page, id[e]!).fill(CRON[e]);
    await clickEmptyBoard(page);
    await pickEdge(page, entryEdge(page, id.wf!, id.E4!));
    await tab(page, 'Link').click();
    await expect(field(page, 'Cron')).toHaveAttribute('placeholder', 'not scheduled');
    await field(page, 'Cron').fill(CRON.E4);
    await expect(inspector(page)).toContainText(/30 seconds/i);

    // ---- the UI before the Save: four ⏱ labels, the Schedules readings -------------------------------------------------------
    // (the edit trims the cron, so E2 is held as "*/10  * * * * *": its inner double space stays for the server to normalise)
    const held = { E1: CRON.E1, E2: CRON.E2.trim(), E3: CRON.E3, E4: CRON.E4 };
    for (const e of ENTRIES) await expect(label(page, id.wf!, id[e]!), `${e}'s arrow label`).toHaveText(`⏱ ${held[e].replace(/\s+/g, ' ')}`);
    await selectWorkflowAlone(page, id.wf!);
    const readings: Record<string, string> = {};
    for (const e of ENTRIES) {
      await expect(cronIn(page, id[e]!)).toHaveValue(held[e]);
      await expect(schedule(page, id[e]!).locator('.in-note')).toContainText(new RegExp(`${PERIOD_S[e]} seconds`, 'i'));
      readings[e] = await schedule(page, id[e]!).locator('.in-note').innerText();
    }
    evidence.readings = readings;
    await clickEmptyBoard(page);
    await page.screenshot({ path: shot('cron-live-board.png') });
    await selectWorkflowAlone(page, id.wf!);
    await inspector(page).screenshot({ path: shot('cron-live-schedules.png') });

    // ---- Save; BaseAPI's row; a reload keeps it ------------------------------------------------------------------------------
    const answer = await save(page);
    expect(answer.applied, 'the Save is applied').toBe(true);
    saved = answer.made![id.wf!]!;
    const real = (k: string) => answer.made?.[id[k]!] ?? id[k]!;
    const S: Record<string, string> = Object.fromEntries(STEPS.map((s) => [s.key, real(s.key)]));
    const name = Object.fromEntries(Object.entries(S).map(([k, v]) => [v, k]));
    evidence.workflowId = saved;
    evidence.steps = S;
    const row = await getJson<Row>(`/workflows/${saved}`);
    expect(row.cronExpression, 'the workflow row has no cron of its own').toBeUndefined();
    expect(row.entryCrons, 'GET /workflows/{id} entryCrons').toEqual(Object.fromEntries(ENTRIES.map((e) => [S[e], held[e]])));
    expect([...(row.entryStepIds as string[])].sort()).toEqual(ENTRIES.map((e) => S[e]).sort());
    evidence.storedEntryCrons = row.entryCrons;

    await page.reload();
    await waitLoaded(page);
    await selectWorkflowAlone(page, saved);
    for (const e of ENTRIES) {
      await expect(cronIn(page, S[e]!), `${e} after the reload`).toHaveValue(held[e]);
      await expect(label(page, saved, S[e]!)).toHaveText(`⏱ ${held[e].replace(/\s+/g, ' ')}`);
    }
    await clickEmptyBoard(page);
    await pickEdge(page, entryEdge(page, saved, S.E1!));
    await tab(page, 'Link').click();
    await expect(field(page, 'Cron'), 'the Link tab shows the cron set in Schedules').toHaveValue(CRON.E1);

    // ---- dry run: BaseAPI's validate (what a Start would refuse) finds nothing ------------------------------------------------
    const dry = await validateStored(saved);
    evidence.dryRun = dry;
    expect(dry.problems, 'the dry run of the stored workflow').toEqual([]);
    expect(dry.valid).toBe(true);

    // ---- Start from the toolbar; ~65 s; Stop from the toolbar ----------------------------------------------------------------
    await expect(wfNode(page, saved).locator('.tri-st[data-status="stopped"]')).toBeVisible({ timeout: 20_000 });
    await selectWorkflowAlone(page, saved);
    await offMark();
    const startSent = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/orchestration/start'));
    await toolbar(page, 'workflow').getByRole('button', { name: '▶ Start' }).click();
    expect((await startSent).ok(), 'Start answered 2xx').toBe(true);
    const startedAt = Date.now();
    await expect(outLine(page, `${N}: Start requested`)).toHaveCount(1);
    await expect(outLine(page, new RegExp(`^${N}: Start refused`)), 'the refused-Start check path shows nothing').toHaveCount(0);
    await expect(wfNode(page, saved).locator('.tri-problems')).toHaveCount(0);
    await expect(wfNode(page, saved).locator('.tri-st[data-status="running"]')).toBeVisible({ timeout: 30_000 });
    await sleep(Math.max(0, startedAt + 65_000 - Date.now()));
    await offMark();
    await selectWorkflowAlone(page, saved);
    const stopSent = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/orchestration/stop'));
    await toolbar(page, 'workflow').getByRole('button', { name: '■ Stop' }).click();
    expect((await stopSent).ok(), 'Stop answered 2xx').toBe(true);
    const stoppedAt = Date.now();
    await expect(outLine(page, `${N}: Stop requested`)).toHaveCount(1);
    await expect(wfNode(page, saved).locator('.tri-st[data-status="stopped"]')).toBeVisible({ timeout: 30_000 });
    // the quiet period: a leak would fire on the next */10 mark at the latest
    await sleep(15_000);
    const quietEnd = Date.now();
    evidence.window = { startedAt: new Date(startedAt).toISOString(), stoppedAt: new Date(stoppedAt).toISOString(), quietEnd: new Date(quietEnd).toISOString() };

    // ---- Elasticsearch: every record of this workflow in the window, settled ------------------------------------------------
    const all = await settledLogs({ 'attributes.WorkflowId': saved }, startedAt, quietEnd, { floorMs: 15_000 });
    const of = (tpl: string) => all.filter((r) => r.attributes['{OriginalFormat}'] === tpl);
    const dispatches = of(ENTRY_DISPATCHED);
    const STOP_SLACK = 2_000;
    const during = dispatches.filter((d) => d.at <= stoppedAt + STOP_SLACK);
    const after = dispatches.filter((d) => d.at > stoppedAt + STOP_SLACK);
    const line = (d: LogRecord) => `${hhmmss(d.at)} ${name[d.attributes.StepId!] ?? d.attributes.StepId} ${d.attributes.CorrelationId}`;
    const summary = dispatches.map(line).join('; ');
    evidence.dispatches = dispatches.map(line);

    // tick counts: the cron marks in (start, stop], ±1 (activation lag may miss the first, the stop's lag may admit one more)
    const counts: Record<string, { expected: number; measured: number; at: string[] }> = {};
    for (const e of ENTRIES) {
      const mine = during.filter((d) => d.attributes.StepId === S[e]);
      counts[e] = { expected: marks(PERIOD_S[e], startedAt, stoppedAt), measured: mine.length, at: mine.map((d) => hhmmss(d.at)) };
    }
    evidence.counts = counts;
    for (const e of ENTRIES) {
      const c = counts[e]!;
      expect(Math.abs(c.measured - c.expected), `${e} (${CRON[e]}) fired ${c.measured} times, the window holds ${c.expected} marks: ${summary}`).toBeLessThanOrEqual(1);
      expect(c.measured, `${e} fired at all`).toBeGreaterThan(0);
    }
    expect(after, `entry dispatches after the stop at ${hhmmss(stoppedAt)} (+${STOP_SLACK} ms): ${summary}`).toEqual([]);

    // every tick on its cron's second marks (the record is written right after the send: allow 2.5 s)
    for (const d of during) {
      const e = name[d.attributes.StepId!] as EntryKey;
      expect(d.at % (PERIOD_S[e] * 1000), `${line(d)} is on a */${PERIOD_S[e]} second mark`).toBeLessThan(2_500);
    }

    // correlation ids: one per fire of a cron group — E1 and E2 always together (one normalised cron), E3 and E4 alone
    const byCorr = new Map<string, string[]>();
    for (const d of during) byCorr.set(d.attributes.CorrelationId!, [...(byCorr.get(d.attributes.CorrelationId!) ?? []), name[d.attributes.StepId!]!]);
    const groups = [...byCorr].map(([c, steps]) => ({ c, steps: steps.sort().join('+') }));
    evidence.groups = groups;
    for (const g of groups) expect(['E1+E2', 'E3', 'E4'], `correlation ${g.c} carries ${g.steps}: ${summary}`).toContain(g.steps);
    const corrOf = (k: string) => groups.filter((g) => g.steps === k).map((g) => g.c);
    expect(corrOf('E1+E2').length, 'one correlation id per E1/E2 tick').toBe(counts.E1!.measured);
    expect(counts.E1!.measured, 'E1 and E2 fire together').toBe(counts.E2!.measured);

    // branches: each tick's hand-offs, under its correlation id (ticks in the last 5 s before the stop may be cut by the stop)
    const handoffs = of(HANDED_OFF);
    const handed = (c: string) => new Set(handoffs.filter((h) => h.attributes.CorrelationId === c).map((h) => `${name[h.attributes.StepId!]}>${name[h.attributes.NextStepId!]}`));
    const tickAt = (c: string) => Math.min(...during.filter((d) => d.attributes.CorrelationId === c).map((d) => d.at));
    const branchEvidence: Record<string, string[]> = {};
    for (const [k, want] of [['E1+E2', BRANCH.E12], ['E3', BRANCH.E3], ['E4', BRANCH.E4]] as const) {
      for (const c of corrOf(k)) {
        const got = handed(c);
        branchEvidence[`${k} ${hhmmss(tickAt(c))} ${c}`] = [...got].sort();
        if (tickAt(c) > stoppedAt - 5_000) continue;
        for (const [f, t] of want) expect(got.has(`${f}>${t}`), `${k} tick ${c}: ${f} handed off to ${t}`).toBe(true);
        // nothing hands off to a step outside its branch, and E3's failure never reaches OK (its condition is Completed)
        expect([...got].filter((h) => !want.some(([f, t]) => h === `${f}>${t}`)), `${k} tick ${c}: hand-offs outside the branch`).toEqual([]);
      }
    }
    evidence.branches = branchEvidence;
    expect(handoffs.filter((h) => h.attributes.NextStepId === S.OK), 'OK (Completed) is never handed E3\'s failure').toEqual([]);

    // the fan-in step J ran under each E1/E2 tick's correlation id (its own processor's record), and E3's failure is on record
    const ranJ = all.filter((r) => r.attributes.StepId === S.J && r.service !== 'orchestrator');
    const jRuns: Record<string, number> = {};
    for (const c of corrOf('E1+E2')) {
      jRuns[c] = ranJ.filter((r) => r.attributes.CorrelationId === c && /^recorded a step outcome/.test(r.attributes['{OriginalFormat}'] ?? '')).length;
      if (tickAt(c) <= stoppedAt - 5_000) expect(jRuns[c], `J recorded tick ${c}`).toBeGreaterThan(0);
    }
    evidence.joinRunsPerTick = jRuns;
    const e3Outcomes = of(ENTRY_COMPLETED).filter((r) => r.attributes.StepId === S.E3).map((r) => r.attributes.Result);
    const e3Anyway = of(ADVANCED_ANYWAY).filter((r) => r.attributes.StepId === S.E3).map((r) => `${r.attributes.Result} x${r.attributes.SuccessorCount}`);
    evidence.e3 = { entryOutcomes: e3Outcomes, advancedAnyway: e3Anyway };
    expect(e3Outcomes.length, 'E3 reported its outcomes').toBeGreaterThan(0);
    expect(new Set(e3Outcomes), 'E3 (a source expander with no file) fails every tick').toEqual(new Set(['Failed']));
    expect(new Set(e3Anyway), 'E3 advances its two failure-accepting successors anyway').toEqual(new Set(['Failed x2']));
    const others = of(ENTRY_COMPLETED).filter((r) => r.attributes.StepId !== S.E3).map((r) => r.attributes.Result);
    expect(new Set(others), 'the recorder entries complete').toEqual(new Set(['Completed']));

    // ---- delete through the board (stopped): the cleanup below has nothing left to stop -------------------------------------
    await selectWorkflowAlone(page, saved);
    await toolbar(page, 'workflow').getByRole('button', { name: 'Delete', exact: true }).click();
    expect((await save(page)).applied).toBe(true);
    expect((await getJson<Row[]>('/workflows')).some((w) => w.id === saved)).toBe(false);
    saved = null;
  } finally {
    const dir = resolve(process.cwd(), 'test-results');
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'cron-live-evidence.json'), JSON.stringify(evidence, null, 2));
    test.info().annotations.push({ type: 'evidence', description: JSON.stringify({ counts: evidence.counts, groups: (evidence.groups as unknown[] | undefined)?.length }) });
    if (saved) {
      // never leave a running e2e workflow behind: stop it and give the stop time to land before the fixture deletes the rows
      await orchestrate('stop', saved);
      await sleep(15_000);
    }
  }
});
