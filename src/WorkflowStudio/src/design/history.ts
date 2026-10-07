import { EMPTY_DRAFT, type Draft } from './draft';

/** One document's design draft and its undo / redo stacks (spec §5.3). Not kept across a refresh. */
export interface DesignHistory {
  draft: Draft;
  past: Draft[];
  future: Draft[];
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

export function undo(h: DesignHistory): DesignHistory {
  const previous = h.past[h.past.length - 1];
  if (previous === undefined) return h;
  return { draft: previous, past: h.past.slice(0, -1), future: [h.draft, ...h.future], merge: null };
}

export function redo(h: DesignHistory): DesignHistory {
  const [next, ...rest] = h.future;
  if (next === undefined) return h;
  return { draft: next, past: [...h.past, h.draft].slice(-HISTORY_DEPTH), future: rest, merge: null };
}

export const canUndo = (h: DesignHistory): boolean => h.past.length > 0;
export const canRedo = (h: DesignHistory): boolean => h.future.length > 0;
