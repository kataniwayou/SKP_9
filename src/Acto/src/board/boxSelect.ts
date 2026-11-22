import type { Rect } from '../model/geometry';
import type { Pick } from './selection';
import { pickKey } from './picks';

/**
 * Box select [user, 2026-11-22]: a right-button drag on the board draws a dashed rectangle; on release every triangle,
 * step and cache fully or partly inside it is picked (never wires, entry arrows, cache lines or ghosts).
 */

/** A node as the board places it: its pick (null: not a component) and its box in board coordinates. */
export interface Placed { pick: Pick | null; box: Rect }

/** The rectangle between two corners, whichever way it was drawn. */
export function rectOf(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

const touches = (a: Rect, b: Rect) => a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;

/** The triangles, steps and caches the box touches, left to right, then top to bottom. */
export function boxPicks(placed: readonly Placed[], box: Rect): Pick[] {
  return placed
    .filter((n): n is Placed & { pick: Pick } =>
      n.pick !== null && (n.pick.kind === 'workflow' || n.pick.kind === 'step' || n.pick.kind === 'cache') && touches(n.box, box))
    .sort((a, b) => a.box.x - b.box.x || a.box.y - b.box.y)
    .map((n) => n.pick);
}

/** The picks after a box: the box's alone, or (Ctrl held) the current ones with the box's new ones after them. */
export function withBox(current: readonly Pick[], box: readonly Pick[], additive: boolean): Pick[] {
  if (!additive) return [...box];
  const have = new Set(current.map(pickKey));
  return [...current, ...box.filter((p) => !have.has(pickKey(p)))];
}
