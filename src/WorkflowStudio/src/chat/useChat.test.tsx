import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { StudioApi } from '../api/client';
import { graphDto, processorDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { createInspectorService } from '../app/inspectorService';
import { shownDesignOf } from '../store/problems';
import { createStudioStore } from '../store/studioStore';
import { createChatStore, type ChatState } from './chatStore';
import { NOT_CONFIGURED, type ChatWire } from './kimi';
import { runTool } from './runTool';
import type { ToolContext } from './toolTypes';
import { CANCELLED_NOTE, MAX_ROUNDS, useChat } from './useChat';

const ok = <T,>(value: T) => ({ ok: true, value }) as const;
const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const delta = (d: object) => ev({ choices: [{ delta: d }] });
const call = (index: number, id: string, name: string, args: object) =>
  delta({ tool_calls: [{ index, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

/** One scripted answer of the model: the stream's events, an HTTP status, or a stream that never ends. */
type Scripted = string[] | number | 'hang';

/** A fetch that answers /ai/config with a model and each completion request with the next scripted answer. */
function scriptedFetch(...answers: Scripted[]) {
  const bodies: { messages: ChatWire[]; tools: { function: { name: string } }[] }[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/ai/config') return new Response(JSON.stringify({ model: 'kimi-k3' }), { status: 200 });
    bodies.push(JSON.parse(String(init?.body)));
    const a = answers.shift() ?? [delta({ content: 'out of script' })];
    if (typeof a === 'number') return new Response('', { status: a });
    const signal = init?.signal;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        signal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')));
        if (a === 'hang') { c.enqueue(new TextEncoder().encode(delta({ reasoning_content: 'hmm' }))); return; }
        for (const p of [...a, 'data: [DONE]\n\n']) c.enqueue(new TextEncoder().encode(p));
        c.close();
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
  return { fetchFn: fn as unknown as typeof fetch, bodies };
}

/** Workflow orders 1.0.0 with step a (an entry step), open and active. */
async function setup(...answers: Scripted[]) {
  const store = createStudioStore();
  store.dispatch({ type: 'open', workflowId: 'wf1', name: 'orders', version: '1.0.0' });
  store.dispatch({
    type: 'loaded', workflowId: 'wf1',
    doc: await loadedDocument(graphDto({ workflow: workflowDto({ entryStepIds: ['s1'] }), steps: [stepDto('s1', { name: 'a', processorId: 'p1' })], processors: [processorDto('p1', { name: 'fetcher' })] })),
  });
  const api = {
    listWorkflows: async () => ok([workflowDto({ id: 'wf1' })]),
    listProcessors: async () => ok([processorDto('p1', { name: 'fetcher' })]),
    listCaches: async () => ok([]),
  } as unknown as StudioApi;
  let n = 0;
  const ctx: ToolContext = { store, api, service: createInspectorService(api, store), commands: {} as ToolContext['commands'], newId: () => `n${++n}` };
  const chat = createChatStore(null);
  const { fetchFn, bodies } = scriptedFetch(...answers);
  const hook = renderHook(() => useChat(ctx, chat, fetchFn));
  const state = (): ChatState => chat.getState();
  const idle = () => waitFor(() => expect(state().busy).toBe(false));
  const steps = () => [...shownDesignOf(store.getState().docs[0]!)!.graph.steps.values()].map((s) => s.name);
  return { store, ctx, chat, hook, state, idle, bodies, steps };
}

describe('useChat', () => {
  it('runs a turn\'s calls in order, answers each by its id, then shows the final text', async () => {
    const t = await setup(
      [delta({ content: 'Adding a step.' }), call(0, 'c1', 'add_step', {}), call(1, 'c2', 'connect', { from: 'a', to: 'step' })],
      [delta({ content: 'Done: step wired from a.' })],
    );
    act(() => t.hook.result.current.send('add a step after a'));
    await waitFor(() => expect(t.state().entries.at(-1)).toEqual({ kind: 'model', text: 'Done: step wired from a.' }));
    await t.idle();
    expect(t.steps()).toEqual(['a', 'step']);
    const kinds = t.state().entries.map((e) => e.kind);
    expect(kinds.slice(0, 4)).toEqual(['user', 'model', 'action', 'action']);
    expect(t.state().entries.filter((e) => e.kind === 'action').every((e) => e.kind === 'action' && e.ok)).toBe(true);
    // the second request carries the assistant's calls and both answers, in order, by id
    expect(t.bodies).toHaveLength(2);
    const second = t.bodies[1]!.messages;
    expect(second[0]!.role).toBe('system');
    const assistant = second.find((m) => m.role === 'assistant')!;
    expect(assistant.role === 'assistant' && assistant.tool_calls!.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(second.filter((m) => m.role === 'tool').map((m) => m.role === 'tool' && m.tool_call_id)).toEqual(['c1', 'c2']);
    expect(t.bodies[0]!.tools.map((x) => x.function.name)).toContain('add_step');
    expect(t.hook.result.current.status).toBeNull();
  });

  it('503: the not-configured note, and the chat is usable again', async () => {
    const t = await setup(503, [delta({ content: 'hello' })]);
    act(() => t.hook.result.current.send('hi'));
    await t.idle();
    expect(t.state().entries.at(-1)).toEqual({ kind: 'note', text: NOT_CONFIGURED, level: 'error' });
    expect(NOT_CONFIGURED).toMatch(/^The chat is not configured/);
    act(() => t.hook.result.current.send('again'));
    await waitFor(() => expect(t.state().entries.at(-1)).toEqual({ kind: 'model', text: 'hello' }));
  });

  it('stop mid-stream: not busy, a cancelled note', async () => {
    const t = await setup('hang');
    act(() => t.hook.result.current.send('think hard'));
    await waitFor(() => expect(t.hook.result.current.status?.activity).toBe('thinking'));
    act(() => t.hook.result.current.stop());
    await t.idle();
    expect(t.state().entries.at(-1)).toMatchObject({ kind: 'note', text: expect.stringMatching(/cancelled/i) });
    expect(t.hook.result.current.status).toBeNull();
  });

  it('the cancelled note promises Undo for drawing changes and assignments: field edits are reversed by Revert entity', () => {
    expect(CANCELLED_NOTE).toMatch(/Undo reverses drawing changes and created or removed assignments/);
    expect(CANCELLED_NOTE).toMatch(/Revert entity reverses field edits/);
    expect(CANCELLED_NOTE).not.toMatch(/Discard/);
  });

  it('New chat while a request runs: a message sent at once, before the old run has unwound, starts its own request', async () => {
    const t = await setup('hang', [delta({ content: 'fresh answer' })]);
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
    const t = await setup(
      [call(0, 'c1', 'add_step', {}), call(1, 'c2', 'delete_picked', {}), call(2, 'c3', 'read_output', {})],
      [delta({ content: 'Deleted.' })],
    );
    act(() => t.hook.result.current.send('add a step, then delete it'));
    await waitFor(() => expect(t.state().question).not.toBeNull());
    await t.idle();
    expect(t.state().question).toMatchObject({ callId: 'c2', choices: ['Yes', 'No'], pin: 'wf1' });
    expect(t.steps()).toEqual(['a', 'step']);
    expect(t.bodies).toHaveLength(1);
    // other text is refused while the question is open
    act(() => t.hook.result.current.send('wait, what?'));
    expect(t.state().entries.at(-1)).toEqual({ kind: 'note', text: 'Answer the question first', level: 'info' });
    // typed "yes" answers it
    act(() => t.hook.result.current.send(' yes '));
    await waitFor(() => expect(t.state().entries.at(-1)).toEqual({ kind: 'model', text: 'Deleted.' }));
    await t.idle();
    expect(t.state().question).toBeNull();
    expect(t.steps()).toEqual(['a']);
    const tools = t.bodies[1]!.messages.filter((m) => m.role === 'tool').map((m) => m.role === 'tool' && m.tool_call_id);
    expect(tools).toEqual(['c1', 'c2', 'c3']);
  });

  it('a question restored after a refresh is answered with no loop in memory', async () => {
    const t = await setup([delta({ content: 'Kept as it is.' })]);
    // the design has a step to delete, picked
    expect(await runTool(t.ctx, { id: 'x', name: 'add_step', arguments: '{}' })).toMatchObject({ kind: 'done', ok: true });
    act(() => t.chat.dispatch({ type: 'wire', add: [
      { role: 'user', content: 'delete it' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'q1', type: 'function', function: { name: 'delete_picked', arguments: '{}' } }] },
    ] }));
    act(() => t.chat.dispatch({ type: 'ask', question: { callId: 'q1', text: 'Delete?', choices: ['Yes', 'No'], pin: 'wf1' } }));
    act(() => t.hook.result.current.answer('No'));
    await waitFor(() => expect(t.state().entries.at(-1)).toEqual({ kind: 'model', text: 'Kept as it is.' }));
    const tool = t.bodies[0]!.messages.find((m) => m.role === 'tool');
    expect(tool).toMatchObject({ tool_call_id: 'q1', content: expect.stringMatching(/declined/) });
    expect(t.state().question).toBeNull();
    expect(t.steps()).toEqual(['a', 'step']);
  });

  it('the status counts the tokens of the whole request, across rounds', async () => {
    const t = await setup([call(0, 'c1', 'read_output', {}), ev({ choices: [], usage: { prompt_tokens: 50_000, completion_tokens: 1000 } })], 'hang');
    act(() => t.hook.result.current.send('read'));
    await waitFor(() => expect(t.hook.result.current.status).toMatchObject({ tokens: 1000, activity: 'thinking' }));
    // ↑ is the latest request, the second round's, estimated from its body: not the first round's 50k, nor a sum
    const prompt = t.hook.result.current.status!.prompt;
    expect(prompt).toBeGreaterThan(0);
    expect(prompt).toBeLessThan(50_000);
    expect(t.bodies).toHaveLength(2);
    act(() => t.hook.result.current.stop());
    await t.idle();
  });

  it('a call left unanswered by a refresh is answered as possibly run', async () => {
    const t = await setup([delta({ content: 'Looking.' })]);
    act(() => t.chat.dispatch({ type: 'wire', add: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'u1', type: 'function', function: { name: 'add_step', arguments: '{}' } }] },
    ] }));
    act(() => t.hook.result.current.send('again'));
    await t.idle();
    const tool = t.bodies[0]!.messages.find((m) => m.role === 'tool');
    expect(tool).toMatchObject({ tool_call_id: 'u1', content: expect.stringMatching(/may have run; read the design and Output before going on/) });
    expect((tool as { content: string }).content).not.toMatch(/^not run/);
  });

  it('a turn with no text and no calls adds nothing to the wire, only a note', async () => {
    const t = await setup([ev({ choices: [], usage: { completion_tokens: 1 } })]);
    act(() => t.hook.result.current.send('hi'));
    await t.idle();
    expect(t.state().wire.filter((m) => m.role === 'assistant')).toEqual([]);
    expect(t.state().entries.at(-1)).toEqual({ kind: 'note', text: 'The model gave no answer', level: 'error' });
  });

  it('a 400 says the conversation is too long and to start a New chat', async () => {
    const t = await setup(400);
    act(() => t.hook.result.current.send('hi'));
    await t.idle();
    expect(t.state().entries.at(-1)).toMatchObject({ kind: 'note', level: 'error', text: expect.stringMatching(/The conversation is too long for the model: start a New chat.*HTTP 400/) });
  });

  it('a runaway loop stops after MAX_ROUNDS', async () => {
    const rounds = Array.from({ length: MAX_ROUNDS }, (_, i): Scripted => [call(0, `r${i}`, 'read_output', {})]);
    const t = await setup(...rounds);
    act(() => t.hook.result.current.send('loop'));
    await t.idle();
    expect(t.bodies).toHaveLength(MAX_ROUNDS);
    expect(t.state().entries.at(-1)).toEqual({ kind: 'note', text: `Stopped after ${MAX_ROUNDS} rounds`, level: 'error' });
  });
});
