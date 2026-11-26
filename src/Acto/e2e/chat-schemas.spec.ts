import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { flowPos, openAt, saveButton } from './helpers';
import { needsChat, say } from './chatTurn';
import { seed } from './seed';

// The chat and the Schemas mode (user, 2026-11-26: "verify that the chat aligns with the new schemas, processors display
// rules"), against the deployed model (real, costs tokens). Plain-language turns about throwaway e2e-chat-... rows; each is
// checked by its EFFECT on the board (the toggle, the cards, a ghost, a place), and by the reply only where the point is what
// it says (a schema's state, a refusal's reason). Nothing is saved: the guard (fixtures.ts) refuses every schema or processor
// write anyway, and the board's unsaved changes go with the page.

test.describe.configure({ retries: 1 }); // the model is not deterministic: one retry, and a retried pass is reported as flaky
test.beforeEach(async ({ request }) => { await needsChat(request); });

const HASH_A = 'e2e1'.padEnd(64, 'a');
const HASH_B = 'e2e1'.padEnd(64, 'b');
/** e2e-chat-proc-a (Input e2e-chat-in) runs e2e-chat-s1 in e2e-chat-wf; e2e-chat-proc-b, which no step uses, holds e2e-chat-held; e2e-chat-orph is an orphan. */
const SEED = {
  schemas: [
    { key: 'IN', name: 'e2e-chat-in', definition: '{"type":"object"}', at: { x: 180, y: 200 } },
    { key: 'HELD', name: 'e2e-chat-held', at: { x: 180, y: 480 } },
    { key: 'ORPH', name: 'e2e-chat-orph', at: { x: 460, y: 340 } },
  ],
  processors: [
    { key: 'PA', name: 'e2e-chat-proc-a', sourceHash: HASH_A, input: 'IN' },
    { key: 'PB', name: 'e2e-chat-proc-b', sourceHash: HASH_B, config: 'HELD', at: { x: 180, y: 340 } },
  ],
  steps: [{ key: 'S1', name: 'e2e-chat-s1', at: { x: 180, y: 40 }, processor: 'PA' }],
  workflows: [{ key: 'W', name: 'e2e-chat-wf', at: { x: 0, y: 60 }, entry: ['S1'] }],
} as const;

const toggle = (page: Page) => page.locator('button.schemas-toggle');
const scNode = (page: Page, id: string) => page.locator(`.react-flow__node-schema:not(.ghost)[data-id="sc:${id}"]`);
const prNode = (page: Page, id: string) => page.locator(`.react-flow__node-processor[data-id="pr:${id}"]`);
const scGhost = (page: Page, id: string) => page.locator(`.react-flow__node.ghost[data-id="ghost:schema:${id}"]`);

test('the chat follows the Schemas mode: turns it on, reads the states, refuses held and processor deletes with the reason, deletes an orphan to a ghost, moves a card, turns it off', async ({ page }) => {
  const id = await seed(SEED);
  await openAt(page);
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');

  // 1 · on, and the states read from the board
  const t1 = await say(page, 'Turn on the Schemas mode, then tell me for each of the schemas e2e-chat-in, e2e-chat-held and e2e-chat-orph whether it is wired, held or an orphan. Change nothing else.');
  await expect(toggle(page), 'the chat turned the Schemas mode on').toHaveAttribute('aria-pressed', 'true');
  expect(t1.actions.join(' | ')).toMatch(/schemas mode on/);
  for (const [name, state] of [['e2e-chat-in', /wired/i], ['e2e-chat-held', /held/i], ['e2e-chat-orph', /orphan/i]] as const) {
    const line = t1.reply.split(/\n|(?<=\.)\s/).find((l) => l.includes(name)) ?? t1.reply;
    expect(line, `the reply gives ${name}'s state`).toMatch(state);
  }
  await expect(scNode(page, id.ORPH!)).toBeVisible();
  await expect(prNode(page, id.PB!)).toBeVisible();

  // 2 · a held schema is not deleted: no question, the card stays, the reply says why
  const t2 = await say(page, 'Delete the schema e2e-chat-held.');
  expect(t2.asked, 'no Delete question for a held schema').toEqual([]);
  await expect(scNode(page, id.HELD!)).toBeVisible();
  expect(t2.reply).toMatch(/held|orphan/i);

  // 3 · a processor is never deleted
  const t3 = await say(page, 'Delete the processor e2e-chat-proc-b.');
  expect(t3.asked, 'no Delete question for a processor').toEqual([]);
  await expect(prNode(page, id.PB!)).toBeVisible();
  expect(t3.reply).toMatch(/never|cannot|can't|not (be )?deleted/i);

  // 4 · an orphan is deleted after the question that names it, to a ghost, unsaved
  const t4 = await say(page, 'Delete the orphan schema e2e-chat-orph. Do not save.');
  expect(t4.asked.join(' | '), 'the question names an orphan schema').toMatch(/Delete 1 orphan schema\?/);
  await expect(scNode(page, id.ORPH!)).toHaveCount(0);
  await expect(scGhost(page, id.ORPH!), 'a ghost until Save').toBeVisible();
  await expect(saveButton(page)).toBeEnabled();

  // 5 · a card moves (its place only)
  const before = await flowPos(scNode(page, id.IN!));
  const t5 = await say(page, 'Move the schema card e2e-chat-in 300 to the right, keeping its height. Do not save.');
  expect(t5.actions.join(' | ')).toMatch(/move blocks/);
  await expect.poll(async () => Math.round((await flowPos(scNode(page, id.IN!))).x - before.x), 'moved 300 to the right').toBe(300);
  expect(Math.round((await flowPos(scNode(page, id.IN!))).y)).toBe(Math.round(before.y));

  // 6 · off: the cards are hidden
  await say(page, 'Turn the Schemas mode off.');
  await expect(toggle(page), 'the chat turned the Schemas mode off').toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.react-flow__node-schema, .react-flow__node-processor')).toHaveCount(0);
});
