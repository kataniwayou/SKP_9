import { snap } from './geometry';

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
const HIT_MARGIN = 3;
const CLEARANCE = 24;

function segmentHits(a: Pt, b: Pt, box: Box): boolean {
  const x1 = Math.min(a[0], b[0]), x2 = Math.max(a[0], b[0]);
  const y1 = Math.min(a[1], b[1]), y2 = Math.max(a[1], b[1]);
  return x2 > box.x - HIT_MARGIN && x1 < box.x + box.w + HIT_MARGIN && y2 > box.y - HIT_MARGIN && y1 < box.y + box.h + HIT_MARGIN;
}

/** Length + 24 per bend + 5000 per block a segment crosses (the source's own box is allowed for the
 *  first segment, the target's for the last). */
function cost(pts: Pt[], srcId: string, tgtId: string, boxes: Box[]): number {
  let length = 0, hits = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!, b = pts[i + 1]!;
    length += Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
    for (const box of boxes) {
      if ((box.id === srcId && i === 0) || (box.id === tgtId && i === pts.length - 2)) continue;
      if (segmentHits(a, b, box)) hits++;
    }
  }
  return length + (pts.length - 2) * BEND_COST + hits * HIT_COST;
}

/** Drops repeated points and points that lie on the line between their neighbours. */
export function simplify(pts: Pt[]): Pt[] {
  const unique = pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1]![0] || p[1] !== pts[i - 1]![1]);
  return unique.filter((p, i) => {
    if (i === 0 || i === unique.length - 1) return true;
    const a = unique[i - 1]!, b = unique[i + 1]!;
    return !((a[0] === p[0] && p[0] === b[0]) || (a[1] === p[1] && p[1] === b[1]));
  });
}

/**
 * An orthogonal route from a source port (sx, sy) to a landing (tx, ty), the cheapest of: straight;
 * Z with its elbow at 50 / 30 / 70 % of the gap or 16 px from either end; and U shapes over or under
 * the blocks in the way. `nudge` is the wire's fan-out offset, so sibling wires keep distinct
 * vertical runs. Every candidate point is on the 8 px grid when its inputs are.
 */
export function route(sx: number, sy: number, tx: number, ty: number, srcId: string, tgtId: string, nudge: number, boxes: Box[]): Pt[] {
  const candidates: Pt[][] = [];

  if (tx - sx >= CLEARANCE) {
    if (sy === ty) candidates.push([[sx, sy], [tx, ty]]);
    for (const f of [0.5, 0.3, 0.7]) {
      const mx = snap(sx + (tx - sx) * f) + nudge;
      candidates.push([[sx, sy], [mx, sy], [mx, ty], [tx, ty]]);
    }
    candidates.push(
      [[sx, sy], [sx + 16 + nudge, sy], [sx + 16 + nudge, ty], [tx, ty]],
      [[sx, sy], [tx - 16, sy], [tx - 16, ty], [tx, ty]],
    );
  }

  // A large negative fan-out nudge must not pull the U's first vertical back to or through the source's right edge.
  const x1 = sx + CLEARANCE + Math.max(nudge, -16), x2 = tx - CLEARANCE;
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
  for (const ly of levels) candidates.push([[sx, sy], [x1, sy], [x1, ly], [x2, ly], [x2, ty], [tx, ty]]);

  let best: Pt[] = candidates[0]!, bestCost = Infinity;
  for (const candidate of candidates) {
    const pts = simplify(candidate);
    const c = cost(pts, srcId, tgtId, boxes);
    if (c < bestCost) { bestCost = c; best = pts; }
  }
  return best;
}
