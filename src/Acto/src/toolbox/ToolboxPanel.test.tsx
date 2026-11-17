import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Processor } from '../model/graph';
import { LiveStoreProvider } from '../live/LiveContext';
import { liveStub } from '../test/liveStub';
import { ToolboxPanel } from './ToolboxPanel';

const proc = (id: string): Processor => ({ id, name: `${id}-proc`, version: '1', description: null, sourceHash: '', instanceId: null } as unknown as Processor);

describe('ToolboxPanel', () => {
  it('lists Workflow and Cache create items and one step per processor with health and liveness', () => {
    const live = liveStub(); live.known([], { p1: true });
    render(<LiveStoreProvider value={live}><ToolboxPanel processors={[proc('p1'), proc('p2')]} /></LiveStoreProvider>);
    expect(screen.getByText('Create')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Workflow/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Cache/ })).toBeEnabled();
    expect(screen.getByText('p1-proc')).toBeInTheDocument();
    expect(screen.getByText('p2-proc')).toBeInTheDocument();
    expect(screen.getAllByTestId('health-dot').map((d) => d.getAttribute('data-health'))).toEqual(['healthy', 'undetermined']);
    expect(screen.getByText(/live · 1 of 1 replica healthy/)).toBeInTheDocument();
    expect(screen.getByText('not reported')).toBeInTheDocument();
  });
  it('carries the item as application/acto JSON on dragStart', () => {
    const live = liveStub();
    const cache = { id: 'c1', name: 'orders', version: '1', description: null, root: '', items: '{}', audit: { createdAt: '', createdBy: null, updatedAt: '', updatedBy: null } };
    render(<LiveStoreProvider value={live}><ToolboxPanel processors={[proc('p1')]} caches={[cache]} /></LiveStoreProvider>);
    const drag = (el: HTMLElement) => {
      const data: Record<string, string> = {};
      fireEvent.dragStart(el, { dataTransfer: { setData: (k: string, v: string) => { data[k] = v; }, effectAllowed: '' } });
      return JSON.parse(data['application/acto']!);
    };
    expect(drag(screen.getByRole('button', { name: /Workflow/ }))).toEqual({ kind: 'workflow' });
    expect(drag(screen.getByRole('button', { name: /Cache/ }))).toEqual({ kind: 'cache-new' });
    expect(drag(screen.getByTestId('toolbox-step'))).toEqual({ kind: 'step', processorId: 'p1' });
    expect(drag(screen.getByTestId('toolbox-cache'))).toEqual({ kind: 'cache', cacheId: 'c1' });
  });
});
