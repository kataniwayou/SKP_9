import { act, render, screen, waitFor } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { liveStub } from '../test/liveStub';
import { memoryStorage } from '../test/memoryStorage';
import { Board } from './Board';
import { HEADER_H } from './geometry';
import { bw } from './fixtures';
import { fakeApi, graphWith, wf } from './testApi';

type Props = Record<string, (...a: unknown[]) => void>;
const seen: { props: Props | null } = { props: null };

vi.mock('@xyflow/react', async (orig) => {
  const mod = await orig<typeof import('@xyflow/react')>();
  const Real = mod.ReactFlow;
  return { ...mod, ReactFlow: (p: Record<string, unknown>) => { seen.props = p as Props; return <Real {...(p as object)} />; } };
});

const stepNode = (wfId: string, id: string, x: number, y: number): Node =>
  ({ id: `st:${wfId}:${id}`, type: 'step', position: { x, y }, data: { workflowId: wfId, stepId: id } });

describe('Board editing', () => {
  it('commits one moveStep at drag end, with y relative to the frame content', async () => {
    const onEdit = { moveStep: vi.fn(), moveFrame: vi.fn(), resizeFrame: vi.fn(), connect: vi.fn() };
    render(<Board workflows={[bw('w1', ['a'])]} selection={null} onSelect={() => {}} initialZoom={1} onEdit={onEdit} />);
    await screen.findByText('a-name');
    act(() => seen.props!.onNodeDragStop!({}, stepNode('w1', 'a', 100, 90 + HEADER_H)));
    expect(onEdit.moveStep).toHaveBeenCalledTimes(1);
    expect(onEdit.moveStep).toHaveBeenCalledWith('w1', 'a', { x: 100, y: 90 });
  });
  it('commits nothing when the drag ends where the step already was', async () => {
    const onEdit = { moveStep: vi.fn(), moveFrame: vi.fn(), resizeFrame: vi.fn(), connect: vi.fn() };
    const w = bw('w1', ['a']);
    render(<Board workflows={[w]} selection={null} onSelect={() => {}} initialZoom={1} onEdit={onEdit} />);
    await screen.findByText('a-name');
    const p = w.stepAt.get('a')!;
    act(() => seen.props!.onNodeDragStop!({}, stepNode('w1', 'a', p.x, p.y + HEADER_H)));
    expect(onEdit.moveStep).not.toHaveBeenCalled();
  });
  it('commits a frame move at drag end', async () => {
    const onEdit = { moveStep: vi.fn(), moveFrame: vi.fn(), resizeFrame: vi.fn(), connect: vi.fn() };
    render(<Board workflows={[bw('w1', ['a'])]} selection={null} onSelect={() => {}} initialZoom={1} onEdit={onEdit} />);
    await screen.findByText('a-name');
    act(() => seen.props!.onNodeDragStop!({}, { id: 'wf:w1', type: 'workflow', position: { x: 40, y: 50 }, data: { workflowId: 'w1' } }));
    expect(onEdit.moveFrame).toHaveBeenCalledWith('w1', { x: 40, y: 50 });
  });
  it('stays read-only without onEdit', async () => {
    render(<Board workflows={[bw('w1', ['a'])]} selection={null} onSelect={() => {}} initialZoom={1} />);
    await screen.findByText('a-name');
    expect(seen.props!.onNodeDragStop).toBeUndefined();
    expect(seen.props!.nodesDraggable).toBe(false);
  });
  it('shows the resizer only on the selected frame', async () => {
    const onEdit = { moveStep: vi.fn(), moveFrame: vi.fn(), resizeFrame: vi.fn(), connect: vi.fn() };
    const { rerender } = render(<Board workflows={[bw('w1', ['a'])]} selection={null} onSelect={() => {}} initialZoom={1} onEdit={onEdit} />);
    await screen.findByText('a-name');
    expect(document.querySelector('.react-flow__resize-control')).toBeNull();
    rerender(<Board workflows={[bw('w1', ['a'])]} selection={{ kind: 'workflow', workflowId: 'w1' }} onSelect={() => {}} initialZoom={1} onEdit={onEdit} />);
    expect(document.querySelector('.react-flow__resize-control')).not.toBeNull();
  });
  it('resizes only from the right edge, the bottom edge and their corner', async () => {
    const onEdit = { moveStep: vi.fn(), moveFrame: vi.fn(), resizeFrame: vi.fn(), connect: vi.fn() };
    render(<Board workflows={[bw('w1', ['a'])]} selection={{ kind: 'workflow', workflowId: 'w1' }} onSelect={() => {}} initialZoom={1} onEdit={onEdit} />);
    await screen.findByText('a-name');
    const controls = [...document.querySelectorAll('.react-flow__resize-control')];
    expect(controls.some((c) => c.classList.contains('top') || c.classList.contains('left'))).toBe(false);
    expect(controls.map((c) => [...c.classList].filter((k) => k === 'right' || k === 'bottom').join(' ')).sort()).toEqual(['bottom', 'bottom right', 'right']);
  });
  it('connects a wire dropped on the body of a step', async () => {
    const onEdit = { moveStep: vi.fn(), moveFrame: vi.fn(), resizeFrame: vi.fn(), connect: vi.fn() };
    const w = bw('w1', ['a', 'b']);
    render(<Board workflows={[w]} selection={null} onSelect={() => {}} initialZoom={1} onEdit={onEdit} />);
    await screen.findByText('a-name');
    const a = w.stepAt.get('a')!;
    act(() => seen.props!.onConnectEnd!({ clientX: a.x + 50, clientY: HEADER_H + a.y + 40 },
      { isValid: false, fromNode: stepNode('w1', 'b', 0, 0), toNode: null }));
    expect(onEdit.connect).toHaveBeenCalledWith('w1', 'b', 'w1', 'a');
  });
  it('connects a wire dropped on the wrong handle of a step to that step', async () => {
    const onEdit = { moveStep: vi.fn(), moveFrame: vi.fn(), resizeFrame: vi.fn(), connect: vi.fn() };
    render(<Board workflows={[bw('w1', ['a', 'b'])]} selection={null} onSelect={() => {}} initialZoom={1} onEdit={onEdit} />);
    await screen.findByText('a-name');
    act(() => seen.props!.onConnectEnd!({ clientX: 5000, clientY: 5000 },
      { isValid: false, fromNode: stepNode('w1', 'b', 0, 0), toNode: stepNode('w1', 'a', 0, 0) }));
    expect(onEdit.connect).toHaveBeenCalledWith('w1', 'b', 'w1', 'a');
  });
  it('hides the wires when zoomed far out, where the steps draw no handles', async () => {
    render(<Board workflows={[bw('w1', ['a', 'b'], [{ id: 'a>b', from: 'a', to: 'b', condition: 1 }])]} selection={null} onSelect={() => {}} initialZoom={0.2} />);
    await screen.findByText('2 steps');
    const edges = () => seen.props!.edges as unknown as { hidden?: boolean }[];
    await waitFor(() => expect(edges().map((e) => e.hidden)).toEqual([true]));
  });
});

describe('App wiring', () => {
  const setup = async () => {
    render(<App api={fakeApi({ workflows: [wf('w1'), wf('w2')], graph: graphWith({ entry: ['a'], steps: { a: ['b'], b: [] } }) })}
      live={liveStub()} storage={memoryStorage()} session={memoryStorage()} />);
    await screen.findByText('Board loaded: 2 workflows');
    await screen.findAllByText('a-name');
  };
  it('refuses a wire across workflows', async () => {
    await setup();
    act(() => seen.props!.onConnect!({ source: 'st:w1:a', target: 'st:w2:b' }));
    expect(await screen.findByText('A wire stays inside its workflow')).toBeInTheDocument();
    expect(screen.queryByText('That wire already exists')).toBeNull();
  });
  it('logs a wire dropped on nothing', async () => {
    await setup();
    act(() => seen.props!.onConnectEnd!({}, { isValid: false, fromNode: stepNode('w1', 'a', 0, 0), toNode: null }));
    expect(await screen.findByText('A wire must end on a step')).toBeInTheDocument();
  });
  it('adds a wire inside a workflow and refuses the same one again', async () => {
    await setup();
    act(() => seen.props!.onConnect!({ source: 'st:w1:b', target: 'st:w1:a' }));
    expect(screen.queryByText('That wire already exists')).toBeNull();
    act(() => seen.props!.onConnect!({ source: 'st:w1:b', target: 'st:w1:a' }));
    expect(await screen.findByText('That wire already exists')).toBeInTheDocument();
  });
});
