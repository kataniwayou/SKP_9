import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createApi, type StudioApi } from './api/client';
import { describeError } from './api/describeError';
import { cacheFromDto, processorFromDto } from './api/toModel';
import { Board, type BoardEdit } from './board/Board';
import { loadBoard } from './board/loadBoard';
import { lastPick, livePicks, togglePick, type Pick } from './board/picks';
import { addCache, addStep, addWire, linkCache, moveFrame, moveMany, newWorkflowState, removeStep, removeWire, resizeFrame, swapProcessor, unlinkCache } from './design/state';
import { dropVerdict, type DropItem } from './board/dropTarget';
import { newId } from './design/ids';
import { saveWorkflow } from './design/saveWorkflow';
import type { ToolbarActions } from './board/nodes/boardContext';
import { createBoardStore, useBoard, type BoardStore } from './design/boardStore';
import { undoRedoKey } from './design/keys';
import { InspectorPanel } from './inspector/InspectorPanel';
import { createLiveStore, type LiveStore } from './live/liveClient';
import { LiveStoreProvider } from './live/LiveContext';
import { signalRHub } from './live/signalrHub';
import type { Cache, Processor } from './model/graph';
import { OutputPanel } from './output/OutputPanel';
import { createOutputStore, OutputProvider, type OutputStore } from './output/outputStore';
import { readView, writeView, type SavedView } from './session/view';
import { Shell } from './shell/Shell';
import { ToolboxPanel } from './toolbox/ToolboxPanel';
import './app.css';

export interface AppProps { api?: StudioApi; live?: LiveStore; storage?: Storage | null; session?: Storage | null }

function browserStorage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

function browserSession(): Storage | null {
  try { return window.sessionStorage; } catch { return null; }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function App(props: AppProps) {
  const [api] = useState<StudioApi>(() => props.api ?? createApi());
  const [live] = useState<LiveStore>(() => props.live ?? createLiveStore({ api, hub: signalRHub() }));
  const [storage] = useState<Storage | null>(() => (props.storage === undefined ? browserStorage() : props.storage));
  const [output] = useState<OutputStore>(() => createOutputStore(storage));
  const [store] = useState<BoardStore>(() => createBoardStore(output, props.session === undefined ? browserSession() : props.session));
  const [saved] = useState<SavedView | null>(() => readView(storage));

  const [loaded, setLoaded] = useState(false);
  const workflows = useBoard(store);
  const [processors, setProcessors] = useState<Processor[]>([]);
  const [caches, setCaches] = useState<Cache[]>([]);
  const processorsRef = useRef<Processor[]>([]);
  const [picks, setPicks] = useState<Pick[]>(() => (saved?.selection ? [saved.selection] : []));
  const viewport = useRef<{ x: number; y: number; zoom: number } | null>(saved && { x: saved.x, y: saved.y, zoom: saved.zoom });

  useEffect(() => { live.start(); return () => live.stop(); }, [live]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const board = await loadBoard(api);
        if (cancelled) return;
        const n = board.workflows.length;
        if (board.listed) output.log(`Board loaded: ${n} workflow${n === 1 ? '' : 's'}`, 'ok');
        for (const f of board.failures) output.log(`Could not load ${f.name}: ${f.detail}`, 'error');
        for (const w of board.workflows) {
          const name = (id: string) => w.graph.steps.get(id)?.name ?? id;
          const { stops, starts } = w.entryDiff;
          const parts = [
            stops.length > 0 ? `${stops.map(name).join(', ')} stops being a first step` : '',
            starts.length > 0 ? `${starts.map(name).join(', ')} starts running` : '',
          ].filter(Boolean);
          if (parts.length > 0) output.log(`${w.graph.workflow.name}: on Save, ${parts.join('; ')}`, 'warn');
        }
        setPicks((ps) => livePicks(ps, board.workflows));
        store.load(board, processorsRef.current);
        setLoaded(true);
      } catch (e) {
        if (cancelled) return;
        output.log(`Could not load the board: ${message(e)}`, 'error');
        store.load({ listed: false, workflows: [], failures: [] }, processorsRef.current);
        setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [api, output, store]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api.listProcessors?.();
        if (cancelled || !r) return;
        if (r.ok) {
          const ps = r.value.map(processorFromDto);
          processorsRef.current = ps;
          setProcessors(ps);
          store.setProcessors(ps);
        }
        else output.log(`Could not list the processors: ${describeError(r.error)}`, 'error');
      } catch (e) {
        if (!cancelled) output.log(`Could not list the processors: ${message(e)}`, 'error');
      }
    })();
    return () => { cancelled = true; };
  }, [api, output, store]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api.listCaches?.();
        if (cancelled || !r) return;
        if (r.ok) setCaches(r.value.map(cacheFromDto));
        else output.log(`Could not list the caches: ${describeError(r.error)}`, 'error');
      } catch (e) {
        if (!cancelled) output.log(`Could not list the caches: ${message(e)}`, 'error');
      }
    })();
    return () => { cancelled = true; };
  }, [api, output]);

  // a picked thing that disappears (workflow deleted, step undone away) leaves the picks
  useEffect(() => {
    if (!loaded) return;
    setPicks((ps) => { const l = livePicks(ps, workflows); return l.length === ps.length ? ps : l; });
  }, [loaded, workflows]);

  const selWf = lastPick(picks)?.workflowId ?? null;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const act = undoRedoKey(e);
      if (!act || selWf === null) return;
      e.preventDefault();
      if (act === 'undo') store.undo(selWf); else store.redo(selWf);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [store, selWf]);

  const picksRef = useRef(picks);
  picksRef.current = picks;
  const persist = useCallback((ps: Pick[]) => {
    const v = viewport.current;
    if (v) writeView(storage, { ...v, selection: lastPick(ps) });
  }, [storage]);
  const setAllPicks = useCallback((ps: Pick[]) => { picksRef.current = ps; setPicks(ps); persist(ps); }, [persist]);
  const onPick = useCallback((p: Pick | null, additive: boolean) => {
    if (p === null) { if (!additive) setAllPicks([]); return; }
    setAllPicks(additive ? togglePick(picksRef.current, p) : [p]);
  }, [setAllPicks]);
  const onSelect = useCallback((s: Pick) => setAllPicks([s]), [setAllPicks]);
  const onViewChange = useCallback((v: { x: number; y: number; zoom: number }) => {
    viewport.current = v;
    persist(picksRef.current);
  }, [persist]);

  const onEdit = useMemo<BoardEdit>(() => ({
    moveMany: (wf, m) => store.edit(wf, (s) => moveMany(s, m)),
    resizeFrame: (wf, size, at) => store.edit(wf, (s) => resizeFrame(at ? moveFrame(s, at) : s, size)),
    connect: (fromWf, from, toWf, to) => {
      if (to === null || toWf === null) { output.log('A wire must end on a step', 'warn'); return; }
      if (toWf !== fromWf) { output.log('A wire stays inside its workflow', 'warn'); return; }
      store.editOrRefuse(fromWf, (s) => addWire(s, from, to));
    },
  }), [store, output]);

  const toolbar = useMemo<ToolbarActions>(() => ({
    save: (wf) => { void saveWorkflow(api, store, output, wf); },
    deleteStep: (wf, step) => {
      store.editOrRefuse(wf, (s) => ({ state: removeStep(s, step) }));
      onSelect({ kind: 'workflow', workflowId: wf });
    },
    deleteWire: (wf, wireId) => {
      const i = wireId.indexOf('>');
      store.editOrRefuse(wf, (s) => ({ state: removeWire(s, wireId.slice(0, i), wireId.slice(i + 1)) }));
      onSelect({ kind: 'workflow', workflowId: wf });
    },
    deleteCache: (wf, cacheId) => {
      store.editOrRefuse(wf, (s) => ({ state: unlinkCache(s, cacheId) }));
      onSelect({ kind: 'workflow', workflowId: wf });
    },
    status: (wf) => {
      const e = store.entry(wf);
      return { unsaved: e?.unsaved ?? false, problems: e?.problems ?? 0, saving: e?.saving ?? false };
    },
  }), [api, store, output, onSelect]);

  const workflowsRef = useRef(workflows);
  workflowsRef.current = workflows;
  const onDropItem = useCallback((item: DropItem, at: { x: number; y: number }) => {
    const boards = workflowsRef.current;
    const v = dropVerdict(item, at, boards);
    if ('refused' in v) { output.log(v.refused, 'warn'); return; }
    switch (v.do) {
      case 'newWorkflow': {
        const taken = new Set(boards.map((b) => b.graph.workflow.name));
        let n = 1;
        while (taken.has(`new-workflow-${n}`)) n++;
        const name = `new-workflow-${n}`;
        const state = newWorkflowState(newId(), name, v.at);
        store.addWorkflow(state);
        onSelect({ kind: 'workflow', workflowId: state.workflowId });
        output.log(`${name} created — it is saved only when you press Save`, 'ok');
        return;
      }
      case 'addStep': {
        const p = processorsRef.current.find((x) => x.id === (item as { processorId: string }).processorId);
        if (!p) { output.log('That processor is no longer listed', 'warn'); return; }
        store.edit(v.workflowId, (s) => addStep(s, p, v.at, newId()));
        return;
      }
      case 'swap': {
        const p = processorsRef.current.find((x) => x.id === (item as { processorId: string }).processorId);
        if (!p) { output.log('That processor is no longer listed', 'warn'); return; }
        store.edit(v.workflowId, (s) => swapProcessor(s, v.stepId, p));
        return;
      }
      case 'newCache': {
        const taken = new Set(boards.flatMap((b) => [...b.graph.caches.values()].map((c) => c.name)));
        let n = 1;
        while (taken.has(`new-cache-${n}`)) n++;
        store.edit(v.workflowId, (s) => addCache(s, { id: newId(), name: `new-cache-${n}`, version: '1.0.0', description: null, root: '', items: '{}', isNew: true }));
        return;
      }
      case 'linkCache': {
        const c = caches.find((x) => x.id === v.cacheId);
        if (!c) { output.log('That cache is no longer listed', 'warn'); return; }
        store.edit(v.workflowId, (s) => linkCache(s, c));
        return;
      }
    }
  }, [store, output, onSelect, caches]);

  return (
    <LiveStoreProvider value={live}>
      <OutputProvider store={output}>
        <div className="acto">
          <header className="topbar"><span className="brand">Acto</span>
          </header>
          <Shell
            storage={storage}
            toolbox={<ToolboxPanel processors={processors} caches={caches} />}
            board={!loaded
              ? <div className="board-wait">Loading the board…</div>
              : <Board workflows={workflows} picks={picks} onPick={onPick}
                  {...(saved ? { initialView: { x: saved.x, y: saved.y, zoom: saved.zoom } } : {})}
                  onViewChange={onViewChange} onEdit={onEdit} toolbar={toolbar} onDropItem={onDropItem} />}
            inspector={<InspectorPanel workflows={workflows} picks={picks} store={store} />}
            output={<OutputPanel />}
            chat={<div className="ph"><span>Chat</span></div>}
          />
        </div>
      </OutputProvider>
    </LiveStoreProvider>
  );
}
