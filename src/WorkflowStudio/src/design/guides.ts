import type { StudioDocument } from '../app/document';
import { PMID, snap } from '../layout/geometry';
import { cacheNodeId, SPHERE_NODE_ID } from '../layout/nodeIds';
import { nodeBox } from './hit';

/**
 * A block for the guides, by React Flow node id; `mid` is a step's processor middle (absolute), and the hub's centre:
 * wires leave the hub at its centre's height and land at a step's processor middle, so middles lined up run straight.
 */
export interface GuideBox { id: string; x: number; y: number; w: number; h: number; mid?: number }
export interface GuideLine { x1: number; y1: number; x2: number; y2: number }

export function guideBoxes(doc: StudioDocument): GuideBox[] {
  const ids = [SPHERE_NODE_ID, ...doc.placement.steps.keys(), ...[...doc.placement.caches.keys()].map(cacheNodeId)];
  const out: GuideBox[] = [];
  for (const id of ids) {
    const b = nodeBox(doc, id);
    if (!b) continue;
    const mid = doc.placement.steps.has(id) ? b.y + PMID : id === SPHERE_NODE_ID ? b.y + b.h / 2 : undefined;
    out.push({ id, ...b, ...(mid !== undefined ? { mid } : {}) });
  }
  return out;
}

// Like to like only (Visio, measured 2026-10-21): a left edge lines up with left edges, a centre with centres, a
// processor middle with middles; each list holds a block's coordinates by kind, null where it has none of that kind.
const xsOf = (b: GuideBox): (number | null)[] => [b.x, b.x + b.w / 2, b.x + b.w];
const ysOf = (b: GuideBox): (number | null)[] => [b.y, b.y + b.h / 2, b.y + b.h, b.mid ?? null];
/** Whether `b` has coordinate `v` of kind `k` in `of`. */
const has = (of: (b: GuideBox) => (number | null)[], b: GuideBox, k: number, v: number) => of(b)[k] === v;

/**
 * An equal-gap mark (Visio's dimension arrow, plan 10): axis 'x' is a horizontal gap from x `from` to x `to`, drawn
 * below y `at` (the lower bottom edge of its pair); axis 'y' a vertical gap from y `from` to y `to`, drawn right of x
 * `at` (the farther right edge of its pair).
 */
export interface GapMark { axis: 'x' | 'y'; from: number; to: number; at: number }
/** What a drag shows: the alignment lines and the equal-gap marks. */
export interface Guides { lines: GuideLine[]; gaps: GapMark[] }
export const NO_GUIDES: Guides = { lines: [], gaps: [] };

/** How near (screen px, at any zoom) a block snaps to a guide: Visio snapped 3, 6 and 10 px off, not 16 (plan 10). */
export const SNAP_REACH_PX = 12;

/** The smallest offset within `reach` that lines a coordinate of `moving` up with the same kind of another block's; null when none does. */
function best(of: (b: GuideBox) => (number | null)[], moving: GuideBox, others: readonly GuideBox[], reach: number): number | null {
  let found: number | null = null;
  const mine = of(moving);
  for (const o of others) {
    of(o).forEach((t, k) => {
      const m = mine[k];
      if (t === null || m === null || m === undefined) return;
      const d = t - m;
      if (Math.abs(d) <= reach && (found === null || Math.abs(d) < Math.abs(found))) found = d;
    });
  }
  return found;
}

/** The distance between two spans [a0, a1] and [b0, b1] (0 when they overlap). */
const apart = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, b0 - a1, a0 - b1);

/**
 * Plan 10 (Visio's dynamic grid, the authority): the dragged block, at its unrounded position, snaps when an edge, its
 * centre or its processor middle is within `reach` (flow px) of another block's; `hit` says which axes a guide caught,
 * and `x`, `y` where it lands on them, exactly (the caller rounds the others to the grid). Each matching coordinate draws one line, to the nearest block it matches
 * (Visio's). A guide on blocks that are on the 8 px grid keeps the block on it.
 */
export function snapToGuides(moving: GuideBox, others: readonly GuideBox[], reach: number): { dx: number; dy: number; x: number; y: number; hit: { x: boolean; y: boolean } } & Guides {
  // per axis the smaller move wins between an alignment and an equal gap (plan 10 §8); y first, so x's equal gap is
  // looked for in the row the block lands in (tidy-up 2026-10-22)
  const ay = smaller(best(ysOf, moving, others, reach), smaller(gapSnap(moving, others, reach, Y), nearestOf(chainMoves(moving, others, reach, Y))));
  const level = ay === null ? moving : { ...moving, y: moving.y + ay, ...(moving.mid !== undefined ? { mid: moving.mid + ay } : {}) };
  const ax = smaller(best(xsOf, level, others, reach), smaller(gapSnap(level, others, reach, X), nearestOf(chainMoves(level, others, reach, X))));
  const dx = ax ?? 0, dy = ay ?? 0;
  // where it lands, exactly: an offset added back to an unrounded position leaves float noise (432.00000000000006),
  // which would miss the exact matches that draw the lines and marks, and turn a drag back to the start into a step;
  // an axis no guide caught lands on the grid (the caller rounds it so), and the lines and marks are measured there
  const x = ax === null ? snap(moving.x) : exact(moving.x + dx), y = ay === null ? snap(moving.y) : exact(moving.y + dy);
  const m: GuideBox = { ...moving, x, y, ...(moving.mid !== undefined ? { mid: exact(moving.mid + (y - moving.y)) } : {}) };
  const gaps = onceEach([...gapMarks(m, others, X), ...chainMarks(m, others, X), ...gapMarks(m, others, Y), ...chainMarks(m, others, Y)]);
  return { dx, dy, x, y, hit: { x: ax !== null, y: ay !== null }, lines: linesOf(m, others), gaps };
}

/** A coordinate rid of float noise (to a millionth of a px): guides land on whole numbers when their references do. */
const exact = (v: number) => Math.round(v * 1e6) / 1e6;

const smaller = (a: number | null, b: number | null): number | null => (a === null ? b : b === null || Math.abs(a) <= Math.abs(b) ? a : b);

/** One axis of a box: along it (`lo`, `len`) and across it (`clo`, `clen`); `mark` builds a gap mark between two boxes. */
interface Axis {
  lo: (b: GuideBox) => number; len: (b: GuideBox) => number; clo: (b: GuideBox) => number; clen: (b: GuideBox) => number;
  mark: (p: GuideBox, q: GuideBox) => GapMark;
}
const X: Axis = {
  lo: (b) => b.x, len: (b) => b.w, clo: (b) => b.y, clen: (b) => b.h,
  mark: (p, q) => ({ axis: 'x', from: p.x + p.w, to: q.x, at: Math.max(p.y + p.h, q.y + q.h) }),
};
const Y: Axis = {
  lo: (b) => b.y, len: (b) => b.h, clo: (b) => b.x, clen: (b) => b.w,
  mark: (p, q) => ({ axis: 'y', from: p.y + p.h, to: q.y, at: Math.max(p.x + p.w, q.x + q.w) }),
};

/** The blocks in `m`'s row along `a` (their spans across `a` overlap `m`'s), in order along `a`. */
const rowOf = (m: GuideBox, others: readonly GuideBox[], a: Axis) =>
  others.filter((o) => Math.min(a.clo(o) + a.clen(o), a.clo(m) + a.clen(m)) - Math.max(a.clo(o), a.clo(m)) > 0)
    .sort((p, q) => a.lo(p) - a.lo(q));

/** Each pair of blocks next to each other along `a` (none between them) with a gap over 0, and that gap. */
function pairsOf(row: readonly GuideBox[], a: Axis): { p: GuideBox; q: GuideBox; gap: number }[] {
  const out: { p: GuideBox; q: GuideBox; gap: number }[] = [];
  // a run is a box of no width; runs lying on one line (fan-out wires on a trunk) are one neighbour, never each other's
  const sameLine = (r: GuideBox, p: GuideBox) => a.len(r) === 0 && a.len(p) === 0 && a.lo(r) === a.lo(p);
  for (const [i, p] of row.entries()) {
    if (row.slice(0, i).some((r) => sameLine(r, p))) continue;
    const end = a.lo(p) + a.len(p);
    const after = row.filter((r) => r !== p && a.lo(r) >= end && !sameLine(r, p));
    if (after.length === 0) continue;
    const q = after.reduce((b, r) => (a.lo(r) < a.lo(b) ? r : b));
    const between = row.some((r) => r !== p && r !== q && a.lo(r) < a.lo(q) && a.lo(r) + a.len(r) > end);
    const gap = a.lo(q) - end;
    if (!between && gap > 0) out.push({ p, q, gap });
  }
  return out;
}

/**
 * Visio's equal gaps (plan 10 §4.1.1): the smallest move within `reach` that makes `m`'s gap to its nearest neighbour
 * along `a` (before or after it) equal a gap between two blocks next to each other in its row; ties to the earlier side.
 */
function gapSnap(m: GuideBox, others: readonly GuideBox[], reach: number, a: Axis): number | null {
  // ties to the earlier found
  return nearestOf(gapMoves(m, others, reach, a));
}

/** Every move within `reach` that makes `m`'s gap to its nearest neighbour along `a` equal a gap in its row (as `gapSnap`). */
function gapMoves(m: GuideBox, others: readonly GuideBox[], reach: number, a: Axis): number[] {
  const row = rowOf(m, others, a);
  const pairs = pairsOf(row, a);
  const mid = a.lo(m) + a.len(m) / 2;
  const before = row.filter((o) => a.lo(o) + a.len(o) <= mid).reduce<GuideBox | null>((b, o) => (b === null || a.lo(o) + a.len(o) > a.lo(b) + a.len(b) ? o : b), null);
  const after = row.filter((o) => a.lo(o) >= mid).reduce<GuideBox | null>((b, o) => (b === null || a.lo(o) < a.lo(b) ? o : b), null);
  const out: number[] = [];
  const consider = (d: number) => { if (Math.abs(d) <= reach) out.push(d); };
  // never a gap from the same block: one stacked with `m` beside its neighbour makes that gap again, no equal spacing
  for (const { p, q, gap: g } of pairs) {
    if (before && p !== before) consider(g - (a.lo(m) - (a.lo(before) + a.len(before))));
    if (after && q !== after) consider(a.lo(after) - g - (a.lo(m) + a.len(m)));
  }
  return out;
}

/** The move nearest 0 of `ds` (the first on a tie); null when there is none. */
const nearestOf = (ds: readonly number[]): number | null => ds.reduce<number | null>((f, d) => (f === null || Math.abs(d) < Math.abs(f) ? d : f), null);

/** Each gap marked once: two blocks stacked in one column make the same gap at two places across (the first is kept). */
export const onceEach = (marks: readonly GapMark[]): GapMark[] => marks.filter((g, i) => marks.findIndex((h) => h.axis === g.axis && h.from === g.from && h.to === g.to) === i);

/**
 * `m`'s nearest neighbour `before` it along `a` (wholly before it, a gap over 0 between), or after it, in any row: equal
 * spacing needs no shared column or row (the user's, 2026-10-23). Nearest as the boxes lie apart, along and across, so a
 * block far off to one side is no neighbour of one it is merely level with (the guides sweep, 2026-10-23); on a tie
 * the one with the smaller gap along.
 */
function neighbourOf(m: GuideBox, others: readonly GuideBox[], a: Axis, before: boolean): GuideBox | null {
  const end = (b: GuideBox) => a.lo(b) + a.len(b);
  const gap = (o: GuideBox) => (before ? a.lo(m) - end(o) : a.lo(o) - end(m));
  const across = (o: GuideBox) => apart(a.clo(m), a.clo(m) + a.clen(m), a.clo(o), a.clo(o) + a.clen(o));
  const dist = (o: GuideBox) => Math.hypot(gap(o), across(o));
  return others.filter((o) => o !== m && gap(o) > 0).reduce<GuideBox | null>((n, o) => (n === null || dist(o) < dist(n) || (dist(o) === dist(n) && gap(o) < gap(n)) ? o : n), null);
}

/**
 * Equal spacing along a chain (the user's, 2026-10-23: three blocks or more, three parallel wires or more, in a column
 * or not): `m`'s gap to its nearest neighbour on a side equal to that neighbour's gap to its own next one on that side,
 * or equal gaps to its nearest neighbour on each side. The pairs as they are for `m` where it is.
 */
function chainOf(m: GuideBox, others: readonly GuideBox[], a: Axis): { before: [GuideBox, GuideBox] | null; after: [GuideBox, GuideBox] | null; n: GuideBox | null; q: GuideBox | null } {
  const n = neighbourOf(m, others, a, true), q = neighbourOf(m, others, a, false);
  const rest = (x: GuideBox) => others.filter((o) => o !== x);
  const nn = n && neighbourOf(n, rest(n), a, true), qq = q && neighbourOf(q, rest(q), a, false);
  return { before: n && nn ? [nn, n] : null, after: q && qq ? [q, qq] : null, n, q };
}

/** Every move within `reach` that spaces `m` evenly along a chain (`chainOf`). */
function chainMoves(m: GuideBox, others: readonly GuideBox[], reach: number, a: Axis): number[] {
  const end = (b: GuideBox) => a.lo(b) + a.len(b);
  const { before, after, n, q } = chainOf(m, others, a);
  const out: number[] = [];
  // its gap to n as n's to the one before; to q as q's to the one after; or the middle between n and q
  if (before) out.push(end(before[1]) + (a.lo(before[1]) - end(before[0])) - a.lo(m));
  if (after) out.push(a.lo(after[0]) - (a.lo(after[1]) - end(after[0])) - end(m));
  if (n && q) out.push((end(n) + a.lo(q) - a.len(m)) / 2 - a.lo(m));
  return out.filter((d) => Math.abs(d) <= reach);
}

/** At `m`'s final place: the marks of each even chain it is in (`chainOf`). */
function chainMarks(m: GuideBox, others: readonly GuideBox[], a: Axis): GapMark[] {
  const end = (b: GuideBox) => a.lo(b) + a.len(b);
  const { before, after, n, q } = chainOf(m, others, a);
  const out: GapMark[] = [];
  const g = (p: GuideBox, r: GuideBox) => a.lo(r) - end(p);
  if (before && g(before[1], m) === g(before[0], before[1])) out.push(a.mark(before[0], before[1]), a.mark(before[1], m));
  if (after && g(m, after[0]) === g(after[0], after[1])) out.push(a.mark(m, after[0]), a.mark(after[0], after[1]));
  if (n && q && g(n, m) === g(m, q)) out.push(a.mark(n, m), a.mark(m, q));
  return out;
}

/**
 * Equal spacing along a chain for any box, a wire's run among them as a box with no width (`others`: what it chains with,
 * in any row): every move within `reach`, and the marks at `m`'s place.
 */
export const chainGapMoves = (m: GuideBox, others: readonly GuideBox[], reach: number, axis: 'x' | 'y'): number[] =>
  chainMoves(m, others, reach, axis === 'x' ? X : Y);
export const chainGapMarks = (m: GuideBox, others: readonly GuideBox[], axis: 'x' | 'y'): GapMark[] =>
  onceEach(chainMarks(m, others, axis === 'x' ? X : Y));

/**
 * Equal gaps along `axis` for any box, a wire's run among them as a box with no width (the user's, 2026-10-23): every move
 * within `reach` that makes `m`'s gap to a neighbour equal one between two neighbours in its row, and the marks at `m`'s
 * place.
 */
export const equalGapMoves = (m: GuideBox, others: readonly GuideBox[], reach: number, axis: 'x' | 'y'): number[] =>
  gapMoves(m, others, reach, axis === 'x' ? X : Y);
export const equalGapMarks = (m: GuideBox, others: readonly GuideBox[], axis: 'x' | 'y'): GapMark[] =>
  gapMarks(m, others, axis === 'x' ? X : Y);

/** At `m`'s final place: every pair next to each other in its row (`m` included) whose gap equals one of `m`'s own gaps. */
function gapMarks(m: GuideBox, others: readonly GuideBox[], a: Axis): GapMark[] {
  const pairs = pairsOf([...rowOf(m, others, a), m].sort((p, q) => a.lo(p) - a.lo(q)), a);
  const own = pairs.filter((x) => x.p === m || x.q === m);
  // a gap equals another pair's, never one from or to the same block: two blocks stacked in one column beside a third
  // make the same gap twice (the guides sweeps, 2026-10-23), whether `m` is one of the two or the third
  const shared = (x: { p: GuideBox; q: GuideBox }, o: { p: GuideBox; q: GuideBox }) => x.p === o.p || x.q === o.q;
  const equal = own.filter((o) => pairs.some((x) => x !== o && x.gap === o.gap && !shared(x, o))).map((o) => o.gap);
  // each mark once: runs lying on one line (a trunk) make the same pair more than once
  return onceEach(pairs.filter((x) => equal.includes(x.gap)).map((x) => a.mark(x.p, x.q)));
}

/** One line per coordinate of `m` that some block has exactly, of the same kind, spanning `m` and the nearest such block. */
function linesOf(m: GuideBox, others: readonly GuideBox[]): GuideLine[] {
  const lines: GuideLine[] = [];
  const seen = new Set<string>();
  const add = (l: GuideLine) => { const key = `${l.x1},${l.y1},${l.x2},${l.y2}`; if (!seen.has(key)) { seen.add(key); lines.push(l); } };
  xsOf(m).forEach((x, k) => {
    if (x === null) return;
    const near = nearest(others.filter((o) => has(xsOf, o, k, x)), (o) => apart(m.y, m.y + m.h, o.y, o.y + o.h));
    if (near) add({ x1: x, y1: Math.min(m.y, near.y), x2: x, y2: Math.max(m.y + m.h, near.y + near.h) });
  });
  ysOf(m).forEach((y, k) => {
    if (y === null) return;
    const near = nearest(others.filter((o) => has(ysOf, o, k, y)), (o) => apart(m.x, m.x + m.w, o.x, o.x + o.w));
    if (near) add({ x1: Math.min(m.x, near.x), y1: y, x2: Math.max(m.x + m.w, near.x + near.w), y2: y });
  });
  return lines;
}

const nearest = <T>(xs: readonly T[], d: (x: T) => number): T | null =>
  xs.reduce<T | null>((b, x) => (b === null || d(x) < d(b) ? x : b), null);
