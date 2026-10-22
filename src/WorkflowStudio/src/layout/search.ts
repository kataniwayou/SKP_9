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
/** What crossing another net's run costs (a line jump): a tidy drawing crosses little. */
const CROSS = 48;

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

  /**
   * How many px of the run a → b lie on another net's run, how many beside one (parallel, nearer than a track), and how
   * many runs it crosses (one on its far end's line counts, one on its near end's does not, so a path's runs count each
   * crossing once).
   */
  near(a: Pt, b: Pt): { on: number; beside: number; crosses: number } {
    this.sort();
    const levelRun = a[1] === b[1];
    const runs = levelRun ? this.level : this.upright, across = levelRun ? this.upright : this.level;
    const at = levelRun ? a[1] : a[0];
    const lo = levelRun ? Math.min(a[0], b[0]) : Math.min(a[1], b[1]), hi = levelRun ? Math.max(a[0], b[0]) : Math.max(a[1], b[1]);
    let on = 0, beside = 0, crosses = 0;
    for (let i = lowerBound(runs, at - TRACK + 0.01); i < runs.length && runs[i]!.at < at + TRACK; i++) {
      const r = runs[i]!, shared = Math.min(hi, r.hi) - Math.max(lo, r.lo);
      if (shared <= 0) continue;
      if (Math.abs(r.at - at) < 0.01) on += shared; else beside += shared;
    }
    for (let i = lowerBound(across, lo + 0.01); i < across.length && across[i]!.at <= hi; i++) {
      const r = across[i]!;
      if (r.lo < at && at < r.hi) crosses++;
    }
    return { on, beside, crosses };
  }

  costOf(points: readonly Pt[]): { on: number; beside: number } {
    let on = 0, beside = 0;
    for (let i = 1; i < points.length; i++) {
      const n = this.near(points[i - 1]!, points[i]!);
      on += n.on; beside += n.beside;
    }
    return { on, beside };
  }

  /**
   * The lines a track off each run lies on, upright (x) ones and level (y) ones, its ends a track past included; and
   * with `fine`, half and a quarter of a track off too, dearer (beside it) but a way through where the tracks are full
   * ("where they can"). Only of the runs that reach into `bound` (null: all).
   */
  lines(fine: boolean, bound: { x1: number; x2: number; y1: number; y2: number } | null = null): { xs: number[]; ys: number[] } {
    const xs: number[] = [], ys: number[] = [];
    const off = fine ? [TRACK, TRACK / 2, TRACK / 4] : [TRACK];
    const reaches = (x1: number, x2: number, y1: number, y2: number) => bound === null
      || (x2 >= bound.x1 - TRACK && x1 <= bound.x2 + TRACK && y2 >= bound.y1 - TRACK && y1 <= bound.y2 + TRACK);
    for (const r of this.upright) {
      if (!reaches(r.at, r.at, r.lo, r.hi)) continue;
      for (const o of off) xs.push(r.at - o, r.at + o);
      ys.push(r.lo - TRACK, r.hi + TRACK);
    }
    for (const r of this.level) {
      if (!reaches(r.lo, r.hi, r.at, r.at)) continue;
      for (const o of off) ys.push(r.at - o, r.at + o);
      xs.push(r.lo - TRACK, r.hi + TRACK);
    }
    return { xs, ys };
  }
}

/** The run a → b lies strictly inside `box` grown by `g` (along its border is not inside). */
function inside(a: Pt, b: Pt, box: Box, g: number): boolean {
  return Math.max(a[0], b[0]) > box.x - g && Math.min(a[0], b[0]) < box.x + box.w + g
    && Math.max(a[1], b[1]) > box.y - g && Math.min(a[1], b[1]) < box.y + box.h + g;
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

  const lo = (...v: number[]) => Math.min(...v), hi = (...v: number[]) => Math.max(...v);
  const bound = {
    x1: lo(ax, bx, src.x, tgt.x) - 3 * STUB, x2: hi(ax, bx, src.x + src.w, tgt.x + tgt.w) + 3 * STUB,
    y1: lo(sy, ty, src.y, tgt.y) - 3 * STUB, y2: hi(sy, ty, src.y + src.h, tgt.y + tgt.h) + 3 * STUB,
  };
  const ends: Ends = { sx, sy, tx, ty, src: src.id, tgt: tgt.id };
  // first on the coarse grid (the blocks' clearance lines, a track off other nets' runs); only when that finds no way, or
  // one on another net's run, on the fine one too (half and a quarter track off them, every grid line by the ports), and
  // last unbounded (review 2026-10-22: the fine grid everywhere cost 100-500 ms a workflow)
  const columns: number[] = [];
  for (let v = GRID; v < STUB; v += GRID) columns.push(sx + v, tx - v);
  const coarse = search(ends, bx, boxes, tracks, [], false, bound);
  if (coarse && tracks.costOf(coarse).on === 0) return simplify(coarse);
  const found = search(ends, bx, boxes, tracks, columns, true, bound) ?? coarse ?? search(ends, bx, boxes, tracks, columns, true, null);
  if (found) return simplify(found);
  return route(sx, sy, tx, ty, src.id, tgt.id, 0, [...boxes]);
}

interface Bound { x1: number; x2: number; y1: number; y2: number }
/** The wire's two ports and the blocks they are on. */
interface Ends { sx: number; sy: number; tx: number; ty: number; src: string; tgt: string }

/** 0: +x, 1: +y, 2: -x, 3: -y */
const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];

/**
 * Dijkstra over (grid node, heading), costs compared in order: [length + bends + blocks' clearance (its own blocks' only
 * nearer than a track, and not along its ports' lines) + other nets'
 * runs on, beside and crossed, Σ upright
 * length × its distance from the target's stub (`hug`, its x), level length below the source's line]. From the output
 * `a` straight out (+x), to the input `b` straight in (+x): the stubs are not fixed, the clearance's cost keeps them
 * 64 long where nothing is in the way. A run keeps half the clearance (32) off every block, its own too, but for its own
 * along its port's line (the stub), and for any within a stub of either port (the column it leaves or enters by: a block
 * packed against a port leaves no other way, review 2026-10-22), where it only keeps out of it. Null when no way exists.
 */
function search(e: Ends, hug: number, boxes: readonly Box[], tracks: Tracks, columns: readonly number[], fine: boolean, bound: Bound | null): Pt[] | null {
  const a: Pt = [e.sx, e.sy], b: Pt = [e.tx, e.ty];
  const within = (box: Box) => bound === null
    || (box.x - STUB < bound.x2 && box.x + box.w + STUB > bound.x1 && box.y - STUB < bound.y2 && box.y + box.h + STUB > bound.y1);
  const near = boxes.filter(within);
  // the blocks as numbers: their sides, and 1 for the source's, 2 for the target's (3 both), 0 another's
  const M = near.length;
  const X1 = new Float64Array(M), X2 = new Float64Array(M), Y1 = new Float64Array(M), Y2 = new Float64Array(M), kind = new Uint8Array(M);
  near.forEach((box, m) => {
    X1[m] = box.x; X2[m] = box.x + box.w; Y1[m] = box.y; Y2[m] = box.y + box.h;
    kind[m] = (box.id === e.src ? 1 : 0) | (box.id === e.tgt ? 2 : 0);
  });
  const xsAll = [a[0], b[0], ...columns], ysAll = [a[1], b[1]];
  for (const box of near) {
    for (const g of [STUB, HALF_CLEAR]) {
      xsAll.push(snap(box.x - g), snap(box.x + box.w + g));
      ysAll.push(snap(box.y - g), snap(box.y + box.h + g));
    }
  }
  const t = tracks.lines(fine, bound);
  xsAll.push(...t.xs.map((v) => snap(v)));
  ysAll.push(...t.ys.map((v) => snap(v)));
  if (bound) { xsAll.push(snap(bound.x1), snap(bound.x2)); ysAll.push(snap(bound.y1), snap(bound.y2)); }
  const keep = (v: number, l: number, h: number, must: number[]) => must.includes(v) || bound === null || (v >= l && v <= h);
  const xs = [...new Set(xsAll)].filter((v) => keep(v, bound?.x1 ?? 0, bound?.x2 ?? 0, [a[0], b[0]])).sort((p, q) => p - q);
  const ys = [...new Set(ysAll)].filter((v) => keep(v, bound?.y1 ?? 0, bound?.y2 ?? 0, [a[1], b[1]])).sort((p, q) => p - q);
  const W = xs.length, H = ys.length, N = W * H;
  // the blocks a run on each line can touch (its clearance band reaches the line): a level run's by its y, an upright's
  // by its x
  const rowBoxes = ys.map((y) => { const r: number[] = []; for (let m = 0; m < M; m++) if (y > Y1[m]! - STUB && y < Y2[m]! + STUB) r.push(m); return r; });
  const colBoxes = xs.map((x) => { const r: number[] = []; for (let m = 0; m < M; m++) if (x > X1[m]! - STUB && x < X2[m]! + STUB) r.push(m); return r; });
  const start = xs.indexOf(a[0]) + W * ys.indexOf(a[1]);
  const goal = xs.indexOf(b[0]) + W * ys.indexOf(b[1]);
  const pt = (n: number): Pt => [xs[n % W]!, ys[Math.floor(n / W)]!];

  // an edge's cost, by (node, heading): [primary, hug, below] in `cost`; `known` 1 when worked out, 2 when it runs inside
  // a block (or off the grid)
  const known = new Uint8Array(N * 4), cost = new Float64Array(N * 12);
  const edge = (n: number, d: number): number => {
    const k = n * 4 + d;
    if (known[k] !== 0) return known[k]!;
    const i = n % W, j = (n - i) / W, ni = i + DX[d]!, nj = j + DY[d]!;
    known[k] = 2;
    if (ni < 0 || ni >= W || nj < 0 || nj >= H) return 2;
    const p: Pt = [xs[i]!, ys[j]!], q: Pt = [xs[ni]!, ys[nj]!];
    const x1 = Math.min(p[0], q[0]), x2 = Math.max(p[0], q[0]), y1 = Math.min(p[1], q[1]), y2 = Math.max(p[1], q[1]);
    const levelRun = y1 === y2;
    const byPort = (x1 >= e.sx && x2 <= e.sx + STUB) || (x1 >= e.tx - STUB && x2 <= e.tx);
    // a block's clearance counts round the blocks it passes; round its own only nearer than a track (phase 3's deferred
    // list: a hard search turned 8 px off its own block), so a wire still nests a track inside another net's as Visio's
    // fan-out does, and never along its ports' lines (its stubs)
    let soft = 0;
    for (const m of levelRun ? rowBoxes[j]! : colBoxes[i]!) {
      const k = kind[m]!;
      const stub = levelRun && (((k & 1) !== 0 && y1 === e.sy) || ((k & 2) !== 0 && y1 === e.ty));
      const g = byPort || stub ? 0 : HALF_CLEAR;
      if (x2 > X1[m]! - g && x1 < X2[m]! + g && y2 > Y1[m]! - g && y1 < Y2[m]! + g) return 2;
      if (stub) continue;
      const c = k === 0 ? STUB : TRACK;
      if (levelRun) { if (y1 > Y1[m]! - c && y1 < Y2[m]! + c) soft += Math.max(0, Math.min(x2, X2[m]! + c) - Math.max(x1, X1[m]! - c)); }
      else if (x1 > X1[m]! - c && x1 < X2[m]! + c) soft += Math.max(0, Math.min(y2, Y2[m]! + c) - Math.max(y1, Y1[m]! - c));
    }
    const len = x2 - x1 + y2 - y1;
    const tr = tracks.near(p, q);
    const level = d === 0 || d === 2;
    cost[3 * k] = len + NEAR * soft + ON_COST * tr.on + BESIDE * tr.beside + CROSS * tr.crosses;
    cost[3 * k + 1] = level ? 0 : len * Math.abs(p[0] - hug);
    cost[3 * k + 2] = level && p[1] > a[1] ? len : 0;
    known[k] = 1;
    return 1;
  };

  const S = N * 4;
  const d0 = new Float64Array(S).fill(Infinity), d1 = new Float64Array(S), d2 = new Float64Array(S);
  const prev = new Int32Array(S).fill(-1);
  const less = (p0: number, p1: number, p2: number, q0: number, q1: number, q2: number) =>
    p0 !== q0 ? p0 < q0 : p1 !== q1 ? p1 < q1 : p2 < q2;
  const heap = new Heap();
  // A*: the primary cost is never below the length still to go
  // and the fewest bends still to make, heading `d`, to come in heading +x on the input's line
  const togo = (n: number, d: number) => {
    const x = xs[n % W]!, y = ys[(n - (n % W)) / W]!;
    const bends = y === b[1] ? (d === 0 ? 0 : d === 2 ? 2 : 1) : d === 1 || d === 3 ? 1 : 2;
    return Math.abs(x - b[0]) + Math.abs(y - b[1]) + BEND * bends;
  };
  const s0 = start * 4;
  d0[s0] = 0;
  heap.push(togo(start, 0), 0, 0, s0);
  let best = -1;
  while (heap.size > 0) {
    const k = heap.pop(), f0 = heap.p0, c1 = heap.p1, c2 = heap.p2;
    const n = k >> 2, d = k & 3, c0 = f0 - togo(n, d);
    if (c0 !== d0[k] || c1 !== d1[k] || c2 !== d2[k]) continue;
    if (n === goal && d === 0) { best = k; break; }
    for (let nd = 0; nd < 4; nd++) {
      if (nd === (d + 2) % 4 || (n === start && nd !== 0) || n === goal) continue;
      if (edge(n, nd) === 2) continue;
      const ek = 3 * (n * 4 + nd);
      const nn = n + DX[nd]! + W * DY[nd]!;
      const nk = nn * 4 + nd;
      const e0 = c0 + cost[ek]! + (nd === d ? 0 : BEND), e1 = c1 + cost[ek + 1]!, e2 = c2 + cost[ek + 2]!;
      if (less(e0, e1, e2, d0[nk]!, d1[nk]!, d2[nk]!)) {
        d0[nk] = e0; d1[nk] = e1; d2[nk] = e2; prev[nk] = k;
        heap.push(e0 + togo(nn, nd), e1, e2, nk);
      }
    }
  }
  if (best < 0) return null;
  const path: Pt[] = [];
  for (let k = best; k >= 0; k = prev[k]!) path.push(pt(k >> 2));
  return path.reverse();
}

/**
 * A binary min-heap of (cost, cost, cost, key), ordered by the three costs in turn, on flat typed arrays (no allocation
 * per entry: the search pushes thousands). `pop` returns the key and leaves its costs in `p0`, `p1`, `p2`.
 */
class Heap {
  private c0 = new Float64Array(1024); private c1 = new Float64Array(1024); private c2 = new Float64Array(1024);
  private key = new Int32Array(1024);
  size = 0;
  p0 = 0; p1 = 0; p2 = 0;
  private lt(i: number, j: number): boolean {
    const a = this.c0[i]!, b = this.c0[j]!;
    if (a !== b) return a < b;
    const c = this.c1[i]!, d = this.c1[j]!;
    return c !== d ? c < d : this.c2[i]! < this.c2[j]!;
  }
  private swap(i: number, j: number): void {
    let t = this.c0[i]!; this.c0[i] = this.c0[j]!; this.c0[j] = t;
    t = this.c1[i]!; this.c1[i] = this.c1[j]!; this.c1[j] = t;
    t = this.c2[i]!; this.c2[i] = this.c2[j]!; this.c2[j] = t;
    const k = this.key[i]!; this.key[i] = this.key[j]!; this.key[j] = k;
  }
  push(a: number, b: number, c: number, k: number): void {
    if (this.size === this.key.length) {
      const grow = <T extends Float64Array | Int32Array>(x: T): T => { const y = new (x.constructor as new (n: number) => T)(x.length * 2); y.set(x); return y; };
      this.c0 = grow(this.c0); this.c1 = grow(this.c1); this.c2 = grow(this.c2); this.key = grow(this.key);
    }
    let i = this.size++;
    this.c0[i] = a; this.c1[i] = b; this.c2[i] = c; this.key[i] = k;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.lt(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): number {
    const k = this.key[0]!;
    this.p0 = this.c0[0]!; this.p1 = this.c1[0]!; this.p2 = this.c2[0]!;
    const last = --this.size;
    if (last > 0) {
      this.c0[0] = this.c0[last]!; this.c1[0] = this.c1[last]!; this.c2[0] = this.c2[last]!; this.key[0] = this.key[last]!;
      for (let i = 0; ; ) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < last && this.lt(l, m)) m = l;
        if (r < last && this.lt(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return k;
  }
}
