import { GRID, HALF_CLEAR, STUB, TRACK, snap } from './geometry';
import { route, simplify, type Box, type Pt } from './router';

/** What a bend costs, in px of length (several grid steps: Visio's routes bend little). */
const BEND = 40;
/** What a px costs inside a block's 64 px clearance (a narrow gap is used only when going round is dearer). */
const NEAR = 2;
/** What a px costs beside another net's run, closer than a track (32). */
const BESIDE = 4;
/** What a px costs on another net's run: a short circuit, so in effect never, but a route always exists. */
const ON_COST = 1000;

interface Run { at: number; lo: number; hi: number }

/** The first index in `runs` (sorted by `at`) whose `at` is at least `v`. */
function lowerBound(runs: readonly Run[], v: number): number {
  let lo = 0, hi = runs.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (runs[m]!.at < v) lo = m + 1; else hi = m; }
  return lo;
}

/**
 * Other nets' runs as drawn (plan 10 phase 3, spec §4.2.1): what a route must not lie on, and keeps a track (32 px)
 * off where it can.
 */
export class Tracks {
  private readonly level: Run[] = [];
  private readonly upright: Run[] = [];
  private sorted = true;

  add(points: readonly Pt[]): void {
    for (let i = 1; i < points.length; i++) {
      const [ax, ay] = points[i - 1]!, [bx, by] = points[i]!;
      if (ay === by && ax !== bx) this.level.push({ at: ay, lo: Math.min(ax, bx), hi: Math.max(ax, bx) });
      else if (ax === bx && ay !== by) this.upright.push({ at: ax, lo: Math.min(ay, by), hi: Math.max(ay, by) });
    }
    this.sorted = false;
  }

  private sort(): void {
    if (this.sorted) return;
    this.level.sort((a, b) => a.at - b.at);
    this.upright.sort((a, b) => a.at - b.at);
    this.sorted = true;
  }

  /** How many px of the run a → b lie on another net's run, and how many beside one (parallel, nearer than a track). */
  near(a: Pt, b: Pt): { on: number; beside: number } {
    this.sort();
    const levelRun = a[1] === b[1];
    const runs = levelRun ? this.level : this.upright;
    const at = levelRun ? a[1] : a[0];
    const lo = levelRun ? Math.min(a[0], b[0]) : Math.min(a[1], b[1]), hi = levelRun ? Math.max(a[0], b[0]) : Math.max(a[1], b[1]);
    let on = 0, beside = 0;
    for (let i = lowerBound(runs, at - TRACK + 0.01); i < runs.length && runs[i]!.at < at + TRACK; i++) {
      const r = runs[i]!, shared = Math.min(hi, r.hi) - Math.max(lo, r.lo);
      if (shared <= 0) continue;
      if (Math.abs(r.at - at) < 0.01) on += shared; else beside += shared;
    }
    return { on, beside };
  }

  costOf(points: readonly Pt[]): { on: number; beside: number } {
    let on = 0, beside = 0;
    for (let i = 1; i < points.length; i++) {
      const n = this.near(points[i - 1]!, points[i]!);
      on += n.on; beside += n.beside;
    }
    return { on, beside };
  }

  /** The lines a track off each run lies on: upright (x) ones and level (y) ones, its ends a track past included. */
  lines(): { xs: number[]; ys: number[] } {
    const xs: number[] = [], ys: number[] = [];
    for (const r of this.upright) { xs.push(r.at - TRACK, r.at + TRACK); ys.push(r.lo - TRACK, r.hi + TRACK); }
    for (const r of this.level) { ys.push(r.at - TRACK, r.at + TRACK); xs.push(r.lo - TRACK, r.hi + TRACK); }
    return { xs, ys };
  }
}

/** The run a → b lies strictly inside `box` grown by `g` (along its border is not inside). */
function inside(a: Pt, b: Pt, box: Box, g: number): boolean {
  return Math.max(a[0], b[0]) > box.x - g && Math.min(a[0], b[0]) < box.x + box.w + g
    && Math.max(a[1], b[1]) > box.y - g && Math.min(a[1], b[1]) < box.y + box.h + g;
}

/** How many px of the run a → b lie strictly inside `box` grown by `g`. */
function lengthInside(a: Pt, b: Pt, box: Box, g: number): number {
  const x1 = box.x - g, x2 = box.x + box.w + g, y1 = box.y - g, y2 = box.y + box.h + g;
  if (a[1] === b[1]) return a[1] > y1 && a[1] < y2 ? Math.max(0, Math.min(Math.max(a[0], b[0]), x2) - Math.max(Math.min(a[0], b[0]), x1)) : 0;
  return a[0] > x1 && a[0] < x2 ? Math.max(0, Math.min(Math.max(a[1], b[1]), y2) - Math.max(Math.min(a[1], b[1]), y1)) : 0;
}

/**
 * A wire from a block's output `s` to a block's input `t` (plan 10 phase 3, spec §4.2, §4.3), routed as Visio routes a
 * connector glued to points: out of `src` and into `tgt` square-on through a 64 px stub (mid-gap when the blocks are
 * nearer than two stubs). First Visio's own shape is tried:
 * - straight, for level ends;
 * - a Z with its upright at the source's stub, for a target ahead;
 * - the U of spec §4.3, for a target behind. Its return run lies in the free band, 64 off the target, or over the top
 *   of both.
 *
 * The shape is kept when it runs inside no block (another's grown by half the clearance: a narrow gap is used) and lies
 * on and beside none of `tracks`, the other nets' runs. Otherwise an orthogonal path search finds the cheapest way: by
 * length, bends, a block's clearance entered and other nets' runs, then hugging what it goes round (uprights near the
 * target's stub, as Visio's come back down there), then up. The search is bounded near the ends first. With no way at
 * all, the old menu of shapes (`route`) answers.
 */
export function routeBlocks(s: Pt, t: Pt, src: Box, tgt: Box, boxes: readonly Box[], tracks: Tracks = new Tracks()): Pt[] {
  const [sx, sy] = s, [tx, ty] = t;
  const gap = tx - sx;
  const ahead = gap >= 2 * GRID;
  const ax = ahead && gap < 2 * STUB ? snap((sx + tx) / 2) : sx + STUB;
  const bx = ahead && gap < 2 * STUB ? ax : tx - STUB;
  const own = (b: Box) => b.id === src.id || b.id === tgt.id;
  const blocked = (a: Pt, b: Pt, near: readonly Box[]) => near.some((box) => inside(a, b, box, own(box) ? 0 : HALF_CLEAR));
  const kept = (pts: readonly Pt[]) => {
    for (let i = 1; i < pts.length; i++) if (blocked(pts[i - 1]!, pts[i]!, boxes)) return false;
    const c = tracks.costOf(pts);
    return c.on === 0 && c.beside === 0;
  };

  let base: Pt[];
  if (sy === ty && tx > sx) base = [s, t];
  else if (ahead) base = [s, [ax, sy], [ax, ty], t];
  else {
    const below = tgt.y >= src.y + src.h, above = tgt.y + tgt.h <= src.y;
    let level = Math.min(src.y, tgt.y) - STUB;
    if (below && tgt.y - STUB >= src.y + src.h + HALF_CLEAR) level = tgt.y - STUB;
    else if (above && tgt.y + tgt.h + STUB <= src.y - HALF_CLEAR) level = tgt.y + tgt.h + STUB;
    level = snap(level);
    base = [s, [ax, sy], [ax, level], [bx, level], [bx, ty], t];
  }
  base = simplify(base);
  if (kept(base)) return base;

  const a: Pt = [ax, sy], b: Pt = [bx, ty];
  const lo = (...v: number[]) => Math.min(...v), hi = (...v: number[]) => Math.max(...v);
  const bound = {
    x1: lo(ax, bx, src.x, tgt.x) - 3 * STUB, x2: hi(ax, bx, src.x + src.w, tgt.x + tgt.w) + 3 * STUB,
    y1: lo(sy, ty, src.y, tgt.y) - 3 * STUB, y2: hi(sy, ty, src.y + src.h, tgt.y + tgt.h) + 3 * STUB,
  };
  const found = search(a, b, sy, boxes, tracks, own, bound) ?? search(a, b, sy, boxes, tracks, own, null);
  if (found) return simplify([s, ...found, t]);
  return route(sx, sy, tx, ty, src.id, tgt.id, 0, [...boxes]);
}

interface Bound { x1: number; x2: number; y1: number; y2: number }

/** 0: +x, 1: +y, 2: -x, 3: -y */
const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];

/**
 * Dijkstra over (grid node, heading), costs compared in order: [length + bends + clearance + other nets' runs, Σ upright
 * length × its distance from the target's stub, level length below the source's line]. From `a` heading +x (the stub
 * just left), to `b` not heading -x (the stub into the target follows, heading +x). Null when no way exists.
 */
function search(a: Pt, b: Pt, sy: number, boxes: readonly Box[], tracks: Tracks, own: (box: Box) => boolean, bound: Bound | null): Pt[] | null {
  const within = (box: Box) => bound === null
    || (box.x - STUB < bound.x2 && box.x + box.w + STUB > bound.x1 && box.y - STUB < bound.y2 && box.y + box.h + STUB > bound.y1);
  const near = boxes.filter(within);
  const xsAll = [a[0], b[0]], ysAll = [a[1], b[1]];
  for (const box of near) {
    for (const g of [STUB, HALF_CLEAR]) {
      xsAll.push(snap(box.x - g), snap(box.x + box.w + g));
      ysAll.push(snap(box.y - g), snap(box.y + box.h + g));
    }
  }
  const t = tracks.lines();
  xsAll.push(...t.xs.map((v) => snap(v)));
  ysAll.push(...t.ys.map((v) => snap(v)));
  if (bound) { xsAll.push(snap(bound.x1), snap(bound.x2)); ysAll.push(snap(bound.y1), snap(bound.y2)); }
  const keep = (v: number, l: number, h: number, must: number[]) => must.includes(v) || bound === null || (v >= l && v <= h);
  const xs = [...new Set(xsAll)].filter((v) => keep(v, bound?.x1 ?? 0, bound?.x2 ?? 0, [a[0], b[0]])).sort((p, q) => p - q);
  const ys = [...new Set(ysAll)].filter((v) => keep(v, bound?.y1 ?? 0, bound?.y2 ?? 0, [a[1], b[1]])).sort((p, q) => p - q);
  const W = xs.length, H = ys.length, N = W * H;
  const start = xs.indexOf(a[0]) + W * ys.indexOf(a[1]);
  const goal = xs.indexOf(b[0]) + W * ys.indexOf(b[1]);
  const pt = (n: number): Pt => [xs[n % W]!, ys[Math.floor(n / W)]!];

  // an edge's cost, by (node, heading): [primary, hug, below], or null when it runs inside a block
  const edges = new Map<number, [number, number, number] | null>();
  const edge = (n: number, d: number): [number, number, number] | null => {
    const k = n * 4 + d;
    const known = edges.get(k);
    if (known !== undefined) return known;
    const i = n % W, j = Math.floor(n / W), ni = i + DX[d]!, nj = j + DY[d]!;
    let c: [number, number, number] | null = null;
    if (ni >= 0 && ni < W && nj >= 0 && nj < H) {
      const p = pt(n), q = pt(ni + W * nj);
      if (!near.some((box) => inside(p, q, box, own(box) ? 0 : HALF_CLEAR))) {
        const len = Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]);
        let soft = 0;
        for (const box of near) soft += lengthInside(p, q, box, STUB);
        const tr = tracks.near(p, q);
        const level = d === 0 || d === 2;
        c = [len + NEAR * soft + ON_COST * tr.on + BESIDE * tr.beside, level ? 0 : len * Math.abs(p[0] - b[0]), level && p[1] > sy ? len : 0];
      }
    }
    edges.set(k, c);
    return c;
  };

  const S = N * 4;
  const d0 = new Float64Array(S).fill(Infinity), d1 = new Float64Array(S), d2 = new Float64Array(S);
  const prev = new Int32Array(S).fill(-1);
  const less = (p0: number, p1: number, p2: number, q0: number, q1: number, q2: number) =>
    p0 !== q0 ? p0 < q0 : p1 !== q1 ? p1 < q1 : p2 < q2;
  const heap = new Heap(less);
  const s0 = start * 4;
  d0[s0] = 0;
  heap.push(0, 0, 0, s0);
  let best = -1, b0 = Infinity, b1 = 0, b2 = 0;
  while (heap.size > 0) {
    const [c0, c1, c2, k] = heap.pop();
    if (c0 !== d0[k] || c1 !== d1[k] || c2 !== d2[k]) continue;
    if (best >= 0 && !less(c0, c1, c2, b0, b1, b2)) break;
    const n = k >> 2, d = k & 3;
    if (n === goal && d !== 2) {
      const f0 = c0 + (d === 0 ? 0 : BEND);
      if (best < 0 || less(f0, c1, c2, b0, b1, b2)) { best = k; b0 = f0; b1 = c1; b2 = c2; }
    }
    for (let nd = 0; nd < 4; nd++) {
      if (nd === (d + 2) % 4) continue;
      const e = edge(n, nd);
      if (e === null) continue;
      const nn = n + DX[nd]! + W * DY[nd]!;
      const nk = nn * 4 + nd;
      const e0 = c0 + e[0] + (nd === d ? 0 : BEND), e1 = c1 + e[1], e2 = c2 + e[2];
      if (less(e0, e1, e2, d0[nk]!, d1[nk]!, d2[nk]!)) {
        d0[nk] = e0; d1[nk] = e1; d2[nk] = e2; prev[nk] = k;
        heap.push(e0, e1, e2, nk);
      }
    }
  }
  if (best < 0) return null;
  const path: Pt[] = [];
  for (let k = best; k >= 0; k = prev[k]!) path.push(pt(k >> 2));
  return path.reverse();
}

/** A binary min-heap of (cost, cost, cost, key), ordered by `less`. */
class Heap {
  private readonly a: [number, number, number, number][] = [];
  constructor(private readonly less: (p0: number, p1: number, p2: number, q0: number, q1: number, q2: number) => boolean) {}
  get size(): number { return this.a.length; }
  private lt(i: number, j: number): boolean { const p = this.a[i]!, q = this.a[j]!; return this.less(p[0], p[1], p[2], q[0], q[1], q[2]); }
  push(c0: number, c1: number, c2: number, k: number): void {
    const a = this.a;
    a.push([c0, c1, c2, k]);
    for (let i = a.length - 1; i > 0; ) {
      const p = (i - 1) >> 1;
      if (!this.lt(i, p)) break;
      [a[i], a[p]] = [a[p]!, a[i]!];
      i = p;
    }
  }
  pop(): [number, number, number, number] {
    const a = this.a, top = a[0]!, last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && this.lt(l, m)) m = l;
        if (r < a.length && this.lt(r, m)) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m]!, a[i]!];
        i = m;
      }
    }
    return top;
  }
}
