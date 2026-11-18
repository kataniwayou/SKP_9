import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TRIANGLE_H, TRIANGLE_W } from '../board/geometry';
import { board } from '../design/boardFixtures';
import type { Processor } from '../model/graph';
import { LiveStoreProvider } from '../live/LiveContext';
import { liveStub } from '../test/liveStub';
import { dropOnBoard, parseToolboxDrag } from './drag';
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
    expect(screen.getAllByTestId('health-dot').map((d) => d.getAttribute('data-health'))).toEqual(['healthy', 'undetermined']);
    expect(screen.queryByText('Caches')).toBeNull();
  });
  it('carries the item as application/acto JSON on dragStart', () => {
    render(<LiveStoreProvider value={liveStub()}><ToolboxPanel processors={[proc('p1')]} /></LiveStoreProvider>);
    const drag = (el: HTMLElement) => {
      const data: Record<string, string> = {};
      fireEvent.dragStart(el, { dataTransfer: { setData: (k: string, v: string) => { data[k] = v; }, effectAllowed: '' } });
      return parseToolboxDrag(data['application/acto']!);
    };
    expect(drag(screen.getByRole('button', { name: /Workflow/ }))).toEqual({ kind: 'workflow' });
    expect(drag(screen.getByRole('button', { name: /Cache/ }))).toEqual({ kind: 'cache' });
    expect(drag(screen.getByTestId('toolbox-step'))).toEqual({ kind: 'step', processorId: 'p1' });
  });
});

describe('parseToolboxDrag', () => {
  it('reads the three items and nothing else', () => {
    expect(parseToolboxDrag('{"kind":"step","processorId":"p"}')).toEqual({ kind: 'step', processorId: 'p' });
    expect(parseToolboxDrag('{"kind":"step"}')).toBeNull();
    expect(parseToolboxDrag('{"kind":"cache-new"}')).toBeNull();
    expect(parseToolboxDrag('oops')).toBeNull();
  });
});

describe('dropOnBoard', () => {
  const ids = () => 'n1';
  it('a Workflow drop makes a triangle new-workflow-N centred on the drop point, version 1.0.0, no cron, no arrows', () => {
    const r = dropOnBoard(board(), { kind: 'workflow' }, { x: 500, y: 300 }, ids);
    if ('refused' in r) throw new Error(r.refused);
    expect(r.pick).toEqual({ kind: 'workflow', id: 'n1' });
    expect(r.state.workflows.n1).toMatchObject({
      name: 'new-workflow-1', version: '1.0.0', cronExpression: null, entryStepIds: [], cacheIds: [], updatedAt: null,
      at: { x: 500 - TRIANGLE_W / 2, y: 300 - TRIANGLE_H / 2 },
    });
  });
  it('a Cache drop makes new-cache-N; a step drop a step of that processor', () => {
    const c = dropOnBoard(board(), { kind: 'cache' }, { x: 0, y: 0 }, ids);
    if ('refused' in c) throw new Error(c.refused);
    expect(c.state.caches.n1).toMatchObject({ name: 'new-cache-1', version: '1.0.0' });
    const s = dropOnBoard(board(), { kind: 'step', processorId: 'p1' }, { x: 0, y: 0 }, ids);
    if ('refused' in s) throw new Error(s.refused);
    expect(s.state.steps.n1).toMatchObject({ processorId: 'p1', updatedAt: null });
    expect(s.pick).toEqual({ kind: 'step', id: 'n1' });
  });
  it('refuses a processor that is not listed', () => {
    expect(dropOnBoard(board(), { kind: 'step', processorId: 'gone' }, { x: 0, y: 0 }, ids)).toEqual({ refused: 'That processor is no longer listed' });
  });
});
