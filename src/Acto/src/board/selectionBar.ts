import type { Pick } from './picks';

/**
 * What the light bar offers for several picks: the actions every pick has (spec §4, §6). `restore`/`remove`: every
 * pick is a ghost. `run` (Start · Stop): every pick is a triangle, which then also share Delete.
 */
export interface Bar { count: number; copy: boolean; del: boolean; restore: boolean; remove: boolean; run: boolean }

/**
 * null for fewer than two picks (a toolbar does that). Steps have Copy · Delete; caches, wires, entry arrows and cache
 * lines Delete; ghosts Restore · Remove; triangles Start · Stop · Delete (a delete of BaseAPI rows, not a board edit).
 * A mix of kinds that share nothing shows nothing.
 */
export function barOf(picks: readonly Pick[]): Bar | null {
  if (picks.length < 2) return null;
  const count = picks.length;
  const none: Bar = { count, copy: false, del: false, restore: false, remove: false, run: false };
  if (picks.every((p) => p.kind === 'ghost')) return { ...none, restore: true, remove: true };
  if (picks.every((p) => p.kind === 'workflow')) return { ...none, run: true, del: true };
  if (picks.some((p) => p.kind === 'ghost' || p.kind === 'workflow')) return none;
  return { ...none, copy: picks.every((p) => p.kind === 'step'), del: true };
}
