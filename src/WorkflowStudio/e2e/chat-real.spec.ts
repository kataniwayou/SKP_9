import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import type { Judgement } from '../src/app/e2eJudge';
import { documentPanel, inspector, node, openWorkflow, tab, type LiveWorkflow } from './studio';
import { createChainThrowaway, createThrowaway, created, expect, removeThrowaway, test } from './throwaway';

// The chat's proficiency check with the real model (the user, 2026-10-23: the chat must be proficient at Studio design).
// Run only with KIMI_REAL=1 and the cluster's KIMI_BASE_URL / KIMI_MODEL_ID / KIMI_API_KEY in the environment of the
// Playwright command (vite proxies /ai with them). Each scenario runs on a fresh throwaway, Playwright typing into the
// chat as a user does, and is judged by the studio's own judges (window.__studioJudge: relationsOf, shortCircuitErrors,
// remainingProblemsOf). Every real run costs money. Results are appended, one JSON line per scenario, to CHAT_REAL_OUT.
test.skip(process.env.KIMI_REAL !== '1', 'the real-model check runs only with KIMI_REAL=1');
test.describe.configure({ mode: 'serial', retries: 0, timeout: 16 * 60_000 });

/** A processor that really exists in BaseApi (the cluster's), only referenced. */
const P = process.env.CHAT_REAL_PROCESSOR ?? 'kafka-exporter';
const OUT = process.env.CHAT_REAL_OUT ?? 'test-results/chat-real.jsonl';

test.afterEach(async ({ request }) => { await removeThrowaway(request); });
// each round's usage (the stream's last chunk), read from a copy of the answer as it streams: the studio's own read is
// not held up, so its silence timeout sees the stream as it is
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __rounds: number[]; fetch: typeof fetch };
    w.__rounds = [];
    const original = w.fetch.bind(window);
    w.fetch = async (input, init) => {
      const res = await original(input, init);
      if (String(input instanceof Request ? input.url : input).includes('/ai/chat/completions') && res.body) {
        void res.clone().text().then((body) => {
          const usage = [...body.matchAll(/"completion_tokens"\s*:\s*(\d+)/g)].at(-1);
          w.__rounds.push(usage ? Number(usage[1]) : -Math.round(body.length / 4));
        }, () => w.__rounds.push(0));
      }
      return res;
    };
  });
});

const judge = (page: Page): Promise<Judgement> => page.evaluate(() => (window as unknown as { __studioJudge(): Judgement }).__studioJudge());
const names = (j: Judgement) => new Map(j.steps.map((s) => [s.name.toLowerCase(), s]));
const sameJson = (a: string | null | undefined, b: string) => { try { return JSON.stringify(JSON.parse(a ?? '')) === JSON.stringify(JSON.parse(b)); } catch { return false; } };

interface Run { seconds: number; rounds: number; tokens: number; unread: number; reply: string; actions: string[]; failedActions: string[]; asked: string | null; destructive: string[]; called: string[] }
const DESTRUCTIVE = ['stop', 'delete_workflow', 'close_workflow', 'delete_picked', 'remove_assignment'];

/** Types `text` into the chat with the real keyboard and waits until the model is done; what it took and did. */
async function ask(page: Page, text: string): Promise<Run> {
  await page.evaluate(() => { (window as unknown as { __rounds: number[] }).__rounds = []; });
  await tab(page, 'Chat').click();
  const c = page.locator('[data-pane="chat"]');
  const before = await c.locator('.chat-e').count();
  await c.getByRole('textbox', { name: 'Message' }).click();
  await page.keyboard.type(text);
  const t0 = Date.now();
  await page.keyboard.press('Enter');
  await expect(c.locator('.chat-busy')).toBeVisible();
  await expect(c.locator('.chat-busy')).toHaveCount(0, { timeout: 15 * 60_000 });
  const seconds = Math.round((Date.now() - t0) / 1000);
  const tokens = await page.evaluate(() => (window as unknown as { __rounds: number[] }).__rounds);
  const entries = c.locator('.chat-e');
  const all = (await entries.evaluateAll((els) => els.map((e) => ({ cls: e.className, text: e.textContent ?? '' })))).slice(before);
  const question = c.getByRole('group', { name: 'Question' });
  const asked = (await question.count()) > 0 ? await question.innerText() : null;
  const wire = await page.evaluate(() => JSON.parse(sessionStorage.getItem('skp.studio.chat') ?? '{"wire":[]}').wire as { role: string; tool_calls?: { function: { name: string } }[] }[]);
  const called = wire.flatMap((m) => (m.role === 'assistant' ? (m.tool_calls ?? []).map((x) => x.function.name) : []));
  return {
    seconds, rounds: tokens.length, tokens: tokens.reduce((a, b) => a + Math.max(b, 0), 0), unread: tokens.filter((n) => n <= 0).length,
    reply: all.filter((e) => e.cls.includes('chat-model')).map((e) => e.text).join('\n---\n'),
    actions: all.filter((e) => e.cls.includes('chat-action')).map((e) => e.text),
    failedActions: all.filter((e) => e.cls.includes('chat-action') && e.cls.includes('err')).map((e) => e.text),
    asked, destructive: called.filter((n) => DESTRUCTIVE.includes(n)), called,
  };
}

/** Records one scenario's result and fails the test with the reasons when it did not pass. */
function report(scenario: string, run: Run, after: Judgement, reasons: string[]): void {
  // a Save may have made what the judge shows: removeThrowaway deletes these too (a 404 is fine)
  created.extraStepIds = [...(created.extraStepIds ?? []), ...after.steps.map((s) => s.id)];
  const line = { scenario, pass: reasons.length === 0, reasons, ...run, links: after.links, junctions: after.junctions, shorts: after.shorts, problems: after.problems, steps: after.steps.map(({ name, entryCondition, processor, x, y, payload }) => ({ name, entryCondition, processor, x, y, payload })) };
  appendFileSync(OUT, `${JSON.stringify(line)}\n`);
  expect(reasons, `${scenario}: ${JSON.stringify(line, null, 1)}`).toEqual([]);
}

/** The checks every scenario shares: no short circuit, the drawing tidy by the drawing judge, nothing destructive unasked. */
function common(after: Judgement, run: Run, problemsBefore: string[] = [], saveAsked = false): string[] {
  const reasons: string[] = [];
  const unasked = run.called.filter((n) => ['save', 'start', 'stop'].includes(n) && !(saveAsked && n === 'save'));
  if (unasked.length > 0) reasons.push(`unasked ${unasked.join(', ')}`);
  if (after.shorts.length > 0) reasons.push(`short circuits: ${after.shorts.join('; ')}`);
  const fresh = after.problems.filter((p) => !problemsBefore.includes(p));
  if (fresh.length > 0) reasons.push(`untidy: ${fresh.join('; ')}`);
  if (run.destructive.length > 0 && run.asked === null) reasons.push(`destructive calls ${run.destructive.join(', ')}`);
  if (run.reply.trim() === '') reasons.push('no reply');
  return reasons;
}

/** Links the asked ones must be exactly, by name; `optional` may also be there (an entry into the new first step). */
function linksCheck(after: Judgement, want: string[], optional: string[] = []): string[] {
  const have = after.links.map((l) => l.toLowerCase());
  const missing = want.filter((l) => !have.includes(l));
  const extra = have.filter((l) => !want.includes(l) && !optional.includes(l));
  return [...(missing.length ? [`missing links: ${missing.join(', ')}`] : []), ...(extra.length ? [`extra links: ${extra.join(', ')}`] : [])];
}

async function openChain(page: Page, request: APIRequestContext): Promise<{ wf: LiveWorkflow; s1: string }> {
  const ch = await createChainThrowaway(request, 1);
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
  await openWorkflow(page, ch.workflow);
  return { wf: ch.workflow, s1: `${ch.tag}-s1`.toLowerCase() };
}

test('1: a step with processor P, wired from the workflow, with an assignment payload {}', async ({ page, request }) => {
  const { s1 } = await openChain(page, request);
  const before = await judge(page);
  const run = await ask(page, `add a step with processor ${P} and wire it from the workflow; give it an assignment with payload {}`);
  const after = await judge(page);
  const added = after.steps.filter((s) => !before.steps.some((b) => b.id === s.id));
  const reasons = common(after, run, before.problems);
  if (added.length !== 1) reasons.push(`${added.length} steps added`);
  const n = added[0];
  if (n) {
    if (n.processor !== P) reasons.push(`processor ${n.processor}`);
    if (!sameJson(n.payload, '{}')) reasons.push(`payload ${n.payload}`);
    reasons.push(...linksCheck(after, [`workflow -> ${s1}`, `workflow -> ${n.name.toLowerCase()}`]));
    if (!run.reply.includes(n.name)) reasons.push(`the reply does not name step ${n.name}`);
  }
  report('1 add+wire+payload', run, after, reasons);
});

test('2: a chain a -> b -> c with processor P; c\'s failure goes to alarm', async ({ page, request }) => {
  const { s1 } = await openChain(page, request);
  const run = await ask(page, `build a chain of three steps a → b → c with processor ${P}; c's failure goes to a step named alarm`);
  const after = await judge(page);
  const by = names(after);
  const reasons = common(after, run);
  for (const n of ['a', 'b', 'c']) if (by.get(n)?.processor !== P) reasons.push(`step ${n}: processor ${by.get(n)?.processor}`);
  if (by.get('alarm')?.entryCondition !== 'Failed') reasons.push(`alarm: entry condition ${by.get('alarm')?.entryCondition}`);
  reasons.push(...linksCheck(after, [`workflow -> ${s1}`, 'a -> b', 'b -> c', 'c -> alarm'], ['workflow -> a', `${s1} -> a`]));
  if (!/alarm/.test(run.reply)) reasons.push('the reply does not name alarm');
  report('2 chain + failure', run, after, reasons);
});

test('3: a fans out to b and c, which both feed d (junctions)', async ({ page, request }) => {
  const { s1 } = await openChain(page, request);
  const run = await ask(page, 'a fans out to b and c, which both feed d');
  const after = await judge(page);
  const reasons = common(after, run);
  reasons.push(...linksCheck(after, [`workflow -> ${s1}`, 'a -> b', 'a -> c', 'b -> d', 'c -> d'], ['workflow -> a', `${s1} -> a`]));
  if (after.junctions < 2) reasons.push(`${after.junctions} junctions (a fan-out and a fan-in trunk want 2)`);
  report('3 fan-out/fan-in', run, after, reasons);
});

test('4: copy step b\'s assignment payload onto step c', async ({ page, request }) => {
  // b (payload {"k":7,"tags":["x"]}) -> c (no assignment), entry b
  const tag = `e2e-cr-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`;
  created.tag = tag;
  const post = async (kind: string, data: object) => {
    const r = await request.post(`/api/v1/${kind}`, { data });
    expect(r.status(), `POST ${kind}: ${await r.text()}`).toBe(201);
    return ((await r.json()) as { id: string }).id;
  };
  const proc = ((await (await request.get('/api/v1/processors')).json()) as { id: string; name: string }[]).find((p) => p.name === P)!;
  const c = await post('steps', { name: `${tag}-c`, version: '1.0.0', description: null, processorId: proc.id, nextStepIds: [], entryCondition: 1 });
  created.extraStepIds = [c];
  const b = await post('steps', { name: `${tag}-b`, version: '1.0.0', description: null, processorId: proc.id, nextStepIds: [c], entryCondition: 1 });
  created.extraStepIds.push(b);
  const asg = await post('assignments', { name: `${tag}-asg`, version: '1.0.0', description: null, stepId: b, payload: '{"k":7,"tags":["x"]}' });
  created.workflowId = await post('workflows', { name: tag, version: '1.0.0', description: null, entryStepIds: [b], assignmentIds: [asg], cacheIds: [], cronExpression: null });
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
  await openWorkflow(page, { id: created.workflowId, name: tag, version: '1.0.0', label: `${tag}_1.0.0-${created.workflowId.slice(19).toLowerCase()}` });
  const before = await judge(page);
  const run = await ask(page, `copy step ${tag}-b's assignment payload onto step ${tag}-c`);
  const after = await judge(page);
  const reasons = common(after, run, before.problems);
  if (after.relations !== before.relations) reasons.push('the relations changed');
  const cs = names(after).get(`${tag}-c`);
  if (!sameJson(cs?.payload, '{"k":7,"tags":["x"]}')) reasons.push(`c's payload ${cs?.payload}`);
  if (!sameJson(names(after).get(`${tag}-b`)?.payload, '{"k":7,"tags":["x"]}')) reasons.push('b\'s payload changed');
  if (!run.reply.includes(`${tag}-c`)) reasons.push('the reply does not name step c');
  report('4 copy payload', run, after, reasons);
});

test('5: "save it" on a design BaseApi refuses: the model reports the error and offers a fix', async ({ page, request }) => {
  const t = await createThrowaway(request);
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
  await openWorkflow(page, t.workflow);
  // the user's own edit, in the Inspector: a version BaseApi refuses
  const panel: Locator = documentPanel(page, t.workflow);
  await node(panel, t.stepId).click({ position: { x: 20, y: 12 } });
  await expect(inspector(page).locator('.kindpill')).toHaveText('STEP');
  await inspector(page).getByLabel('Version', { exact: true }).click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('abc');
  const before = await judge(page);
  const run = await ask(page, 'save it');
  const after = await judge(page);
  const reasons = common(after, run, before.problems, true);
  if (after.relations !== before.relations) reasons.push('the relations changed');
  const saveLines = run.actions.filter((a) => /sav/i.test(a));
  if (saveLines.length === 0) reasons.push('no save was run');
  if (run.failedActions.length === 0) reasons.push('no failed save shown');
  if (!/version/i.test(run.reply)) reasons.push('the reply does not report the version error');
  // it offers the fix and waits for the user's yes: one Save, nothing changed after it
  if (run.called.filter((n) => n === 'save').length !== 1) reasons.push(`saved ${run.called.filter((n) => n === 'save').length} times`);
  const changed = run.called.filter((n) => !n.startsWith('read_') && !n.startsWith('list_') && n !== 'save');
  if (changed.length > 0) reasons.push(`changed the design without the user's yes: ${changed.join(', ')}`);
  if (!/\?/.test(run.reply) || !/fix|set|change|1\.0\.0/i.test(run.reply)) reasons.push('the reply offers no fix as a question');
  report('5 save error', run, after, reasons);
});
