import { fireEvent, waitFor, within } from '@testing-library/react';
import { expect, vi } from 'vitest';

/** The model's answers as server-sent events: a tool call, some text. */
export const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
export const toolCall = (index: number, id: string, name: string, args: object) =>
  ev({ choices: [{ delta: { tool_calls: [{ index, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });
export const say = (text: string) => ev({ choices: [{ delta: { content: text } }] });

/** /ai/config answers a model; each completion request answers the next scripted stream (then a plain "done"). */
export function scriptedAi(...answers: string[][]) {
  return vi.fn(async (url: string, _init?: RequestInit) => {
    if (url === '/ai/config') return new Response(JSON.stringify({ model: 'kimi-k3' }), { status: 200 });
    const a = answers.shift() ?? [say('done')];
    const body = new ReadableStream<Uint8Array>({
      start(c) { for (const p of [...a, 'data: [DONE]\n\n']) c.enqueue(new TextEncoder().encode(p)); c.close(); },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
}

export const chatPanel = () => within(document.querySelector('[data-panel="chat"]') as HTMLElement);

/** Writes `text` in the chat's box once it is open and sends it. */
export async function sendChat(text: string) {
  const box = chatPanel().getByRole('textbox', { name: 'Message' });
  await waitFor(() => expect(box).not.toBeDisabled());
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: 'Enter' });
}

/** Waits for the answer to end (Stop goes away and the box opens again). */
export async function chatSettled() {
  await waitFor(() => expect(chatPanel().queryByRole('button', { name: 'Stop' })).toBeNull());
  await waitFor(() => expect(chatPanel().getByRole('textbox', { name: 'Message' })).not.toBeDisabled());
}
