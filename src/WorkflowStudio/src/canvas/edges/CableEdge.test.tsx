import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { arrowHead, CableEdgeView } from './CableEdge';

describe('CableEdgeView', () => {
  it('draws the trace, a ring at the source and an open chevron whose tip is the landing', () => {
    const { container } = render(<svg><CableEdgeView points={[[0, 8], [64, 8]]} colour="#2DD4BF" delay={0} flowing={false} /></svg>);

    expect(container.querySelector('path.w')!.getAttribute('d')).toBe('M0 8 L64 8');
    expect(container.querySelector('path.w')!.getAttribute('stroke')).toBe('#2DD4BF');
    expect(container.querySelector('.nx-head')!.getAttribute('d')).toBe('M55 2L64 8L55 14');
    const src = container.querySelector('circle.nx-src')!;
    expect([src.getAttribute('cx'), src.getAttribute('cy')]).toEqual(['0', '8']);
  });

  it('pulses toward the target only while flowing, with its stagger', () => {
    const still = render(<svg><CableEdgeView points={[[0, 8], [64, 8]]} colour="#2DD4BF" delay={-0.82} flowing={false} /></svg>);
    expect(still.container.querySelector('.nx-pulse')).toBeNull();

    const flowing = render(<svg><CableEdgeView points={[[0, 8], [64, 8]]} colour="#2DD4BF" delay={-0.82} flowing /></svg>);
    const pulse = flowing.container.querySelector('.nx-pulse') as SVGPathElement;
    expect(pulse.getAttribute('d')).toBe('M0 8 L64 8');
    expect(pulse.style.animationDelay).toBe('-0.82s');
  });

  it('draws a junction end as a filled circle, no ring or arrow head there; a short circuit\'s red (plan 9 §5)', () => {
    const { container } = render(<svg><CableEdgeView points={[[0, 8], [64, 8], [64, 40]]} colour="#2DD4BF" delay={0} flowing tailOn="junction" headOn="terminal" /></svg>);
    expect(container.querySelector('circle.nx-src')).toBeNull();
    const dot = container.querySelector('circle.nx-joint')!;
    expect([dot.getAttribute('cx'), dot.getAttribute('cy')]).toEqual(['0', '8']);
    expect(container.querySelector('.nx-head')).not.toBeNull();
    const head = render(<svg><CableEdgeView points={[[0, 8], [64, 8]]} colour="#2DD4BF" delay={0} flowing={false} headOn="junction" short /></svg>);
    expect(head.container.querySelector('.nx-head')).toBeNull();
    expect(head.container.querySelector('circle.nx-joint.short')).not.toBeNull();
    expect(head.container.querySelector('circle.nx-src')).not.toBeNull();
  });

  it('dashes a wire that is not solid and never pulses it; open ends keep the ring and the arrow head, no open circle (plan 9 §5)', () => {
    const { container } = render(<svg><CableEdgeView points={[[0, 8], [64, 8]]} colour="#8A97A8" delay={0} flowing dashed tailOn="open" headOn="open" /></svg>);
    expect(container.querySelector('.wire')!.classList.contains('dashed')).toBe(true);
    expect(container.querySelector('.nx-pulse')).toBeNull();
    expect(container.querySelector('circle.nx-src')).not.toBeNull();
    expect(container.querySelector('.nx-head')).not.toBeNull();
    expect(container.querySelector('circle.nx-open')).toBeNull();
  });

  it('a direction-less wire (rule D) has no tail ring and no arrow head, open or joined; its junction circle stays', () => {
    const open = render(<svg><CableEdgeView points={[[0, 8], [64, 8]]} colour="#8A97A8" delay={0} flowing={false} dashed tailOn="open" headOn="open" free /></svg>);
    expect(open.container.querySelector('circle.nx-src')).toBeNull();
    expect(open.container.querySelector('.nx-head')).toBeNull();
    const joined = render(<svg><CableEdgeView points={[[0, 8], [64, 8]]} colour="#2DD4BF" delay={0} flowing={false} dashed tailOn="junction" headOn="open" free /></svg>);
    expect(joined.container.querySelector('circle.nx-src')).toBeNull();
    expect(joined.container.querySelector('.nx-head')).toBeNull();
    expect(joined.container.querySelector('circle.nx-joint')).not.toBeNull();
  });

  it('draws each stretch it shares with a wire of another net in the short circuit\'s red, over its own line (the user\'s rule 2, 2026-10-09)', () => {
    const { container } = render(<svg><CableEdgeView points={[[0, 8], [64, 8], [64, 40]]} colour="#2DD4BF" delay={0} flowing={false} short overlaps={[[[16, 8], [48, 8]], [[64, 16], [64, 32]]]} /></svg>);
    const red = [...container.querySelectorAll('path.nx-overlap')].map((p) => p.getAttribute('d'));
    expect(red).toEqual(['M16 8 L48 8', 'M64 16 L64 32']);
    expect(render(<svg><CableEdgeView points={[[0, 8], [64, 8]]} colour="#2DD4BF" delay={0} flowing={false} /></svg>).container.querySelector('path.nx-overlap')).toBeNull();
  });

  it("draws Visio's line jumps on its trace and its pulse, not on its hit band (plan 10 phase 3)", () => {
    const { container } = render(<svg><CableEdgeView points={[[0, 8], [64, 8]]} jumps={[[32, 8]]} colour="#2DD4BF" delay={0} flowing /></svg>);
    expect(container.querySelector('path.w')!.getAttribute('d')).toBe('M0 8 L24 8 A8 8 0 0 1 40 8 L64 8');
    expect(container.querySelector('.nx-pulse')!.getAttribute('d')).toBe('M0 8 L24 8 A8 8 0 0 1 40 8 L64 8');
  });

  it('points an arrow head along the last run, whichever way it runs', () => {
    expect(arrowHead([0, 8], [64, 8])).toBe('M55 2L64 8L55 14');
    expect(arrowHead([64, 0], [64, 40])).toBe('M70 31L64 40L58 31');
    expect(arrowHead([64, 8], [64, 8])).toBe('M55 2L64 8L55 14');
  });
});
