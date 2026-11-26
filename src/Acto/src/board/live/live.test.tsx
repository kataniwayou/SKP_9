import { readFileSync } from 'node:fs';
import { act, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { LiveStoreProvider } from '../../live/LiveContext';
import type { LiveState } from '../../live/liveState';
import { liveStub } from '../../test/liveStub';
import { Board } from '../Board';
import { scheduledBoard } from '../../design/boardFixtures';
import { useWorkflowStatus } from '../../live/LiveContext';
import { HealthDot } from './HealthDot';
import { StateBadge } from './StateBadge';

const renderWithLive = (ui: ReactNode, state: Partial<LiveState>) =>
  render(<LiveStoreProvider value={liveStub(state)}>{ui}</LiveStoreProvider>);

describe('live state', () => {
  it('shows Running, Stopped and Checking…', () => {
    const { rerender } = render(<StateBadge status="running" />);
    expect(screen.getByText('Running')).toBeInTheDocument();
    rerender(<StateBadge status="stopped" />);
    expect(screen.getByText('Stopped')).toBeInTheDocument();
    rerender(<StateBadge status="unknown" />);
    expect(screen.getByText('Checking…')).toBeInTheDocument();
    rerender(<StateBadge status="checking" />);
    expect(screen.getByText('Checking…')).toBeInTheDocument();
    expect(document.querySelector('.state-badge')).not.toBeNull();
  });
  it('colours a dot by health and is grey for an unknown processor', () => {
    renderWithLive(<><HealthDot processorId="p1" /><HealthDot processorId="nope" /><HealthDot processorId={null} /></>,
      { processorsKnown: 'known', processors: new Map([['p1', { live: true, healthy: 2, replicas: 2, reason: null }]]) });
    const [ok, unknown, none] = screen.getAllByTestId('health-dot');
    expect(ok).toHaveAttribute('data-health', 'healthy');
    expect(ok).toHaveAttribute('title', 'live · 2 of 2 replicas healthy');
    expect(unknown).toHaveAttribute('data-health', 'undetermined');
    expect(none).toHaveAttribute('data-health', 'undetermined');
    expect(ok).toHaveAttribute('aria-label', 'live · 2 of 2 replicas healthy');
  });
  it('draws solid hearts as Grafana\'s alert list does: whole when live, cracked when not, with a question mark when nobody can say [user, 2026-11-25]', () => {
    renderWithLive(<><HealthDot processorId="p1" /><HealthDot processorId="p2" /><HealthDot processorId="nope" /></>,
      { processorsKnown: 'known', processors: new Map([
        ['p1', { live: true, healthy: 1, replicas: 1, reason: null }],
        ['p2', { live: false, healthy: 0, replicas: 1, reason: 'no healthy replica' }],
      ]) });
    const [live, down, unknown] = screen.getAllByTestId('health-dot');
    // one solid heart each; the crack (a path) or the question mark (a path and its dot) is cut out by a mask
    const shape = (e: HTMLElement) => {
      const heart = e.querySelectorAll('svg > g.beat > path');
      const m = e.querySelector('mask');
      return {
        hearts: heart.length, fill: heart[0]?.getAttribute('fill'), masked: heart[0]?.getAttribute('mask') === (m ? `url(#${m.id})` : null),
        cut: m ? [...m.children].slice(1).map((c) => c.tagName) : [],
      };
    };
    expect(shape(live!)).toEqual({ hearts: 1, fill: 'currentColor', masked: true, cut: [] });
    expect(shape(down!)).toEqual({ hearts: 1, fill: 'currentColor', masked: true, cut: ['path'] });
    expect(shape(unknown!)).toEqual({ hearts: 1, fill: 'currentColor', masked: true, cut: ['path', 'circle'] });
    expect(live).toHaveStyle({ color: '#16A34A' });
    expect(down).toHaveStyle({ color: '#DC2626' });
    expect(unknown).toHaveStyle({ color: '#94A3B8' });
    // each broken heart cuts its crack with its own mask
    const ids = [...document.querySelectorAll('mask')].map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('beats an inner <g>, never the <svg> root: the SVG renderer paints it, so no compositor layer and no black flash at small zoom [user, 2026-11-26]', () => {
    renderWithLive(<HealthDot processorId="p1" />,
      { processorsKnown: 'known', processors: new Map([['p1', { live: true, healthy: 1, replicas: 1, reason: null }]]) });
    const svg = screen.getByTestId('health-dot').querySelector('svg')!;
    // the root holds only the beating group (and the mask defs); the heart is inside the group
    expect([...svg.children].filter((c) => c.tagName !== 'defs').map((c) => `${c.tagName}.${c.getAttribute('class')}`)).toEqual(['g.beat']);
    const css = readFileSync('src/app.css', 'utf8');
    const animated = [...css.matchAll(/([^{}\n]+)\{[^}]*animation:\s*heartbeat[^}]*\}/g)].map((m) => m[1]!.trim());
    expect(animated).toEqual(['.health-dot[data-health="healthy"] .beat']);
    const rule = css.match(/\.health-dot\[data-health="healthy"\] \.beat \{([^}]*)\}/)![1]!;
    // the same origin as before: 50% 55% of the 24-unit view box, which an inner element measures only with view-box
    expect(rule).toContain('transform-box: view-box');
    expect(rule).toContain('transform-origin: 50% 55%');
    expect(css).not.toMatch(/\.health-dot[^{]*svg\s*\{[^}]*animation/);
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{ \.health-dot\[data-health="healthy"\] \.beat \{ animation: none; \}/);
  });
  it('treats an empty processor id as no processor', () => {
    renderWithLive(<HealthDot processorId="" />, { processorsKnown: 'known', processors: new Map() });
    expect(screen.getByTestId('health-dot')).toHaveAttribute('data-health', 'undetermined');
  });
  it('marks a running workflow on the board: triangle state, wire class', async () => {
    const stub = liveStub();
    stub.known(['daily'], {});
    const Live = () => {
      const daily = useWorkflowStatus('daily');
      return <Board state={scheduledBoard()} view={{ workflows: [], picks: [], live: (id) => (id === 'daily' ? daily : 'stopped') }} onPick={() => {}} initialZoom={1} />;
    };
    render(<LiveStoreProvider value={stub}><Live /></LiveStoreProvider>);
    await screen.findByText('fetch-orders');
    expect(screen.getByText('● running')).toBeInTheDocument();
    expect(document.querySelector('.wire.running')).not.toBeNull();
    act(() => stub.known([], {}));
    expect(await screen.findAllByText('■ stopped')).toHaveLength(2);
    expect(document.querySelector('.wire.running')).toBeNull();
  });
});
