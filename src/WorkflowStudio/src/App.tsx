import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createApi, type StudioApi } from './api/client';
import { describeError } from './api/describeError';
import type { WorkflowReadDto } from './api/types';
import { DocumentPanel } from './app/DocumentPanel';
import { loadDocument } from './app/loadDocument';
import { browserTabStorage, createSaver, readTabSession, restoredState, sessionOf, writeTabSession, type Session } from './app/session';
import { SvgDefs } from './canvas/SvgDefs';
import type { SavedView } from './canvas/savedView';
import { fitterFor } from './canvas/useFitter';
import { DockShell, type DockDocument, type PickerItem } from './dock/DockShell';
import type { ToolId } from './dock/ids';
import { browserStorage, type SavedLayout } from './dock/layoutPersistence';
import { entityName } from './model/entityNames';
import { Inspector } from './panels/Inspector';
import { Output, Toolbox } from './panels/PaneNote';
import { Problems } from './panels/Problems';
import { inspectorKey } from './store/studioState';
import { createStudioStore, StudioStoreProvider, useStudio, useStudioStore } from './store/studioStore';

export { describeError } from './api/describeError';

const uniqueName = (w: WorkflowReadDto) => entityName(w.name ?? '', w.version ?? '', w.id ?? '');

function renderTool(id: ToolId) {
  switch (id) {
    case 'inspector': return <Inspector />;
    case 'problems': return <Problems />;
    case 'output': return <Output />;
    case 'toolbox': return <Toolbox />;
  }
}

export interface AppProps {
  api?: StudioApi;
  /** The browser's storage: the saved window layout, and the session's mirror. Default: localStorage. */
  storage?: Storage | null;
  /** This tab's storage, where its session lives. Default: sessionStorage. */
  tabStorage?: Storage | null;
}

/**
 * The studio page (slice 3a): one store, the dock, and what goes in its documents and panes. The page
 * keeps its session (plan 3d): the store starts from it, so a refresh brings back what was open.
 */
export function App({ api: injected, storage, tabStorage }: AppProps) {
  const api = useMemo(() => injected ?? createApi(), [injected]);
  const resolved = useMemo(() => (storage === undefined ? browserStorage() : storage), [storage]);
  const tab = useMemo(() => (tabStorage === undefined ? browserTabStorage() : tabStorage), [tabStorage]);
  const session = useMemo(() => readTabSession(tab, resolved), [tab, resolved]);
  // the session is read once: the store is made once, from the session the page started with
  const store = useMemo(() => createStudioStore(restoredState(session)), []);
  // the page's fonts start loading at once, so the first document opens with its fitter ready
  useEffect(() => { void fitterFor(document); }, []);
  return (
    <StudioStoreProvider value={store}>
      <SvgDefs />
      <Studio api={api} storage={resolved} tabStorage={tab} session={session} />
    </StudioStoreProvider>
  );
}

function Studio({ api, storage, tabStorage, session }: { api: StudioApi; storage: Storage | null; tabStorage: Storage | null; session: Session | null }) {
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

  /** Fetches an open document's workflow; a result that lands after the document was closed is dropped. */
  const load = useCallback((id: string) => {
    const token = (opens.current.get(id) ?? 0) + 1;
    opens.current.set(id, token);
    void loadDocument(api, id).then((r) => {
      const current = store.getState().docs.find((d) => d.workflowId === id);
      if (opens.current.get(id) !== token || current?.status.kind !== 'loading') return;
      store.dispatch(r.ok
        ? { type: 'loaded', workflowId: id, doc: r.value }
        : { type: 'failed', workflowId: id, message: describeError(r.error) });
    });
  }, [api, store]);

  const openWorkflow = useCallback((id: string) => {
    const known = workflows.find((w) => w.id === id);
    const alreadyOpen = store.getState().docs.some((d) => d.workflowId === id);
    store.dispatch({ type: 'open', workflowId: id, name: known?.name ?? id, version: known?.version ?? '' });
    if (!alreadyOpen) load(id);
  }, [store, workflows, load]);

  useEffect(() => {
    for (const d of store.getState().docs) if (d.status.kind === 'loading') load(d.workflowId);
  }, []); // the restored documents only; later ones are loaded by openWorkflow

  // views and the dock change on every pan and drag, so they are kept outside React state
  const views = useRef(new Map<string, SavedView>(session?.docs.flatMap((d) => (d.view ? [[d.workflowId, d.view] as const] : [])) ?? []));
  const dockState = useRef<SavedLayout | null>(session?.dock ?? null);
  const saver = useMemo(() => createSaver(() => {
    const state = store.getState();
    for (const id of [...views.current.keys()]) if (!state.docs.some((d) => d.workflowId === id)) views.current.delete(id);
    writeTabSession(tabStorage, storage, sessionOf(state, views.current, dockState.current));
  }), [store, storage, tabStorage]);
  useEffect(() => store.subscribe(saver.schedule), [store, saver]);
  // the last change before the page goes away is written at once, not 300 ms later
  useEffect(() => {
    const flush = () => saver.flush();
    window.addEventListener('pagehide', flush);
    return () => { window.removeEventListener('pagehide', flush); saver.flush(); };
  }, [saver]);

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
      onCloseDocument={(id) => {
        views.current.delete(id); // reopened later, it fits afresh
        store.dispatch({ type: 'close', workflowId: id });
      }}
      workflows={items}
      pickerNote={listError}
      onPickerOpen={readList}
      onOpenWorkflow={openWorkflow}
      renderDocument={(id, panel) => (
        <DocumentPanel api={api} workflowId={id} panel={panel}
          initialView={views.current.get(id) ?? null}
          onViewChange={(v) => { views.current.set(id, v); saver.schedule(); }} />
      )}
      renderTool={renderTool}
      inspectorKey={inspector}
      onEscape={() => {
        const id = store.getState().activeId;
        if (id !== null) store.dispatch({ type: 'select', workflowId: id, selection: null });
      }}
      popoutContent={<SvgDefs />}
      storage={storage}
      restore={session?.dock ?? null}
      onLayoutChange={(dock) => { dockState.current = dock; saver.schedule(); }}
    />
  );
}
