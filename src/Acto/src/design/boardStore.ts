import { useSyncExternalStore } from 'react';
import type { BoardLoad, BoardWorkflow } from '../board/loadBoard';
import type { Id, Processor, Schema } from '../model/graph';
import type { OutputStore } from '../output/outputStore';
import { readDrafts, writeDrafts, type Drafts } from './drafts';
import { commit, historyOf, redo, undo, type History } from './history';
import { applyStored } from './request';
import { boardWorkflowOf, sameState, stateOf, type WorkflowState } from './state';

export interface BoardEntry { base: WorkflowState | null; history: History; unsaved: boolean;
  /** The stored layout the workflow had when loaded (opaque JSON), to spot a change made elsewhere. */
  layout: unknown;
  /** Validation problems the last save found; 0 when valid or never saved. */
  problems: number;
  /** True while a save is in flight: a second save is refused and edits wait. */
  saving: boolean }

export interface BoardStore {
  load(board: BoardLoad, processors: Processor[]): void;
  setProcessors(processors: Processor[]): void;
  boards(): BoardWorkflow[];
  /** A processor as stored (without any edit of the designs), what a processor edit is diffed against. */
  processor(id: Id, workflowId: Id): Processor | null;
  /** A schema as stored in the workflow's loaded graph. */
  schema(id: Id, workflowId: Id): Schema | null;
  entry(id: Id): BoardEntry | null;
  edit(id: Id, fn: (s: WorkflowState) => WorkflowState, merge?: string): void;
  editOrRefuse(id: Id, fn: (s: WorkflowState) => { state: WorkflowState } | { refused: string }): void;
  undo(id: Id): void;
  redo(id: Id): void;
  addWorkflow(state: WorkflowState): void;
  replace(id: Id, bw: BoardWorkflow): void;
  /** The workflow is gone (deleted, or never saved and discarded): its entry and its draft with it. */
  remove(id: Id): void;
  setProblems(id: Id, n: number): void;
  setSaving(id: Id, saving: boolean): void;
  /** The save was applied but the re-read failed: the present state becomes the base (the layout stays as last set). */
  adoptPresent(id: Id): void;
  /** BaseAPI stored this layout (it does on every save it reads, applied or not): what the next save compares against. */
  setLayout(id: Id, layout: unknown): void;
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
  let draftsFailed = false;
  const subs = new Set<() => void>();

  const viewOf = (base: WorkflowState | null, history: History, layout: unknown = null, problems = 0, saving = false): BoardEntry => ({
    base, history, unsaved: !base || !sameState(history.present, base), layout, problems, saving,
  });
  const make = (baseBw: BoardWorkflow | null, history?: History): Rec => {
    const base = baseBw ? stateOf(baseBw) : null;
    const h = history ?? historyOf(base!);
    return { baseBw, base, history: h, view: viewOf(base, h, baseBw?.graph.layout ?? null), bwFor: null, bw: null };
  };
  const withHistory = (r: Rec, h: History): Rec => ({ ...r, history: h, view: viewOf(r.base, h, r.view.layout, r.view.problems, r.view.saving), bwFor: null, bw: null });
  const notify = () => { cached = null; subs.forEach((f) => f()); };
  const changed = () => {
    const drafts: Drafts = { ...kept };
    for (const [id, r] of recs) {
      if (r.view.unsaved) drafts[id] = { updatedAt: r.baseBw ? r.baseBw.graph.workflow.updatedAt : null, history: r.history };
    }
    const failed = writeDrafts(session, drafts);
    if (failed !== null && !draftsFailed) {
      draftsFailed = true;
      output.log(`Unsaved work is no longer kept across refresh: ${failed}`, 'warn');
    }
    notify();
  };
  const locked = (r: Rec): boolean => {
    if (!r.view.saving) return false;
    output.log(`${r.history.present.fields.name} is saving — wait for it to finish`, 'warn');
    return true;
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
          const applied = applyStored(rec.base!, bw.graph.design, bw.graph.layout, bw.designCaches);
          if (sameState(applied, rec.base!)) { recs.set(id, rec); continue; }
          // one step on from the saved workflow, so Undo goes back to it
          recs.set(id, withHistory(rec, commit(rec.history, applied)));
          output.log(`${name}: loaded unsaved work from a save that failed`, 'warn');
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
    processor: (id, wf) => processors.get(id) ?? recs.get(wf)?.baseBw?.graph.processors.get(id) ?? null,
    schema: (id, wf) => recs.get(wf)?.baseBw?.graph.schemas.get(id) ?? null,
    entry: (id) => recs.get(id)?.view ?? null,
    edit(id, fn, merge) {
      const r = recs.get(id);
      if (r && !locked(r)) setHistory(id, r, commit(r.history, fn(r.history.present), merge));
    },
    editOrRefuse(id, fn) {
      const r = recs.get(id);
      if (!r || locked(r)) return;
      const res = fn(r.history.present);
      if ('refused' in res) output.log(res.refused, 'warn');
      else setHistory(id, r, commit(r.history, res.state));
    },
    undo(id) { const r = recs.get(id); if (r && !locked(r)) setHistory(id, r, undo(r.history)); },
    redo(id) { const r = recs.get(id); if (r && !locked(r)) setHistory(id, r, redo(r.history)); },
    addWorkflow(state) {
      recs.set(state.workflowId, make(null, historyOf(state)));
      changed();
    },
    remove(id) {
      if (!recs.delete(id) && !(id in kept)) return;
      delete kept[id];
      changed();
    },
    setSaving(id, saving) {
      const r = recs.get(id);
      if (!r || r.view.saving === saving) return;
      recs.set(id, { ...r, view: { ...r.view, saving } });
      notify();
    },
    adoptPresent(id) {
      const r = recs.get(id);
      if (!r) return;
      const next = make(boardWorkflowOf(r.history.present, r.baseBw, processors));
      next.view = { ...next.view, saving: r.view.saving, layout: r.view.layout };
      recs.set(id, next);
      changed();
    },
    setLayout(id, layout) {
      const r = recs.get(id);
      if (!r) return;
      recs.set(id, { ...r, view: { ...r.view, layout } });
      notify();
    },
    replace(id, bw) {
      const next = make(bw);
      next.view = { ...next.view, saving: recs.get(id)?.view.saving ?? false };
      recs.set(id, next);
      changed();
    },
    setProblems(id, n) {
      const r = recs.get(id);
      if (!r || r.view.problems === n) return;
      recs.set(id, { ...r, view: { ...r.view, problems: n } });
      notify();
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
