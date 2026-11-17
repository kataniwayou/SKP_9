import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Processor } from '../model/graph';
import { LiveStoreProvider } from '../live/LiveContext';
import { liveStub } from '../test/liveStub';
import { ToolboxPanel } from './ToolboxPanel';

const proc = (id: string): Processor => ({ id, name: `${id}-proc`, version: '1', description: null, sourceHash: '', instanceId: null } as unknown as Processor);

describe('ToolboxPanel', () => {
  it('lists a disabled Workflow item and one step per processor with health and liveness', () => {
    const live = liveStub(); live.known([], { p1: true });
    render(<LiveStoreProvider value={live}><ToolboxPanel processors={[proc('p1'), proc('p2')]} /></LiveStoreProvider>);
    expect(screen.getByText('Create')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Workflow/ })).toBeDisabled();
    expect(screen.getByText('drop anywhere on the board')).toBeInTheDocument();
    expect(screen.getByText('p1-proc')).toBeInTheDocument();
    expect(screen.getByText('p2-proc')).toBeInTheDocument();
    expect(screen.getAllByTestId('health-dot').map((d) => d.getAttribute('data-health'))).toEqual(['healthy', 'undetermined']);
    expect(screen.getByText(/live · 1 of 1 replica healthy/)).toBeInTheDocument();
    expect(screen.getByText('not reported')).toBeInTheDocument();
  });
});
