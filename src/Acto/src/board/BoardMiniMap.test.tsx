import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const setCenter = vi.fn();
vi.mock('@xyflow/react', async (orig) => {
  const m = await orig<typeof import('@xyflow/react')>();
  return { ...m, useReactFlow: () => ({ ...m.useReactFlow(), setCenter }) };
});

import { board } from '../design/boardFixtures';
import { Board } from './Board';
import type { BoardView } from './toFlow';

const view = (over: Partial<BoardView> = {}): BoardView => ({ workflows: [], picks: [], live: () => 'stopped', ...over });
const mini = (sel: string) => [...document.querySelectorAll(`.react-flow__minimap ${sel}`)] as SVGElement[];

describe('Board minimap', () => {
  it('draws a mark per triangle, step and cache', async () => {
    render(<Board state={board()} view={view()} onPick={() => {}} />);
    await vi.waitFor(() => expect(mini('[data-mini-triangle]')).toHaveLength(2));
    expect(mini('[data-mini-step]')).toHaveLength(3);
    expect(mini('[data-mini-cache]')).toHaveLength(1);
  });

  it('colours triangles by run state, steps by processor and caches grey', async () => {
    render(<Board state={board()} view={view({ live: (id) => (id === 'daily' ? 'running' : id === 'hourly' ? 'stopped' : 'unknown') })} onPick={() => {}} />);
    await vi.waitFor(() => expect(mini('[data-mini-triangle]')).toHaveLength(2));
    const fill = (id: string) => (mini(`[data-mini-triangle="${id}"]`)[0] as SVGElement).style.fill;
    expect(fill('daily')).toBe('var(--st-on)');
    expect(fill('hourly')).toBe('var(--st-off)');
    expect(mini('[data-mini-cache]')[0]!.style.fill).toBe('var(--idle)');
    expect(mini('[data-mini-step]')[0]!.style.fill).toMatch(/^(#|rgb)/);
  });

  it('outlines a picked item in the accent colour', async () => {
    render(<Board state={board()} view={view({ picks: [{ kind: 'workflow', id: 'daily' }] })} onPick={() => {}} />);
    await vi.waitFor(() => expect(mini('[data-mini-triangle]')).toHaveLength(2));
    expect((mini('[data-mini-triangle="daily"]')[0] as SVGElement).style.stroke).toBe('var(--accent)');
    expect((mini('[data-mini-triangle="hourly"]')[0] as SVGElement).style.stroke).toBe('none');
  });

  it('centres the board on a clicked mark at the current zoom', async () => {
    render(<Board state={board()} view={view()} onPick={() => {}} initialZoom={0.5} />);
    await vi.waitFor(() => expect(mini('[data-mini-cache]')).toHaveLength(1));
    fireEvent.click(mini('[data-mini-cache]')[0]!);
    expect(setCenter).toHaveBeenCalledWith(0 + 160 / 2, -100 + 56 / 2, { zoom: 0.5 });
  });

  it('draws no mark for a ghost', async () => {
    const row = { ...board().steps.lonely!, id: 'gone', name: 'gone', at: { x: 5, y: 6 } };
    render(<Board state={board()} view={view({ ghosts: [{ key: 'step:gone', kind: 'step', row }] })} onPick={() => {}} />);
    await vi.waitFor(() => expect(mini('[data-mini-step]')).toHaveLength(3));
  });
});
