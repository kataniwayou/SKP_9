import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectData } from '../api/project';
import { canvasBridge, type CanvasApi } from '../molecule/bridge';
import type { Vec } from '../molecule/layout';
import { atomKey, buildMolecule } from '../molecule/model';
import { createHighlights } from './highlights';
import { Wand } from './Wand';
import { createWorkspace } from './workspace';

const H = 'a'.repeat(64);
const b = { version: '1.0.0', description: null, updatedAt: '2026-10-17T09:30:00.123456Z' };
const data = {
  workflows: [{ id: 'w1', name: 'flow', ...b, entryStepIds: ['s1'], assignmentIds: [], cacheIds: [], cronExpression: null }],
  steps: [{ id: 's1', name: 'first', ...b, processorId: 'p1', nextStepIds: [], entryCondition: 1 }],
  processors: [{ id: 'p1', name: 'proc', ...b, sourceHash: H, instanceId: null, inputSchemaId: null, outputSchemaId: null, configSchemaId: null }],
  schemas: [], assignments: [], caches: [],
} as unknown as ProjectData;
const W1 = atomKey('wf', 'w1');

function setup(picked: string[], reply: (body: { messages: { content: string }[] }) => string) {
  const workspace = createWorkspace();
  workspace.loaded(data, buildMolecule(data));
  const highlights = createHighlights(picked);
  const placed: Map<string, Vec>[] = [];
  const now = new Map<string, Vec>([[W1, [0, 0, 0]], [atomKey('step', 's1'), [10, 0, 0]], [atomKey('proc', 'p1'), [10, 9, 0]]]);
  canvasBridge.set({ positions: () => new Map(now), place: (p: ReadonlyMap<string, Vec>) => { placed.push(new Map(p)); } } as unknown as CanvasApi);
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/ai/config') return new Response('{"model":"kimi-k3"}', { status: 200 });
    const body = JSON.parse(init!.body as string);
    return new Response(JSON.stringify({ choices: [{ message: { content: reply(body) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  render(<Wand workspace={workspace} highlights={highlights} fetchFn={fetchFn} />);
  return { workspace, placed, fetchFn };
}

afterEach(() => canvasBridge.set(null));

describe('the wand (the user, 2026-10-17)', () => {
  it('is greyed until workflows are picked in the Workflows filter', () => {
    setup([], () => '{}');
    const wand = screen.getByRole('button', { name: /^AI drawing: Pick the workflows/ });
    expect(wand).toHaveAttribute('aria-disabled', 'true');
  });

  it('asks the model for the picked workflows, places its drawing on the canvas, and puts it back with the arrow', async () => {
    const { workspace, placed } = setup([W1], () => JSON.stringify({ atoms: { a1: [-4.7, 0, 0], a2: [0, 0, 0], a3: [0, 2.7, 0] } }));
    fireEvent.click(screen.getByRole('button', { name: 'AI drawing: lay out flow' }));
    await waitFor(() => expect(placed).toHaveLength(1));
    const [drawn] = placed;
    expect(drawn!.get(atomKey('proc', 'p1'))![1] - drawn!.get(atomKey('step', 's1'))![1]).toBeCloseTo(2.7);
    expect(workspace.get().messages.at(-1)!.text).toMatch(/^AI drawing applied: flow laid out by the spine rules, 3 atoms placed/);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Take back the AI drawing' })); });
    expect(placed[1]!.get(atomKey('proc', 'p1'))).toEqual([10, 9, 0]);
  });

  it('a refused answer gets one correction round; refused twice, nothing is placed', async () => {
    let n = 0;
    const { workspace, placed } = setup([W1], () => (n++ === 0 ? 'not json' : JSON.stringify({ atoms: { a1: [0, 0, 0] } })));
    fireEvent.click(screen.getByRole('button', { name: 'AI drawing: lay out flow' }));
    await waitFor(() => expect(workspace.get().messages.at(-1)!.text).toMatch(/^AI drawing not applied: 2 atoms not placed/));
    expect(n).toBe(2);
    expect(placed).toHaveLength(0);
    expect(workspace.get().messages.some((x) => /refused \(the answer is not one JSON object\); asking kimi-k3 once to correct it/.test(x.text))).toBe(true);
  });
});
