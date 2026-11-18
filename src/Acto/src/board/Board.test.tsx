import { act, fireEvent, render, screen } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import { describe, expect, it, vi } from 'vitest';
import { board } from '../design/boardFixtures';
import { Board, type BoardProps } from './Board';
import type { Pick } from './selection';
import type { BoardView } from './toFlow';

type Props = Record<string, (...a: unknown[]) => void>;
const seen: { props: Props | null } = { props: null };

vi.mock('@xyflow/react', async (orig) => {
  const mod = await orig<typeof import('@xyflow/react')>();
  const Real = mod.ReactFlow;
  return { ...mod, ReactFlow: (p: Record<string, unknown>) => { seen.props = p as Props; return <Real {...(p as object)} />; } };
});

const view = (over: Partial<BoardView> = {}): BoardView => ({ workflow: null, picks: [], live: () => 'stopped', ...over });
const show = (over: Partial<BoardProps> = {}) => render(<Board state={board()} view={view()} onPick={() => {}} initialZoom={1} {...over} />);
const node = (id: string, x: number, y: number): Node => ({ id, position: { x, y }, data: {} });

describe('Board', () => {
  it('draws a triangle with its name, state and its two handles, and a cache block', async () => {
    show();
    const tri = (await screen.findByText('daily', { selector: '.tri-nm' })).closest('.react-flow__node') as HTMLElement;
    expect(tri).toHaveClass('react-flow__node-workflow');
    expect(tri.querySelector('.tri-st')).toHaveTextContent('Stopped');
    expect([...tri.querySelectorAll('.react-flow__handle')].map((h) => h.getAttribute('data-handleid'))).toEqual(['tip', 'back']);
    const cache = screen.getByText('c1').closest('.react-flow__node') as HTMLElement;
    expect(cache).toHaveClass('react-flow__node-cache');
    expect(cache.querySelectorAll('.react-flow__handle')).toHaveLength(1);
  });
  it('draws every step at every zoom, far out too, each with both handles', async () => {
    show({ initialZoom: 0.1 });
    expect(await screen.findByText('fetch-orders')).toBeInTheDocument();
    const step = document.querySelector('.react-flow__node-step') as HTMLElement;
    expect([...step.querySelectorAll('.react-flow__handle')].map((h) => h.getAttribute('data-handleid'))).toEqual(['in', 'out']);
    expect((step.firstElementChild as HTMLElement).style.visibility).not.toBe('hidden');
  });
  it('shows no FIRST, PARKED or shared tags', async () => {
    show();
    await screen.findByText('fetch-orders');
    expect(document.querySelector('.node .tag')).toBeNull();
  });
  it('draws the entry arrows, the cache line and a wire with its condition letter', async () => {
    show();
    await screen.findByText('fetch-orders');
    expect(document.querySelectorAll('.entry-edge')).toHaveLength(2);
    expect(document.querySelectorAll('.cache-edge')).toHaveLength(1);
    expect(document.querySelectorAll('.link-wire')).toHaveLength(1);
    expect(screen.getByText('C', { selector: '.pilltx' })).toBeInTheDocument();
  });
  it('dims what the selected triangle does not reach and lights its payloads', async () => {
    show({ view: view({ workflow: 'daily', picks: [{ kind: 'workflow', id: 'daily' }] }) });
    await screen.findByText('fetch-orders');
    const dimmed = [...document.querySelectorAll('.react-flow__node.dim, .react-flow__edge.dim')].map((e) => e.getAttribute('data-id') ?? e.getAttribute('data-testid'));
    expect(dimmed).toEqual(expect.arrayContaining(['st:lonely', 'wf:hourly']));
    expect(dimmed).not.toContain('st:fetch');
    expect(screen.getByText('0 keys')).toHaveClass('pay');
    expect(document.querySelector('.tri.sel')).not.toBeNull();
  });
  it('shows the run state on the triangle', async () => {
    show({ view: view({ live: (id) => (id === 'daily' ? 'running' : 'unknown') }) });
    await screen.findByText('daily', { selector: '.tri-nm' });
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });
  it('marks a running workflow\'s wire as flowing', async () => {
    show({ view: view({ live: (id) => (id === 'daily' ? 'running' : 'stopped') }) });
    await screen.findByText('fetch-orders');
    expect(document.querySelector('.wire.running')).not.toBeNull();
  });

  describe('picking', () => {
    it('reports a click on a triangle, a step, a cache and a wire', async () => {
      const onPick = vi.fn();
      show({ onPick });
      fireEvent.click(await screen.findByText('daily', { selector: '.tri-nm' }));
      fireEvent.click(screen.getByText('fetch-orders'));
      fireEvent.click(screen.getByText('c1'));
      fireEvent.click(document.querySelector('[data-id="wire:fetch:expand"]')!);
      expect(onPick.mock.calls).toEqual([
        [{ kind: 'workflow', id: 'daily' }, false], [{ kind: 'step', id: 'fetch' }, false],
        [{ kind: 'cache', id: 'c1' }, false], [{ kind: 'wire', from: 'fetch', to: 'expand' }, false]]);
    });
    it('reports a click on an entry arrow and a cache line', async () => {
      const onPick = vi.fn();
      show({ onPick });
      await screen.findByText('fetch-orders');
      fireEvent.click(document.querySelector('[data-id="entry:daily:fetch"]')!);
      fireEvent.click(document.querySelector('[data-id="cache:daily:c1"]')!);
      expect(onPick.mock.calls).toEqual([
        [{ kind: 'entry', workflowId: 'daily', stepId: 'fetch' }, false], [{ kind: 'cacheLink', workflowId: 'daily', cacheId: 'c1' }, false]]);
    });
    it('reports a Ctrl+click as additive and a click on empty board as no pick', async () => {
      const onPick = vi.fn();
      show({ onPick });
      fireEvent.click(await screen.findByText('fetch-orders'), { ctrlKey: true });
      fireEvent.click(screen.getByText('expand'), { metaKey: true });
      fireEvent.click(document.querySelector('.react-flow__pane')!);
      expect(onPick.mock.calls).toEqual([[{ kind: 'step', id: 'fetch' }, true], [{ kind: 'step', id: 'expand' }, true], [null, false]]);
    });
    it('marks the picked step, cache and wire as selected', async () => {
      const picks: Pick[] = [{ kind: 'step', id: 'fetch' }, { kind: 'wire', from: 'fetch', to: 'expand' }];
      show({ view: view({ picks }) });
      await screen.findByText('fetch-orders');
      expect(screen.getByText('fetch-orders').closest('.node')).toHaveClass('sel');
      expect(screen.getByText('expand').closest('.node')).not.toHaveClass('sel');
      expect(document.querySelector('.link-wire .wire.sel')).not.toBeNull();
    });
    it('numbers several picks, with no toolbar; a lone pick has a toolbar and no number', async () => {
      const toolbar = () => [{ label: 'Delete', tone: 'danger' as const, onClick: () => {} }];
      const a: Pick = { kind: 'step', id: 'fetch' };
      const b: Pick = { kind: 'step', id: 'expand' };
      const { rerender } = show({ view: view({ picks: [b, a] }), onMove: () => {}, toolbar });
      await screen.findByText('fetch-orders');
      expect(screen.getByText('expand').closest('.node')!.querySelector('.pick-no')).toHaveTextContent('1');
      expect(screen.getByText('fetch-orders').closest('.node')!.querySelector('.pick-no')).toHaveTextContent('2');
      expect(document.querySelector('[role=toolbar]')).toBeNull();
      rerender(<Board state={board()} view={view({ picks: [a] })} onPick={() => {}} initialZoom={1} onMove={() => {}} toolbar={toolbar} />);
      expect(await screen.findByRole('toolbar')).toHaveTextContent('Delete');
      expect(document.querySelector('.pick-no')).toBeNull();
    });
    it('draws no toolbar without a provider or on a read-only board', async () => {
      const { rerender } = show({ view: view({ picks: [{ kind: 'step', id: 'fetch' }] }), onMove: () => {} });
      await screen.findByText('fetch-orders');
      expect(document.querySelector('[role=toolbar]')).toBeNull();
      rerender(<Board state={board()} view={view({ picks: [{ kind: 'step', id: 'fetch' }] })} onPick={() => {}} initialZoom={1}
        toolbar={() => [{ label: 'Delete', onClick: () => {} }]} />);
      expect(document.querySelector('[role=toolbar]')).toBeNull();
    });
  });

  describe('editing', () => {
    it('is read-only without onMove and onConnect', async () => {
      show();
      await screen.findByText('fetch-orders');
      expect(seen.props!.nodesDraggable).toBe(false);
      expect(seen.props!.nodesConnectable).toBe(false);
    });
    it('commits one onMove at drag stop, for a triangle too', async () => {
      const onMove = vi.fn();
      show({ onMove });
      await screen.findByText('fetch-orders');
      act(() => seen.props!.onNodeDragStop!({}, node('st:fetch', 260, 230)));
      act(() => seen.props!.onNodeDragStop!({}, node('wf:daily', 40, 50)));
      expect(onMove.mock.calls).toEqual([
        [[{ ref: { kind: 'step', id: 'fetch' }, at: { x: 260, y: 230 } }]],
        [[{ ref: { kind: 'workflow', id: 'daily' }, at: { x: 40, y: 50 } }]]]);
    });
    it('commits a multi-node drag as one onMove, and nothing when nothing moved', async () => {
      const onMove = vi.fn();
      show({ onMove });
      await screen.findByText('fetch-orders');
      const all = [node('st:fetch', 260, 230), node('st:expand', 460, 230), node('ca:c1', 0, -100)];
      act(() => seen.props!.onNodeDragStop!({}, all[0]!, all));
      expect(onMove).toHaveBeenCalledTimes(1);
      expect(onMove.mock.calls[0]![0]).toEqual([
        { ref: { kind: 'step', id: 'fetch' }, at: { x: 260, y: 230 } }, { ref: { kind: 'step', id: 'expand' }, at: { x: 460, y: 230 } }]);
      onMove.mockClear();
      act(() => seen.props!.onNodeDragStop!({}, node('st:fetch', 200, 200)));
      expect(onMove).not.toHaveBeenCalled();
    });
    it('Esc during a drag puts the node back and the drag stop commits nothing', async () => {
      const onMove = vi.fn();
      show({ onMove });
      await screen.findByText('fetch-orders');
      const card = () => document.querySelector('.react-flow__node-step[data-id="st:fetch"]') as HTMLElement;
      const before = card().style.transform;
      act(() => seen.props!.onNodeDragStart!({}, node('st:fetch', 200, 200), [node('st:fetch', 200, 200)]));
      const move = (x: number, y: number) => act(() => (seen.props!.onNodesChange as unknown as (c: unknown[]) => void)([{ type: 'position', id: 'st:fetch', position: { x, y }, dragging: true }]));
      move(280, 240);
      expect(card().style.transform).not.toBe(before);
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(card().style.transform).toBe(before);
      move(290, 250);
      expect(card().style.transform).toBe(before);
      act(() => seen.props!.onNodeDragStop!({}, node('st:fetch', 290, 250)));
      expect(onMove).not.toHaveBeenCalled();
    });
    it('Esc with no drag clears the picks, but not while typing in a field', async () => {
      const onPick = vi.fn();
      show({ onPick, onMove: () => {}, view: view({ picks: [{ kind: 'step', id: 'fetch' }] }) });
      await screen.findByText('fetch-orders');
      const input = document.createElement('input');
      document.body.appendChild(input);
      fireEvent.keyDown(input, { key: 'Escape' });
      expect(onPick).not.toHaveBeenCalled();
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(onPick).toHaveBeenCalledWith(null, false);
      input.remove();
    });
    it('reports each kind of connection with the items it joins', async () => {
      const onConnect = vi.fn();
      show({ onConnect });
      await screen.findByText('fetch-orders');
      const make = seen.props!.onConnect!;
      act(() => make({ source: 'st:expand', sourceHandle: 'out', target: 'st:lonely', targetHandle: 'in' }));
      act(() => make({ source: 'wf:daily', sourceHandle: 'tip', target: 'st:lonely', targetHandle: 'in' }));
      act(() => make({ source: 'wf:hourly', sourceHandle: 'back', target: 'ca:c1', targetHandle: 'in' }));
      act(() => make({ source: 'wf:hourly', sourceHandle: 'tip', target: 'ca:c1', targetHandle: 'in' }));
      expect(onConnect.mock.calls).toEqual([['wire', 'expand', 'lonely'], ['entry', 'daily', 'lonely'], ['cacheLink', 'hourly', 'c1']]);
    });
    it('offers React Flow only the connections that mean something', async () => {
      show({ onConnect: () => {} });
      await screen.findByText('fetch-orders');
      const valid = seen.props!.isValidConnection as unknown as (c: unknown) => boolean;
      expect(valid({ source: 'wf:daily', sourceHandle: 'tip', target: 'st:fetch', targetHandle: 'in' })).toBe(true);
      expect(valid({ source: 'st:fetch', sourceHandle: 'out', target: 'wf:daily', targetHandle: 'tip' })).toBe(false);
    });

    describe('a press on a triangle, through React Flow', () => {
      // React Flow's own drag (d3-drag): the press on the node, the moves and the release on the window
      const gesture = (el: HTMLElement, path: [number, number][]) => {
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
      const tri = () => document.querySelector('[data-id="wf:daily"]') as HTMLElement;
      it('a click that wobbles a few pixels picks it and moves nothing', async () => {
        const onMove = vi.fn();
        const onPick = vi.fn();
        show({ onMove, onPick, initialZoom: 0.5 });
        await screen.findByText('fetch-orders');
        act(() => gesture(tri(), [[200, 120], [199, 119], [198, 118], [197, 117]]));
        fireEvent.click(tri(), { clientX: 197, clientY: 117 });
        expect(onMove).not.toHaveBeenCalled();
        expect(onPick).toHaveBeenCalledWith({ kind: 'workflow', id: 'daily' }, false);
      });
      it('a real drag still moves it, by the distance dragged', async () => {
        const onMove = vi.fn();
        show({ onMove });
        await screen.findByText('fetch-orders');
        const path: [number, number][] = [[200, 120]];
        for (let i = 1; i <= 20; i++) path.push([200 + i * 5, 120]);
        act(() => gesture(tri(), path));
        expect(onMove).toHaveBeenCalledTimes(1);
        const [moved] = onMove.mock.calls[0]![0] as { ref: unknown; at: { x: number } }[];
        expect(moved!.ref).toEqual({ kind: 'workflow', id: 'daily' });
        expect(moved!.at.x).toBeGreaterThan(80);
      });
    });
  });
});
