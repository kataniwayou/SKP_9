import { render } from '@testing-library/react';
import { vi } from 'vitest';
import type { StudioApi } from '../api/client';
import { graphDto, processorDto, stepDto } from '../api/fixtures';
import type { WorkflowGraphDto } from '../api/types';
import { loadedDocument } from '../app/fixtures';
import { createInspectorService } from '../app/inspectorService';
import { StudioActionsProvider, type StudioActions } from '../app/studioActions';
import { LiveStoreProvider } from '../live/LiveContext';
import { Inspector } from '../panels/Inspector';
import type { Pick } from '../store/picks';
import type { Selection } from '../store/selection';
import { createStudioStore, StudioStoreProvider } from '../store/studioStore';
import { liveStub, type LiveStub } from './liveStub';

const notFound = { ok: false, error: { kind: 'notFound', status: 404 } } as const;

export const inspectorGraph = graphDto({
  steps: [stepDto('s1', { name: 'fetch', nextStepIds: ['s2'], processorId: 'p1' }), stepDto('s2', { name: 'store', processorId: 'p1' })],
  processors: [processorDto('p1', { name: 'fetcher', configSchemaId: 'sc1' })],
} as never);

/** Tests only: the Inspector over a loaded document, a real service on `api`, and a guard that records. */
export async function renderInspector(api: Partial<StudioApi>, { selection, picks, graph = inspectorGraph, live = liveStub() }: { selection: Selection | null; picks?: Pick[]; graph?: WorkflowGraphDto; live?: LiveStub }) {
  const store = createStudioStore();
  store.dispatch({ type: 'open', workflowId: 'wf1', name: 'orders', version: '1.0.0' });
  store.dispatch({ type: 'loaded', workflowId: 'wf1', doc: await loadedDocument(graph) });
  store.dispatch({ type: 'select', workflowId: 'wf1', selection, picks });
  const full = {
    getEntity: vi.fn().mockResolvedValue(notFound), putEntity: vi.fn().mockResolvedValue(notFound),
    createAssignment: vi.fn().mockResolvedValue(notFound),
    deleteAssignment: vi.fn().mockResolvedValue(notFound), saveDesign: vi.fn(), ...api,
  } as unknown as StudioApi;
  const service = createInspectorService(full, store);
  const guard = vi.fn<StudioActions['guard']>((_id, proceed) => proceed());
  const view = render(
    <StudioStoreProvider value={store}>
      <LiveStoreProvider value={live}>
        <StudioActionsProvider value={{ service, guard }}><Inspector /></StudioActionsProvider>
      </LiveStoreProvider>
    </StudioStoreProvider>,
  );
  return { ...view, store, api: full, service, guard };
}
