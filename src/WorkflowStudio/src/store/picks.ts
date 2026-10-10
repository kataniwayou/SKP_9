import { cacheNodeId, SPHERE_NODE_ID } from '../layout/nodeIds';
import type { Selection } from './selection';

/**
 * What is picked on a document's canvas (spec §3.2): blocks by React Flow node id, wires by wire id, a step's processor
 * (its picture inside the step, 2026-10-10) by the step's id: Delete removes it from the step, never the entity. The
 * Inspector's selection is separate: it is the one entity shown, and only one picked block has one.
 */
export type Pick = { kind: 'node'; id: string } | { kind: 'wire'; id: string } | { kind: 'processor'; id: string };

export const pickKey = (p: Pick): string => `${p.kind}:${p.id}`;

export function picksOf(selection: Selection | null): Pick[] {
  if (selection === null) return [];
  switch (selection.kind) {
    case 'workflow': return [{ kind: 'node', id: SPHERE_NODE_ID }];
    case 'step': return [{ kind: 'node', id: selection.stepId }];
    case 'processor': return [{ kind: 'processor', id: selection.stepId }];
    case 'cache': return [{ kind: 'node', id: cacheNodeId(selection.cacheId) }];
  }
}

export function togglePick(picks: readonly Pick[], pick: Pick): Pick[] {
  const key = pickKey(pick);
  return picks.some((p) => pickKey(p) === key) ? picks.filter((p) => pickKey(p) !== key) : [...picks, pick];
}

export const samePicks = (a: readonly Pick[], b: readonly Pick[]): boolean =>
  a.length === b.length && a.every((p, i) => pickKey(p) === pickKey(b[i]!));

export const nodePickIds = (picks: readonly Pick[]): string[] => picks.filter((p) => p.kind === 'node').map((p) => p.id);
export const wirePickIds = (picks: readonly Pick[]): string[] => picks.filter((p) => p.kind === 'wire').map((p) => p.id);
/** The steps whose processor is picked. */
export const processorPickIds = (picks: readonly Pick[]): string[] => picks.filter((p) => p.kind === 'processor').map((p) => p.id);
