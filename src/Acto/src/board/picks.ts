import type { BoardState } from '../design/board';
import { deleteCaches, deleteSteps, removeEntries, removeWires, unlinkCaches } from '../design/edits';
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

/**
 * Delete of picked steps, caches, wires, entry arrows and cache lines as one board state (one history step): the
 * links first, then the steps (with their wires, entry arrows and payloads) and the caches (with their lines).
 * Triangles are not deleted here: that is BaseAPI's delete, not an edit.
 */
export function deletePicks(b: BoardState, picks: readonly Pick[]): BoardState {
  const wires: [string, string][] = [];
  const entries: [string, string][] = [];
  const links: [string, string][] = [];
  const steps: string[] = [];
  const caches: string[] = [];
  for (const p of picks) {
    if (p.kind === 'wire') wires.push([p.from, p.to]);
    else if (p.kind === 'entry') entries.push([p.workflowId, p.stepId]);
    else if (p.kind === 'cacheLink') links.push([p.workflowId, p.cacheId]);
    else if (p.kind === 'step') steps.push(p.id);
    else if (p.kind === 'cache') caches.push(p.id);
  }
  let s = b;
  if (wires.length) s = removeWires(s, wires);
  if (entries.length) s = removeEntries(s, entries);
  if (links.length) s = unlinkCaches(s, links);
  if (steps.length) s = deleteSteps(s, steps);
  if (caches.length) s = deleteCaches(s, caches);
  return s;
}
