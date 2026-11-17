import { useSyncExternalStore } from 'react';
import type { BoardLoad, BoardWorkflow } from '../board/loadBoard';
import type { Id, Processor } from '../model/graph';
import type { OutputStore } from '../output/outputStore';
import { readDrafts, writeDrafts, type Drafts } from './drafts';
import { commit, historyOf, redo, undo, type History } from './history';
import { applyStored } from './request';
import { boardWorkflowOf, sameState, stateOf, type WorkflowState } from './state';

export interface BoardEntry { base: WorkflowState | null; history: History; unsaved: boolean }

export interface BoardStore {
  load(board: BoardLoad, processors: Processor[]): void;
  setProcessors(processors: Processor[]): void;
  boards(): BoardWorkflow[];
  entry(id: Id): BoardEntry | null;
  edit(id: Id, fn: (s: WorkflowState) => WorkflowState, merge?: string): void;
  editOrRefuse(id: Id, fn: (s: WorkflowState) => { state: WorkflowState } | { refused: string }): void;
  undo(id: Id): void;
  redo(id: Id): void;
  addWorkflow(state: WorkflowState): void;
  replace(id: Id, bw: BoardWorkflow): void;
  subscribe(fn: () => void): () => void;
}

interface Rec {
  baseBw: BoardWorkflow | null; base: WorkflowState | null; history: History;
  view: BoardEntry; bwFor: WorkflowState | null; bw: BoardWorkflow | null;
}

export function createBoardStore(output: OutputStore, session: Storage | null): BoardStore {
  const recs = new Map<Id, Rec>();
  // drafts for workflows this load did not bring back: left in the session untouched until they load
  let kept: Drafts = {};
  let processors = new Map<Id, Processor>();
  let procVersion = 0;
  let bwProcVersion = 0;
  let cached: BoardWorkflow[] | null = null;
  const subs = new Set<() => void>();

  const viewOf = (base: WorkflowState | null, history: History): BoardEntry => ({
    base, history, unsaved: !base || !sameState(history.present, base),
  });
  const make = (baseBw: BoardWorkflow | null, history?: History): Rec => {
    const base = baseBw ? stateOf(baseBw) : null;
    const h = history ?? historyOf(base!);
    return { baseBw, base, history: h, view: viewOf(base, h), bwFor: null, bw: null };
  };
  const withHistory = (r: Rec, h: History): Rec => ({ ...r, history: h, view: viewOf(r.base, h), bwFor: null, bw: null });
  const notify = () => { cached = null; subs.forEach((f) => f()); };
  const changed = () => {
    const drafts: Drafts = { ...kept };
    for (const [id, r] of recs) {
      if (r.view.unsaved) drafts[id] = { updatedAt: r.baseBw ? r.baseBw.graph.workflow.updatedAt : null, history: r.history };
    }
    writeDrafts(session, drafts);
    notify();
  };
  const setHistory = (id: Id, r: Rec, h: History) => {
    if (h === r.history) return;
    recs.set(id, withHistory(r, h));
    changed();
  };

  return {
    load(board, procs) {
      processors = new Map(procs.map((p) => [p.id, p]));
      procVersion++;
      recs.clear();
      const drafts = readDrafts(session);
      for (const bw of board.workflows) {
        const id = bw.graph.workflow.id;
        const name = bw.graph.workflow.name;
        const rec = make(bw);
        const draft = drafts[id];
        if (draft && draft.updatedAt === bw.graph.workflow.updatedAt) {
          recs.set(id, withHistory(rec, draft.history));
          continue;
        }
        if (draft) output.log(`${name}: unsaved work from before the refresh was dropped because the workflow changed`, 'warn');
        if (bw.graph.design != null) {
          const applied = applyStored(rec.base!, bw.graph.design, bw.graph.layout);
          recs.set(id, withHistory(rec, historyOf(applied)));
          if (!sameState(applied, rec.base!)) output.log(`${name}: loaded unsaved work from a save that failed`, 'warn');
          continue;
        }
        recs.set(id, rec);
      }
      // a workflow created in the designer and not yet saved is not on the server to match against
      kept = {};
      const loaded = new Set(board.workflows.map((w) => w.graph.workflow.id));
      for (const [id, d] of Object.entries(drafts)) {
        if (loaded.has(id)) continue;
        if (d.history.present.isNew) recs.set(id, make(null, d.history));
        else kept[id] = d;
      }
      changed();
    },
    setProcessors(ps) {
      processors = new Map(ps.map((p) => [p.id, p]));
      procVersion++;
      notify();
    },
    boards() {
      if (cached) return cached;
      if (bwProcVersion !== procVersion) {
        for (const r of recs.values()) { r.bw = null; r.bwFor = null; }
        bwProcVersion = procVersion;
      }
      cached = [...recs.values()].map((r) => {
        if (!r.bw || r.bwFor !== r.history.present) {
          r.bw = boardWorkflowOf(r.history.present, r.baseBw, processors);
          r.bwFor = r.history.present;
        }
        return r.bw;
      });
      return cached;
    },
    entry: (id) => recs.get(id)?.view ?? null,
    edit(id, fn, merge) {
      const r = recs.get(id);
      if (r) setHistory(id, r, commit(r.history, fn(r.history.present), merge));
    },
    editOrRefuse(id, fn) {
      const r = recs.get(id);
      if (!r) return;
      const res = fn(r.history.present);
      if ('refused' in res) output.log(res.refused, 'warn');
      else setHistory(id, r, commit(r.history, res.state));
    },
    undo(id) { const r = recs.get(id); if (r) setHistory(id, r, undo(r.history)); },
    redo(id) { const r = recs.get(id); if (r) setHistory(id, r, redo(r.history)); },
    addWorkflow(state) {
      recs.set(state.workflowId, make(null, historyOf(state)));
      changed();
    },
    replace(id, bw) {
      recs.set(id, make(bw));
      changed();
    },
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
  };
}

export function useBoard(store: BoardStore): BoardWorkflow[] {
  return useSyncExternalStore(store.subscribe, store.boards);
}

export function useEntry(store: BoardStore, id: Id): BoardEntry | null {
  return useSyncExternalStore(store.subscribe, () => store.entry(id));
}
