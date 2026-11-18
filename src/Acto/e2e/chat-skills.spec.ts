import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import {
  EXPANDER, NORMALIZER, caNode, cacheEdge, childLabels, entryEdge, expectDryRunMatches, ghost, openAt, out, rowNamed, rowsNamed,
  saveButton, stNode, tabLabels, wfNode, wireEdge,
} from './helpers';
import { seed } from './seed';
import { apply, bodyOf, getJson, type Row } from './stack';

// The chat's skills, against the deployed model (real, costs tokens). Each test types a plain-language instruction, as a user
// would, about throwaway e2e-chat-... rows only, waits for the answer, then checks the EFFECT on the board and, after a Save,
// in BaseAPI; never the wording of the reply, except where the point is what the reply says (a refusal quoted, the dry-run
// problems, what the Inspector shows, a question asked before acting). The guard (fixtures.ts) refuses Start/Stop and every
// processor or schema write; the run's teardown fails if a real row changed.
//
// The model's settings come from the environment of the Playwright process only (KIMI_API_KEY, KIMI_BASE_URL, KIMI_MODEL_ID):
// the Vite dev server proxies /ai with them. Without them every test here is skipped. Their values are never printed.

const slow = Number(process.env.ACTO_SLOWMO ?? 0) > 0;
const TURN = slow ? 600_000 : 300_000; // one model answer, tools included

test.describe.configure({ retries: 1 }); // the model is not deterministic: one retry, and a retried pass is reported as flaky

test.beforeEach(async ({ request }) => {
  const missing = ['KIMI_API_KEY', 'KIMI_BASE_URL', 'KIMI_MODEL_ID'].filter((k) => !process.env[k]);
  test.skip(missing.length > 0, `the chat is not configured: ${missing.join(', ')} not set in the environment`);
  const config = await request.get('/ai/config');
  test.skip(config.status() === 503, 'the chat is not configured (/ai/config answered 503)');
  test.setTimeout(slow ? 1_800_000 : 900_000);
});

const chatPanel = (page: Page) => page.locator('[data-panel="chat"]');

interface Turn { reply: string; actions: string[]; failed: string[]; asked: string[] }

/** The choice a test makes on a question of Acto's own (the buttons): by default it confirms Save/Delete/Remove and declines Stop. */
type Chooser = (question: string, choices: string[]) => string;
const confirm: Chooser = (_q, choices) => (choices.includes('Stop') ? 'Cancel' : choices.find((c) => c !== 'Cancel') ?? 'Cancel');

/**
 * Sends one message and waits until the model is done: every question Acto asks with buttons meanwhile is answered by
 * `choose`. Answers the new model texts, the tool lines (and the failed ones) and the questions asked, all for this turn.
 */
async function say(page: Page, text: string, choose: Chooser = confirm): Promise<Turn> {
  const chat = chatPanel(page);
  const box = chat.getByRole('textbox', { name: 'Message' });
  await expect(box).toBeEnabled({ timeout: 60_000 });
  const models0 = await chat.locator('.chat-model').count();
  const actions0 = await chat.locator('.chat-action').count();
  const users0 = await chat.locator('.chat-user').count();
  await box.fill(text);
  await box.press('Enter');
  await expect(chat.locator('.chat-user')).toHaveCount(users0 + 1);
  const stop = chat.getByRole('button', { name: 'Stop' });
  const question = chat.getByRole('group', { name: 'Question' });
  const asked: string[] = [];
  for (;;) {
    // busy (Stop shown) until it answers or asks
    await expect.poll(async () => (await question.count()) > 0 || (await stop.count()) === 0, { timeout: TURN, intervals: [500, 1000, 2000] }).toBe(true);
    if (await question.count() === 0) break;
    const q = await question.locator('.chat-q-text').innerText();
    const choices = await question.getByRole('button').allInnerTexts();
    const c = choose(q, choices);
    asked.push(`${q} [${choices.join('/')}] -> ${c}`);
    await question.getByRole('button', { name: c, exact: true }).click();
    await expect(question).toHaveCount(0);
  }
  const reply = (await chat.locator('.chat-model').allInnerTexts()).slice(models0).join('\n');
  const actionLoc = chat.locator('.chat-action');
  const all = await actionLoc.allInnerTexts();
  const classes = await actionLoc.evaluateAll((els) => els.map((e) => e.className));
  const actions = all.slice(actions0);
  const failed = actions.filter((_, i) => classes[actions0 + i]!.includes('err'));
  test.info().annotations.push({ type: 'chat', description: `> ${text}\n  tools: ${actions.join(' | ')}\n  asked: ${asked.join(' | ') || '-'}\n  reply: ${reply.slice(0, 700)}` });
  return { reply, actions, failed, asked };
}

const named = async (table: 'workflows' | 'steps' | 'caches' | 'assignments', name: string) => rowNamed(table, name);

/** A chain e2e-chat-s1 > s2 > s3 (archive-expander) entered by e2e-chat-a at s1; `withB` adds e2e-chat-b entering s2, payloads per workflow. */
async function seedChain(withB = false) {
  return seed({
    steps: [
      { key: 's1', name: 'e2e-chat-s1', at: { x: 300, y: 0 }, processor: EXPANDER, next: ['s2'] },
      { key: 's2', name: 'e2e-chat-s2', at: { x: 600, y: 0 }, processor: EXPANDER, next: ['s3'] },
      { key: 's3', name: 'e2e-chat-s3', at: { x: 900, y: 0 }, processor: EXPANDER },
    ],
    payloads: withB ? [{ key: 'pa', step: 's2', payload: '{"maxDepth": 2}' }, { key: 'pb', step: 's2', payload: '{"maxDepth": 5}' }] : [],
    workflows: [
      { key: 'a', name: 'e2e-chat-a', at: { x: 0, y: 0 }, entry: ['s1'], payloads: withB ? ['pa'] : [] },
      ...(withB ? [{ key: 'b', name: 'e2e-chat-b', at: { x: 0, y: 300 }, entry: ['s2'], payloads: ['pb'] }] : []),
    ],
  });
}

test('1 build: a workflow e2e-chat-a with three chained steps and an entry arrow, saved', async ({ page }) => {
  await openAt(page);
  await say(page, 'Build a new workflow called e2e-chat-a with three new steps named e2e-chat-s1, e2e-chat-s2 and e2e-chat-s3, all using the '
    + 'archive-expander processor. Chain them s1 -> s2 -> s3 and point the workflow\'s entry arrow at e2e-chat-s1. Then save the board.');

  const wf = await named('workflows', 'e2e-chat-a');
  const [s1, s2, s3] = await Promise.all(['e2e-chat-s1', 'e2e-chat-s2', 'e2e-chat-s3'].map((n) => named('steps', n)));
  expect(wf.entryStepIds).toEqual([s1!.id]);
  expect(s1!.nextStepIds).toEqual([s2!.id]);
  expect(s2!.nextStepIds).toEqual([s3!.id]);
  expect(s3!.nextStepIds).toEqual([]);
  for (const s of [s1!, s2!, s3!]) expect(s.processorId).toBe((await getJson<Row[]>('/processors')).find((p) => p.name === EXPANDER)!.id);
  // the board shows what BaseAPI holds, and nothing is left unsaved
  await expect(entryEdge(page, wf.id, s1!.id)).toHaveCount(1);
  await expect(wireEdge(page, s1!.id, s2!.id)).toHaveCount(1);
  await expect(wireEdge(page, s2!.id, s3!.id)).toHaveCount(1);
  await expect(saveButton(page)).toBeDisabled();
});

test('2 shared step: e2e-chat-b enters the middle step, and each workflow gets its own payload there', async ({ page }) => {
  const ids = await seedChain();
  await openAt(page);
  await say(page, 'Make a second workflow called e2e-chat-b whose entry arrow points at the existing step e2e-chat-s2, so it shares that step with '
    + 'e2e-chat-a. Then on step e2e-chat-s2 give e2e-chat-a the payload {"maxDepth": 2} and e2e-chat-b the payload {"maxDepth": 5}. Then save the board.');

  const a = await getJson<Row>(`/workflows/${ids.a}`);
  const b = await named('workflows', 'e2e-chat-b');
  expect(b.entryStepIds).toEqual([ids.s2]);
  expect(a.entryStepIds).toEqual([ids.s1]);
  const asg = await getJson<Row[]>('/assignments');
  const on = (w: Row) => asg.filter((x) => (w.assignmentIds as string[]).includes(x.id) && x.stepId === ids.s2);
  expect(on(a), 'e2e-chat-a has one payload on e2e-chat-s2').toHaveLength(1);
  expect(on(b), 'e2e-chat-b has one payload on e2e-chat-s2').toHaveLength(1);
  expect(on(a)[0]!.id).not.toBe(on(b)[0]!.id);
  expect(JSON.parse(on(a)[0]!.payload as string)).toEqual({ maxDepth: 2 });
  expect(JSON.parse(on(b)[0]!.payload as string)).toEqual({ maxDepth: 5 });
  await expect(entryEdge(page, b.id, ids.s2!)).toHaveCount(1);
  await expect(saveButton(page)).toBeDisabled();
});

test('3 caches: two new caches with roots, both linked to e2e-chat-a, saved', async ({ page }) => {
  const ids = await seedChain();
  await openAt(page);
  await say(page, 'Create two caches: e2e-chat-c1 with root e2e-chat-root1, and e2e-chat-c2 with root e2e-chat-root2. Link both of them to the '
    + 'workflow e2e-chat-a, then save the board.');

  const c1 = await named('caches', 'e2e-chat-c1');
  const c2 = await named('caches', 'e2e-chat-c2');
  expect(c1.root).toBe('e2e-chat-root1');
  expect(c2.root).toBe('e2e-chat-root2');
  const a = await getJson<Row>(`/workflows/${ids.a}`);
  expect([...(a.cacheIds as string[])].sort()).toEqual([c1.id, c2.id].sort());
  await expect(cacheEdge(page, ids.a!, c1.id)).toHaveCount(1);
  await expect(cacheEdge(page, ids.a!, c2.id)).toHaveCount(1);
  await expect(saveButton(page)).toBeDisabled();
});

test('4 cache items: one added, another removed, saved', async ({ page }) => {
  const ids = await seed({ caches: [{ key: 'c', name: 'e2e-chat-c4', at: { x: 0, y: 0 }, root: 'e2e-chat-c4' }] });
  // the seed writes items '{}': give it two items through the same runner
  const c = await getJson<Row>(`/caches/${ids.c}`);
  await apply([{ op: 'update', table: 'caches', id: c.id, row: { ...bodyOf(c), items: '{"keep":"1","drop":"2"}' }, updatedAt: c.updatedAt as string }]);
  await openAt(page);
  await expect(caNode(page, ids.c!)).toBeVisible();
  await say(page, 'In the cache e2e-chat-c4, add an item "color" with the value "blue" and remove the item "drop". Keep the item "keep". Then save the board.');

  const after = await getJson<Row>(`/caches/${ids.c}`);
  expect(JSON.parse(after.items as string)).toEqual({ keep: '1', color: 'blue' });
  await expect(saveButton(page)).toBeDisabled();
});

test('5 delete a step, then restore it: the step and its wires are back, nothing unsaved', async ({ page }) => {
  const ids = await seedChain();
  await openAt(page);
  await expect(stNode(page, ids.s3!)).toBeVisible();
  const del = await say(page, 'Delete the step e2e-chat-s3 from the board. Do not save.');
  expect(del.asked.length, 'Acto asked before the delete').toBeGreaterThan(0);
  await expect(stNode(page, ids.s3!)).toHaveCount(0);
  await expect(ghost(page, 'e2e-chat-s3')).toHaveCount(1);
  await expect(saveButton(page)).toBeEnabled();

  await say(page, 'I changed my mind: restore the step e2e-chat-s3.');
  await expect(stNode(page, ids.s3!)).toBeVisible();
  await expect(wireEdge(page, ids.s2!, ids.s3!)).toHaveCount(1);
  await expect(ghost(page, 'e2e-chat-s3')).toHaveCount(0);
  await expect(saveButton(page), 'the board is as stored again').toBeDisabled();
  expect((await getJson<Row>(`/steps/${ids.s3}`)).name).toBe('e2e-chat-s3');
});

test('6 save and report the dry run: the problems the chat reports are BaseAPI\'s validate problems', async ({ page }) => {
  const ids = await seed({
    steps: [{ key: 's', name: 'e2e-chat-d1', at: { x: 300, y: 0 }, processor: NORMALIZER }],
    payloads: [{ key: 'p', step: 's', payload: '{"handler": "Bogus"}' }],
    workflows: [{ key: 'w', name: 'e2e-chat-d', at: { x: 0, y: 0 }, entry: ['s'], payloads: ['p'] }],
  });
  await openAt(page);
  const t = await say(page, 'Set the description of workflow e2e-chat-d to "chat dry run", save the board, and tell me every problem the dry run '
    + 'reports for e2e-chat-d. Do not fix anything.');

  expect((await getJson<Row>(`/workflows/${ids.w}`)).description).toBe('chat dry run');
  const problems = await expectDryRunMatches(page, ids.w!, 'e2e-chat-d');
  expect(problems.length, 'the seed has a payload its config schema refuses').toBeGreaterThan(0);
  // every problem BaseAPI reports is in the reply, by its title or its detail
  const low = t.reply.toLowerCase();
  for (const p of problems) {
    const hit = [p.title, p.detail, p.gate].filter((s): s is string => !!s).some((s) => low.includes(s.toLowerCase().slice(0, 40)));
    expect(hit, `the reply reports "${p.title}: ${p.detail}"\nreply: ${t.reply}`).toBe(true);
  }
  // nothing fixed: the payload is as seeded
  const w = await getJson<Row>(`/workflows/${ids.w}`);
  expect((w.assignmentIds as string[])).toEqual([ids.p]);
  expect(JSON.parse((await getJson<Row>(`/assignments/${ids.p}`)).payload as string)).toEqual({ handler: 'Bogus' });
});

test('7 a save the database refuses (a workflow with no entry step): the chat reports the refusal, nothing saved', async ({ page }) => {
  await openAt(page);
  const t = await say(page, 'Create a new workflow named e2e-chat-empty with no steps and no entry arrow, and save the board right away. '
    + 'Do not add anything else.');

  expect(await rowsNamed('workflows', 'e2e-chat-empty'), 'nothing was saved').toHaveLength(0);
  expect(t.actions.some((a) => /save failed/.test(a)), `the save tool failed\n${t.actions.join('\n')}`).toBe(true);
  // the refusal Output showed (BaseAPI's words) and what the reply says of it
  const errors = await out(page).locator('[role="listitem"] span').allInnerTexts();
  test.info().annotations.push({ type: 'output', description: errors.join(' | ').slice(0, 1200) });
  expect(t.reply, 'the reply names the missing entry step').toMatch(/entry/i);
  expect(t.reply, 'the reply says it was not saved').toMatch(/not (been )?saved|refused|failed|rejected|could not|couldn't|was not/i);
  await expect(saveButton(page), 'the new workflow stays unsaved on the board').toBeEnabled();
});

const PICK = 'On the board, select the workflow e2e-chat-a and the step e2e-chat-s2 (only those two). Then tell me what the '
  + 'Inspector shows now: which tabs, and whose payload.';

test('8a pick a workflow and a step: the board selects exactly those two, and the Inspector shows Step · Processor with that workflow\'s assignment', async ({ page }) => {
  const ids = await seedChain(true);
  await openAt(page);
  await say(page, PICK);
  // rule 2: one workflow + one step -> Step · Processor, with that workflow's assignment under Step
  await expect(tabLabels(page)).toHaveText(['Step', 'Processor']);
  await expect(childLabels(page, 'Step')).toHaveText(['e2e-chat-a']);
  await expect(wfNode(page, ids.a!)).toHaveClass(/selected/);
  await expect(wfNode(page, ids.b!)).not.toHaveClass(/selected/);
});

// FIXME (chat gap, observed 2026-11-18, 2 of 2 tries): the pick is right (8a passes) but the reply describes an Inspector that does
// not exist. Observed: "the Inspector shows the Workflow tab and the Step tab" (try 1) and "tabs for both: the workflow tab ... and the
// step tab" (try 2), and it calls e2e-chat-b's payload {"maxDepth": 5} "sits on the same step". Expected (inspector-tabs spec §5 rule 2):
// Step · Processor, with the one child tab "e2e-chat-a" (its assignment) under Step; no Workflow tab. Cause: the system prompt and the
// tools say nothing of rules 1-3 and no tool reads the picks or the Inspector, so the model guesses from the older single-panel design.
test.fixme('8b pick a workflow and a step: the reply says what the Inspector shows, by rule 2 (Step · Processor, e2e-chat-a\'s assignment)', async ({ page }) => {
  await seedChain(true);
  await openAt(page);
  const t = await say(page, PICK);
  const low = t.reply.toLowerCase();
  expect(low, 'the reply names the Step tab').toContain('step');
  expect(low, 'the reply names the Processor tab').toContain('processor');
  expect(t.reply, 'the reply does not invent a Workflow tab').not.toMatch(/workflow tab/i);
  expect(t.reply, 'the reply names e2e-chat-a\'s payload on the step').toMatch(/e2e-chat-a[^\n]*(payload|assignment)|(payload|assignment)[^\n]*e2e-chat-a/i);
});

// FIXME (chat gap, observed 2026-11-18, 2 of 2 tries): asked "Start the workflow e2e-chat-run.", the model called `start` at once, with
// no question; the guard aborted POST /orchestration/start (it never reached BaseAPI), and the model reported "Start failed — Network
// error: Failed to fetch" as a connectivity problem. Expected (the user's ask-first rule for running a workflow): a question first
// (Acto's buttons or in words), no start request until the user confirms; "no" leaves it stopped. Cause: `start` is not in DESTRUCTIVE
// (src/chat/tools.ts) and the prompt's rule 9 lets the model start whenever the user asked. Note: the user-approved destructive list
// (docs/superpowers/specs/2026-10-23-skp-studio-11-chat-pane-design.md, "Destructive operations") has Stop but not Start, so this
// expectation needs the user's ruling (add Start to the list) before it can pass.
test.fixme('9 start asks first: the chat does not start a workflow without confirmation; "no" leaves it stopped', async ({ page }) => {
  await seed({
    steps: [{ key: 's', name: 'e2e-chat-r1', at: { x: 300, y: 0 }, processor: NORMALIZER }],
    payloads: [{ key: 'p', step: 's', payload: '{"handler": "Acme"}' }],
    workflows: [{ key: 'w', name: 'e2e-chat-run', at: { x: 0, y: 0 }, entry: ['s'], payloads: ['p'] }],
  });
  const runs: string[] = [];
  page.on('request', (r) => { const p = new URL(r.url()).pathname; if (/\/(start|stop)$/i.test(p)) runs.push(`${r.method()} ${p}`); });
  await openAt(page);
  // a question with buttons is declined; a question in words is answered "no"
  const t = await say(page, 'Start the workflow e2e-chat-run.', () => 'Cancel');
  const askedInWords = /\?/.test(t.reply);
  expect(runs, 'no start went out before the user confirmed').toEqual([]);
  expect(t.asked.length > 0 || askedInWords, `the chat asked first\nreply: ${t.reply}`).toBe(true);
  if (t.asked.length === 0) await say(page, 'no', () => 'Cancel');
  expect(runs, 'no start after "no"').toEqual([]);
});
