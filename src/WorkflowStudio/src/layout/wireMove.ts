import { GRID, snap, type Point } from './geometry';
import { simplify, type Pt } from './router';

/** A wire's drawn path moved whole (the user's body drag, 2026-10-08): every point shifted by (dx, dy), the same shape. */
export function translatePoints(points: readonly Pt[], dx: number, dy: number): Pt[] {
  return points.map(([x, y]) => [x + dx, y + dy] as Pt);
}

const samePt = (a: Pt, b: Pt) => a[0] === b[0] && a[1] === b[1];

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

// ---- an end dragged around corners (the user's rule C, 2026-10-09) ----

export type Axis = 'h' | 'v';

/**
 * A dragged end drawing its wire like a pen around corners: `path` runs from the end that stays to the last corner
 * fixed so far (the anchor); from there the live end goes along `axis` (`dir` +1 or -1 its way) and then square on
 * to the pointer, an L as before. Each 90 degree turn of the pointer fixes the corner where it turned.
 */
export interface Legs {
  path: Pt[];
  /** The fewest points `path` keeps: the wire's own corners (and the end that stays) are never taken back. */
  floor: number;
  axis: Axis;
  dir: number;
  /** The pointer (snapped): where the end is drawn to. */
  end: Pt;
  /** The pointer (not snapped) where its current stretch of movement began: a turn fixes a corner there. */
  ref: Point;
  /** A corner was fixed in this drag. */
  drawn: boolean;
}

/** The pointer has to go this far (flow px) before its way counts, and an L leg be this long before a turn fixes it. */
export const TURN = 2 * GRID;

const along = (p: Pt | readonly number[], axis: Axis): number => (axis === 'h' ? p[0]! : p[1]!);
const across = (axis: Axis): Axis => (axis === 'h' ? 'v' : 'h');
const axisOf = (a: Pt, b: Pt): Axis => (a[0] === b[0] && a[1] !== b[1] ? 'v' : 'h');

/**
 * A drag of the end at the far end of `oriented` (drawn from the end that stays) begins, the pointer at `at`. The
 * corners the wire already has stay: only a corner fixed in this drag can be taken back.
 */
export function startLegs(oriented: readonly Pt[], at: Point): Legs {
  const pts = oriented.filter((p, i) => i === 0 || !samePt(p, oriented[i - 1]!));
  if (pts.length < 2) pts.push(pts[0] ?? [at.x, at.y]);
  const n = pts.length;
  const anchor = pts[n - 2]!, end = pts[n - 1]!;
  const axis = axisOf(anchor, end);
  return { path: pts.slice(0, n - 1), floor: n - 1, axis, dir: Math.sign(along(end, axis) - along(anchor, axis)) || 1, end, ref: at, drawn: false };
}

/**
 * The pointer moved to `p` (flow coordinates, not snapped). Back at or past the anchor along its leg, that corner goes
 * (and the one before, and so on, down to the corners the wire had). Moving one way for `TURN` px along the anchor's axis while the
 * L's other leg is at least `TURN` long is a 90 degree turn: the corner where the pointer turned is fixed. The end is
 * at `p` on the grid, or exactly at `at` (an alignment guide's, which need not lie on the grid).
 */
export function moveLegs(s: Legs, p: Point, at?: Pt): Legs {
  const end: Pt = at ?? [snap(p.x), snap(p.y)];
  let { path, axis, dir, ref, drawn } = s;
  while (path.length > s.floor) {
    const a = path[path.length - 1]!;
    const len = along(end, axis) - along(a, axis);
    if (len !== 0 && Math.sign(len) === dir) break;
    const b = path[path.length - 2]!;
    path = path.slice(0, -1);
    axis = axisOf(b, a);
    dir = Math.sign(along(a, axis) - along(b, axis)) || 1;
  }
  const vx = p.x - ref.x, vy = p.y - ref.y;
  if (Math.hypot(vx, vy) >= TURN) {
    const way: Axis | null = Math.abs(vx) >= 2 * Math.abs(vy) ? 'h' : Math.abs(vy) >= 2 * Math.abs(vx) ? 'v' : null;
    const a = path[path.length - 1]!;
    const leg = along(end, across(axis)) - along(a, across(axis));
    if (way === axis && Math.abs(leg) >= TURN) {
      const corner: Pt = axis === 'h' ? [snap(ref.x), a[1]] : [a[0], snap(ref.y)];
      const len = along(corner, axis) - along(a, axis);
      if (len !== 0 && Math.sign(len) === dir) {
        path = [...path, corner];
        axis = across(axis);
        dir = Math.sign(leg);
        drawn = true;
      }
    }
    ref = p;
  }
  return { path, floor: s.floor, axis, dir, end, ref, drawn };
}

/** The path as drawn now, from the end that stays to the dragged end: the corners fixed, then the L to the pointer. */
export function legsPath(s: Legs): Pt[] {
  const a = s.path[s.path.length - 1]!;
  const pivot: Pt = s.axis === 'h' ? [s.end[0], a[1]] : [a[0], s.end[1]];
  return simplify([...s.path, pivot, s.end]);
}
