import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SelectionBar } from './SelectionBarView';

const labels = () => screen.queryAllByRole('button').map((b) => b.textContent);

describe('SelectionBar', () => {
  it('steps: the pill, Copy and Delete', () => {
    const a = { copy: vi.fn(), del: vi.fn() };
    render(<SelectionBar bar={{ count: 3, copy: true, del: true }} actions={a} />);
    expect(screen.getByText('3 SELECTED')).toBeInTheDocument();
    expect(labels()).toEqual(['Copy', 'Delete']);
    fireEvent.click(screen.getByText('Copy')); fireEvent.click(screen.getByText('Delete'));
    expect(a.copy).toHaveBeenCalledTimes(1); expect(a.del).toHaveBeenCalledTimes(1);
  });
  it('a step and a cache: only Delete', () => {
    render(<SelectionBar bar={{ count: 2, copy: false, del: true }} actions={{ copy: vi.fn(), del: vi.fn() }} />);
    expect(labels()).toEqual(['Delete']);
  });
  it('nothing in common: only the text', () => {
    render(<SelectionBar bar={{ count: 2, copy: false, del: false }} actions={{ copy: vi.fn(), del: vi.fn() }} />);
    expect(screen.getByText('no action in common')).toBeInTheDocument();
    expect(labels()).toEqual([]);
  });
});
