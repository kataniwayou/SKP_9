import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeApi } from '../board/testApi';
import { createBoardStore } from '../design/boardStore';
import { newWorkflowState } from '../design/state';
import { createOutputStore } from '../output/outputStore';
import { liveStub } from '../test/liveStub';
import { createChatStore, type ChatState } from './chatStore';
import { NOT_CONFIGURED, type ChatWire } from './kimi';
import { TOOL_DEFS } from './tools';
import { workflowArg, type ToolContext, type ToolDef } from './toolTypes';
import { CANCELLED_NOTE, MAX_ROUNDS, useChat } from './useChat';

const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const delta = (d: object) => ev({ choices: [{ delta: d }] });
const call = (index: number, id: string, name: string, args: object) =>
  delta({ tool_calls: [{ index, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

/** One scripted answer of the model: the stream's events, an HTTP status, or a stream that never ends. */
type Scripted = string[] | number | 'hang';

/** A fetch that answers /ai/config with a model and each completion request with the next scripted answer. */
function scriptedFetch(...answers: Scripted[]) {
  const bodies: { messages: ChatWire[]; tools: { function: { name: string } }[] }[] = [];
  const aborted: string[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/ai/config') return new Response(JSON.stringify({ model: 'kimi-k3' }), { status: 200 });
    bodies.push(JSON.parse(String(init?.body)));
    const a = answers.shift() ?? [delta({ content: 'out of script' })];
    if (typeof a === 'number') return new Response('', { status: a });
    const signal = init?.signal;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        signal?.addEventListener('abort', () => { aborted.push(url); c.error(new DOMException('aborted', 'AbortError')); });
        if (a === 'hang') { c.enqueue(new TextEncoder().encode(delta({ reasoning_content: 'hmm' }))); return; }
        for (const p of [...a, 'data: [DONE]\n\n']) c.enqueue(new TextEncoder().encode(p));
        c.close();
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
  return { fetchFn: fn as unknown as typeof fetch, bodies, aborted };
}

/** Test-only tools: `poke` names a workflow and logs it; `wipe` asks first, as a destructive tool does. */
const poked: string[] = [];
const wiped: string[] = [];
const TEST_TOOLS: ToolDef[] = [
  {
    name: 'poke', description: 'test', parameters: { type: 'object' },
    async run(ctx, args) {
      const wf = workflowArg(ctx, args);
      if ('error' in wf) return { kind: 'done', ok: false, result: wf.error, action: 'poke', entries: [] };
      poked.push(wf.name);
      return { kind: 'done', ok: true, result: `poked ${wf.name}`, action: `poke ${wf.name}`, entries: [] };
    },
  },
  {
    name: 'wipe', description: 'test', parameters: { type: 'object' },
    async run(ctx, args, answer, pin) {
      const wf = workflowArg(ctx, pin ? { workflow_id: pin } : args);
      if ('error' in wf) return { kind: 'done', ok: false, result: wf.error, action: 'wipe', entries: [] };
      if (answer === undefined) return { kind: 'ask', question: { text: `Wipe ${wf.name}?`, choices: ['Yes', 'No'], pin: wf.id } };
      if (answer !== 'Yes') return { kind: 'done', ok: true, result: 'the user declined; nothing was done', action: 'wipe declined', entries: [] };
      wiped.push(wf.name);
      return { kind: 'done', ok: true, result: `wiped ${wf.name}`, action: `wipe ${wf.name}`, entries: [] };
    },
  },
];

function setup(...answers: Scripted[]) {
  const output = createOutputStore(null);
  const store = createBoardStore(output, null);
  store.addWorkflow(newWorkflowState('wf1', 'orders', { x: 0, y: 0 }));
  const ctx: ToolContext = {
    store, api: fakeApi(), output, live: liveStub(),
    commands: { focus: vi.fn(), setPicks: vi.fn(), picks: () => [], newWorkflowAt: () => ({ x: 0, y: 0 }) },
    processors: () => [], caches: () => [], session: null, newId: () => 'n1',
  };
  const chat = createChatStore(null);
  const { fetchFn, bodies, aborted } = scriptedFetch(...answers);
  const hook = renderHook(() => useChat(ctx, chat, fetchFn));
  const state = (): ChatState => chat.getState();
  const idle = () => waitFor(() => expect(state().busy).toBe(false));
  return { store, ctx, chat, hook, state, idle, bodies, aborted, fetchFn };
}

describe('useChat with no tools (TOOL_DEFS empty, as this task leaves it)', () => {
  it('a message gets the model\'s text, sent with an empty tool list and the system prompt', async () => {
    expect(TOOL_DEFS).toEqual([]);
    const t = setup([delta({ content: 'Hello there.' })]);
    act(() => t.hook.result.current.send('hi'));
    await waitFor(() => expect(t.state().entries.at(-1)).toEqual({ kind: 'model', text: 'Hello there.' }));
    await t.idle();
    expect(t.state().entries).toEqual([{ kind: 'user', text: 'hi' }, { kind: 'model', text: 'Hello there.' }]);
    expect(t.bodies).toHaveLength(1);
    expect(t.bodies[0]!.tools).toEqual([]);
    expect(t.bodies[0]!.messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(t.hook.result.current.status).toBeNull();
  });

  it('a call to a tool that does not exist comes back to the model as a failed result', async () => {
    const t = setup([call(0, 'c1', 'add_step', {})], [delta({ content: 'Sorry.' })]);
    act(() => t.hook.result.current.send('add a step'));
    await waitFor(() => expect(t.state().entries.at(-1)).toEqual({ kind: 'model', text: 'Sorry.' }));
    await t.idle();
    expect(t.state().entries).toContainEqual({ kind: 'action', text: 'unknown tool add_step: there is no tool named add_step', ok: false });
    expect(t.bodies[1]!.messages.find((m) => m.role === 'tool')).toMatchObject({ tool_call_id: 'c1', content: 'there is no tool named add_step' });
  });
});

describe('useChat', () => {
  beforeEach(() => { TOOL_DEFS.push(...TEST_TOOLS); poked.length = 0; wiped.length = 0; });
  afterEach(() => { TOOL_DEFS.splice(0, TOOL_DEFS.length); });

  it('runs a turn\'s calls in order, answers each by its id, then shows the final text', async () => {
    const t = setup(
      [delta({ content: 'Poking twice.' }), call(0, 'c1', 'poke', { workflow_id: 'wf1' }), call(1, 'c2', 'poke', { workflow_id: 'gone' })],
      [delta({ content: 'Done.' })],
    );
    act(() => t.hook.result.current.send('poke it'));
    await waitFor(() => expect(t.state().entries.at(-1)).toEqual({ kind: 'model', text: 'Done.' }));
    await t.idle();
    expect(poked).toEqual(['orders']);
    expect(t.state().entries.map((e) => e.kind)).toEqual(['user', 'model', 'action', 'action', 'model']);
    expect(t.state().entries[3]).toEqual({ kind: 'action', text: 'poke: no workflow gone on the board', ok: false });
    expect(t.bodies).toHaveLength(2);
    const second = t.bodies[1]!.messages;
    expect(second[0]!.role).toBe('system');
    const assistant = second.find((m) => m.role === 'assistant')!;
    expect(assistant.role === 'assistant' && assistant.tool_calls!.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(second.filter((m) => m.role === 'tool').map((m) => m.role === 'tool' && m.content)).toEqual(['poked orders', 'no workflow gone on the board']);
    expect(t.bodies[0]!.tools.map((x) => x.function.name)).toEqual(['poke', 'wipe']);
  });

  it('503: the not-configured note, and the chat is usable again', async () => {
    const t = setup(503, [delta({ content: 'hello' })]);
    act(() => t.hook.result.current.send('hi'));
    await t.idle();
    expect(t.state().entries.at(-1)).toEqual({ kind: 'note', text: NOT_CONFIGURED, level: 'error' });
    act(() => t.hook.result.current.send('again'));
    await waitFor(() => expect(t.state().entries.at(-1)).toEqual({ kind: 'model', text: 'hello' }));
  });

  it('stop mid-stream: the request is aborted, not busy, a cancelled note', async () => {
    const t = setup('hang');
    act(() => t.hook.result.current.send('think hard'));
    await waitFor(() => expect(t.hook.result.current.status?.activity).toBe('thinking'));
    act(() => t.hook.result.current.stop());
    await t.idle();
    expect(t.aborted).toEqual(['/ai/chat/completions']);
    expect(t.state().entries.at(-1)).toEqual({ kind: 'note', text: CANCELLED_NOTE, level: 'info' });
    expect(t.hook.result.current.status).toBeNull();
  });

  it('the cancelled note promises Undo, and names no Revert', () => {
    expect(CANCELLED_NOTE).toMatch(/Undo/);
    expect(CANCELLED_NOTE).not.toMatch(/Revert|Discard/);
  });

  it('New chat while a request runs: a message sent at once, before the old run has unwound, starts its own request', async () => {
    const t = setup('hang', [delta({ content: 'fresh answer' })]);
    act(() => t.hook.result.current.send('think hard'));
    await waitFor(() => expect(t.hook.result.current.status?.activity).toBe('thinking'));
    act(() => {
      t.hook.result.current.newChat();
      t.hook.result.current.send('start over');
    });
    await waitFor(() => expect(t.state().entries.at(-1)).toEqual({ kind: 'model', text: 'fresh answer' }));
    await t.idle();
    expect(t.state().entries).toEqual([{ kind: 'user', text: 'start over' }, { kind: 'model', text: 'fresh answer' }]);
    expect(t.bodies).toHaveLength(2);
    expect(t.bodies[1]!.messages.map((m) => m.role)).toEqual(['system', 'user']);
  });

  it('a destructive call waits for the user; Yes runs it once, then the rest and the next round', async () => {
    const t = setup(
      [call(0, 'c1', 'poke', { workflow_id: 'wf1' }), call(1, 'c2', 'wipe', { workflow_id: 'wf1' }), call(2, 'c3', 'poke', { workflow_id: 'wf1' })],
      [delta({ content: 'Wiped.' })],
    );
    act(() => t.hook.result.current.send('wipe it'));
    await waitFor(() => expect(t.state().question).not.toBeNull());
    await t.idle();
    expect(t.state().question).toMatchObject({ callId: 'c2', text: 'Wipe orders?', choices: ['Yes', 'No'], pin: 'wf1' });
    expect(poked).toEqual(['orders']);
    expect(wiped).toEqual([]);
    expect(t.bodies).toHaveLength(1);
    act(() => t.hook.result.current.send('wait, what?'));
    expect(t.state().entries.at(-1)).toEqual({ kind: 'note', text: 'Answer the question first', level: 'info' });
    act(() => t.hook.result.current.send(' yes '));
    await waitFor(() => expect(t.state().entries.at(-1)).toEqual({ kind: 'model', text: 'Wiped.' }));
    await t.idle();
    expect(t.state().question).toBeNull();
    expect(wiped).toEqual(['orders']);
    expect(poked).toEqual(['orders', 'orders']);
    const tools = t.bodies[1]!.messages.filter((m) => m.role === 'tool').map((m) => m.role === 'tool' && m.tool_call_id);
    expect(tools).toEqual(['c1', 'c2', 'c3']);
  });

  it('a question restored after a refresh is answered with no loop in memory', async () => {
    const t = setup([delta({ content: 'Kept as it is.' })]);
    act(() => t.chat.dispatch({ type: 'wire', add: [
      { role: 'user', content: 'wipe it' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'q1', type: 'function', function: { name: 'wipe', arguments: '{"workflow_id":"wf1"}' } }] },
    ] }));
    act(() => t.chat.dispatch({ type: 'ask', question: { callId: 'q1', text: 'Wipe orders?', choices: ['Yes', 'No'], pin: 'wf1' } }));
    act(() => t.hook.result.current.answer('No'));
    await waitFor(() => expect(t.state().entries.at(-1)).toEqual({ kind: 'model', text: 'Kept as it is.' }));
    const tool = t.bodies[0]!.messages.find((m) => m.role === 'tool');
    expect(tool).toMatchObject({ tool_call_id: 'q1', content: expect.stringMatching(/declined/) });
    expect(t.state().question).toBeNull();
    expect(wiped).toEqual([]);
  });

  it('the status counts the tokens of the whole request, across rounds', async () => {
    const t = setup([call(0, 'c1', 'poke', { workflow_id: 'wf1' }), ev({ choices: [], usage: { prompt_tokens: 50_000, completion_tokens: 1000 } })], 'hang');
    act(() => t.hook.result.current.send('read'));
    await waitFor(() => expect(t.hook.result.current.status).toMatchObject({ tokens: 1000, activity: 'thinking' }));
    const prompt = t.hook.result.current.status!.prompt;
    expect(prompt).toBeGreaterThan(0);
    expect(prompt).toBeLessThan(50_000);
    expect(t.bodies).toHaveLength(2);
    act(() => t.hook.result.current.stop());
    await t.idle();
  });

  it('a call left unanswered by a refresh is answered as possibly run', async () => {
    const t = setup([delta({ content: 'Looking.' })]);
    act(() => t.chat.dispatch({ type: 'wire', add: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'u1', type: 'function', function: { name: 'poke', arguments: '{}' } }] },
    ] }));
    act(() => t.hook.result.current.send('again'));
    await t.idle();
    const tool = t.bodies[0]!.messages.find((m) => m.role === 'tool');
    expect(tool).toMatchObject({ tool_call_id: 'u1', content: expect.stringMatching(/may have run/) });
    expect((tool as { content: string }).content).not.toMatch(/^not run/);
  });

  it('a turn with no text and no calls adds nothing to the wire, only a note', async () => {
    const t = setup([ev({ choices: [], usage: { completion_tokens: 1 } })]);
    act(() => t.hook.result.current.send('hi'));
    await t.idle();
    expect(t.state().wire.filter((m) => m.role === 'assistant')).toEqual([]);
    expect(t.state().entries.at(-1)).toEqual({ kind: 'note', text: 'The model gave no answer', level: 'error' });
  });

  it('a 400 says the conversation is too long and to start a New chat', async () => {
    const t = setup(400);
    act(() => t.hook.result.current.send('hi'));
    await t.idle();
    expect(t.state().entries.at(-1)).toMatchObject({ kind: 'note', level: 'error', text: expect.stringMatching(/The conversation is too long for the model: start a New chat.*HTTP 400/) });
  });

  it('a runaway loop stops after MAX_ROUNDS', async () => {
    const rounds = Array.from({ length: MAX_ROUNDS }, (_, i): Scripted => [call(0, `r${i}`, 'poke', { workflow_id: 'wf1' })]);
    const t = setup(...rounds);
    act(() => t.hook.result.current.send('loop'));
    await t.idle();
    expect(t.bodies).toHaveLength(MAX_ROUNDS);
    expect(t.state().entries.at(-1)).toEqual({ kind: 'note', text: `Stopped after ${MAX_ROUNDS} rounds`, level: 'error' });
  });
});
