import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createApi, type ApiError, type StudioApi } from './api/client';
import type { WorkflowReadDto } from './api/types';
import { DocumentPanel } from './app/DocumentPanel';
import { loadDocument } from './app/loadDocument';
import { SvgDefs } from './canvas/SvgDefs';
import { fitterFor } from './canvas/useFitter';
import { DockShell, type DockDocument, type PickerItem } from './dock/DockShell';
import type { ToolId } from './dock/ids';
import { entityName } from './model/entityNames';
import { Inspector } from './panels/Inspector';
import { Output, Toolbox } from './panels/PaneNote';
import { Problems } from './panels/Problems';
import { inspectorKey } from './store/studioState';
import { createStudioStore, StudioStoreProvider, useStudio, useStudioStore } from './store/studioStore';

export function describeError(error: ApiError): string {
  switch (error.kind) {
    case 'notFound': return 'This workflow no longer exists.';
    case 'network': return `Network error: ${error.message}`;
    default: return error.status === 0 ? error.detail : `${error.status}: ${error.detail}`;
  }
}

const uniqueName = (w: WorkflowReadDto) => entityName(w.name ?? '', w.version ?? '', w.id ?? '');

function renderTool(id: ToolId) {
  switch (id) {
    case 'inspector': return <Inspector />;
    case 'problems': return <Problems />;
    case 'output': return <Output />;
    case 'toolbox': return <Toolbox />;
  }
}

/** The studio page (slice 3a): one store, the dock, and what goes in its documents and panes. */
export function App({ api: injected, storage }: { api?: StudioApi; storage?: Storage | null }) {
  const api = useMemo(() => injected ?? createApi(), [injected]);
  const store = useMemo(() => createStudioStore(), []);
  // the page's fonts start loading at once, so the first document opens with its fitter ready
  useEffect(() => { void fitterFor(document); }, []);
  return (
    <StudioStoreProvider value={store}>
      <SvgDefs />
      <Studio api={api} storage={storage} />
    </StudioStoreProvider>
  );
}

function Studio({ api, storage }: { api: StudioApi; storage?: Storage | null }) {
  const store = useStudioStore();
  const docs = useStudio((s) => s.docs);
  const activeId = useStudio((s) => s.activeId);
  const inspector = useStudio(inspectorKey);
  // one token per open: a result from an earlier open of the same workflow (closed and reopened while loading) is ignored
  const opens = useRef(new Map<string, number>());
  const [workflows, setWorkflows] = useState<WorkflowReadDto[]>([]);
  const [listError, setListError] = useState<string | undefined>(undefined);

  const readList = useCallback(() => {
    void api.listWorkflows().then((r) => {
      if (r.ok) {
        setWorkflows([...r.value].sort((a, b) => uniqueName(a).localeCompare(uniqueName(b))));
        setListError(undefined);
      } else {
        setListError(`Workflows could not be listed. ${describeError(r.error)}`);
      }
    });
  }, [api]);
  useEffect(readList, [readList]);

  const openWorkflow = useCallback((id: string) => {
    const known = workflows.find((w) => w.id === id);
    const alreadyOpen = store.getState().docs.some((d) => d.workflowId === id);
    store.dispatch({ type: 'open', workflowId: id, name: known?.name ?? id, version: known?.version ?? '' });
    if (alreadyOpen) return;
    const token = (opens.current.get(id) ?? 0) + 1;
    opens.current.set(id, token);
    void loadDocument(api, id).then((r) => {
      const current = store.getState().docs.find((d) => d.workflowId === id);
      if (opens.current.get(id) !== token || current?.status.kind !== 'loading') return;
      store.dispatch(r.ok
        ? { type: 'loaded', workflowId: id, doc: r.value }
        : { type: 'failed', workflowId: id, message: describeError(r.error) });
    });
  }, [api, store, workflows]);

  // the dock only needs each document's identity and names; a selection change must not re-render every tab
  const identity = docs.map((d) => `${d.workflowId}\u0000${d.name}\u0000${d.version}`).join('\u0001');
  const documents: DockDocument[] = useMemo(
    () => docs.map((d) => ({ id: d.workflowId, name: d.name, version: d.version, tooltip: entityName(d.name, d.version, d.workflowId) })),
    [identity], // the part of `docs` the dock shows; `docs` itself changes on every selection

  );
  const items: PickerItem[] = useMemo(
    () => workflows.filter((w) => w.id).map((w) => ({ id: w.id!, label: uniqueName(w), open: documents.some((d) => d.id === w.id) })),
    [workflows, documents],
  );

  return (
    <DockShell
      documents={documents}
      activeDocumentId={activeId}
      onActivateDocument={(id) => store.dispatch({ type: 'activate', workflowId: id })}
      onCloseDocument={(id) => store.dispatch({ type: 'close', workflowId: id })}
      workflows={items}
      pickerNote={listError}
      onPickerOpen={readList}
      onOpenWorkflow={openWorkflow}
      renderDocument={(id, panel) => <DocumentPanel api={api} workflowId={id} panel={panel} />}
      renderTool={renderTool}
      inspectorKey={inspector}
      onEscape={() => {
        const id = store.getState().activeId;
        if (id !== null) store.dispatch({ type: 'select', workflowId: id, selection: null });
      }}
      popoutContent={<SvgDefs />}
      storage={storage}
    />
  );
}
