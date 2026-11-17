import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { memoryStorage } from '../test/memoryStorage';
import { Shell } from './Shell';

const ui = (storage?: Storage | null) =>
  <Shell toolbox="T" board="B" inspector="I" output="O" chat="C" storage={storage} />;

describe('Shell', () => {
  it('resets a splitter on double-click', () => {
    render(ui(null));
    const sep = screen.getAllByRole('separator')[0]!;
    fireEvent.pointerDown(sep, { clientX: 216 }); fireEvent.pointerMove(sep, { clientX: 316 }); fireEvent.pointerUp(sep);
    expect(screen.getByTestId('shell')).toHaveStyle({ '--tw': '300px' });
    fireEvent.doubleClick(sep); expect(screen.getByTestId('shell')).toHaveStyle({ '--tw': '200px' });
  });

  it('renders the five panels and four separators in order', () => {
    render(ui(null));
    for (const p of ['toolbox', 'board', 'inspector', 'output', 'chat'])
      expect(document.querySelector(`[data-panel="${p}"]`)).not.toBeNull();
    const seps = screen.getAllByRole('separator');
    expect(seps.map((s) => s.getAttribute('aria-orientation'))).toEqual(['vertical', 'vertical', 'horizontal', 'vertical']);
  });

  it('clamps drags, moves the other splitters the right way and remembers sizes', () => {
    const st = memoryStorage();
    const { unmount } = render(ui(st));
    const [s1, s2, s3] = screen.getAllByRole('separator') as [HTMLElement, HTMLElement, HTMLElement];
    fireEvent.pointerDown(s1, { clientX: 0 }); fireEvent.pointerMove(s1, { clientX: 1000 }); fireEvent.pointerUp(s1);
    fireEvent.pointerDown(s2, { clientX: 500 }); fireEvent.pointerMove(s2, { clientX: 400 }); fireEvent.pointerUp(s2);
    fireEvent.pointerDown(s3, { clientY: 500 }); fireEvent.pointerMove(s3, { clientY: 450 }); fireEvent.pointerUp(s3);
    const shell = screen.getByTestId('shell');
    expect(shell).toHaveStyle({ '--tw': '340px', '--iw': '400px', '--bh': '240px' });
    unmount();
    render(ui(st));
    expect(screen.getByTestId('shell')).toHaveStyle({ '--tw': '340px', '--iw': '400px', '--bh': '240px' });
  });

  it('ignores moves when no drag started', () => {
    render(ui(null));
    const sep = screen.getAllByRole('separator')[0]!;
    fireEvent.pointerMove(sep, { clientX: 900 });
    expect(screen.getByTestId('shell')).toHaveStyle({ '--tw': '200px' });
  });

  it('writes the sizes once, on pointer-up, not on every move', () => {
    const st = memoryStorage();
    const set = vi.spyOn(st, 'setItem');
    render(ui(st));
    const sep = screen.getAllByRole('separator')[0]!;
    fireEvent.pointerDown(sep, { clientX: 0 });
    for (const x of [10, 20, 30, 40, 50]) fireEvent.pointerMove(sep, { clientX: x });
    expect(screen.getByTestId('shell')).toHaveStyle({ '--tw': '250px' });
    expect(set).not.toHaveBeenCalled();
    fireEvent.pointerUp(sep);
    expect(set).toHaveBeenCalledTimes(1);
    expect(JSON.parse(st.getItem('acto.panels')!).tools).toBe(250);
  });
});
