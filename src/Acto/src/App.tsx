import { useCallback, useEffect, useRef, useState } from 'react';
import { createApi, type StudioApi } from './api/client';
import { processorFromDto } from './api/toModel';
import { Board } from './board/Board';
import { loadBoard, type BoardWorkflow } from './board/loadBoard';
import type { Selection } from './board/selection';
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

export interface AppProps { api?: StudioApi; live?: LiveStore; storage?: Storage | null }

function browserStorage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function App(props: AppProps) {
  const [api] = useState<StudioApi>(() => props.api ?? createApi());
  const [live] = useState<LiveStore>(() => props.live ?? createLiveStore({ api, hub: signalRHub() }));
  const [storage] = useState<Storage | null>(() => (props.storage === undefined ? browserStorage() : props.storage));
  const [output] = useState<OutputStore>(() => createOutputStore(storage));
  const [saved] = useState<SavedView | null>(() => readView(storage));

  const [workflows, setWorkflows] = useState<BoardWorkflow[] | null>(null);
  const [processors, setProcessors] = useState<Processor[]>([]);
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
        output.log(`Board loaded: ${n} workflow${n === 1 ? '' : 's'}`, 'ok');
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
        setWorkflows(board.workflows);
      } catch (e) {
        if (!cancelled) output.log(`Could not load the board: ${message(e)}`, 'error');
      }
    })();
    return () => { cancelled = true; };
  }, [api, output]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api.listProcessors?.();
        if (cancelled || !r) return;
        if (r.ok) setProcessors(r.value.map(processorFromDto));
        else output.log('Could not list the processors', 'error');
      } catch (e) {
        if (!cancelled) output.log(`Could not list the processors: ${message(e)}`, 'error');
      }
    })();
    return () => { cancelled = true; };
  }, [api, output]);

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

  return (
    <LiveStoreProvider value={live}>
      <OutputProvider store={output}>
        <div className="acto">
          <header className="topbar"><span className="brand">Acto</span></header>
          <Shell
            storage={storage}
            toolbox={<ToolboxPanel processors={processors} />}
            board={workflows === null
              ? <div className="board-wait">Loading the board…</div>
              : <Board workflows={workflows} selection={selection} onSelect={onSelect}
                  {...(saved ? { initialView: { x: saved.x, y: saved.y, zoom: saved.zoom } } : {})}
                  onViewChange={onViewChange} />}
            inspector={<InspectorPanel workflows={workflows ?? []} selection={selection} />}
            output={<OutputPanel />}
            chat={<div className="ph"><span>Chat</span></div>}
          />
        </div>
      </OutputProvider>
    </LiveStoreProvider>
  );
}
