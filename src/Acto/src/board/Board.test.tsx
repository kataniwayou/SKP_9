import { fireEvent, render, screen } from '@testing-library/react';

import { describe, expect, it, vi } from 'vitest';
import { Board } from './Board';
import { bw } from './fixtures';

describe('Board', () => {
  it('shows every workflow name, an empty frame line and the minimap', async () => {
    render(<Board workflows={[bw('w1', ['a']), bw('w2', [])]} picks={[]} onPick={() => {}} />);
    expect(await screen.findByText('w1-name', { selector: '.nm' })).toBeInTheDocument();
    expect(screen.getByText('Empty workflow')).toBeInTheDocument();
    expect(document.querySelector('.react-flow__minimap')).not.toBeNull();
  });
  it('draws every step card at every zoom, far out too (no far mode)', async () => {
    render(<Board workflows={[bw('w1', ['a', 'b'])]} picks={[]} onPick={() => {}} initialZoom={0.1} />);
    expect(await screen.findByText('a-name')).toBeInTheDocument();
    expect(screen.getByText('b-name')).toBeInTheDocument();
    expect(screen.queryByText('2 steps')).toBeNull();
  });
  it('keeps a far step card visible with both handles', async () => {
    render(<Board workflows={[bw('w1', ['a'])]} picks={[]} onPick={() => {}} initialZoom={0.1} />);
    await screen.findByText('a-name');
    const node = document.querySelector('.react-flow__node-step') as HTMLElement;
    expect(node.querySelectorAll('.react-flow__handle')).toHaveLength(2);
    expect(node.querySelector('.node')).not.toBeNull();
    expect((node.firstElementChild as HTMLElement).style.visibility).not.toBe('hidden');
  });
  it('picks a step clicked far out', async () => {
    const onPick = vi.fn();
    render(<Board workflows={[bw('w1', ['a'])]} picks={[]} onPick={onPick} initialZoom={0.1} />);
    const name = await screen.findByText('a-name');
    expect((document.querySelector('.react-flow__node-step') as HTMLElement).style.pointerEvents).not.toBe('none');
    fireEvent.click(name);
    expect(onPick).toHaveBeenCalledWith({ kind: 'step', workflowId: 'w1', stepId: 'a' }, false);
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
    fireEvent.click(await screen.findByText('w1-name', { selector: '.nm' }));
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
  it('tags a step shown in several workflows as shared', async () => {
    render(<Board workflows={[bw('w1', ['s', 'a']), bw('w2', ['s'], [], { x: 0, y: 600 })]} picks={[]} onPick={() => {}} initialZoom={1} />);
    await screen.findAllByText('s-name');
    expect(screen.getAllByText('shared · 2')).toHaveLength(2);
    expect(screen.getAllByText('a-name')).toHaveLength(1);
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
    const toolbar = { save: vi.fn(), start: vi.fn(), stop: vi.fn(), copy: vi.fn(), deleteStep: vi.fn(), deleteWire: vi.fn(), deleteCache: vi.fn(), remove: vi.fn(), confirmRemove: vi.fn(), cancelRemove: vi.fn(), pendingRemove: () => null, status: () => ({ unsaved: false, problems: 0, saving: false, run: 'stopped' as const }) };
    const onEdit = { moveMany: vi.fn(), resizeFrame: vi.fn(), connect: vi.fn() };
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
