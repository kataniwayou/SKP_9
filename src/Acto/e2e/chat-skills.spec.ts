import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import {
  EXPANDER, NORMALIZER, allSteps, allWorkflows, caNode, cacheEdge, childLabels, entryEdge, expectSaveChecksNothing, ghost, openAt, out, rowNamed, rowsNamed,
  openFitted, saveButton, stNode, tabLabels, wfNode, wireEdge,
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

/**
 * The choice a test makes on a question of Acto's own: a button's text, or `type:<text>` to type the answer in the message box (a
 * typed yes/no answers it). By default it confirms Save/Delete/Remove/Take stored and declines Start and Stop: never a real run.
 */
type Chooser = (question: string, choices: string[]) => string;
const confirm: Chooser = (_q, choices) => (choices.includes('Stop') || choices.includes('Start') ? 'Cancel' : choices.find((c) => c !== 'Cancel') ?? 'Cancel');

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
    if (c.startsWith('type:')) {
      await box.fill(c.slice('type:'.length));
      await box.press('Enter');
    } else await question.getByRole('button', { name: c, exact: true }).click();
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

test('6 save, then check_workflow: the problems the chat reports are what a Start would refuse (BaseAPI\'s validate problems)', async ({ page }) => {
  const ids = await seed({
    steps: [{ key: 's', name: 'e2e-chat-d1', at: { x: 300, y: 0 }, processor: NORMALIZER }],
    payloads: [{ key: 'p', step: 's', payload: '{"handler": "Bogus"}' }],
    workflows: [{ key: 'w', name: 'e2e-chat-d', at: { x: 0, y: 0 }, entry: ['s'], payloads: ['p'] }],
  });
  await openAt(page);
  const t = await say(page, 'Set the description of workflow e2e-chat-d to "chat dry run", save the board, then check what a Start of e2e-chat-d would refuse and tell me every problem '
    + 'it names. Do not fix anything.');

  expect((await getJson<Row>(`/workflows/${ids.w}`)).description).toBe('chat dry run');
  const problems = await expectSaveChecksNothing(page, ids.w!, 'e2e-chat-d');
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

// 8b was a fixme until read_selection and the prompt's selection rules (2026-11-18 audit G4): the reply described a Workflow tab
// and a Step tab. Now the model reads the Inspector's own tab rules.
test('8b pick a workflow and a step: the reply says what the Inspector shows, by rule 2 (Step · Processor, e2e-chat-a\'s assignment)', async ({ page }) => {
  await seedChain(true);
  await openAt(page);
  const t = await say(page, PICK);
  expect(t.actions.some((a) => /read selection/.test(a)), `it read the selection\n${t.actions.join('\n')}`).toBe(true);
  const low = t.reply.toLowerCase();
  expect(low, 'the reply names the Step tab').toContain('step');
  expect(low, 'the reply names the Processor tab').toContain('processor');
  expect(t.reply, 'the reply does not invent a Workflow tab').not.toMatch(/workflow tab/i);
  expect(t.reply, 'the reply names e2e-chat-a\'s payload on the step').toMatch(/e2e-chat-a[^\n]*(payload|assignment)|(payload|assignment)[^\n]*e2e-chat-a/i);
});

// 9 was a fixme until Start joined the ask-first list [user, 2026-11-18] (audit G7): the model called start at once. Now Acto asks
// with buttons and the test answers by typing "no" in the message box (audit G8). The guard still aborts any start request.
test('9 start asks first: the chat does not start a workflow without confirmation; "no" leaves it stopped', async ({ page }) => {
  await seed({
    steps: [{ key: 's', name: 'e2e-chat-r1', at: { x: 300, y: 0 }, processor: NORMALIZER }],
    payloads: [{ key: 'p', step: 's', payload: '{"handler": "Acme"}' }],
    workflows: [{ key: 'w', name: 'e2e-chat-run', at: { x: 0, y: 0 }, entry: ['s'], payloads: ['p'] }],
  });
  const runs: string[] = [];
  page.on('request', (r) => { const p = new URL(r.url()).pathname; if (/\/(start|stop)$/i.test(p)) runs.push(`${r.method()} ${p}`); });
  await openAt(page);
  const t = await say(page, 'Start the workflow e2e-chat-run.', () => 'type:no');
  expect(runs, 'no start request went out').toEqual([]);
  expect(t.asked.length, `Acto asked before the start\nreply: ${t.reply}`).toBeGreaterThan(0);
  expect(t.asked[0]).toMatch(/^Start e2e-chat-run\?/);
  expect(t.actions.some((a) => /user declined: start/.test(a)), `the typed no declined it\n${t.actions.join('\n')}`).toBe(true);
  await expect(chatPanel(page).getByRole('group', { name: 'Question' })).toHaveCount(0);
});

test('10 assignment fields: e2e-chat-a\'s payload row on the shared step gets a name and a description of its own, saved', async ({ page }) => {
  const ids = await seedChain(true);
  await openAt(page);
  await say(page, 'On step e2e-chat-s2, rename e2e-chat-a\'s payload (its assignment) to e2e-chat-pay-a2 and give it the description "for a only". '
    + 'Leave e2e-chat-b\'s payload alone. Then save the board.');
  const a = await getJson<Row>(`/workflows/${ids.a}`);
  const b = await getJson<Row>(`/workflows/${ids.b}`);
  const mine = await getJson<Row>(`/assignments/${(a.assignmentIds as string[])[0]}`);
  expect(mine).toMatchObject({ name: 'e2e-chat-pay-a2', description: 'for a only', stepId: ids.s2 });
  expect(JSON.parse(mine.payload as string)).toEqual({ maxDepth: 2 });
  const theirs = await getJson<Row>(`/assignments/${(b.assignmentIds as string[])[0]}`);
  expect(theirs.name).toBe('e2e-pay-pb');
  await expect(saveButton(page)).toBeDisabled();
});

test('11 ghosts: a step deleted and saved comes back through the chat (a new row), and another ghost is removed', async ({ page }) => {
  const ids = await seedChain();
  await openAt(page);
  await say(page, 'Delete the steps e2e-chat-s3 and e2e-chat-s2 from the board, then save the board.');
  await expect(stNode(page, ids.s3!)).toHaveCount(0);
  await expect(ghost(page, 'e2e-chat-s3')).toHaveCount(1);
  await expect(ghost(page, 'e2e-chat-s2')).toHaveCount(1);
  expect(await rowsNamed('steps', 'e2e-chat-s3')).toHaveLength(0);

  // undo cannot bring it back now (the delete is saved): only the ghost can
  const t = await say(page, 'Bring back the deleted step e2e-chat-s3, and drop the faded ghost of e2e-chat-s2 from the board. Then save the board.');
  expect(t.actions.some((a) => /restore ghosts/.test(a)), `restore_ghosts ran\n${t.actions.join('\n')}`).toBe(true);
  const s3 = await named('steps', 'e2e-chat-s3');
  expect(s3.id, 'a new row: the old one was deleted').not.toBe(ids.s3);
  await expect(stNode(page, s3.id)).toBeVisible();
  await expect(ghost(page, 'e2e-chat-s3')).toHaveCount(0);
  await expect(ghost(page, 'e2e-chat-s2')).toHaveCount(0);
  expect(await rowsNamed('steps', 'e2e-chat-s2'), 'removing a ghost changes nothing in BaseAPI').toHaveLength(0);
  await expect(saveButton(page)).toBeDisabled();
});

test('12 an unsaved cache: its items are edited from the board\'s value, not the stored one', async ({ page }) => {
  await openAt(page);
  await say(page, 'Create a cache e2e-chat-c5 with root e2e-chat-r5 and the items a = 1 and keep = yes. Do not save yet.');
  await expect(saveButton(page)).toBeEnabled();
  expect(await rowsNamed('caches', 'e2e-chat-c5')).toHaveLength(0);
  await say(page, 'In the cache e2e-chat-c5, change item a to 2 and add the item b = 3. Then save the board.');
  const c = await named('caches', 'e2e-chat-c5');
  expect(c.root).toBe('e2e-chat-r5');
  expect(JSON.parse(c.items as string)).toEqual({ a: '2', keep: 'yes', b: '3' });
});

test('13 Take stored: a save refused because the row changed elsewhere; the chat takes the stored version', async ({ page }) => {
  const ids = await seedChain();
  await openAt(page);
  await say(page, 'Set the description of workflow e2e-chat-a to "mine". Do not save.');
  await expect(saveButton(page)).toBeEnabled();
  // someone else changes the same row meanwhile
  const w = await getJson<Row>(`/workflows/${ids.a}`);
  await apply([{ op: 'update', table: 'workflows', id: w.id, row: { ...bodyOf(w), description: 'theirs' }, updatedAt: w.updatedAt as string }]);

  const refused = await say(page, 'Save the board.');
  expect(refused.actions.some((a) => /save failed/.test(a)), `the save was refused\n${refused.actions.join('\n')}`).toBe(true);
  expect((await getJson<Row>(`/workflows/${ids.a}`)).description).toBe('theirs');
  const t = await say(page, 'Drop my change and take the stored version of what changed elsewhere.');
  expect(t.asked.some((q) => /^Take the stored/.test(q)), `Acto asked first\n${t.asked.join('\n')}`).toBe(true);
  await expect(saveButton(page), 'nothing unsaved is left').toBeDisabled();
  expect((await getJson<Row>(`/workflows/${ids.a}`)).description).toBe('theirs');
});

test('14 add_cache with its name and root in one call, saved', async ({ page }) => {
  await openAt(page);
  const t = await say(page, 'Create a cache named e2e-chat-c6 with the root e2e-chat-r6 and save the board.');
  expect(t.actions, 'one add_cache named it').toContain('add cache e2e-chat-c6');
  const c = await named('caches', 'e2e-chat-c6');
  expect(c.root).toBe('e2e-chat-r6');
  await expect(caNode(page, c.id)).toBeVisible();
});

test('15 a new payload laid out as ＋ Create does: the chat makes it from the config schema, names the fields to fill, then fills them and saves [user, 2026-11-19]', async ({ page }) => {
  const id = await seed({
    steps: [{ key: 'f', name: 'e2e-chat-f1', at: { x: 300, y: 0 }, processor: 'file-fetcher' }],
    workflows: [{ key: 'a', name: 'e2e-chat-a', at: { x: 0, y: 0 }, entry: ['f'] }],
  });
  await openAt(page);
  const t = await say(page, 'Create the payload of workflow e2e-chat-a on step e2e-chat-f1 the way the Inspector\'s Create button does, '
    + 'and tell me which fields I still have to fill in. Do not save.');
  expect(t.actions, 'set_payload without a payload laid it out').toContain('made payload on e2e-chat-f1');
  // file-fetcher-config: two required integers (placeholders) and an optional array: three keys (the triangle picked shows its chip), nothing saved
  await wfNode(page, id.a!).locator('.tri-nm').click();
  await expect(stNode(page, id.f!).locator('.key-chip')).toContainText('3 keys');
  for (const field of ['minimumSizeBytes', 'maximumSizeBytes']) expect(t.reply, `the reply names ${field}`).toContain(field);
  expect((await rowsNamed('assignments', 'e2e-chat-f1-assignment'))).toHaveLength(0);

  await say(page, 'Set minimumSizeBytes to 0 and maximumSizeBytes to 1024 in that payload, keep the rest, and save the board.');
  const wf = await named('workflows', 'e2e-chat-a');
  const rows = (await getJson<Row[]>('/assignments')).filter((a) => (wf.assignmentIds as string[]).includes(a.id));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.name).toBe('e2e-chat-f1-assignment');
  expect(JSON.parse(rows[0]!.payload as string)).toMatchObject({ minimumSizeBytes: 0, maximumSizeBytes: 1024 });
});

// [user, 2026-11-23 rev 2] the workflow-state rules, free-style Save and the copy rule, through the chat

/** Declines every question: these tests must never delete, start or stop anything real. */
const decline: Chooser = () => 'Cancel';

test('16 a running workflow cannot be deleted: the chat\'s delete is refused before any question, the row stays', async ({ page }) => {
  await openFitted(page);
  await expect.poll(async () => page.locator('.tri-st[data-status]').count(), { timeout: 30_000 }).toBeGreaterThan(0);
  const running = page.locator('.react-flow__node-workflow:has(.tri-st[data-status="running"])').first();
  test.skip(await running.count() === 0, 'the cluster runs no workflow now: nothing running to try');
  const id = (await running.getAttribute('data-id'))!.slice('wf:'.length);
  const name = (await getJson<Row>(`/workflows/${id}`)).name as string;
  const t = await say(page, `Delete the workflow ${name} (id ${id}). Do nothing else.`, decline);

  // the model may call the delete (refused by the tool) or, having read Running, not call it at all: never a delete that goes
  const deletes = t.actions.filter((a) => /^delete/.test(a));
  expect(deletes.every((a) => /refused/.test(a)), `every delete tool call was refused\n${t.actions.join('\n')}`).toBe(true);
  expect(t.asked.some((q) => q.includes('[Delete/')), 'no Delete question was asked').toBe(false);
  await expect(wfNode(page, id)).toHaveCount(1);
  expect((await getJson<Row>(`/workflows/${id}`)).id).toBe(id);
});

test('17 a never-saved workflow cannot be started: the chat\'s start is refused before any question', async ({ page }) => {
  await openAt(page);
  const t = await say(page, 'Create a new workflow named e2e-chat-ns, do not save it, and start it right away.', decline);

  expect(t.asked.some((q) => q.includes('[Start/')), 'no Start question was asked').toBe(false);
  expect(t.actions.some((a) => /start e2e-chat-ns refused/.test(a)) || /save/i.test(t.reply), `start refused, or the reply says to save first\n${t.actions.join('\n')}\n${t.reply}`).toBe(true);
  expect(await rowsNamed('workflows', 'e2e-chat-ns'), 'nothing was saved').toHaveLength(0);
});

test('18 free style: a design with a cycle saves; check_workflow names the cycle', async ({ page }) => {
  const ids = await seed({
    steps: [
      { key: 'c1', name: 'e2e-chat-c1', at: { x: 300, y: 0 }, processor: EXPANDER, next: ['c2'] },
      { key: 'c2', name: 'e2e-chat-c2', at: { x: 600, y: 0 }, processor: EXPANDER },
    ],
    workflows: [{ key: 'w', name: 'e2e-chat-c', at: { x: 0, y: 0 }, entry: ['c1'] }],
  });
  await openAt(page);
  const t = await say(page, 'Wire step e2e-chat-c2 back to step e2e-chat-c1 (a loop), save the board, then check what a Start of e2e-chat-c would refuse '
    + 'and tell me every problem. Do not fix anything.');

  expect((await getJson<Row>(`/steps/${ids.c2}`)).nextStepIds, 'the cycle was saved').toEqual([ids.c1]);
  expect(t.actions.some((a) => /checked e2e-chat-c/.test(a)), `check_workflow ran\n${t.actions.join('\n')}`).toBe(true);
  expect(t.reply, 'the reply names the cycle').toMatch(/cycl|loop/i);
  await expect(saveButton(page)).toBeDisabled();
});

test('19 a workflow copied alone pastes alone: no entry arrows, cache lines or payloads', async ({ page }) => {
  const ids = await seedChain();
  await openAt(page);
  await expect(wfNode(page, ids.a!)).toHaveCount(1);
  const wfs0 = await allWorkflows(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-id')));
  const steps0 = await allSteps(page).count();
  await say(page, 'Copy only the workflow e2e-chat-a (not its steps or caches) and paste it once. Do not save.');

  await expect.poll(async () => allWorkflows(page).count()).toBe(wfs0.length + 1);
  const wfs1 = await allWorkflows(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-id')));
  const pasted = wfs1.find((x) => !wfs0.includes(x))!.slice('wf:'.length);
  expect(await allSteps(page).count(), 'no step was pasted').toBe(steps0);
  await expect(page.locator(`.react-flow__edge[data-id^="entry:${pasted}:"]`)).toHaveCount(0);
  await expect(page.locator(`.react-flow__edge[data-id^="cache:${pasted}:"]`)).toHaveCount(0);
  await expect(entryEdge(page, ids.a!, ids.s1!), 'the original keeps its arrow').toHaveCount(1);
  await expect(saveButton(page), 'the paste is unsaved').toBeEnabled();
});
