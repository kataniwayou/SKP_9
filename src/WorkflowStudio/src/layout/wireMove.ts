import type { Side } from '../circuit/circuit';
import type { Point } from './geometry';
import { simplify, type Pt } from './router';
import { shapeFromPoints, type Bends } from './shape';

/** A wire's drawn path moved whole (the user's body drag, 2026-10-08): every point shifted by (dx, dy), the same shape. */
export function translatePoints(points: readonly Pt[], dx: number, dy: number): Pt[] {
  return points.map(([x, y]) => [x + dx, y + dy] as Pt);
}

const samePt = (a: Pt, b: Pt) => a[0] === b[0] && a[1] === b[1];

/**
 * A drawn path with its `side` end dragged to `q`, adding at most one corner (an L; the user's end drag, 2026-10-08).
 * The run at that end keeps its axis: its end point moves along it to `q`'s coordinate on that axis (a horizontal run
 * to `q.x`, a vertical one to `q.y`), then one perpendicular run goes on to `q`. Every other point stays. Dragged along
 * the run's own axis it is only lengthened or shortened. A run of no length at that end does not count.
 */
export function endMoved(points: readonly Pt[], side: Side, q: Point): Pt[] {
  const pts = side === 'head' ? [...points] : [...points].reverse();
  let i = pts.length - 1;
  while (i > 0 && samePt(pts[i - 1]!, pts[i]!)) i--;
  const to: Pt = [q.x, q.y];
  let out: Pt[];
  if (i === 0) out = simplify([pts[0]!, [q.x, pts[0]![1]], to]);
  else {
    const a = pts[i - 1]!, b = pts[i]!;
    const vertical = a[0] === b[0];
    const pivot: Pt = vertical ? [b[0], q.y] : [q.x, b[1]];
    out = simplify([...pts.slice(0, i), pivot, to]);
  }
  return side === 'head' ? out : out.reverse();
}

/** Lies on the right-angled run a → b (its ends included). */
const onRun = (p: Pt, a: Pt, b: Pt) =>
  (a[0] === b[0] && p[0] === a[0] && p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1]))
  || (a[1] === b[1] && p[1] === a[1] && p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0]));

/**
 * The path from `start` on: what follows the first run `start` lies on. A lead before a wire's core (the hub's ring
 * and the way out of its square, a junction's jog) is dropped, so the rest is the core its bends shape. A start on
 * no run is put in front of the path.
 */
export function coreFrom(points: readonly Pt[], start: Pt): Pt[] {
  for (let i = 0; i < points.length - 1; i++) {
    if (onRun(start, points[i]!, points[i + 1]!)) return simplify([start, ...points.slice(i + 1)]);
  }
  return simplify([start, ...points]);
}

/**
 * A wire's `side` end dragged to `q` (`endMoved`): the path as drawn, and the bends that draw it again from the
 * other end's core end (`fixed`: the core's start for a dragged head, its end for a dragged tail) to `q`.
 */
export function movedEndShape(points: readonly Pt[], side: Side, q: Point, fixed: Pt): { points: Pt[]; bends: Bends } {
  const moved = endMoved(points, side, q);
  const core = side === 'head' ? coreFrom(moved, fixed) : coreFrom([...moved].reverse(), fixed).reverse();
  return { points: moved, bends: shapeFromPoints(core) };
}
