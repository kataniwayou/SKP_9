import { useSyncExternalStore } from 'react';
import type { BoardLoad, BoardWorkflow } from '../board/loadBoard';
import { FRAME_PAD, STEP_W } from '../board/geometry';
import type { Id, Processor, Schema } from '../model/graph';
import type { Point } from '../model/geometry';
import type { OutputStore } from '../output/outputStore';
import { readDrafts, writeDrafts, type Drafts } from './drafts';
import { commit, historyOf, redo, undo, type History } from './history';
import { applyStored } from './request';
import { changedEntities, entityLabel, holders, type EntityKey } from './shared';
import { boardWorkflowOf, sameState, stateOf, type CacheState, type StepState, type WorkflowState } from './state';

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
  /**
   * Another workflow saved changes to the entities in `keys` this one shows too: `bw` (this workflow re-read) becomes
   * the base, and in every history state those entities take the re-read values and stamps (positions, the frame and
   * everything else stay). A step the re-read reaches that the base did not hold is added next to its source.
   */
  rebase(id: Id, bw: BoardWorkflow, keys: Set<EntityKey>): void;
  /** The workflow is gone (deleted, or never saved and discarded): its entry and its draft with it. */
  remove(id: Id): void;
  setProblems(id: Id, n: number): void;
  setSaving(id: Id, saving: boolean): void;
  /** The save was applied but the re-read failed: the present state becomes the base (the layout stays as last set). */
  adoptPresent(id: Id): void;
  /** BaseAPI stored this layout (it does on every save it reads, applied or not): what the next save compares against. */
  setLayout(id: Id, layout: unknown): void;
  /**
   * The other workflow holding an unsaved change to this step, processor or cache; null when none, or when `except`
   * holds one too (drafts or a failed save brought both back: refusing it would only block the way out).
   */
  lockedBy(key: EntityKey, except: Id): Id | null;
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
  // what each workflow has unsaved, kept per present state (states are immutable)
  const changedCache = new WeakMap<WorkflowState, { base: WorkflowState | null; keys: Set<EntityKey> }>();
  // shared steps whose wiring change each workflow was already told about, until it is back to its base
  const warned = new Map<Id, Set<Id>>();

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
    for (const [id, r] of recs) if (!r.view.unsaved) warned.delete(id);
    for (const id of warned.keys()) if (!recs.has(id)) warned.delete(id);
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
  const changedOf = (r: Rec): Set<EntityKey> => {
    const present = r.history.present;
    const hit = changedCache.get(present);
    if (hit && hit.base === r.base) return hit.keys;
    const keys = changedEntities(r.base, present);
    changedCache.set(present, { base: r.base, keys });
    return keys;
  };
  const lockedBy = (key: EntityKey, except: Id): Id | null => {
    const own = recs.get(except);
    if (own && changedOf(own).has(key)) return null;
    for (const [id, r] of recs) if (id !== except && changedOf(r).has(key)) return id;
    return null;
  };
  /** False (and says why) when the change touches a step, processor or cache another workflow is changing. */
  const allowed = (id: Id, r: Rec, next: WorkflowState): boolean => {
    for (const key of changedEntities(r.history.present, next)) {
      const other = lockedBy(key, id);
      if (other === null) continue;
      const own = store.boards().filter((b) => b.graph.workflow.id === id);
      const label = entityLabel(key, [...own, ...store.boards()]);
      output.log(`${label} is being changed in ${recs.get(other)!.history.present.fields.name} — save or undo it there first`, 'warn');
      return false;
    }
    return true;
  };
  /** The first wiring change out of a shared step (per workflow, until it is back to its base) names who else runs it. */
  const announceWiring = (id: Id, cur: WorkflowState, next: WorkflowState) => {
    let held: Map<EntityKey, Id[]> | null = null;
    for (const stepId of Object.keys(next.steps)) {
      const a = cur.steps[stepId];
      const b = next.steps[stepId];
      if (!a || !b || a === b || (a.nextStepIds.length === b.nextStepIds.length && a.nextStepIds.every((n, i) => n === b.nextStepIds[i]))) continue;
      if (warned.get(id)?.has(stepId)) continue;
      held ??= holders(store.boards());
      const others = (held.get(`step:${stepId}`) ?? []).filter((w) => w !== id).map((w) => recs.get(w)?.history.present.fields.name ?? w);
      if (others.length === 0) continue;
      const set = warned.get(id) ?? new Set<Id>();
      set.add(stepId);
      warned.set(id, set);
      const names = others.join(', ');
      output.log(`${a.name} is shared with ${names}: changing its wires changes what ${names} run${others.length === 1 ? 's' : ''} too`, 'warn');
    }
  };
  const setHistory = (id: Id, r: Rec, h: History) => {
    if (h === r.history || !allowed(id, r, h.present)) return;
    announceWiring(id, r.history.present, h.present);
    recs.set(id, withHistory(r, h));
    changed();
  };

  const store: BoardStore = {
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
    rebase(id, bw, keys) {
      const r = recs.get(id);
      if (!r || !r.base || !r.baseBw) return;
      const oldBase = r.base;
      const reached = new Set(bw.stepIds);
      const sourceOf = (stepId: Id) => bw.stepIds.find((s) => bw.graph.steps.get(s)?.nextStepIds.includes(stepId));
      /** Where a step the re-read brings in goes, given where this state has the others: right of its source. */
      const placeIn = (at: (id: Id) => Point | undefined, stepId: Id): Point => {
        const src = sourceOf(stepId);
        const p = src !== undefined ? at(src) : undefined;
        if (p) return { x: p.x + STEP_W + 60, y: p.y };
        return { ...(bw.stepAt.get(stepId) ?? { x: FRAME_PAD, y: FRAME_PAD }) };
      };
      const appeared = bw.stepIds.filter((s) => !oldBase.steps[s]);
      const baseAt = new Map<Id, Point>();
      for (const s of bw.stepIds) if (oldBase.steps[s]) baseAt.set(s, { ...oldBase.steps[s]!.at });
      for (const s of appeared) baseAt.set(s, placeIn((x) => baseAt.get(x), s));
      const baseBw: BoardWorkflow = { ...bw, stepAt: baseAt, frame: { ...r.baseBw.frame } };
      const base = stateOf(baseBw);

      for (const key of keys) {
        if (!key.startsWith('processor:')) continue;
        const p = bw.graph.processors.get(key.slice('processor:'.length));
        if (p) { processors = new Map(processors).set(p.id, p); procVersion++; }
      }
      const rebased = (s: WorkflowState): WorkflowState => {
        let steps = s.steps;
        let caches = s.caches;
        let assignments = s.assignments;
        let deletedSteps = s.deletedSteps;
        const setStep = (stepId: Id, st: StepState) => { steps = { ...steps, [stepId]: st }; };
        for (const key of keys) {
          const i = key.indexOf(':');
          const kind = key.slice(0, i);
          const eid = key.slice(i + 1);
          if (kind === 'step') {
            const now = reached.has(eid) ? base.steps[eid] : undefined;
            const had = steps[eid];
            if (now && had) {
              setStep(eid, { ...had, name: now.name, version: now.version, description: now.description, entryCondition: now.entryCondition,
                processorId: now.processorId, nextStepIds: [...now.nextStepIds], updatedAt: now.updatedAt, isNew: false });
            } else if (!now) {
              // deleted by the workflow that saved: gone here too, with the wires to it
              if (had && !had.isNew) {
                const rest: Record<Id, StepState> = {};
                for (const [sid, x] of Object.entries(steps)) {
                  if (sid === eid) continue;
                  rest[sid] = x.nextStepIds.includes(eid) ? { ...x, nextStepIds: x.nextStepIds.filter((n) => n !== eid) } : x;
                }
                steps = rest;
                if (assignments[eid]) { assignments = { ...assignments }; delete assignments[eid]; }
              }
              if (eid in deletedSteps) { deletedSteps = { ...deletedSteps }; delete deletedSteps[eid]; }
            }
          } else if (kind === 'cache') {
            const c = bw.graph.caches.get(eid);
            const held = caches[eid];
            if (!c || !held) continue;
            const fields = { name: c.name, version: c.version, description: c.description, root: c.root, items: c.items };
            const next: CacheState = { ...held, ...fields, isNew: false, ...(held.linked ? { linked: fields } : {}) };
            caches = { ...caches, [eid]: next };
          }
        }
        for (const sid of appeared) {
          if (steps[sid] || sid in deletedSteps) continue;
          const cur = steps;
          setStep(sid, { ...base.steps[sid]!, at: placeIn((x) => cur[x]?.at, sid) });
        }
        if (steps === s.steps && caches === s.caches && assignments === s.assignments && deletedSteps === s.deletedSteps) return s;
        return { ...s, steps, caches, assignments, deletedSteps };
      };
      const h = r.history;
      const history: History = { past: h.past.map(rebased), present: rebased(h.present), future: h.future.map(rebased), merge: null };
      recs.set(id, {
        baseBw, base, history, view: viewOf(base, history, r.view.layout, r.view.problems, r.view.saving), bwFor: null, bw: null,
      });
      changed();
    },
    setProblems(id, n) {
      const r = recs.get(id);
      if (!r || r.view.problems === n) return;
      recs.set(id, { ...r, view: { ...r.view, problems: n } });
      notify();
    },
    lockedBy,
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
  };
  return store;
}

export function useBoard(store: BoardStore): BoardWorkflow[] {
  return useSyncExternalStore(store.subscribe, store.boards);
}

export function useEntry(store: BoardStore, id: Id): BoardEntry | null {
  return useSyncExternalStore(store.subscribe, () => store.entry(id));
}
