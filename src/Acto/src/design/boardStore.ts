import { useSyncExternalStore } from 'react';
import type { BoardLoad, BoardWorkflow } from '../board/loadBoard';
import { STEP_W } from '../board/geometry';
import type { Id, Processor, Schema } from '../model/graph';
import type { Point, Rect } from '../model/geometry';
import type { OutputStore } from '../output/outputStore';
import { readDrafts, writeDrafts, type Drafts } from './drafts';
import { commit, historyOf, redo, undo, type History } from './history';
import { applyStored } from './request';
import { changedEntities, entityLabel, holders, type EntityKey } from './shared';
import { boardWorkflowOf, deepEqual, sameState, stateOf, type CacheState, type StepState, type WorkflowState } from './state';

export interface BoardEntry { base: WorkflowState | null; history: History; unsaved: boolean;
  /** The stored layout the workflow had when loaded (opaque JSON), to spot a change made elsewhere. */
  layout: unknown;
  /** Validation problems the last save found; 0 when valid or never saved. */
  problems: number;
  /** True while a save is in flight: a second save is refused and edits wait. */
  saving: boolean }

export interface BoardStore {
  /** `begin`, `arrive` for each workflow, `finish`: the board at once. */
  load(board: BoardLoad, processors: Processor[]): void;
  /** Clears the board and reads the session drafts once; they stay pending (and in the session) until their workflow arrives. */
  begin(processors: Processor[]): void;
  /** One workflow joins the board, with its draft or the design of a failed save applied. */
  arrive(bw: BoardWorkflow): void;
  /** New-workflow drafts become frames; drafts for workflows that never arrived are kept for later. */
  finish(board: BoardLoad): void;
  setProcessors(processors: Processor[]): void;
  /**
   * BaseAPI's schema list (with definitions): a processor's slots the loaded graph lacks (a step just added from the
   * toolbox) are filled from it, so the Inspector and the payload check have them before any save.
   */
  setSchemas(schemas: Schema[]): void;
  boards(): BoardWorkflow[];
  /**
   * A processor as last read from BaseAPI (the processor list, refreshed by every re-read after a save), without any
   * unsaved edit of the designs: what a processor edit is diffed against.
   */
  processor(id: Id, workflowId: Id): Processor | null;
  /** A schema as stored in the workflow's loaded graph, else as BaseAPI's schema list holds it. */
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
  // the frame each workflow arrived with: a final layout only moves a frame still there
  const arrivedFrame = new Map<Id, Rect>();
  let processors = new Map<Id, Processor>();
  let schemaList = new Map<Id, Schema>();
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
  /** A fresher read of these processors (a re-read after a save) replaces what the processor list said. */
  const learnProcessors = (ps: Iterable<Processor>) => {
    let next: Map<Id, Processor> | null = null;
    for (const p of ps) {
      if (deepEqual(processors.get(p.id), p)) continue;
      next ??= new Map(processors);
      next.set(p.id, p);
    }
    if (next) { processors = next; procVersion++; }
  };
  const setHistory = (id: Id, r: Rec, h: History) => {
    if (h === r.history || !allowed(id, r, h.present)) return;
    announceWiring(id, r.history.present, h.present);
    recs.set(id, withHistory(r, h));
    changed();
  };

  const store: BoardStore = {
    load(board, procs) {
      store.begin(procs);
      for (const bw of board.workflows) store.arrive(bw);
      store.finish(board);
    },
    begin(procs) {
      processors = new Map(procs.map((p) => [p.id, p]));
      procVersion++;
      recs.clear();
      arrivedFrame.clear();
      kept = readDrafts(session);
      changed();
    },
    arrive(bw) {
      const id = bw.graph.workflow.id;
      const name = bw.graph.workflow.name;
      const rec = make(bw);
      const draft = kept[id];
      delete kept[id];
      arrivedFrame.set(id, { ...bw.frame });
      if (draft && draft.updatedAt === bw.graph.workflow.updatedAt) {
        recs.set(id, withHistory(rec, draft.history));
      } else {
        if (draft) output.log(`${name}: unsaved work from before the refresh was dropped because the workflow changed`, 'warn');
        const applied = bw.graph.design != null ? applyStored(rec.base!, bw.graph.design, bw.graph.layout, bw.designCaches) : null;
        if (applied && !sameState(applied, rec.base!)) {
          // one step on from the saved workflow, so Undo goes back to it
          recs.set(id, withHistory(rec, commit(rec.history, applied)));
          output.log(`${name}: loaded unsaved work from a save that failed`, 'warn');
        } else recs.set(id, rec);
      }
      changed();
    },
    finish(board) {
      // the one-shot layout: base and every history state move, only where the frame is still the provisional one
      for (const [id, to] of board.finalFrames ?? []) {
        const r = recs.get(id);
        const from = arrivedFrame.get(id);
        if (!r || !r.base || !r.baseBw || !from) continue;
        const move = (s: WorkflowState): WorkflowState => (s.frame.x === from.x && s.frame.y === from.y ? { ...s, frame: { ...s.frame, x: to.x, y: to.y } } : s);
        const base = move(r.base);
        const h = r.history;
        const history: History = { past: h.past.map(move), present: move(h.present), future: h.future.map(move), merge: h.merge };
        recs.set(id, {
          ...r, baseBw: { ...r.baseBw, frame: { ...r.baseBw.frame, x: to.x, y: to.y } }, base, history,
          view: viewOf(base, history, r.view.layout, r.view.problems, r.view.saving), bwFor: null, bw: null,
        });
      }
      // a workflow created in the designer and not yet saved is not on the server to match against
      for (const [id, d] of Object.entries(kept)) {
        if (!d.history.present.isNew || recs.has(id)) continue;
        recs.set(id, make(null, d.history));
        delete kept[id];
      }
      changed();
    },
    setProcessors(ps) {
      processors = new Map(ps.map((p) => [p.id, p]));
      procVersion++;
      notify();
    },
    setSchemas(ss) {
      schemaList = new Map(ss.map((x) => [x.id, x]));
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
          r.bw = boardWorkflowOf(r.history.present, r.baseBw, processors, schemaList);
          r.bwFor = r.history.present;
        }
        return r.bw;
      });
      return cached;
    },
    processor: (id, wf) => processors.get(id) ?? recs.get(wf)?.baseBw?.graph.processors.get(id) ?? null,
    schema: (id, wf) => recs.get(wf)?.baseBw?.graph.schemas.get(id) ?? schemaList.get(id) ?? null,
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
      const built = boardWorkflowOf(r.history.present, r.baseBw, processors, schemaList);
      // what was just saved is what BaseAPI holds now, the processors this workflow changed included
      learnProcessors(built.graph.processors.values());
      const next = make(built);
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
      // a save that lands after its workflow left the board (deleted, discarded) must not bring it back
      const r = recs.get(id);
      if (!r) return;
      learnProcessors(bw.graph.processors.values());
      const next = make(bw);
      next.view = { ...next.view, saving: r.view.saving };
      recs.set(id, next);
      changed();
    },
    rebase(id, bw, keys) {
      const r = recs.get(id);
      if (!r || !r.base || !r.baseBw) return;
      // the re-read is only where the changed entities' new values come from: the base is the old base with
      // exactly the same patch the history states get, so nothing else the re-read differs in reaches this workflow
      const reread = bw.graph.steps;
      const reached = new Set(bw.stepIds);
      const fromReread = (stepId: Id, at: Point): StepState => {
        const g = reread.get(stepId)!;
        return {
          id: stepId, name: g.name, version: g.version, description: g.description, entryCondition: g.entryCondition,
          processorId: g.processorId, nextStepIds: [...g.nextStepIds], at, updatedAt: g.updatedAt, isNew: false,
        };
      };

      learnProcessors([...keys].flatMap((key) => {
        const p = key.startsWith('processor:') ? bw.graph.processors.get(key.slice('processor:'.length)) : undefined;
        return p ? [p] : [];
      }));
      const rebased = (s: WorkflowState): WorkflowState => {
        let steps = s.steps;
        let caches = s.caches;
        let assignments = s.assignments;
        let deletedSteps = s.deletedSteps;
        const keyed: Id[] = [];
        for (const key of keys) {
          const i = key.indexOf(':');
          const kind = key.slice(0, i);
          const eid = key.slice(i + 1);
          if (kind === 'step') {
            const had = steps[eid];
            if (reached.has(eid) && reread.has(eid)) {
              if (had) { steps = { ...steps, [eid]: fromReread(eid, had.at) }; keyed.push(eid); }
            } else {
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
        // a step a changed step now wires to that this state lacks (never held, or removed here) comes in right of
        // its source, and so on down what it reaches; one this state deleted stays deleted
        const queue = keyed.flatMap((k) => steps[k]!.nextStepIds.map((to) => [k, to] as const));
        while (queue.length) {
          const [from, to] = queue.shift()!;
          if (steps[to] || to in deletedSteps || !reread.has(to)) continue;
          const src = steps[from]!.at;
          steps = { ...steps, [to]: fromReread(to, { x: src.x + STEP_W + 60, y: src.y }) };
          for (const n of steps[to]!.nextStepIds) queue.push([to, n]);
        }
        if (steps === s.steps && caches === s.caches && assignments === s.assignments && deletedSteps === s.deletedSteps) return s;
        return { ...s, steps, caches, assignments, deletedSteps };
      };
      const base = rebased(r.base);
      // graph lookups (audits, processors, schemas, caches) see the re-read where the base did not have them
      const g0 = r.baseBw.graph;
      const merged = <K, V>(old: Map<K, V>, add: Map<K, V>, take: (k: K) => boolean) => {
        const m = new Map(old);
        for (const [k, v] of add) if (!m.has(k) || take(k)) m.set(k, v);
        return m;
      };
      const lookup: BoardWorkflow = {
        ...r.baseBw,
        graph: {
          ...g0,
          steps: merged(g0.steps, reread, (k) => keys.has(`step:${k}`)),
          processors: merged(g0.processors, bw.graph.processors, (k) => keys.has(`processor:${k}`)),
          schemas: merged(g0.schemas, bw.graph.schemas, () => false),
          caches: merged(g0.caches, bw.graph.caches, (k) => keys.has(`cache:${k}`)),
        },
      };
      const built = boardWorkflowOf(base, lookup, processors, schemaList);
      const baseBw: BoardWorkflow = { ...built, graph: { ...built.graph, processors: lookup.graph.processors, schemas: lookup.graph.schemas } };
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
