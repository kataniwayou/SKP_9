import { useSyncExternalStore } from 'react';
import type { Id } from '../model/graph';
import type { OutputStore } from '../output/outputStore';
import { deepEqual, type BoardState, type Edit } from './board';
import { changedKeys } from './changes';
import { withoutWorkflow } from './edits';
import { canRedo, canUndo, commit, historyOf, redo, undo, type History } from './history';

const KEY = 'acto.board';
export const SAVING_REFUSAL = 'Saving — wait for it to finish';

export interface BoardStore {
  /** base = b; restores the session draft (key `acto.board`) over it when present. */
  load(b: BoardState): void;
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
  /** base = present = fresh; history and draft cleared; failures cleared. */
  saved(fresh: BoardState): void;
  /** withoutWorkflow on base and every history state; consecutive equal states merged. */
  dropWorkflow(id: Id): void;
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

function readDraft(session: Storage | null): History<BoardState> | null {
  try {
    const raw = session?.getItem(KEY);
    if (!raw) return null;
    const h: unknown = JSON.parse(raw);
    if (!isObj(h) || !isBoard(h.present) || !Array.isArray(h.past) || !Array.isArray(h.future)) return null;
    if (!h.past.every(isBoard) || !h.future.every(isBoard)) return null;
    return { past: h.past as BoardState[], present: h.present, future: h.future as BoardState[], merge: null };
  } catch {
    return null;
  }
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
  let unsavedFor: { base: BoardState; present: BoardState; keys: Set<string> } | null = null;
  const subs = new Set<() => void>();

  const writeDraft = () => {
    try {
      if (history.past.length === 0 && history.future.length === 0 && history.present === base) session?.removeItem(KEY);
      else session?.setItem(KEY, JSON.stringify({ past: history.past, present: history.present, future: history.future }));
    } catch (e) {
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
    load(b) {
      base = b;
      const draft = readDraft(session);
      history = draft ?? historyOf(b);
      unsavedFor = null;
      if (!draft) writeDraft();
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
    saved(fresh) {
      base = fresh;
      history = historyOf(fresh);
      failures = new Map();
      unsavedFor = null;
      writeDraft();
      notify();
    },
    dropWorkflow(id) {
      const drop = (s: BoardState) => withoutWorkflow(s, id);
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
