import { fireEvent, render, screen } from '@testing-library/react';

import { describe, expect, it, vi } from 'vitest';
import { Board } from './Board';
import { bw } from './fixtures';

describe('Board', () => {
  it('shows every workflow name, an empty frame line and the minimap', async () => {
    render(<Board workflows={[bw('w1', ['a']), bw('w2', [])]} selection={null} onSelect={() => {}} />);
    expect(await screen.findByText('w1-name')).toBeInTheDocument();
    expect(screen.getByText('Empty workflow')).toBeInTheDocument();
    expect(document.querySelector('.react-flow__minimap')).not.toBeNull();
  });
  it('shows only name and step count when zoomed far out', async () => {
    render(<Board workflows={[bw('w1', ['a', 'b'])]} selection={null} onSelect={() => {}} initialZoom={0.3} />);
    expect(await screen.findByText('2 steps')).toBeInTheDocument();
    expect(screen.queryByText('a-name')).toBeNull();
  });
  it('reports a click on a step as a step selection', async () => {
    const onSelect = vi.fn();
    render(<Board workflows={[bw('w1', ['a'])]} selection={null} onSelect={onSelect} />);
    fireEvent.click(await screen.findByText('a-name'));
    expect(onSelect).toHaveBeenCalledWith({ kind: 'step', workflowId: 'w1', stepId: 'a' });
  });
  it('reports a click on a frame header as a workflow selection', async () => {
    const onSelect = vi.fn();
    render(<Board workflows={[bw('w1', ['a'])]} selection={null} onSelect={onSelect} />);
    fireEvent.click(await screen.findByText('w1-name'));
    expect(onSelect).toHaveBeenCalledWith({ kind: 'workflow', workflowId: 'w1' });
  });
  it('draws a wire with its condition letter', async () => {
    const wires = [{ id: 'a>b', from: 'a', to: 'b', condition: 2 }];
    render(<Board workflows={[bw('w1', ['a', 'b'], wires)]} selection={null} onSelect={() => {}} initialZoom={1} />);
    await screen.findByText('a-name');
    expect(document.querySelector('.link-wire')).not.toBeNull();
    expect(screen.getByText('F')).toBeInTheDocument();
  });
  it('tags parked and first steps and shows "not scheduled"', async () => {
    render(<Board workflows={[bw('w1', ['a', 'b'])]} selection={null} onSelect={() => {}} initialZoom={1} />);
    await screen.findByText('a-name');
    expect(screen.getAllByText('PARKED')).toHaveLength(2);
    expect(screen.getByText(/not scheduled/)).toBeInTheDocument();
  });
  it('reports a click on empty board as no selection', async () => {
    const onSelect = vi.fn();
    render(<Board workflows={[bw('w1', ['a'])]} selection={null} onSelect={onSelect} initialZoom={1} />);
    await screen.findByText('a-name');
    fireEvent.click(document.querySelector('.react-flow__pane')!);
    expect(onSelect).toHaveBeenCalledWith(null);
  });
  const wires = [{ id: 'a>b', from: 'a', to: 'b', condition: 2 }];
  it('reports a click on a wire as a wire selection', async () => {
    const onSelect = vi.fn();
    render(<Board workflows={[bw('w1', ['a', 'b'], wires)]} selection={null} onSelect={onSelect} initialZoom={1} />);
    await screen.findByText('a-name');
    fireEvent.click(document.querySelector('.react-flow__edge')!);
    expect(onSelect).toHaveBeenCalledWith({ kind: 'wire', workflowId: 'w1', wireId: 'a>b' });
  });
  it('marks the selected frame, step and wire with the sel class', async () => {
    const w = [bw('w1', ['a', 'b'], wires)];
    const { rerender } = render(<Board workflows={w} selection={{ kind: 'workflow', workflowId: 'w1' }} onSelect={() => {}} initialZoom={1} />);
    await screen.findByText('a-name');
    expect(document.querySelector('.frame.sel')).not.toBeNull();
    expect(document.querySelector('.node.sel')).toBeNull();
    rerender(<Board workflows={w} selection={{ kind: 'step', workflowId: 'w1', stepId: 'a' }} onSelect={() => {}} initialZoom={1} />);
    expect(screen.getByText('a-name').closest('.node')).toHaveClass('sel');
    expect(screen.getByText('b-name').closest('.node')).not.toHaveClass('sel');
    expect(document.querySelector('.frame.sel')).toBeNull();
    rerender(<Board workflows={w} selection={{ kind: 'wire', workflowId: 'w1', wireId: 'a>b' }} onSelect={() => {}} initialZoom={1} />);
    expect(document.querySelector('.link-wire .wire.sel')).not.toBeNull();
    expect(document.querySelector('.node.sel')).toBeNull();
  });
});
