import type { StudioDocument } from '../app/document';
import { moveWire, type Circuit, type Side } from '../circuit/circuit';
import { hubStart } from '../layout/circuitRoute';
import { GRID, snap, SPHERE_R, type Point } from '../layout/geometry';
import type { Pt } from '../layout/router';
import { shapeFromPoints } from '../layout/shape';
import { nearestOn } from '../layout/junctions';
import { translatePoints } from '../layout/wireMove';
import { applyDrop, judgeDrop, lineReachOf, pointOfTarget, targetOf, toneOf, type DropTarget, type Verdict } from './drop';
import { blockAt, wireAt } from './hit';
import type { OverlapJudge } from './overlapJudge';

/** One end of a wire moved whole (the user's rule B, 2026-10-09): what it is over, the verdict, and where it is drawn. */
export interface BodyEnd {
  /** The end's name in the wire as it was before the drag. */
  side: Side;
  target: DropTarget;
  verdict: Verdict;
  /** The block (node id) or, when `line`, the wire under the end; null over empty canvas. */
  id: string | null;
  line: boolean;
  /** Where the end is drawn, in flow coordinates. */
  at: Point;
}

/** Where a wire moved whole lands (rule B): its shift, its moved path, the circuit to show and the one a release makes. */
export interface BodyLanding {
  dx: number;
  dy: number;
  points: Pt[];
  /** Moved, open at both ends where the moved path starts and ends: what the canvas shows while it is dragged. */
  preview: Circuit;
  /** Each end over a contact it may take, connected there, the shape kept; the others open. */
  result: Circuit;
  /** Tail, then head. */
  ends: BodyEnd[];
  /** The end that reached a contact first and decides the shift; null: neither is on one. */
  first: Side | null;
  /**
   * The open ends of other wires its moved line lies on (rule 2, the user's 2026-10-26): each judged as that end dropped
   * on the line there (`side` and `id`: that end and its wire), joined in `result` where it may join.
   */
  joins: (BodyEnd & { wire: string })[];
}

const other = (s: Side): Side => (s === 'tail' ? 'head' : 'tail');

/**
 * How far the drawn end at `e` is from where `t` would put it, and whether a wire moved whole (its shape frozen)
 * still takes `t` without moving: a step side must be met exactly (its height on the 8 px grid), a line within half a
 * grid step (a junction's point along its host is snapped), the hub within half its ring's 15 degree spacing (its
 * tails start every 15 degrees). On the hub the end goes where a tail with a shape of its own starts (`hubStart`:
 * the ring point on the grid, `aim` the x of the shape's first vertical run from this end), so what is stored stays
 * on the grid and the short lead from the ring takes the rest.
 */
function gap(shown: StudioDocument, t: DropTarget, e: Point, aim: number | null): { x: number; y: number; fits: boolean } {
  const { cx, cy } = shown.placement.sphere;
  const c = t.on === 'hub' ? hubStart(cx, cy, t.angle, aim).start : pointOfTarget(shown, t);
  const x = c.x - e.x, y = c.y - e.y;
  const fits = t.on === 'step' ? Math.abs(x) < 0.5 && Math.abs(y) <= GRID / 2
    : t.on === 'wire' ? Math.hypot(x, y) <= GRID / 2
      : t.on === 'hub' ? Math.hypot(x, y) <= (SPHERE_R * Math.PI) / 24
        : false;
  return { x, y, fits };
}

/**
 * Wire `id`, drawn as `points`, moved whole by (`dx`, `dy`) (the user's rule B, 2026-10-09): its shape frozen, detached
 * from everything (`moveWire`; `drawnAt` opens the ends joined on it where they are drawn). Each end is judged over what
 * is under it as an end square's drag is (`targetOf`, `judgeDrop`, the drop reach `reach` in flow units; the wire
 * itself is not under its own ends); the wire has no direction while moved, so the side or the hub an end lands on
 * decides it (rule D). An end over a contact it may take shifts the whole wire onto that contact (a step side's line,
 * the hub's ring, the host's line): the end that got there first (`first`, kept from the last move while it is still
 * on one) decides the shift. The other end connects too when the frozen shape meets its contact as well (or when
 * shifting onto that one instead meets both); otherwise it stays open. A refused end moves with the wire and stays open.
 * `overlap` (the user's rule 2, 2026-10-09): when the wire connected as moved would lie on a wire it may not share a line
 * with (a new short circuit), its connecting ends are "short circuit" and stay open; the wire still moves (drawn red where
 * it lies on the other wire, and pinned in Output).
 */
export function landBody(
  shown: StudioDocument, circuit: Readonly<Circuit>, id: string, points: readonly Pt[], drawnAt: (id: string, side: Side) => Point | null,
  dx: number, dy: number, first: Side | null, reach: number, overlap?: OverlapJudge,
): BodyLanding {
  return rejoined(shown, id, landEnds(shown, circuit, id, points, drawnAt, dx, dy, first, reach, overlap));
}

/**
 * Rule 2's other contact points (the user's, 2026-10-26): every open end of another wire the moved line lies on (within
 * a grid step: a move of the line off it disconnects it, at any zoom) is judged as that end dropped on the line there,
 * and joined where it may join; so a wire put back where it was joins the ends its move opened again (even landed a grid
 * step off, as onto the hub's ring), and one dropped across an open end joins it.
 */
function rejoined(shown: StudioDocument, id: string, l: Omit<BodyLanding, 'joins'>): BodyLanding {
  const line = [...l.points];
  const placing = { routes: shown.wires, ctx: { placement: shown.placement, steps: shown.graph.steps } };
  const joins: BodyLanding['joins'] = [];
  let result = l.result;
  for (const j of Object.keys(l.result)) {
    if (j === id) continue;
    for (const side of ['tail', 'head'] as const) {
      const e = result[j]?.[side];
      if (!e || e.on !== 'open') continue;
      const near = nearestOn([line], [e.x, e.y]);
      if (near.gap > GRID) continue;
      const target: DropTarget = { on: 'wire', host: id, at: near.at };
      const verdict = judgeDrop(shown, result, j, side, target);
      joins.push({ wire: j, side, target, verdict, id, line: true, at: { x: e.x, y: e.y } });
      if (toneOf(verdict) === 'ok') result = applyDrop(result, j, side, target, placing, result[j]!.bends ?? null).circuit;
    }
  }
  return { ...l, result, joins };
}

function landEnds(
  shown: StudioDocument, circuit: Readonly<Circuit>, id: string, points: readonly Pt[], drawnAt: (id: string, side: Side) => Point | null,
  dx: number, dy: number, first: Side | null, reach: number, overlap?: OverlapJudge,
): Omit<BodyLanding, 'joins'> {
  const placed = (sx: number, sy: number) => {
    const pts = translatePoints(points, sx, sy);
    return { pts, c: moveWire(circuit, id, pts, drawnAt) };
  };
  const endAt = (pts: readonly Pt[], side: Side): Point => {
    const [x, y] = side === 'tail' ? pts[0]! : pts[pts.length - 1]!;
    return { x, y };
  };
  const look = (c: Readonly<Circuit>, at: Point) => {
    const over = blockAt(shown, at, reach);
    const line = over === null ? wireAt(shown, at, lineReachOf(reach), null, id) : null;
    return { target: targetOf(shown, c, at, over, line), id: line ? line.id : over, line: line !== null };
  };
  // the x of the frozen shape's first vertical run from each end (what a tail on the hub starts towards)
  const firstRun = (side: Side): number | null => {
    const from = side === 'tail' ? points : [...points].reverse();
    const s = shapeFromPoints(from);
    // a straight wire heads for its other end
    return s.xs.length > 0 ? s.xs[0]! : from.length > 1 ? from[from.length - 1]![0] : null;
  };
  const aimOf = (side: Side, sx: number): number | null => { const x = firstRun(side); return x === null ? null : x + sx; };
  // the ends joined on the moved wire are opened by `moveWire`: applyDrop has none to place, these are its context
  const placing = { routes: shown.wires, ctx: { placement: shown.placement, steps: shown.graph.steps } };
  const raw = placed(dx, dy);
  const sides: Side[] = ['tail', 'head'];
  const alone = sides.map((side) => {
    const at = endAt(raw.pts, side);
    const l = look(raw.c, at);
    return { side, at, ...l, verdict: judgeDrop(shown, raw.c, id, side, l.target) };
  });
  const ok = (side: Side) => toneOf(alone[side === 'tail' ? 0 : 1]!.verdict) === 'ok';
  const lead: Side | null = first !== null && ok(first) ? first : ok('tail') ? 'tail' : ok('head') ? 'head' : null;
  if (lead === null) {
    return { dx, dy, points: raw.pts, preview: raw.c, result: raw.c, ends: alone, first: null };
  }

  /** The wire shifted onto end `a`'s contact, `a` connected there, and the other end judged and connected if it fits. */
  const onto = (a: Side) => {
    const A = alone[a === 'tail' ? 0 : 1]!;
    const g = gap(shown, A.target, A.at, aimOf(a, dx));
    // onto the hub the shift stays on the grid, so the moved shape does too
    const sx = A.target.on === 'hub' ? snap(dx + g.x) : dx + g.x, sy = A.target.on === 'hub' ? snap(dy + g.y) : dy + g.y;
    const moved = placed(sx, sy);
    const one = applyDrop(moved.c, id, a, A.target, placing, moved.c[id]?.bends ?? null);
    const b = other(a);
    const bAt = endAt(moved.pts, b);
    const l = look(one.circuit, bAt);
    let verdict = judgeDrop(shown, one.circuit, id, other(one.side), l.target);
    let result = one.circuit;
    let fits = false;
    if (toneOf(verdict) === 'ok') {
      fits = gap(shown, l.target, bAt, aimOf(b, sx)).fits;
      if (fits) result = applyDrop(one.circuit, id, other(one.side), l.target, placing, one.circuit[id]?.bends ?? null).circuit;
      else verdict = 'move';
    }
    const ends: BodyEnd[] = [
      { side: a, target: A.target, verdict: A.verdict, id: A.id, line: A.line, at: endAt(moved.pts, a) },
      { side: b, ...l, verdict, at: bAt },
    ];
    if (a === 'head') ends.reverse();
    return { dx: sx, dy: sy, points: moved.pts, preview: moved.c, result, ends, fits };
  };
  let best = onto(lead);
  // the shape does not meet both contacts shifted onto the first end's: shifted onto the other end's, it may
  if (!best.fits && ok(other(lead))) {
    const turn = onto(other(lead));
    if (turn.fits) best = turn;
  }
  // connected, the moved wire would lie on a wire it may not share a line with (rule 2): its ends stay open, where the
  // pointer put it (not shifted onto a contact it does not take)
  if (overlap && best.result !== best.preview && overlap(best.points, () => best.result)) {
    const ends = alone.map((e) => (toneOf(e.verdict) === 'ok' ? { ...e, verdict: 'short' as const } : e));
    return { dx, dy, points: raw.pts, preview: raw.c, result: raw.c, ends, first: null };
  }
  return { dx: best.dx, dy: best.dy, points: best.points, preview: best.preview, result: best.result, ends: best.ends, first: lead };
}
