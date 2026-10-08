import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { arrowHead, CableEdgeView } from './CableEdge';

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

  it('draws a junction end as a filled circle, no ring or arrow head there; a short circuit\'s red (plan 9 §5)', () => {
    const { container } = render(<svg><CableEdgeView points={[[0, 8], [64, 8], [64, 40]]} colour="#2DD4BF" broken={false} delay={0} flowing tailOn="junction" headOn="terminal" /></svg>);
    expect(container.querySelector('circle.nx-src')).toBeNull();
    const dot = container.querySelector('circle.nx-joint')!;
    expect([dot.getAttribute('cx'), dot.getAttribute('cy')]).toEqual(['0', '8']);
    expect(container.querySelector('.nx-head')).not.toBeNull();
    const head = render(<svg><CableEdgeView points={[[0, 8], [64, 8]]} colour="#2DD4BF" broken={false} delay={0} flowing={false} headOn="junction" short /></svg>);
    expect(head.container.querySelector('.nx-head')).toBeNull();
    expect(head.container.querySelector('circle.nx-joint.short')).not.toBeNull();
    expect(head.container.querySelector('circle.nx-src')).not.toBeNull();
  });

  it('dashes a wire that is not solid and never pulses it; open ends keep the ring and the arrow head, no open circle (plan 9 §5)', () => {
    const { container } = render(<svg><CableEdgeView points={[[0, 8], [64, 8]]} colour="#8A97A8" broken={false} delay={0} flowing dashed tailOn="open" headOn="open" /></svg>);
    expect(container.querySelector('.wire')!.classList.contains('dashed')).toBe(true);
    expect(container.querySelector('.nx-pulse')).toBeNull();
    expect(container.querySelector('circle.nx-src')).not.toBeNull();
    expect(container.querySelector('.nx-head')).not.toBeNull();
    expect(container.querySelector('circle.nx-open')).toBeNull();
  });

  it('points an arrow head along the last run, whichever way it runs', () => {
    expect(arrowHead([0, 8], [64, 8])).toBe('M55 2L64 8L55 14');
    expect(arrowHead([64, 0], [64, 40])).toBe('M70 31L64 40L58 31');
    expect(arrowHead([64, 8], [64, 8])).toBe('M55 2L64 8L55 14');
  });
});
