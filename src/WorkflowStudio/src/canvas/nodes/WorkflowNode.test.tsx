import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { WorkflowView, type WorkflowNodeData } from './WorkflowNode';

const data: WorkflowNodeData = { tip: 'orders_1.0.0-wf1', cron: { text: '⏱ 0 * * * * *', full: '⏱ 0 * * * * *', cut: false } };

describe('WorkflowView', () => {
  it('writes only WORKFLOW on the dial, with the unique name as its tooltip', () => {
    const { container, getByText } = render(<svg><WorkflowView {...data} started={false} /></svg>);
    expect(getByText('WORKFLOW')).toBeInTheDocument();
    expect(container.querySelector('.wf > title')!.textContent).toBe('orders_1.0.0-wf1');
    expect([...container.querySelectorAll('text')].some((t) => t.textContent!.includes('orders'))).toBe(false);
  });

  it('is grey, still and blinking when not started, with the cron and state on its pill', () => {
    const { container } = render(<svg><WorkflowView {...data} started={false} /></svg>);
    const wf = container.querySelector('.wf')!;
    expect(wf.classList.contains('nx-idlewf')).toBe(true);
    expect(wf.getAttribute('data-started')).toBe('false');
    expect(container.querySelector('.nx-state')!.textContent).toBe('⏱ 0 * * * * *  ○ not started');
  });

  it('is green and turning when started', () => {
    const { container } = render(<svg><WorkflowView {...data} started /></svg>);
    const wf = container.querySelector('.wf')!;
    expect(wf.classList.contains('started')).toBe(true);
    expect(wf.classList.contains('nx-idlewf')).toBe(false);
    expect(container.querySelector('.hub-inner .nx-spin')).not.toBeNull();
    expect(container.querySelector('.nx-state')!.textContent).toBe('⏱ 0 * * * * *  ● started');
  });

  it('gives each hub its own core gradient, so two documents never share one', () => {
    const { container } = render(<svg><WorkflowView {...data} started /><WorkflowView {...data} started={false} /></svg>);
    const ids = [...container.querySelectorAll('radialGradient')].map((g) => g.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    const fills = [...container.querySelectorAll('.nx-core-glow')].map((c) => c.getAttribute('fill'));
    expect(fills).toEqual(ids.map((id) => `url(#${id})`));
  });

  it('keeps the full cron in a tooltip when it was cut', () => {
    const cut = { text: '⏱ 0 0/5 …', full: '⏱ 0 0/5 * * * MON-FRI 2026', cut: true };
    const { container } = render(<svg><WorkflowView {...data} cron={cut} started={false} /></svg>);
    expect(container.querySelector('.nx-state')!.parentElement!.querySelector(':scope > title')!.textContent).toBe('⏱ 0 0/5 * * * MON-FRI 2026');
  });
});
