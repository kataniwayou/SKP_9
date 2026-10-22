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
  const ay = smaller(best(ysOf, moving, others, reach), gapSnap(moving, others, reach, Y));
  const level = ay === null ? moving : { ...moving, y: moving.y + ay, ...(moving.mid !== undefined ? { mid: moving.mid + ay } : {}) };
  const ax = smaller(best(xsOf, level, others, reach), gapSnap(level, others, reach, X));
  const dx = ax ?? 0, dy = ay ?? 0;
  // where it lands, exactly: an offset added back to an unrounded position leaves float noise (432.00000000000006),
  // which would miss the exact matches that draw the lines and marks, and turn a drag back to the start into a step;
  // an axis no guide caught lands on the grid (the caller rounds it so), and the lines and marks are measured there
  const x = ax === null ? snap(moving.x) : exact(moving.x + dx), y = ay === null ? snap(moving.y) : exact(moving.y + dy);
  const m: GuideBox = { ...moving, x, y, ...(moving.mid !== undefined ? { mid: exact(moving.mid + (y - moving.y)) } : {}) };
  return { dx, dy, x, y, hit: { x: ax !== null, y: ay !== null }, lines: linesOf(m, others), gaps: [...gapMarks(m, others, X), ...gapMarks(m, others, Y)] };
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
  for (const p of row) {
    const end = a.lo(p) + a.len(p);
    const after = row.filter((r) => a.lo(r) >= end);
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
  const row = rowOf(m, others, a);
  const gaps = pairsOf(row, a).map((x) => x.gap);
  const mid = a.lo(m) + a.len(m) / 2;
  const before = row.filter((o) => a.lo(o) + a.len(o) <= mid).reduce<GuideBox | null>((b, o) => (b === null || a.lo(o) + a.len(o) > a.lo(b) + a.len(b) ? o : b), null);
  const after = row.filter((o) => a.lo(o) >= mid).reduce<GuideBox | null>((b, o) => (b === null || a.lo(o) < a.lo(b) ? o : b), null);
  let found: number | null = null;
  const consider = (d: number) => { if (Math.abs(d) <= reach && (found === null || Math.abs(d) < Math.abs(found))) found = d; };
  for (const g of gaps) {
    if (before) consider(g - (a.lo(m) - (a.lo(before) + a.len(before))));
    if (after) consider(a.lo(after) - g - (a.lo(m) + a.len(m)));
  }
  return found;
}

/** At `m`'s final place: every pair next to each other in its row (`m` included) whose gap equals one of `m`'s own gaps. */
function gapMarks(m: GuideBox, others: readonly GuideBox[], a: Axis): GapMark[] {
  const pairs = pairsOf([...rowOf(m, others, a), m].sort((p, q) => a.lo(p) - a.lo(q)), a);
  const own = pairs.filter((x) => x.p === m || x.q === m);
  const equal = own.filter((o) => pairs.some((x) => x !== o && x.gap === o.gap)).map((o) => o.gap);
  return pairs.filter((x) => equal.includes(x.gap)).map((x) => a.mark(x.p, x.q));
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
