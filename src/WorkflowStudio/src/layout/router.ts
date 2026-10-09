import { COLUMN_PITCH, GRID, STEP_W, snap } from './geometry';

export type Pt = readonly [number, number];

export interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const BEND_COST = 24;
const HIT_COST = 5000;
/** A stretch shared with a wire of another net is a short circuit (the user's rule 2, 2026-10-09): worse than a block crossed. */
const OVERLAP_COST = 2 * HIT_COST;
const HIT_MARGIN = 3;
export const CLEARANCE = 24;

function segmentHits(a: Pt, b: Pt, box: Box): boolean {
  const x1 = Math.min(a[0], b[0]), x2 = Math.max(a[0], b[0]);
  const y1 = Math.min(a[1], b[1]), y2 = Math.max(a[1], b[1]);
  return x2 > box.x - HIT_MARGIN && x1 < box.x + box.w + HIT_MARGIN && y2 > box.y - HIT_MARGIN && y1 < box.y + box.h + HIT_MARGIN;
}

/** How many blocks the segments cross (the source's own box is allowed for the first segment, the target's for the last). */
export function hitsOf(pts: readonly Pt[], srcId: string, tgtId: string, boxes: readonly Box[]): number {
  let hits = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!, b = pts[i + 1]!;
    for (const box of boxes) {
      if ((box.id === srcId && i === 0) || (box.id === tgtId && i === pts.length - 2)) continue;
      if (segmentHits(a, b, box)) hits++;
    }
  }
  return hits;
}

/** Length + 24 per bend + 5000 per block a segment crosses (`hitsOf`). */
function cost(pts: Pt[], srcId: string, tgtId: string, boxes: Box[]): number {
  let length = 0;
  for (let i = 0; i < pts.length - 1; i++) length += Math.abs(pts[i]![0] - pts[i + 1]![0]) + Math.abs(pts[i]![1] - pts[i + 1]![1]);
  return length + (pts.length - 2) * BEND_COST + hitsOf(pts, srcId, tgtId, boxes) * HIT_COST;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** Drops repeated points and points that lie on the line between their neighbours. */
export function simplify(pts: Pt[]): Pt[] {
  const unique = pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1]![0] || p[1] !== pts[i - 1]![1]);
  return unique.filter((p, i) => {
    if (i === 0 || i === unique.length - 1) return true;
    const a = unique[i - 1]!, b = unique[i + 1]!;
    return !((a[0] === p[0] && p[0] === b[0]) || (a[1] === p[1] && p[1] === b[1]));
  });
}

/** What else a route weighs (the user's rule 2, 2026-10-09). */
export interface RouteAvoid {
  /** How many stretches a candidate shares with wires of other nets (each costs more than a block crossed). */
  avoid?: (pts: Pt[]) => number;
  /** Moves the candidates' own runs off their usual tracks (a multiple of the grid): their elbows, and the U's levels outward. */
  spread?: number;
}

/**
 * An orthogonal route from a source port (sx, sy) to a landing (tx, ty), the cheapest of: straight;
 * Z with its elbow at 50 / 30 / 70 % of the gap or 16 px from either end; and U shapes over or under
 * the blocks in the way. `nudge` is the wire's fan-out offset, so sibling wires keep distinct
 * vertical runs. Every candidate point is on the 8 px grid when its inputs are. `o.avoid` makes a
 * candidate lying on another net's wire dear; `o.spread` gives every candidate a track of its own.
 */
export function route(sx: number, sy: number, tx: number, ty: number, srcId: string, tgtId: string, nudge: number, boxes: Box[], o: RouteAvoid = {}): Pt[] {
  const candidates: Pt[][] = [];
  const spread = o.spread ?? 0;

  // Level and to the right: straight is always on offer (the landing rule sends such wires from a
  // gap of STRAIGHT_MIN_GAP, below the CLEARANCE the bent shapes need).
  if (sy === ty && tx > sx) candidates.push([[sx, sy], [tx, ty]]);
  if (tx - sx >= CLEARANCE) {
    for (const f of [0.5, 0.3, 0.7]) {
      const mx = snap(sx + (tx - sx) * f) + nudge + spread;
      candidates.push([[sx, sy], [mx, sy], [mx, ty], [tx, ty]]);
    }
    candidates.push(
      [[sx, sy], [sx + 16 + nudge + Math.abs(spread), sy], [sx + 16 + nudge + Math.abs(spread), ty], [tx, ty]],
      [[sx, sy], [tx - 16 - Math.abs(spread), sy], [tx - 16 - Math.abs(spread), ty], [tx, ty]],
    );
  }
  // A forward gap of 16 to 23 px is too short for the shapes above; a Z with its elbow one grid step
  // past the source still beats a U that crosses both blocks (parked since plan 2).
  if (tx - sx >= 2 * GRID && tx - sx < CLEARANCE && sy !== ty) {
    candidates.push([[sx, sy], [sx + GRID, sy], [sx + GRID, ty], [tx, ty]]);
  }

  // The U's first vertical must stay in the free gap right of the source: at least one grid step off
  // its edge (a large negative fan-out nudge must not pull it back through the source) and at least
  // one grid step short of the next column (the gap is COLUMN_PITCH - STEP_W = 64; a large positive
  // nudge must not land it on the neighbouring block's edge).
  const x1 = sx + clamp(CLEARANCE + nudge + spread, GRID, COLUMN_PITCH - STEP_W - GRID), x2 = tx - CLEARANCE - Math.abs(spread);
  const lo = Math.min(x1, x2), hi = Math.max(x1, x2);
  const span = boxes.filter((b) => b.x < hi + 20 && b.x + b.w > lo - 20);
  const levels = new Set<number>();
  if (span.length > 0) {
    levels.add(Math.min(...span.map((b) => b.y)) - CLEARANCE);
    levels.add(Math.max(...span.map((b) => b.y + b.h)) + CLEARANCE);
  }
  for (const id of [srcId, tgtId]) {
    const b = boxes.find((x) => x.id === id);
    if (b) { levels.add(b.y - CLEARANCE); levels.add(b.y + b.h + CLEARANCE); }
  }
  if (levels.size === 0) levels.add(Math.max(sy, ty) + CLEARANCE);
  for (const level of levels) {
    // a spread U goes further out: above the blocks higher, below them lower
    const ly = spread === 0 ? level : level + (level < Math.min(sy, ty) ? -1 : 1) * Math.abs(spread);
    candidates.push([[sx, sy], [x1, sy], [x1, ly], [x2, ly], [x2, ty], [tx, ty]]);
  }

  let best: Pt[] = candidates[0]!, bestCost = Infinity;
  for (const candidate of candidates) {
    const pts = simplify(candidate);
    const c = cost(pts, srcId, tgtId, boxes) + (o.avoid ? o.avoid(pts) * OVERLAP_COST : 0);
    if (c < bestCost) { bestCost = c; best = pts; }
  }
  return best;
}
