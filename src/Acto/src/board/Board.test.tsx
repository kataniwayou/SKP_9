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
});
