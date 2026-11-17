import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createApi, type StudioApi } from './api/client';
import { describeError } from './api/describeError';
import { processorFromDto } from './api/toModel';
import { Board, type BoardEdit } from './board/Board';
import { loadBoard } from './board/loadBoard';
import type { Selection } from './board/selection';
import { addWire, moveFrame, moveStep, removeStep, removeWire, resizeFrame } from './design/state';
import { saveWorkflow } from './design/saveWorkflow';
import type { ToolbarActions } from './board/nodes/boardContext';
import { createBoardStore, useBoard, type BoardStore } from './design/boardStore';
import { InspectorPanel } from './inspector/InspectorPanel';
import { createLiveStore, type LiveStore } from './live/liveClient';
import { LiveStoreProvider } from './live/LiveContext';
import { signalRHub } from './live/signalrHub';
import type { Processor } from './model/graph';
import { OutputPanel } from './output/OutputPanel';
import { createOutputStore, OutputProvider, type OutputStore } from './output/outputStore';
import { keepExistingSelection, readView, writeView, type SavedView } from './session/view';
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
  const processorsRef = useRef<Processor[]>([]);
  const [selection, setSelection] = useState<Selection | null>(saved?.selection ?? null);
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
        setSelection((s) => keepExistingSelection(s, board.workflows));
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

  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const persist = useCallback((sel: Selection | null) => {
    const v = viewport.current;
    if (v) writeView(storage, { ...v, selection: sel });
  }, [storage]);
  const onSelect = useCallback((s: Selection | null) => { setSelection(s); persist(s); }, [persist]);
  const onViewChange = useCallback((v: { x: number; y: number; zoom: number }) => {
    viewport.current = v;
    persist(selectionRef.current);
  }, [persist]);

  const onEdit = useMemo<BoardEdit>(() => ({
    moveStep: (wf, step, at) => store.edit(wf, (s) => moveStep(s, step, at)),
    moveFrame: (wf, at) => store.edit(wf, (s) => moveFrame(s, at)),
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
    status: (wf) => {
      const e = store.entry(wf);
      return { unsaved: e?.unsaved ?? false, problems: e?.problems ?? 0, saving: e?.saving ?? false };
    },
  }), [api, store, output, onSelect]);

  return (
    <LiveStoreProvider value={live}>
      <OutputProvider store={output}>
        <div className="acto">
          <header className="topbar"><span className="brand">Acto</span></header>
          <Shell
            storage={storage}
            toolbox={<ToolboxPanel processors={processors} />}
            board={!loaded
              ? <div className="board-wait">Loading the board…</div>
              : <Board workflows={workflows} selection={selection} onSelect={onSelect}
                  {...(saved ? { initialView: { x: saved.x, y: saved.y, zoom: saved.zoom } } : {})}
                  onViewChange={onViewChange} onEdit={onEdit} toolbar={toolbar} />}
            inspector={<InspectorPanel workflows={workflows} selection={selection} />}
            output={<OutputPanel />}
            chat={<div className="ph"><span>Chat</span></div>}
          />
        </div>
      </OutputProvider>
    </LiveStoreProvider>
  );
}
