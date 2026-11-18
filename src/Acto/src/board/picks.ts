import type { BoardState } from '../design/board';
import type { Pick } from './selection';

export type { Pick };

/** A stable key of a pick, one per thing. */
export function pickKey(p: Pick): string {
  switch (p.kind) {
    case 'workflow': return `wf:${p.id}`;
    case 'step': return `st:${p.id}`;
    case 'cache': return `ca:${p.id}`;
    case 'wire': return `wi:${p.from}>${p.to}`;
    case 'entry': return `en:${p.workflowId}:${p.stepId}`;
    case 'cacheLink': return `cl:${p.workflowId}:${p.cacheId}`;
  }
}

export function togglePick(picks: readonly Pick[], p: Pick): Pick[] {
  const k = pickKey(p);
  return picks.some((x) => pickKey(x) === k) ? picks.filter((x) => pickKey(x) !== k) : [...picks, p];
}

export const lastPick = (picks: readonly Pick[]): Pick | null => picks[picks.length - 1] ?? null;

const exists = (b: BoardState, p: Pick): boolean => {
  switch (p.kind) {
    case 'workflow': return !!b.workflows[p.id];
    case 'step': return !!b.steps[p.id];
    case 'cache': return !!b.caches[p.id];
    case 'wire': return !!b.steps[p.from]?.nextStepIds.includes(p.to);
    case 'entry': return !!b.workflows[p.workflowId]?.entryStepIds.includes(p.stepId);
    case 'cacheLink': return !!b.workflows[p.workflowId]?.cacheIds.includes(p.cacheId);
  }
};

/** The picks whose thing is still on the board, in order. */
export const livePicks = (picks: readonly Pick[], b: BoardState): Pick[] => picks.filter((p) => exists(b, p));
