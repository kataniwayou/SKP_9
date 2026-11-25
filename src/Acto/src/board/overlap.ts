import type { Point, Rect } from '../model/geometry';

/** The clear margin a drop keeps around every other item [user, 2026-11-25]. */
export const DROP_GAP = 16;
/** The grid the nearest free place is looked for on, and how far it looks. */
const STEP = 20;
const REACH = 1200;

export const overlaps = (a: Rect, b: Rect, gap = 0): boolean =>
  a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

/** The offsets to try, nearest first; at equal distance right, then down, then left, then up (reading order). */
const CANDIDATES: Point[] = (() => {
  const out: Point[] = [];
  for (let dx = -REACH; dx <= REACH; dx += STEP) for (let dy = -REACH; dy <= REACH; dy += STEP) out.push({ x: dx, y: dy });
  const turn = (p: Point) => { const a = Math.atan2(p.y, p.x); return a < 0 ? a + 2 * Math.PI : a; };
  return out.sort((p, q) => Math.hypot(p.x, p.y) - Math.hypot(q.x, q.y) || turn(p) - turn(q));
})();

/**
 * Option B of the drag mock [user, 2026-11-25]: where a drop lands so nothing ends up hidden. The dragged items move as
 * one group by the smallest offset that keeps each of them `DROP_GAP` clear of every other item (ghosts included); none
 * when they are clear already, or when nothing within reach is (they stay where they were let go).
 */
export function pushAside(moving: Rect[], others: Rect[]): Point {
  const clear = (d: Point) => moving.every((m) => others.every((o) => !overlaps({ ...m, x: m.x + d.x, y: m.y + d.y }, o, DROP_GAP)));
  if (moving.length === 0 || others.length === 0) return { x: 0, y: 0 };
  // a drop that merely sits near another item (inside the gap, not on it) is left alone: only a real overlap moves it
  if (moving.every((m) => others.every((o) => !overlaps(m, o)))) return { x: 0, y: 0 };
  return CANDIDATES.find(clear) ?? { x: 0, y: 0 };
}

/** The items any of `moving` lies over: what the drag outlines as "under". */
export function covered<T extends { box: Rect }>(moving: Rect[], others: T[]): T[] {
  return others.filter((o) => moving.some((m) => overlaps(m, o.box)));
}
