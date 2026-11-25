import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { createApi, type StudioApi } from './api/client';
import { describeError } from './api/describeError';
import { Board, type BoardCenter, type BoardFocus } from './board/Board';
import type { ConnectionKind } from './board/connect';
import { loadBoard } from './board/loadBoard';
import type { ToolbarActions } from './board/nodes/boardContext';
import { deletePicks, deleteRefusal, livePicks } from './board/picks';
import { placeMissing } from './board/placement';
import { nudgeBlocked, occupied, rectAt } from './board/occupied';
import { pushAside } from './board/overlap';
import { selectPick, synced, withPicks, type Pick, type SelectionState } from './board/selection';
import { withBox } from './board/boxSelect';
import { barOf } from './board/selectionBar';
import { SelectionBar } from './board/SelectionBarView';
import { toolbarFor } from './board/Toolbar';
import type { BoardView } from './board/toFlow';
import { ChatHost } from './chat/ChatHost';
import { createChatStore, type ChatStore } from './chat/chatStore';
import type { ToolContext } from './chat/toolTypes';
import type { BoardState, ItemRef } from './design/board';
import { NO_AUDIT } from './design/board';
import { createBoardStore, useBoardState, type BoardStore } from './design/boardStore';
import { addEntry, addWire, linkCache, moveItems } from './design/edits';
import { newId } from './design/ids';
import { nudgeKey, pasteKey, undoRedoKey } from './design/keys';
import { unsavedMarks } from './design/changes';
import { createGhostStore, keepGhosts, restoreGhosts, withTheirWires, type GhostItem, type GhostStore } from './design/ghosts';
import { saveBoard, takeStored } from './design/saveBoard';
import { InspectorPanel, pickName } from './inspector/InspectorPanel';
import { createLiveStore, type LiveStore } from './live/liveClient';
import { LiveStoreProvider } from './live/LiveContext';
import { statusOf } from './live/liveState';
import { signalRHub } from './live/signalrHub';
import type { Point } from './model/geometry';
import type { Id } from './model/graph';
import { copyClip, copyMessage, pasteClip, pasteMessage, readClip, writeClip } from './operate/clipboard';
import { runWorkflow } from './operate/runWorkflow';
import { watchTransitions } from './operate/transitions';
import { OutputPanel } from './output/OutputPanel';
import { createOutputStore, OutputProvider, type OutputStore } from './output/outputStore';
import { readView, writeView, type SavedView } from './session/view';
import { DiscardButton, SaveButton, TakeStoredButton } from './shell/SaveButton';
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

const NONE: SelectionState = { workflows: [], picks: [] };
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** A free spot for a new triangle: where placement would put one with no location. */
function freeTriangleSpot(b: BoardState): Point {
  const probe = '\u0000new';
  const placed = placeMissing({ ...b, workflows: { ...b.workflows, [probe]: {
    id: probe, name: '', version: '', description: null, entryStepIds: [], entryCrons: {}, assignmentIds: [], cacheIds: [], at: null, updatedAt: null, ...NO_AUDIT,
  } } });
  return placed.workflows[probe]?.at ?? { x: 0, y: 0 };
}

/** The selection with whatever left the board (or the ghosts, restored or removed) taken out (the same object when nothing did). */
function trimmed(s: SelectionState, b: BoardState, ghosts: readonly GhostItem[]): SelectionState {
  const keys = new Set(ghosts.map((g) => g.key));
  const picks = livePicks(s.picks, b).filter((p) => p.kind !== 'ghost' || keys.has(p.key));
  const workflows = s.workflows.filter((id) => b.workflows[id]);
  return picks.length === s.picks.length && workflows.length === s.workflows.length ? s : { workflows, picks };
}

export function App(props: AppProps) {
  const [api] = useState<StudioApi>(() => props.api ?? createApi());
  const [live] = useState<LiveStore>(() => props.live ?? createLiveStore({ api, hub: signalRHub() }));
  const [storage] = useState<Storage | null>(() => (props.storage === undefined ? browserStorage() : props.storage));
  const [output] = useState<OutputStore>(() => createOutputStore(storage));
  const [session] = useState<Storage | null>(() => (props.session === undefined ? browserSession() : props.session));
  const [store] = useState<BoardStore>(() => createBoardStore(output, storage));
  // the draft and its ghosts live in localStorage: they outlive the tab and belong to the draft [user, 2026-11-23]
  const [ghostStore] = useState<GhostStore>(() => createGhostStore(store, storage));
  useEffect(() => keepGhosts(ghostStore, storage, output), [ghostStore, storage, output]);
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
  const ghosts = useSyncExternalStore(ghostStore.subscribe, ghostStore.ghosts);
  // for the tabs of hidden panels: a dot on Output / Chat when something new comes in
  const outputLines = useSyncExternalStore(output.subscribe, output.lines);
  const chatEntries = useSyncExternalStore(chat.subscribe, () => chat.getState().entries);

  const [loaded, setLoaded] = useState(false);
  const [sel, setSel] = useState<SelectionState>(() => saved?.selection ?? NONE);
  const selRef = useRef(sel);
  selRef.current = sel;
  const viewport = useRef<{ x: number; y: number; zoom: number } | null>(saved && { x: saved.x, y: saved.y, zoom: saved.zoom });
  const boardFocus = useRef<BoardFocus | null>(null);
  const boardCenter = useRef<BoardCenter | null>(null);
  // a nudge session: a press and the repeats of its held key; a new press or a selection change starts the next one
  const nudgeSeq = useRef(0);

  useEffect(() => { live.start(); return () => live.stop(); }, [live]);
  useEffect(() => watchTransitions(live, output,
    (id) => store.state().workflows[id]?.name ?? store.base().workflows[id]?.name ?? null), [live, output, store]);

  /**
   * Discard [user, 2026-11-25]: the board back to what a fresh load shows (BaseAPI's rows, every unplaced item given a spot),
   * as one undo step. Output says how many changes went and that Ctrl+Z brings them back.
   */
  const discard = useCallback(() => {
    const n = store.discard(placeMissing(store.base()));
    if (n > 0) output.log(`Discarded ${plural(n, 'unsaved change')} — Ctrl+Z brings ${n === 1 ? 'it' : 'them'} back`, 'ok');
  }, [store, output]);

  // startup: BaseAPI's lists, every unplaced item given a spot, then the store (which restores an unsaved board over it)
  useEffect(() => {
    let cancelled = false;
    void loadBoard(api).then((r) => {
      if (cancelled) return;
      if (r.ok) {
        // base stays BaseAPI's rows (nulls kept): the placed locations are unsaved, go out with the next Save, and are no undo step
        store.load(r.value, placeMissing(r.value));
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
  }, [persist]);

  // a picked thing that leaves the board (deleted, undone away) leaves the selection; so does a ghost restored or removed
  useEffect(() => {
    if (!loaded) return;
    const s = trimmed(selRef.current, state, ghosts);
    if (s !== selRef.current) { selRef.current = s; setSel(s); persist(s); }
  }, [loaded, state, ghosts, persist]);

  const onInspectorPicks = useCallback((picks: Pick[]) => setSelection(withPicks(selRef.current, picks)), [setSelection]);
  const onPick = useCallback((p: Pick | null, additive: boolean) => setSelection(selectPick(selRef.current, p, additive)), [setSelection]);
  /** A right-button box: its picks replace the selection, or (Ctrl) join it; an empty box clears it (with Ctrl, changes nothing). */
  const onBoxPick = useCallback((picks: Pick[], additive: boolean) =>
    setSelection(withPicks(selRef.current, withBox(synced(selRef.current).picks, picks, additive))), [setSelection]);
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

  const copyItems = useCallback((refs: ItemRef[]) => {
    const clip = copyClip(store.state(), refs);
    if (!clip) { output.log('Nothing to copy — pick workflows, steps or caches', 'warn'); return; }
    writeClip(session, clip);
    output.log(copyMessage(clip), 'ok');
  }, [store, output, session]);

  // Ctrl+V pastes the copied triangles, steps and caches as new ones on free board, and picks them
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!pasteKey(e)) return;
      e.preventDefault();
      const clip = readClip(session);
      if (!clip) { output.log('Nothing copied yet', 'warn'); return; }
      let pasted: ItemRef[] = [];
      store.edit((b) => { const r = pasteClip(b, clip, newId); pasted = r.pasted; return r.state; });
      if (pasted.length === 0) return;
      writeClip(session, { ...clip, pasted: clip.pasted + 1 });
      const triangles = pasted.flatMap((p) => (p.kind === 'workflow' ? [p.id] : []));
      setSelection({ workflows: triangles.length > 0 ? triangles : selRef.current.workflows, picks: pasted.map((p) => ({ ...p })) });
      output.log(pasteMessage(pasted), 'ok');
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
      const b0 = store.state();
      const moves = refs.flatMap((ref) => {
        const row = (ref.kind === 'step' ? b0.steps : ref.kind === 'cache' ? b0.caches : b0.workflows)[ref.id];
        return row?.at ? [{ ref, at: { x: row.at.x + d.dx, y: row.at.y + d.dy } }] : [];
      });
      // a nudge stops against another item (a ghost included) rather than going over it [user, 2026-11-25]
      const others = occupied(b0, ghostStore.ghosts(), new Set(refs.map((r) => `${r.kind}:${r.id}`)));
      if (nudgeBlocked(moves.map((m) => rectAt(m.ref.kind, m.at)), others)) return;
      store.edit((b) => moveItems(b, moves), `nudge:${nudgeSeq.current}`);
    };
    // capture, so it runs before the board stops the arrow reaching React Flow's own node movement
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [store, ghostStore]);

  /**
   * Delete of triangles, steps, caches, wires, entry arrows and cache lines: one edit, one undo step, ghosts until Save
   * [user, 2026-11-23]. A pick holding a running workflow (or one whose state is not known) deletes nothing at all.
   */
  const removePicks = useCallback((picks: readonly Pick[]) => {
    const refused = deleteRefusal(picks, store.state(), store.base(), (wf) => statusOf(live.getState(), wf));
    if (refused.length) { for (const line of refused) output.log(line, 'warn'); return; }
    const before = store.state();
    store.edit((b) => deletePicks(b, picks));
    if (store.state() !== before) setSelection({ workflows: selRef.current.workflows, picks: [] });
  }, [store, setSelection, live, output]);

  /** Restore: the ghosts back as one board edit (one undo step); a refusal (`restore <name> first`) is an Output warning. */
  const restore = useCallback((keys: string[]) => {
    const items = keys.flatMap((k) => { const g = ghostStore.get(k); return g ? [g] : []; });
    if (items.length === 0) return;
    store.editOrRefuse((b) => restoreGhosts(b, store.base(), withTheirWires(b, items, ghostStore.ghosts()), ghostStore.get));
  }, [store, ghostStore]);
  /** Remove: the ghosts leave the board for this page session; BaseAPI is not touched and it is no undo step. */
  const removeGhosts = useCallback((keys: string[]) => ghostStore.remove(keys), [ghostStore]);

  const run = useCallback((wf: Id, op: 'start' | 'stop') => { void runWorkflow(api, store, output, live, wf, op); }, [api, store, output, live]);
  const toolbar = useMemo<ToolbarActions>(() => (p) => toolbarFor(p, {
    picks: sel.picks,
    run: (wf) => statusOf(live.getState(), wf),
    saved: (wf) => !!store.base().workflows[wf],
    start: (wf) => run(wf, 'start'),
    stop: (wf) => run(wf, 'stop'),
    copy: (ref) => copyItems([ref]),
    remove: (x) => removePicks([x]),
    restore, removeGhosts,
  }), [sel.picks, live, run, copyItems, removePicks, restore, removeGhosts]);

  const bar = barOf(sel.picks);
  const ghostKeys = () => selRef.current.picks.flatMap((p) => (p.kind === 'ghost' ? [p.key] : []));
  const triangleIds = () => selRef.current.picks.flatMap((p) => (p.kind === 'workflow' ? [p.id] : []));
  const barView = bar && (
    <SelectionBar bar={bar} startDisabled={bar.run && triangleIds().some((id) => !store.base().workflows[id])} actions={{
      copy: () => copyItems(selRef.current.picks.flatMap((p) => (p.kind === 'step' || p.kind === 'cache' || p.kind === 'workflow' ? [{ kind: p.kind, id: p.id }] : []))),
      del: () => removePicks(selRef.current.picks),
      restore: () => restore(ghostKeys()),
      remove: () => removeGhosts(ghostKeys()),
      start: () => { for (const wf of triangleIds()) run(wf, 'start'); },
      stop: () => { for (const wf of triangleIds()) run(wf, 'stop'); },
    }} />
  );

  const onMove = useCallback((moved: { ref: ItemRef; at: Point }[]) => store.edit((b) => moveItems(b, moved)), [store]);
  const onMoveGhosts = useCallback((moved: { key: string; at: Point }[]) => ghostStore.moveGhosts(moved), [ghostStore]);
  const onConnect = useCallback((kind: ConnectionKind, a: Id, b: Id) => {
    if (kind === 'wire') store.editOrRefuse((s) => addWire(s, a, b));
    else if (kind === 'entry') store.editOrRefuse((s) => addEntry(s, a, b));
    else store.editOrRefuse((s) => linkCache(s, a, b));
  }, [store]);
  const onDropData = useCallback((raw: string, at: Point) => {
    const d = parseToolboxDrag(raw);
    if (!d || !Number.isFinite(at.x) || !Number.isFinite(at.y)) return;
    const r0 = dropOnBoard(store.state(), d, at, newId);
    if ('refused' in r0) { output.log(r0.refused, 'warn'); return; }
    // a new item dropped on another (a ghost included) slides to the nearest free place, as a dragged one does [user, 2026-11-25]
    const r = (() => {
      const p = r0.pick;
      if (p.kind !== 'workflow' && p.kind !== 'step' && p.kind !== 'cache') return r0;
      const row = (p.kind === 'step' ? r0.state.steps : p.kind === 'cache' ? r0.state.caches : r0.state.workflows)[p.id];
      if (!row?.at) return r0;
      const off = pushAside([rectAt(p.kind, row.at)], occupied(r0.state, ghostStore.ghosts(), new Set([`${p.kind}:${p.id}`])));
      if (off.x === 0 && off.y === 0) return r0;
      return { ...r0, state: moveItems(r0.state, [{ ref: { kind: p.kind, id: p.id }, at: { x: row.at.x + off.x, y: row.at.y + off.y } }]) };
    })();
    store.edit(() => r.state);
    if (store.state() !== r.state) return; // refused while saving
    if (r.pick.kind === 'workflow') output.log(`${r.state.workflows[r.pick.id]!.name} created — it is saved only when you press Save`, 'ok');
    // a drop selects only the new item, so the Inspector is on it at once (it is named next)
    setSelection(withPicks(selRef.current, [r.pick]));
  }, [store, output, setSelection, ghostStore]);

  const unsavedKeys = store.unsaved();
  const marks = useMemo(() => unsavedMarks(store.base(), state, unsavedKeys), [store, state, unsavedKeys]);
  const view = useMemo<BoardView>(() => ({
    workflows: sel.workflows, picks: sel.picks,
    live: (wf) => statusOf(liveState, wf),
    problems: (wf) => store.problems(wf),
    failed: (key) => store.failures().has(key),
    unsaved: (key) => marks.has(key),
    ghosts,
  // tick: the problems and failures are read through the store, so a change of theirs is a new view
  }), [sel, liveState, store, tick, marks, ghosts]);

  const processors = useMemo(() => Object.values(state.processors).sort((a, b) => a.name.localeCompare(b.name)), [state.processors]);
  const stateNow = useCallback(() => store.state(), [store]);

  // what the chat's tools act on: the same store, history and picks as the user's own gestures
  const chatCtx = useMemo<ToolContext>(() => ({
    store, api, output, live, session, newId, ghosts: ghostStore,
    processors: () => Object.values(store.state().processors),
    caches: () => Object.values(store.state().caches),
    commands: {
      focus: (workflowId, stepIds) => boardFocus.current?.(workflowId, stepIds),
      setPicks: (picks) => setSelection(withPicks(selRef.current, picks)),
      picks: () => selRef.current.picks,
      newWorkflowAt: () => freeTriangleSpot(store.state()),
    },
  }), [store, api, output, live, session, ghostStore, setSelection]);

  return (
    <LiveStoreProvider value={live}>
      <OutputProvider store={output}>
        <div className="acto">
          <header className="topbar"><span className="brand">Act<span>o</span></span>
            <DiscardButton unsaved={store.unsaved().size} saving={store.saving()} onDiscard={discard} />
            <SaveButton unsaved={store.unsaved().size} saving={store.saving()} blocked={store.saveBlocked()} onSave={() => { void saveBoard(api, store, output, ghostStore); }} />
            <TakeStoredButton count={store.stale().length} saving={store.saving()} onTake={() => { void takeStored(api, store, output); }} />
            <button type="button" className="pbtn theme-toggle" onClick={toggleTheme}>{theme === 'dark' ? 'Light' : 'Dark'}</button>
          </header>
          <Shell
            storage={storage}
            marks={{ output: outputLines, chat: chatEntries }}
            inspectorNote={sel.picks.length > 1 ? `${sel.picks.length} selected`
              : sel.picks[0] ? (pickName(sel.picks[0], state, ghostStore) ?? '') : ''}
            toolbox={<ToolboxPanel processors={processors} />}
            board={!loaded
              ? <div className="board-wait">Loading the board…</div>
              : <Board state={state} view={view} onPick={onPick} onBoxPick={onBoxPick} onMove={onMove} onMoveGhosts={onMoveGhosts} onConnect={onConnect} onDropData={onDropData}
                  toolbar={toolbar} bar={barView} settled={loaded} focusRef={boardFocus} centerRef={boardCenter} stateNow={stateNow} onViewChange={onViewChange}
                  {...(saved ? { initialView: { x: saved.x, y: saved.y, zoom: saved.zoom } } : {})} />}
            inspector={<InspectorPanel store={store} selection={sel} ghosts={ghostStore} onPicks={onInspectorPicks} onCenter={(r) => boardCenter.current?.(r)} />}
            output={<OutputPanel />}
            chat={<ChatHost chat={chat} ctx={chatCtx} ready={loaded} storage={storage} {...(props.aiFetch ? { fetchFn: props.aiFetch } : {})} />}
          />
        </div>
      </OutputProvider>
    </LiveStoreProvider>
  );
}
