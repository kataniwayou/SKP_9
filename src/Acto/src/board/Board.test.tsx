import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import { describe, expect, it, vi } from 'vitest';
import { board, scheduledBoard, schemaBoard } from '../design/boardFixtures';
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

const view = (over: Partial<BoardView> = {}): BoardView => ({ workflows: [], picks: [], live: () => 'stopped', ...over });
const show = (over: Partial<BoardProps> = {}) => render(<Board state={board()} view={view()} onPick={() => {}} initialZoom={1} {...over} />);
const node = (id: string, x: number, y: number): Node => ({ id, position: { x, y }, data: {} });

describe('Board', () => {
  it('draws a triangle with its name, state and its two handles, and a cache block', async () => {
    show();
    const tri = (await screen.findByText('daily', { selector: '.tri-nm' })).closest('.react-flow__node') as HTMLElement;
    expect(tri).toHaveClass('react-flow__node-workflow');
    expect(tri.querySelector('.tri-st')).toHaveTextContent('■ stopped');
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
    // a wire wears its target step's condition colour but no letter: the step's pill shows it [user, 2026-11-25]
    expect(document.querySelector('.link-wire')).toHaveAttribute('data-condition', 'Completed');
    expect(document.querySelector('.link-wire')).toHaveStyle({ color: '#0F9488' });
    expect(document.querySelector('.link-wire .pilltx, .link-wire .pill')).toBeNull();
  });
  it('dims nothing when a triangle is selected, and shows its payload chip', async () => {
    show({ view: view({ workflows: ['daily'], picks: [{ kind: 'workflow', id: 'daily' }] }) });
    await screen.findByText('fetch-orders');
    expect(document.querySelectorAll('.react-flow__node.dim, .react-flow__edge.dim')).toHaveLength(0);
    expect(screen.getByText('◆ 0 keys')).toHaveClass('key-chip');
    expect(document.querySelector('.tri.sel')).not.toBeNull();
  });
  it('shows the run state on the triangle', async () => {
    show({ view: view({ live: (id) => (id === 'daily' ? 'running' : 'unknown') }) });
    await screen.findByText('daily', { selector: '.tri-nm' });
    expect(screen.getByText('● running')).toBeInTheDocument();
    expect(screen.getByText('checking…')).toBeInTheDocument();
  });
  it('marks a running workflow\'s wire as flowing', async () => {
    show({ state: scheduledBoard(), view: view({ live: (id) => (id === 'daily' ? 'running' : 'stopped') }) });
    await screen.findByText('fetch-orders');
    expect(document.querySelector('.wire.running')).not.toBeNull();
  });

  describe('schemas mode', () => {
    it('draws schema and processor cards with their tags, and the dotted reference wires with their slot letters', async () => {
      show({ state: schemaBoard(), view: view({ schemas: true }) });
      const sx = (await screen.findByText('orders-in')).closest('.react-flow__node') as HTMLElement;
      expect(sx).toHaveClass('react-flow__node-schema');
      expect(sx.querySelector('.schema-card')).toHaveTextContent(/SCHEMA/);
      expect(sx.querySelector('.schema-tag')).toBeNull();
      const tag = (name: string) => (screen.getByText(name).closest('.schema-card') as HTMLElement).querySelector('.schema-tag');
      expect(tag('held-out')).toHaveTextContent('held');
      expect(tag('old-copy')).toHaveTextContent('orphan');
      const proc = screen.getByText('idle-proc').closest('.proc-card') as HTMLElement;
      expect(proc).toHaveTextContent('PROCESSOR');
      expect(proc).toHaveTextContent('no step');
      expect(proc).toHaveTextContent('2.0.0 · inst-7');
      expect(document.querySelectorAll('.schema-ref')).toHaveLength(7);
      expect([...document.querySelectorAll('.schema-ref .schema-ref-slot')].map((t) => t.textContent).sort().join('')).toBe('CCCIIIO');
    });
    it('hovering a schema card thickens its wires', async () => {
      show({ state: schemaBoard(), view: view({ schemas: true }) });
      const sc = (await screen.findByText('orders-cfg')).closest('.react-flow__node') as HTMLElement;
      expect(document.querySelectorAll('.schema-ref.lit')).toHaveLength(0);
      fireEvent.mouseEnter(sc);
      await waitFor(() => expect(document.querySelectorAll('.schema-ref.lit')).toHaveLength(3));
      fireEvent.mouseLeave(sc);
      await waitFor(() => expect(document.querySelectorAll('.schema-ref.lit')).toHaveLength(0));
    });
  });

  describe('the React Flow look', () => {
    it('draws a step as a header (processor, condition pill) over the step name, with no ring unless it runs', async () => {
      show();
      await screen.findByText('fetch-orders');
      const card = screen.getByText('fetch-orders').closest('.node') as HTMLElement;
      expect(card.querySelector('.bn-header')).toHaveTextContent('proc');
      expect(card.querySelector('.bn-header .cond-pill')).toHaveTextContent('C');
      expect(card.querySelector('.bn-body')).toHaveTextContent('fetch-orders');
      expect(card).not.toHaveClass('running');
    });
    it('rings the steps a running workflow reaches, and animates only its entry arrows and wires', async () => {
      show({ state: scheduledBoard(), view: view({ live: (id) => (id === 'daily' ? 'running' : 'stopped') }) });
      await screen.findByText('fetch-orders');
      expect(screen.getByText('fetch-orders').closest('.node')).toHaveClass('running');
      expect(document.querySelectorAll('.entry-line.running')).toHaveLength(1);
      expect(document.querySelector('.cache-line.running')).toBeNull();
      expect(document.querySelector('.wire.running')).not.toBeNull();
    });
    it('draws a running triangle with a ring and "● running", a stopped one S1 with a stop square, an unknown one "checking…"', async () => {
      show({ view: view({ live: (id) => (id === 'daily' ? 'running' : id === 'hourly' ? 'stopped' : 'unknown') }) });
      await screen.findByText('daily', { selector: '.tri-nm' });
      const tri = (id: string) => document.querySelector(`[data-workflow="${id}"]`) as HTMLElement;
      expect(tri('daily')).toHaveClass('running');
      expect(tri('daily').querySelector('.tri-ring')).not.toBeNull();
      expect(tri('daily').querySelector('.tri-st')).toHaveTextContent('● running');
      expect(tri('hourly')).toHaveClass('stopped');
      expect(tri('hourly').querySelector('.tri-stop')).not.toBeNull();
      expect(tri('hourly').querySelector('.tri-ring')).toBeNull();
      expect(tri('hourly').querySelector('.tri-st')).toHaveTextContent('■ stopped');
    });
    it('shows no run state "checking…" as a stopped shape', async () => {
      show({ view: view({ live: () => 'unknown' }) });
      await screen.findByText('daily', { selector: '.tri-nm' });
      const t = document.querySelector('[data-workflow="daily"]') as HTMLElement;
      expect(t).toHaveClass('stopped');
      expect(t.querySelector('.tri-st')).toHaveTextContent('checking…');
    });
    it('draws a key chip with its workflow colour as border', async () => {
      show({ view: view({ workflows: ['daily'], picks: [{ kind: 'workflow', id: 'daily' }] }) });
      await screen.findByText('fetch-orders');
      const chip = document.querySelector('.key-chip') as HTMLElement;
      expect(chip).toHaveTextContent('◆ 0 keys');
      expect(chip.style.borderColor).not.toBe('');
    });
    it('draws a ghost triangle with the ghost class on its stopped shape, so the ghost rule styles its body', async () => {
      const row = { ...board().workflows.daily!, id: 'gone-wf', name: 'gone-workflow', at: { x: 5, y: 6 } };
      show({ view: view({ ghosts: [{ key: 'workflow:gone-wf', kind: 'workflow' as const, row, assignments: [] }] }) });
      const name = await screen.findByText('gone-workflow');
      const tri = name.closest('.tri') as HTMLElement;
      expect(tri).toHaveClass('ghost');
      expect(tri).toHaveClass('stopped');
      expect(tri.querySelector('.tri-body')).not.toBeNull();
    });
    it('draws ghosts faded with their tag, and a ghost wire with the ghost class', async () => {
      const row = { ...board().steps.lonely!, id: 'gone', name: 'gone-step', at: { x: 5, y: 6 } };
      const ghosts = [
        { key: 'step:gone', kind: 'step' as const, row },
        { key: 'wire:fetch:gone', kind: 'wire' as const, from: 'fetch', to: 'gone', condition: 2 },
      ];
      show({ view: view({ ghosts }) });
      const name = await screen.findByText('gone-step');
      const g = name.closest('.react-flow__node') as HTMLElement;
      expect(g).toHaveClass('ghost');
      expect(g.querySelector('.bn-body')).toBeTruthy();
      expect(g).toHaveTextContent('deleted · ghost');
      expect(document.querySelector('.link-wire.ghost')).not.toBeNull();
      expect(document.querySelector('.react-flow__edge.ghost')).not.toBeNull();
    });
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
    it('a click on a handle is no pick and no unpick: the step’s out handle, the triangle’s tip, picked or not', async () => {
      const onPick = vi.fn();
      show({ onPick, view: view({ workflows: ['daily'], picks: [{ kind: 'step', id: 'fetch' }, { kind: 'workflow', id: 'daily' }] }) });
      const stepNode = (await screen.findByText('fetch-orders')).closest('.react-flow__node') as HTMLElement;
      const triNode = screen.getByText('daily', { selector: '.tri-nm' }).closest('.react-flow__node') as HTMLElement;
      const handles = [...stepNode.querySelectorAll('.react-flow__handle'), ...triNode.querySelectorAll('.react-flow__handle')];
      expect(handles.length).toBeGreaterThan(2);
      // React Flow's click-to-connect looks under the pointer; jsdom has no layout
      const had = Object.prototype.hasOwnProperty.call(document, 'elementFromPoint');
      Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => null });
      try {
        for (const h of handles) fireEvent.click(h);
        fireEvent.click(screen.getByText('expand').closest('.react-flow__node')!.querySelector('.react-flow__handle')!);
      } finally {
        if (!had) delete (document as { elementFromPoint?: unknown }).elementFromPoint;
      }
      expect(onPick).not.toHaveBeenCalled();
      // and the board still draws the picks as selected: React Flow's own select-on-click is put right
      await waitFor(() => expect([...document.querySelectorAll('.react-flow__node.selected')].map((n) => n.getAttribute('data-id')).sort())
        .toEqual(['st:fetch', 'wf:daily']));
      // the body of the same node still picks
      fireEvent.click(screen.getByText('fetch-orders'));
      expect(onPick.mock.calls).toEqual([[{ kind: 'step', id: 'fetch' }, false]]);
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
      // dropped clear of everything (a drop on an item slides aside: tested below)
      act(() => seen.props!.onNodeDragStop!({}, node('st:fetch', 3000, 3000)));
      act(() => seen.props!.onNodeDragStop!({}, node('wf:daily', 5000, 5000)));
      expect(onMove.mock.calls).toEqual([
        [[{ ref: { kind: 'step', id: 'fetch' }, at: { x: 3000, y: 3000 } }]],
        [[{ ref: { kind: 'workflow', id: 'daily' }, at: { x: 5000, y: 5000 } }]]]);
    });
    it('commits a multi-node drag as one onMove, and nothing when nothing moved', async () => {
      const onMove = vi.fn();
      show({ onMove });
      await screen.findByText('fetch-orders');
      const all = [node('st:fetch', 3000, 3000), node('st:expand', 3300, 3000), node('ca:c1', 0, -100)];
      act(() => seen.props!.onNodeDragStop!({}, all[0]!, all));
      expect(onMove).toHaveBeenCalledTimes(1);
      expect(onMove.mock.calls[0]![0]).toEqual([
        { ref: { kind: 'step', id: 'fetch' }, at: { x: 3000, y: 3000 } }, { ref: { kind: 'step', id: 'expand' }, at: { x: 3300, y: 3000 } }]);
      onMove.mockClear();
      act(() => seen.props!.onNodeDragStop!({}, node('st:fetch', 200, 200)));
      expect(onMove).not.toHaveBeenCalled();
    });
    it('a drag of ghosts and real items commits the real ones to onMove and the ghosts to onMoveGhosts', async () => {
      const onMove = vi.fn(); const onMoveGhosts = vi.fn();
      show({ onMove, onMoveGhosts });
      await screen.findByText('fetch-orders');
      // dropped clear of everything, so nothing is pushed aside
      const g = { ...node('ghost:step:gone', 3000, 3060), className: 'ghost' };
      const all = [node('st:fetch', 3000, 3200), g];
      act(() => seen.props!.onNodeDragStop!({}, all[0]!, all));
      expect(onMove.mock.calls).toEqual([[[{ ref: { kind: 'step', id: 'fetch' }, at: { x: 3000, y: 3200 } }]]]);
      expect(onMoveGhosts.mock.calls).toEqual([[[{ key: 'step:gone', at: { x: 3000, y: 3060 } }]]]);
    });
    it('a drop on another item slides to the nearest free place, clear of it [user, 2026-11-25, option B]', async () => {
      const onMove = vi.fn();
      show({ onMove });
      await screen.findByText('fetch-orders');
      // the expand step sits at its fixture place: drop fetch right on top of it
      const expand = document.querySelector('.react-flow__node-step[data-id="st:expand"]') as HTMLElement;
      const at = /translate\(([-\d.]+)px, *([-\d.]+)px\)/.exec(expand.style.transform)!;
      const [ex, ey] = [Number(at[1]), Number(at[2])];
      act(() => seen.props!.onNodeDragStop!({}, node('st:fetch', ex, ey), [node('st:fetch', ex, ey)]));
      const [[moved]] = onMove.mock.calls as [[{ ref: unknown; at: { x: number; y: number } }[]]];
      expect(moved![0]!.ref).toEqual({ kind: 'step', id: 'fetch' });
      expect(moved![0]!.at).not.toEqual({ x: ex, y: ey });
    });
    it('a drop on a ghost slides too, and a dragged ghost is pushed off a real item [user, 2026-11-25]', async () => {
      const onMove = vi.fn(); const onMoveGhosts = vi.fn();
      const ghostAt = { x: 2000, y: 2000 };
      show({ onMove, onMoveGhosts, view: view({ ghosts: [{ key: 'step:gone', kind: 'step', row: { ...board().steps.lonely!, id: 'gone', name: 'gone', at: ghostAt } }] }) });
      await screen.findByText('fetch-orders');
      act(() => seen.props!.onNodeDragStop!({}, node('st:fetch', ghostAt.x, ghostAt.y), [node('st:fetch', ghostAt.x, ghostAt.y)]));
      expect((onMove.mock.calls[0]![0] as { at: { x: number; y: number } }[])[0]!.at).not.toEqual(ghostAt);
      // and the other way round: the ghost dropped on the step
      const lonely = document.querySelector('.react-flow__node-step[data-id="st:lonely"]') as HTMLElement;
      const m = /translate\(([-\d.]+)px, *([-\d.]+)px\)/.exec(lonely.style.transform)!;
      const g = { ...node('ghost:step:gone', Number(m[1]), Number(m[2])), className: 'ghost' };
      act(() => seen.props!.onNodeDragStop!({}, g, [g]));
      expect((onMoveGhosts.mock.calls[0]![0] as { at: { x: number; y: number } }[])[0]!.at).not.toEqual({ x: Number(m[1]), y: Number(m[2]) });
    });
    it('dropping a schema card on a step pushes it aside, and commits it as a schema move', async () => {
      const onMove = vi.fn();
      show({ onMove, state: schemaBoard(), view: view({ schemas: true }) });
      await screen.findByText('orders-in');
      const expand = document.querySelector('.react-flow__node-step[data-id="st:expand"]') as HTMLElement;
      const at = /translate\(([-\d.]+)px, *([-\d.]+)px\)/.exec(expand.style.transform)!;
      const [ex, ey] = [Number(at[1]), Number(at[2])];
      const card = { ...node('sc:so', ex, ey), measured: { width: 190, height: 52 } };
      act(() => seen.props!.onNodeDragStop!({}, card, [card]));
      const [[moved]] = onMove.mock.calls as [[{ ref: unknown; at: { x: number; y: number } }[]]];
      expect(moved![0]!.ref).toEqual({ kind: 'schema', id: 'so' });
      expect(moved![0]!.at).not.toEqual({ x: ex, y: ey });
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
