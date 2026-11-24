import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import {
  clickEmptyBoard, entryEdge, field, inspector, openAt, out, outLine, pickEdge, save, saveButton, selectWorkflowAlone, tab, toolbar,
  validateStored, wfNode,
} from '../helpers';
import { processorId, seed } from '../seed';
import {
  API, ENTRY_DISPATCHED, NO_FUTURE_FIRE, countLogs, getJson, orchestrate, settledLogs, type Row,
} from '../stack';

// Regression 7 (user, 2026-11-24): entry-cron validation through the four layers — design (the Acto Inspector), Save (BaseAPI's row
// rules, all or nothing, refusals in Output), BaseAPI directly, the dry run (POST /workflows/{id}/validate), and real running (live
// only). A cron is a save-time rule: once stored, the dry run has nothing to say about it, and a cron that never fires starts and
// dispatches nothing.

const RECORDER = 'outcome-recorder';
const NEVER = '0 0 0 30 2 *'; // 30 February: parses, never fires
/** A cron of the right shape and 121+ characters (a seconds list padded out). */
const LONG = `${Array.from({ length: 50 }, (_, i) => i).join(',')} * * * * *`;
const msg = {
  invalid: (s: string) => `EntryCrons for step ${s} must be a valid 5- or 6-field cron expression.`,
  long: (s: string) => `EntryCrons for step ${s} must be at most 120 characters.`,
  notEntry: (s: string) => `EntryCrons names step ${s}, which is not an entry step.`,
};

const schedule = (page: Page, step: string) => inspector(page).getByTestId(`schedule:${step}`);
const cronIn = (page: Page, step: string) => schedule(page, step).getByRole('textbox', { name: 'Cron' });
const note = (page: Page, step: string) => schedule(page, step).locator('.in-note');
const presets = (page: Page, step: string) => schedule(page, step).getByRole('combobox', { name: 'Cron presets' });
const label = (page: Page, wf: string, step: string) => entryEdge(page, wf, step).locator('.entry-cron');
const undo = (page: Page) => inspector(page).getByRole('button', { name: 'Undo', exact: true });
const redo = (page: Page) => inspector(page).getByRole('button', { name: 'Redo', exact: true });
const shot = (name: string) => resolve(process.cwd(), '../../.playwright-mcp', name);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A workflow with two entry steps (outcome-recorder: no payload needed), seeded through /model/apply. */
async function twoEntries(prefix: string, crons: Record<string, string> = {}) {
  const id = await seed({
    steps: [
      { key: 'a', name: `${prefix}-a`, at: { x: 300, y: 40 }, processor: RECORDER },
      { key: 'b', name: `${prefix}-b`, at: { x: 300, y: 220 }, processor: RECORDER },
    ],
    workflows: [{ key: 'w', name: `${prefix}-wf`, at: { x: 0, y: 130 }, entry: ['a', 'b'], entryCrons: crons }],
  });
  return { w: id.w!, a: id.a!, b: id.b! };
}

// ---- 1. design: the Inspector's Cron fields -------------------------------------------------------------------------------

test('design: a Schedules row reads 5- and 6-field crons and presets, shows an unreadable cron as typed, clears to not scheduled; Link tab and Schedules agree; undo and redo', async ({ page }) => {
  const { w, a, b } = await twoEntries('e2e-cval-ui');
  await openAt(page);
  await selectWorkflowAlone(page, w);
  await expect(cronIn(page, a)).toHaveAttribute('placeholder', 'not scheduled');
  await expect(note(page, a), 'no cron: no reading').toHaveCount(0);

  // an unreadable cron: the note under the field repeats the text (no reading), and the arrow carries it as typed
  await cronIn(page, a).fill('not a cron');
  await expect(note(page, a)).toHaveText('not a cron');
  await expect(label(page, w, a)).toHaveText('⏱ not a cron');
  // four and seven fields: no reading either
  await cronIn(page, a).fill('*/10 * * *');
  await expect(note(page, a)).toHaveText('*/10 * * *');
  await cronIn(page, a).fill('* * * * * * *');
  await expect(note(page, a)).toHaveText('* * * * * * *');

  // five fields (seconds 0), six fields (seconds first), a preset — each read in words
  await cronIn(page, a).fill('*/5 * * * *');
  await expect(note(page, a)).toHaveText(/5 minutes/i);
  const five = await note(page, a).innerText();
  await cronIn(page, a).fill('*/20 * * * * *');
  await expect(note(page, a)).toHaveText(/20 seconds/i);
  const six = await note(page, a).innerText();
  await presets(page, a).selectOption({ label: 'Every hour · 0 0 * * * *' });
  await expect(cronIn(page, a)).toHaveValue('0 0 * * * *');
  await expect(note(page, a)).toHaveText(/hour/i);
  const preset = await note(page, a).innerText();
  await expect(label(page, w, a)).toHaveText('⏱ 0 0 * * * *');
  test.info().annotations.push({ type: 'readings', description: JSON.stringify({ five, six, preset }) });

  // 121+ characters: the field takes it and reads it (the length is BaseAPI's rule, checked at Save)
  expect(LONG.length).toBeGreaterThan(120);
  await cronIn(page, b).fill(LONG);
  await expect(cronIn(page, b)).toHaveValue(LONG);
  await expect(note(page, b)).toHaveCount(1);
  test.info().annotations.push({ type: 'long cron reading', description: await note(page, b).innerText() });

  // cleared (typed empty, and the "Not scheduled" preset): not scheduled, no reading, no label
  await cronIn(page, b).fill('');
  await expect(cronIn(page, b)).toHaveValue('');
  await expect(cronIn(page, b)).toHaveAttribute('placeholder', 'not scheduled');
  await expect(note(page, b)).toHaveCount(0);
  await expect(label(page, w, b)).toHaveCount(0);
  await presets(page, a).selectOption({ label: 'Not scheduled' });
  await expect(cronIn(page, a)).toHaveValue('');
  await expect(label(page, w, a)).toHaveCount(0);

  // the Link tab and the Schedules row edit one value
  await cronIn(page, b).fill('*/15 * * * * *');
  await clickEmptyBoard(page);
  await pickEdge(page, entryEdge(page, w, b));
  await tab(page, 'Link').click();
  await expect(field(page, 'Cron')).toHaveValue('*/15 * * * * *');
  await expect(inspector(page)).toContainText(/15 seconds/i);
  await field(page, 'Cron').fill('not a cron either');
  await expect(inspector(page).locator('.in-note.sub')).toHaveText('not a cron either');
  await field(page, 'Cron').fill('*/45 * * * * *');
  await expect(label(page, w, b)).toHaveText('⏱ */45 * * * * *');
  await selectWorkflowAlone(page, w);
  await expect(cronIn(page, b)).toHaveValue('*/45 * * * * *');
  await expect(cronIn(page, a)).toHaveValue('');

  // undo: the arrow's consecutive cron edits share one merge key (entryCron:<wf>:<step>) whichever tab made them, so they are one
  // step — undo takes b back to no cron, redo restores */45; an edit of a's cron after it is its own step
  await undo(page).click();
  await expect(cronIn(page, b)).toHaveValue('');
  await expect(label(page, w, b)).toHaveCount(0);
  await redo(page).click();
  await expect(cronIn(page, b)).toHaveValue('*/45 * * * * *');
  await expect(label(page, w, b)).toHaveText('⏱ */45 * * * * *');
  await expect(redo(page)).toBeDisabled();
  await cronIn(page, a).fill('0 */5 * * * *');
  await expect(label(page, w, a)).toHaveText('⏱ 0 */5 * * * *');
  await undo(page).click();
  await expect(cronIn(page, a)).toHaveValue('');
  await expect(cronIn(page, b), 'undo of a leaves b').toHaveValue('*/45 * * * * *');
  await redo(page).click();
  await expect(cronIn(page, a)).toHaveValue('0 */5 * * * *');
  await expect(label(page, w, a)).toHaveText('⏱ 0 */5 * * * *');
  await expect(saveButton(page)).toContainText('Save ·');
});

// BUG (found 2026-11-24): every keystroke goes through setEntryCron, which trims the value, and the field shows the trimmed value —
// so a space typed at the end is dropped before the next field is typed: "*/10 * * * * *" typed key by key becomes "*/10*****".
// Only a paste (or Playwright's fill) gets a multi-field cron in. Same in the Link tab. Expected to fail until Acto is fixed.
test('design: a cron typed key by key keeps its spaces, in a Schedules row and in the Link tab', async ({ page }) => {
  test.fail(true, 'BUG: the Cron field trims on every keystroke, so a typed space is lost ("*/10 * * * * *" -> "*/10*****")');
  const { w, a, b } = await twoEntries('e2e-cval-keys');
  await openAt(page);
  await selectWorkflowAlone(page, w);
  await cronIn(page, a).click();
  await cronIn(page, a).pressSequentially('*/10 * * * * *', { delay: 40 });
  const schedulesTyped = await cronIn(page, a).inputValue();
  await clickEmptyBoard(page);
  await pickEdge(page, entryEdge(page, w, b));
  await tab(page, 'Link').click();
  await field(page, 'Cron').click();
  await field(page, 'Cron').pressSequentially('*/30 * * * * *', { delay: 40 });
  const linkTyped = await field(page, 'Cron').inputValue();
  test.info().annotations.push({ type: 'typed key by key', description: JSON.stringify({ schedules: schedulesTyped, link: linkTyped }) });
  expect({ schedules: schedulesTyped, link: linkTyped }, 'what a designer types is what the field holds').toEqual({ schedules: '*/10 * * * * *', link: '*/30 * * * * *' });
});

// ---- 2. Save: BaseAPI's refusal, all or nothing --------------------------------------------------------------------------

test('Save: an invalid or over-long entry cron is refused with BaseAPI\'s message, nothing of the push is stored; fixed, it saves', async ({ page }) => {
  const { w, a, b } = await twoEntries('e2e-cval-save', { b: '0 0 * * * *' });
  const before = await getJson<Row>(`/workflows/${w}`);
  await openAt(page);
  await selectWorkflowAlone(page, w);
  // two edits in one push: a valid description and an unreadable cron
  await field(page, 'Description').fill('must not be stored');
  await cronIn(page, a).fill('not a cron');
  let answer = await save(page);
  expect(answer.applied, 'the push is refused').not.toBe(true);
  await expect(outLine(page, `workflow e2e-cval-save-wf: ${msg.invalid(a)}`)).toHaveCount(1);
  const lines = await out(page).locator('[role="listitem"] span').allInnerTexts();
  test.info().annotations.push({ type: 'output (invalid)', description: lines.join(' | ') });
  await page.screenshot({ path: shot('cron-save-refused.png') });
  let now = await getJson<Row>(`/workflows/${w}`);
  expect(now.description ?? null, 'all or nothing: the description was not stored').toBe(before.description ?? null);
  expect(now.entryCrons).toEqual({ [b]: '0 0 * * * *' });
  expect(now.updatedAt).toBe(before.updatedAt);

  // over-long
  await cronIn(page, a).fill(LONG);
  answer = await save(page);
  expect(answer.applied).not.toBe(true);
  await expect(outLine(page, `workflow e2e-cval-save-wf: ${msg.long(a)}`)).toHaveCount(1);
  test.info().annotations.push({ type: 'output (long)', description: (await out(page).locator('[role="listitem"] span').allInnerTexts()).join(' | ') });
  now = await getJson<Row>(`/workflows/${w}`);
  expect(now.entryCrons).toEqual({ [b]: '0 0 * * * *' });
  expect(now.updatedAt).toBe(before.updatedAt);

  // fixed in the UI: it saves, both crons and the description stored
  await cronIn(page, a).fill('*/20 * * * *');
  answer = await save(page);
  expect(answer.applied).toBe(true);
  now = await getJson<Row>(`/workflows/${w}`);
  expect(now.entryCrons).toEqual({ [a]: '*/20 * * * *', [b]: '0 0 * * * *' });
  expect(now.description).toBe('must not be stored');
});

// ---- 3. BaseAPI directly -------------------------------------------------------------------------------------------------

async function post(path: string, body: unknown, method = 'POST') {
  const r = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, unknown> | null };
}
const newStepRow = async (name: string) => {
  const r = await post('/steps', { name, version: '1.0.0', description: null, processorId: await processorId(RECORDER), nextStepIds: [], entryCondition: 1 });
  expect(r.status, `step ${name} created`).toBe(201);
  return r.body!.id as string;
};

test('BaseAPI: POST and PUT refuse a bad entry cron with the exact message and store nothing; cronExpression in a body is ignored', async () => {
  const s1 = await newStepRow('e2e-cval-api-s1');
  const s2 = await newStepRow('e2e-cval-api-s2');
  const wf = (crons: Record<string, string>, extra: Record<string, unknown> = {}) => ({
    name: 'e2e-cval-api-wf', version: '1.0.0', description: null, entryStepIds: [s1], assignmentIds: [], cacheIds: [], entryCrons: crons, ...extra,
  });
  const cases: [string, Record<string, string>, string][] = [
    ['unparseable, 5 fields', { [s1]: 'abc def ghi jkl mno' }, msg.invalid(s1)],
    ['out of range, 6 fields', { [s1]: '61 * * * * *' }, msg.invalid(s1)],
    ['3 words', { [s1]: 'not a cron' }, msg.invalid(s1)],
    ['4 fields', { [s1]: '*/10 * * *' }, msg.invalid(s1)],
    ['7 fields', { [s1]: '* * * * * * *' }, msg.invalid(s1)],
    ['121+ chars', { [s1]: LONG }, msg.long(s1)],
    ['blank', { [s1]: '' }, msg.invalid(s1)],
    ['whitespace', { [s1]: '   ' }, msg.invalid(s1)],
    ['key not an entry step', { [s2]: '*/10 * * * * *' }, msg.notEntry(s2)],
  ];
  const seen: string[] = [];
  for (const [what, crons, want] of cases) {
    const r = await post('/workflows', wf(crons));
    seen.push(`POST ${what}: ${r.status} ${JSON.stringify((r.body?.errors as Record<string, unknown>) ?? r.body)}`);
    expect(r.status, `POST ${what}`).toBe(400);
    expect((r.body?.errors as Record<string, string[]>)?.EntryCrons, `POST ${what}`).toEqual([want]);
  }
  expect((await getJson<Row[]>('/workflows')).filter((w) => w.name === 'e2e-cval-api-wf'), 'no refused POST stored a row').toEqual([]);

  // accepted: 5 fields, 6 fields, a never-firing one; cronExpression in the body is ignored (not stored, not echoed)
  const ok = await post('/workflows', wf({ [s1]: '*/5 * * * *' }, { cronExpression: '0 * * * * *' }));
  seen.push(`POST valid + cronExpression: ${ok.status}`);
  expect(ok.status).toBe(201);
  const id = ok.body!.id as string;
  expect(ok.body!.cronExpression).toBeUndefined();
  let row = await getJson<Row>(`/workflows/${id}`);
  expect(row.cronExpression).toBeUndefined();
  expect(row.entryCrons).toEqual({ [s1]: '*/5 * * * *' });

  // PUT: each bad cron refused with its message, the row unchanged
  const body = (crons: Record<string, string>, extra: Record<string, unknown> = {}) => ({ ...wf(crons, extra), entryStepIds: [s1], updatedAt: row.updatedAt });
  for (const [what, crons, want] of cases) {
    const r = await post(`/workflows/${id}`, body(crons), 'PUT');
    seen.push(`PUT ${what}: ${r.status} ${JSON.stringify((r.body?.errors as Record<string, unknown>) ?? r.body)}`);
    expect(r.status, `PUT ${what}`).toBe(400);
    expect((r.body?.errors as Record<string, string[]>)?.EntryCrons, `PUT ${what}`).toEqual([want]);
  }
  expect((await getJson<Row>(`/workflows/${id}`)).entryCrons, 'no refused PUT changed the row').toEqual({ [s1]: '*/5 * * * *' });

  for (const cron of ['*/20 * * * * *', NEVER]) {
    const r = await post(`/workflows/${id}`, body({ [s1]: cron }, { cronExpression: '0 0 * * * *' }), 'PUT');
    seen.push(`PUT ${cron} + cronExpression: ${r.status}`);
    expect(r.status, `PUT ${cron}`).toBeLessThan(300);
    row = await getJson<Row>(`/workflows/${id}`);
    expect(row.entryCrons).toEqual({ [s1]: cron });
    expect(row.cronExpression).toBeUndefined();
  }
  test.info().annotations.push({ type: 'BaseAPI answers', description: seen.join(' | ') });
});

// ---- 4. the dry run ------------------------------------------------------------------------------------------------------

/** Three stored workflows of one outcome-recorder entry step each: a firing cron, no cron, a cron that never fires. */
async function threeStored(prefix: string) {
  const id = await seed({
    steps: [
      { key: 's1', name: `${prefix}-s1`, at: { x: 300, y: 0 }, processor: RECORDER },
      { key: 's2', name: `${prefix}-s2`, at: { x: 300, y: 180 }, processor: RECORDER },
      { key: 's3', name: `${prefix}-s3`, at: { x: 300, y: 360 }, processor: RECORDER },
    ],
    workflows: [
      { key: 'valid', name: `${prefix}-valid`, at: { x: 0, y: 0 }, entry: ['s1'], entryCrons: { s1: '*/10 * * * * *' } },
      { key: 'none', name: `${prefix}-none`, at: { x: 0, y: 180 }, entry: ['s2'] },
      { key: 'never', name: `${prefix}-never`, at: { x: 0, y: 360 }, entry: ['s3'], entryCrons: { s3: NEVER } },
    ],
  });
  return id;
}

test('dry run: a valid cron, no cron and a never-firing cron — the validate endpoint has no cron problem for any (a cron is a save-time rule)', async () => {
  const id = await threeStored('e2e-cval-dry');
  const seen: Record<string, unknown> = {};
  for (const k of ['valid', 'none', 'never']) {
    const r = await validateStored(id[k]!);
    seen[k] = r;
    expect(r.problems.filter((p) => /cron|schedul/i.test(`${p.gate} ${p.title} ${p.detail}`)), `${k}: no cron problem`).toEqual([]);
    expect(r, `${k}: the dry run`).toEqual({ valid: true, problems: [] });
  }
  test.info().annotations.push({ type: 'validate answers', description: JSON.stringify(seen) });
});

// ---- 5. real running (live only) -----------------------------------------------------------------------------------------

test('running: the no-cron and the never-firing workflows start from the toolbar and dispatch nothing; the never-firing one is logged without its cron', async ({ page }) => {
  test.skip(process.env.ACTO_E2E_LIVE !== '1', 'the live run: set ACTO_E2E_LIVE=1');
  test.setTimeout(6 * 60_000);
  const id = await threeStored('e2e-cval-run');
  const run = [id.none!, id.never!];
  const started: string[] = [];
  let anyStarted = false;
  try {
    await openAt(page);
    const t0 = Date.now();
    for (const w of run) {
      await expect(wfNode(page, w).locator('.tri-st[data-status="stopped"]')).toBeVisible({ timeout: 20_000 });
      await selectWorkflowAlone(page, w);
      await toolbar(page, 'workflow').getByRole('button', { name: '▶ Start' }).click();
      started.push(w);
      anyStarted = true;
      const name = await wfNode(page, w).locator('.tri-nm').innerText();
      await expect(outLine(page, `${name}: Start requested`)).toHaveCount(1);
      await expect(wfNode(page, w).locator('.tri-st[data-status="running"]')).toBeVisible({ timeout: 30_000 });
    }
    await sleep(25_000);
    for (const w of run) {
      await selectWorkflowAlone(page, w);
      await toolbar(page, 'workflow').getByRole('button', { name: '■ Stop' }).click();
      await expect(wfNode(page, w).locator('.tri-st[data-status="stopped"]')).toBeVisible({ timeout: 30_000 });
    }
    started.length = 0;
    await sleep(10_000);
    const t1 = Date.now();

    // positive control: ingest is alive — some workflow on the stack (the user's chain fires every minute) dispatched lately
    const any = await countLogs({ 'attributes.{OriginalFormat}': ENTRY_DISPATCHED }, t1 - 5 * 60_000, t1);
    expect(any, 'some workflow logged an entry dispatch in the last 5 minutes (ingest is alive)').toBeGreaterThan(0);
    const seen: Record<string, unknown> = { anyDispatchesLast5Min: any };
    for (const [k, w] of [['none', id.none!], ['never', id.never!]] as const) {
      const d = await settledLogs({ 'attributes.{OriginalFormat}': ENTRY_DISPATCHED, 'attributes.WorkflowId': w }, t0, t1, { settleOnEmpty: true });
      seen[`${k} dispatches`] = d.length;
      expect(d.map((r) => r.attributes.CorrelationId), `${k}: no entry dispatch`).toEqual([]);
    }
    // the scheduler's warning: present for the never-firing cron (once per orchestrator replica that activated it), never with the cron text
    const warned = await settledLogs({ 'attributes.{OriginalFormat}': NO_FUTURE_FIRE, 'attributes.WorkflowId': id.never! }, t0, t1, { floorMs: 0, settleOnEmpty: false, budgetMs: 40_000 });
    seen.neverWarnings = warned.map((r) => ({ at: new Date(r.at).toISOString(), level: r.level, body: r.body, replica: (r.raw as { resource?: { attributes?: Record<string, string> } }).resource?.attributes?.['service.instance.id'] }));
    expect(warned.length, 'the never-firing cron is logged as having no future fire time').toBeGreaterThan(0);
    for (const r of warned) {
      expect(r.level).toBe('Warning');
      expect(JSON.stringify(r.raw), 'the record does not carry the cron text').not.toContain('30 2');
    }
    const quiet = await settledLogs({ 'attributes.{OriginalFormat}': NO_FUTURE_FIRE, 'attributes.WorkflowId': id.none! }, t0, t1, { floorMs: 0, settleOnEmpty: true, budgetMs: 20_000 });
    seen.noneWarnings = quiet.length;
    expect(quiet, 'no cron at all: no group, so no warning').toEqual([]);
    test.info().annotations.push({ type: 'running evidence', description: JSON.stringify(seen) });
  } finally {
    // stop whatever may still run (a stop of a stopped workflow is harmless); give a real stop time to land before the rows go
    if (anyStarted) {
      for (const w of run) await orchestrate('stop', w).catch(() => undefined);
      await sleep(started.length ? 15_000 : 2_000);
    }
  }
});
