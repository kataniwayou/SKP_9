import { GRID, snap } from './geometry';
import { simplify, type Pt } from './router';

/**
 * A manual route (spec §4.3), Visio's "reroute as needed": a wire leaves its source and lands on its
 * target horizontally, so its path is H V H V … H. `xs` is the x of each vertical run, `ys` the y of each
 * horizontal run between two verticals (`ys.length === xs.length - 1`). The first and last horizontal
 * runs are the source's and target's heights, so they follow the blocks; everything else stays.
 */
export interface Bends {
  xs: number[];
  ys: number[];
}

/** A junction (plan 7): the wire ends on `host`'s line, `at` px along its drawn line from its start. */
export interface Contact {
  host: string;
  at: number;
}

/** What the user did to one wire's shape. */
export interface WireShape {
  /** A manual route; null: the router decides. For a joined wire: its own line's bends. */
  bends: Bends | null;
  /** Step-local landing height on the target, when slid; null: the landing rule decides. */
  landing: number | null;
  /** On another wire's line (plan 7); absent or null: a plain wire. */
  contact?: Contact | null;
}

/** A wire's two ends: the source port and the landing. */
export interface Ends {
  sx: number;
  sy: number;
  tx: number;
  ty: number;
}

/** How far a jog stands off the source port (spec §4.2). */
export const JOG = 16;

export interface SegmentHandle {
  /** The run's index: 0 is the first (horizontal) run, 2 × xs.length the last. */
  k: number;
  x: number;
  y: number;
  vertical: boolean;
}

export function endsOf(points: readonly Pt[]): Ends {
  const [sx, sy] = points[0]!;
  const [tx, ty] = points[points.length - 1]!;
  return { sx, sy, tx, ty };
}

/** The canonical path H V H … H, zero-length runs included, so run k is points k → k+1. */
export function pointsOfShape(e: Ends, b: Bends): Pt[] {
  if (b.xs.length === 0) return [[e.sx, e.sy], [e.tx, e.ty]];
  const pts: Pt[] = [[e.sx, e.sy]];
  let y = e.sy;
  b.xs.forEach((x, i) => {
    pts.push([x, y]);
    y = i < b.ys.length ? b.ys[i]! : e.ty;
    pts.push([x, y]);
  });
  pts.push([e.tx, e.ty]);
  return pts;
}

/** The bends of any right-angled path that starts and ends horizontally (a router route, simplified or not). */
export function shapeFromPoints(pts: readonly Pt[]): Bends {
  const runs: ({ v: true; x: number } | { v: false; y: number })[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i]!, [bx, by] = pts[i + 1]!;
    if (ax === bx && ay === by) continue;
    const v = ax === bx;
    if (runs.length > 0 && runs[runs.length - 1]!.v === v) continue;
    runs.push(v ? { v: true, x: ax } : { v: false, y: ay });
  }
  const xs: number[] = [], ys: number[] = [];
  runs.forEach((r, i) => {
    if (r.v) xs.push(r.x);
    else if (xs.length > 0 && runs.slice(i + 1).some((n) => n.v)) ys.push(r.y);
  });
  return { xs, ys };
}

/** Lines up runs that meet, drops bends that no longer turn; null when the path is straight. */
export function normalize(e: Ends, b: Bends): Bends | null {
  const s = shapeFromPoints(simplify(pointsOfShape(e, b)));
  return s.xs.length === 0 ? null : s;
}

/**
 * Run k dragged to p (spec §4.2): a vertical run moves sideways, an inner horizontal one up or down. The
 * first run leaves a fixed port, so it gets a jog first (on a straight wire, at both ends). The last run
 * slides the landing instead: its new height comes back as `landingY` (absolute, snapped).
 */
export function dragSegment(b: Bends, k: number, p: { x: number; y: number }, e: Ends): { bends: Bends } | { landingY: number } {
  const n = b.xs.length;
  const y = snap(p.y, GRID), x = snap(p.x, GRID);
  if (n === 0) return { bends: { xs: [snap(e.sx + JOG), snap(e.tx - JOG)], ys: [y] } };
  if (k === 0) return { bends: { xs: [snap(e.sx + JOG), ...b.xs], ys: [y, ...b.ys] } };
  if (k === 2 * n) return { landingY: y };
  if (k % 2 === 1) return { bends: { xs: b.xs.map((v, i) => (i === (k - 1) / 2 ? x : v)), ys: [...b.ys] } };
  return { bends: { xs: [...b.xs], ys: b.ys.map((v, i) => (i === k / 2 - 1 ? y : v)) } };
}

export function segmentHandles(e: Ends, b: Bends): SegmentHandle[] {
  const pts = pointsOfShape(e, b);
  const out: SegmentHandle[] = [];
  for (let k = 0; k < pts.length - 1; k++) {
    const [ax, ay] = pts[k]!, [bx, by] = pts[k + 1]!;
    if (ax === bx && ay === by) continue;
    out.push({ k, x: (ax + bx) / 2, y: (ay + by) / 2, vertical: ax === bx });
  }
  return out;
}

export function nearestSegment(e: Ends, b: Bends, p: { x: number; y: number }): number {
  const pts = pointsOfShape(e, b);
  let best = 0, bestD = Infinity;
  for (let k = 0; k < pts.length - 1; k++) {
    const [ax, ay] = pts[k]!, [bx, by] = pts[k + 1]!;
    if (ax === bx && ay === by) continue;
    const cx = Math.min(Math.max(p.x, Math.min(ax, bx)), Math.max(ax, bx));
    const cy = Math.min(Math.max(p.y, Math.min(ay, by)), Math.max(ay, by));
    const d = Math.hypot(p.x - cx, p.y - cy);
    if (d < bestD) { bestD = d; best = k; }
  }
  return best;
}
