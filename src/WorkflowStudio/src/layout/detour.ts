import { GRID, snap } from './geometry';
import { simplify, type Box, type Pt } from './router';
import { pointsOfShape, shapeFromPoints, type Bends, type Ends } from './shape';

/** How far a detour stands off a block's border, and a dragged run is pushed off one (the router's clearance). */
export const DETOUR_CLEARANCE = 24;
const MARGIN = 3;
const BEND_COST = 24;
/** Only blocks this near a blocked run take part in its detour (keeps the search small on big graphs). */
const REACH = 480;

const hits = (a: Pt, b: Pt, box: Box): boolean => {
  const x1 = Math.min(a[0], b[0]), x2 = Math.max(a[0], b[0]);
  const y1 = Math.min(a[1], b[1]), y2 = Math.max(a[1], b[1]);
  return x2 > box.x - MARGIN && x1 < box.x + box.w + MARGIN && y2 > box.y - MARGIN && y1 < box.y + box.h + MARGIN;
};
const inside = (p: Pt, box: Box): boolean =>
  p[0] >= box.x - MARGIN && p[0] <= box.x + box.w + MARGIN && p[1] >= box.y - MARGIN && p[1] <= box.y + box.h + MARGIN;

/** 0: +x, 1: +y, 2: -x, 3: -y */
const dirOf = (a: Pt, b: Pt): number => (a[1] === b[1] ? (b[0] > a[0] ? 0 : 2) : (b[1] > a[1] ? 1 : 3));

/**
 * The cheapest right-angled way from `s` to `e` around `boxes` (length + 24 a bend), on the lines that
 * stand DETOUR_CLEARANCE off each block. A block holding `s` (or `e`) may only be left (or entered) by the
 * first (or last) move, heading `din` (or `dout`): a port's wire leaves its block straight out. No move
 * turns back on the one before, nor on the run before `s` (`din`), and the last does not head `notOut`
 * (the run after `e` would turn back on it). Null when no way exists.
 */
function search(s: Pt, e: Pt, din: number, dout: number | null, notOut: number | null, boxes: Box[]): Pt[] | null {
  const lo = (v: number[]) => Math.min(...v), hi = (v: number[]) => Math.max(...v);
  const near = boxes.filter((b) => b.x < hi([s[0], e[0]]) + REACH && b.x + b.w > lo([s[0], e[0]]) - REACH
    && b.y < hi([s[1], e[1]]) + REACH && b.y + b.h > lo([s[1], e[1]]) - REACH);
  const xs = [...new Set([s[0], e[0], ...near.flatMap((b) => [snap(b.x - DETOUR_CLEARANCE, GRID), snap(b.x + b.w + DETOUR_CLEARANCE, GRID)])])].sort((a, b) => a - b);
  const ys = [...new Set([s[1], e[1], ...near.flatMap((b) => [snap(b.y - DETOUR_CLEARANCE, GRID), snap(b.y + b.h + DETOUR_CLEARANCE, GRID)])])].sort((a, b) => a - b);
  const W = xs.length, H = ys.length;
  const atS = near.filter((b) => inside(s, b)), atE = near.filter((b) => inside(e, b));
  const si = xs.indexOf(s[0]) + W * ys.indexOf(s[1]), ei = xs.indexOf(e[0]) + W * ys.indexOf(e[1]);
  const pt = (n: number): Pt => [xs[n % W]!, ys[Math.floor(n / W)]!];
  const step = (n: number, d: number): number => {
    const x = n % W, y = Math.floor(n / W);
    if (d === 0) return x + 1 < W ? n + 1 : -1;
    if (d === 2) return x > 0 ? n - 1 : -1;
    if (d === 1) return y + 1 < H ? n + W : -1;
    return y > 0 ? n - W : -1;
  };
  const free = (a: number, b: number, d: number): boolean => {
    const pa = pt(a), pb = pt(b);
    for (const box of near) {
      if (!hits(pa, pb, box)) continue;
      // a port's own block lets its wire out (or in) straight, and nowhere else
      if (a === si && atS.includes(box) && d === din) continue;
      if (b === ei && atE.includes(box) && dout !== null && d === dout) continue;
      return false;
    }
    return true;
  };

  // Dijkstra over (node, heading); small graphs, so a sorted array stands in for a heap
  const key = (n: number, d: number) => n * 4 + d;
  const dist = new Map<number, number>(), prev = new Map<number, number>();
  const open: [number, number, number][] = [[0, si, din]];
  dist.set(key(si, din), 0);
  while (open.length > 0) {
    let m = 0;
    for (let i = 1; i < open.length; i++) if (open[i]![0] < open[m]![0]) m = i;
    const [c, n, d] = open.splice(m, 1)[0]!;
    if (c > (dist.get(key(n, d)) ?? Infinity)) continue;
    if (n === ei && n !== si && (dout === null || d === dout) && d !== notOut) {
      const out: Pt[] = [];
      for (let k: number | undefined = key(n, d); k !== undefined; k = prev.get(k)) out.push(pt(Math.floor(k / 4)));
      return out.reverse();
    }
    for (let nd = 0; nd < 4; nd++) {
      if (nd === (d + 2) % 4) continue;
      const nn = step(n, nd);
      if (nn < 0 || !free(n, nn, nd)) continue;
      const [ax, ay] = pt(n), [bx, by] = pt(nn);
      const nc = c + Math.abs(ax - bx) + Math.abs(ay - by) + (nd === d ? 0 : BEND_COST);
      if (nc < (dist.get(key(nn, nd)) ?? Infinity)) {
        dist.set(key(nn, nd), nc);
        prev.set(key(nn, nd), key(n, d));
        open.push([nc, nn, nd]);
      }
    }
  }
  return null;
}

/**
 * A right-angled path that leaves (sx, sy) and lands on (tx, ty) heading +x, kept clear of `boxes`: each
 * run that crosses a block is replaced by a detour around it (spec §4.2, the user's rule: a dragged wire
 * goes around a step, never through it). A run whose detour cannot be found stays as it is.
 */
export function clearPath(points: readonly Pt[], boxes: Box[]): Pt[] {
  // a bend inside a block cannot be kept: its neighbours are joined around the block instead
  const all = simplify([...points]);
  const pts = all.filter((p, i) => i === 0 || i === all.length - 1 || !boxes.some((box) => inside(p, box)));
  const out: Pt[] = [pts[0]!];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = out[out.length - 1]!, b = pts[i + 1]!;
    const last = i === pts.length - 2;
    // a wire leaves its source's port and enters its target's landing straight, heading right: only that
    // crossing of the border is allowed, never a run back through either block
    const right = dirOf(a, b) === 0;
    const blocked = boxes.some((box) => hits(a, b, box) && !(i === 0 && right && inside(a, box)) && !(last && right && inside(b, box)));
    const square = a[0] === b[0] || a[1] === b[1];
    if (!blocked && square) { out.push(b); continue; }
    // the heading into this run: the run before it, or +x from the source port
    const din = out.length > 1 ? dirOf(out[out.length - 2]!, a) : 0;
    const next = pts[i + 2];
    const notOut = last || !next || (next[0] !== b[0] && next[1] !== b[1]) ? null : (dirOf(b, next) + 2) % 4;
    const way = search(a, b, i === 0 ? 0 : din, last ? 0 : null, notOut, boxes);
    if (way) out.push(...way.slice(1));
    else if (square) out.push(b);
    else {
      // no way around: still right-angled, with its elbow halfway
      const mx = snap((a[0] + b[0]) / 2, GRID);
      out.push([mx, a[1]], [mx, b[1]], b);
    }
  }
  return simplify(out);
}

/** Length + 24 a bend, + a block's worth for every run still through a block (the source and target only straight in and out). */
function costOf(pts: Pt[], boxes: Box[]): number {
  let c = (pts.length - 2) * BEND_COST;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!, b = pts[i + 1]!, right = dirOf(a, b) === 0;
    c += Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
    const last = i === pts.length - 2;
    for (const box of boxes) {
      if (hits(a, b, box) && !(i === 0 && right && inside(a, box)) && !(last && right && inside(b, box))) c += 5000;
    }
  }
  return c;
}

/** The run under the pointer: points 2i+1 → 2i+2 for xs[i], 2i+2 → 2i+3 for ys[i]. */
function runPoints(ends: Ends, b: Bends, run: { vertical: boolean; index: number }): [Pt, Pt] {
  const pts = pointsOfShape(ends, b);
  return run.vertical ? [pts[2 * run.index + 1]!, pts[2 * run.index + 2]!] : [pts[2 * run.index + 2]!, pts[2 * run.index + 3]!];
}

/**
 * Run `k`'s new position pushed off the blocks it would lie on (spec §4.2): a vertical run moves left or
 * right, a horizontal one up or down, to the side of the block that makes the shorter clear wire. The
 * source's and the target's own blocks count too: a run never lies inside a step.
 */
export function clearRun(bends: Bends, ends: Ends, run: { vertical: boolean; index: number }, boxes: Box[]): Bends {
  let cur: Bends = { xs: [...bends.xs], ys: [...bends.ys] };
  for (let pass = 0; pass < 4; pass++) {
    const [a, b] = runPoints(ends, cur, run);
    const box = boxes.find((bx) => hits(a, b, bx));
    if (!box) break;
    const sides = run.vertical
      ? [snap(box.x - DETOUR_CLEARANCE, GRID), snap(box.x + box.w + DETOUR_CLEARANCE, GRID)]
      : [snap(box.y - DETOUR_CLEARANCE, GRID), snap(box.y + box.h + DETOUR_CLEARANCE, GRID)];
    const options = sides.map((v): Bends => (run.vertical
      ? { xs: cur.xs.map((x, i) => (i === run.index ? v : x)), ys: [...cur.ys] }
      : { xs: [...cur.xs], ys: cur.ys.map((y, i) => (i === run.index ? v : y)) }));
    // the side nearer where the run was dragged wins, unless the other makes a much clearer wire
    const was = run.vertical ? cur.xs[run.index]! : cur.ys[run.index]!;
    const costs = options.map((o, j) => costOf(clearPath(pointsOfShape(ends, o), boxes), boxes) + 10 * Math.abs(sides[j]! - was));
    cur = costs[0]! <= costs[1]! ? options[0]! : options[1]!;
  }
  return cur;
}

/** A manual shape kept clear of the blocks: its runs detour around any block they would cross. */
export function clearBends(ends: Ends, bends: Bends, boxes: Box[]): Bends {
  return shapeFromPoints(clearPath(pointsOfShape(ends, bends), boxes));
}
