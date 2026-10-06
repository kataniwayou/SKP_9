import { render } from '@testing-library/react';
import { vi } from 'vitest';
import type { StudioApi } from '../api/client';
import { graphDto, processorDto, stepDto } from '../api/fixtures';
import type { WorkflowGraphDto } from '../api/types';
import { loadedDocument } from '../app/fixtures';
import { createInspectorService } from '../app/inspectorService';
import { StudioActionsProvider, type StudioActions } from '../app/studioActions';
import { Inspector } from '../panels/Inspector';
import type { Selection } from '../store/selection';
import { createStudioStore, StudioStoreProvider } from '../store/studioStore';

const notFound = { ok: false, error: { kind: 'notFound', status: 404 } } as const;

export const inspectorGraph = graphDto({
  steps: [stepDto('s1', { name: 'fetch', nextStepIds: ['s2'], processorId: 'p1' }), stepDto('s2', { name: 'store', processorId: 'p1' })],
  processors: [processorDto('p1', { name: 'fetcher', configSchemaId: 'sc1' })],
} as never);

/** Tests only: the Inspector over a loaded document, a real service on `api`, and a guard that records. */
export async function renderInspector(api: Partial<StudioApi>, { selection, graph = inspectorGraph }: { selection: Selection; graph?: WorkflowGraphDto }) {
  const store = createStudioStore();
  store.dispatch({ type: 'open', workflowId: 'wf1', name: 'orders', version: '1.0.0' });
  store.dispatch({ type: 'loaded', workflowId: 'wf1', doc: await loadedDocument(graph) });
  store.dispatch({ type: 'select', workflowId: 'wf1', selection });
  const full = {
    getEntity: vi.fn().mockResolvedValue(notFound), putEntity: vi.fn().mockResolvedValue(notFound),
    createAssignment: vi.fn().mockResolvedValue(notFound), ...api,
  } as unknown as StudioApi;
  const afterWrite = vi.fn();
  const service = createInspectorService(full, store, afterWrite);
  const guard = vi.fn<StudioActions['guard']>((_id, proceed) => proceed());
  const confirmUnlink = vi.fn<StudioActions['confirmUnlink']>();
  const view = render(
    <StudioStoreProvider value={store}>
      <StudioActionsProvider value={{ service, guard, confirmUnlink }}><Inspector /></StudioActionsProvider>
    </StudioStoreProvider>,
  );
  return { ...view, store, api: full, service, guard, confirmUnlink, afterWrite };
}
