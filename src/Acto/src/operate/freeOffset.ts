import type { Point, Rect } from '../model/geometry';

export const PASTE_CELL = 32;
export const PASTE_MARGIN = 16;
/** How far out the search goes (in cells) before the group goes below everything. */
const MAX_RING = 64;

/**
 * Where a pasted group lands: `start` (an offset of the whole group) when no box of it, grown by `margin`, overlaps an
 * obstacle; otherwise the nearest offset from `start` on the 32 px grid where none does and the group stays at or past
 * `min` (its top-left), the group moved as one rigid unit. Rings of growing size are searched in turn, each nearest first,
 * right and down before left and up. Past the last ring the group goes below everything. (Port of WorkflowStudio's.)
 */
export function freeOffset(group: readonly Rect[], obstacles: readonly Rect[], start: Point, margin = PASTE_MARGIN, min?: Point): Point {
  if (group.length === 0) return start;
  const grown = obstacles.map((o) => ({ x: o.x - margin, y: o.y - margin, w: o.w + 2 * margin, h: o.h + 2 * margin }));
  const hits = (r: Rect) => grown.some((o) => r.x < o.x + o.w && o.x < r.x + r.w && r.y < o.y + o.h && o.y < r.y + r.h);
  const fits = (dx: number, dy: number) => group.every((b) =>
    (!min || (b.x + dx >= min.x && b.y + dy >= min.y)) && !hits({ x: b.x + dx, y: b.y + dy, w: b.w, h: b.h }));
  if (fits(start.x, start.y)) return start;
  for (let r = 1; r <= MAX_RING; r++) {
    const ring: [number, number][] = [];
    for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) if (Math.max(Math.abs(i), Math.abs(j)) === r) ring.push([i, j]);
    ring.sort(([ai, aj], [bi, bj]) => (ai * ai + aj * aj) - (bi * bi + bj * bj)
      || (Number(ai < 0) + Number(aj < 0)) - (Number(bi < 0) + Number(bj < 0)) || bi - ai || bj - aj);
    for (const [i, j] of ring) {
      const dx = start.x + i * PASTE_CELL, dy = start.y + j * PASTE_CELL;
      if (fits(dx, dy)) return { x: dx, y: dy };
    }
  }
  const bottom = Math.max(...obstacles.map((o) => o.y + o.h), ...group.map((b) => b.y + b.h));
  const top = Math.min(...group.map((b) => b.y));
  return { x: start.x, y: Math.ceil((bottom + margin + PASTE_CELL - top) / PASTE_CELL) * PASTE_CELL };
}
