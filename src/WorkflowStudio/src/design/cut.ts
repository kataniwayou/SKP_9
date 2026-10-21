import { holdEnd, setBends, setEnd, type Circuit, type End, type Side } from '../circuit/circuit';
import type { WireRoute } from '../layout/circuitRoute';
import { snap, type Point } from '../layout/geometry';
import { lengthOf, nearestOn, slice } from '../layout/junctions';
import type { Placement } from '../layout/placement';
import { simplify, type Pt } from '../layout/router';
import { endsOf, pointsOfShape, segmentHandles, shapeFromPoints, type Bends, type Ends } from '../layout/shape';

/** On-screen size (px) of a picked wire's square, at any zoom. */
export const SQUARE = 9;

/**
 * A picked wire's square (plan 9 rule 14): on a run of its core (run `k`), or on an end. `cuts`: a run with a grid
 * point inside it, where an end square released cuts the wire (a run one grid step long has none: its square, at its
 * middle, only drags the run).
 */
export type Square =
  | { kind: 'run'; k: number; x: number; y: number; vertical: boolean; cuts: boolean }
  /** `glued`: on a step side, the hub or a wire (drawn as Visio's green dot); else open (a hollow circle), plan 10. */
  | { kind: 'end'; side: Side; x: number; y: number; glued: boolean };

/**
 * A run square is drawn only where an end square does not cover it: on a run too short on screen, the end
 * square (drawn above) would take every press meant for it. That run is still dragged through the wire's body.
 */
function clearOfEnds(h: { x: number; y: number }, ends: Ends, k: number): boolean {
  const room = (SQUARE + 1) * k;
  return Math.hypot(h.x - ends.sx, h.y - ends.sy) >= room && Math.hypot(h.x - ends.tx, h.y - ends.ty) >= room;
}

/**
 * The squares a picked wire shows (`k`: flow units per screen pixel): one in the middle of each run of its core that
 * an end square does not cover (none on the last run of a head on a junction: it ends on its host), one on each end.
 */
export function squaresOf(w: WireRoute, bends: Bends, k: number): Square[] {
  const ends = endsOf(w.points);
  const last = 2 * bends.xs.length;
  const core = pointsOfShape(w.core.ends, bends);
  const runs: Square[] = [];
  for (const h of segmentHandles(w.core.ends, bends)) {
    if (w.headOn === 'junction' && h.k === last) continue;
    if (!clearOfEnds(h, ends, k)) continue;
    // drawn where it cuts (on the grid, inside its run); a run with no grid point inside it keeps its square at its
    // middle, for run drags only: never on a corner or an end
    const [x, y] = cutPoint(w, bends, h.k);
    const a = core[h.k]!, b = core[h.k + 1]!;
    const cuts = !((x === a[0] && y === a[1]) || (x === b[0] && y === b[1]));
    runs.push(cuts ? { kind: 'run', k: h.k, x, y, vertical: h.vertical, cuts } : { kind: 'run', k: h.k, x: h.x, y: h.y, vertical: h.vertical, cuts });
  }
  return [...runs,
    { kind: 'end', side: 'tail', x: ends.sx, y: ends.sy, glued: w.tailOn !== 'open' },
    { kind: 'end', side: 'head', x: ends.tx, y: ends.ty, glued: w.headOn !== 'open' }];
}

/** The corners of a picked wire's core, where Visio draws a small dot (plan 10): never pressed, a run drag moves them. */
export function bendsOf(w: WireRoute, bends: Bends): { x: number; y: number }[] {
  return pointsOfShape(w.core.ends, bends).slice(1, -1).map(([x, y]) => ({ x, y }));
}

/** What an end square being dragged (`side`) may be released on: the run squares that cut, and the other end's square. */
export const cutTargets = (squares: readonly Square[], side: Side): Square[] =>
  squares.filter((s) => (s.kind === 'run' ? s.cuts : s.side !== side));

/** The square under `p` (flow coordinates), within the square's own size on screen (`k` flow units per pixel). */
export function squareAt(squares: readonly Square[], p: Point, k: number): Square | null {
  const half = (SQUARE / 2) * k;
  return squares.find((s) => Math.abs(p.x - s.x) <= half && Math.abs(p.y - s.y) <= half) ?? null;
}

/**
 * Where run `k` of the wire's core is cut and its square drawn: its middle, on the 8 px grid along the run (kept on
 * the run), so the open end a cut leaves is on the grid (review 2026-10-09).
 */
function cutPoint(w: WireRoute, bends: Bends, k: number): Pt {
  const pts = pointsOfShape(w.core.ends, bends);
  const a = pts[k]!, b = pts[k + 1]!;
  const along = (u: number, v: number) => Math.min(Math.max(snap((u + v) / 2), Math.min(u, v)), Math.max(u, v));
  return a[0] === b[0] ? [a[0], along(a[1], b[1])] : [along(a[0], b[0]), a[1]];
}

/** Where the cut point lies along the wire as drawn. */
const cutAlong = (w: WireRoute, cut: Pt): number => nearestOn([w.points], cut).at;

/**
 * A wire cut at run square `k` with its `dragged` end (the user's rule, 2026-10-09), as drawn: the part that stays
 * (from the end that stays to the square) and the part that goes (from the square to the dragged end).
 */
export function cutPaths(w: WireRoute, bends: Bends, dragged: Side, k: number): { kept: Pt[]; gone: Pt[] } {
  const d = cutAlong(w, cutPoint(w, bends, k));
  const total = lengthOf([w.points]);
  const before = slice(w.points, 0, d), after = slice(w.points, d, total);
  return dragged === 'head' ? { kept: before, gone: after } : { kept: after, gone: before };
}

/**
 * End `side` of wire `id` held where it is drawn (`at`) when it is automatic on a step or the hub, so it does not move
 * once the other end has gone (the user's end drag, 2026-10-08): a step end at its drawn height, a hub end at its
 * drawn height on the hub's right side (`dy`, review 2026-10-09; it used to snap to the nearest 15 degrees).
 */
export function holdDrawn(c: Circuit, id: string, side: Side, at: Point, placement: Placement): Circuit {
  const o = c[id]?.[side];
  if (!o) return c;
  const step = o.on === 'step' && o.y === null ? placement.steps.get(o.step) : undefined;
  if (o.on === 'step' && step) return holdEnd(c, id, side, { on: 'step', step: o.step, y: at.y - step.y });
  // an automatic hub tail leaves the hub's right side: held at that height, exactly where it is drawn
  if (o.on === 'hub' && o.angle === null) return holdEnd(c, id, side, { on: 'hub', angle: null, dy: at.y - placement.sphere.cy });
  return c;
}

/**
 * Wire `id` (drawn as `w`, shaped by `bends`) cut at its run square `k` by its `dragged` end released there (the
 * user's rule, 2026-10-09): everything from the square to that end goes; the wire ends there open, its shape up to
 * there kept (a straight piece as a one-run shape), its other end held where it is drawn. Ends joined on the part
 * that goes open where they are drawn (`pointOf`); those on the part kept keep their point. With no end left on a
 * step or the hub it has no direction (rule D).
 */
export function cutWire(
  c: Readonly<Circuit>, id: string, dragged: Side, w: WireRoute, bends: Bends, k: number,
  pointOf: (id: string, side: Side) => Point | null, placement: Placement,
): Circuit {
  if (!Object.hasOwn(c, id)) return c as Circuit;
  const cut = cutPoint(w, bends, k);
  const core = pointsOfShape(w.core.ends, bends);
  const keptCore = simplify(dragged === 'head' ? [...core.slice(0, k + 1), cut] : [cut, ...core.slice(k + 1)]);
  // a cut never leaves a wire of no length (its square is not drawn there either)
  if (lengthOf([keptCore]) === 0 || keptCore.length < 2) return c as Circuit;
  const shape = shapeFromPoints(keptCore);
  let next = setEnd(c, id, dragged, { on: 'open', x: cut[0], y: cut[1] });
  next = setBends(next, id, shape.xs.length > 0 ? shape : { xs: [keptCore[0]![0]], ys: [] });
  const other: Side = dragged === 'head' ? 'tail' : 'head';
  const [ox, oy] = other === 'tail' ? w.points[0]! : w.points[w.points.length - 1]!;
  next = holdDrawn(next, id, other, { x: ox, y: oy }, placement);
  // the ends joined on it: open on the part that goes, kept on the part that stays (from a new tail: shifted back)
  const d = cutAlong(w, cut);
  const out = Object.assign(Object.create(null) as Circuit, next);
  for (const [j, x] of Object.entries(next)) {
    if (j === id) continue;
    const place = (s: Side): End => {
      const e = x[s];
      if (e.on !== 'wire' || e.host !== id) return e;
      const gone = dragged === 'head' ? e.at > d : e.at < d;
      if (gone) { const p = pointOf(j, s) ?? { x: 0, y: 0 }; return { on: 'open', x: p.x, y: p.y }; }
      return dragged === 'head' ? e : { on: 'wire', host: id, at: e.at - d };
    };
    const tail = place('tail'), head = place('head');
    if (tail !== x.tail || head !== x.head) out[j] = { ...x, tail, head };
  }
  return out;
}
