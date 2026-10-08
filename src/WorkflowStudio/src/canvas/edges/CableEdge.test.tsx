import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CableEdgeView, LOOSE_COLOUR } from './CableEdge';

describe('CableEdgeView', () => {
  it('draws the trace, a ring at the source and an open chevron whose tip is the landing', () => {
    const { container } = render(<svg><CableEdgeView points={[[0, 8], [64, 8]]} colour="#2DD4BF" broken={false} delay={0} flowing={false} /></svg>);

    expect(container.querySelector('path.w')!.getAttribute('d')).toBe('M0 8 L64 8');
    expect(container.querySelector('path.w')!.getAttribute('stroke')).toBe('#2DD4BF');
    expect(container.querySelector('.nx-head')!.getAttribute('d')).toBe('M55 2L64 8L55 14');
    const src = container.querySelector('circle.nx-src')!;
    expect([src.getAttribute('cx'), src.getAttribute('cy')]).toEqual(['0', '8']);
    expect(container.querySelector('.wire')!.classList.contains('broken')).toBe(false);
  });

  it('pulses toward the target only while flowing, with its stagger', () => {
    const still = render(<svg><CableEdgeView points={[[0, 8], [64, 8]]} colour="#2DD4BF" broken={false} delay={-0.82} flowing={false} /></svg>);
    expect(still.container.querySelector('.nx-pulse')).toBeNull();

    const flowing = render(<svg><CableEdgeView points={[[0, 8], [64, 8]]} colour="#2DD4BF" broken={false} delay={-0.82} flowing /></svg>);
    const pulse = flowing.container.querySelector('.nx-pulse') as SVGPathElement;
    expect(pulse.getAttribute('d')).toBe('M0 8 L64 8');
    expect(pulse.style.animationDelay).toBe('-0.82s');
  });

  it('dashes a broken wire, cuts a gap at the middle of its longest segment, puts ⚠ in it, and never pulses', () => {
    const { container, getByText } = render(
      <svg><CableEdgeView points={[[0, 0], [16, 0], [16, 96], [32, 96]]} colour="#FF7A66" broken delay={0} flowing /></svg>,
    );

    expect(container.querySelector('.wire')!.classList.contains('broken')).toBe(true);
    const warn = getByText('⚠');
    expect([warn.getAttribute('x'), warn.getAttribute('y')]).toEqual(['16', '53']);
    const hole = container.querySelector('mask rect[fill="#000"]')!;
    expect([hole.getAttribute('x'), hole.getAttribute('y')]).toEqual(['6', '41']);
    const mask = container.querySelector('mask')!;
    expect(container.querySelector('path.w')!.closest('g[mask]')!.getAttribute('mask')).toBe(`url(#${mask.id})`);
    expect(container.querySelector('.nx-pulse')).toBeNull();
  });

  it('gives every broken wire its own gap mask (review focus 4)', () => {
    const { container } = render(
      <svg>
        <CableEdgeView points={[[0, 0], [64, 0]]} colour="#FF7A66" broken delay={0} flowing={false} />
        <CableEdgeView points={[[0, 40], [64, 40]]} colour="#FF7A66" broken delay={0} flowing={false} />
      </svg>,
    );
    const ids = [...container.querySelectorAll('mask')].map((m) => m.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('draws a loose wire grey and dashed, a ring at its source and an open circle at its end, with no arrow head or pulse (plan 8 §5)', () => {
    const { container } = render(<svg><CableEdgeView points={[[0, 0], [40, 0], [40, 30]]} colour={LOOSE_COLOUR} broken={false} delay={0} loose flowing /></svg>);
    const g = container.querySelector('g.wire.loose')!;
    expect(g.querySelector('circle.nx-src')).not.toBeNull();
    expect([g.querySelector('circle.nx-open')!.getAttribute('cx'), g.querySelector('circle.nx-open')!.getAttribute('cy')]).toEqual(['40', '30']);
    expect(g.querySelector('.nx-head')).toBeNull();
    expect(g.querySelector('.nx-pulse')).toBeNull();
  });
});
