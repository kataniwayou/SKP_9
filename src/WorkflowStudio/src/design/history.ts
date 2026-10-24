import type { Id } from '../model/graph';
import type { AssignmentOp } from './design';
import { EMPTY_DRAFT, type Draft } from './draft';

/**
 * Creating or removing a step's assignment (2026-10-23): an Undo step of its own, as a drawing gesture is. The draft
 * does not change; Undo puts `before` back as the step's assignment operation, Redo `after` (null: none).
 */
export interface AssignmentStep {
  assignment: { stepId: Id; before: AssignmentOp | null; after: AssignmentOp | null };
}

/** In `past`: the draft before a drawing step, or an assignment step. In `future`: the draft after, or the step. */
export type HistoryStep = Draft | AssignmentStep;

export const isAssignmentStep = (s: HistoryStep): s is AssignmentStep => Object.hasOwn(s, 'assignment');

/** One document's design draft and its undo / redo stacks (spec §5.3). */
export interface DesignHistory {
  draft: Draft;
  past: HistoryStep[];
  future: HistoryStep[];
  /** The kind of the last step when it may merge with the next one of its kind (a run of nudges). */
  merge: string | null;
}

export const HISTORY_DEPTH = 100;

export const historyOf = (draft: Draft = EMPTY_DRAFT): DesignHistory => ({ draft, past: [], future: [], merge: null });

/** A finished gesture. `merge`: a step of the same kind straight after this one replaces it instead of stacking. */
export function commit(h: DesignHistory, draft: Draft, merge: string | null = null): DesignHistory {
  if (draft === h.draft) return h;
  if (merge !== null && merge === h.merge) return { ...h, draft, future: [] };
  return { draft, past: [...h.past, h.draft].slice(-HISTORY_DEPTH), future: [], merge };
}

/** An assignment created or removed: one step, the draft as it is. */
export const commitAssignment = (h: DesignHistory, step: AssignmentStep): DesignHistory =>
  ({ draft: h.draft, past: [...h.past, step].slice(-HISTORY_DEPTH), future: [], merge: null });

/** The step Undo would take back, or Redo would do again (null: none). */
export const undoStepOf = (h: DesignHistory): HistoryStep | null => h.past[h.past.length - 1] ?? null;
export const redoStepOf = (h: DesignHistory): HistoryStep | null => h.future[0] ?? null;

export function undo(h: DesignHistory): DesignHistory {
  const previous = undoStepOf(h);
  if (previous === null) return h;
  if (isAssignmentStep(previous)) return { draft: h.draft, past: h.past.slice(0, -1), future: [previous, ...h.future], merge: null };
  return { draft: previous, past: h.past.slice(0, -1), future: [h.draft, ...h.future], merge: null };
}

export function redo(h: DesignHistory): DesignHistory {
  const next = redoStepOf(h);
  if (next === null) return h;
  const rest = h.future.slice(1);
  if (isAssignmentStep(next)) return { draft: h.draft, past: [...h.past, next].slice(-HISTORY_DEPTH), future: rest, merge: null };
  return { draft: next, past: [...h.past, h.draft].slice(-HISTORY_DEPTH), future: rest, merge: null };
}

export const canUndo = (h: DesignHistory): boolean => h.past.length > 0;
export const canRedo = (h: DesignHistory): boolean => h.future.length > 0;
