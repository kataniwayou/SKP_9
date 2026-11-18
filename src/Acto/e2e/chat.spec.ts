import { test, expect } from './fixtures';
import { openFitted } from './helpers';

// The chat, against the deployed model (real, costs tokens): ONE read-only question. The dev server proxies
// /ai only when KIMI_BASE_URL, KIMI_MODEL_ID and KIMI_API_KEY are in its environment; without them /ai/config answers
// 503 and the test is skipped. The guard (fixtures.ts) refuses any write a tool might try; the question only reads.

test('a read-only question: the tool line "list workflows", an answer naming a real workflow; Stop while it answers; New chat clears', async ({ page, request, stack }) => {
  // the three settings are read from the environment only to decide whether to run: their values are never printed
  const missing = ['KIMI_API_KEY', 'KIMI_BASE_URL', 'KIMI_MODEL_ID'].filter((k) => !process.env[k]);
  test.skip(missing.length > 0, `the chat is not configured: ${missing.join(', ')} not set in the environment`);
  const config = await request.get('/ai/config');
  test.skip(config.status() === 503, 'the chat is not configured: start the run with KIMI_BASE_URL, KIMI_MODEL_ID and KIMI_API_KEY in the environment');
  expect(config.ok()).toBe(true);
  test.setTimeout(Number(process.env.ACTO_SLOWMO ?? 0) > 0 ? 600_000 : 240_000);

  await openFitted(page);
  const chat = page.locator('[data-panel="chat"]');
  const box = chat.getByRole('textbox', { name: 'Message' });
  await expect(box).toBeEnabled();
  await expect(chat.getByRole('button', { name: 'Stop' })).toHaveCount(0);
  await box.fill('List the workflows on the board. Only read.');
  await box.press('Enter');
  await expect(chat.locator('.chat-user')).toHaveText('List the workflows on the board. Only read.');
  // while it answers: Stop shows, the box waits
  await expect(chat.getByRole('button', { name: 'Stop' })).toBeVisible();
  await expect(box).toBeDisabled();
  // a read tool ran: its line is in the conversation (list workflows, read board, ...)
  await expect(chat.locator('.chat-action:not(.err)').first()).toBeVisible({ timeout: 180_000 });
  await expect(chat.getByRole('button', { name: 'Stop' })).toHaveCount(0, { timeout: 180_000 });
  const answer = (await chat.locator('.chat-model').allInnerTexts()).join('\n');
  const named = stack.workflows.filter((w) => answer.includes(w.name)).map((w) => w.name);
  expect(named.length, `the answer names a real workflow:\n${answer}`).toBeGreaterThan(0);
  test.info().annotations.push({ type: 'answer', description: answer.slice(0, 400) });

  await chat.getByRole('button', { name: 'New chat' }).click();
  await expect(chat.locator('.chat-e')).toHaveCount(0);
  await expect(chat.getByText('Ask for a change to a workflow, and watch it happen on the board.')).toBeVisible();
  await expect(box).toBeEnabled();
});
