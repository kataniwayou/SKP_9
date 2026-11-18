import type { Pick } from './picks';

/** What the light bar offers for several picks: the actions every pick has (spec §6). */
export interface Bar { count: number; copy: boolean; del: boolean }

/**
 * null for fewer than two picks (a toolbar does that). Steps have Copy · Delete; caches, wires, entry arrows and cache
 * lines Delete; so Copy only when every pick is a step. Triangles are never in a multi pick; were one there, nothing is common.
 */
export function barOf(picks: readonly Pick[]): Bar | null {
  if (picks.length < 2) return null;
  const count = picks.length;
  if (picks.some((p) => p.kind === 'workflow')) return { count, copy: false, del: false };
  return { count, copy: picks.every((p) => p.kind === 'step'), del: true };
}
