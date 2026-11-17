import type { WorkflowState } from './state';

export interface History { past: WorkflowState[]; present: WorkflowState; future: WorkflowState[]; merge: string | null }

const DEPTH = 100;

export const historyOf = (s: WorkflowState): History => ({ past: [], present: s, future: [], merge: null });

/** A new present. Commits sharing a `merge` key in a row (typing) collapse into one step. */
export function commit(h: History, next: WorkflowState, merge?: string): History {
  if (next === h.present) return h;
  if (merge !== undefined && h.merge === merge && h.past.length > 0) return { ...h, present: next, future: [] };
  return { past: [...h.past, h.present].slice(-DEPTH), present: next, future: [], merge: merge ?? null };
}

export const canUndo = (h: History) => h.past.length > 0;
export const canRedo = (h: History) => h.future.length > 0;

export function undo(h: History): History {
  if (!canUndo(h)) return h;
  return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1]!, future: [h.present, ...h.future], merge: null };
}

export function redo(h: History): History {
  if (!canRedo(h)) return h;
  return { past: [...h.past, h.present], present: h.future[0]!, future: h.future.slice(1), merge: null };
}
