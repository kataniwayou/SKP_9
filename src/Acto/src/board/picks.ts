import type { BoardWorkflow } from './loadBoard';
import type { Selection } from './selection';
import { keepExistingSelection } from '../session/view';

/** One picked thing; the picks are kept in the order they were made. */
export type Pick = Selection;

/** Same as the React Flow node / edge id of the thing. */
export function pickKey(p: Pick): string {
  switch (p.kind) {
    case 'workflow': return `wf:${p.workflowId}`;
    case 'step': return `st:${p.workflowId}:${p.stepId}`;
    case 'wire': return `wi:${p.workflowId}:${p.wireId}`;
    case 'cache': return `ca:${p.workflowId}:${p.cacheId}`;
  }
}

export function togglePick(picks: readonly Pick[], p: Pick): Pick[] {
  const k = pickKey(p);
  return picks.some((x) => pickKey(x) === k) ? picks.filter((x) => pickKey(x) !== k) : [...picks, p];
}

export const lastPick = (picks: readonly Pick[]): Pick | null => picks[picks.length - 1] ?? null;

/** The picks whose thing is still on the board. */
export function livePicks(picks: readonly Pick[], workflows: BoardWorkflow[]): Pick[] {
  return picks.filter((p) => keepExistingSelection(p, workflows) !== null);
}
