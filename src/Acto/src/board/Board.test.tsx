import { fireEvent, render, screen } from '@testing-library/react';

import { describe, expect, it, vi } from 'vitest';
import { Board } from './Board';
import { bw } from './fixtures';

describe('Board', () => {
  it('shows every workflow name, an empty frame line and the minimap', async () => {
    render(<Board workflows={[bw('w1', ['a']), bw('w2', [])]} picks={[]} onPick={() => {}} />);
    expect(await screen.findByText('w1-name')).toBeInTheDocument();
    expect(screen.getByText('Empty workflow')).toBeInTheDocument();
    expect(document.querySelector('.react-flow__minimap')).not.toBeNull();
  });
  it('shows only name and step count when zoomed far out', async () => {
    render(<Board workflows={[bw('w1', ['a', 'b'])]} picks={[]} onPick={() => {}} initialZoom={0.3} />);
    expect(await screen.findByText('2 steps')).toBeInTheDocument();
    expect(screen.queryByText('a-name')).toBeNull();
  });
  it('keeps invisible handles on a far step, so a wire drawn before the zoom is known can still be placed', async () => {
    render(<Board workflows={[bw('w1', ['a'])]} picks={[]} onPick={() => {}} initialZoom={0.3} />);
    await screen.findByText('1 step');
    const node = document.querySelector('.react-flow__node-step') as HTMLElement;
    expect(node.querySelectorAll('.react-flow__handle')).toHaveLength(2);
    expect((node.firstElementChild as HTMLElement).style.visibility).toBe('hidden');
  });
  it('lets a click at far zoom fall through the hidden steps to the frame', async () => {
    render(<Board workflows={[bw('w1', ['a'])]} picks={[]} onPick={() => {}} initialZoom={0.3} />);
    await screen.findByText('1 step');
    const node = document.querySelector('.react-flow__node-step') as HTMLElement;
    expect(node.style.pointerEvents).toBe('none');
  });
  it('reports a click on a step as a step selection', async () => {
    const onPick = vi.fn();
    render(<Board workflows={[bw('w1', ['a'])]} picks={[]} onPick={onPick} />);
    fireEvent.click(await screen.findByText('a-name'));
    expect(onPick).toHaveBeenCalledWith({ kind: 'step', workflowId: 'w1', stepId: 'a' }, false);
  });
  it('reports a click on a frame header as a workflow selection', async () => {
    const onPick = vi.fn();
    render(<Board workflows={[bw('w1', ['a'])]} picks={[]} onPick={onPick} />);
    fireEvent.click(await screen.findByText('w1-name'));
    expect(onPick).toHaveBeenCalledWith({ kind: 'workflow', workflowId: 'w1' }, false);
  });
  it('draws a wire with its condition letter', async () => {
    const wires = [{ id: 'a>b', from: 'a', to: 'b', condition: 2 }];
    render(<Board workflows={[bw('w1', ['a', 'b'], wires)]} picks={[]} onPick={() => {}} initialZoom={1} />);
    await screen.findByText('a-name');
    expect(document.querySelector('.link-wire')).not.toBeNull();
    expect(screen.getByText('F')).toBeInTheDocument();
  });
  it('tags parked and first steps and shows "not scheduled"', async () => {
    render(<Board workflows={[bw('w1', ['a', 'b'])]} picks={[]} onPick={() => {}} initialZoom={1} />);
    await screen.findByText('a-name');
    expect(screen.getAllByText('PARKED')).toHaveLength(2);
    expect(screen.getByText(/not scheduled/)).toBeInTheDocument();
  });
  it('reports a click on empty board as no selection', async () => {
    const onPick = vi.fn();
    render(<Board workflows={[bw('w1', ['a'])]} picks={[]} onPick={onPick} initialZoom={1} />);
    await screen.findByText('a-name');
    fireEvent.click(document.querySelector('.react-flow__pane')!);
    expect(onPick).toHaveBeenCalledWith(null, false);
  });
  const wires = [{ id: 'a>b', from: 'a', to: 'b', condition: 2 }];
  it('reports a click on a wire as a wire selection', async () => {
    const onPick = vi.fn();
    render(<Board workflows={[bw('w1', ['a', 'b'], wires)]} picks={[]} onPick={onPick} initialZoom={1} />);
    await screen.findByText('a-name');
    fireEvent.click(document.querySelector('.react-flow__edge')!);
    expect(onPick).toHaveBeenCalledWith({ kind: 'wire', workflowId: 'w1', wireId: 'a>b' }, false);
  });
  it('marks the selected frame, step and wire with the sel class', async () => {
    const w = [bw('w1', ['a', 'b'], wires)];
    const { rerender } = render(<Board workflows={w} picks={[{ kind: 'workflow', workflowId: 'w1' }]} onPick={() => {}} initialZoom={1} />);
    await screen.findByText('a-name');
    expect(document.querySelector('.frame.sel')).not.toBeNull();
    expect(document.querySelector('.node.sel')).toBeNull();
    rerender(<Board workflows={w} picks={[{ kind: 'step', workflowId: 'w1', stepId: 'a' }]} onPick={() => {}} initialZoom={1} />);
    expect(screen.getByText('a-name').closest('.node')).toHaveClass('sel');
    expect(screen.getByText('b-name').closest('.node')).not.toHaveClass('sel');
    expect(document.querySelector('.frame.sel')).toBeNull();
    rerender(<Board workflows={w} picks={[{ kind: 'wire', workflowId: 'w1', wireId: 'a>b' }]} onPick={() => {}} initialZoom={1} />);
    expect(document.querySelector('.link-wire .wire.sel')).not.toBeNull();
    expect(document.querySelector('.node.sel')).toBeNull();
  });
  describe('picks', () => {
    const toolbar = { save: vi.fn(), deleteStep: vi.fn(), deleteWire: vi.fn(), deleteCache: vi.fn(), status: () => ({ unsaved: false, problems: 0, saving: false }) };
    const onEdit = { moveStep: vi.fn(), moveFrame: vi.fn(), resizeFrame: vi.fn(), connect: vi.fn() };
    const a = { kind: 'step', workflowId: 'w1', stepId: 'a' } as const;
    const b = { kind: 'step', workflowId: 'w1', stepId: 'b' } as const;
    it('reports a Ctrl+click on two step cards as additive picks', async () => {
      const onPick = vi.fn();
      render(<Board workflows={[bw('w1', ['a', 'b'])]} picks={[]} onPick={onPick} initialZoom={1} />);
      fireEvent.click(await screen.findByText('a-name'), { ctrlKey: true });
      fireEvent.click(screen.getByText('b-name'), { metaKey: true });
      expect(onPick).toHaveBeenNthCalledWith(1, a, true);
      expect(onPick).toHaveBeenNthCalledWith(2, b, true);
    });
    it('numbers each picked thing in pick order and shows no toolbar for several', async () => {
      render(<Board workflows={[bw('w1', ['a', 'b'])]} picks={[b, a]} onPick={() => {}} initialZoom={1} onEdit={onEdit} toolbar={toolbar} />);
      await screen.findByText('a-name');
      expect(screen.getByText('b-name').closest('.node')!.querySelector('.pick-no')).toHaveTextContent('1');
      expect(screen.getByText('a-name').closest('.node')!.querySelector('.pick-no')).toHaveTextContent('2');
      expect(document.querySelector('[role=toolbar]')).toBeNull();
    });
    it('numbers a picked frame, wire and cache too', async () => {
      const w = bw('w1', ['a', 'b'], wires);
      w.graph.workflow.cacheIds = ['c1'];
      w.graph.caches.set('c1', { id: 'c1', name: 'orders', version: '1', description: null, root: '', items: '{}', audit: w.graph.workflow.audit });
      render(<Board workflows={[w]} picks={[{ kind: 'workflow', workflowId: 'w1' }, { kind: 'wire', workflowId: 'w1', wireId: 'a>b' }, { kind: 'cache', workflowId: 'w1', cacheId: 'c1' }]} onPick={() => {}} initialZoom={1} />);
      await screen.findByText('orders');
      expect(document.querySelector('.frame .pick-no')).toHaveTextContent('1');
      expect(await screen.findByText('2', { selector: '.pick-no' })).toBeInTheDocument();
      expect(screen.getByText('orders').closest('.cache-chip')!.querySelector('.pick-no')).toHaveTextContent('3');
    });
    it('shows the toolbar and no badge for a single pick', async () => {
      render(<Board workflows={[bw('w1', ['a', 'b'])]} picks={[a]} onPick={() => {}} initialZoom={1} onEdit={onEdit} toolbar={toolbar} />);
      await screen.findByText('a-name');
      expect(document.querySelector('[role=toolbar]')).not.toBeNull();
      expect(document.querySelector('.pick-no')).toBeNull();
    });
  });
});
