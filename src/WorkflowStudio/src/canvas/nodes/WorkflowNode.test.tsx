import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { LiveStatus } from '../../api/liveStatus';
import { SPHERE_R } from '../../layout/geometry';
import { WorkflowView, type WorkflowNodeData } from './WorkflowNode';

const data: WorkflowNodeData = { tip: 'orders_1.0.0-wf1' };

describe('WorkflowView', () => {
  it('writes only WORKFLOW on the dial, with the unique name as its tooltip', () => {
    const { container, getByText } = render(<svg><WorkflowView {...data} started={false} status="stopped" /></svg>);
    expect(getByText('WORKFLOW')).toBeInTheDocument();
    expect(container.querySelector('.wf > title')!.textContent).toBe('orders_1.0.0-wf1');
    expect([...container.querySelectorAll('text')].some((t) => t.textContent!.includes('orders'))).toBe(false);
  });

  it('is grey, still and blinking when not started, with its state inside the dial', () => {
    const { container } = render(<svg><WorkflowView {...data} started={false} status="stopped" /></svg>);
    const wf = container.querySelector('.wf')!;
    expect(wf.classList.contains('nx-idlewf')).toBe(true);
    expect(wf.getAttribute('data-started')).toBe('false');
    expect(container.querySelector('.nx-state')!.textContent).toBe('○ not started');
  });

  it('is green and turning when started', () => {
    const { container } = render(<svg><WorkflowView {...data} started status="running" /></svg>);
    const wf = container.querySelector('.wf')!;
    expect(wf.classList.contains('started')).toBe(true);
    expect(wf.classList.contains('nx-idlewf')).toBe(false);
    expect(container.querySelector('.hub-inner .nx-spin')).not.toBeNull();
    expect(container.querySelector('.nx-state')!.textContent).toBe('● started');
  });

  it('states inside the dial only what the live poll knows: started, not started, status unknown or checking', () => {
    const said = (started: boolean, status: LiveStatus) => {
      const { container, unmount } = render(<svg><WorkflowView {...data} started={started} status={status} /></svg>);
      const text = container.querySelector('.nx-state tspan')!.textContent;
      unmount();
      return text;
    };
    expect(said(true, 'running')).toBe('● started');
    expect(said(false, 'stopped')).toBe('○ not started');
    expect(said(false, 'unknown')).toBe('? status unknown');
    expect(said(false, 'checking')).toBe('checking…');
  });

  it('looks not started (grey, still, blinking) while the status is unknown or checking (spec §5.1)', () => {
    for (const status of ['unknown', 'checking'] as const) {
      const { container, unmount } = render(<svg><WorkflowView {...data} started={false} status={status} /></svg>);
      const wf = container.querySelector('.wf')!;
      expect(wf.classList.contains('nx-idlewf')).toBe(true);
      expect(wf.getAttribute('data-started')).toBe('false');
      unmount();
    }
  });

  it('gives each hub its own core gradient, so two documents never share one', () => {
    const { container } = render(<svg><WorkflowView {...data} started status="running" /><WorkflowView {...data} started={false} status="stopped" /></svg>);
    const ids = [...container.querySelectorAll('radialGradient')].map((g) => g.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    const fills = [...container.querySelectorAll('.nx-core-glow')].map((c) => c.getAttribute('fill'));
    expect(fills).toEqual(ids.map((id) => `url(#${id})`));
  });

  it('writes nothing outside the dial (its ring is for contact points): no pill, the state centred inside under WORKFLOW (2026-10-10)', () => {
    const { container } = render(<svg><WorkflowView {...data} started={false} status="stopped" /></svg>);
    expect(container.querySelector('.nx-pill')).toBeNull();
    expect(container.querySelector('rect')).toBeNull();
    const state = container.querySelector('.nx-state')!;
    expect(state.getAttribute('text-anchor')).toBe('middle');
    expect(state.textContent).not.toContain('⏱');
    const word = Number(container.querySelector('.nx-wl')!.getAttribute('y')), y = Number(state.getAttribute('y'));
    expect(y).toBeGreaterThan(word);
    // inside the inner core (r - 22 around the centre r, r)
    expect(Math.abs(y - SPHERE_R)).toBeLessThan(SPHERE_R - 22);
  });
});
