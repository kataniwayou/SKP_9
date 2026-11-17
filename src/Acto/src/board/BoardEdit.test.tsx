import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  it('commits one moveMany at drag end, with y relative to the frame content', async () => {
    const onEdit = { moveMany: vi.fn(), resizeFrame: vi.fn(), connect: vi.fn() };
    render(<Board workflows={[bw('w1', ['a'])]} picks={[]} onPick={() => {}} initialZoom={1} onEdit={onEdit} />);
    await screen.findByText('a-name');
    act(() => seen.props!.onNodeDragStop!({}, stepNode('w1', 'a', 100, 90 + HEADER_H)));
    expect(onEdit.moveMany).toHaveBeenCalledTimes(1);
    expect(onEdit.moveMany).toHaveBeenCalledWith('w1', { steps: [{ id: 'a', at: { x: 100, y: 90 } }] });
  });
  it('commits a multi-node drag as one moveMany per workflow', async () => {
    const onEdit = { moveMany: vi.fn(), resizeFrame: vi.fn(), connect: vi.fn() };
    render(<Board workflows={[bw('w1', ['a', 'b']), bw('w2', ['c'], [], { x: 600, y: 0 })]} picks={[]} onPick={() => {}} initialZoom={1} onEdit={onEdit} />);
    await screen.findByText('a-name');
    const all = [stepNode('w1', 'a', 100, 90 + HEADER_H), stepNode('w1', 'b', 300, 90 + HEADER_H), stepNode('w2', 'c', 100, 90 + HEADER_H)];
    act(() => seen.props!.onNodeDragStop!({}, all[0]!, all));
    expect(onEdit.moveMany).toHaveBeenCalledTimes(2);
    expect(onEdit.moveMany).toHaveBeenCalledWith('w1', { steps: [{ id: 'a', at: { x: 100, y: 90 } }, { id: 'b', at: { x: 300, y: 90 } }] });
    expect(onEdit.moveMany).toHaveBeenCalledWith('w2', { steps: [{ id: 'c', at: { x: 100, y: 90 } }] });
  });
  it('commits nothing when the drag ends where the step already was', async () => {
    const onEdit = { moveMany: vi.fn(), resizeFrame: vi.fn(), connect: vi.fn() };
    const w = bw('w1', ['a']);
    render(<Board workflows={[w]} picks={[]} onPick={() => {}} initialZoom={1} onEdit={onEdit} />);
    await screen.findByText('a-name');
    const p = w.stepAt.get('a')!;
    act(() => seen.props!.onNodeDragStop!({}, stepNode('w1', 'a', p.x, p.y + HEADER_H)));
    expect(onEdit.moveMany).not.toHaveBeenCalled();
  });
  it('commits a frame move at drag end', async () => {
    const onEdit = { moveMany: vi.fn(), resizeFrame: vi.fn(), connect: vi.fn() };
    render(<Board workflows={[bw('w1', ['a'])]} picks={[]} onPick={() => {}} initialZoom={1} onEdit={onEdit} />);
    await screen.findByText('a-name');
    act(() => seen.props!.onNodeDragStop!({}, { id: 'wf:w1', type: 'workflow', position: { x: 40, y: 50 }, data: { workflowId: 'w1' } }));
    expect(onEdit.moveMany).toHaveBeenCalledWith('w1', { steps: [], frame: { x: 40, y: 50 } });
  });
  describe('a press on a frame, through React Flow', () => {
    // React Flow's own drag (d3-drag): the press on the node, the moves and the release on the window
    const gesture = (el: HTMLElement, path: [number, number][]) => {
      // d3-drag listens on the event's view (jsdom's MouseEvent will not take the test window as one: set after)
      const view = el.ownerDocument.defaultView!;
      const mouse = (type: string, x: number, y: number) => {
        const e = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === 'mouseup' ? 0 : 1, clientX: x, clientY: y });
        Object.defineProperty(e, 'view', { value: view });
        return e;
      };
      const [x0, y0] = path[0]!;
      fireEvent(el, mouse('mousedown', x0, y0));
      for (const [x, y] of path.slice(1)) fireEvent(view, mouse('mousemove', x, y));
      const [x1, y1] = path.at(-1)!;
      fireEvent(view, mouse('mouseup', x1, y1));
    };
    const frame = () => document.querySelector('[data-id="wf:w1"]') as HTMLElement;

    it('a click that wobbles a few pixels picks the frame and moves nothing', async () => {
      const onEdit = { moveMany: vi.fn(), resizeFrame: vi.fn(), connect: vi.fn() };
      const onPick = vi.fn();
      render(<Board workflows={[bw('w1', ['a'])]} picks={[]} onPick={onPick} initialZoom={0.5} onEdit={onEdit} />);
      await screen.findByText('a-name');
      // a hand on a mouse: a few one-pixel twitches between press and release (3 px down-left in all)
      act(() => gesture(frame(), [[200, 120], [199, 119], [198, 118], [197, 117]]));
      fireEvent.click(frame(), { clientX: 197, clientY: 117 });
      expect(onEdit.moveMany).not.toHaveBeenCalled();
      expect(onPick).toHaveBeenCalledWith({ kind: 'workflow', workflowId: 'w1' }, false);
    });
    it('a real drag of the frame still moves it, by the distance dragged', async () => {
      const onEdit = { moveMany: vi.fn(), resizeFrame: vi.fn(), connect: vi.fn() };
      const w = bw('w1', ['a']);
      render(<Board workflows={[w]} picks={[]} onPick={() => {}} initialZoom={1} onEdit={onEdit} />);
      await screen.findByText('a-name');
      const path: [number, number][] = [[200, 120]];
      for (let i = 1; i <= 20; i++) path.push([200 + i * 5, 120]);
      act(() => gesture(frame(), path));
      expect(onEdit.moveMany).toHaveBeenCalledTimes(1);
      const [wf, moved] = onEdit.moveMany.mock.calls[0]! as [string, { frame: { x: number; y: number } }];
      expect(wf).toBe('w1');
      // most of the 100 px dragged (jsdom's board has no size, so React Flow's edge auto-pan adds a little)
      expect(moved.frame.x - w.frame.x).toBeGreaterThan(80);
    });
  });
  it('Esc during a drag puts the node back and the drag end commits nothing', async () => {
    const onEdit = { moveMany: vi.fn(), resizeFrame: vi.fn(), connect: vi.fn() };
    const w = bw('w1', ['a']);
    render(<Board workflows={[w]} picks={[]} onPick={() => {}} initialZoom={1} onEdit={onEdit} />);
    await screen.findByText('a-name');
    const p = w.stepAt.get('a')!;
    const at = (x: number, y: number) => stepNode('w1', 'a', x, y + HEADER_H);
    const card = () => document.querySelector('.react-flow__node-step') as HTMLElement;
    const before = card().style.transform;
    act(() => seen.props!.onNodeDragStart!({}, at(p.x, p.y), [at(p.x, p.y)]));
    act(() => (seen.props!.onNodesChange as unknown as (c: unknown[]) => void)([{ type: 'position', id: 'st:w1:a', position: { x: p.x + 80, y: p.y + HEADER_H + 40 }, dragging: true }]));
    expect(card().style.transform).not.toBe(before);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(card().style.transform).toBe(before);
    act(() => (seen.props!.onNodesChange as unknown as (c: unknown[]) => void)([{ type: 'position', id: 'st:w1:a', position: { x: p.x + 90, y: p.y + HEADER_H + 50 }, dragging: true }]));
    expect(card().style.transform).toBe(before);
    act(() => seen.props!.onNodeDragStop!({}, at(p.x + 90, p.y + 50)));
    expect(onEdit.moveMany).not.toHaveBeenCalled();
    expect(card().style.transform).toBe(before);
    // a later drag commits again
    act(() => seen.props!.onNodeDragStart!({}, at(p.x, p.y)));
    act(() => seen.props!.onNodeDragStop!({}, at(p.x + 16, p.y)));
    expect(onEdit.moveMany).toHaveBeenCalledTimes(1);
  });
  it('Esc with no drag in progress does nothing', async () => {
    const onEdit = { moveMany: vi.fn(), resizeFrame: vi.fn(), connect: vi.fn() };
    const w = bw('w1', ['a']);
    render(<Board workflows={[w]} picks={[]} onPick={() => {}} initialZoom={1} onEdit={onEdit} />);
    await screen.findByText('a-name');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    const p = w.stepAt.get('a')!;
    act(() => seen.props!.onNodeDragStop!({}, stepNode('w1', 'a', p.x + 8, p.y + HEADER_H)));
    expect(onEdit.moveMany).toHaveBeenCalledTimes(1);
  });
  it.each([['step'], ['workflow']])('the Delete and Backspace keys leave a picked %s on the board', async (kind) => {
    const onEdit = { moveMany: vi.fn(), resizeFrame: vi.fn(), connect: vi.fn() };
    const picks = kind === 'step' ? [{ kind: 'step' as const, workflowId: 'w1', stepId: 'a' }] : [{ kind: 'workflow' as const, workflowId: 'w1' }];
    render(<Board workflows={[bw('w1', ['a', 'b'])]} picks={picks} onPick={() => {}} initialZoom={1} onEdit={onEdit} />);
    await screen.findByText('a-name');
    const count = () => document.querySelectorAll('.react-flow__node').length;
    const before = count();
    for (const key of ['Backspace', 'Delete']) {
      fireEvent.keyDown(document.body, { key, code: key });
      fireEvent.keyUp(document.body, { key, code: key });
    }
    // React Flow's own remove changes (from any source) must not drop nodes the store still holds
    act(() => (seen.props!.onNodesChange as unknown as (c: unknown[]) => void)([{ type: 'remove', id: 'st:w1:a' }, { type: 'remove', id: 'wf:w1' }]));
    expect(count()).toBe(before);
    expect(seen.props!.deleteKeyCode).toBeNull();
    expect(screen.getByText('a-name')).toBeInTheDocument();
    expect(document.querySelector('.react-flow__node-workflow')).not.toBeNull();
    expect(onEdit.moveMany).not.toHaveBeenCalled();
    expect(onEdit.resizeFrame).not.toHaveBeenCalled();
    expect(onEdit.connect).not.toHaveBeenCalled();
  });
  it('stays read-only without onEdit', async () => {
    render(<Board workflows={[bw('w1', ['a'])]} picks={[]} onPick={() => {}} initialZoom={1} />);
    await screen.findByText('a-name');
    expect(seen.props!.onNodeDragStop).toBeUndefined();
    expect(seen.props!.nodesDraggable).toBe(false);
  });
  it('shows the resizer only on the selected frame', async () => {
    const onEdit = { moveMany: vi.fn(), resizeFrame: vi.fn(), connect: vi.fn() };
    const { rerender } = render(<Board workflows={[bw('w1', ['a'])]} picks={[]} onPick={() => {}} initialZoom={1} onEdit={onEdit} />);
    await screen.findByText('a-name');
    expect(document.querySelector('.react-flow__resize-control')).toBeNull();
    rerender(<Board workflows={[bw('w1', ['a'])]} picks={[{ kind: 'workflow', workflowId: 'w1' }]} onPick={() => {}} initialZoom={1} onEdit={onEdit} />);
    expect(document.querySelector('.react-flow__resize-control')).not.toBeNull();
  });
  it('resizes only from the right edge, the bottom edge and their corner', async () => {
    const onEdit = { moveMany: vi.fn(), resizeFrame: vi.fn(), connect: vi.fn() };
    render(<Board workflows={[bw('w1', ['a'])]} picks={[{ kind: 'workflow', workflowId: 'w1' }]} onPick={() => {}} initialZoom={1} onEdit={onEdit} />);
    await screen.findByText('a-name');
    const controls = [...document.querySelectorAll('.react-flow__resize-control')];
    expect(controls.some((c) => c.classList.contains('top') || c.classList.contains('left'))).toBe(false);
    expect(controls.map((c) => [...c.classList].filter((k) => k === 'right' || k === 'bottom').join(' ')).sort()).toEqual(['bottom', 'bottom right', 'right']);
  });
  it('connects a wire dropped on the body of a step', async () => {
    const onEdit = { moveMany: vi.fn(), resizeFrame: vi.fn(), connect: vi.fn() };
    const w = bw('w1', ['a', 'b']);
    render(<Board workflows={[w]} picks={[]} onPick={() => {}} initialZoom={1} onEdit={onEdit} />);
    await screen.findByText('a-name');
    const a = w.stepAt.get('a')!;
    act(() => seen.props!.onConnectEnd!({ clientX: a.x + 50, clientY: HEADER_H + a.y + 40 },
      { isValid: false, fromNode: stepNode('w1', 'b', 0, 0), toNode: null }));
    expect(onEdit.connect).toHaveBeenCalledWith('w1', 'b', 'w1', 'a');
  });
  it('connects a wire dropped on the wrong handle of a step to that step', async () => {
    const onEdit = { moveMany: vi.fn(), resizeFrame: vi.fn(), connect: vi.fn() };
    render(<Board workflows={[bw('w1', ['a', 'b'])]} picks={[]} onPick={() => {}} initialZoom={1} onEdit={onEdit} />);
    await screen.findByText('a-name');
    act(() => seen.props!.onConnectEnd!({ clientX: 5000, clientY: 5000 },
      { isValid: false, fromNode: stepNode('w1', 'b', 0, 0), toNode: stepNode('w1', 'a', 0, 0) }));
    expect(onEdit.connect).toHaveBeenCalledWith('w1', 'b', 'w1', 'a');
  });
  it('hides the wires when zoomed far out, where the steps draw no handles', async () => {
    render(<Board workflows={[bw('w1', ['a', 'b'], [{ id: 'a>b', from: 'a', to: 'b', condition: 1 }])]} picks={[]} onPick={() => {}} initialZoom={0.2} />);
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
