import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createApi, type StudioApi } from './api/client';
import { describeError } from './api/describeError';
import type { WorkflowReadDto } from './api/types';
import { ConfirmDialog } from './app/ConfirmDialog';
import { cancelDelete, commitDelete, deleteGoes, deleteWarningLines, prepareDelete, type DeletePlan } from './app/deleteWorkflow';
import { DocumentPanel } from './app/DocumentPanel';
import { createInspectorService } from './app/inspectorService';
import { loadDocument } from './app/loadDocument';
import { newWorkflowDocument, untitledName } from './app/newWorkflow';
import { runWorkflow } from './app/runWorkflow';
import { saveDesign } from './app/saveDesign';
import { browserTabStorage, createSaver, keepSession, readTabSession, restoredState, sessionOf, type Session } from './app/session';
import { StudioActionsProvider, type StudioActions } from './app/studioActions';
import { documentSettled, type StudioCommands } from './app/studioCommands';
import { SvgDefs } from './canvas/SvgDefs';
import type { SavedView } from './canvas/savedView';
import { fitterFor } from './canvas/useFitter';
import { DockShell, type DockDocument, type PickerItem } from './dock/DockShell';
import type { ToolId } from './dock/ids';
import { browserStorage, type SavedLayout } from './dock/layoutPersistence';
import { entityName } from './model/entityNames';
import { createLiveStore, type HubFactory } from './live/liveClient';
import { LiveStoreProvider, useLive, useLiveStore } from './live/LiveContext';
import { statusOf } from './live/liveState';
import { signalRHub } from './live/signalrHub';
import { Inspector } from './panels/Inspector';
import { createChatStore } from './chat/chatStore';
import { ChatHost, ChatStoreProvider } from './chat/ChatHost';
import { Output } from './panels/Output';
import { Toolbox } from './panels/Toolbox';
import type { Pick } from './store/picks';
import { newId } from './design/ids';
import { AI_DRAWING, NOT_SAVED_YET, runBlocked, RUN_WORD, type RunOp } from './store/run';
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
    case 'chat': return <ChatHost />;
  }
}

export interface AppProps {
  api?: StudioApi;
  /** The browser's storage: the saved window layout, and the session's mirror. Default: localStorage. */
  storage?: Storage | null;
  /** This tab's storage, where its session lives. Default: sessionStorage. */
  tabStorage?: Storage | null;
  /**
   * The liveness hub (2026-10-10). Default: BaseApi's SignalR hub, or none when `api` is injected (a test's fake api:
   * the studio then polls it). Null: no hub, poll only.
   */
  hub?: HubFactory | null;
}

/**
 * The studio page (slice 3a): one store, the dock, and what goes in its documents and panes. The page
 * keeps its session (plan 3d): the store starts from it, so a refresh brings back what was open.
 */
export function App({ api: injected, storage, tabStorage, hub }: AppProps) {
  const api = useMemo(() => injected ?? createApi(), [injected]);
  const resolved = useMemo(() => (storage === undefined ? browserStorage() : storage), [storage]);
  const tab = useMemo(() => (tabStorage === undefined ? browserTabStorage() : tabStorage), [tabStorage]);
  const session = useMemo(() => readTabSession(tab, resolved), [tab, resolved]);
  // the session is read once: the store is made once, from the session the page started with
  const store = useMemo(() => createStudioStore(restoredState(session)), []);
  // one liveness store for the app, opened at start and independent of documents (2026-10-10); not kept across a refresh
  // the chat's own store: kept per tab like the session, but separate from it (2026-10-23)
  const chat = useMemo(() => createChatStore(tab, resolved), []);
  useEffect(() => {
    const flush = () => chat.flush();
    window.addEventListener('pagehide', flush);
    return () => { window.removeEventListener('pagehide', flush); chat.flush(); };
  }, [chat]);
  const live = useMemo(() => createLiveStore({ api, hub: hub !== undefined ? hub : injected ? null : signalRHub() }), []);
  useEffect(() => { live.start(); return () => live.stop(); }, [live]);
  // the page's fonts start loading at once, so the first document opens with its fitter ready
  useEffect(() => { void fitterFor(document); }, []);
  return (
    <StudioStoreProvider value={store}>
      <ChatStoreProvider value={chat}>
        <LiveStoreProvider value={live}>
          <SvgDefs />
          <Studio api={api} storage={resolved} tabStorage={tab} session={session} />
        </LiveStoreProvider>
      </ChatStoreProvider>
    </StudioStoreProvider>
  );
}

function Studio({ api, storage, tabStorage, session }: { api: StudioApi; storage: Storage | null; tabStorage: Storage | null; session: Session | null }) {
  const store = useStudioStore();
  const live = useLiveStore();
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

  // Output logs every workflow that starts or stops, open or not (2026-10-10), named from the open document or the
  // workflow list; a workflow the list does not know yet is named by its id, and the list is read again
  const listed = useRef(workflows);
  listed.current = workflows;
  useEffect(() => live.onWorkflowChange((changes) => {
    const at = new Date().toISOString();
    let stale = false;
    for (const change of changes) {
      const same = (id: string | null | undefined) => id?.toLowerCase() === change.workflowId;
      const open = store.getState().docs.find((d) => same(d.workflowId));
      const known = listed.current.find((w) => same(w.id));
      if (!open && !known) stale = true;
      store.dispatch({
        type: 'liveChanged', workflowId: open?.workflowId ?? known?.id ?? change.workflowId,
        name: open?.name ?? known?.name ?? change.workflowId, running: change.running, at,
      });
    }
    if (stale) readList();
  }), [live, store, readList]);
  const liveOf = useCallback((id: string) => statusOf(live.getState(), id), [live]);
  const running = useLive((s) => (s.workflows === 'known' ? s.running : null));

  /** Fetches an open document's workflow; a result that lands after the document was closed is dropped. */
  const load = useCallback((id: string) => {
    const token = (opens.current.get(id) ?? 0) + 1;
    opens.current.set(id, token);
    // a new workflow (2026-10-10) BaseApi does not have yet: built again here, never read
    const doc = store.getState().docs.find((d) => d.workflowId === id);
    const reading = doc?.virtual
      ? newWorkflowDocument(id, doc.name, doc.version).then((value) => ({ ok: true as const, value }))
      : loadDocument(api, id);
    void reading.then((r) => {
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
    | { kind: 'closeDesign'; workflowId: string; doc: Document; proceed: () => void }
    | { kind: 'deleteWorkflow'; plan: DeletePlan; doc: Document };
  const [prompt, setPromptState] = useState<Prompt | null>(null);
  // the open question, read by the guard at once (state would lag a render behind)
  const asking = useRef<Prompt | null>(null);
  const setPrompt = useCallback((next: Prompt | null) => { asking.current = next; setPromptState(next); }, []);

  const openWorkflow = useCallback((id: string) => {
    const known = workflows.find((w) => w.id === id);
    const alreadyOpen = store.getState().docs.some((d) => d.workflowId === id);
    store.dispatch({ type: 'open', workflowId: id, name: known?.name ?? id, version: known?.version ?? '' });
    if (!alreadyOpen) load(id);
  }, [store, workflows, load]);

  useEffect(() => {
    for (const d of store.getState().docs) if (d.status.kind === 'loading') load(d.workflowId);
  }, []); // the restored documents only; later ones are loaded by openWorkflow

  // Workflow › New workflow (2026-10-10): a blank document with only the hub, a workflow that exists only in the studio
  // until its first Save creates it; named untitled (or untitled-2, …) so no listed or open workflow has its name
  const newWorkflow = useCallback(() => {
    const id = newId();
    const name = untitledName([...workflows.map((w) => w.name ?? ''), ...store.getState().docs.map((d) => d.name)]);
    // the hub on the left of the canvas, at 100 %, clear of the capsule toolbar: a Fit would centre a lone hub
    views.current.set(id, { x: 0, y: 64, zoom: 1, followFit: false });
    return newWorkflowDocument(id, name).then((doc) => { store.dispatch({ type: 'new', workflowId: id, doc }); return id; });
  }, [store, workflows]);

  // Save; a new workflow it created is listed by BaseApi from now on: the picker's list is read again
  const save = useCallback((id: string) => {
    const wasNew = store.getState().docs.find((d) => d.workflowId === id)?.virtual === true;
    return saveDesign(api, store, id).then(() => {
      if (wasNew && store.getState().docs.find((d) => d.workflowId === id)?.virtual === false) readList();
    });
  }, [api, store, readList]);

  // Workflow › Delete workflow… (2026-10-10): a fresh liveness reading and BaseApi's dry run first; the warning only
  // then, with Cancel as its default; nothing destructive is sent before Continue. One deletion at a time per workflow.
  const deleting = useRef(new Set<string>());
  /**
   * The delete up to its warning, shared by the menu and the chat. The menu holds the deletion until its warning is
   * answered (`holdForAnswer`); the chat asks in its own way, so only the preparation holds it.
   */
  const planDelete = useCallback(async (id: string, holdForAnswer: boolean): Promise<DeletePlan | null> => {
    if (deleting.current.has(id) || (holdForAnswer && asking.current !== null)) return null;
    const open = store.getState().docs.find((d) => d.workflowId === id);
    if (!open || open.status.kind !== 'ready' || open.saving) {
      store.dispatch({ type: 'log', workflowId: id, lines: [{ at: new Date().toISOString(), text: 'Not deleted: the workflow is still loading or saving', level: 'error' }] });
      return null;
    }
    if (open.drawing) {
      store.dispatch({ type: 'log', workflowId: id, lines: [{ at: new Date().toISOString(), text: `Not deleted: ${AI_DRAWING}`, level: 'error' }] });
      return null;
    }
    deleting.current.add(id);
    const plan = await prepareDelete(api, store, id);
    const gone = plan === null || (holdForAnswer && asking.current !== null) || !store.getState().docs.some((d) => d.workflowId === id);
    if (gone || !holdForAnswer) deleting.current.delete(id);
    return gone ? null : plan;
  }, [api, store]);
  const deleteWorkflow = useCallback((id: string) => {
    void planDelete(id, true).then((plan) => { if (plan) setPrompt({ kind: 'deleteWorkflow', plan, doc: document }); });
  }, [planDelete, setPrompt]);
  /** `held`: the menu's warning already holds this deletion; the chat's commit takes the hold itself. */
  const continueDelete = useCallback(async (plan: DeletePlan, held = true): Promise<boolean> => {
    if (!held) {
      if (deleting.current.has(plan.workflowId)) return false;
      deleting.current.add(plan.workflowId);
    }
    const deleted = await commitDelete(api, store, plan);
    deleting.current.delete(plan.workflowId);
    if (!deleted) return false;
    // gone from BaseApi: from the picker, the views and every per-document memory too
    views.current.delete(plan.workflowId);
    opens.current.delete(plan.workflowId);
    setWorkflows((list) => list.filter((w) => w.id !== plan.workflowId));
    saver.flush();
    return true;
  }, [api, store]);

  // closing: the AI's drawing keeps a document open; the menu asks about a design draft first, the chat does not
  const refuseClose = useCallback((id: string): boolean => {
    if (!store.getState().docs.find((d) => d.workflowId === id)?.drawing) return false;
    store.dispatch({ type: 'log', workflowId: id, lines: [{ at: new Date().toISOString(), text: `Not closed: ${AI_DRAWING}`, level: 'error' }] });
    return true;
  }, [store]);
  const closeNow = useCallback((id: string) => {
    views.current.delete(id); // reopened later, it fits afresh
    store.dispatch({ type: 'close', workflowId: id });
  }, [store]);

  // what the chat may ask of the page (2026-10-23): the same paths as the menus, without their dialogs
  const commands: StudioCommands = useMemo(() => ({
    listWorkflows: () => api.listWorkflows(),
    open: (id) => { openWorkflow(id); return documentSettled(store, id); },
    newWorkflow,
    activate: (id) => store.dispatch({ type: 'activate', workflowId: id }),
    save: (id) => save(id),
    run: (id, op) => runWorkflow(api, store, id, op, liveOf),
    prepareDelete: (id) => planDelete(id, false),
    commitDelete: (plan) => continueDelete(plan, false),
    close: (id) => { if (!refuseClose(id)) closeNow(id); },
  }), [api, store, openWorkflow, newWorkflow, save, liveOf, planDelete, continueDelete, refuseClose, closeNow]);

  const actions: StudioActions = useMemo(() => ({
    service,
    api,
    // nothing is lost by moving away (plan 8): only an open question holds an action back
    guard: (_workflowId, proceed) => { if (asking.current === null) proceed(); },
    confirmDiscardDesign: (workflowId, doc = document) => {
      if (asking.current !== null) return;
      setPrompt({ kind: 'design', workflowId, doc });
    },
    commands,
  }), [service, setPrompt, api, commands]);

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
  const identity = docs.map((d) => `${d.workflowId}\u0000${d.name}\u0000${d.version}\u0000${designDirty(d)}\u0000${d.saving}`).join('\u0001');
  const documents: DockDocument[] = useMemo(
    () => docs.map((d) => ({ id: d.workflowId, name: d.name, version: d.version, tooltip: entityName(d.name, d.version, d.workflowId), dirty: designDirty(d), saving: d.saving })),
    [identity], // the part of `docs` the dock shows; `docs` itself changes on every selection

  );
  const items: PickerItem[] = useMemo(
    () => workflows.filter((w) => w.id).map((w) => ({
      id: w.id!, label: uniqueName(w), open: documents.some((d) => d.id === w.id), running: running?.has(w.id!.toLowerCase()) ?? false,
    })),
    [workflows, documents, running],
  );

  return (
    <StudioActionsProvider value={actions}>
      <SaveAnnouncer />
      <DockShell
        documents={documents}
        notice={notice}
        activeDocumentId={activeId}
        onActivateDocument={(id) => store.dispatch({ type: 'activate', workflowId: id })}
        onCloseDocument={(id, doc) => {
          const close = () => closeNow(id);
          // the AI is drawing it (2026-10-11): it stays open until the drawing lands or is cancelled
          if (refuseClose(id)) return;
          // a design draft is asked about first: Discard closes, dropping the draft with the document
          const open = store.getState().docs.find((d) => d.workflowId === id);
          if (open && designDirty(open) && asking.current === null) setPrompt({ kind: 'closeDesign', workflowId: id, doc: doc ?? document, proceed: close });
          else close();
        }}
        workflows={items}
        status={<LiveMark />}
        pickerNote={listError}
        onPickerOpen={readList}
        onOpenWorkflow={openWorkflow}
        renderDocument={(id, panel) => (
          <DocumentPanel workflowId={id} panel={panel} onDeleteWorkflow={() => deleteWorkflow(id)}
            initialView={views.current.get(id) ?? null}
            onViewChange={(v) => { views.current.set(id, v); saver.schedule(); }}
            onSelect={(selection: Selection | null, doc: Document, picks?: Pick[]) => {
              // a click on this canvas takes the Inspector back from the Toolbox, even on what was already selected
              if (store.getState().toolboxPick !== null) store.dispatch({ type: 'toolboxPick', pick: null });
              store.dispatch({ type: 'activate', workflowId: id });
              const open = store.getState().docs.find((d) => d.workflowId === id);
              // the same entity: only the picks change, and the Inspector has nothing to ask
              if (open && selectionKey(open.selection) === selectionKey(selection)) {
                if (picks) store.dispatch({ type: 'pick', workflowId: id, picks });
                return;
              }
              actions.guard(id, () => store.dispatch({ type: 'select', workflowId: id, selection, picks }), doc);
            }}
            onSave={() => void save(id)}
            onRun={(op) => void runWorkflow(api, store, id, op, liveOf)}
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
        toolMenu={(id) => (id !== 'output' ? [] : [{
          id: 'clear', icon: '⌫', label: 'Clear output', tip: 'Clear the messages; current problems stay',
          disabled: store.getState().output.length === 0, onSelect: () => store.dispatch({ type: 'clearOutput' }),
        }])}
        onDeleteWorkflow={deleteWorkflow}
        deleteBlocked={(id) => (store.getState().docs.find((d) => d.workflowId === id)?.virtual ? NOT_SAVED_YET : null)}
        onNewWorkflow={newWorkflow}
        onRunCommand={(op: RunOp) => {
          const open = store.getState().docs.find((d) => d.workflowId === store.getState().activeId);
          if (!open) return `${RUN_WORD[op]}: open a workflow first.`;
          const why = runBlocked(open);
          if (why !== null) return `${RUN_WORD[op]} is not available: ${why}`;
          void runWorkflow(api, store, open.workflowId, op, liveOf);
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
          message={store.getState().docs.find((d) => d.workflowId === prompt.workflowId)?.virtual
            ? 'This new workflow is not saved yet: BaseApi has no such workflow. Save creates it (when BaseApi finds no errors); Discard drops it entirely.'
            : 'This workflow has design changes that are not saved. Save stores them on the workflow (BaseApi applies them when it finds no errors); Discard drops them.'}
          buttons={[
            { label: 'Discard', onClick: () => { setPrompt(null); prompt.proceed(); } },
            {
              label: 'Save', primary: true,
              onClick: () => {
                setPrompt(null);
                // closed once the design is stored; a Save that got no answer keeps the document open with its edits
                void save(prompt.workflowId).then(() => {
                  const still = store.getState().docs.find((d) => d.workflowId === prompt.workflowId);
                  if (still && !designDirty(still)) prompt.proceed();
                });
              },
            },
          ]} />
      )}
      {prompt?.kind === 'deleteWorkflow' && (
        <ConfirmDialog doc={prompt.doc} title={`Delete workflow '${prompt.plan.name}'?`} safe
          onCancel={() => { setPrompt(null); deleting.current.delete(prompt.plan.workflowId); cancelDelete(store, prompt.plan.workflowId); }}
          message={<DeleteWarning plan={prompt.plan} />}
          buttons={[{ label: 'Continue', onClick: () => { setPrompt(null); void continueDelete(prompt.plan); } }]} />
      )}
    </StudioActionsProvider>
  );
}

/** The warning before a workflow's deletion (2026-10-10): what BaseApi's dry run says goes, and what stays. */
function DeleteWarning({ plan }: { plan: DeletePlan }) {
  const goes = deleteGoes(plan);
  return (
    <div className="delwarn">
      {deleteWarningLines(plan).map((line) => {
        const at = line.indexOf(goes);
        // the first line stresses what goes
        return <p key={line}>{at < 0 ? line : <>{line.slice(0, at)}<b>{goes}</b>{line.slice(at + goes.length)}</>}</p>;
      })}
    </div>
  );
}

/** How long live updates must stay down before the mark shows: a reconnect that succeeds sooner shows nothing. */
export const LIVE_MARK_DELAY_MS = 4000;

/**
 * The status area's mark while live updates are not reaching the studio from the hub (2026-10-10): the studio polls
 * meanwhile, and the mark goes when the hub is back. Nothing while connected or still connecting at start, and nothing
 * for a drop that reconnects within LIVE_MARK_DELAY_MS (e.g. a background tab's throttled timers).
 */
export function LiveMark() {
  const connection = useLive((s) => s.connection);
  const down = connection === 'reconnecting' || connection === 'offline';
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!down) { setShown(false); return; }
    const timer = setTimeout(() => setShown(true), LIVE_MARK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [down]);
  if (!down || !shown) return null;
  return (
    <span className="livemark" role="status" aria-label="Live updates"
      data-tip="Live updates from BaseApi are not connected; the studio reads the status every 5 s until they are back">
      <span className="spin-dot" aria-hidden="true" />live updates reconnecting
    </span>
  );
}

/**
 * A polite live region (2026-10-10): "Saving <name>…" when a Save starts, "Saved <name>" or "Not saved <name>" when it
 * ends; what happened in detail is Output's log, not repeated here.
 */
export function SaveAnnouncer() {
  const docs = useStudio((s) => s.docs);
  const output = useStudio((s) => s.output);
  const was = useRef(new Map<string, boolean>());
  const [message, setMessage] = useState('');
  useEffect(() => {
    for (const d of docs) {
      const before = was.current.get(d.workflowId) ?? false;
      if (d.saving && !before) setMessage(`Saving ${d.name}…`);
      if (!d.saving && before) {
        const verdict = output.findLast((l) => l.workflowId === d.workflowId && /^(Saved|Not saved)/.test(l.text));
        setMessage(verdict && verdict.text.startsWith('Saved') && !verdict.text.startsWith('Saved; not applied') ? `Saved ${d.name}` : `Not saved ${d.name}`);
      }
      was.current.set(d.workflowId, d.saving);
    }
  }, [docs, output]);
  return <div className="sr-only" role="status" aria-live="polite" aria-label="Save status">{message}</div>;
}
