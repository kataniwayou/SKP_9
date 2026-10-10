import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Health } from '../../api/liveness';
import { STEP_FRAME } from './nxShapes';
import { EMPTY_SLOT_TIP } from './Chip';
import { StepView, type StepNodeData } from './StepNode';

const data: StepNodeData = {
  name: { text: 'fetch…', full: 'fetch-orders-from-the-api', cut: true },
  version: { text: 'v1.0.0', full: 'v1.0.0', cut: false },
  letter: 'C',
  colour: '#2DD4BF',
  assignment: '◆ 2 keys',
  tip: 'fetch-orders-from-the-api_1.0.0-s1\nentry C · Completed\nassignment ◆ 2 keys',
  fanIn: 2,
  ins: [96, 112],
  outs: [96],
  processor: {
    processorId: 'p1',
    title: { text: 'fetcher', full: 'fetcher', cut: false },
    version: '2.1.0',
    rows: [
      { label: 'in', value: { text: 'orders-in', full: 'orders-in', cut: false } },
      { label: 'out', value: null },
      { label: 'cfg', value: null },
    ],
    inputLit: true,
    outputLit: false,
    tooltip: 'fetcher 2.1.0',
  },
};

const view = (over: Partial<StepNodeData> = {}, health: Health = 'healthy') =>
  render(<svg><StepView {...data} {...over} health={health} /></svg>);

describe('StepView', () => {
  it('draws the cap text, the condition pill, the assignment badge and the fan-in badge', () => {
    const { getByText } = view();
    expect(getByText('fetch…')).toBeInTheDocument();
    expect(getByText('STEP')).toBeInTheDocument();
    expect(getByText('v1.0.0')).toBeInTheDocument();
    expect(getByText('C')).toBeInTheDocument();
    expect(getByText('◆ 2 keys')).toBeInTheDocument();
    expect(getByText('fan-in ×2')).toBeInTheDocument();
  });

  it('draws the notched frame and the glossy cap of the locked art', () => {
    const { container } = view();
    expect(container.querySelector('path.nx-frame')!.getAttribute('d')).toBe(STEP_FRAME);
    expect(container.querySelector('path[fill="url(#nxCap)"]')).not.toBeNull();
  });

  it('puts the full name in a tooltip when it was cut', () => {
    const { container } = view();
    expect(container.querySelector('text.nx-sn')!.parentElement!.querySelector(':scope > title')!.textContent)
      .toBe('fetch-orders-from-the-api');
  });

  it('puts a socket on the frame edge and a contact on the panel for every landing and departure, lit only where the side has a schema', () => {
    const { container } = view();
    expect(container.querySelectorAll('.nx-socket')).toHaveLength(3);
    expect(container.querySelectorAll('.nx-socket circle.nx-fh:not(.nx-d2)')).toHaveLength(2);   // two landings, In schema set
    expect(container.querySelectorAll('.chipg rect.nx-fh.nx-g')).toHaveLength(2);
    expect(container.querySelectorAll('.chipg rect.nx-nd')).toHaveLength(1);                     // one departure, no Out schema
  });

  it.each([
    ['healthy', false, false],
    ['unhealthy', true, false],
    ['undetermined', true, true],
  ] as const)('draws a %s processor: halted %s, blinking %s', (health, halted, waiting) => {
    const { container } = view({}, health);
    const ring = container.querySelector('.nx-health')!;
    expect(ring.getAttribute('data-health')).toBe(health);
    expect(ring.classList.contains('nx-halted')).toBe(halted);
    expect(ring.classList.contains('nx-wait')).toBe(waiting);
    expect(ring.querySelector('.nx-spin')).not.toBeNull();
  });

  it('names its processor on the panel, for the live check', () => {
    expect(view().container.querySelector('.chipg')!.getAttribute('data-processor')).toBe('p1');
  });

  it('shows the processor title with its version, a set slot by value and an empty one as ∅', () => {
    const { container, getByText, getAllByText } = view();
    expect(getByText('PROCESSOR')).toBeInTheDocument();
    expect(getByText('fetcher')).toBeInTheDocument();
    expect(container.querySelector('.nx-pv')!.textContent).toBe(' 2.1.0');
    expect(getByText('orders-in')).toBeInTheDocument();
    expect(getAllByText('∅')).toHaveLength(2);
  });

  it('shows the step tooltip on the step, and keeps the processor its own', () => {
    const { container } = view();
    expect(container.querySelector('.blk > title')!.textContent).toBe('fetch-orders-from-the-api_1.0.0-s1\nentry C · Completed\nassignment ◆ 2 keys');
    expect(container.querySelector('.chipg > title')!.textContent).toBe('fetcher 2.1.0');
  });

  it('with no processor (removed in the design, 2026-10-10): the dashed amber empty slot with a ⚠ and its tip; no die; a transparent background', () => {
    const { container } = view({ processor: null });
    expect(container.querySelector('.chipg')).toBeNull();
    const slot = container.querySelector('.chip-empty')!;
    expect(slot.querySelector('title')!.textContent).toBe(EMPTY_SLOT_TIP);
    expect(slot.querySelector('.chip-empty-mark')!.textContent).toBe('⚠');
    // nothing behind the ⚠ (the user's addition): one outline, not filled, and the glyph; no plate, circle or path
    const shapes = [...slot.querySelectorAll('rect, circle, ellipse, path, polygon')];
    expect(shapes).toHaveLength(1);
    expect(shapes[0]!.getAttribute('fill')).toBe('none');
    expect(shapes[0]!.classList.contains('chip-empty-line')).toBe(true);
    // its sockets are not lit
    expect(container.querySelectorAll('.nx-socket .nx-fh.nx-d2').length).toBeGreaterThan(0);
  });
});
