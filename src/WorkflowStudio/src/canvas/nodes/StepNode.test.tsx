import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StepView, type StepNodeData } from './StepNode';

const data: StepNodeData = {
  name: { text: 'fetch…', full: 'fetch-orders-from-the-api', cut: true },
  version: { text: 'v1.0.0', full: 'v1.0.0', cut: false },
  parked: false,
  letter: 'C',
  colour: '#2DD4BF',
  assignment: '◆ 2 keys',
  fanIn: 2,
  ins: [96, 112],
  outs: [96],
  processor: {
    title: { text: 'fetcher', full: 'fetcher', cut: false },
    version: '2.1.0',
    rows: [
      { label: 'in  ', value: { text: 'orders-in', full: 'orders-in', cut: false } },
      { label: 'out ', value: null },
      { label: 'cfg ', value: null },
    ],
    inputLit: true,
    outputLit: false,
    tooltip: 'fetcher 2.1.0',
  },
};

describe('StepView', () => {
  it('draws the cap text, the pill, the assignment badge and the fan-in badge', () => {
    const { getByText } = render(<svg><StepView {...data} /></svg>);

    expect(getByText('fetch…')).toBeInTheDocument();
    expect(getByText('STEP')).toBeInTheDocument();
    expect(getByText('v1.0.0')).toBeInTheDocument();
    expect(getByText('C')).toBeInTheDocument();
    expect(getByText('◆ 2 keys')).toBeInTheDocument();
    expect(getByText('fan-in ×2')).toBeInTheDocument();
  });

  it('puts the full name in a tooltip when it was cut', () => {
    const { container } = render(<svg><StepView {...data} /></svg>);
    // the <title> sits beside the <text> in a wrapping <g>, so the text keeps only what is drawn
    expect(container.querySelector('text.name')!.parentElement!.querySelector(':scope > title')!.textContent)
      .toBe('fetch-orders-from-the-api');
  });

  it('draws one edge contact per landing and per departure, lit when the side has a schema', () => {
    const { container } = render(<svg><StepView {...data} /></svg>);
    expect(container.querySelectorAll('.pad-io')).toHaveLength(2);    // two landings, In schema set
    expect(container.querySelectorAll('.pad-null')).toHaveLength(1);  // one departure, no Out schema
  });

  it('marks a parked step with the PARKED label and the parked class', () => {
    const { container, getByText } = render(<svg><StepView {...data} parked /></svg>);
    expect(getByText('PARKED')).toBeInTheDocument();
    expect(container.querySelector('.blk')!.classList.contains('parked')).toBe(true);
  });
});
