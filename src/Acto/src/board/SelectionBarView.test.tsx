import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Bar } from './selectionBar';
import { SelectionBar, type BarActions } from './SelectionBarView';

const labels = () => screen.queryAllByRole('button').map((b) => b.textContent);
const bar = (count: number, over: Partial<Bar> = {}): Bar => ({ count, copy: false, del: false, restore: false, remove: false, run: false, ...over });
const acts = (): BarActions => ({ copy: vi.fn(), del: vi.fn(), restore: vi.fn(), remove: vi.fn(), start: vi.fn(), stop: vi.fn() });

describe('SelectionBar', () => {
  it('steps: the pill, Copy and Delete', () => {
    const a = acts();
    render(<SelectionBar bar={bar(3, { copy: true, del: true })} actions={a} />);
    expect(screen.getByText('3 SELECTED')).toBeInTheDocument();
    expect(labels()).toEqual(['Copy', 'Delete']);
    fireEvent.click(screen.getByText('Copy')); fireEvent.click(screen.getByText('Delete'));
    expect(a.copy).toHaveBeenCalledTimes(1); expect(a.del).toHaveBeenCalledTimes(1);
  });
  it('a step and a cache: only Delete', () => {
    render(<SelectionBar bar={bar(2, { del: true })} actions={acts()} />);
    expect(labels()).toEqual(['Delete']);
  });
  it('nothing in common: only the text', () => {
    render(<SelectionBar bar={bar(2)} actions={acts()} />);
    expect(screen.getByText('no action in common')).toBeInTheDocument();
    expect(labels()).toEqual([]);
  });
  it('ghosts: Restore and Remove', () => {
    const a = acts();
    render(<SelectionBar bar={bar(2, { restore: true, remove: true })} actions={a} />);
    expect(labels()).toEqual(['Restore', 'Remove']);
    fireEvent.click(screen.getByText('Restore')); fireEvent.click(screen.getByText('Remove'));
    expect(a.restore).toHaveBeenCalledTimes(1); expect(a.remove).toHaveBeenCalledTimes(1);
  });
  it('triangles: Start, Stop and Delete', () => {
    const a = acts();
    render(<SelectionBar bar={bar(2, { run: true, del: true })} actions={a} />);
    expect(labels()).toEqual(['▶ Start', '■ Stop', 'Delete']);
    fireEvent.click(screen.getByText('▶ Start')); fireEvent.click(screen.getByText('■ Stop'));
    expect(a.start).toHaveBeenCalledTimes(1); expect(a.stop).toHaveBeenCalledTimes(1);
  });
});
