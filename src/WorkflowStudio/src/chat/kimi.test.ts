import { describe, expect, it, vi } from 'vitest';
import { NOT_CONFIGURED } from '../ai/drawing';
import { ChatError, requestTurn, type Progress } from './kimi';

const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const delta = (d: object) => ev({ choices: [{ delta: d }] });
const streamOf = (...parts: string[]) => new ReadableStream<Uint8Array>({
  start(c) { for (const p of parts) c.enqueue(new TextEncoder().encode(p)); c.close(); },
});
const fetchOf = (...parts: string[]) =>
  vi.fn(async () => new Response(streamOf(...parts, 'data: [DONE]\n\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch;
const ask = (f: typeof fetch, onProgress: (p: Progress) => void = () => {}) =>
  requestTurn('kimi-k3', [{ role: 'user', content: 'hi' }], [], new AbortController().signal, onProgress, f);

describe('requestTurn', () => {
  it('assembles a tool call from pieces', async () => {
    const t = await ask(fetchOf(
      delta({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'add_step', arguments: '' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: '{"na' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: 'me":"a"}' } }] }),
    ));
    expect(t.calls).toEqual([{ id: 'c1', name: 'add_step', arguments: '{"name":"a"}' }]);
  });

  it('two calls by index', async () => {
    const t = await ask(fetchOf(
      delta({ tool_calls: [{ index: 1, id: 'c2', function: { name: 'b', arguments: '{}' } }] }),
      delta({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'a', arguments: '{}' } }] }),
    ));
    expect(t.calls.map((c) => c.id)).toEqual(['c1', 'c2']);
  });

  it('tokens from usage', async () => {
    const seen: Progress[] = [];
    const t = await ask(fetchOf(delta({ content: 'x' }), ev({ choices: [], usage: { completion_tokens: 3200 } })), (p) => seen.push(p));
    expect(t.tokens).toBe(3200);
    expect(seen.at(-1)!.tokens).toBe(3200);
  });

  it('tokens estimated without usage', async () => {
    const t = await ask(fetchOf(delta({ reasoning_content: 'r'.repeat(300) }), delta({ content: 'c'.repeat(100) })));
    expect(t.tokens).toBe(100);
    expect(t.reasoning).toHaveLength(300);
    expect(t.text).toHaveLength(100);
  });

  it('reports the phase: waiting first, thinking for reasoning, writing for content', async () => {
    const seen: Progress[] = [];
    await ask(fetchOf(delta({ reasoning_content: 'hm' }), delta({ content: 'ok' })), (p) => seen.push(p));
    expect(seen.map((p) => p.phase)).toEqual(['waiting', 'thinking', 'writing']);
  });

  it('sends the tools, the usage option and the effort', async () => {
    const f = fetchOf(delta({ content: 'x' }));
    await requestTurn('kimi-k3', [{ role: 'user', content: 'hi' }], [{ type: 'function' }], new AbortController().signal, () => {}, f);
    const sent = JSON.parse(((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit).body as string);
    expect(sent).toMatchObject({ model: 'kimi-k3', stream: true, stream_options: { include_usage: true }, tools: [{ type: 'function' }], reasoning_effort: 'low' });
  });

  it('503 and 401 are ChatErrors in the wand\'s words', async () => {
    const status = (s: number) => vi.fn(async () => new Response('', { status: s })) as unknown as typeof fetch;
    await expect(ask(status(503))).rejects.toThrow(new ChatError(NOT_CONFIGURED));
    await expect(ask(status(401))).rejects.toThrow('the model refused the key (HTTP 401)');
  });

  it('a silent model is given up', async () => {
    vi.useFakeTimers();
    try {
      const never = vi.fn((_u: unknown, init: RequestInit) => new Promise<Response>((_, rej) => init.signal!.addEventListener('abort', () => rej(new Error('aborted'))))) as unknown as typeof fetch;
      const p = expect(ask(never)).rejects.toThrow(/no word from the model/);
      await vi.advanceTimersByTimeAsync(60_001);
      await p;
    } finally { vi.useRealTimers(); }
  });
});
