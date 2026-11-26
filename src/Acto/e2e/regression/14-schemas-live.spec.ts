import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Locator, Page, Request } from '@playwright/test';
import { test, expect } from '../fixtures';
import {
  EXPANDER, VALID_PAYLOAD, clickEmptyBoard, dragBy, entry, flowPos, inspector, newStep, newWorkflow, offMark, outLine, save, saveButton,
  selectWorkflowAlone, toolbar, typePayload, waitLoaded, wfNode,
} from '../helpers';
import { regionCorner } from '../seed';
import {
  ENTRY_COMPLETED, ENTRY_DISPATCHED, HANDED_OFF, countLogs, getJson, isE2e, orchestrate, readAll, realDifferences, settledLogs,
  type LogRecord, type Row, type Snapshot,
} from '../stack';

// Regression 14 (user, 2026-11-26): moving real schema and processor cards in the Schemas mode is a layout change and nothing
// else. Proven from the orchestrator's own records in Elasticsearch, on the stack's REAL running workflows:
//   1. before: the real workflows the orchestrator runs (GET /orchestration/live), their entry dispatches in the 5 min before t0,
//      and every row;
//   2. in the UI, the Schemas mode on: the input and config schemas of archive-expander (a processor a step of a running real
//      workflow uses) and a real stepless processor card are dragged and saved (the guard lets location-only through) — t1;
//   3. every real row is as it was, location aside;
//   4. every running real workflow dispatches an entry step after t1 and that fire completes or hands off (waited up to its next
//      fire + 60 s; a workflow whose next fire is more than 6 min after t1 is recorded as "not awaited", not waited for);
//   5. an e2e- workflow built in the UI on archive-expander (so on the moved schemas) is started, dispatched and its entry step
//      reports its outcome; it is stopped and nothing more is dispatched; the real workflows keep running after that stop.
// Evidence: test-results/regression-14-evidence.json. Live only (ACTO_E2E_LIVE=1). Start/Stop only of the e2e- workflow.
// Plan: docs/superpowers/plans/2026-11-26-acto-schemas-mode-regression.md (Task C).

test.skip(process.env.ACTO_E2E_LIVE !== '1', 'the live run: set ACTO_E2E_LIVE=1');
test.use({ actionTimeout: 60_000 });

const N = 'e2e-schlive';
const CRON = '*/10 * * * * *';
/** The longest a real workflow's next fire is waited for; a later one is recorded, not awaited. */
const BUDGET_MS = 6 * 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const iso = (ms: number) => new Date(ms).toISOString();
const hhmmss = (ms: number) => iso(ms).slice(11, 23);

const toggle = (page: Page) => page.locator('button.schemas-toggle');
const scNode = (page: Page, id: string) => page.locator(`.react-flow__node-schema[data-id="sc:${id}"]`);
const prNode = (page: Page, id: string) => page.locator(`.react-flow__node-processor[data-id="pr:${id}"]`);
const cronIn = (page: Page, step: string) => inspector(page).getByTestId(`schedule:${step}`).getByRole('textbox', { name: 'Cron' });
const changesOf = (req: Request) => ((req.postDataJSON() ?? {}) as { changes?: { op: string; table: string; id: string }[] }).changes ?? [];

/**
 * The next fire of a Quartz cron (sec min hour dom mon dow [year]) strictly after `from` (UTC), or null when a day, month or
 * weekday field is not a wildcard (the stack's crons never restrict them) or none falls within a day.
 */
function nextFire(cron: string, from: number): number | null {
  const f = cron.trim().split(/\s+/);
  if (f.length < 6 || f.slice(3, 6).some((x) => x !== '*' && x !== '?')) return null;
  const matches = (field: string, v: number, max: number) => field.split(',').some((part) => {
    const [range, stepS] = part.split('/');
    const step = stepS ? Number(stepS) : 1;
    let lo: number, hi: number;
    if (range === '*' || range === '?') { lo = 0; hi = max; } else if (range!.includes('-')) { [lo, hi] = range!.split('-').map(Number) as [number, number]; } else {
      lo = Number(range); hi = stepS ? max : lo;
    }
    return v >= lo && v <= hi && (v - lo) % step === 0;
  });
  for (let t = Math.floor(from / 1000) * 1000 + 1000; t <= from + 86_400_000; t += 1000) {
    const d = new Date(t);
    if (matches(f[0]!, d.getUTCSeconds(), 59) && matches(f[1]!, d.getUTCMinutes(), 59) && matches(f[2]!, d.getUTCHours(), 23)) return t;
  }
  return null;
}
/** The earliest next fire over a workflow's entry crons. */
const nextOf = (w: Row, from: number) => Object.values((w.entryCrons ?? {}) as Record<string, string>)
  .map((c) => nextFire(c, from)).filter((v): v is number => v !== null).sort((a, b) => a - b)[0] ?? null;

/** Puts the view (zoom 1) so the card is at screen (400, 200) of the board, through the remembered view and a reload. */
async function lookAt(page: Page, card: Locator) {
  const at = await flowPos(card);
  await page.evaluate((v) => localStorage.setItem('acto.view', JSON.stringify(v)), { x: 400 - at.x, y: 200 - at.y, zoom: 1, selection: null });
  await page.reload();
  await waitLoaded(page);
  await expect(card).toBeVisible();
  return at;
}
/** Drags a card until it ends somewhere else (a drop onto another card slides aside, maybe back where it was). */
async function moveCard(page: Page, card: Locator) {
  const at = await lookAt(page, card);
  const far = async () => { const p = await flowPos(card); return Math.hypot(p.x - at.x, p.y - at.y); };
  for (const [dx, dy] of [[0, 90], [0, -90], [140, 0], [-140, 0]] as const) {
    await dragBy(page, card, dx, dy, { x: 40, y: 12 });
    await page.waitForTimeout(400); // longer than a slide (280 ms)
    if (await far() > 20) break;
  }
  expect(await far(), 'the card moved').toBeGreaterThan(20);
  return { before: at, after: await flowPos(card) };
}

/** A real workflow's records after `from`: its entry dispatches and the fires among them that completed or handed off. */
function fires(all: LogRecord[], from: number) {
  const of = (tpl: string) => all.filter((r) => r.attributes['{OriginalFormat}'] === tpl && r.at > from);
  const dispatched = of(ENTRY_DISPATCHED);
  const outcome = new Set([...of(ENTRY_COMPLETED), ...of(HANDED_OFF)].map((r) => r.attributes.CorrelationId));
  return {
    dispatched: dispatched.map((d) => `${hhmmss(d.at)} ${d.attributes.StepId} ${d.attributes.CorrelationId}`),
    finished: [...new Set(dispatched.map((d) => d.attributes.CorrelationId).filter((c) => outcome.has(c)))],
  };
}

test('real workflows keep running after their schema and processor cards are moved and saved; an e2e- workflow on the moved schemas runs', async ({ page }) => {
  test.setTimeout(20 * 60_000);
  const evidence: Record<string, unknown> = {};
  let saved: string | null = null;
  try {
    // ---- 1 · before ------------------------------------------------------------------------------------------------------
    const t0 = Date.now();
    evidence.t0 = iso(t0);
    const live = await getJson<string[]>('/orchestration/live');
    const before: Snapshot = await readAll();
    const running = before.workflows.filter((w) => live.includes(w.id) && !isE2e(w.name));
    evidence.running = running.map((w) => ({ id: w.id, name: w.name, entryCrons: w.entryCrons }));
    expect(running.length, 'PRECONDITION: no real workflow is running (GET /orchestration/live). This spec proves real workflows keep '
      + 'running after schema/processor moves; start one (e.g. filefetcher-archiveexpander-chain) and run it again').toBeGreaterThan(0);
    const dispatchedBefore: Record<string, number> = {};
    for (const w of running) {
      dispatchedBefore[w.name] = await countLogs({ 'attributes.WorkflowId': w.id, 'attributes.{OriginalFormat}': ENTRY_DISPATCHED }, t0 - 5 * 60_000, t0);
    }
    evidence.dispatchesIn5MinBeforeT0 = dispatchedBefore;

    // the processor whose schemas move: archive-expander, used by a step of a running real workflow (its entry run fails, a
    // source with no file, and writes nothing: safe to run from an e2e- workflow); and a real processor no step uses
    const steps = new Map(before.steps.map((s) => [s.id, s]));
    const reach = (w: Row) => {
      const seen = new Set<string>(), todo = [...((w.entryStepIds as string[]) ?? [])];
      while (todo.length) { const s = todo.pop()!; if (seen.has(s) || !steps.has(s)) continue; seen.add(s); todo.push(...((steps.get(s)!.nextStepIds as string[]) ?? [])); }
      return [...seen].map((s) => steps.get(s)!);
    };
    const proc = before.processors.find((p) => p.name === EXPANDER && running.some((w) => reach(w).some((s) => s.processorId === p.id)));
    expect(proc, `PRECONDITION: no running real workflow has an ${EXPANDER} step`).toBeDefined();
    const user = running.find((w) => reach(w).some((s) => s.processorId === proc!.id))!;
    const schemaIds = [proc!.inputSchemaId, proc!.configSchemaId].filter((v): v is string => typeof v === 'string');
    expect(schemaIds.length, `${EXPANDER} references an input and a config schema`).toBe(2);
    const used = new Set(before.steps.map((s) => s.processorId as string));
    const stepless = before.processors.find((p) => !isE2e(p.name) && !used.has(p.id)
      && [p.inputSchemaId, p.outputSchemaId, p.configSchemaId].some((v) => typeof v === 'string'));
    if (!stepless) test.info().annotations.push({ type: 'skipped half', description: 'no real processor without a step: only schemas move' });
    const movedIds = [...schemaIds, ...(stepless ? [stepless.id] : [])];
    const rowOf = (s: Snapshot, id: string) => [...s.schemas, ...s.processors].find((r) => r.id === id)!;
    evidence.moved = movedIds.map((id) => ({ id, name: rowOf(before, id).name, usedBy: id === stepless?.id ? 'no step' : `${EXPANDER} (a step of ${user.name})` }));

    // ---- 2 · move the real cards in the UI, Save -----------------------------------------------------------------------------
    await page.goto('/');
    await waitLoaded(page);
    if ((await toggle(page).getAttribute('aria-pressed')) !== 'true') await toggle(page).click();
    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
    // turning the mode on places every card that has no stored place: saved first (location only), so the move Save holds the moves alone
    if (await saveButton(page).isEnabled()) expect((await save(page)).applied, 'the turn-on placements saved').toBe(true);
    await expect(saveButton(page)).toHaveText('Save');
    const placedBefore = await readAll();

    const cards = movedIds.map((id) => (id === stepless?.id ? prNode(page, id) : scNode(page, id)));
    const drags: { before: { x: number; y: number }; after: { x: number; y: number } }[] = [];
    for (const c of cards) { await expect(c).toBeAttached(); drags.push(await moveCard(page, c)); }

    const writes: string[] = [];
    const onReq = (r: Request) => { if (r.method() !== 'GET') writes.push(`${r.method()} ${new URL(r.url()).pathname}`); };
    page.on('request', onReq);
    const sent = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/v1/model/apply');
    expect((await save(page)).applied, 'the guard passed the moves as location-only and BaseAPI applied them').toBe(true);
    const changes = changesOf(await sent);
    page.off('request', onReq);
    const t1 = Date.now();
    evidence.t1 = iso(t1);
    expect(changes.map((c) => `${c.op} ${c.table} ${c.id}`).sort(), 'the Save sends the moved rows alone')
      .toEqual(movedIds.map((id) => `update ${id === stepless?.id ? 'processors' : 'schemas'} ${id}`).sort());
    expect(writes.filter((w) => /\/validate$|\/diagram$/.test(w)), 'no dry run and no diagram for a move').toEqual([]);

    // ---- 3 · real rows unchanged beyond location ----------------------------------------------------------------------------
    const after = await readAll();
    const real = (s: Snapshot) => Object.fromEntries(Object.entries(s).map(([t, rows]) => [t, rows.filter((r) => !isE2e(r.name))])) as Snapshot;
    expect(realDifferences(real(before), after), 'real rows changed beyond location').toEqual([]);
    evidence.rows = movedIds.map((id, i) => {
      const pick = (r: Row) => ({ boardX: r.boardX, boardY: r.boardY, updatedAt: r.updatedAt });
      const a = rowOf(after, id);
      expect(Math.abs((a.boardX as number) - drags[i]!.after.x), `${a.name} boardX stored`).toBeLessThanOrEqual(1);
      expect(Math.abs((a.boardY as number) - drags[i]!.after.y), `${a.name} boardY stored`).toBeLessThanOrEqual(1);
      return { id, name: a.name, before: pick(rowOf(before, id)), afterTurnOn: pick(rowOf(placedBefore, id)), after: pick(a), full: { before: rowOf(before, id), after: a } };
    });

    // ---- 5 · an e2e- workflow on the moved schemas, built in the UI, started and stopped ------------------------------------
    // (before 4's waits, which it overlaps: the real workflows' window runs from t1 past this one's stop)
    await toggle(page).click();
    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
    const c = regionCorner();
    await page.evaluate((v) => localStorage.setItem('acto.view', JSON.stringify(v)), { x: 70 - (c.x - 40), y: 70 - (c.y - 40), zoom: 1, selection: null });
    await page.reload();
    await waitLoaded(page);
    const wfC = await newWorkflow(page, { x: 0, y: 60 }, N);
    const stC = await newStep(page, EXPANDER, { x: 280, y: 60 }, `${N}-E`);
    await entry(page, wfC, stC);
    await typePayload(page, wfC, N, stC, VALID_PAYLOAD[EXPANDER]!);
    await selectWorkflowAlone(page, wfC);
    await cronIn(page, stC).fill(CRON);
    await clickEmptyBoard(page);
    const answer = await save(page);
    expect(answer.applied, 'the e2e- workflow saved').toBe(true);
    saved = answer.made![wfC]!;
    const stepId = answer.made?.[stC] ?? stC;
    const stepRow = await getJson<Row>(`/steps/${stepId}`);
    expect(stepRow.processorId, `the e2e- step runs ${EXPANDER}, the processor whose schemas moved`).toBe(proc!.id);
    expect((await getJson<Row>(`/workflows/${saved}`)).entryCrons).toEqual({ [stepId]: CRON });

    await expect(wfNode(page, saved).locator('.tri-st[data-status="stopped"]')).toBeVisible({ timeout: 20_000 });
    await selectWorkflowAlone(page, saved);
    await offMark();
    await toolbar(page, 'workflow').getByRole('button', { name: '▶ Start' }).click();
    const tStart = Date.now();
    await expect(outLine(page, `${N}: Start requested`)).toHaveCount(1);
    await expect(outLine(page, new RegExp(`^${N}: Start refused`))).toHaveCount(0);
    await expect(wfNode(page, saved).locator('.tri-st[data-status="running"]')).toBeVisible({ timeout: 30_000 });
    await sleep(Math.max(0, tStart + 35_000 - Date.now()));
    await offMark();
    await selectWorkflowAlone(page, saved);
    await toolbar(page, 'workflow').getByRole('button', { name: '■ Stop' }).click();
    const tStop = Date.now();
    await expect(wfNode(page, saved).locator('.tri-st[data-status="stopped"]')).toBeVisible({ timeout: 30_000 });
    await sleep(25_000); // the quiet period: two and a half */10 marks
    const tQuiet = Date.now();

    const mine = await settledLogs({ 'attributes.WorkflowId': saved }, tStart, tQuiet, { floorMs: 15_000 });
    const mDispatched = mine.filter((r) => r.attributes['{OriginalFormat}'] === ENTRY_DISPATCHED);
    const mCompleted = mine.filter((r) => r.attributes['{OriginalFormat}'] === ENTRY_COMPLETED && r.attributes.StepId === stepId);
    const SLACK = 2_000;
    evidence.e2e = {
      workflowId: saved, stepId, processor: `${proc!.name} ${proc!.version}`, cron: CRON,
      window: { start: iso(tStart), stop: iso(tStop), quietEnd: iso(tQuiet) },
      dispatched: mDispatched.map((d) => `${hhmmss(d.at)} ${d.attributes.CorrelationId}`),
      completed: mCompleted.map((d) => `${hhmmss(d.at)} ${d.attributes.Result} ${d.attributes.CorrelationId}`),
    };
    const during = mDispatched.filter((d) => d.at <= tStop + SLACK);
    expect(during.length, 'the e2e- workflow was dispatched while running').toBeGreaterThanOrEqual(2);
    expect(mCompleted.length, 'its entry step reported an outcome').toBeGreaterThan(0);
    const dCorr = new Set(during.map((d) => d.attributes.CorrelationId));
    for (const r of mCompleted) expect(dCorr.has(r.attributes.CorrelationId), `outcome ${r.attributes.CorrelationId} belongs to a dispatch`).toBe(true);
    // the expander as an entry step has no fetched file: it fails, the same answer as in regression 6 (its payload passed the moved config schema)
    expect(new Set(mCompleted.map((r) => r.attributes.Result))).toEqual(new Set(['Failed']));
    expect(mDispatched.filter((d) => d.at > tStop + SLACK), `dispatched after the stop at ${hhmmss(tStop)}`).toEqual([]);

    // ---- 4 · every running real workflow keeps running (after t1, and after the e2e- stop) ---------------------------------
    const real4: Record<string, unknown> = {};
    const awaited = running.map((w) => {
      const n1 = nextOf(w, t1), n2 = nextOf(w, tStop);
      return { w, n1, n2, ok1: n1 !== null && n1 - t1 <= BUDGET_MS, ok2: n2 !== null && n2 - tStop <= BUDGET_MS };
    });
    for (const a of awaited.filter((x) => !x.ok1)) real4[a.w.name] = { awaited: false, note: `next fire at ${a.n1 ? iso(a.n1) : 'unknown'}, more than ${BUDGET_MS / 60_000} min after t1: not awaited` };
    expect(awaited.some((a) => a.ok1), `no running real workflow fires within ${BUDGET_MS / 60_000} min of t1: ${JSON.stringify(real4)}`).toBe(true);
    const end = Math.max(...awaited.filter((a) => a.ok1).flatMap((a) => [a.n1! + 60_000, ...(a.ok2 ? [a.n2! + 60_000] : [])]));
    await sleep(Math.max(0, end - Date.now()));
    for (const a of awaited.filter((x) => x.ok1)) {
      const all = await settledLogs({ 'attributes.WorkflowId': a.w.id }, t1, end, { floorMs: 15_000 });
      const sinceT1 = fires(all, t1), sinceStop = fires(all, tStop);
      real4[a.w.name] = {
        awaited: true, id: a.w.id, nextFireAfterT1: iso(a.n1!), nextFireAfterE2eStop: a.n2 ? iso(a.n2) : null, windowEnd: iso(end),
        dispatchedSinceT1: sinceT1.dispatched, finishedCorrelationsSinceT1: sinceT1.finished,
        dispatchedSinceE2eStop: sinceStop.dispatched.length,
      };
      expect(sinceT1.dispatched.length, `${a.w.name} dispatched an entry step after the moves were saved (t1 ${hhmmss(t1)})`).toBeGreaterThan(0);
      expect(sinceT1.finished.length, `${a.w.name}: a fire after t1 completed its entry step or handed off`).toBeGreaterThan(0);
      if (a.ok2) expect(sinceStop.dispatched.length, `${a.w.name} still dispatches after the e2e- stop`).toBeGreaterThan(0);
    }
    evidence.realAfter = real4;
    const liveAfter = await getJson<string[]>('/orchestration/live');
    evidence.liveAfter = liveAfter;
    for (const w of running) expect(liveAfter, `${w.name} is still live`).toContain(w.id);
  } finally {
    const dir = resolve(process.cwd(), 'test-results');
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'regression-14-evidence.json'), JSON.stringify(evidence, null, 2));
    if (saved) {
      // never leave a running e2e- workflow behind (only the one this run made)
      let stopped = false;
      for (let i = 0; i < 3 && !stopped; i++) {
        stopped = (await orchestrate('stop', saved).catch(() => null))?.ok === true;
        if (!stopped) await sleep(3_000);
      }
      expect.soft(stopped, `the cleanup stop of ${saved} was accepted`).toBe(true);
    }
  }
});
