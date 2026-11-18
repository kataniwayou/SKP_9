import { act, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { LiveStoreProvider } from '../../live/LiveContext';
import type { LiveState } from '../../live/liveState';
import { liveStub } from '../../test/liveStub';
import { Board } from '../Board';
import { board } from '../../design/boardFixtures';
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
  it('treats an empty processor id as no processor', () => {
    renderWithLive(<HealthDot processorId="" />, { processorsKnown: 'known', processors: new Map() });
    expect(screen.getByTestId('health-dot')).toHaveAttribute('data-health', 'undetermined');
  });
  it('marks a running workflow on the board: triangle state, wire class', async () => {
    const stub = liveStub();
    stub.known(['daily'], {});
    const Live = () => {
      const daily = useWorkflowStatus('daily');
      return <Board state={board()} view={{ workflow: null, picks: [], live: (id) => (id === 'daily' ? daily : 'stopped') }} onPick={() => {}} initialZoom={1} />;
    };
    render(<LiveStoreProvider value={stub}><Live /></LiveStoreProvider>);
    await screen.findByText('fetch-orders');
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(document.querySelector('.wire.running')).not.toBeNull();
    act(() => stub.known([], {}));
    expect(await screen.findAllByText('Stopped')).toHaveLength(2);
    expect(document.querySelector('.wire.running')).toBeNull();
  });
});
