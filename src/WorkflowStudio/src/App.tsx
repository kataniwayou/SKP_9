import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createApi, type StudioApi } from './api/client';
import { describeError } from './api/describeError';
import type { WorkflowReadDto } from './api/types';
import { ConfirmDialog } from './app/ConfirmDialog';
import { DocumentPanel } from './app/DocumentPanel';
import { createInspectorService } from './app/inspectorService';
import { loadDocument } from './app/loadDocument';
import { runWorkflow } from './app/runWorkflow';
import { saveDesign } from './app/saveDesign';
import { browserTabStorage, createSaver, keepSession, readTabSession, restoredState, sessionOf, type Session } from './app/session';
import { StudioActionsProvider, type StudioActions } from './app/studioActions';
import { SvgDefs } from './canvas/SvgDefs';
import type { SavedView } from './canvas/savedView';
import { fitterFor } from './canvas/useFitter';
import { DockShell, type DockDocument, type PickerItem } from './dock/DockShell';
import type { ToolId } from './dock/ids';
import { browserStorage, type SavedLayout } from './dock/layoutPersistence';
import { entityName } from './model/entityNames';
import { Inspector } from './panels/Inspector';
import { Output } from './panels/Output';
import { Toolbox } from './panels/PaneNote';
import type { Pick } from './store/picks';
import { runBlocked, RUN_WORD, type RunOp } from './store/run';
import { selectionKey, type Selection } from './store/selection';
import { designDirty, inspectorKey } from './store/studioState';
import { createStudioStore, StudioStoreProvider, useStudio, useStudioStore } from './store/studioStore';

export { describeError } from './api/describeError';

const uniqueName = (w: WorkflowReadDto) => entityName(w.name ?? '', w.version ?? '', w.id ?? '');

function renderTool(id: ToolId) {
  switch (id) {
    case 'inspector': return <Inspector />;
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

  // the page's toast (a refused session write), shown by the dock
  const [notice, setNotice] = useState({ id: 0, text: '' });

  const service = useMemo(() => createInspectorService(api, store), [api, store]);

  type Prompt =
    | { kind: 'design'; workflowId: string; doc: Document }
    | { kind: 'closeDesign'; workflowId: string; doc: Document; proceed: () => void };
  const [prompt, setPromptState] = useState<Prompt | null>(null);
  // the open question, read by the guard at once (state would lag a render behind)
  const asking = useRef<Prompt | null>(null);
  const setPrompt = useCallback((next: Prompt | null) => { asking.current = next; setPromptState(next); }, []);

  const actions: StudioActions = useMemo(() => ({
    service,
    // nothing is lost by moving away (plan 8): only an open question holds an action back
    guard: (_workflowId, proceed) => { if (asking.current === null) proceed(); },
    confirmDiscardDesign: (workflowId, doc = document) => {
      if (asking.current !== null) return;
      setPrompt({ kind: 'design', workflowId, doc });
    },
  }), [service, setPrompt]);

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
  const sessionRefused = useRef(false);
  const saver = useMemo(() => createSaver(() => {
    const state = store.getState();
    for (const id of [...views.current.keys()]) if (!state.docs.some((d) => d.workflowId === id)) views.current.delete(id);
    const kept = keepSession(tabStorage, storage, sessionOf(state, views.current, dockState.current));
    if (!kept && !sessionRefused.current) setNotice((n) => ({ id: n.id + 1, text: 'This browser would not keep the session: a refresh may lose unsaved changes' }));
    sessionRefused.current = !kept;
  }), [store, storage, tabStorage]);
  useEffect(() => store.subscribe(saver.schedule), [store, saver]);
  // the last change before the page goes away is written at once, not 300 ms later
  useEffect(() => {
    const flush = () => saver.flush();
    window.addEventListener('pagehide', flush);
    return () => { window.removeEventListener('pagehide', flush); saver.flush(); };
  }, [saver]);

  // the dock only needs each document's identity and names; a selection change must not re-render every tab
  const identity = docs.map((d) => `${d.workflowId}\u0000${d.name}\u0000${d.version}\u0000${designDirty(d)}`).join('\u0001');
  const documents: DockDocument[] = useMemo(
    () => docs.map((d) => ({ id: d.workflowId, name: d.name, version: d.version, tooltip: entityName(d.name, d.version, d.workflowId), dirty: designDirty(d) })),
    [identity], // the part of `docs` the dock shows; `docs` itself changes on every selection

  );
  const items: PickerItem[] = useMemo(
    () => workflows.filter((w) => w.id).map((w) => ({ id: w.id!, label: uniqueName(w), open: documents.some((d) => d.id === w.id) })),
    [workflows, documents],
  );

  return (
    <StudioActionsProvider value={actions}>
      <DockShell
        documents={documents}
        notice={notice}
        activeDocumentId={activeId}
        onActivateDocument={(id) => store.dispatch({ type: 'activate', workflowId: id })}
        onCloseDocument={(id, doc) => {
          const close = () => {
            views.current.delete(id); // reopened later, it fits afresh
            store.dispatch({ type: 'close', workflowId: id });
          };
          // a design draft is asked about first: Discard closes, dropping the draft with the document
          const open = store.getState().docs.find((d) => d.workflowId === id);
          if (open && designDirty(open) && asking.current === null) setPrompt({ kind: 'closeDesign', workflowId: id, doc: doc ?? document, proceed: close });
          else close();
        }}
        workflows={items}
        pickerNote={listError}
        onPickerOpen={readList}
        onOpenWorkflow={openWorkflow}
        renderDocument={(id, panel) => (
          <DocumentPanel api={api} workflowId={id} panel={panel}
            initialView={views.current.get(id) ?? null}
            onViewChange={(v) => { views.current.set(id, v); saver.schedule(); }}
            onSelect={(selection: Selection | null, doc: Document, picks?: Pick[]) => {
              store.dispatch({ type: 'activate', workflowId: id });
              const open = store.getState().docs.find((d) => d.workflowId === id);
              // the same entity: only the picks change, and the Inspector has nothing to ask
              if (open && selectionKey(open.selection) === selectionKey(selection)) {
                if (picks) store.dispatch({ type: 'pick', workflowId: id, picks });
                return;
              }
              actions.guard(id, () => store.dispatch({ type: 'select', workflowId: id, selection, picks }), doc);
            }}
            onSave={() => void saveDesign(api, store, id)}
            onRun={(op) => void runWorkflow(api, store, id, op)}
            onRetry={() => { store.dispatch({ type: 'retry', workflowId: id }); load(id); }} />
        )}
        renderTool={renderTool}
        inspectorKey={inspector}
        onEscape={(doc) => {
          const id = store.getState().activeId;
          if (id !== null) actions.guard(id, () => store.dispatch({ type: 'select', workflowId: id, selection: null }), doc);
        }}
        popoutContent={<SvgDefs />}
        storage={storage}
        restore={session?.dock ?? null}
        onLayoutChange={(dock) => { dockState.current = dock; saver.schedule(); }}
        onRunCommand={(op: RunOp) => {
          const open = store.getState().docs.find((d) => d.workflowId === store.getState().activeId);
          if (!open) return `${RUN_WORD[op]}: open a workflow first.`;
          const why = runBlocked(open, op);
          if (why !== null) return `${RUN_WORD[op]} is not available: ${why}`;
          void runWorkflow(api, store, open.workflowId, op);
          return null;
        }}
      />
      {prompt?.kind === 'design' && (
        <ConfirmDialog doc={prompt.doc} title="Discard design" onCancel={() => setPrompt(null)}
          message="Every unsaved design change in this workflow is dropped; the canvas shows the last saved design again."
          buttons={[{ label: 'Discard', primary: true, onClick: () => { setPrompt(null); store.dispatch({ type: 'discardDesign', workflowId: prompt.workflowId }); } }]} />
      )}
      {prompt?.kind === 'closeDesign' && (
        <ConfirmDialog doc={prompt.doc} title="Save design changes?" onCancel={() => setPrompt(null)}
          message="This workflow has design changes that are not saved. Save stores them on the workflow (BaseApi applies them when it finds no errors); Discard drops them."
          buttons={[
            { label: 'Discard', onClick: () => { setPrompt(null); prompt.proceed(); } },
            {
              label: 'Save', primary: true,
              onClick: () => {
                setPrompt(null);
                // closed once the design is stored; a Save that got no answer keeps the document open with its edits
                void saveDesign(api, store, prompt.workflowId).then(() => {
                  const still = store.getState().docs.find((d) => d.workflowId === prompt.workflowId);
                  if (still && !designDirty(still)) prompt.proceed();
                });
              },
            },
          ]} />
      )}
    </StudioActionsProvider>
  );
}
