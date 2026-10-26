import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectData } from '../api/project';
import { createHighlights } from '../app/highlights';
import { createWorkspace } from '../app/workspace';
import { buildMolecule } from '../molecule/model';
import project from '../test/fixtures/project.json';
import { createChatStore, type ChatState } from './chatStore';
import type { ChatWire } from './kimi';
import type { ToolContext } from './toolTypes';
import { useChat } from './useChat';

const data = project as ProjectData;
const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const delta = (d: object) => ev({ choices: [{ delta: d }] });
const call = (index: number, id: string, name: string, args: object) =>
  delta({ tool_calls: [{ index, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

/** A fetch that answers /ai/config with a model, each completion request with the next scripted answer, and an apply. */
function scriptedFetch(...answers: string[][]) {
  const bodies: { messages: ChatWire[]; tools: { function: { name: string } }[] }[] = [];
  const applies: unknown[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/ai/config') return new Response(JSON.stringify({ model: 'kimi-k3' }), { status: 200 });
    if (url === '/api/v1/model/apply') { applies.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify({ ok: true, applied: true, results: [] }), { status: 200 }); }
    bodies.push(JSON.parse(String(init?.body)));
    const a = answers.shift() ?? [delta({ content: 'out of script' })];
    return new Response([...a, 'data: [DONE]\n\n'].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
  return { fetchFn: fn as unknown as typeof fetch, bodies, applies };
}

function setup(...answers: string[][]) {
  const workspace = createWorkspace();
  workspace.loaded(data, buildMolecule(data));
  const ctx: ToolContext = { workspace, highlights: createHighlights([]) };
  const chat = createChatStore(null);
  const scripted = scriptedFetch(...answers);
  // the apply reads the global fetch
  vi.stubGlobal('fetch', scripted.fetchFn);
  const hook = renderHook(() => useChat(ctx, chat, scripted.fetchFn));
  const state = (): ChatState => chat.getState();
  const idle = () => waitFor(() => expect(state().busy).toBe(false));
  return { ctx, hook, state, idle, ...scripted };
}

afterEach(() => vi.unstubAllGlobals());

describe("Valence's chat loop (2026-10-26)", () => {
  it('pins and highlights as the user would, shows each action, then the final text', async () => {
    const t = setup(
      [call(0, 'c1', 'highlight_workflows', { workflows: ['kafka-import-export'] }), call(1, 'c2', 'pin', { target: 'kafka-importer' })],
      [delta({ content: 'Shown: processor kafka-importer 2.2.0.' })],
    );
    act(() => t.hook.result.current.send('show me the kafka importer'));
    await waitFor(() => expect(t.state().entries.at(-1)).toEqual({ kind: 'model', text: 'Shown: processor kafka-importer 2.2.0.' }));
    await t.idle();
    expect(t.ctx.highlights.get()).toEqual([`wf:${data.workflows[0]!.id}`]);
    expect(t.ctx.workspace.get().pinned).toMatch(/^proc:/);
    expect(t.state().entries.filter((e) => e.kind === 'action').map((e) => (e as { text: string }).text))
      .toEqual(['highlighted workflow kafka-import-export 2.0.0', 'pinned processor kafka-importer 2.2.0']);
    // the model was told of every tool, and its calls were answered by id
    expect(t.bodies[0]!.tools.map((x) => x.function.name)).toContain('apply_changes');
    expect(t.bodies[1]!.messages.filter((m) => m.role === 'tool').map((m) => (m as { tool_call_id: string }).tool_call_id)).toEqual(['c1', 'c2']);
  });

  it('asks before applying; the answer applies once and the loop goes on', async () => {
    const t = setup(
      [call(0, 'c1', 'set_field', { atom: 'kafka-importer', field: 'description', value: 'reads Kafka' })],
      [delta({ content: 'Edited; not applied yet.' })],
      [call(0, 'c2', 'apply_changes', {})],
      [delta({ content: 'Applied.' })],
    );
    act(() => t.hook.result.current.send('describe it as reads Kafka'));
    await t.idle();
    t.ctx.workspace.judged({ kind: 'done', ok: true, planned: 1, refused: 0, byAtom: {} });
    act(() => t.hook.result.current.send('apply'));
    await waitFor(() => expect(t.state().question?.choices).toEqual(['Apply', 'Cancel']));
    await t.idle();
    expect(t.applies).toHaveLength(0);
    act(() => t.hook.result.current.answer('Apply'));
    await waitFor(() => expect(t.state().entries.at(-1)).toEqual({ kind: 'model', text: 'Applied.' }));
    await t.idle();
    expect(t.applies).toHaveLength(1);
    expect(t.ctx.workspace.get().edits).toEqual({});
  });
});
