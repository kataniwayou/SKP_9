import type { BoardState, ItemRef } from '../design/board';
import type { GhostItem } from '../design/ghosts';
import type { Point, Rect } from '../model/geometry';
import { CACHE_H, CACHE_W, STEP_H, STEP_W, TRIANGLE_H, TRIANGLE_W } from './geometry';
import { overlaps } from './overlap';

type Kind = ItemRef['kind'];
const SIZE: Record<Kind, { w: number; h: number }> = {
  workflow: { w: TRIANGLE_W, h: TRIANGLE_H }, step: { w: STEP_W, h: STEP_H }, cache: { w: CACHE_W, h: CACHE_H },
};

/** An item's box on the board at `at`, in the sizes the board declares for it. */
export const rectAt = (kind: Kind, at: Point): Rect => ({ x: at.x, y: at.y, ...SIZE[kind] });

/**
 * Every placed triangle, step, cache and ghost on the board, keyed as `kind:id` (a ghost by its own key), less `except`:
 * what a toolbox drop or a nudge must not land on [user, 2026-11-25]. Items not yet placed take no room.
 */
export function occupied(b: BoardState, ghosts: readonly GhostItem[], except: ReadonlySet<string> = new Set()): Rect[] {
  const out: Rect[] = [];
  const add = (key: string, kind: Kind, at: Point | null | undefined) => { if (at && !except.has(key)) out.push(rectAt(kind, at)); };
  for (const w of Object.values(b.workflows)) add(`workflow:${w.id}`, 'workflow', w.at);
  for (const s of Object.values(b.steps)) add(`step:${s.id}`, 'step', s.at);
  for (const c of Object.values(b.caches)) add(`cache:${c.id}`, 'cache', c.at);
  for (const g of ghosts) {
    if (g.kind !== 'step' && g.kind !== 'cache' && g.kind !== 'workflow') continue;
    // a ghost whose item is back on the board is not drawn
    const live = g.kind === 'step' ? b.steps[g.row.id] : g.kind === 'cache' ? b.caches[g.row.id] : b.workflows[g.row.id];
    if (!live) add(g.key.startsWith('ghost:') ? g.key : `ghost:${g.key}`, g.kind, g.row.at);
  }
  return out;
}

/** Whether a nudge's new boxes would lie on any other item (touching inside the drop gap is allowed: only a real overlap). */
export const nudgeBlocked = (moving: Rect[], others: Rect[]): boolean => moving.some((m) => others.some((o) => overlaps(m, o)));
