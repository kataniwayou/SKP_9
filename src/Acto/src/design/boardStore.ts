import { useSyncExternalStore } from 'react';
import type { Id } from '../model/graph';
import type { OutputStore } from '../output/outputStore';
import { deepEqual, type BoardState, type Edit } from './board';
import { changedKeys } from './changes';
import { withoutWorkflow } from './edits';
import { canRedo, canUndo, commit, historyOf, redo, undo, type History } from './history';
import type { Table } from './changes';

const KEY = 'acto.board';
export const SAVING_REFUSAL = 'Saving — wait for it to finish';

export interface BoardStore {
  /**
   * base = b (BaseAPI's rows as read); the present starts as `present` (default b) with an empty history, so what differs
   * (placement's locations, say) is unsaved and goes out with the next Save, and no undo returns it. A session draft (key
   * `acto.board`: the unsaved board and the base it was made against) is replayed onto them: only the designer's changes
   * (draft base vs. draft present) are taken over, each with the stamp the draft read; every other row is the fresh one.
   * Undo history is not restored across a reload.
   */
  load(b: BoardState, present?: BoardState): void;
  state(): BoardState;
  base(): BoardState;
  /** Refused while saving. */
  edit(fn: (b: BoardState) => BoardState, merge?: string): void;
  /** A refusal goes to Output as a warning. */
  editOrRefuse(fn: (b: BoardState) => Edit): void;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  /** changedKeys(base, present). */
  unsaved(): Set<string>;
  saving(): boolean;
  setSaving(on: boolean): void;
  /** Save's outcome is unknown (its answer was lost): Save is refused and no draft is kept until the next load. */
  saveBlocked(): boolean;
  blockSave(): void;
  /** base = present = fresh; history and draft cleared; failures cleared. */
  saved(fresh: BoardState): void;
  /** withoutWorkflow on base and every history state; consecutive equal states merged. With `deletedAssignments` the base loses exactly those assignment rows. */
  dropWorkflow(id: Id, deletedAssignments?: Id[]): void;
  problems(wf: Id): number;
  setProblems(wf: Id, n: number): void;
  /** Key as changedKeys → BaseAPI's message. */
  failures(): Map<string, string>;
  setFailures(f: Map<string, string>): void;
  subscribe(fn: () => void): () => void;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isBoard = (v: unknown): v is BoardState =>
  isObj(v) && ['workflows', 'steps', 'caches', 'assignments', 'processors', 'schemas'].every((k) => isObj(v[k]));

/** The session draft: the unsaved board and the base it was diffed against. Nothing else (no undo history). */
interface Draft { base: BoardState; present: BoardState }

function readDraft(session: Storage | null): Draft | null {
  try {
    const raw = session?.getItem(KEY);
    if (!raw) return null;
    const d: unknown = JSON.parse(raw);
    if (!isObj(d) || !isBoard(d.base) || !isBoard(d.present)) return null;
    return { base: d.base, present: d.present };
  } catch {
    return null;
  }
}

const TABLES: readonly Table[] = ['workflows', 'steps', 'caches', 'assignments', 'processors', 'schemas'];

/**
 * The draft's own changes (draft.base vs. draft.present) replayed onto a fresh read (`base` as read, `present` as placed).
 * A row the designer did not change is the fresh one in both, so nothing goes out for it (a row created or changed
 * elsewhere included). A row they changed or created is their version in the present, and a row they changed or deleted
 * is the row the draft read in the base: its stamp is the draft's, so a row also changed elsewhere is refused (409). A row
 * they deleted that is gone from the fresh read as well is left alone.
 */
export function rebaseDraft(draft: Draft, base: BoardState, present: BoardState): Draft {
  const nb = { ...base } as Record<Table, Record<Id, unknown>>;
  const np = { ...present } as Record<Table, Record<Id, unknown>>;
  for (const t of TABLES) {
    const db = draft.base[t] as Record<Id, unknown>;
    const dp = draft.present[t] as Record<Id, unknown>;
    const ids = new Set([...Object.keys(db), ...Object.keys(dp)]);
    let bt: Record<Id, unknown> | null = null;
    let pt: Record<Id, unknown> | null = null;
    for (const id of ids) {
      const inDb = id in db, inDp = id in dp;
      if (inDb && inDp && deepEqual(db[id], dp[id])) continue;
      bt ??= { ...nb[t] }; pt ??= { ...np[t] };
      if (inDp) {
        pt[id] = dp[id];
        if (inDb) bt[id] = db[id];
      } else {
        delete pt[id];
        if (id in base[t]) bt[id] = db[id]; else delete bt[id];
      }
    }
    if (bt) nb[t] = bt;
    if (pt) np[t] = pt;
  }
  return { base: nb as unknown as BoardState, present: np as unknown as BoardState };
}

/** Compresses runs of equal neighbours: the earlier of two equal past states goes, the later of two equal future states. */
function compact(h: History<BoardState>): History<BoardState> {
  const past: BoardState[] = [];
  const seq = [...h.past, h.present];
  for (let i = 0; i < h.past.length; i++) if (!deepEqual(seq[i], seq[i + 1])) past.push(seq[i]!);
  const future: BoardState[] = [];
  let prev = h.present;
  for (const s of h.future) { if (!deepEqual(prev, s)) future.push(s); prev = s; }
  return { past, present: h.present, future, merge: h.merge };
}

export function createBoardStore(output: OutputStore, session: Storage | null): BoardStore {
  let base: BoardState = { workflows: {}, steps: {}, caches: {}, assignments: {}, processors: {}, schemas: {} };
  let history: History<BoardState> = historyOf(base);
  let saving = false;
  let problems = new Map<Id, number>();
  let failures = new Map<string, string>();
  let draftFailed = false;
  let blocked = false;
  let unsavedFor: { base: BoardState; present: BoardState; keys: Set<string> } | null = null;
  const subs = new Set<() => void>();

  const dropDraft = () => { try { session?.removeItem(KEY); } catch { /* blocked storage: nothing to drop */ } };
  /** The draft is `{ base, present }` while the board has unsaved changes, and no key when it is clean. */
  const writeDraft = () => {
    try {
      // while Save's outcome is unknown, a reload must start from BaseAPI's rows: no draft that could re-send the creates
      if (blocked || store.unsaved().size === 0) session?.removeItem(KEY);
      else session?.setItem(KEY, JSON.stringify({ base, present: history.present } satisfies Draft));
    } catch (e) {
      // a draft that could not be written must not leave an older one behind to be restored
      dropDraft();
      if (draftFailed) return;
      draftFailed = true;
      output.log(`Unsaved work is no longer kept across refresh: ${e instanceof Error ? e.message : String(e)}`, 'warn');
    }
  };
  const notify = () => subs.forEach((f) => f());
  const setHistory = (h: History<BoardState>) => {
    if (h === history) return;
    history = h;
    writeDraft();
    notify();
  };
  const refuseWhileSaving = (): boolean => {
    if (!saving) return false;
    output.log(SAVING_REFUSAL, 'warn');
    return true;
  };

  const store: BoardStore = {
    load(b, present = b) {
      const draft = readDraft(session);
      const start = draft ? rebaseDraft(draft, b, present) : { base: b, present };
      base = start.base;
      history = historyOf(start.present);
      unsavedFor = null;
      blocked = false;
      // no draft: nothing of the designer's to keep (placement is redone on every load); a stale or old-shaped key goes
      if (draft) writeDraft(); else dropDraft();
      notify();
    },
    state: () => history.present,
    base: () => base,
    edit(fn, merge) {
      if (refuseWhileSaving()) return;
      setHistory(commit(history, fn(history.present), merge));
    },
    editOrRefuse(fn) {
      if (refuseWhileSaving()) return;
      const res = fn(history.present);
      if ('refused' in res) output.log(res.refused, 'warn');
      else setHistory(commit(history, res.state));
    },
    undo() { if (!refuseWhileSaving()) setHistory(undo(history)); },
    redo() { if (!refuseWhileSaving()) setHistory(redo(history)); },
    canUndo: () => canUndo(history),
    canRedo: () => canRedo(history),
    unsaved() {
      if (!unsavedFor || unsavedFor.base !== base || unsavedFor.present !== history.present) {
        unsavedFor = { base, present: history.present, keys: changedKeys(base, history.present) };
      }
      return unsavedFor.keys;
    },
    saving: () => saving,
    setSaving(on) { if (saving !== on) { saving = on; notify(); } },
    saveBlocked: () => blocked,
    blockSave() { blocked = true; dropDraft(); notify(); },
    saved(fresh) {
      base = fresh;
      blocked = false;
      history = historyOf(fresh);
      failures = new Map();
      unsavedFor = null;
      writeDraft();
      notify();
    },
    dropWorkflow(id, deletedAssignments) {
      // with an explicit list the board loses exactly the rows BaseAPI deleted (plus this workflow's own never-saved rows no
      // other workflow links); a row another workflow still links in a state stays there
      const gone = deletedAssignments ? new Set(deletedAssignments) : null;
      const drop = (s: BoardState): BoardState => {
        if (!gone) return withoutWorkflow(s, id);
        const w = s.workflows[id];
        const workflows = { ...s.workflows };
        delete workflows[id];
        const mine = new Set(w?.assignmentIds ?? []);
        const keep = Object.fromEntries(Object.entries(s.assignments).filter(([k, a]) =>
          !gone.has(k) && !(mine.has(k) && a.updatedAt === null && !Object.values(workflows).some((o) => o.assignmentIds.includes(k)))));
        return { ...s, workflows, assignments: keep };
      };
      base = drop(base);
      setHistory(compact({ past: history.past.map(drop), present: drop(history.present), future: history.future.map(drop), merge: history.merge }));
      // base may have changed even when the history did not
      writeDraft();
      notify();
    },
    problems: (wf) => problems.get(wf) ?? 0,
    setProblems(wf, n) {
      if ((problems.get(wf) ?? 0) === n) return;
      problems = new Map(problems);
      if (n === 0) problems.delete(wf); else problems.set(wf, n);
      notify();
    },
    failures: () => failures,
    setFailures(f) { failures = f; notify(); },
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
  };
  return store;
}

export function useBoardState(store: BoardStore): BoardState {
  return useSyncExternalStore(store.subscribe, store.state);
}
