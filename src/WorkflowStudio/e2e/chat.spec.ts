import type { Locator, Page, Route } from '@playwright/test';
import { box, documentPanel, emptySpot, groupOf, newWires, node, openWorkflow, pane, tab } from './studio';
import { createThrowaway, expect, removeThrowaway, test, type Throwaway } from './throwaway';

// The Chat pane (2026-10-23), with the real mouse: the model is scripted — the studio's own /ai route answered here as an
// event stream that carries tool_calls the way Kimi streams them (by index: the first piece has id and name, the rest
// argument fragments; usage as a chunk of its own) — so no model is called and no key is needed. Only this run's
// throwaway is opened; the one Save (the echo test, last) writes this throwaway's design only.
test.describe.configure({ mode: 'serial', retries: 0 });
let t: Throwaway;

/** One scripted answer of the model: its text, its tool calls, the tokens its usage chunk reports, a delay before it. */
interface Turn { text?: string; calls?: { name: string; args: object }[]; tokens?: number; delayMs?: number }
let script: Turn[] = [];
let sent: { messages: { role: string; content?: string; tool_call_id?: string }[] }[] = [];

const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const delta = (d: object) => ev({ choices: [{ delta: d }] });

/** A turn as Kimi streams it: a thought, the text in two pieces, each call by index in pieces, the usage, [DONE]. */
function streamOf(turn: Turn, round: number): string {
  let body = delta({ reasoning_content: 'thinking it over' });
  const text = turn.text ?? '';
  if (text !== '') body += delta({ content: text.slice(0, text.length >> 1) }) + delta({ content: text.slice(text.length >> 1) });
  (turn.calls ?? []).forEach((c, index) => {
    body += delta({ tool_calls: [{ index, id: `call-${round}-${index}`, type: 'function', function: { name: c.name, arguments: '' } }] });
    const args = JSON.stringify(c.args);
    for (const piece of [args.slice(0, args.length >> 1), args.slice(args.length >> 1)]) body += delta({ tool_calls: [{ index, function: { arguments: piece } }] });
  });
  body += ev({ choices: [], usage: { completion_tokens: turn.tokens ?? 40 } });
  return `${body}data: [DONE]\n\n`;
}

test.beforeAll(async ({ request }) => { t = await createThrowaway(request); });
test.afterAll(async ({ request }) => { await removeThrowaway(request); });
test.beforeEach(async ({ page }) => {
  script = [];
  sent = [];
  // the model the studio's environment names; routes on the page outlive a reload
  await page.route('**/ai/config', (route: Route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"model":"kimi-k3"}' }));
  await page.route('**/ai/chat/completions', async (route: Route) => {
    sent.push(route.request().postDataJSON());
    const round = sent.length;
    const turn = script.shift() ?? { text: 'out of script' };
    if (turn.delayMs) await new Promise((r) => setTimeout(r, turn.delayMs));
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: streamOf(turn, round) });
  });
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
});

/** The Chat pane, brought to the front by its tab. */
async function chat(page: Page): Promise<Locator> {
  await tab(page, 'Chat').click();
  return page.locator('[data-pane="chat"]');
}
/** Writes a message with the real keyboard, Enter sends. */
async function say(page: Page, text: string): Promise<void> {
  const c = await chat(page);
  await c.getByRole('textbox', { name: 'Message' }).click();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}
const lastModel = (c: Locator) => c.locator('.chat-model').last();
const steps = (panel: Locator) => panel.locator('.react-flow__node-step');
const draftMark = (page: Page) => page.getByText('● design draft');
const posOf = (panel: Locator, id: string) => node(panel, id).evaluate((e) => {
  const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec((e as HTMLElement).style.transform)!;
  return [Number(m[1]), Number(m[2])] as [number, number];
});

test('build: a step with the throwaway\'s processor, wired from the workflow, its payload set; the canvas grows while the status counts tokens; Ctrl+Z takes the assignment, then the wire', async ({ page }) => {
  await openWorkflow(page, t.workflow);
  const panel = documentPanel(page, t.workflow);
  await expect(steps(panel)).toHaveCount(2);
  script = [
    { tokens: 1200, calls: [
      { name: 'add_step', args: { processor: `${t.tag}-proc` } },
      { name: 'connect', args: { from: 'workflow', to: 'step' } },
      { name: 'create_assignment', args: { step: 'step' } },
      { name: 'set_field', args: { target: { kind: 'assignment', step: 'step' }, field: 'payload', value: '{"k":1}' } },
    ] },
    { delayMs: 3000, text: 'Added step step 1.0.0, wired it from the workflow and gave its assignment the payload {"k":1}.' },
  ];
  await say(page, 'add a step with our processor, wire it from the workflow, payload {"k":1}');
  const c = page.locator('[data-pane="chat"]');
  // while the second round is on its way: the new step and its wire are on the canvas, the status line counts the first round
  await expect(steps(panel)).toHaveCount(3);
  await expect(newWires(panel)).toHaveCount(1);
  await expect(c.getByRole('status')).toContainText('↓ 1.2k tokens');
  await expect(c.getByRole('button', { name: 'Stop' })).toBeVisible();
  await expect(c.getByRole('textbox', { name: 'Message' })).toBeDisabled();
  await expect(lastModel(c)).toHaveText(/Added step step 1\.0\.0/, { timeout: 15_000 });
  await expect(c.getByRole('status')).toHaveCount(0);
  // one line per action, none failed
  await expect(c.locator('.chat-action')).toHaveCount(4);
  await expect(c.locator('.chat-action.err')).toHaveCount(0);
  await expect(c.locator('.chat-action').first()).toContainText(`+ step step with processor ${t.tag}-proc`);
  await expect(c.locator('.chat-action').nth(1)).toContainText('wired workflow → step (Completed)');
  // the second request handed each call's answer back by its id
  expect(sent).toHaveLength(2);
  expect(sent[1]!.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)).toEqual(['call-1-0', 'call-1-1', 'call-1-2', 'call-1-3']);
  await expect(draftMark(page)).toBeVisible();
  // creating the assignment is the last Undo step (2026-10-23), the wire the one before: Ctrl+Z on the canvas takes them
  // in turn, the step stays
  const spot = await emptySpot(panel);
  await page.mouse.click(spot.x, spot.y);
  await expect(sent[1]!.messages.filter((m) => m.role === 'tool').at(-2)!.content).toContain('assignment');
  await page.keyboard.press('Control+z');
  await expect(newWires(panel)).toHaveCount(1);
  await page.keyboard.press('Control+z');
  await expect(newWires(panel)).toHaveCount(0);
  await expect(steps(panel)).toHaveCount(3);
  await page.keyboard.press('Control+y');
  await page.keyboard.press('Control+y');
  await expect(newWires(panel)).toHaveCount(1);
});

test('a destructive call asks in the chat, with no pop-up: No keeps the step; asked again, Yes deletes it', async ({ page }) => {
  await openWorkflow(page, t.workflow);
  const panel = documentPanel(page, t.workflow);
  // add_step leaves the new step picked: delete_picked asks to delete it
  script = [
    { calls: [{ name: 'add_step', args: {} }, { name: 'delete_picked', args: {} }] },
    { text: 'Kept your changes.' },
    { calls: [{ name: 'delete_picked', args: {} }] },
    { text: 'Deleted the step.' },
  ];
  await say(page, 'add a step, then delete it');
  const c = page.locator('[data-pane="chat"]');
  const question = c.getByRole('group', { name: 'Question' });
  await expect(question).toContainText(`Delete step step from ${t.workflow.name} ${t.workflow.version}?`);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(steps(panel)).toHaveCount(3);
  expect(sent).toHaveLength(1);
  await question.getByRole('button', { name: 'No' }).click();
  await expect(lastModel(c)).toHaveText('Kept your changes.');
  await expect(question).toHaveCount(0);
  await expect(draftMark(page)).toBeVisible();
  await expect(steps(panel)).toHaveCount(3);
  expect(sent[1]!.messages.filter((m) => m.role === 'tool').at(-1)!.content).toContain('declined');
  await say(page, 'now delete it');
  await expect(question).toBeVisible();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await question.getByRole('button', { name: 'Yes' }).click();
  await expect(lastModel(c)).toHaveText('Deleted the step.');
  await expect(steps(panel)).toHaveCount(2);
});

test('an open question survives a refresh: Yes after the reload carries out the call and the loop\'s next turn arrives', async ({ page }) => {
  await openWorkflow(page, t.workflow);
  script = [
    { calls: [{ name: 'add_step', args: {} }, { name: 'remove_assignment', args: { step: t.stepName } }] },
    { text: 'Removed after your refresh.' },
  ];
  await say(page, 'add a step, then remove the first step\'s assignment');
  const question = page.locator('[data-pane="chat"]').getByRole('group', { name: 'Question' });
  await expect(question).toBeVisible();
  await page.reload();
  const panel = documentPanel(page, t.workflow);
  await expect(steps(panel)).toHaveCount(3);
  await expect(draftMark(page)).toBeVisible();
  const c = await chat(page);
  await expect(c.getByRole('group', { name: 'Question' })).toContainText(`Remove the assignment of step ${t.stepName} from ${t.workflow.name} ${t.workflow.version}?`);
  await expect(c.locator('.chat-user').first()).toHaveText('add a step, then remove the first step\'s assignment');
  await c.getByRole('group', { name: 'Question' }).getByRole('button', { name: 'Yes' }).click();
  await expect(lastModel(c)).toHaveText('Removed after your refresh.');
  await expect(c.locator('.chat-action').last()).toContainText(`- assignment of ${t.stepName}`);
  await expect(steps(panel)).toHaveCount(3);
  expect(sent).toHaveLength(2);
  expect(sent[1]!.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)).toEqual(['call-1-0', 'call-1-1']);
});

test('no lock: while the model\'s turn is on its way the user drags a block, it moves; the model\'s step lands too', async ({ page }) => {
  await openWorkflow(page, t.workflow);
  const panel = documentPanel(page, t.workflow);
  script = [{ delayMs: 2000, calls: [{ name: 'add_step', args: {} }] }, { text: 'Added step step.' }];
  await say(page, 'add an empty step');
  const c = page.locator('[data-pane="chat"]');
  await expect(c.getByRole('status')).toBeVisible();
  const before = await posOf(panel, t.stepBId);
  const grip = await box(node(panel, t.stepBId).locator('.nx-sn'));
  await page.mouse.move(grip.x + 10, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + 10, grip.y + grip.height / 2 + 160, { steps: 12 });
  await page.mouse.up();
  await expect.poll(() => posOf(panel, t.stepBId)).not.toEqual(before);
  // the drag happened while the chat was still busy
  await expect(c.getByRole('status')).toBeVisible();
  await expect(lastModel(c)).toHaveText('Added step step.');
  await expect(steps(panel)).toHaveCount(3);
  expect(await posOf(panel, t.stepBId)).not.toEqual(before);
});

test('the Chat pane floats and docks back like the others; New chat empties it', async ({ page }) => {
  await openWorkflow(page, t.workflow);
  await chat(page);
  const before = await box(groupOf(page, 'Chat'));
  await tab(page, 'Chat').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^⧉\s*Float/ }).click();
  await expect(page.locator('.dv-resize-container').filter({ has: tab(page, 'Chat') })).toBeVisible();
  await tab(page, 'Chat').dblclick({ modifiers: ['Control'] });
  await expect(page.locator('.dv-resize-container').filter({ has: tab(page, 'Chat') })).toHaveCount(0);
  const after = await box(groupOf(page, 'Chat'));
  for (const k of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(after[k] - before[k])).toBeLessThanOrEqual(2);
  script = [{ text: 'Hello.' }];
  await say(page, 'hello');
  const c = page.locator('[data-pane="chat"]');
  await expect(lastModel(c)).toHaveText('Hello.');
  await c.getByRole('button', { name: 'New chat' }).click();
  await expect(c.locator('.chat-e')).toHaveCount(0);
  await expect(c.getByText('Ask for a change to the open workflow')).toBeVisible();
});

// last: its Save stores a refused design on the throwaway, which the other tests would open
test('echo: a Save BaseApi refuses shows in the chat with the very red lines Output shows', async ({ page }) => {
  await openWorkflow(page, t.workflow);
  script = [
    { calls: [
      { name: 'set_field', args: { target: { kind: 'step', step: t.stepName }, field: 'version', value: 'abc' } },
      { name: 'save', args: {} },
    ] },
    { text: 'Save was refused: BaseApi says the version is not valid. Shall I set it back to 1.0.0?' },
  ];
  await say(page, `give ${t.stepName} version abc and save`);
  const c = page.locator('[data-pane="chat"]');
  await expect(lastModel(c)).toHaveText(/Save was refused/, { timeout: 20_000 });
  await expect(c.locator('.chat-action.err')).toHaveCount(1);
  const chatRed = await c.locator('.chat-output.err').allTextContents();
  expect(chatRed.length).toBeGreaterThan(0);
  const out = await pane(page, 'Output');
  const outputRed = await out.locator('.outl.err').evaluateAll((els) => els.map((e) => {
    const copy = e.cloneNode(true) as HTMLElement;
    copy.querySelector('.t')?.remove();
    return copy.textContent!.trim();
  }));
  expect(chatRed.map((s) => s.trim())).toEqual(outputRed);
  // the model heard them, marked as errors
  const tool = sent[1]!.messages.filter((m) => m.role === 'tool').at(-1)!;
  expect(tool.content).toContain('[error]');
});
