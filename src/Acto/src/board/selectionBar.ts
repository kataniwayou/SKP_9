import type { BoardState } from '../design/board';
import { schemaStates } from '../design/schemaStates';
import type { Pick } from './picks';

/**
 * What the light bar offers for several picks: the actions every pick has (spec §4, §6). `restore`/`remove`: every
 * pick is a ghost. `run` (Start · Stop): every pick is a triangle, which then also share Delete.
 */
export interface Bar { count: number; copy: boolean; del: boolean; restore: boolean; remove: boolean; run: boolean }

/**
 * null for fewer than two picks (a toolbar does that). Triangles, steps and caches have Copy [user, 2026-11-19], in any
 * mix; every kind but a ghost Delete, in any mix (every delete is a ghost [user, 2026-11-23]); ghosts Restore · Remove;
 * triangles alone also Start · Stop. Orphan schemas alone Delete; a schema or processor in any other mix shares nothing. A mix with a ghost shares nothing but Copy (none: a ghost has no Copy).
 */
export function barOf(picks: readonly Pick[], b: BoardState): Bar | null {
  if (picks.length < 2) return null;
  const count = picks.length;
  const none: Bar = { count, copy: false, del: false, restore: false, remove: false, run: false };
  if (picks.every((p) => p.kind === 'ghost')) return { ...none, restore: true, remove: true };
  if (picks.some((p) => p.kind === 'schema' || p.kind === 'processor')) {
    // only orphan schemas share a Delete; any other mix with a schema or processor has no action in common
    const states = schemaStates(b);
    return picks.every((p) => p.kind === 'schema' && states[p.id] === 'orphan') ? { ...none, del: true } : none;
  }
  const copy = picks.every((p) => p.kind === 'workflow' || p.kind === 'step' || p.kind === 'cache');
  if (picks.every((p) => p.kind === 'workflow')) return { ...none, run: true, copy, del: true };
  if (picks.some((p) => p.kind === 'ghost')) return { ...none, copy };
  return { ...none, copy, del: true };
}
