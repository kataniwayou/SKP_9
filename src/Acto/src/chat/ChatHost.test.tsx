import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { fakeApi } from '../board/testApi';
import { createBoardStore } from '../design/boardStore';
import { oneWorkflow } from '../design/boardFixtures';
import { createOutputStore } from '../output/outputStore';
import { liveStub } from '../test/liveStub';
import { ChatHost } from './ChatHost';
import { createChatStore } from './chatStore';
import { NOT_CONFIGURED } from './kimi';
import type { ToolContext } from './toolTypes';

function context(): ToolContext {
  const output = createOutputStore(null);
  const store = createBoardStore(output, null);
  store.load(oneWorkflow());
  return {
    store, api: fakeApi(), output, live: liveStub(),
    commands: { focus: vi.fn(), setPicks: vi.fn(), picks: () => [], newWorkflowAt: () => ({ x: 0, y: 0 }) },
    processors: () => [], caches: () => [], session: null, newId: () => 'n1',
  };
}

describe('ChatHost', () => {
  it('/ai/config 503: the not-configured line, the box closed, and no request to the model (Review Focus 2)', async () => {
    const fetchFn = vi.fn(async (url: string) => (url === '/ai/config'
      ? new Response(JSON.stringify({ error: 'The chat is not configured' }), { status: 503 })
      : new Response('', { status: 200 }))) as unknown as typeof fetch;
    const ctx = context();
    render(<ChatHost chat={createChatStore(null)} ctx={ctx} fetchFn={fetchFn} />);
    expect(await screen.findByText(NOT_CONFIGURED)).toBeInTheDocument();
    const box = screen.getByRole('textbox', { name: 'Message' });
    expect(box).toBeDisabled();
    fireEvent.change(box, { target: { value: 'hi' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual(['/ai/config']);
    expect(Object.keys(ctx.store.state().workflows)).toHaveLength(1);
  });

  it('Stop aborts the request in flight: the fetch sees the abort', async () => {
    let seen: AbortSignal | undefined;
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/ai/config') return new Response(JSON.stringify({ model: 'kimi-k3' }), { status: 200 });
      seen = init?.signal ?? undefined;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          init?.signal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')));
          c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'hm' } }] })}\n\n`));
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    render(<ChatHost chat={createChatStore(null)} ctx={context()} fetchFn={fetchFn} />);
    const box = screen.getByRole('textbox', { name: 'Message' });
    await waitFor(() => expect(box).not.toBeDisabled());
    fireEvent.change(box, { target: { value: 'think' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    const stop = await screen.findByRole('button', { name: 'Stop' });
    await waitFor(() => expect(seen).toBeDefined());
    expect(seen!.aborted).toBe(false);
    fireEvent.click(stop);
    await waitFor(() => expect(seen!.aborted).toBe(true));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull());
    expect(screen.getByText(/^Cancelled/)).toBeInTheDocument();
  });
});
