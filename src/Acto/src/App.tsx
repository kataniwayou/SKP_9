import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createApi, type StudioApi } from './api/client';
import { describeError } from './api/describeError';
import { cacheFromDto, processorFromDto } from './api/toModel';
import { Board, type BoardEdit } from './board/Board';
import { SelectionBar, type BarActions } from './board/SelectionBarView';
import { barOf } from './board/selectionBar';
import { loadBoard } from './board/loadBoard';
import { lastPick, livePicks, togglePick, type Pick } from './board/picks';
import { addCache, addStep, addWire, deleteParts, linkCache, moveFrame, moveMany, newWorkflowState, removeStepHere, removeWire, resizeFrame, swapProcessor, unlinkCache } from './design/state';
import { dropVerdict, type DropItem } from './board/dropTarget';
import { newId } from './design/ids';
import { saveWorkflow } from './design/saveWorkflow';
import { changedEntities, stepSharing } from './design/shared';
import type { ToolbarActions } from './board/nodes/boardContext';
import { createBoardStore, useBoard, type BoardStore } from './design/boardStore';
import { nudgeKey, pasteKey, undoRedoKey } from './design/keys';
import { FRAME_PAD } from './board/geometry';
import { copyClip, copyMessage, pasteClip, readClip, writeClip } from './operate/clipboard';
import { InspectorPanel } from './inspector/InspectorPanel';
import { createLiveStore, type LiveStore } from './live/liveClient';
import { LiveStoreProvider, useLive } from './live/LiveContext';
import { statusOf } from './live/liveState';
import { commitDelete, confirmText, prepareDelete, type DeletePlan } from './operate/deleteWorkflow';
import { runWorkflow } from './operate/runWorkflow';
import { watchTransitions } from './operate/transitions';
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

/** The selection bar for several picks; re-reads the run status when the live set changes. */
function PickBar({ picks, status, actions, pending, onConfirm, onCancel }: {
  picks: Pick[]; status: ToolbarActions['status']; actions: BarActions; pending: DeletePlan | null; onConfirm: () => void; onCancel: () => void;
}) {
  useLive((st) => st.running);
  useLive((st) => st.workflows);
  const bar = barOf(picks, (wf) => { const s = status(wf); return { run: s.run, unsaved: s.unsaved }; });
  if (!bar) return null;
  return <SelectionBar bar={bar} actions={actions} {...(pending && bar.kind === 'workflows' ? { confirm: { text: confirmText(pending), onConfirm, onCancel } } : {})} />;
}

export function App(props: AppProps) {
  const [api] = useState<StudioApi>(() => props.api ?? createApi());
  const [live] = useState<LiveStore>(() => props.live ?? createLiveStore({ api, hub: signalRHub() }));
  const [storage] = useState<Storage | null>(() => (props.storage === undefined ? browserStorage() : props.storage));
  const [output] = useState<OutputStore>(() => createOutputStore(storage));
  const [session] = useState<Storage | null>(() => (props.session === undefined ? browserSession() : props.session));
  const [store] = useState<BoardStore>(() => createBoardStore(output, session));
  const [saved] = useState<SavedView | null>(() => readView(storage));

  const [loaded, setLoaded] = useState(false);
  const workflows = useBoard(store);
  const [processors, setProcessors] = useState<Processor[]>([]);
  const [caches, setCaches] = useState<Cache[]>([]);
  const processorsRef = useRef<Processor[]>([]);
  const [picks, setPicks] = useState<Pick[]>(() => (saved?.selection ? [saved.selection] : []));
  const [pending, setPending] = useState<DeletePlan | null>(null);
  const pendingRef = useRef<DeletePlan | null>(null);
  const removeToken = useRef(0);
  const viewport = useRef<{ x: number; y: number; zoom: number } | null>(saved && { x: saved.x, y: saved.y, zoom: saved.zoom });

  useEffect(() => { live.start(); return () => live.stop(); }, [live]);
  useEffect(() => watchTransitions(live, output, (id) => store.entry(id)?.history.present.fields.name ?? null), [live, output, store]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        store.begin(processorsRef.current);
        const board = await loadBoard(api, 4, (bw) => { if (!cancelled) store.arrive(bw); });
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
        store.finish(board);
        setLoaded(true);
      } catch (e) {
        if (cancelled) return;
        output.log(`Could not load the board: ${message(e)}`, 'error');
        store.finish({ listed: false, workflows: [], failures: [] });
        setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [api, output, store]);

  const listProcessors = useCallback(async (cancelled: () => boolean = () => false) => {
    try {
      const r = await api.listProcessors?.();
      if (cancelled() || !r) return;
      if (r.ok) {
        const ps = r.value.map(processorFromDto);
        processorsRef.current = ps;
        setProcessors(ps);
        store.setProcessors(ps);
      }
      else output.log(`Could not list the processors: ${describeError(r.error)}`, 'error');
    } catch (e) {
      if (!cancelled()) output.log(`Could not list the processors: ${message(e)}`, 'error');
    }
  }, [api, output, store]);
  useEffect(() => {
    let cancelled = false;
    void listProcessors(() => cancelled);
    return () => { cancelled = true; };
  }, [listProcessors]);
  /** A save that changed a processor changed what the toolbox lists too. */
  const save = useCallback(async (id: string) => {
    const e = store.entry(id);
    const procChanged = e !== null && [...changedEntities(e.base, e.history.present)].some((k) => k.startsWith('processor:'));
    if (await saveWorkflow(api, store, output, id) === 'saved' && procChanged) await listProcessors();
  }, [api, store, output, listProcessors]);

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
  // a nudge session: a press and the repeats of its held key; a new press or a pick change starts the next one
  const nudgeSeq = useRef(0);
  const persist = useCallback((ps: Pick[]) => {
    const v = viewport.current;
    if (v) writeView(storage, { ...v, selection: lastPick(ps) });
  }, [storage]);
  const setAllPicks = useCallback((ps: Pick[]) => {
    picksRef.current = ps; setPicks(ps); persist(ps);
    nudgeSeq.current++;
    // a pick change drops a pending delete confirm (and a still-running preparation) silently
    removeToken.current++; pendingRef.current = null; setPending(null);
  }, [persist]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!pasteKey(e)) return;
      e.preventDefault();
      const last = lastPick(picksRef.current);
      const target = last ? store.entry(last.workflowId) : null;
      if (!last || !target) { output.log('Select a workflow to paste into', 'warn'); return; }
      const clip = readClip(session);
      if (!clip) { output.log('Nothing copied yet', 'warn'); return; }
      let pasted: string[] = [];
      store.edit(last.workflowId, (s) => {
        const r = pasteClip(s, clip, last.kind === 'step' ? last.stepId : null, newId);
        pasted = r.pasted;
        return r.state;
      });
      if (pasted.length === 0) return;
      writeClip(session, { ...clip, pasted: clip.pasted + 1 });
      setAllPicks(pasted.map((stepId) => ({ kind: 'step' as const, workflowId: last.workflowId, stepId })));
      output.log(`Pasted ${pasted.length} step${pasted.length === 1 ? '' : 's'} into ${target.history.present.fields.name}`, 'ok');
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [store, output, session, setAllPicks]);
  // arrows nudge picked steps (or a picked frame) by 8 px: one history step per workflow while a key repeats
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const d = nudgeKey(e);
      if (!d) return;
      if (!e.repeat) nudgeSeq.current++;
      const seq = nudgeSeq.current;
      const byWf = new Map<string, { steps: string[]; frame: boolean }>();
      for (const p of picksRef.current) {
        if (p.kind !== 'step' && p.kind !== 'workflow') continue;
        let g = byWf.get(p.workflowId);
        if (!g) { g = { steps: [], frame: false }; byWf.set(p.workflowId, g); }
        if (p.kind === 'step') g.steps.push(p.stepId); else g.frame = true;
      }
      if (byWf.size === 0) return;
      e.preventDefault();
      for (const [wf, g] of byWf) {
        // the first press says the workflow is saving; its repeats need not say it again
        if (e.repeat && store.entry(wf)?.saving) continue;
        store.edit(wf, (s) => moveMany(s, {
          steps: g.steps.flatMap((id) => {
            const st = s.steps[id];
            return st ? [{ id, at: { x: Math.max(FRAME_PAD, st.at.x + d.dx), y: Math.max(FRAME_PAD, st.at.y + d.dy) } }] : [];
          }),
          ...(g.frame ? { frame: { x: s.frame.x + d.dx, y: s.frame.y + d.dy } } : {}),
        }), `nudge:${wf}:${seq}`);
      }
    };
    // capture, so it runs before the board stops the arrow reaching React Flow's own node movement
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [store]);
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

  const copyPicks = useCallback((extra?: { wf: string; step: string }) => {
    const ids = new Map<string, Set<string>>();
    const add = (wf: string, step: string) => (ids.get(wf) ?? ids.set(wf, new Set()).get(wf)!).add(step);
    if (extra) add(extra.wf, extra.step);
    for (const p of picksRef.current) if (p.kind === 'step') add(p.workflowId, p.stepId);
    const parts = [...ids].flatMap(([id, set]) => {
      const state = store.entry(id)?.history.present;
      return state ? [{ state, stepIds: [...set] }] : [];
    });
    const clip = copyClip(parts);
    if (!clip) { output.log('Nothing to copy — pick steps', 'warn'); return; }
    writeClip(session, clip);
    output.log(copyMessage(clip), 'ok');
  }, [store, output, session]);

  const toolbar = useMemo<ToolbarActions>(() => ({
    save: (wf) => { void save(wf); },
    start: (wf) => { void runWorkflow(api, store, output, live, wf, 'start'); },
    stop: (wf) => { void runWorkflow(api, store, output, live, wf, 'stop'); },
    copy: (wf, step) => copyPicks({ wf, step }),
    deleteStep: (wf, step) => {
      const { shared, others } = stepSharing(store.boards(), wf);
      store.editOrRefuse(wf, (s) => removeStepHere(s, step, shared, others));
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
    remove: (wfs) => {
      const token = ++removeToken.current;
      void prepareDelete(api, store, output, wfs).then((plan) => {
        if (token !== removeToken.current) return;
        pendingRef.current = plan; setPending(plan);
      });
    },
    confirmRemove: () => {
      const plan = pendingRef.current;
      if (!plan) return;
      pendingRef.current = null; setPending(null);
      const token = ++removeToken.current;
      void commitDelete(api, store, output, plan).then((gone) => {
        if (gone.length === 0 || token !== removeToken.current) return;
        setAllPicks(picksRef.current.filter((p) => !gone.includes(p.workflowId)));
      });
    },
    cancelRemove: () => {
      if (!pendingRef.current) return;
      removeToken.current++; pendingRef.current = null; setPending(null);
      output.log('Delete cancelled — nothing was sent');
    },
    pendingRemove: () => pending,
    status: (wf) => {
      const e = store.entry(wf);
      return { unsaved: e?.unsaved ?? false, problems: e?.problems ?? 0, saving: e?.saving ?? false, run: statusOf(live.getState(), wf) };
    },
  }), [api, store, output, live, onSelect, setAllPicks, pending, copyPicks, save]);

  const barActions = useMemo<BarActions>(() => ({
    copy: () => copyPicks(),
    deleteParts: () => {
      const ps = picksRef.current;
      const last = lastPick(ps);
      const per = new Map<string, { steps: string[]; wires: [string, string][]; caches: string[] }>();
      for (const p of ps) {
        if (p.kind === 'workflow') continue;
        const e = per.get(p.workflowId) ?? { steps: [], wires: [], caches: [] };
        per.set(p.workflowId, e);
        if (p.kind === 'step') e.steps.push(p.stepId);
        else if (p.kind === 'wire') { const i = p.wireId.indexOf('>'); e.wires.push([p.wireId.slice(0, i), p.wireId.slice(i + 1)]); }
        else e.caches.push(p.cacheId);
      }
      // one edit (one undo step) per workflow
      for (const [wf, e] of per) {
        const { shared, others } = stepSharing(store.boards(), wf);
        let refused: string[] = [];
        store.editOrRefuse(wf, (st) => {
          const out = deleteParts(st, e.steps, e.wires, shared, others);
          refused = out.refused;
          return { state: e.caches.reduce(unlinkCache, out.state) };
        });
        // a refused step stays; the rest of the pick still goes
        for (const why of refused) output.log(why, 'warn');
      }
      if (last) setAllPicks([{ kind: 'workflow', workflowId: last.workflowId }]);
    },
    start: (ids: string[]) => { for (const id of ids) void runWorkflow(api, store, output, live, id, 'start'); },
    stop: (ids: string[]) => { for (const id of ids) void runWorkflow(api, store, output, live, id, 'stop'); },
    save: (ids: string[]) => { void (async () => { for (const id of ids) await save(id); })(); },
    deleteWorkflows: () => toolbar.remove([...new Set(picksRef.current.filter((p) => p.kind === 'workflow').map((p) => p.workflowId))]),
  }), [api, store, output, live, toolbar, copyPicks, setAllPicks, save]);

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
            board={!loaded && workflows.length === 0
              ? <div className="board-wait">Loading the board…</div>
              : <Board workflows={workflows} picks={picks} onPick={onPick} settled={loaded}
                  {...(saved ? { initialView: { x: saved.x, y: saved.y, zoom: saved.zoom } } : {})}
                  onViewChange={onViewChange} onEdit={onEdit} toolbar={toolbar} onDropItem={onDropItem}
                  bar={<PickBar picks={picks} status={toolbar.status} actions={barActions} pending={pending} onConfirm={toolbar.confirmRemove} onCancel={toolbar.cancelRemove} />} />}
            inspector={<InspectorPanel workflows={workflows} picks={picks} store={store} />}
            output={<OutputPanel />}
            chat={<div className="ph"><span>Chat</span></div>}
          />
        </div>
      </OutputProvider>
    </LiveStoreProvider>
  );
}
