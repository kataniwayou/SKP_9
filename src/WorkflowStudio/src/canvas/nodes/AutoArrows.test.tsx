import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Dir } from '../../design/autoConnect';
import { DesignContext, type DesignGestures } from '../../design/DesignContext';
import { AutoArrows } from './AutoArrows';

const gesturesOf = (): DesignGestures => ({ wirePointerDown: vi.fn(), portPointerDown: vi.fn(), arrowPointerDown: vi.fn(), arrowHover: vi.fn() });
const arrows = (g: DesignGestures, dirs: Dir[] | undefined) => (
  <DesignContext.Provider value={g}><AutoArrows id="s1" dirs={dirs} w={224} h={160} mid={96} /></DesignContext.Provider>
);

describe("Visio's AutoConnect arrows (plan 10 phase 6)", () => {
  it('report the arrow under the pointer, and none once it leaves', () => {
    const g = gesturesOf();
    const { container } = render(arrows(g, ['right', 'down']));
    const right = container.querySelector('[data-dir="right"]')!;
    fireEvent.pointerEnter(right);
    expect(g.arrowHover).toHaveBeenLastCalledWith({ id: 's1', dir: 'right' });
    fireEvent.pointerLeave(right);
    expect(g.arrowHover).toHaveBeenLastCalledWith(null);
  });

  it('an arrow taken away under the pointer reports none: no leave comes for it (its landing box stayed on the canvas, 2026-10-22)', () => {
    const g = gesturesOf();
    const { container, rerender } = render(arrows(g, ['right', 'down']));
    fireEvent.pointerEnter(container.querySelector('[data-dir="right"]')!);
    // a wire drawn from the step's output: it shows no right arrow any more
    rerender(arrows(g, ['down']));
    expect(g.arrowHover).toHaveBeenLastCalledWith(null);
  });

  it('all its arrows taken away (the block leaves design mode or the canvas) report none too', () => {
    const g = gesturesOf();
    const { container, rerender, unmount } = render(arrows(g, ['right']));
    fireEvent.pointerEnter(container.querySelector('[data-dir="right"]')!);
    rerender(arrows(g, undefined));
    expect(g.arrowHover).toHaveBeenLastCalledWith(null);
    const h = gesturesOf();
    const again = render(arrows(h, ['up']));
    fireEvent.pointerEnter(again.container.querySelector('[data-dir="up"]')!);
    again.unmount();
    expect(h.arrowHover).toHaveBeenLastCalledWith(null);
    unmount();
  });

  it('an arrow that stays, or one not hovered going, reports nothing', () => {
    const g = gesturesOf();
    const { container, rerender } = render(arrows(g, ['right', 'down']));
    fireEvent.pointerEnter(container.querySelector('[data-dir="right"]')!);
    rerender(arrows(g, ['right']));
    expect(g.arrowHover).toHaveBeenCalledTimes(1);
  });
});
