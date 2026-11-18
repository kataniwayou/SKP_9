export interface History<S> { past: S[]; present: S; future: S[]; merge: string | null }

const DEPTH = 100;

export const historyOf = <S>(s: S): History<S> => ({ past: [], present: s, future: [], merge: null });

/** A new present. Commits sharing a `merge` key in a row (typing) collapse into one step. */
export function commit<S>(h: History<S>, next: S, merge?: string): History<S> {
  if (next === h.present) return h;
  if (merge !== undefined && h.merge === merge && h.past.length > 0) return { ...h, present: next, future: [] };
  return { past: [...h.past, h.present].slice(-DEPTH), present: next, future: [], merge: merge ?? null };
}

export const canUndo = <S>(h: History<S>) => h.past.length > 0;
export const canRedo = <S>(h: History<S>) => h.future.length > 0;

export function undo<S>(h: History<S>): History<S> {
  if (!canUndo(h)) return h;
  return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1]!, future: [h.present, ...h.future], merge: null };
}

export function redo<S>(h: History<S>): History<S> {
  if (!canRedo(h)) return h;
  return { past: [...h.past, h.present], present: h.future[0]!, future: h.future.slice(1), merge: null };
}
