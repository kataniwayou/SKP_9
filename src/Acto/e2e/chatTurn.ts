import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

// One turn of the chat against the deployed model, shared by the chat specs that talk to it (real, costs tokens).

const slow = Number(process.env.ACTO_SLOWMO ?? 0) > 0;
export const TURN = slow ? 600_000 : 300_000; // one model answer, tools included

/** Skips the test unless the chat is configured (the three KIMI_ settings, never printed) and gives it the time a chat takes. */
export async function needsChat(request: { get(url: string): Promise<{ status(): number }> }) {
  const missing = ['KIMI_API_KEY', 'KIMI_BASE_URL', 'KIMI_MODEL_ID'].filter((k) => !process.env[k]);
  test.skip(missing.length > 0, `the chat is not configured: ${missing.join(', ')} not set in the environment`);
  const config = await request.get('/ai/config');
  test.skip(config.status() === 503, 'the chat is not configured (/ai/config answered 503)');
  test.setTimeout(slow ? 1_800_000 : 900_000);
}

export const chatPanel = (page: Page) => page.locator('[data-panel="chat"]');

export interface Turn { reply: string; actions: string[]; failed: string[]; asked: string[] }

/**
 * The choice a test makes on a question of Acto's own: a button's text, or `type:<text>` to type the answer in the message box (a
 * typed yes/no answers it). By default it confirms Save/Delete/Remove/Take stored and declines Start and Stop: never a real run.
 */
export type Chooser = (question: string, choices: string[]) => string;
export const confirm: Chooser = (_q, choices) => (choices.includes('Stop') || choices.includes('Start') ? 'Cancel' : choices.find((c) => c !== 'Cancel') ?? 'Cancel');

/**
 * Sends one message and waits until the model is done: every question Acto asks with buttons meanwhile is answered by
 * `choose`. Answers the new model texts, the tool lines (and the failed ones) and the questions asked, all for this turn.
 */
export async function say(page: Page, text: string, choose: Chooser = confirm): Promise<Turn> {
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
