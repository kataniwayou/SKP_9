import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { createApi, type StudioApi } from './api/client';
import { describeError } from './api/describeError';
import { Board, type BoardFocus } from './board/Board';
import type { ConnectionKind } from './board/connect';
import { loadBoard } from './board/loadBoard';
import type { ToolbarActions } from './board/nodes/boardContext';
import { deletePicks, livePicks } from './board/picks';
import { placeMissing } from './board/placement';
import { selectPick, type Pick, type SelectionState } from './board/selection';
import { barOf } from './board/selectionBar';
import { SelectionBar } from './board/SelectionBarView';
import { toolbarFor } from './board/Toolbar';
import type { BoardView } from './board/toFlow';
import { ChatHost } from './chat/ChatHost';
import { createChatStore, type ChatStore } from './chat/chatStore';
import type { ToolContext } from './chat/toolTypes';
import type { BoardState, ItemRef } from './design/board';
import { createBoardStore, useBoardState, type BoardStore } from './design/boardStore';
import { addEntry, addWire, linkCache, moveItems } from './design/edits';
import { newId } from './design/ids';
import { nudgeKey, pasteKey, undoRedoKey } from './design/keys';
import { saveBoard } from './design/saveBoard';
import { InspectorPanel } from './inspector/InspectorPanel';
import { createLiveStore, type LiveStore } from './live/liveClient';
import { LiveStoreProvider } from './live/LiveContext';
import { statusOf } from './live/liveState';
import { signalRHub } from './live/signalrHub';
import type { Point } from './model/geometry';
import type { Id } from './model/graph';
import { copyClip, copyMessage, pasteClip, readClip, writeClip } from './operate/clipboard';
import { commitDelete, prepareDelete, type DeletePlan } from './operate/deleteWorkflow';
import { runWorkflow } from './operate/runWorkflow';
import { watchTransitions } from './operate/transitions';
import { OutputPanel } from './output/OutputPanel';
import { createOutputStore, OutputProvider, type OutputStore } from './output/outputStore';
import { readView, writeView, type SavedView } from './session/view';
import { SaveButton } from './shell/SaveButton';
import { Shell } from './shell/Shell';
import { applyTheme, saveTheme, savedTheme, type Theme } from './shell/theme';
import { dropOnBoard, parseToolboxDrag } from './toolbox/drag';
import { ToolboxPanel } from './toolbox/ToolboxPanel';
import './app.css';

export interface AppProps { api?: StudioApi; live?: LiveStore; storage?: Storage | null; session?: Storage | null;
  /** The chat's fetch for /ai (tests); the browser's by default. */
  aiFetch?: typeof fetch }

function browserStorage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

function browserSession(): Storage | null {
  try { return window.sessionStorage; } catch { return null; }
}

const NONE: SelectionState = { workflow: null, picks: [] };
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** A free spot for a new triangle: where placement would put one with no location. */
function freeTriangleSpot(b: BoardState): Point {
  const probe = '\u0000new';
  const placed = placeMissing({ ...b, workflows: { ...b.workflows, [probe]: {
    id: probe, name: '', version: '', description: null, cronExpression: null, entryStepIds: [], assignmentIds: [], cacheIds: [], at: null, updatedAt: null,
  } } });
  return placed.workflows[probe]?.at ?? { x: 0, y: 0 };
}

/** The selection with whatever left the board taken out (the same object when nothing did). */
function trimmed(s: SelectionState, b: BoardState): SelectionState {
  const picks = livePicks(s.picks, b);
  const workflow = s.workflow !== null && b.workflows[s.workflow] ? s.workflow : null;
  return picks.length === s.picks.length && workflow === s.workflow ? s : { workflow, picks };
}

export function App(props: AppProps) {
  const [api] = useState<StudioApi>(() => props.api ?? createApi());
  const [live] = useState<LiveStore>(() => props.live ?? createLiveStore({ api, hub: signalRHub() }));
  const [storage] = useState<Storage | null>(() => (props.storage === undefined ? browserStorage() : props.storage));
  const [output] = useState<OutputStore>(() => createOutputStore(storage));
  const [session] = useState<Storage | null>(() => (props.session === undefined ? browserSession() : props.session));
  const [store] = useState<BoardStore>(() => createBoardStore(output, session));
  const [saved] = useState<SavedView | null>(() => readView(storage));
  // the chat: this tab's sessionStorage, mirrored to localStorage (a new tab picks the conversation up)
  const [chat] = useState<ChatStore>(() => createChatStore(session, storage));

  const [theme, setTheme] = useState<Theme>(() => savedTheme(storage));
  const toggleTheme = useCallback(() => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next); applyTheme(next); saveTheme(next, storage);
  }, [theme, storage]);

  const state = useBoardState(store);
  // problems, failures and saving change without a new board state: count every store change
  const [tick, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => store.subscribe(bump), [store]);
  const liveState = useSyncExternalStore(live.subscribe, live.getState);

  const [loaded, setLoaded] = useState(false);
  const [sel, setSel] = useState<SelectionState>(() => saved?.selection ?? NONE);
  const selRef = useRef(sel);
  selRef.current = sel;
  const [pending, setPending] = useState<DeletePlan | null>(null);
  const pendingRef = useRef<DeletePlan | null>(null);
  const deleteToken = useRef(0);
  const viewport = useRef<{ x: number; y: number; zoom: number } | null>(saved && { x: saved.x, y: saved.y, zoom: saved.zoom });
  const boardFocus = useRef<BoardFocus | null>(null);
  // a nudge session: a press and the repeats of its held key; a new press or a selection change starts the next one
  const nudgeSeq = useRef(0);

  useEffect(() => { live.start(); return () => live.stop(); }, [live]);
  useEffect(() => watchTransitions(live, output,
    (id) => store.state().workflows[id]?.name ?? store.base().workflows[id]?.name ?? null), [live, output, store]);

  // startup: BaseAPI's lists, every unplaced item given a spot, then the store (which restores an unsaved board over it)
  useEffect(() => {
    let cancelled = false;
    void loadBoard(api).then((r) => {
      if (cancelled) return;
      if (r.ok) {
        store.load(placeMissing(r.value));
        output.log(`Board loaded: ${plural(Object.keys(r.value.workflows).length, 'workflow')}`, 'ok');
      } else output.log(`Could not load the board: ${describeError(r.error)}`, 'error');
      setLoaded(true);
    });
    return () => { cancelled = true; };
  }, [api, output, store]);

  const persist = useCallback((s: SelectionState) => {
    const v = viewport.current;
    if (v) writeView(storage, { ...v, selection: s });
  }, [storage]);
  const setSelection = useCallback((next: SelectionState) => {
    selRef.current = next; setSel(next); persist(next);
    nudgeSeq.current++;
    // a selection change drops a pending delete confirm (and a still-running dry run) silently
    deleteToken.current++; pendingRef.current = null; setPending(null);
  }, [persist]);

  // a picked thing that leaves the board (deleted, undone away) leaves the selection
  useEffect(() => {
    if (!loaded) return;
    const s = trimmed(selRef.current, state);
    if (s !== selRef.current) { selRef.current = s; setSel(s); persist(s); }
  }, [loaded, state, persist]);

  const onPick = useCallback((p: Pick | null, additive: boolean) => setSelection(selectPick(selRef.current, p, additive)), [setSelection]);
  const onViewChange = useCallback((v: { x: number; y: number; zoom: number }) => {
    viewport.current = v;
    persist(selRef.current);
  }, [persist]);

  // Ctrl+Z / Ctrl+Y: the one board history
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const act = undoRedoKey(e);
      if (!act) return;
      e.preventDefault();
      if (act === 'undo') store.undo(); else store.redo();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [store]);

  const copySteps = useCallback((ids: Id[]) => {
    const clip = copyClip(store.state(), ids);
    if (!clip) { output.log('Nothing to copy — pick steps', 'warn'); return; }
    writeClip(session, clip);
    output.log(copyMessage(clip), 'ok');
  }, [store, output, session]);

  // Ctrl+V pastes the copied steps as new steps on free board, and picks them
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!pasteKey(e)) return;
      e.preventDefault();
      const clip = readClip(session);
      if (!clip) { output.log('Nothing copied yet', 'warn'); return; }
      let pasted: Id[] = [];
      store.edit((b) => { const r = pasteClip(b, clip, newId); pasted = r.pasted; return r.state; });
      if (pasted.length === 0) return;
      writeClip(session, { ...clip, pasted: clip.pasted + 1 });
      setSelection({ workflow: selRef.current.workflow, picks: pasted.map((id) => ({ kind: 'step' as const, id })) });
      output.log(`Pasted ${plural(pasted.length, 'step')}`, 'ok');
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [store, output, session, setSelection]);

  // arrows nudge the picked triangles, steps and caches by 8 px: one history step while a key repeats
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const d = nudgeKey(e);
      if (!d) return;
      const refs: ItemRef[] = selRef.current.picks.flatMap((p) =>
        p.kind === 'workflow' || p.kind === 'step' || p.kind === 'cache' ? [{ kind: p.kind, id: p.id }] : []);
      if (refs.length === 0) return;
      e.preventDefault();
      if (!e.repeat) nudgeSeq.current++;
      // the first press says the board is saving; its repeats need not say it again
      if (e.repeat && store.saving()) return;
      store.edit((b) => moveItems(b, refs.flatMap((ref) => {
        const row = (ref.kind === 'step' ? b.steps : ref.kind === 'cache' ? b.caches : b.workflows)[ref.id];
        return row?.at ? [{ ref, at: { x: row.at.x + d.dx, y: row.at.y + d.dy } }] : [];
      })), `nudge:${nudgeSeq.current}`);
    };
    // capture, so it runs before the board stops the arrow reaching React Flow's own node movement
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [store]);

  /** Delete of steps, caches, wires, entry arrows and cache lines: one edit, one undo step. */
  const removePicks = useCallback((picks: readonly Pick[]) => {
    const before = store.state();
    store.edit((b) => deletePicks(b, picks));
    if (store.state() !== before) setSelection({ workflow: selRef.current.workflow, picks: [] });
  }, [store, setSelection]);

  const askDelete = useCallback((wf: Id) => {
    const token = ++deleteToken.current;
    void prepareDelete(api, store, output, wf).then((plan) => {
      if (!plan || token !== deleteToken.current) return;
      pendingRef.current = plan; setPending(plan);
    });
  }, [api, store, output]);
  const confirmDelete = useCallback(() => {
    const plan = pendingRef.current;
    if (!plan) return;
    pendingRef.current = null; setPending(null);
    const token = ++deleteToken.current;
    void commitDelete(api, store, output, plan).then((gone) => {
      if (gone && token === deleteToken.current) setSelection(NONE);
    });
  }, [api, store, output, setSelection]);
  const cancelDelete = useCallback(() => {
    if (!pendingRef.current) return;
    deleteToken.current++; pendingRef.current = null; setPending(null);
    output.log('Delete cancelled — nothing was sent');
  }, [output]);

  const toolbar = useMemo<ToolbarActions>(() => (p) => toolbarFor(p, {
    picks: sel.picks,
    run: (wf) => statusOf(live.getState(), wf),
    pending,
    start: (wf) => { void runWorkflow(api, store, output, live, wf, 'start'); },
    stop: (wf) => { void runWorkflow(api, store, output, live, wf, 'stop'); },
    copy: (id) => copySteps([id]),
    remove: (x) => removePicks([x]),
    askDelete, confirmDelete, cancelDelete,
  }), [sel.picks, pending, api, store, output, live, copySteps, removePicks, askDelete, confirmDelete, cancelDelete]);

  const bar = barOf(sel.picks);
  const barView = bar && (
    <SelectionBar bar={bar} actions={{
      copy: () => copySteps(selRef.current.picks.flatMap((p) => (p.kind === 'step' ? [p.id] : []))),
      del: () => removePicks(selRef.current.picks),
    }} />
  );

  const onMove = useCallback((moved: { ref: ItemRef; at: Point }[]) => store.edit((b) => moveItems(b, moved)), [store]);
  const onConnect = useCallback((kind: ConnectionKind, a: Id, b: Id) => {
    if (kind === 'wire') store.editOrRefuse((s) => addWire(s, a, b));
    else if (kind === 'entry') store.editOrRefuse((s) => addEntry(s, a, b));
    else store.editOrRefuse((s) => linkCache(s, a, b));
  }, [store]);
  const onDropData = useCallback((raw: string, at: Point) => {
    const d = parseToolboxDrag(raw);
    if (!d || !Number.isFinite(at.x) || !Number.isFinite(at.y)) return;
    const r = dropOnBoard(store.state(), d, at, newId);
    if ('refused' in r) { output.log(r.refused, 'warn'); return; }
    store.edit(() => r.state);
    if (store.state() !== r.state) return; // refused while saving
    if (r.pick.kind === 'workflow') output.log(`${r.state.workflows[r.pick.id]!.name} created — it is saved only when you press Save`, 'ok');
    setSelection(selectPick(selRef.current, r.pick, false));
  }, [store, output, setSelection]);

  const view = useMemo<BoardView>(() => ({
    workflow: sel.workflow, picks: sel.picks,
    live: (wf) => statusOf(liveState, wf),
    problems: (wf) => store.problems(wf),
    failed: (key) => store.failures().has(key),
  // tick: the problems and failures are read through the store, so a change of theirs is a new view
  }), [sel, liveState, store, tick]);

  const processors = useMemo(() => Object.values(state.processors).sort((a, b) => a.name.localeCompare(b.name)), [state.processors]);
  const stateNow = useCallback(() => store.state(), [store]);

  // what the chat's tools act on: the same store, history and picks as the user's own gestures
  const chatCtx = useMemo<ToolContext>(() => ({
    store, api, output, live, session, newId,
    processors: () => Object.values(store.state().processors),
    caches: () => Object.values(store.state().caches),
    commands: {
      focus: (workflowId, stepIds) => boardFocus.current?.(workflowId, stepIds),
      setPicks: (picks) => setSelection({ workflow: selRef.current.workflow, picks }),
      picks: () => selRef.current.picks,
      newWorkflowAt: () => freeTriangleSpot(store.state()),
    },
  }), [store, api, output, live, session, setSelection]);

  return (
    <LiveStoreProvider value={live}>
      <OutputProvider store={output}>
        <div className="acto">
          <header className="topbar"><span className="brand">Act<span>o</span></span>
            <SaveButton unsaved={store.unsaved().size} saving={store.saving()} onSave={() => { void saveBoard(api, store, output); }} />
            <button type="button" className="pbtn theme-toggle" onClick={toggleTheme}>{theme === 'dark' ? 'Light' : 'Dark'}</button>
          </header>
          <Shell
            storage={storage}
            toolbox={<ToolboxPanel processors={processors} />}
            board={!loaded
              ? <div className="board-wait">Loading the board…</div>
              : <Board state={state} view={view} onPick={onPick} onMove={onMove} onConnect={onConnect} onDropData={onDropData}
                  toolbar={toolbar} bar={barView} settled={loaded} focusRef={boardFocus} stateNow={stateNow} onViewChange={onViewChange}
                  {...(saved ? { initialView: { x: saved.x, y: saved.y, zoom: saved.zoom } } : {})} />}
            inspector={<InspectorPanel store={store} selection={sel} />}
            output={<OutputPanel />}
            chat={<ChatHost chat={chat} ctx={chatCtx} ready={loaded} storage={storage} {...(props.aiFetch ? { fetchFn: props.aiFetch } : {})} />}
          />
        </div>
      </OutputProvider>
    </LiveStoreProvider>
  );
}
